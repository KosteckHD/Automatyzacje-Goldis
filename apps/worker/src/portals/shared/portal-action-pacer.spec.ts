import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PORTAL_ACTION_INTERVAL_MS, portalActionIntervalFromEnvironment, PortalActionPacer } from "./portal-action-pacer";

test("portal action pacing uses a bounded configurable interval and a conservative default", () => {
  assert.equal(portalActionIntervalFromEnvironment({}), DEFAULT_PORTAL_ACTION_INTERVAL_MS);
  assert.equal(portalActionIntervalFromEnvironment({ WORKER_PORTAL_MIN_ACTION_INTERVAL_MS: " 1500 " }), 1_500);
  assert.equal(portalActionIntervalFromEnvironment({ WORKER_PORTAL_MIN_ACTION_INTERVAL_MS: "60000" }), 60_000);
  for (const value of ["0", "60001", "1.5", "abc"]) {
    assert.throws(() => portalActionIntervalFromEnvironment({ WORKER_PORTAL_MIN_ACTION_INTERVAL_MS: value }),
      { message: "WORKER_PORTAL_MIN_ACTION_INTERVAL_MS_INVALID" });
  }
});

test("concurrent actions on one profile receive spaced admissions and recheck lease after waiting", async () => {
  let now = 10_000;
  const delays: number[] = [];
  let leaseChecks = 0;
  const pacer = new PortalActionPacer(1_000, {
    now: () => now,
    sleep: async (milliseconds) => { delays.push(milliseconds); now += milliseconds; },
  });
  const assertLease = async () => { leaseChecks += 1; };

  await pacer.beforeAction("goldis-local-profile", assertLease);
  await Promise.all([
    pacer.beforeAction("goldis-local-profile", assertLease),
    pacer.beforeAction("goldis-local-profile", assertLease),
  ]);
  assert.deepEqual(delays, [1_000, 1_000]);
  assert.equal(leaseChecks, 3);
});

test("a different browser profile has an independent action schedule", async () => {
  let now = 20_000;
  const delays: number[] = [];
  const pacer = new PortalActionPacer(2_000, {
    now: () => now,
    sleep: async (milliseconds) => { delays.push(milliseconds); now += milliseconds; },
  });
  const noOp = async () => undefined;
  await pacer.beforeAction("profile-a", noOp);
  await pacer.beforeAction("profile-b", noOp);
  assert.deepEqual(delays, []);
});

test("lease denial after a pacing wait prevents action admission", async () => {
  let now = 0;
  let admitted = 0;
  const pacer = new PortalActionPacer(500, { now: () => now, sleep: async (ms) => { now += ms; } });
  await pacer.beforeAction("profile", async () => undefined);
  await assert.rejects(pacer.beforeAction("profile", async () => { throw new Error("RUN_EXECUTION_LEASE_LOST"); }),
    /RUN_EXECUTION_LEASE_LOST/);
  await pacer.beforeAction("profile", async () => { admitted += 1; });
  assert.equal(admitted, 1);
});

test("aborting a run during pacing wakes the wait and denies the next browser action", async () => {
  let now = 0;
  let leaseRechecked = false;
  const controller = new AbortController();
  let sleepHasStarted!: () => void;
  const sleepStarted = new Promise<void>((resolve) => { sleepHasStarted = resolve; });
  const pacer = new PortalActionPacer(30_000, {
    now: () => now,
    sleep: (_milliseconds, signal) => new Promise<void>((resolve) => {
      if (signal?.aborted) { resolve(); return; }
      const finish = () => { signal?.removeEventListener("abort", finish); resolve(); };
      signal?.addEventListener("abort", finish, { once: true });
      sleepHasStarted();
    }),
  });
  await pacer.beforeAction("profile", async () => undefined);
  const pending = pacer.beforeAction("profile", async () => {
    leaseRechecked = true;
    if (controller.signal.aborted) throw new Error("RUN_EXECUTION_LEASE_LOST");
  }, controller.signal);
  await sleepStarted;
  controller.abort();
  await assert.rejects(pending, /RUN_EXECUTION_LEASE_LOST/);
  assert.equal(leaseRechecked, true);
});
