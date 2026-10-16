import { test } from "node:test";
import assert from "node:assert/strict";
import { assertWorkerApiReady, workerApiReadinessUrl } from "./api-readiness";

test("worker readiness defaults to local API and accepts the exact healthy response", async () => {
  assert.equal(workerApiReadinessUrl({}).toString(), "http://127.0.0.1:3001/api/health/ready");
  let requested = "";
  await assertWorkerApiReady({ GOLDIS_API_READY_URL: "http://api:3001/api/health/ready" }, async (url) => {
    requested = url.toString();
    return { ok: true, async json() { return { status: "ready" }; } };
  });
  assert.equal(requested, "http://api:3001/api/health/ready");
});

test("worker readiness fails closed when API readiness is unavailable or reports another state", async () => {
  await assert.rejects(assertWorkerApiReady({}, async () => ({ ok: false, async json() { return { status: "not_ready" }; } })),
    (error) => error instanceof Error && error.message === "WORKER_API_NOT_READY");
  await assert.rejects(assertWorkerApiReady({}, async () => ({ ok: true, async json() { return { status: "alive" }; } })),
    (error) => error instanceof Error && error.message === "WORKER_API_NOT_READY");
  await assert.rejects(assertWorkerApiReady({}, async () => { throw new Error("private endpoint detail"); }),
    (error) => error instanceof Error && error.message === "WORKER_API_NOT_READY");
});

test("worker readiness accepts only a direct health endpoint URL", () => {
  for (const value of [
    "file:///api/health/ready", "http://user:password@api/api/health/ready", "http://api/other",
    "http://api/api/health/ready?debug=1", "not-a-url",
  ]) {
    assert.throws(() => workerApiReadinessUrl({ GOLDIS_API_READY_URL: value }), /WORKER_API_READINESS_CONFIG_INVALID/);
  }
  assert.throws(() => workerApiReadinessUrl({ API_PORT: "70000" }), /WORKER_API_READINESS_CONFIG_INVALID/);
});
