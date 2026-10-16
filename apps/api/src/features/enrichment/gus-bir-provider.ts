import { randomUUID } from "node:crypto";
import { normalizeNip, normalizeRegon } from "@goldis/core";
import { SaxesParser } from "saxes";
import {
  type RegistryProvider,
  type RegistryProviderBatchOutcome,
  type RegistryProviderBatchResult,
  RegistryProviderError,
  type RegistryProviderResult,
} from "./registry-provider";

const SERVICE_NAMESPACE = "http://CIS/BIR/PUBL/2014/07";
const DATA_NAMESPACE = "http://CIS/BIR/PUBL/2014/07/DataContract";
const SOAP_NAMESPACE = "http://www.w3.org/2003/05/soap-envelope";
const WSA_NAMESPACE = "http://www.w3.org/2005/08/addressing";
const ACTION_ROOT = `${SERVICE_NAMESPACE}/IUslugaBIRzewnPubl`;
const PRODUCTION_ENDPOINT = "https://wyszukiwarkaregon.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc";
const TEST_ENDPOINT = "https://wyszukiwarkaregontest.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc";
const PROVIDER_VERSION = "1.2.0";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_XML_DEPTH = 32;
const MAX_XML_NODES = 20_000;

function hasUnsupportedControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 8 ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127)
    );
  });
}

export type GusBirEnvironment = "production" | "test";
export type GusBirRegistryProviderOptions = Readonly<{
  environment: GusBirEnvironment;
  userKey: string;
  /** Loopback-only override used by local SOAP fixtures. Production ignores no caller-supplied host. */
  testBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxResponseBytes?: number;
  timeoutMs?: number;
}>;

type XmlNode = { name: string; namespaceUri: string; children: XmlNode[]; text: string };

class SessionExpiredError extends Error {
  constructor() {
    super("GUS_BIR_SESSION_EXPIRED");
  }
}

function positiveInteger(value: number, code: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(code);
  return value;
}

function loopbackUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["/", "/wsBIR/UslugaBIRzewnPubl.svc"].includes(url.pathname)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseXmlDocument(xml: string): XmlNode {
  if (/<!DOCTYPE\b/i.test(xml))
    throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR XML documents with DTD are forbidden");
  const rootHolder: XmlNode = { name: "#document", namespaceUri: "", children: [], text: "" };
  const stack: XmlNode[] = [rootHolder];
  let nodeCount = 0;
  let textCount = 0;
  let parseFailure = false;
  const parser = new SaxesParser({ xmlns: true, position: false });
  parser.on("error", () => {
    parseFailure = true;
  });
  parser.on("doctype", () => {
    parseFailure = true;
  });
  parser.on("opentag", (tag) => {
    nodeCount += 1;
    if (nodeCount > MAX_XML_NODES || stack.length > MAX_XML_DEPTH) {
      parseFailure = true;
      return;
    }
    const node: XmlNode = { name: tag.local, namespaceUri: tag.uri, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => {
    if (stack.length > 1) stack.pop();
  });
  const appendText = (value: string) => {
    textCount += value.length;
    if (textCount > MAX_RESPONSE_BYTES) {
      parseFailure = true;
      return;
    }
    stack[stack.length - 1].text += value;
  };
  parser.on("text", appendText);
  parser.on("cdata", appendText);
  try {
    parser.write(xml).close();
  } catch {
    parseFailure = true;
  }
  if (parseFailure || rootHolder.children.length !== 1) {
    throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR returned malformed or unsafe XML");
  }
  return rootHolder.children[0];
}

function descendants(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = [];
  const visit = (current: XmlNode) => {
    if (current.name === name) found.push(current);
    for (const child of current.children) visit(child);
  };
  visit(node);
  return found;
}

function textContent(node: XmlNode): string {
  return node.text + node.children.map(textContent).join("");
}

function directText(node: XmlNode, name: string, required = false): string | null {
  const matches = node.children.filter((child) => child.name === name);
  if (matches.length > 1 || (required && matches.length !== 1)) {
    throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR returned an invalid result structure");
  }
  if (matches.length === 0) return null;
  return textContent(matches[0]).trim();
}

function soapBody(operation: "Zaloguj" | "DaneSzukajPodmioty", endpoint: URL, inner: string): string {
  const action = `${ACTION_ROOT}/${operation}`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="${SOAP_NAMESPACE}" xmlns:wsa="${WSA_NAMESPACE}" ` +
    `xmlns:bir="${SERVICE_NAMESPACE}" xmlns:dc="${DATA_NAMESPACE}">` +
    `<soap:Header><wsa:Action soap:mustUnderstand="true">${action}</wsa:Action>` +
    `<wsa:To soap:mustUnderstand="true">${xmlEscape(endpoint.href)}</wsa:To>` +
    `<wsa:MessageID>urn:uuid:${randomUUID()}</wsa:MessageID>` +
    `<wsa:ReplyTo><wsa:Address>${WSA_NAMESPACE}/anonymous</wsa:Address></wsa:ReplyTo></soap:Header>` +
    `<soap:Body>${inner}</soap:Body></soap:Envelope>`
  );
}

function operationResult(envelope: XmlNode, resultElement: string): string {
  if (envelope.name !== "Envelope" || envelope.namespaceUri !== SOAP_NAMESPACE) {
    throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR returned a non-SOAP envelope");
  }
  const bodies = envelope.children.filter((child) => child.name === "Body" && child.namespaceUri === SOAP_NAMESPACE);
  if (bodies.length !== 1) throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR SOAP body is missing");
  const body = bodies[0];
  const faults = descendants(body, "Fault").filter((fault) => fault.namespaceUri === SOAP_NAMESPACE);
  if (faults.length > 0) {
    const faultText =
      descendants(faults[0], "Text").map(textContent).join(" ") ||
      descendants(faults[0], "faultstring").map(textContent).join(" ") ||
      descendants(faults[0], "Value").map(textContent).join(" ");
    if (
      /(?:nieprawid[lł]owy|wygas[lł]|niewa[zż]ny).{0,60}(?:identyfikator )?sesj|(?:session|sid).{0,40}(?:expired|invalid|not found)|(?:expired|invalid).{0,40}(?:session|sid)/i.test(
        faultText,
      )
    ) {
      throw new SessionExpiredError();
    }
    throw new RegistryProviderError("UNAVAILABLE", "GUS BIR reported a SOAP fault");
  }
  const nodes = descendants(body, resultElement).filter((node) => node.namespaceUri === SERVICE_NAMESPACE);
  if (nodes.length !== 1)
    throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR response omitted its operation result");
  return textContent(nodes[0]).trim();
}

function sessionIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{20}$/.test(value)) {
    throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR returned an invalid session identifier");
  }
  return value;
}

function parseSearchXml(
  xml: string,
  requested: ReadonlySet<string>,
): Map<string, RegistryProviderResult["candidates"][number][]> {
  const root = parseXmlDocument(xml);
  const errorCodes = descendants(root, "ErrorCode")
    .map(textContent)
    .map((value) => value.trim());
  if (errorCodes.length > 0) {
    if (errorCodes.length === 1 && errorCodes[0] === "4") return new Map();
    throw new RegistryProviderError("UNAVAILABLE", "GUS BIR could not complete the registry search");
  }
  if (root.name !== "root")
    throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR returned an unexpected search document");
  const rows = descendants(root, "dane");
  const candidates = new Map<string, RegistryProviderResult["candidates"][number][]>();
  for (const row of rows) {
    const rawNip = directText(row, "Nip", true);
    const nip = rawNip === null ? null : normalizeNip(rawNip).normalized;
    const name = directText(row, "Nazwa", true);
    const rawRegon = directText(row, "Regon");
    const regon = rawRegon ? normalizeRegon(rawRegon).normalized : null;
    const unitType = directText(row, "Typ");
    if (
      !nip ||
      !requested.has(nip) ||
      !name ||
      name.length > 256 ||
      (rawRegon && (!regon || !/^\d{9}(?:\d{5})?$/.test(rawRegon))) ||
      (unitType !== null && unitType.length > 80)
    ) {
      throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR returned an invalid or unrelated entity");
    }
    const candidate: Record<string, unknown> = { nip, name };
    if (regon) candidate.regon = regon;
    if (unitType) candidate.unitType = unitType;
    if (regon?.length === 14) {
      candidate.isLocalUnit = true;
      candidate.parentRegon = regon.slice(0, 9);
    }
    const nipCandidates = candidates.get(nip) ?? [];
    const signature = JSON.stringify(candidate);
    if (!nipCandidates.some((existing) => JSON.stringify(existing) === signature)) nipCandidates.push(candidate);
    candidates.set(nip, nipCandidates);
  }
  return candidates;
}

async function readLimitedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR response exceeded the configured size limit");
  }
  if (!response.body) throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR response body is missing");
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
        throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR response exceeded the configured size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** SOAP adapter for the free GUS BIR search operation; it never requests full reports. */
export class GusBirRegistryProvider implements RegistryProvider {
  readonly cacheNamespace = "gus-bir";
  readonly maxBatchSize = 20;
  private readonly endpoint: URL;
  private readonly userKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;
  private loginPromise: Promise<string> | null = null;

  constructor(options: GusBirRegistryProviderOptions) {
    if (
      typeof options.userKey !== "string" ||
      !options.userKey.trim() ||
      options.userKey.length > 512 ||
      hasUnsupportedControlCharacters(options.userKey)
    ) {
      throw new Error("GUS_BIR_USER_KEY_REQUIRED");
    }
    if (options.testBaseUrl && (options.environment !== "test" || !loopbackUrl(options.testBaseUrl))) {
      throw new Error("GUS_BIR_TEST_URL_MUST_BE_LOOPBACK");
    }
    const loopbackTestEndpoint = options.testBaseUrl ? loopbackUrl(options.testBaseUrl) : null;
    this.endpoint =
      options.environment === "test" ? (loopbackTestEndpoint ?? new URL(TEST_ENDPOINT)) : new URL(PRODUCTION_ENDPOINT);
    this.userKey = options.userKey.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
      "GUS_BIR_MAX_RESPONSE_BYTES_INVALID",
      8 * 1024 * 1024,
    );
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "GUS_BIR_TIMEOUT_INVALID", 120_000);
  }

  async lookupByNip(nipNormalized: string, signal?: AbortSignal): Promise<RegistryProviderResult> {
    const results = await this.lookupManyByNip([nipNormalized], signal);
    const outcome = results.get(nipNormalized);
    if (!outcome) throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR omitted a requested NIP");
    if (outcome.kind === "error") throw outcome.error;
    return outcome.result;
  }

  async lookupManyByNip(nipsNormalized: readonly string[], signal?: AbortSignal): Promise<RegistryProviderBatchResult> {
    if (signal?.aborted) throw new RegistryProviderError("TIMEOUT", "GUS BIR request was cancelled");
    if (
      !Array.isArray(nipsNormalized) ||
      nipsNormalized.length < 1 ||
      nipsNormalized.length > this.maxBatchSize ||
      new Set(nipsNormalized).size !== nipsNormalized.length ||
      nipsNormalized.some((nip) => {
        const normalized = normalizeNip(nip).normalized;
        return !normalized || normalized !== nip;
      })
    ) {
      throw new RegistryProviderError(
        "INVALID_RESPONSE",
        "GUS BIR batch requires one to twenty unique normalized NIPs",
      );
    }
    const session = await this.getSession();
    let payload: string;
    try {
      payload = await this.search(nipsNormalized, session, signal);
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error;
      if (this.sessionId === session) this.sessionId = null;
      const refreshed = await this.getSession();
      try {
        payload = await this.search(nipsNormalized, refreshed, signal);
      } catch (retryError) {
        if (retryError instanceof SessionExpiredError) {
          if (this.sessionId === refreshed) this.sessionId = null;
          throw new RegistryProviderError("UNAVAILABLE", "GUS BIR rejected the refreshed session");
        }
        throw retryError;
      }
    }
    const requested = new Set(nipsNormalized);
    const byNip = parseSearchXml(payload, requested);
    const fetchedAt = this.now();
    if (!Number.isFinite(fetchedAt.getTime()))
      throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR clock is invalid");
    const outcomes = new Map<string, RegistryProviderBatchOutcome>();
    for (const nip of nipsNormalized) {
      const result: RegistryProviderResult = {
        providerName: this.cacheNamespace,
        providerVersion: PROVIDER_VERSION,
        dataVersion: null,
        fetchedAt: new Date(fetchedAt),
        candidates: byNip.get(nip) ?? [],
      };
      outcomes.set(nip, { kind: "result", result });
    }
    return outcomes;
  }

  private async getSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    if (!this.loginPromise) {
      this.loginPromise = this.login()
        .then((sessionId) => {
          this.sessionId = sessionId;
          return sessionId;
        })
        .finally(() => {
          this.loginPromise = null;
        });
    }
    return this.loginPromise;
  }

  private async login(): Promise<string> {
    const response = await this.soapRequest(
      "Zaloguj",
      `<bir:Zaloguj><bir:pKluczUzytkownika>${xmlEscape(this.userKey)}</bir:pKluczUzytkownika></bir:Zaloguj>`,
    );
    const value = operationResult(parseXmlDocument(response), "ZalogujResult");
    return sessionIdentifier(value);
  }

  private async search(nips: readonly string[], sessionId: string, signal?: AbortSignal): Promise<string> {
    const nipFilter = nips.length === 1 ? `<dc:Nip>${nips[0]}</dc:Nip>` : `<dc:Nipy>${nips.join(",")}</dc:Nipy>`;
    const requestBody =
      `<bir:DaneSzukajPodmioty><bir:pParametryWyszukiwania>` +
      `${nipFilter}</bir:pParametryWyszukiwania></bir:DaneSzukajPodmioty>`;
    const response = await this.soapRequest("DaneSzukajPodmioty", requestBody, sessionId, signal);
    return operationResult(parseXmlDocument(response), "DaneSzukajPodmiotyResult");
  }

  private async soapRequest(
    operation: "Zaloguj" | "DaneSzukajPodmioty",
    body: string,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
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
      const action = `${ACTION_ROOT}/${operation}`;
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            accept: "application/soap+xml",
            "content-type": `application/soap+xml; charset=utf-8; action="${action}"`,
            ...(sessionId ? { sid: sessionId } : {}),
          },
          body: soapBody(operation, this.endpoint, body),
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        if (timeoutTriggered || signal?.aborted)
          throw new RegistryProviderError("TIMEOUT", "GUS BIR request timed out");
        throw new RegistryProviderError("UNAVAILABLE", "GUS BIR transport failed");
      }
      if (sessionId && (response.status === 401 || response.status === 403)) {
        await response.body?.cancel().catch(() => undefined);
        throw new SessionExpiredError();
      }
      if (response.redirected || new URL(response.url).origin !== this.endpoint.origin) {
        await response.body?.cancel().catch(() => undefined);
        throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR redirected the request");
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/soap+xml") {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 429)
          throw new RegistryProviderError("RATE_LIMITED", "GUS BIR search limit reached", 300);
        if (response.status === 408 || response.status >= 500)
          throw new RegistryProviderError("UNAVAILABLE", "GUS BIR is temporarily unavailable");
        throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR returned an unsupported response type");
      }
      const bytes = await readLimitedBody(response, this.maxResponseBytes);
      let xml: string;
      try {
        xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR returned invalid UTF-8");
      }
      let envelope: XmlNode;
      try {
        envelope = parseXmlDocument(xml);
      } catch (error) {
        if (!response.ok && response.status >= 500)
          throw new RegistryProviderError("UNAVAILABLE", "GUS BIR is temporarily unavailable");
        throw error;
      }
      if (descendants(envelope, "Fault").length > 0) {
        operationResult(envelope, operation === "Zaloguj" ? "ZalogujResult" : "DaneSzukajPodmiotyResult");
      }
      if (!response.ok) {
        if (response.status === 429)
          throw new RegistryProviderError("RATE_LIMITED", "GUS BIR search limit reached", 300);
        if (response.status === 408 || response.status >= 500)
          throw new RegistryProviderError("UNAVAILABLE", "GUS BIR is temporarily unavailable");
        throw new RegistryProviderError("INVALID_RESPONSE", "GUS BIR returned an unsuccessful response");
      }
      return xml;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
