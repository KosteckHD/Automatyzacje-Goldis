"use strict";

const { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } = require("node:crypto");
const { createReadStream, createWriteStream } = require("node:fs");
const { open, unlink } = require("node:fs/promises");
const { pipeline } = require("node:stream/promises");

const MAGIC = Buffer.from("GOLDBAK1", "ascii");
const HEADER_BYTES = 40;
const TAG_BYTES = 16;
const ITERATIONS = 600_000;
const MIN_ITERATIONS = 250_000;
const MAX_ITERATIONS = 1_000_000;

function deriveKey(passphrase, salt, iterations) {
  if (typeof passphrase !== "string" || Buffer.byteLength(passphrase, "utf8") < 16) {
    throw new Error("BACKUP_PASSPHRASE_TOO_SHORT");
  }
  return pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
}

function headerFor(salt, nonce, iterations) {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  salt.copy(header, 8);
  nonce.copy(header, 24);
  header.writeUInt32BE(iterations, 36);
  return header;
}

async function encryptFile(inputPath, outputPath, passphrase) {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = deriveKey(passphrase, salt, ITERATIONS);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  let handle;
  try {
    handle = await open(outputPath, "wx", 0o600);
    await handle.writeFile(headerFor(salt, nonce, ITERATIONS));
    await handle.close();
    handle = null;
    await pipeline(createReadStream(inputPath), cipher, createWriteStream(outputPath, { flags: "a" }));
    const tagFile = await open(outputPath, "a");
    try { await tagFile.writeFile(cipher.getAuthTag()); await tagFile.sync(); }
    finally { await tagFile.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
    throw error;
  } finally {
    key.fill(0);
  }
}

async function decryptFile(inputPath, outputPath, passphrase) {
  let input;
  try {
    input = await open(inputPath, "r");
    const info = await input.stat();
    if (info.size < HEADER_BYTES + TAG_BYTES) throw new Error("BACKUP_FORMAT_INVALID");
    const header = Buffer.alloc(HEADER_BYTES);
    await input.read(header, 0, header.length, 0);
    if (!header.subarray(0, 8).equals(MAGIC)) throw new Error("BACKUP_FORMAT_INVALID");
    const salt = header.subarray(8, 24);
    const nonce = header.subarray(24, 36);
    const iterations = header.readUInt32BE(36);
    if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new Error("BACKUP_KDF_PARAMETERS_INVALID");
    const key = deriveKey(passphrase, salt, iterations);
    const tag = Buffer.alloc(TAG_BYTES);
    await input.read(tag, 0, tag.length, info.size - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    await input.close();
    input = null;
    try {
      await pipeline(
        createReadStream(inputPath, { start: HEADER_BYTES, end: info.size - TAG_BYTES - 1 }),
        decipher,
        createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
      );
    } catch {
      await unlink(outputPath).catch(() => undefined);
      throw new Error("BACKUP_AUTHENTICATION_FAILED");
    } finally {
      key.fill(0);
    }
  } finally {
    if (input) await input.close().catch(() => undefined);
  }
}

async function main(argv) {
  const [operation, inputPath, outputPath] = argv;
  if (!(["encrypt", "decrypt"].includes(operation)) || !inputPath || !outputPath || argv.length !== 3) {
    throw new Error("USAGE: goldis-backup-crypto.cjs encrypt|decrypt input output");
  }
  const passphrase = process.env.GOLDIS_BACKUP_PASSPHRASE;
  if (!passphrase) throw new Error("BACKUP_PASSPHRASE_REQUIRED");
  if (operation === "encrypt") await encryptFile(inputPath, outputPath, passphrase);
  else await decryptFile(inputPath, outputPath, passphrase);
  process.stdout.write(`${operation === "encrypt" ? "BACKUP_ENCRYPTED" : "BACKUP_DECRYPTED"}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "BACKUP_CRYPTO_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = { decryptFile, encryptFile };
