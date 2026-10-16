import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadApiRuntimeConfig, loadApiSecretConfig } from "../../infrastructure/config";

const magic = Buffer.from("GOLDISAF", "ascii");
const formatVersion = 1;
const headerBytes = magic.length + 1 + 4 + 12 + 16;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ArtifactCryptoError extends Error {
  constructor(
    readonly code: "ARTIFACT_ENCRYPTION_CONFIG_INVALID" | "ARTIFACT_ENCRYPTION_FAILED" | "ARTIFACT_DECRYPT_FAILED",
  ) {
    super(code);
    this.name = "ArtifactCryptoError";
  }
}

export type ArtifactCryptoEnvironment = Readonly<Record<string, string | undefined>>;
export type ArtifactDecryption = Readonly<{ bytes: Buffer; encrypted: boolean }>;

function configuredArtifactEnvironment(): ArtifactCryptoEnvironment {
  const runtimeConfig = loadApiRuntimeConfig();
  const secretConfig = loadApiSecretConfig();
  return {
    APP_ENV: runtimeConfig.appEnvironment,
    ARTIFACT_REQUIRE_ENCRYPTION: runtimeConfig.artifactEncryptionRequired ? "1" : "0",
    ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION: secretConfig.artifactEncryptionActiveKeyVersion,
    ARTIFACT_ENCRYPTION_KEYS_BASE64: secretConfig.artifactEncryptionKeysBase64,
  };
}

function keyring(environment: ArtifactCryptoEnvironment) {
  const activeVersionText = environment.ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION;
  const encoded = environment.ARTIFACT_ENCRYPTION_KEYS_BASE64;
  if (!activeVersionText || !/^[1-9]\d*$/.test(activeVersionText) || !encoded) {
    throw new ArtifactCryptoError("ARTIFACT_ENCRYPTION_CONFIG_INVALID");
  }
  let entries: unknown;
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) throw new Error();
    entries = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new ArtifactCryptoError("ARTIFACT_ENCRYPTION_CONFIG_INVALID");
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new ArtifactCryptoError("ARTIFACT_ENCRYPTION_CONFIG_INVALID");
  }
  const keys = new Map<number, Buffer>();
  for (const [versionText, encodedKey] of Object.entries(entries)) {
    if (!/^[1-9]\d*$/.test(versionText) || typeof encodedKey !== "string") {
      throw new ArtifactCryptoError("ARTIFACT_ENCRYPTION_CONFIG_INVALID");
    }
    const decoded = Buffer.from(encodedKey, "base64");
    const version = Number(versionText);
    if (!Number.isSafeInteger(version) || decoded.length !== 32 || decoded.toString("base64") !== encodedKey) {
      throw new ArtifactCryptoError("ARTIFACT_ENCRYPTION_CONFIG_INVALID");
    }
    keys.set(version, decoded);
  }
  const activeVersion = Number(activeVersionText);
  const activeKey = keys.get(activeVersion);
  if (!activeKey) throw new ArtifactCryptoError("ARTIFACT_ENCRYPTION_CONFIG_INVALID");
  return { activeVersion, activeKey, keys };
}

function associatedData(artifactId: string): Buffer {
  if (!uuidPattern.test(artifactId)) throw new ArtifactCryptoError("ARTIFACT_DECRYPT_FAILED");
  return Buffer.from(`goldis:artifact:v1:${artifactId.toLowerCase()}`, "utf8");
}

/** Encrypts artifacts with AES-256-GCM and binds the ciphertext to its immutable artifact ID. */
export function encryptArtifactBytes(
  artifactId: string,
  bytes: Uint8Array,
  environment?: ArtifactCryptoEnvironment,
): Buffer {
  if (!uuidPattern.test(artifactId)) throw new ArtifactCryptoError("ARTIFACT_DECRYPT_FAILED");
  const config = keyring(environment ?? configuredArtifactEnvironment());
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", config.activeKey, iv, { authTagLength: 16 });
    cipher.setAAD(associatedData(artifactId));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const header = Buffer.alloc(headerBytes);
    magic.copy(header, 0);
    header.writeUInt8(formatVersion, magic.length);
    header.writeUInt32BE(config.activeVersion, magic.length + 1);
    iv.copy(header, magic.length + 5);
    cipher.getAuthTag().copy(header, magic.length + 17);
    return Buffer.concat([header, ciphertext]);
  } catch (error) {
    if (error instanceof ArtifactCryptoError) throw error;
    throw new ArtifactCryptoError("ARTIFACT_ENCRYPTION_FAILED");
  }
}

/** Reads current ciphertext and recognizes old plaintext exports for controlled migration. */
export function decryptStoredArtifactBytes(
  artifactId: string,
  stored: Uint8Array,
  environment?: ArtifactCryptoEnvironment,
): ArtifactDecryption {
  const configuredEnvironment = environment ?? configuredArtifactEnvironment();
  const buffer = Buffer.from(stored);
  if (buffer.length < magic.length || !buffer.subarray(0, magic.length).equals(magic)) {
    if (configuredEnvironment.APP_ENV === "production" || configuredEnvironment.ARTIFACT_REQUIRE_ENCRYPTION === "1") {
      throw new ArtifactCryptoError("ARTIFACT_DECRYPT_FAILED");
    }
    return { bytes: buffer, encrypted: false };
  }
  if (buffer.length <= headerBytes || buffer.readUInt8(magic.length) !== formatVersion) {
    throw new ArtifactCryptoError("ARTIFACT_DECRYPT_FAILED");
  }
  const version = buffer.readUInt32BE(magic.length + 1);
  const key = keyring(configuredEnvironment).keys.get(version);
  if (!key) throw new ArtifactCryptoError("ARTIFACT_ENCRYPTION_CONFIG_INVALID");
  const iv = buffer.subarray(magic.length + 5, magic.length + 17);
  const tag = buffer.subarray(magic.length + 17, headerBytes);
  const ciphertext = buffer.subarray(headerBytes);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(associatedData(artifactId));
    decipher.setAuthTag(tag);
    return { bytes: Buffer.concat([decipher.update(ciphertext), decipher.final()]), encrypted: true };
  } catch {
    throw new ArtifactCryptoError("ARTIFACT_DECRYPT_FAILED");
  }
}
