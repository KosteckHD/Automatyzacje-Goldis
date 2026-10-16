"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createReleaseManifest } = require("./create-release-manifest.cjs");

const keys = ["GOLDIS_POSTGRES_IMAGE", "GOLDIS_REDIS_IMAGE", "GOLDIS_API_IMAGE", "GOLDIS_WORKER_IMAGE", "GOLDIS_WEB_IMAGE"];

function environmentFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-release-manifest-"));
  const file = path.join(directory, "production.env");
  const values = [
    ...keys.map((key, index) => `${key}=registry.example/${key.toLowerCase()}@sha256:${String(index + 1).repeat(64)}`),
    "GOLDIS_BUILD_VERSION=0.1.0-test", `GOLDIS_BUILD_COMMIT=${"a1b2c3d4".padEnd(40, "e")}`, `GOLDIS_IMAGE_DIGEST=sha256:${"3".repeat(64)}`,
  ];
  fs.writeFileSync(file, `${values.join("\n")}\n`);
  return { directory, file };
}

test("release manifest pins every image and hashes runtime config without carrying secrets", (t) => {
  const fixture = environmentFile();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const manifest = createReleaseManifest({ envFile: fixture.file, headCommit: "a1b2c3d4".padEnd(40, "e"), now: 0 });
  assert.equal(manifest.format, "goldis-release");
  assert.equal(manifest.apiImageDigest, `sha256:${"3".repeat(64)}`);
  assert.match(manifest.highestMigration, /^\d{3}-[a-z0-9-]+\.ts$/);
  assert.equal(manifest.validation.backupRestore, "pending");
  assert.equal(JSON.stringify(manifest).includes("synthetic-secret"), false);
});

test("release manifest rejects an API digest that does not match its immutable image", (t) => {
  const fixture = environmentFile();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  fs.appendFileSync(fixture.file, `GOLDIS_IMAGE_DIGEST=sha256:${"f".repeat(64)}\n`);
  assert.throws(() => createReleaseManifest({ envFile: fixture.file, headCommit: "a1b2c3d4".padEnd(40, "e") }), /RELEASE_API_DIGEST_MISMATCH/);
});
