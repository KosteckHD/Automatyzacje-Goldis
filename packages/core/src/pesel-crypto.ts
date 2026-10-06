import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { IdentityMatchV1 } from "./index";

const ACTIVE_VERSION_ENV = "PESEL_ENCRYPTION_ACTIVE_KEY_VERSION";
const KEYRING_ENV = "PESEL_ENCRYPTION_KEYS_BASE64";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PeselEncryptionContext = Readonly<{ runId: string; sourceRowId: string }>;
export type EncryptedPeselV1 = Readonly<{ keyVersion: number; ciphertext: string }>;
export type EncryptedRunIdentityRecord = Readonly<Omit<IdentityMatchV1, "pesel" | "schemaVersion"> & {
  runId: string;
  peselCiphertext: string;
  peselKeyVersion: number;
}>;
type Environment = Readonly<Record<string, string | undefined>>;

export class PeselEncryptionError extends Error {
  constructor(readonly code: "PESEL_ENCRYPTION_CONFIG_INVALID" | "PESEL_CONTEXT_INVALID" | "PESEL_FORMAT_INVALID" | "PESEL_CIPHERTEXT_INVALID" | "PESEL_DECRYPT_FAILED" | "PESEL_ENCRYPTION_FAILED") {
    super(code);
    this.name = "PeselEncryptionError";
  }
}

type Keyring = Readonly<{ activeVersion: number; keys: ReadonlyMap<number, Buffer> }>;

function invalidConfig(): never {
  throw new PeselEncryptionError("PESEL_ENCRYPTION_CONFIG_INVALID");
}

function readKeyring(environment: Environment): Keyring {
  const versionText = environment[ACTIVE_VERSION_ENV];
  const encodedKeyring = environment[KEYRING_ENV];
  if (!versionText || !/^[1-9]\d*$/.test(versionText) || !encodedKeyring) return invalidConfig();

  let decodedJson: string;
  try {
    const bytes = Buffer.from(encodedKeyring, "base64");
    if (bytes.toString("base64") !== encodedKeyring) return invalidConfig();
    decodedJson = bytes.toString("utf8");
  } catch {
    return invalidConfig();
  }

  let entries: unknown;
  try {
    entries = JSON.parse(decodedJson);
  } catch {
    return invalidConfig();
  }
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return invalidConfig();

  const keys = new Map<number, Buffer>();
  for (const [versionKey, encodedKey] of Object.entries(entries)) {
    if (!/^[1-9]\d*$/.test(versionKey) || typeof encodedKey !== "string") return invalidConfig();
    const version = Number(versionKey);
    if (!Number.isSafeInteger(version) || keys.has(version)) return invalidConfig();
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== 32 || key.toString("base64") !== encodedKey) return invalidConfig();
    keys.set(version, key);
  }

  const activeVersion = Number(versionText);
  if (!Number.isSafeInteger(activeVersion) || !keys.has(activeVersion)) return invalidConfig();
  return { activeVersion, keys };
}

function associatedData(context: PeselEncryptionContext): Buffer {
  if (!uuidPattern.test(context.runId) || !uuidPattern.test(context.sourceRowId)) {
    throw new PeselEncryptionError("PESEL_CONTEXT_INVALID");
  }
  return Buffer.from(`goldis:pesel:v1:${context.runId.toLowerCase()}:${context.sourceRowId.toLowerCase()}`, "utf8");
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new PeselEncryptionError("PESEL_CIPHERTEXT_INVALID");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new PeselEncryptionError("PESEL_CIPHERTEXT_INVALID");
  return decoded;
}

/** Returns the exact identity fields safe to persist; plaintext PESEL is intentionally absent. */
export function encryptIdentityForPersistence(
  identity: IdentityMatchV1,
  runId: string,
  environment: Environment = process.env,
): EncryptedRunIdentityRecord {
  const encrypted = encryptPesel(identity.pesel, { runId, sourceRowId: identity.sourceRowId }, environment);
  return {
    runId,
    sourceRowId: identity.sourceRowId,
    regon: identity.regon,
    companyName: identity.companyName,
    firstName: identity.firstName,
    lastName: identity.lastName,
    peselCiphertext: encrypted.ciphertext,
    peselKeyVersion: encrypted.keyVersion,
    matchMethod: identity.matchMethod,
    adapterVersion: identity.adapterVersion,
  };
}

/** Safe log token for known errors; never serialize arbitrary exception messages. */
export function peselErrorCodeForLog(error: unknown): string {
  return error instanceof PeselEncryptionError ? error.code : "PESEL_OPERATION_FAILED";
}

/** Encrypts a PESEL using AES-256-GCM; key material is read from server configuration only. */
export function encryptPesel(pesel: string, context: PeselEncryptionContext, environment: Environment = process.env): EncryptedPeselV1 {
  const keyring = readKeyring(environment);
  const aad = associatedData(context);
  if (!/^\d{11}$/.test(pesel)) throw new PeselEncryptionError("PESEL_FORMAT_INVALID");

  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyring.keys.get(keyring.activeVersion)!, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(pesel, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      keyVersion: keyring.activeVersion,
      ciphertext: `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`,
    };
  } catch {
    throw new PeselEncryptionError("PESEL_ENCRYPTION_FAILED");
  }
}

/** Decrypts only with the recorded key version and the same run/source binding. */
export function decryptPesel(record: EncryptedPeselV1, context: PeselEncryptionContext, environment: Environment = process.env): string {
  if (!record || typeof record !== "object" || !Number.isSafeInteger(record.keyVersion)
    || record.keyVersion < 1 || typeof record.ciphertext !== "string") {
    throw new PeselEncryptionError("PESEL_CIPHERTEXT_INVALID");
  }
  const keyring = readKeyring(environment);
  const key = keyring.keys.get(record.keyVersion);
  if (!key) return invalidConfig();
  const aad = associatedData(context);
  const parts = record.ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new PeselEncryptionError("PESEL_CIPHERTEXT_INVALID");

  const iv = decodeBase64Url(parts[1]);
  const tag = decodeBase64Url(parts[2]);
  const ciphertext = decodeBase64Url(parts[3]);
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new PeselEncryptionError("PESEL_CIPHERTEXT_INVALID");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (!/^\d{11}$/.test(plaintext)) throw new PeselEncryptionError("PESEL_DECRYPT_FAILED");
    return plaintext;
  } catch {
    throw new PeselEncryptionError("PESEL_DECRYPT_FAILED");
  }
}
