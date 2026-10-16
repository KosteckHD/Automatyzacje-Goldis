import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadApiSecretConfig } from "../../infrastructure/config";
import { containsControlCharacters } from "../../shared/control-characters";
import type { AuthMailContent } from "./auth-mail-templates";

export type EncryptedAuthMail = Readonly<{ ciphertext: Buffer; nonce: Buffer; authTag: Buffer; keyVersion: number }>;

function keyring(): Readonly<{ activeVersion: number; keys: ReadonlyMap<number, Buffer> }> {
  const configuredSecrets = loadApiSecretConfig();
  const activeText = configuredSecrets.authMailEncryptionActiveKeyVersion;
  const encoded = configuredSecrets.authMailEncryptionKeysBase64;
  if (!activeText || !/^[1-9]\d*$/.test(activeText) || !encoded) throw new Error("AUTH_MAIL_KEYRING_UNAVAILABLE");
  let parsed: unknown;
  try {
    const jsonBytes = Buffer.from(encoded, "base64");
    if (jsonBytes.toString("base64") !== encoded) throw new Error();
    parsed = JSON.parse(jsonBytes.toString("utf8"));
  } catch {
    throw new Error("AUTH_MAIL_KEYRING_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("AUTH_MAIL_KEYRING_INVALID");
  const keys = new Map<number, Buffer>();
  for (const [versionText, keyText] of Object.entries(parsed)) {
    if (!/^[1-9]\d*$/.test(versionText) || typeof keyText !== "string") throw new Error("AUTH_MAIL_KEYRING_INVALID");
    const key = Buffer.from(keyText, "base64");
    if (key.length !== 32 || key.toString("base64") !== keyText) throw new Error("AUTH_MAIL_KEYRING_INVALID");
    keys.set(Number(versionText), key);
  }
  const activeVersion = Number(activeText);
  if (!keys.has(activeVersion)) throw new Error("AUTH_MAIL_KEYRING_INVALID");
  return { activeVersion, keys };
}

function aad(mailId: string): Buffer {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mailId)) {
    throw new Error("AUTH_MAIL_ID_INVALID");
  }
  return Buffer.from(`goldis:auth-mail:v1:${mailId.toLowerCase()}`, "utf8");
}

function validateContent(value: unknown): AuthMailContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AUTH_MAIL_PAYLOAD_INVALID");
  const row = value as Record<string, unknown>;
  const expected = ["from", "to", "replyTo", "subject", "html", "text"];
  if (
    Object.keys(row).some((key) => !expected.includes(key)) ||
    typeof row.from !== "string" ||
    typeof row.to !== "string" ||
    (row.replyTo !== null && typeof row.replyTo !== "string") ||
    typeof row.subject !== "string" ||
    typeof row.html !== "string" ||
    typeof row.text !== "string" ||
    row.from.length > 340 ||
    row.to.length > 254 ||
    (typeof row.replyTo === "string" && row.replyTo.length > 254) ||
    row.subject.length > 180 ||
    row.html.length > 32_000 ||
    row.text.length > 16_000 ||
    containsControlCharacters(row.from) ||
    containsControlCharacters(row.to) ||
    (typeof row.replyTo === "string" && containsControlCharacters(row.replyTo))
  ) {
    throw new Error("AUTH_MAIL_PAYLOAD_INVALID");
  }
  return {
    from: row.from,
    to: row.to,
    replyTo: row.replyTo as string | null,
    subject: row.subject,
    html: row.html,
    text: row.text,
  };
}

export function encryptAuthMailContent(mailId: string, content: AuthMailContent): EncryptedAuthMail {
  const configured = keyring();
  const plaintext = Buffer.from(JSON.stringify(validateContent(content)), "utf8");
  if (plaintext.length > 64 * 1024) throw new Error("AUTH_MAIL_PAYLOAD_TOO_LARGE");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", configured.keys.get(configured.activeVersion)!, nonce);
  cipher.setAAD(aad(mailId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  plaintext.fill(0);
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: configured.activeVersion };
}

export function decryptAuthMailContent(
  mailId: string,
  ciphertext: Buffer,
  nonce: Buffer,
  authTag: Buffer,
  keyVersion: number,
): AuthMailContent {
  try {
    if (
      !Buffer.isBuffer(ciphertext) ||
      ciphertext.length === 0 ||
      ciphertext.length > 64 * 1024 ||
      !Buffer.isBuffer(nonce) ||
      nonce.length !== 12 ||
      !Buffer.isBuffer(authTag) ||
      authTag.length !== 16 ||
      !Number.isInteger(keyVersion) ||
      keyVersion < 1
    )
      throw new Error();
    const key = keyring().keys.get(keyVersion);
    if (!key) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad(mailId));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return validateContent(JSON.parse(plaintext.toString("utf8")));
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new Error("AUTH_MAIL_PAYLOAD_DECRYPT_FAILED");
  }
}
