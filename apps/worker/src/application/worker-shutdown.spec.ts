import assert from "node:assert/strict";
import { test } from "node:test";
import { shutdownWorkerResources } from "./worker-shutdown";

test("worker shutdown stops admission before closing dependent resources", async () => {
  const events: string[] = [];
  const timer = setInterval(() => undefined, 60_000);
  const resources = {
    stopJobAdmission: () => events.push("abort-work"),
    timers: [timer],
    worker: {
      async pause(force: boolean) {
        events.push(`pause:${force}`);
      },
      async close() {
        events.push("worker.close");
      },
    },
    inbox: { close: () => events.push("inbox.close") },
    codeReceiver: { async close() { events.push("receiver.close"); } },
    browser: { async close() { events.push("browser.close"); } },
    staging: { destroyKey: () => events.push("staging.destroy") },
    async removeWorkerStatus() { events.push("status.remove"); },
    async releasePortalOwner() { events.push("portal-owner.release"); },
    async closePool() { events.push("pool.close"); },
  };

  await shutdownWorkerResources(resources);

  assert.deepEqual(events, [
    "abort-work",
    "pause:true",
    "inbox.close",
    "worker.close",
    "receiver.close",
    "browser.close",
    "staging.destroy",
    "status.remove",
    "portal-owner.release",
    "pool.close",
  ]);
});

test("worker shutdown continues cleanup when an active worker exceeds its grace period", async () => {
  const events: string[] = [];
  const timer = setInterval(() => undefined, 60_000);
  const resources = {
    stopJobAdmission: () => events.push("abort-work"),
    timers: [timer],
    worker: {
      pause: async () => new Promise<void>(() => undefined),
      async close() { events.push("worker.close"); },
    },
    inbox: { close: () => events.push("inbox.close") },
    codeReceiver: null,
    browser: { async close() { events.push("browser.close"); } },
    staging: null,
    async removeWorkerStatus() { events.push("status.remove"); },
    async releasePortalOwner() { events.push("portal-owner.release"); },
    async closePool() { events.push("pool.close"); },
  };

  const startedAt = Date.now();
  await shutdownWorkerResources(resources, 20);

  assert.ok(Date.now() - startedAt < 500);
  assert.deepEqual(events, [
    "abort-work",
    "inbox.close",
    "worker.close",
    "browser.close",
    "status.remove",
    "portal-owner.release",
    "pool.close",
  ]);
});
