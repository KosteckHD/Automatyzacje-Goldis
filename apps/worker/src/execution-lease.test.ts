import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { acquireRunExecution, ownsRunExecution, releaseRunExecution, renewRunExecution } from "./execution-lease";

const runId = "11111111-1111-4111-8111-111111111111";
const dispatchId = "22222222-2222-4222-8222-222222222222";
const workerId = "33333333-3333-4333-8333-333333333333";

class LeasePool {
  statements: string[] = [];
  run = { status: "queued", executionId: null as string | null, workerId: null as string | null, expires: null as Date | null };
  dispatch = { runId, intent: "create", status: "published" };
  now = new Date("2026-10-02T10:00:00.000Z");

  async connect() {
    return {
      query: async (sql: string, values: unknown[] = []) => {
        const statement = sql.replace(/\s+/g, " ").trim();
        this.statements.push(statement);
        if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") return { rowCount: null, rows: [] };
        if (statement.startsWith("SELECT status, execution_id, lease_expires_at FROM automation_runs")) {
          return { rowCount: 1, rows: [{ status: this.run.status, execution_id: this.run.executionId, lease_expires_at: this.run.expires }] };
        }
        if (statement.startsWith("SELECT run_id, intent_type, status FROM run_dispatch_outbox")) {
          return { rowCount: 1, rows: [{ run_id: this.dispatch.runId, intent_type: this.dispatch.intent, status: this.dispatch.status }] };
        }
        if (statement.startsWith("UPDATE automation_runs SET execution_id")) {
          if (this.run.executionId && this.run.expires && this.run.expires > (values[4] as Date)) return { rowCount: 0, rows: [] };
          this.run.executionId = values[1] as string;
          this.run.workerId = values[2] as string;
          this.run.expires = values[3] as Date;
          return { rowCount: 1, rows: [] };
        }
        if (statement.startsWith("UPDATE run_dispatch_outbox SET status = 'consumed'")) {
          if (this.dispatch.status !== "published" && this.dispatch.status !== "publishing") return { rowCount: 0, rows: [] };
          this.dispatch.status = "consumed";
          return { rowCount: 1, rows: [] };
        }
        if (statement.startsWith("UPDATE automation_runs SET heartbeat_at")) {
          if (this.run.executionId !== values[1] || !this.run.expires || this.run.expires <= (values[2] as Date)) return { rowCount: 0, rows: [] };
          this.run.expires = values[3] as Date;
          return { rowCount: 1, rows: [] };
        }
        if (statement.startsWith("SELECT 1 FROM automation_runs")) {
          const owns = this.run.executionId === values[1] && this.run.workerId === values[2]
            && this.run.expires !== null && this.run.expires > (values[3] as Date);
          return { rowCount: owns ? 1 : 0, rows: owns ? [{}] : [] };
        }
        if (statement.startsWith("UPDATE automation_runs SET execution_id = NULL")) {
          if (this.run.executionId !== values[1]) return { rowCount: 0, rows: [] };
          this.run.executionId = null;
          this.run.workerId = null;
          this.run.expires = null;
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`UNEXPECTED_SQL:${statement}`);
      },
      release: () => undefined,
    };
  }

  async query(sql: string, values: unknown[] = []) {
    const statement = sql.replace(/\s+/g, " ").trim();
    this.statements.push(statement);
    if (statement.startsWith("UPDATE automation_runs SET heartbeat_at")) {
      if (this.run.executionId !== values[1] || !this.run.expires || this.run.expires <= (values[2] as Date)) return { rowCount: 0, rows: [] };
      this.run.expires = values[3] as Date;
      return { rowCount: 1, rows: [] };
    }
    if (statement.startsWith("SELECT 1 FROM automation_runs")) {
      const owns = this.run.executionId === values[1] && this.run.workerId === values[2]
        && this.run.expires !== null && this.run.expires > (values[3] as Date);
      return { rowCount: owns ? 1 : 0, rows: owns ? [{}] : [] };
    }
    if (statement.startsWith("UPDATE automation_runs SET execution_id = NULL")) {
      if (this.run.executionId !== values[1]) return { rowCount: 0, rows: [] };
      this.run.executionId = null;
      this.run.workerId = null;
      this.run.expires = null;
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`UNEXPECTED_SQL:${statement}`);
  }
}

test("lease atomically consumes the matching dispatch, renews, fences and releases", async () => {
  const fake = new LeasePool();
  const lease = await acquireRunExecution(fake as unknown as Pool, {
    runId, dispatchId, workerSessionId: workerId, now: fake.now, leaseMs: 60_000,
  });
  assert.ok(lease);
  assert.equal(lease.intentType, "create");
  assert.equal(fake.dispatch.status, "consumed");
  assert.equal(await ownsRunExecution(fake as unknown as Pool, lease, fake.now), true);
  assert.equal(await renewRunExecution(fake as unknown as Pool, lease, new Date(fake.now.getTime() + 10_000), 60_000), true);
  assert.equal(await ownsRunExecution(fake as unknown as Pool, { ...lease, executionId: workerId }, fake.now), false);
  await releaseRunExecution(fake as unknown as Pool, lease, fake.now);
  assert.equal(fake.run.executionId, null);
});

test("duplicate dispatch cannot take an unexpired lease and an expired lease cannot heartbeat", async () => {
  const fake = new LeasePool();
  const lease = await acquireRunExecution(fake as unknown as Pool, {
    runId, dispatchId, workerSessionId: workerId, now: fake.now, leaseMs: 60_000,
  });
  assert.ok(lease);
  const duplicate = await acquireRunExecution(fake as unknown as Pool, {
    runId, dispatchId, workerSessionId: "44444444-4444-4444-8444-444444444444", now: fake.now,
  });
  assert.equal(duplicate, null);
  assert.equal(fake.dispatch.status, "consumed");
  const expiredAt = new Date(fake.now.getTime() + 60_000);
  assert.equal(await renewRunExecution(fake as unknown as Pool, lease, expiredAt), false);
  assert.equal(await ownsRunExecution(fake as unknown as Pool, lease, expiredAt), false);
});
