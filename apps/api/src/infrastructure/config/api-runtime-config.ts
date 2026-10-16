import { assertApiStartupConfiguration, type StartupEnvironment } from "./runtime-startup-config";
import { runtimeBuildManifest } from "./runtime-manifest";
import { parseAuthMailConfig, type AuthMailConfig } from "../../features/account-recovery/auth-mail-settings";

export type ApiRuntimeConfig = Readonly<{
  port: number;
  trustProxyIps: string | undefined;
  appEnvironment: string | undefined;
  nodeEnvironment: string | undefined;
  publicAppOrigin: string | undefined;
  loginRateLimitKeyPrefix: string | undefined;
  workerInternalUrl: string | undefined;
  importParserUrl: string | undefined;
  apiExportDirectory: string | undefined;
  deletionJournalDirectory: string | undefined;
  artifactEncryptionRequired: boolean;
  deletionWorkerEnabled: boolean;
  deletionRestoreMaintenance: boolean;
  build: ReturnType<typeof runtimeBuildManifest>;
}>;

export type ApiSecretConfig = Readonly<{
  sessionSecret: string | undefined;
  loginRateLimitSecret: string | undefined;
  privilegedActionBindingKey: string | undefined;
  workerAuthSecret: string | undefined;
  importParserSharedSecret: string | undefined;
  redisUrl: string | undefined;
  resendApiKey: string | undefined;
  authMailEncryptionActiveKeyVersion: string | undefined;
  authMailEncryptionKeysBase64: string | undefined;
  artifactEncryptionActiveKeyVersion: string | undefined;
  artifactEncryptionKeysBase64: string | undefined;
}>;

let startupRuntimeConfig: ApiRuntimeConfig | null = null;
let startupSecretConfig: ApiSecretConfig | null = null;
let startupAuthMailRuntimeConfig: Omit<AuthMailConfig, "resendApiKey"> | null = null;

function apiPort(value: string | undefined): number {
  const configured = value || "3001";
  if (!/^\d{1,5}$/.test(configured)) throw new Error("API_PORT_INVALID");
  const port = Number(configured);
  if (port < 0 || port > 65_535) throw new Error("API_PORT_INVALID");
  return port;
}

function serviceUrl(value: string | undefined, name: string, allowedPaths: readonly string[]): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!(url.protocol === "http:" || url.protocol === "https:") || !url.hostname
      || url.username || url.password || url.search || url.hash || !allowedPaths.includes(url.pathname)) throw new Error();
    return value;
  } catch {
    throw new Error(`${name}_INVALID`);
  }
}

/** Reads non-secret API entrypoint settings after validating production requirements. */
function parseApiRuntimeConfig(environment: StartupEnvironment): ApiRuntimeConfig {
  assertApiStartupConfiguration(environment);
  const loginRateLimitKeyPrefix = environment.LOGIN_RATE_LIMIT_KEY_PREFIX?.trim();
  if (loginRateLimitKeyPrefix && !/^[A-Za-z0-9:_-]{1,96}$/.test(loginRateLimitKeyPrefix)) {
    throw new Error("LOGIN_RATE_LIMIT_KEY_PREFIX_INVALID");
  }
  const redisUrl = environment.REDIS_URL;
  if (redisUrl) {
    try {
      const url = new URL(redisUrl);
      if (!["redis:", "rediss:"].includes(url.protocol) || !url.hostname || url.hash) throw new Error();
    } catch { throw new Error("REDIS_URL_INVALID"); }
  }
  const workerInternalUrl = serviceUrl(environment.WORKER_INTERNAL_URL, "WORKER_INTERNAL_URL", ["/"]);
  const importParserUrl = serviceUrl(environment.IMPORT_PARSER_URL, "IMPORT_PARSER_URL", ["/", "/internal/parse-xlsx"]);
  return Object.freeze({
    port: apiPort(environment.API_PORT),
    trustProxyIps: environment.TRUST_PROXY_IPS,
    appEnvironment: environment.APP_ENV,
    nodeEnvironment: environment.NODE_ENV,
    publicAppOrigin: environment.PUBLIC_APP_ORIGIN,
    loginRateLimitKeyPrefix,
    workerInternalUrl,
    importParserUrl,
    apiExportDirectory: environment.API_EXPORT_DIR,
    deletionJournalDirectory: environment.GOLDIS_DELETION_JOURNAL_DIR,
    artifactEncryptionRequired: environment.ARTIFACT_REQUIRE_ENCRYPTION === "1",
    deletionWorkerEnabled: environment.GOLDIS_DELETION_WORKER !== "0",
    deletionRestoreMaintenance: environment.GOLDIS_RESTORE_MAINTENANCE === "1",
    build: runtimeBuildManifest(environment),
  });
}

/** Secrets stay separate from the public/safe-to-inspect runtime settings snapshot. */
function parseApiSecretConfig(environment: StartupEnvironment): ApiSecretConfig {
  return Object.freeze({
    sessionSecret: environment.SESSION_SECRET,
    loginRateLimitSecret: environment.LOGIN_RATE_LIMIT_SECRET,
    privilegedActionBindingKey: environment.PRIVILEGED_ACTION_BINDING_KEY,
    workerAuthSecret: environment.WORKER_AUTH_SECRET,
    importParserSharedSecret: environment.IMPORT_PARSER_SHARED_SECRET,
    redisUrl: environment.REDIS_URL,
    resendApiKey: environment.RESEND_API_KEY,
    authMailEncryptionActiveKeyVersion: environment.AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION,
    authMailEncryptionKeysBase64: environment.AUTH_MAIL_ENCRYPTION_KEYS_BASE64,
    artifactEncryptionActiveKeyVersion: environment.ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION,
    artifactEncryptionKeysBase64: environment.ARTIFACT_ENCRYPTION_KEYS_BASE64,
  });
}

/** Captures one immutable API configuration before Nest creates any providers. */
export function configureApiRuntimeConfig(environment: StartupEnvironment = process.env): ApiRuntimeConfig {
  if (startupRuntimeConfig || startupSecretConfig) throw new Error("API_RUNTIME_CONFIG_ALREADY_CONFIGURED");
  const runtimeConfig = parseApiRuntimeConfig(environment);
  const secretConfig = parseApiSecretConfig(environment);
  const parsedAuthMail = parseAuthMailConfig(environment);
  const authMailRuntimeConfig = {
    enabled: parsedAuthMail.enabled,
    provider: parsedAuthMail.provider,
    publicOrigin: parsedAuthMail.publicOrigin,
    from: parsedAuthMail.from,
    replyTo: parsedAuthMail.replyTo,
  };
  startupRuntimeConfig = runtimeConfig;
  startupSecretConfig = secretConfig;
  startupAuthMailRuntimeConfig = Object.freeze(authMailRuntimeConfig);
  return runtimeConfig;
}

/** Explicit environments are parsed independently for tests and one-off tooling. */
export function loadApiRuntimeConfig(environment?: StartupEnvironment): ApiRuntimeConfig {
  if (environment !== undefined) return parseApiRuntimeConfig(environment);
  return startupRuntimeConfig ?? parseApiRuntimeConfig(process.env);
}

/** After bootstrap this returns the startup secret snapshot, never a later env reread. */
export function loadApiSecretConfig(environment?: StartupEnvironment): ApiSecretConfig {
  if (environment !== undefined) return parseApiSecretConfig(environment);
  return startupSecretConfig ?? parseApiSecretConfig(process.env);
}

/** Reads mail settings from the API startup snapshot after bootstrap; explicit environments remain useful for tests. */
export function loadApiAuthMailConfig(environment?: StartupEnvironment): AuthMailConfig {
  if (environment !== undefined) return parseAuthMailConfig(environment);
  if (!startupAuthMailRuntimeConfig) return parseAuthMailConfig(process.env);
  const secretConfig = loadApiSecretConfig();
  return { ...startupAuthMailRuntimeConfig, resendApiKey: secretConfig.resendApiKey ?? null };
}
