import { workerApiReadinessUrl } from "./api-readiness";

export type WorkerRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type WorkerRuntimeConfig = Readonly<{
  databaseUrl: string;
  redisUrl: string;
  profileDirectory: string;
  headless: boolean;
  chromiumSandbox: boolean;
  browserChannel: "chrome" | "msedge" | undefined;
  databasePoolMax: number;
  livePortals: boolean;
  internalHost: string;
  internalPort: number;
  serviceSecret: string;
  readinessEnvironment: Readonly<{ GOLDIS_API_READY_URL: string }>;
  resultForwarderEnvironment: Readonly<{
    WORKER_RESULT_API_URL: string;
    WORKER_AUTH_SECRET: string;
    PUBLIC_APP_ORIGIN: string;
  }>;
  portalEnvironment: Readonly<Record<string, string | undefined>>;
  stagingEnvironment: Readonly<Record<string, string | undefined>>;
  stagingDirectory: string | undefined;
  stagingKeyVersion: string | undefined;
  portalConfigPath: string | undefined;
}>;

function flag(value: string | undefined, fallback: "0" | "1", errorCode: string): boolean {
  const configured = value ?? fallback;
  if (configured !== "0" && configured !== "1") throw new Error(errorCode);
  return configured === "1";
}

function port(value: string | undefined): number {
  const configured = value ?? "3022";
  if (!/^\d{1,5}$/.test(configured)) throw new Error("WORKER_INTERNAL_PORT_INVALID");
  const parsed = Number(configured);
  if (parsed < 0 || parsed > 65_535) throw new Error("WORKER_INTERNAL_PORT_INVALID");
  return parsed;
}

/** Reads the worker entrypoint settings once; secret values are kept out of diagnostics. */
export function loadWorkerRuntimeConfig(environment: WorkerRuntimeEnvironment = process.env): WorkerRuntimeConfig {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const redisUrl = environment.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required");
  let parsedRedisUrl: URL;
  try { parsedRedisUrl = new URL(redisUrl); } catch { throw new Error("REDIS_URL_INVALID"); }
  const redisDatabase = parsedRedisUrl.pathname.length > 1 ? parsedRedisUrl.pathname.slice(1) : "0";
  if ((parsedRedisUrl.protocol !== "redis:" && parsedRedisUrl.protocol !== "rediss:") || !parsedRedisUrl.hostname) {
    throw new Error("REDIS_URL_INVALID");
  }
  if (!/^\d+$/.test(redisDatabase) || !Number.isSafeInteger(Number(redisDatabase))) throw new Error("REDIS_URL_INVALID");
  const profileDirectory = environment.WORKER_PROFILE_DIR;
  if (!profileDirectory) throw new Error("WORKER_PROFILE_DIR is required");

  const configuredBrowserChannel = environment.WORKER_BROWSER_CHANNEL;
  if (configuredBrowserChannel && configuredBrowserChannel !== "chrome" && configuredBrowserChannel !== "msedge") {
    throw new Error("WORKER_BROWSER_CHANNEL_INVALID");
  }
  const browserChannel = configuredBrowserChannel === "chrome" || configuredBrowserChannel === "msedge"
    ? configuredBrowserChannel
    : undefined;
  const databasePoolMax = Number(environment.WORKER_DB_POOL_MAX ?? "8");
  if (!Number.isInteger(databasePoolMax) || databasePoolMax < 4 || databasePoolMax > 32) {
    throw new Error("WORKER_DB_POOL_MAX_INVALID");
  }
  const serviceSecret = environment.WORKER_AUTH_SECRET;
  if (!serviceSecret) throw new Error("WORKER_AUTH_SECRET_REQUIRED");
  const internalHost = (environment.WORKER_INTERNAL_HOST ?? "0.0.0.0").trim();
  if (!internalHost) throw new Error("WORKER_INTERNAL_HOST_INVALID");

  const readinessEnvironment = Object.freeze({ GOLDIS_API_READY_URL: workerApiReadinessUrl(environment).toString() });

  const resultApiUrl = environment.WORKER_RESULT_API_URL;
  const publicOrigin = environment.PUBLIC_APP_ORIGIN;
  try {
    const resultUrl = new URL(resultApiUrl || "");
    const originUrl = new URL(publicOrigin || "");
    if (!resultApiUrl || !serviceSecret || serviceSecret.length < 32 || !publicOrigin
      || !["http:", "https:"].includes(resultUrl.protocol) || resultUrl.username || resultUrl.password || resultUrl.search || resultUrl.hash
      || originUrl.origin !== publicOrigin || !["http:", "https:"].includes(originUrl.protocol)) {
      throw new Error("WORKER_RESULT_CONFIG_INVALID");
    }
  } catch { throw new Error("WORKER_RESULT_CONFIG_INVALID"); }

  const stagingEnvironment = Object.freeze(Object.fromEntries(Object.entries(environment)
    .filter(([name]) => name === "WORKER_STAGING_DIR" || name === "WORKER_STAGING_KEY_VERSION" || /^WORKER_STAGING_KEY_V[1-9]\d*$/.test(name))));
  const portalEnvironment = Object.freeze(Object.fromEntries(Object.entries(environment)
    .filter(([name]) => ["PZU_LOGIN", "PZU_PASSWORD", "COMPENSA_LOGIN", "COMPENSA_PASSWORD", "WORKER_PZU_LOGIN_TEST_RUN_ID",
      "WORKER_PORTAL_MIN_ACTION_INTERVAL_MS", "WORKER_AUTH_SECRET"].includes(name))));

  return Object.freeze({
    databaseUrl,
    redisUrl,
    profileDirectory,
    headless: flag(environment.WORKER_HEADLESS, "1", "WORKER_HEADLESS_INVALID"),
    chromiumSandbox: flag(environment.WORKER_CHROMIUM_SANDBOX, "0", "WORKER_CHROMIUM_SANDBOX_INVALID"),
    browserChannel,
    databasePoolMax,
    livePortals: flag(environment.WORKER_LIVE_PORTALS, "0", "WORKER_LIVE_PORTALS_INVALID"),
    internalHost,
    internalPort: port(environment.WORKER_INTERNAL_PORT),
    serviceSecret,
    readinessEnvironment,
    resultForwarderEnvironment: Object.freeze({
      WORKER_RESULT_API_URL: resultApiUrl!,
      WORKER_AUTH_SECRET: serviceSecret,
      PUBLIC_APP_ORIGIN: publicOrigin!,
    }),
    portalEnvironment,
    stagingEnvironment,
    stagingDirectory: environment.WORKER_STAGING_DIR,
    stagingKeyVersion: environment.WORKER_STAGING_KEY_VERSION,
    portalConfigPath: environment.WORKER_PORTAL_CONFIG_PATH,
  });
}
