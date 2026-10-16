"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { decryptFile, encryptFile } = require("./goldis-backup-crypto.cjs");

test("zaszyfrowany backup przywraca bajty i odrzuca błędne hasło lub modyfikację", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "goldis-backup-crypto-"));
  const source = path.join(root, "synthetic.zip");
  const encrypted = path.join(root, "synthetic.goldis-backup");
  const restored = path.join(root, "restored.zip");
  const wrongOutput = path.join(root, "wrong.zip");
  const passphrase = "synthetic-backup-passphrase-2026";
  const payload = Buffer.concat([Buffer.from("synthetic-fixture\0", "utf8"), Buffer.alloc(128 * 1024, 0x5a)]);
  try {
    await writeFile(source, payload);
    await assert.rejects(encryptFile(source, encrypted, "too-short"), /BACKUP_PASSPHRASE_TOO_SHORT/);
    await encryptFile(source, encrypted, passphrase);
    await assert.rejects(decryptFile(encrypted, wrongOutput, "incorrect-backup-passphrase"), /BACKUP_AUTHENTICATION_FAILED/);
    await decryptFile(encrypted, restored, passphrase);
    assert.deepEqual(await readFile(restored), payload);

    const bytes = await readFile(encrypted);
    bytes[bytes.length - 17] ^= 0x01;
    const tampered = path.join(root, "tampered.goldis-backup");
    await writeFile(tampered, bytes);
    await assert.rejects(decryptFile(tampered, wrongOutput, passphrase), /BACKUP_AUTHENTICATION_FAILED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
