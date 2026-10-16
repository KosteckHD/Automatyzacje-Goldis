const path = require("node:path");
const { isIP } = require("node:net");

function inspectRuntimeEnvironment(env) {
  const errors = [];
  const appEnvironment = env.APP_ENV || "development";
  const isProduction = appEnvironment === "production";
  if (!new Set(["development", "test", "production"]).has(appEnvironment)) errors.push("APP_ENV");
  const mode = env.WORKER_LIVE_PORTALS || "0";
  if (mode !== "0" && mode !== "1") errors.push("WORKER_LIVE_PORTALS");
  const isLive = mode === "1";
  const required = (key, valid = (value) => Boolean(value?.trim())) => {
    const value = env[key];
    if (!valid(value ?? "")) errors.push(key);
    return value;
  };
  const absolutePath = (value) => Boolean(value && path.isAbsolute(value));
  const registryProvider = (env.GOLDIS_ENRICHMENT_PROVIDER || "disabled").trim().toLowerCase();
  if (!new Set(["disabled", "mf-vat"]).has(registryProvider)) errors.push("GOLDIS_ENRICHMENT_PROVIDER");
  if (isProduction && registryProvider !== "mf-vat") errors.push("GOLDIS_ENRICHMENT_PROVIDER");
  if (registryProvider === "mf-vat") {
    if (!/^(production|test)$/.test((env.MF_VAT_ENVIRONMENT || "production").trim().toLowerCase())) errors.push("MF_VAT_ENVIRONMENT");
    if (!/^[a-fA-F0-9]{64,128}$/.test(env.REGISTRY_CACHE_HMAC_KEY || "")
      || (env.REGISTRY_CACHE_HMAC_KEY || "").length % 2 !== 0) errors.push("REGISTRY_CACHE_HMAC_KEY");
  }

  required("DATABASE_URL", (value) => /^postgres(?:ql)?:\/\//i.test(value));
  required("MIGRATOR_DATABASE_URL", (value) => {
    if (!/^postgres(?:ql)?:\/\//i.test(value)) return false;
    try { return new URL(value).username === "goldis_migrator"; } catch { return false; }
  });
  required("WORKER_DATABASE_URL", (value) => {
    if (!/^postgres(?:ql)?:\/\//i.test(value)) return false;
    try { return new URL(value).username === "goldis_worker"; } catch { return false; }
  });
  required("ENRICHMENT_DATABASE_URL", (value) => {
    if (!/^postgres(?:ql)?:\/\//i.test(value)) return false;
    try { return new URL(value).username === "goldis_enrichment"; } catch { return false; }
  });
  if (env.DATABASE_URL && /^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL)) {
    try { if (new URL(env.DATABASE_URL).username !== "goldis_api") errors.push("DATABASE_URL_ROLE"); }
    catch { /* The URL validator reports malformed input. */ }
  }
  const redisApiPassword = required("REDIS_API_PASSWORD", (value) => /^[A-Fa-f0-9]{64,128}$/.test(value));
  const redisWorkerPassword = required("REDIS_WORKER_PASSWORD", (value) => /^[A-Fa-f0-9]{64,128}$/.test(value));
  required("REDIS_URL", (value) => {
    if (!/^rediss?:\/\//i.test(value)) return false;
    try {
      const redis = new URL(value);
      return redis.username === "goldis_api" && redis.password === redisApiPassword && redis.pathname === "/0"
        && !redis.search && !redis.hash;
    } catch { return false; }
  });
  required("WORKER_REDIS_URL", (value) => {
    if (!/^rediss?:\/\//i.test(value)) return false;
    try {
      const redis = new URL(value);
      return redis.username === "goldis_worker" && redis.password === redisWorkerPassword && redis.pathname === "/0"
        && !redis.search && !redis.hash;
    } catch { return false; }
  });
  required("WORKER_AUTH_SECRET", (value) => Buffer.byteLength(value) >= 32);
  required("PRIVILEGED_ACTION_BINDING_KEY", (value) => Buffer.byteLength(value) >= 32);
  required("WORKER_PROFILE_DIR", absolutePath);
  for (const key of ["MF_VAT_MIN_REQUEST_INTERVAL_MS", "WORKER_PORTAL_MIN_ACTION_INTERVAL_MS"]) {
    const configured = env[key];
    const normalized = configured?.trim() ?? "";
    if (normalized && (!/^\d+$/.test(normalized) || Number(normalized) < 1 || Number(normalized) > 60_000)) errors.push(key);
  }
  if (!new Set(["0", "1"]).has(env.WORKER_HEADLESS || "0")) errors.push("WORKER_HEADLESS");
  if (!new Set(["0", "1"]).has(env.WORKER_CHROMIUM_SANDBOX || "0")) errors.push("WORKER_CHROMIUM_SANDBOX");
  if (isProduction && env.WORKER_CHROMIUM_SANDBOX !== "1") errors.push("WORKER_CHROMIUM_SANDBOX");
  if (!new Set(["0", "1"]).has(env.ARTIFACT_REQUIRE_ENCRYPTION || "0")) errors.push("ARTIFACT_REQUIRE_ENCRYPTION");
  if (isProduction && env.ARTIFACT_REQUIRE_ENCRYPTION !== "1") errors.push("ARTIFACT_REQUIRE_ENCRYPTION");
  if (env.IMPORT_PARSER_URL || appEnvironment === "production") {
    try {
      const parserUrl = new URL(env.IMPORT_PARSER_URL || "");
      if (!(["http:", "https:"].includes(parserUrl.protocol)) || parserUrl.username || parserUrl.password
        || parserUrl.search || parserUrl.hash || !["/", "/internal/parse-xlsx"].includes(parserUrl.pathname)) throw new Error();
    } catch { errors.push("IMPORT_PARSER_URL"); }
    if (Buffer.byteLength(env.IMPORT_PARSER_SHARED_SECRET || "") < 32) errors.push("IMPORT_PARSER_SHARED_SECRET");
  }
  if (isProduction && env.IMPORT_PARSER_URL !== "http://import-parser:3010") errors.push("IMPORT_PARSER_URL");
  const port = Number(env.WORKER_INTERNAL_PORT || "3022");
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("WORKER_INTERNAL_PORT");
  if (!new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]).has(env.WORKER_INTERNAL_HOST || "127.0.0.1")) errors.push("WORKER_INTERNAL_HOST");
  try {
    const origin = new URL(env.PUBLIC_APP_ORIGIN || "");
    if (!(["https:", "http:"].includes(origin.protocol)) || origin.origin !== env.PUBLIC_APP_ORIGIN
      || (origin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error();
  } catch { errors.push("PUBLIC_APP_ORIGIN"); }
  if (isProduction && !/^https:\/\//i.test(env.PUBLIC_APP_ORIGIN || "")) errors.push("PUBLIC_APP_ORIGIN");
  if (isProduction) {
    const proxies = (env.TRUST_PROXY_IPS || "").split(",").map((part) => part.trim());
    if (proxies.length < 1 || proxies.some((address) => !address || isIP(address) === 0)) errors.push("TRUST_PROXY_IPS");
  }

  for (const [versionName, keyringName] of [
    ["PESEL_ENCRYPTION_ACTIVE_KEY_VERSION", "PESEL_ENCRYPTION_KEYS_BASE64"],
    ["ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION", "ARTIFACT_ENCRYPTION_KEYS_BASE64"],
  ]) {
    const keyVersion = required(versionName, (value) => /^[1-9]\d*$/.test(value));
    const encodedKeyring = required(keyringName);
    if (keyVersion && encodedKeyring) {
      try {
        const decoded = Buffer.from(encodedKeyring, "base64");
        const keyring = JSON.parse(decoded.toString("utf8"));
        const activeKey = keyring?.[keyVersion];
        const decodedKey = typeof activeKey === "string" ? Buffer.from(activeKey, "base64") : Buffer.alloc(0);
        if (decoded.toString("base64") !== encodedKeyring || !keyring || typeof keyring !== "object" || Array.isArray(keyring)
          || typeof activeKey !== "string" || decodedKey.length !== 32 || decodedKey.toString("base64") !== activeKey) throw new Error();
      } catch { errors.push(keyringName); }
    }
  }
  if (isLive) {
    for (const key of ["PZU_LOGIN", "PZU_PASSWORD", "COMPENSA_LOGIN", "COMPENSA_PASSWORD"]) required(key);
    required("WORKER_PORTAL_CONFIG_PATH", absolutePath);
  }
  if (isLive || env.WORKER_STAGING_DIR || env.WORKER_STAGING_KEY_VERSION || env.WORKER_STAGING_KEY_V1) {
    required("WORKER_STAGING_DIR", absolutePath);
    const configuredVersion = required("WORKER_STAGING_KEY_VERSION", (value) => /^[1-9]\d*$/.test(value));
    const keyVersion = /^[1-9]\d*$/.test(configuredVersion || "") ? configuredVersion : "1";
    required(`WORKER_STAGING_KEY_V${keyVersion}`, (value) => /^[A-Za-z0-9_-]{43}=?$/.test(value)
      && Buffer.from(value, "base64url").length === 32);
  }
  return { mode: isLive ? "live" : "off", errors: [...new Set(errors)] };
}

module.exports = { inspectRuntimeEnvironment };
