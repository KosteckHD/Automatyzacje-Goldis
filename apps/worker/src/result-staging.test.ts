import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IdentityMatchV1, OcSnapshotV1 } from "@goldis/core";
import { WorkerResultStagingStore } from "./result-staging";

const runId = "11111111-1111-4111-8111-111111111111";
const sourceRowId = "22222222-2222-4222-8222-222222222222";
const identity: IdentityMatchV1 = {
  schemaVersion: 1, sourceRowId, regon: "012345678", companyName: "Fikcyjna Firma Testowa",
  firstName: "Ala", lastName: "Testowa", pesel: "90010100016",
  matchMethod: "unique_business_identity", adapterVersion: "fixture-1",
};
const snapshot: OcSnapshotV1 = {
  schemaVersion: 1, totalCount: 0, policies: [], capturedAt: "2026-10-02T10:00:00.000Z", parserVersion: "fixture-1",
};

test("staging encrypts a validated result, reloads it with run AAD, and removes idempotently", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "goldis-staging-test-"));
  const directory = path.join(parent, "private");
  const keyV1 = randomBytes(32).toString("base64url");
  const store = new WorkerResultStagingStore({ WORKER_STAGING_DIR: directory, WORKER_STAGING_KEY_VERSION: "1", WORKER_STAGING_KEY_V1: keyV1 });
  try {
    const metadata = await store.write(runId, sourceRowId, identity, snapshot);
    const pathOnDisk = path.join(directory, `${metadata.fileId}.stage`);
    const file = await readFile(pathOnDisk);
    assert.equal(file.includes(Buffer.from("90010100016")), false);
    assert.deepEqual(await store.read(runId, sourceRowId, metadata), { identity, snapshot });
    await assert.rejects(store.read("33333333-3333-4333-8333-333333333333", sourceRowId, metadata), /WORKER_STAGING_INTEGRITY_FAILED/);
    await store.remove(metadata.fileId);
    await store.remove(metadata.fileId);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    store.destroyKey();
    await rm(parent, { recursive: true, force: true });
  }
});

test("staging detects tampering and supports a versioned decryption keyring", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "goldis-staging-rotation-"));
  const directory = path.join(parent, "private");
  const keyV1 = randomBytes(32).toString("base64url");
  const keyV2 = randomBytes(32).toString("base64url");
  const v1 = new WorkerResultStagingStore({ WORKER_STAGING_DIR: directory, WORKER_STAGING_KEY_VERSION: "1", WORKER_STAGING_KEY_V1: keyV1 });
  const v2 = new WorkerResultStagingStore({ WORKER_STAGING_DIR: directory, WORKER_STAGING_KEY_VERSION: "2", WORKER_STAGING_KEY_V1: keyV1, WORKER_STAGING_KEY_V2: keyV2 });
  try {
    const metadata = await v1.write(runId, sourceRowId, identity, snapshot);
    assert.deepEqual(await v2.read(runId, sourceRowId, metadata), { identity, snapshot });
    const filePath = path.join(directory, `${metadata.fileId}.stage`);
    const file = await readFile(filePath);
    file[file.length - 1] ^= 1;
    await writeFile(filePath, file);
    await assert.rejects(v2.read(runId, sourceRowId, metadata), /WORKER_STAGING_INTEGRITY_FAILED/);
  } finally {
    v1.destroyKey();
    v2.destroyKey();
    await rm(parent, { recursive: true, force: true });
  }
});
