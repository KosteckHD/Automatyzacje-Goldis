import type { StartupEnvironment } from "./runtime-startup-config";

export type RuntimeDatabaseRole = "goldis_api" | "goldis_worker" | "goldis_enrichment" | "goldis_migrator";

export type DatabaseProcessRuntimeConfig = Readonly<{
  databaseUrl: string;
  expectedRole: RuntimeDatabaseRole;
}>;

export type ImportParserRuntimeConfig = Readonly<{
  secret: string;
  host: string;
  port: number;
}>;

export type EnrichmentWorkerRuntimeConfig = Readonly<{
  database: DatabaseProcessRuntimeConfig;
  providerEnvironment: Readonly<Record<string, string | undefined>>;
}>;

export type BootstrapAdminRuntimeConfig = Readonly<{
  username: string | undefined;
  password: string | undefined;
}>;

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name}_REQUIRED`);
  return value;
}

function port(value: string | undefined): number {
  const configured = value ?? "3010";
  if (!/^\d{1,5}$/.test(configured)) throw new Error("IMPORT_PARSER_PORT_INVALID");
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("IMPORT_PARSER_PORT_INVALID");
  return parsed;
}

/** Captures the connection secret and the role expected by a one-purpose process. */
export function loadDatabaseProcessRuntimeConfig(
  environment: StartupEnvironment = process.env,
  expectedRole: RuntimeDatabaseRole,
): DatabaseProcessRuntimeConfig {
  const databaseUrl = required(environment.DATABASE_URL, "DATABASE_URL");
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { throw new Error("DATABASE_URL_INVALID"); }
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)) || !parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new Error("DATABASE_URL_INVALID");
  }
  return Object.freeze({ databaseUrl, expectedRole });
}

/** Reads the parser listener settings once; the secret is never included in diagnostics. */
export function loadImportParserRuntimeConfig(environment: StartupEnvironment = process.env): ImportParserRuntimeConfig {
  const secret = required(environment.IMPORT_PARSER_SHARED_SECRET, "IMPORT_PARSER_SHARED_SECRET");
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("IMPORT_PARSER_SHARED_SECRET_INVALID");
  const host = (environment.IMPORT_PARSER_HOST ?? "127.0.0.1").trim();
  if (!host || host.length > 255 || /[\u0000-\u0020\u007f]/.test(host)) throw new Error("IMPORT_PARSER_HOST_INVALID");
  return Object.freeze({ secret, host, port: port(environment.IMPORT_PARSER_PORT) });
}

/** Restricts the enrichment process to the environment keys its provider factory consumes. */
export function loadEnrichmentWorkerRuntimeConfig(environment: StartupEnvironment = process.env): EnrichmentWorkerRuntimeConfig {
  const providerKeys = [
    "APP_ENV", "GOLDIS_ENRICHMENT_PROVIDER", "REGISTRY_CACHE_HMAC_KEY", "MF_VAT_ENVIRONMENT",
    "MF_VAT_TEST_BASE_URL", "MF_VAT_MIN_REQUEST_INTERVAL_MS", "GUS_BIR_ENVIRONMENT", "GUS_BIR_USER_KEY",
    "GUS_BIR_MIN_REQUEST_INTERVAL_MS",
  ];
  const providerEnvironment = Object.freeze(Object.fromEntries(providerKeys
    .filter((key) => environment[key] !== undefined)
    .map((key) => [key, environment[key]])));
  return Object.freeze({
    database: loadDatabaseProcessRuntimeConfig(environment, "goldis_enrichment"),
    providerEnvironment,
  });
}

/** Bootstrap credentials are optional for an already-seeded database and validated by the use case if needed. */
export function loadBootstrapAdminRuntimeConfig(environment: StartupEnvironment = process.env): BootstrapAdminRuntimeConfig {
  return Object.freeze({
    username: environment.GOLDIS_ADMIN_USER,
    password: environment.GOLDIS_ADMIN_PASSWORD,
  });
}
