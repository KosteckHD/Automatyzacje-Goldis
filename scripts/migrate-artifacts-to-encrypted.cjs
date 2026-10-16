"use strict";

const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");
const { open, readFile, rename, unlink } = require("node:fs/promises");
const { dirname, resolve } = require("node:path");
require("reflect-metadata");

const { ExportArtifact, sequelize } = require("../apps/api/dist/infrastructure/database/db");
const { decryptStoredArtifactBytes, encryptArtifactBytes } = require("../apps/api/dist/features/results/public");
const { configuredArtifactRoot, resolveArtifactPath } = require("../apps/api/dist/features/results/public");

function matchesChecksum(bytes, hex) {
  if (!/^[a-f0-9]{64}$/.test(hex)) return false;
  const actual = createHash("sha256").update(bytes).digest();
  const expected = Buffer.from(hex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function replaceAtomically(path, bytes) {
  const temporary = resolve(dirname(path), `.${randomUUID()}.artifact-encryption.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function main() {
  const root = configuredArtifactRoot();
  const artifacts = await ExportArtifact.findAll({ where: { state: "ready" }, order: [["createdAt", "ASC"]] });
  let encrypted = 0;
  let alreadyEncrypted = 0;
  for (const artifact of artifacts) {
    const path = resolveArtifactPath(root, artifact.storageKey);
    const stored = await readFile(path);
    const decrypted = decryptStoredArtifactBytes(artifact.artifactId, stored, {
      ...process.env,
      ARTIFACT_REQUIRE_ENCRYPTION: "0",
    });
    if (decrypted.encrypted) {
      alreadyEncrypted += 1;
      continue;
    }
    if (!matchesChecksum(decrypted.bytes, artifact.sha256)) throw new Error("ARTIFACT_INTEGRITY_FAILED");
    await replaceAtomically(path, encryptArtifactBytes(artifact.artifactId, decrypted.bytes));
    encrypted += 1;
  }
  process.stdout.write(`ARTIFACT_ENCRYPTION_MIGRATION_OK encrypted=${encrypted} already_encrypted=${alreadyEncrypted}\n`);
}

main().catch(() => {
  process.stderr.write("ARTIFACT_ENCRYPTION_MIGRATION_FAILED\n");
  process.exitCode = 1;
}).finally(async () => {
  await sequelize.close().catch(() => undefined);
});
