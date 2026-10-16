import type { SourceRow } from "@goldis/core";
import { loadApiRuntimeConfig, loadApiSecretConfig } from "../../infrastructure/config";

const maxInputBytes = 16 * 1024 * 1024;
const maxOutputBytes = 64 * 1024 * 1024;
const errorCodes = new Set([
  "IMPORT_LIMITS_EXCEEDED",
  "INVALID_WORKBOOK",
  "IMPORT_PARSE_TIMEOUT",
  "IMPORT_CAPACITY_EXCEEDED",
  "IMPORT_PARSER_UNAVAILABLE",
]);

export class ImportParserClientError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

function configuredEnvironment(
  environment?: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  if (environment !== undefined) return environment;
  const runtimeConfig = loadApiRuntimeConfig();
  const secretConfig = loadApiSecretConfig();
  return {
    APP_ENV: runtimeConfig.appEnvironment,
    IMPORT_PARSER_URL: runtimeConfig.importParserUrl,
    IMPORT_PARSER_SHARED_SECRET: secretConfig.importParserSharedSecret,
  };
}

export function assertImportParserClientConfiguration(
  environment?: Readonly<Record<string, string | undefined>>,
): void {
  environment = configuredEnvironment(environment);
  const rawUrl = environment.IMPORT_PARSER_URL;
  const secret = environment.IMPORT_PARSER_SHARED_SECRET;
  if (environment.APP_ENV === "production" && (!rawUrl || !secret || Buffer.byteLength(secret, "utf8") < 32)) {
    throw new Error("IMPORT_PARSER_CONFIGURATION_REQUIRED");
  }
  if (!rawUrl) return;
  try {
    const url = new URL(rawUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "/internal/parse-xlsx")
    )
      throw new Error();
  } catch {
    throw new Error("IMPORT_PARSER_URL_INVALID");
  }
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) throw new Error("IMPORT_PARSER_SHARED_SECRET_INVALID");
}

function validSourceRow(value: unknown): value is SourceRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const textFields = ["companyName", "nipRaw", "address", "postalCode", "city", "regonRaw"];
  const knownFields = new Set([
    "rowNumber",
    "companyName",
    "decisionMakerName",
    "mobile",
    "phone",
    "email",
    "nipRaw",
    "address",
    "postalCode",
    "city",
    "countyCode",
    "regonRaw",
    "regon",
    "effectiveRegon",
    "issues",
  ]);
  if (Object.keys(row).some((field) => !knownFields.has(field))) return false;
  return (
    Number.isSafeInteger(row.rowNumber) &&
    (row.rowNumber as number) >= 2 &&
    (row.rowNumber as number) <= 40_000 &&
    textFields.every((field) => typeof row[field] === "string" && (row[field] as string).length <= 32 * 1024) &&
    (row.decisionMakerName === null ||
      (typeof row.decisionMakerName === "string" && row.decisionMakerName.length <= 32 * 1024)) &&
    ["mobile", "phone", "email"].every(
      (field) => row[field] === undefined || (typeof row[field] === "string" && row[field].length <= 32 * 1024),
    ) &&
    (row.countyCode === undefined ||
      row.countyCode === null ||
      (typeof row.countyCode === "string" && row.countyCode.length <= 100)) &&
    (row.regon === null || (typeof row.regon === "string" && row.regon.length <= 14)) &&
    (row.effectiveRegon === null || (typeof row.effectiveRegon === "string" && row.effectiveRegon.length <= 14)) &&
    Array.isArray(row.issues) &&
    row.issues.length <= 32 &&
    row.issues.every((issue) => typeof issue === "string" && issue.length <= 100)
  );
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  if (!response.body) throw new ImportParserClientError("IMPORT_PARSER_UNAVAILABLE");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxOutputBytes) {
        await reader.cancel();
        throw new ImportParserClientError("IMPORT_PARSER_UNAVAILABLE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export async function parseImportWorkbookRemotely(
  buffer: Buffer,
  environment?: Readonly<Record<string, string | undefined>>,
): Promise<SourceRow[]> {
  if (buffer.length > maxInputBytes) throw new ImportParserClientError("IMPORT_LIMITS_EXCEEDED");
  environment = configuredEnvironment(environment);
  const rawUrl = environment.IMPORT_PARSER_URL;
  const secret = environment.IMPORT_PARSER_SHARED_SECRET;
  try {
    assertImportParserClientConfiguration(environment);
  } catch {
    throw new ImportParserClientError("IMPORT_PARSER_UNAVAILABLE");
  }
  if (!rawUrl || !secret) throw new ImportParserClientError("IMPORT_PARSER_UNAVAILABLE");
  let url: URL;
  try {
    url = new URL(rawUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "/internal/parse-xlsx")
    )
      throw new Error("INVALID_URL");
    url.pathname = "/internal/parse-xlsx";
    url.search = "";
  } catch {
    throw new ImportParserClientError("IMPORT_PARSER_UNAVAILABLE");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "x-goldis-import-parser-key": secret,
      },
      body: Uint8Array.from(buffer),
      signal: AbortSignal.timeout(65_000),
    });
  } catch {
    throw new ImportParserClientError("IMPORT_PARSER_UNAVAILABLE", 2);
  }
  let payload: unknown;
  try {
    payload = JSON.parse((await readBoundedBody(response)).toString("utf8"));
  } catch (error) {
    if (error instanceof ImportParserClientError) throw error;
    throw new ImportParserClientError("IMPORT_PARSER_UNAVAILABLE", 2);
  }
  if (response.status !== 200) {
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const code =
      typeof record.errorCode === "string" && errorCodes.has(record.errorCode)
        ? record.errorCode
        : "IMPORT_PARSER_UNAVAILABLE";
    const retryAfter = response.headers.get("retry-after");
    throw new ImportParserClientError(code, retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined);
  }
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { rows?: unknown }).rows)) {
    throw new ImportParserClientError("IMPORT_PARSER_UNAVAILABLE");
  }
  const rows = (payload as { rows: unknown[] }).rows;
  if (rows.length > 39_999 || !rows.every(validSourceRow))
    throw new ImportParserClientError("IMPORT_PARSER_UNAVAILABLE");
  for (let index = 1; index < rows.length; index += 1) {
    if ((rows[index - 1] as SourceRow).rowNumber >= (rows[index] as SourceRow).rowNumber) {
      throw new ImportParserClientError("IMPORT_PARSER_UNAVAILABLE");
    }
  }
  return rows as SourceRow[];
}
