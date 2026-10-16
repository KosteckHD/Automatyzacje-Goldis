import { isIP } from "node:net";
import { assertAuthMailProductionConfiguration } from "../../features/account-recovery/auth-mail-settings";

export type StartupEnvironment = Readonly<Record<string, string | undefined>>;

function validKeyring(activeText: string | undefined, encoded: string | undefined): boolean {
  if (!activeText || !/^[1-9]\d*$/.test(activeText) || !encoded) return false;
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) return false;
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const key = (parsed as Record<string, unknown>)[activeText];
    if (typeof key !== "string") return false;
    const bytes = Buffer.from(key, "base64");
    return bytes.length === 32 && bytes.toString("base64") === key;
  } catch { return false; }
}

function validUrl(value: string | undefined, scheme: string, username: string): boolean {
  try {
    const url = new URL(value || "");
    return url.protocol === scheme && url.username === username && Boolean(url.password)
      && !url.search && !url.hash;
  } catch { return false; }
}

/** Production-only guard used by the API process itself, including Compose starts. */
export function assertApiStartupConfiguration(env: StartupEnvironment = process.env): void {
  if (env.APP_ENV !== "production") return;
  const errors: string[] = [];
  if (Buffer.byteLength(env.SESSION_SECRET || "", "utf8") < 32) errors.push("SESSION_SECRET");
  if (Buffer.byteLength(env.LOGIN_RATE_LIMIT_SECRET || "", "utf8") < 32) errors.push("LOGIN_RATE_LIMIT_SECRET");
  if (Buffer.byteLength(env.WORKER_AUTH_SECRET || "", "utf8") < 32) errors.push("WORKER_AUTH_SECRET");
  if (env.NODE_ENV !== "production") errors.push("NODE_ENV");
  if (!validUrl(env.DATABASE_URL, "postgres:", "goldis_api")) errors.push("DATABASE_URL_ROLE");
  if (!validUrl(env.REDIS_URL, "redis:", "goldis_api")) errors.push("REDIS_URL_ROLE");
  if (env.PUBLIC_APP_ORIGIN !== (env.PUBLIC_APP_ORIGIN || "").trim()) errors.push("PUBLIC_APP_ORIGIN");
  try {
    const origin = new URL(env.PUBLIC_APP_ORIGIN || "");
    if (origin.protocol !== "https:" || origin.origin !== env.PUBLIC_APP_ORIGIN || origin.username || origin.password) errors.push("PUBLIC_APP_ORIGIN");
  } catch { errors.push("PUBLIC_APP_ORIGIN"); }
  const proxies = (env.TRUST_PROXY_IPS || "").split(",").map((part) => part.trim());
  if (proxies.length !== 1 || proxies[0] !== "172.30.10.10" || proxies.some((address) => isIP(address) === 0)) errors.push("TRUST_PROXY_IPS");
  if (env.ARTIFACT_REQUIRE_ENCRYPTION !== "1") errors.push("ARTIFACT_REQUIRE_ENCRYPTION");
  if (!validKeyring(env.PESEL_ENCRYPTION_ACTIVE_KEY_VERSION, env.PESEL_ENCRYPTION_KEYS_BASE64)) errors.push("PESEL_ENCRYPTION_KEYRING");
  if (!validKeyring(env.ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION, env.ARTIFACT_ENCRYPTION_KEYS_BASE64)) errors.push("ARTIFACT_ENCRYPTION_KEYRING");
  if (env.IMPORT_PARSER_URL !== "http://import-parser:3010") errors.push("IMPORT_PARSER_URL");
  if (Buffer.byteLength(env.IMPORT_PARSER_SHARED_SECRET || "") < 32) errors.push("IMPORT_PARSER_SHARED_SECRET");
  if (Buffer.byteLength(env.PRIVILEGED_ACTION_BINDING_KEY || "") < 32) errors.push("PRIVILEGED_ACTION_BINDING_KEY");
  try { assertAuthMailProductionConfiguration(env); }
  catch { errors.push("AUTH_MAIL_CONFIGURATION"); }
  if (errors.length) throw new Error(`PRODUCTION_CONFIG_INVALID:${[...new Set(errors)].join(",")}`);
}
