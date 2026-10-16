"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createManifest, verifyManifest, verifyJournal } = require("./manifest.cjs");

const imageKeys = ["GOLDIS_POSTGRES_IMAGE", "GOLDIS_REDIS_IMAGE", "GOLDIS_API_IMAGE", "GOLDIS_WORKER_IMAGE", "GOLDIS_WEB_IMAGE"];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-backup-manifest-"));
  const payload = path.join(root, "payload");
  fs.mkdirSync(path.join(payload, "deletion-journal"), { recursive: true });
  fs.mkdirSync(path.join(payload, "exports", "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(payload, "staging"), { recursive: true });
  fs.mkdirSync(path.join(payload, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(payload, "deletion-journal", "deletion-journal.key"), crypto.randomBytes(32));
  fs.writeFileSync(path.join(payload, "deletion-journal", "deletion-journal.jsonl"), "");
  fs.writeFileSync(path.join(payload, "exports", "artifacts", "sample.bin"), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(payload, "staging", "checkpoint.json"), "{}\n");
  fs.writeFileSync(path.join(payload, "secrets", "session_secret"), "synthetic-secret\n");
  const envFile = path.join(root, "production.env");
  fs.writeFileSync(envFile, [
    ...imageKeys.map((key, index) => `${key}=example/${key.toLowerCase()}@sha256:${String(index + 1).repeat(64)}`),
    "GOLDIS_BUILD_VERSION=0.1.0-test", `GOLDIS_BUILD_COMMIT=${"a1b2c3d4".padEnd(40, "e")}`, `GOLDIS_IMAGE_DIGEST=sha256:${"3".repeat(64)}`,
  ].join("\n") + "\n");
  return { root, payload, envFile };
}

test("backup manifest verifies every file and the deletion journal head", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  const created = createManifest(paths.payload, paths.envFile, "059-example-migration.js");
  assert.equal(created.deletionJournalHead.sequence, 0);
  assert.equal(verifyManifest(paths.payload).release.migrationHead, "059-example-migration.js");
});

test("backup manifest detects changed files and refuses mutable journal state", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  createManifest(paths.payload, paths.envFile, "059-example-migration.js");
  fs.writeFileSync(path.join(paths.payload, "exports", "artifacts", "sample.bin"), "tampered");
  assert.throws(() => verifyManifest(paths.payload), /BACKUP_MANIFEST_CHECKSUM_MISMATCH/);
});

test("backup manifest requires digest-pinned images", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  fs.writeFileSync(paths.envFile, `GOLDIS_API_IMAGE=latest\nGOLDIS_BUILD_VERSION=0.1.0-test\nGOLDIS_BUILD_COMMIT=${"a1b2c3d4".padEnd(40, "e")}\nGOLDIS_IMAGE_DIGEST=sha256:${"3".repeat(64)}\n`);
  assert.throws(() => createManifest(paths.payload, paths.envFile, null), /BACKUP_RELEASE_IMAGE_DIGEST_REQUIRED/);
});

test("deletion journal verifier accepts a valid extension and rejects stale or changed history", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  const directory = path.join(paths.payload, "deletion-journal");
  const key = fs.readFileSync(path.join(directory, "deletion-journal.key"));
  const unsigned = {
    formatVersion: 1, sequence: 1, previousHash: "0".repeat(64),
    jobId: crypto.randomUUID(), tenantId: crypto.randomUUID(), targetType: "import", targetId: crypto.randomUUID(),
    createdAt: "2026-10-13T12:00:00.000Z",
  };
  const hash = crypto.createHmac("sha256", key).update(JSON.stringify(unsigned), "utf8").digest("hex");
  fs.writeFileSync(path.join(directory, "deletion-journal.jsonl"), `${JSON.stringify({ ...unsigned, hash })}\n`);
  assert.deepEqual(verifyJournal(directory), { sequence: 1, hash });
  assert.throws(() => verifyJournal(directory, { sequence: 1, hash: "f".repeat(64) }), /BACKUP_DELETION_JOURNAL_PREFIX_MISMATCH/);
  fs.appendFileSync(path.join(directory, "deletion-journal.jsonl"), "tampered\n");
  assert.throws(() => verifyJournal(directory), /BACKUP_DELETION_JOURNAL_TAMPERED/);
});
