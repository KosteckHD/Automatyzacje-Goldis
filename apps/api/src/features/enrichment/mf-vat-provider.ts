import { normalizeNip } from "@goldis/core";
import { secondsUntilNextWarsawDay } from "../../shared/warsaw-time";
import {
  type RegistryProvider,
  type RegistryProviderBatchOutcome,
  type RegistryProviderBatchResult,
  RegistryProviderError,
  type RegistryProviderResult,
} from "./registry-provider";

const PRODUCTION_BASE_URL = "https://wykazpodatnikowvat.mf.gov.pl/api/";
const TEST_BASE_URL = "https://wykazpodatnikowvat-test.mf.gov.pl/api/";
const MF_PROVIDER_VERSION = "1.6.1";
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

export type MfVatEnvironment = "production" | "test";
export type MfVatProviderOptions = Readonly<{
  environment: MfVatEnvironment;
  /** Loopback-only override for isolated transport tests. */
  testBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxResponseBytes?: number;
  timeoutMs?: number;
}>;

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function isLoopbackTestUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

function dateInWarsaw(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new RegistryProviderError("INVALID_RESPONSE", "Invalid MF lookup date");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

async function readLimitedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new RegistryProviderError("INVALID_RESPONSE", "MF response exceeded the configured size limit");
  }
  if (!response.body) throw new RegistryProviderError("INVALID_RESPONSE", "MF response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RegistryProviderError("INVALID_RESPONSE", "MF response exceeded the configured size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function responseError(status: number, headers: Headers, payload: unknown, now: Date): RegistryProviderError {
  const code =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).code
      : null;
  if (status === 429 || code === "WL-191") {
    const retryAfterHeader = headers.get("retry-after");
    let retryAfterSeconds = 300;
    if (retryAfterHeader && /^\d+$/.test(retryAfterHeader)) {
      retryAfterSeconds = Math.min(86_400, Number(retryAfterHeader));
    } else if (retryAfterHeader) {
      const retryAt = Date.parse(retryAfterHeader);
      if (Number.isFinite(retryAt))
        retryAfterSeconds = Math.min(86_400, Math.max(1, Math.ceil((retryAt - now.getTime()) / 1000)));
    } else if (code === "WL-191") {
      retryAfterSeconds = secondsUntilNextWarsawDay(now);
    }
    return new RegistryProviderError("RATE_LIMITED", "MF search limit reached", retryAfterSeconds);
  }
  if (status === 408 || status >= 500)
    return new RegistryProviderError("UNAVAILABLE", "MF search is temporarily unavailable");
  return new RegistryProviderError("INVALID_RESPONSE", "MF search returned an unsuccessful response");
}

function mapSubject(subject: unknown, requestedNip: string): RegistryProviderResult["candidates"][number] {
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) {
    throw new RegistryProviderError("INVALID_RESPONSE", "MF returned an invalid subject");
  }
  const record = subject as Record<string, unknown>;
  if (
    typeof record.nip !== "string" ||
    record.nip !== requestedNip ||
    typeof record.name !== "string" ||
    !record.name.trim() ||
    record.name.length > 256
  ) {
    throw new RegistryProviderError("INVALID_RESPONSE", "MF returned an invalid subject identity");
  }
  const candidate: Record<string, unknown> = { nip: record.nip, name: record.name };
  if (record.regon !== undefined && record.regon !== null && record.regon !== "") {
    if (typeof record.regon !== "string" || !/^\d{9}(?:\d{5})?$/.test(record.regon)) {
      throw new RegistryProviderError("INVALID_RESPONSE", "MF returned an invalid REGON");
    }
    candidate.regon = record.regon;
  }
  return candidate;
}

/**
 * Minimal MF VAT-list adapter. Production always uses the official HTTPS
 * origin; tests can override it only with an explicit loopback URL.
 */
export class MfVatRegistryProvider implements RegistryProvider {
  readonly cacheNamespace = "mf-vat";
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;

  constructor(options: MfVatProviderOptions) {
    this.baseUrl =
      options.environment === "test"
        ? ((options.testBaseUrl ? isLoopbackTestUrl(options.testBaseUrl) : null) ?? new URL(TEST_BASE_URL))
        : new URL(PRODUCTION_BASE_URL);
    if (options.testBaseUrl && (options.environment !== "test" || !isLoopbackTestUrl(options.testBaseUrl))) {
      throw new Error("MF_VAT_TEST_URL_MUST_BE_LOOPBACK");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "MF_VAT_MAX_RESPONSE_BYTES_INVALID",
    );
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "MF_VAT_TIMEOUT_INVALID");
  }

  async lookupByNip(nipNormalized: string, signal?: AbortSignal): Promise<RegistryProviderResult> {
    const normalized = normalizeNip(nipNormalized).normalized;
    if (!normalized || normalized !== nipNormalized) {
      throw new RegistryProviderError("INVALID_RESPONSE", "MF lookup requires a normalized NIP");
    }
    const now = this.now();
    const url = new URL(`api/search/nip/${normalized}`, this.baseUrl);
    url.searchParams.set("date", dateInWarsaw(now));
    const controller = new AbortController();
    let timeoutTriggered = false;
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        if (timeoutTriggered || signal?.aborted)
          throw new RegistryProviderError("TIMEOUT", "MF search request timed out");
        throw new RegistryProviderError("UNAVAILABLE", "MF search transport failed");
      }
      if (response.redirected || new URL(response.url).origin !== this.baseUrl.origin) {
        await response.body?.cancel().catch(() => undefined);
        throw new RegistryProviderError("INVALID_RESPONSE", "MF redirected the search request");
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        await response.body?.cancel().catch(() => undefined);
        throw new RegistryProviderError("INVALID_RESPONSE", "MF returned an unsupported content type");
      }
      const bytes = await readLimitedBody(response, this.maxResponseBytes);
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new RegistryProviderError("INVALID_RESPONSE", "MF returned malformed JSON");
      }
      if (!response.ok) throw responseError(response.status, response.headers, payload, now);
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Object.hasOwn(payload, "result")) {
        throw new RegistryProviderError("INVALID_RESPONSE", "MF response is missing the result field");
      }
      const envelope = (payload as Record<string, unknown>).result;
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !Object.hasOwn(envelope, "subject")) {
        throw new RegistryProviderError("INVALID_RESPONSE", "MF response has an invalid result");
      }
      const subject = (envelope as Record<string, unknown>).subject;
      const candidates = subject === null ? [] : [mapSubject(subject, normalized)];
      return {
        providerName: "mf-vat",
        providerVersion: MF_PROVIDER_VERSION,
        dataVersion: null,
        fetchedAt: this.now(),
        candidates,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async lookupManyByNip(nipsNormalized: readonly string[], signal?: AbortSignal): Promise<RegistryProviderBatchResult> {
    if (
      !Array.isArray(nipsNormalized) ||
      nipsNormalized.length < 1 ||
      nipsNormalized.length > 30 ||
      new Set(nipsNormalized).size !== nipsNormalized.length ||
      nipsNormalized.some((nip) => {
        const normalized = normalizeNip(nip).normalized;
        return !normalized || normalized !== nip;
      })
    ) {
      throw new RegistryProviderError("INVALID_RESPONSE", "MF batch requires one to thirty unique normalized NIPs");
    }
    const now = this.now();
    const url = new URL(`api/search/nips/${nipsNormalized.join(",")}`, this.baseUrl);
    url.searchParams.set("date", dateInWarsaw(now));
    const controller = new AbortController();
    let timeoutTriggered = false;
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        if (timeoutTriggered || signal?.aborted)
          throw new RegistryProviderError("TIMEOUT", "MF batch request timed out");
        throw new RegistryProviderError("UNAVAILABLE", "MF batch transport failed");
      }
      if (response.redirected || new URL(response.url).origin !== this.baseUrl.origin) {
        await response.body?.cancel().catch(() => undefined);
        throw new RegistryProviderError("INVALID_RESPONSE", "MF redirected the batch request");
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        await response.body?.cancel().catch(() => undefined);
        throw new RegistryProviderError("INVALID_RESPONSE", "MF returned an unsupported batch content type");
      }
      const bytes = await readLimitedBody(response, this.maxResponseBytes);
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new RegistryProviderError("INVALID_RESPONSE", "MF returned malformed batch JSON");
      }
      if (!response.ok) throw responseError(response.status, response.headers, payload, now);
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Object.hasOwn(payload, "result")) {
        throw new RegistryProviderError("INVALID_RESPONSE", "MF batch response is missing the result field");
      }
      const envelope = (payload as Record<string, unknown>).result;
      if (
        !envelope ||
        typeof envelope !== "object" ||
        Array.isArray(envelope) ||
        !Array.isArray((envelope as Record<string, unknown>).entries)
      ) {
        throw new RegistryProviderError("INVALID_RESPONSE", "MF batch response has invalid entries");
      }
      const requested = new Set(nipsNormalized);
      const outcomes = new Map<string, RegistryProviderBatchOutcome>();
      for (const entryValue of (envelope as { entries: unknown[] }).entries) {
        if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)) {
          throw new RegistryProviderError("INVALID_RESPONSE", "MF batch contains an invalid entry");
        }
        const entry = entryValue as Record<string, unknown>;
        if (
          typeof entry.identifier !== "string" ||
          !requested.has(entry.identifier) ||
          outcomes.has(entry.identifier)
        ) {
          throw new RegistryProviderError("INVALID_RESPONSE", "MF batch contains an unknown or duplicate NIP");
        }
        if (Object.hasOwn(entry, "error")) {
          const providerError =
            entry.error && typeof entry.error === "object" && !Array.isArray(entry.error)
              ? (entry.error as Record<string, unknown>)
              : {};
          const code = typeof providerError.code === "string" ? providerError.code : "";
          const error =
            code === "WL-191"
              ? new RegistryProviderError("RATE_LIMITED", "MF search limit reached", secondsUntilNextWarsawDay(now))
              : new RegistryProviderError("INVALID_RESPONSE", "MF rejected one NIP in the batch");
          outcomes.set(entry.identifier, { kind: "error", error });
          continue;
        }
        if (!Array.isArray(entry.subjects)) {
          throw new RegistryProviderError("INVALID_RESPONSE", "MF batch entry has invalid subjects");
        }
        const candidates = entry.subjects.map((subject) => mapSubject(subject, entry.identifier as string));
        outcomes.set(entry.identifier, {
          kind: "result",
          result: {
            providerName: "mf-vat",
            providerVersion: MF_PROVIDER_VERSION,
            dataVersion: null,
            fetchedAt: this.now(),
            candidates,
          },
        });
      }
      if (outcomes.size !== requested.size || [...requested].some((nip) => !outcomes.has(nip))) {
        throw new RegistryProviderError("INVALID_RESPONSE", "MF batch response omitted a requested NIP");
      }
      return outcomes;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
