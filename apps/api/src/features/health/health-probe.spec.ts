import assert from "node:assert/strict";
import { test } from "node:test";
import { probeApiReadiness } from "./health-probe";

const healthy = {
  async database() {},
  async redis() {
    return true;
  },
  async deletionJournal() {},
};

test("API readiness requires PostgreSQL, Redis and successful deletion-journal admission", async () => {
  assert.equal(await probeApiReadiness(healthy, 100), true);
  assert.equal(
    await probeApiReadiness(
      {
        ...healthy,
        async redis() {
          return false;
        },
      },
      100,
    ),
    false,
  );
  assert.equal(
    await probeApiReadiness(
      {
        ...healthy,
        async deletionJournal() {
          throw new Error("JOURNAL_MISMATCH");
        },
      },
      100,
    ),
    false,
  );
});

test("API readiness fails closed when any dependency probe exceeds its deadline", async () => {
  assert.equal(
    await probeApiReadiness(
      {
        ...healthy,
        async deletionJournal() {
          await new Promise(() => undefined);
        },
      },
      10,
    ),
    false,
  );
});
