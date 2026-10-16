import { containsControlCharacters } from "../../shared/control-characters";

export type AuthMailProviderKind = "disabled" | "resend";

export type AuthMailConfig = Readonly<{
  enabled: boolean;
  provider: AuthMailProviderKind;
  publicOrigin: string;
  from: string;
  replyTo: string | null;
  resendApiKey: string | null;
}>;

const mailboxPattern = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

function safeMailbox(value: string): boolean {
  return value.length <= 254 && mailboxPattern.test(value) && !containsControlCharacters(value);
}

function parseFrom(value: string): boolean {
  if (value.length > 340 || containsControlCharacters(value)) return false;
  const match = /^(?:[^<>]{1,80} )?<([^<>]+)>$/.exec(value);
  return match ? safeMailbox(match[1]) : safeMailbox(value);
}

export function parseAuthMailConfig(env: Readonly<Record<string, string | undefined>>): AuthMailConfig {
  const flag = env.GOLDIS_PASSWORD_RECOVERY_ENABLED ?? "0";
  if (flag !== "0" && flag !== "1") throw new Error("AUTH_MAIL_RECOVERY_FLAG_INVALID");
  const enabled = flag === "1";
  const providerText = env.GOLDIS_EMAIL_PROVIDER?.trim() || "disabled";
  if (providerText !== "disabled" && providerText !== "resend") throw new Error("AUTH_MAIL_PROVIDER_INVALID");
  const provider = providerText as AuthMailProviderKind;
  const publicOrigin = (env.PUBLIC_APP_ORIGIN || "http://127.0.0.1:3000").trim();
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new Error("AUTH_MAIL_PUBLIC_ORIGIN_INVALID");
  }
  if (
    origin.origin !== publicOrigin ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== "https:" && !(env.NODE_ENV !== "production" && origin.protocol === "http:"))
  ) {
    throw new Error("AUTH_MAIL_PUBLIC_ORIGIN_INVALID");
  }
  const from = (env.GOLDIS_EMAIL_FROM || "").trim();
  const replyToText = (env.GOLDIS_EMAIL_REPLY_TO || "").trim();
  if (enabled && (!parseFrom(from) || (replyToText && !safeMailbox(replyToText)))) {
    throw new Error("AUTH_MAIL_SENDER_CONFIGURATION_INVALID");
  }
  const resendApiKey = (env.RESEND_API_KEY || "").trim();
  if (enabled && (provider !== "resend" || !/^re_[A-Za-z0-9_-]{20,}$/.test(resendApiKey))) {
    throw new Error("AUTH_MAIL_PROVIDER_CONFIGURATION_INVALID");
  }
  return { enabled, provider, publicOrigin, from, replyTo: replyToText || null, resendApiKey: resendApiKey || null };
}

export function assertAuthMailProductionConfiguration(env: Readonly<Record<string, string | undefined>>): void {
  if (env.APP_ENV !== "production") return;
  const config = parseAuthMailConfig(env);
  if (!config.enabled) return;
  if (
    config.provider !== "resend" ||
    !config.resendApiKey ||
    !/^[1-9]\d*$/.test(env.AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION || "") ||
    !validKeyring(env.AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION, env.AUTH_MAIL_ENCRYPTION_KEYS_BASE64)
  ) {
    throw new Error("AUTH_MAIL_PRODUCTION_CONFIGURATION_INVALID");
  }
}

function validKeyring(activeText: string | undefined, encoded: string | undefined): boolean {
  if (!activeText || !encoded) return false;
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) return false;
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const key = (parsed as Record<string, unknown>)[activeText];
    if (typeof key !== "string") return false;
    const bytes = Buffer.from(key, "base64");
    return bytes.length === 32 && bytes.toString("base64") === key;
  } catch {
    return false;
  }
}
