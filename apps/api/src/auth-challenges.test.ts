import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

const challengeId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const now = Date.now();

test("API challenge service wiąże run, termin, status i limit prób; kod nie trafia do zdarzeń", async (t) => {
  const oldDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  try {
    const [{ AuthChallengeService }, db] = await Promise.all([import("./auth-challenges"), import("./db")]);
    const originalTransaction = db.sequelize.transaction;
    const originalChallengeFind = db.AuthChallenge.findByPk;
    const originalChallengeFindOne = db.AuthChallenge.findOne;
    const originalRunFind = db.AutomationRun.findByPk;
    const originalInterventionUpdate = db.ManualIntervention.update;
    const originalEventCreate = db.RunEvent.create;

    await t.test("forwarder używa wyłącznie wewnętrznego endpointu i nie ponawia kodu", async () => {
      const oldUrl = process.env.WORKER_INTERNAL_URL;
      const oldSecret = process.env.WORKER_AUTH_SECRET;
      const seen: Array<{ method: string; path: string; authorization: string | undefined; body: string }> = [];
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          seen.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));
        });
      });
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        process.env.WORKER_INTERNAL_URL = `http://127.0.0.1:${address.port}`;
        process.env.WORKER_AUTH_SECRET = "synthetic-worker-forwarding-secret-never-reused";
        const { WorkerCodeForwarder } = await import("./auth-challenges");
        const forwarder = new WorkerCodeForwarder();
        await forwarder.deliver(challengeId, "407219");
        await forwarder.invalidate(challengeId);
        assert.deepEqual(seen.map(({ method, path }) => ({ method, path })), [
          { method: "POST", path: `/internal/auth-challenges/${challengeId}/code` },
          { method: "DELETE", path: `/internal/auth-challenges/${challengeId}` },
        ]);
        assert.equal(seen[0].authorization, "Bearer synthetic-worker-forwarding-secret-never-reused");
        assert.deepEqual(JSON.parse(seen[0].body), { code: "407219" });
        assert.equal(seen[1].body, "");
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (oldUrl === undefined) delete process.env.WORKER_INTERNAL_URL;
        else process.env.WORKER_INTERNAL_URL = oldUrl;
        if (oldSecret === undefined) delete process.env.WORKER_AUTH_SECRET;
        else process.env.WORKER_AUTH_SECRET = oldSecret;
      }
    });

    let challenge: Record<string, unknown>;
    let run: Record<string, unknown>;
    const events: Array<Record<string, unknown>> = [];
    const interventionUpdates: Array<Record<string, unknown>> = [];
    let sentCode: string | null = null;
    let deliveryFailure = false;
    let invalidated = false;

    const reset = (challengeOverrides: Record<string, unknown> = {}, runOverrides: Record<string, unknown> = {}) => {
      challenge = {
        challengeId, runId, portal: "pzu", status: "active", attemptCount: 0, attemptLimit: 5,
        expiresAt: new Date(now + 60_000), claimedAt: null, updatedAt: new Date(now),
        async save() { return this; },
        ...challengeOverrides,
      };
      run = { id: runId, status: "waiting_for_sms", currentStep: "waiting_for_sms", currentAuthChallengeId: challengeId,
        finishedAt: null, async save() { return this; }, ...runOverrides };
      events.length = 0;
      interventionUpdates.length = 0;
      sentCode = null;
      deliveryFailure = false;
      invalidated = false;
    };

    (db.sequelize as unknown as { transaction: (callback: (transaction: { LOCK: { UPDATE: string } }) => Promise<unknown>) => Promise<unknown> }).transaction = async (callback) => callback({ LOCK: { UPDATE: "UPDATE" } });
    (db.AuthChallenge as any).findByPk = async (id: string) => id === challengeId ? challenge : null;
    (db.AuthChallenge as any).findOne = async () => challenge;
    (db.AutomationRun as any).findByPk = async (id: string) => id === runId ? run : null;
    (db.ManualIntervention as any).update = async (values: Record<string, unknown>) => {
      interventionUpdates.push(values);
      return [1];
    };
    (db.RunEvent as any).create = async (values: Record<string, unknown>) => {
      events.push(values);
      return values;
    };

    try {
      await t.test("odczyt panelu zwraca bezpieczne metadane i wygasza challenge po terminie", async () => {
        reset({ accountKey: "a".repeat(64), browserSessionId: "55555555-5555-4555-8555-555555555555" });
        const service = new AuthChallengeService({ deliver: async () => {}, invalidate: async () => {} } as never);
        const before = Date.now();
        const active = await service.getForRun(runId) as Record<string, unknown>;
        assert.deepEqual({ ...active, serverNow: undefined }, {
          challengeId, runId, portal: "pzu", status: "active", expiresAt: challenge.expiresAt,
          attemptCount: 0, attemptLimit: 5, serverNow: undefined, reasonCode: "SMS_REQUIRED",
        });
        assert.ok(typeof active.serverNow === "string" && Date.parse(active.serverNow) >= before);
        assert.equal(JSON.stringify(active).includes("accountKey"), false);
        assert.equal(JSON.stringify(active).includes("browserSessionId"), false);
        reset({ expiresAt: new Date(Date.now() - 1) });
        assert.equal(await service.getForRun(runId), null);
        assert.equal(challenge.status, "expired");
        assert.equal(events[0].step, "sms_timeout");
        assert.equal(run.status, "waiting_for_manual_data");
      });

      await t.test("odrzuca powiązanie z obcym runem", async () => {
        reset();
        const service = new AuthChallengeService({ deliver: async () => { throw new Error("should not deliver"); }, invalidate: async () => {} } as never);
        await assert.rejects(service.submitCode(challengeId, "33333333-3333-4333-8333-333333333333", "407219"), (error: { getStatus?: () => number }) => error.getStatus?.() === 403);
        assert.equal(sentCode, null);
      });

      await t.test("wygasza challenge i zwraca 410 dla terminu minionego", async () => {
        reset({ expiresAt: new Date(now - 1) });
        const service = new AuthChallengeService({ deliver: async () => {}, invalidate: async () => {} } as never);
        await assert.rejects(service.submitCode(challengeId, runId, "407219"), (error: { getStatus?: () => number }) => error.getStatus?.() === 410);
        assert.equal(challenge.status, "expired");
        assert.equal(interventionUpdates[0].reasonCode, "SMS_TIMEOUT");
        assert.ok(interventionUpdates[0].revision);
        assert.ok(interventionUpdates[0].updatedAt instanceof Date);
        assert.equal(run.status, "waiting_for_manual_data");
      });

      await t.test("odrzuca challenge zajęty, limit prób i run poza waiting_for_sms", async () => {
        const service = new AuthChallengeService({ deliver: async () => {}, invalidate: async () => {} } as never);
        reset({ status: "claimed" });
        await assert.rejects(service.submitCode(challengeId, runId, "407219"), (error: { getStatus?: () => number }) => error.getStatus?.() === 409);
        reset({ attemptCount: 5, attemptLimit: 5 });
        await assert.rejects(service.submitCode(challengeId, runId, "407219"), (error: { getStatus?: () => number }) => error.getStatus?.() === 409);
        reset({}, { status: "cancelled" });
        await assert.rejects(service.submitCode(challengeId, runId, "407219"), (error: { getStatus?: () => number }) => error.getStatus?.() === 409);
      });

      await t.test("zajmuje, przekazuje raz i nie zapisuje kodu w zdarzeniach", async () => {
        reset();
        const service = new AuthChallengeService({
          deliver: async (_id: string, code: string) => { sentCode = code; }, invalidate: async () => { invalidated = true; },
        } as never);
        const accepted = await service.submitCode(challengeId, runId, "407219");
        assert.deepEqual(accepted, { accepted: true, challengeId, attemptCount: 1 });
        assert.equal(challenge.status, "submitted");
        assert.equal(challenge.attemptCount, 1);
        assert.equal(sentCode, "407219");
        assert.equal(invalidated, false);
        assert.equal(JSON.stringify(events).includes("407219"), false);
        await assert.rejects(service.submitCode(challengeId, runId, "407219"), (error: { getStatus?: () => number }) => error.getStatus?.() === 409);
        assert.equal(events.length, 2);
      });

      await t.test("niepewna dostawa unieważnia challenge i zatrzymuje run bez retry kodu", async () => {
        reset();
        const service = new AuthChallengeService({
          deliver: async () => { deliveryFailure = true; throw new Error("synthetic connection reset"); },
          invalidate: async () => { invalidated = true; },
        } as never);
        await assert.rejects(service.submitCode(challengeId, runId, "407219"), (error: { getStatus?: () => number }) => error.getStatus?.() === 503);
        assert.equal(deliveryFailure, true);
        assert.equal(challenge.status, "invalidated");
        assert.equal(run.status, "waiting_for_manual_data");
        assert.equal(run.errorCode, "SMS_DELIVERY_UNCERTAIN");
        assert.equal(interventionUpdates.at(-1)?.reasonCode, "SMS_DELIVERY_UNCERTAIN");
        assert.equal(invalidated, true);
        assert.equal(JSON.stringify({ events, interventionUpdates, challenge, run }).includes("407219"), false);
      });
    } finally {
      db.sequelize.transaction = originalTransaction;
      db.AuthChallenge.findByPk = originalChallengeFind;
      db.AuthChallenge.findOne = originalChallengeFindOne;
      db.AutomationRun.findByPk = originalRunFind;
      db.ManualIntervention.update = originalInterventionUpdate;
      db.RunEvent.create = originalEventCreate;
    }
  } finally {
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
  }
});
