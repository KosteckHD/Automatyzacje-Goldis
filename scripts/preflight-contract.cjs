const path = require("node:path");

function inspectRuntimeEnvironment(env) {
  const errors = [];
  const mode = env.WORKER_LIVE_PORTALS || "0";
  if (mode !== "0" && mode !== "1") errors.push("WORKER_LIVE_PORTALS");
  const isLive = mode === "1";
  const required = (key, valid = (value) => Boolean(value?.trim())) => {
    const value = env[key];
    if (!valid(value ?? "")) errors.push(key);
    return value;
  };
  const absolutePath = (value) => Boolean(value && path.isAbsolute(value));

  required("DATABASE_URL", (value) => /^postgres(?:ql)?:\/\//i.test(value));
  required("REDIS_URL", (value) => /^rediss?:\/\//i.test(value));
  required("WORKER_AUTH_SECRET", (value) => Buffer.byteLength(value) >= 32);
  required("WORKER_PROFILE_DIR", absolutePath);
  if (!new Set(["0", "1"]).has(env.WORKER_HEADLESS || "0")) errors.push("WORKER_HEADLESS");
  const port = Number(env.WORKER_INTERNAL_PORT || "3022");
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("WORKER_INTERNAL_PORT");
  if (!new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]).has(env.WORKER_INTERNAL_HOST || "127.0.0.1")) errors.push("WORKER_INTERNAL_HOST");
  try {
    const origin = new URL(env.PUBLIC_APP_ORIGIN || "");
    if (!(["https:", "http:"].includes(origin.protocol)) || origin.origin !== env.PUBLIC_APP_ORIGIN
      || (origin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error();
  } catch { errors.push("PUBLIC_APP_ORIGIN"); }

  const keyVersion = required("PESEL_ENCRYPTION_ACTIVE_KEY_VERSION");
  const encodedKeyring = required("PESEL_ENCRYPTION_KEYS_BASE64");
  if (keyVersion && encodedKeyring) {
    try {
      const keyring = JSON.parse(Buffer.from(encodedKeyring, "base64").toString("utf8"));
      if (!keyring || typeof keyring !== "object" || Array.isArray(keyring)
        || typeof keyring[keyVersion] !== "string" || Buffer.from(keyring[keyVersion], "base64").length !== 32) throw new Error();
    } catch { errors.push("PESEL_ENCRYPTION_KEYS_BASE64"); }
  }
  if (isLive) {
    for (const key of ["PZU_LOGIN", "PZU_PASSWORD", "COMPENSA_LOGIN", "COMPENSA_PASSWORD"]) required(key);
    required("WORKER_PORTAL_CONFIG_PATH", absolutePath);
    required("WORKER_STAGING_DIR", absolutePath);
    required("WORKER_STAGING_KEY_VERSION");
    required("WORKER_STAGING_KEY_V1", (value) => Buffer.from(value, "base64").length === 32);
  }
  return { mode: isLive ? "live" : "off", errors: [...new Set(errors)] };
}

module.exports = { inspectRuntimeEnvironment };
