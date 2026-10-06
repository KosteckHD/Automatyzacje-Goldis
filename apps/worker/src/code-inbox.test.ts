import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeInboxError, OneTimeCodeInbox, startWorkerCodeReceiver } from "./code-inbox";

const serviceSecret = "synthetic-worker-service-secret-that-is-never-reused";
const challengeId = "11111111-1111-4111-8111-111111111111";
const secondChallengeId = "22222222-2222-4222-8222-222222222222";

async function withReceiver<T>(inbox: OneTimeCodeInbox, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const receiver = await startWorkerCodeReceiver({ host: "127.0.0.1", port: 0, serviceSecret, inbox });
  try {
    return await run(`http://127.0.0.1:${receiver.address.port}`);
  } finally {
    await receiver.close();
  }
}

test("wewnętrzny endpoint odmawia braku i błędnego sekretu usługi oraz niezarejestrowanego challenge", async () => {
  const inbox = new OneTimeCodeInbox();
  await withReceiver(inbox, async (baseUrl) => {
    const path = `/internal/auth-challenges/${challengeId}/code`;
    const missing = await fetch(`${baseUrl}${path}`, { method: "POST", body: JSON.stringify({ code: "314159" }) });
    const invalid = await fetch(`${baseUrl}${path}`, {
      method: "POST", headers: { authorization: "Bearer wrong-secret", "content-type": "application/json" },
      body: JSON.stringify({ code: "314159" }),
    });
    const unregistered = await fetch(`${baseUrl}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${serviceSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ code: "314159" }),
    });
    assert.equal(missing.status, 401);
    assert.equal(invalid.status, 401);
    assert.equal(unregistered.status, 409);
    assert.equal((await unregistered.text()).includes("314159"), false);
  });
});

test("kod trafia do pamięci tylko raz i endpoint nie odsyła ani nie loguje jego wartości", async () => {
  const inbox = new OneTimeCodeInbox();
  const syntheticCode = "684203";
  inbox.register(challengeId, new Date(Date.now() + 60_000));
  const capturedLogs: string[] = [];
  const consoleMethods = ["log", "info", "warn", "error"] as const;
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const method of consoleMethods) console[method] = (...parts: unknown[]) => capturedLogs.push(parts.map(String).join(" "));
  try {
    await withReceiver(inbox, async (baseUrl) => {
      const waiter = inbox.waitForCode(challengeId);
      const response = await fetch(`${baseUrl}/internal/auth-challenges/${challengeId}/code`, {
        method: "POST", headers: { authorization: `Bearer ${serviceSecret}`, "content-type": "application/json" },
        body: JSON.stringify({ code: syntheticCode }),
      });
      const body = await response.text();
      const codeBuffer = await waiter;
      assert.equal(response.status, 202);
      assert.equal(body, JSON.stringify({ accepted: true }));
      assert.equal(body.includes(syntheticCode), false);
      assert.equal(codeBuffer.toString("ascii"), syntheticCode);
      codeBuffer.fill(0);
      assert.equal(codeBuffer.every((byte) => byte === 0), true, "kod testowy zostaje wyzerowany po konsumpcji");
      await assert.rejects(inbox.waitForCode(challengeId), (error: unknown) =>
        error instanceof CodeInboxError && error.code === "CHALLENGE_NOT_REGISTERED");
      const duplicate = await fetch(`${baseUrl}/internal/auth-challenges/${challengeId}/code`, {
        method: "POST", headers: { authorization: `Bearer ${serviceSecret}`, "content-type": "application/json" },
        body: JSON.stringify({ code: syntheticCode }),
      });
      assert.equal(duplicate.status, 409);
    });
  } finally {
    for (const method of consoleMethods) console[method] = originals[method];
  }
  assert.equal(capturedLogs.some((line) => line.includes(syntheticCode)), false, "kod nie trafia do logów");
});

test("endpoint odrzuca niepoprawny kod, format żądania i przekroczony limit body", async () => {
  const inbox = new OneTimeCodeInbox();
  inbox.register(challengeId, new Date(Date.now() + 60_000));
  await withReceiver(inbox, async (baseUrl) => {
    const path = `${baseUrl}/internal/auth-challenges/${challengeId}/code`;
    const headers = { authorization: `Bearer ${serviceSecret}`, "content-type": "application/json" };
    const invalidCode = await fetch(path, { method: "POST", headers, body: JSON.stringify({ code: "12-34" }) });
    const extraField = await fetch(path, { method: "POST", headers, body: JSON.stringify({ code: "1234", other: "ignored" }) });
    const wrongType = await fetch(path, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "{}" });
    const oversized = await fetch(path, { method: "POST", headers, body: JSON.stringify({ code: "1234", padding: "x".repeat(2_000) }) });
    assert.equal(invalidCode.status, 400);
    assert.equal(extraField.status, 400);
    assert.equal(wrongType.status, 415);
    assert.equal(oversized.status, 413);
  });
});

test("challenge wygasa w pamięci i nie przyjmuje późnego kodu", async () => {
  let now = 10_000;
  const inbox = new OneTimeCodeInbox(() => now);
  inbox.register(secondChallengeId, new Date(now + 1_000));
  now += 1_001;
  await assert.rejects(inbox.waitForCode(secondChallengeId), (error: unknown) =>
    error instanceof CodeInboxError && error.code === "CHALLENGE_EXPIRED");
  assert.throws(() => inbox.register(secondChallengeId, new Date(now)), /CHALLENGE_EXPIRED/);
});

test("wewnętrzne DELETE unieważnia oczekujące wyzwanie i odrzuca waiter", async () => {
  const inbox = new OneTimeCodeInbox();
  inbox.register(secondChallengeId, new Date(Date.now() + 60_000));
  const waiter = inbox.waitForCode(secondChallengeId).then(() => null, (error: unknown) => error);
  await withReceiver(inbox, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/auth-challenges/${secondChallengeId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${serviceSecret}` },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { invalidated: true });
    const waiterError = await waiter;
    assert.ok(waiterError instanceof CodeInboxError && waiterError.code === "CHALLENGE_EXPIRED");
    await assert.rejects(inbox.waitForCode(secondChallengeId), (error: unknown) => error instanceof CodeInboxError && error.code === "CHALLENGE_NOT_REGISTERED");
  });
});

test("odbiornik wymaga bezpiecznej konfiguracji przed otwarciem portu", async () => {
  await assert.rejects(startWorkerCodeReceiver({
    host: "127.0.0.1", port: 3022, serviceSecret: "short", inbox: new OneTimeCodeInbox(),
  }), /WORKER_CODE_RECEIVER_CONFIG_INVALID/);
});
