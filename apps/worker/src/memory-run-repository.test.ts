import { test } from "node:test";
import assert from "node:assert/strict";
import type { IdentityMatchV1 } from "@goldis/core";
import { MemoryRunRepository } from "./test-support/memory-run-repository";
import type { Clock, WorkerRunContext } from "./ports";

const context: WorkerRunContext = {
  run: {
    schemaVersion: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    sourceRowId: "22222222-2222-4222-8222-222222222222",
    batchId: "33333333-3333-4333-8333-333333333333",
    referenceDate: "2026-09-29",
    toolId: "oc-policy-verification",
  },
  source: {
    id: "22222222-2222-4222-8222-222222222222",
    rowNumber: 18001,
    companyName: "Fikcyjna Firma Testowa",
    decisionMakerName: null,
    nipRaw: "0000000000",
    address: "ul. Testowa 1",
    postalCode: "00-000",
    city: "Miasto Testowe",
    regonRaw: "012345678",
    regon: "012345678",
    effectiveRegon: "012345678",
    issues: [],
  },
  status: "awaiting_portal_adapter",
  cancelRequested: false,
  identity: null,
};

const clock: Clock = { now: () => new Date("2026-09-30T09:00:00.000Z") };

test("awaria przed checkpointem pozostawia ostatni stan i zdarzenie do wznowienia", async () => {
  const repository = new MemoryRunRepository(context, clock);
  const identity: IdentityMatchV1 = {
    schemaVersion: 1,
    sourceRowId: context.source.id,
    regon: "012345678",
    companyName: "Fikcyjna Firma Testowa",
    firstName: "Ala",
    lastName: "Testowa",
    pesel: "90010100016",
    matchMethod: "unique_business_identity",
    adapterVersion: "fixture-v1",
  };
  await repository.saveIdentity(context.run.runId, identity);
  assert.equal(await repository.transition(context.run.runId, "awaiting_portal_adapter", "pzu_login"), true);
  repository.failNextTransitionBeforeCommit();

  await assert.rejects(repository.transition(context.run.runId, "pzu_login", "everest_search"), /SIMULATED_CHECKPOINT_FAILURE/);
  const afterInterruption = await repository.load(context.run.runId);
  assert.equal(afterInterruption?.status, "pzu_login");
  assert.deepEqual(repository.events().map(({ status }) => status), ["pzu_login"]);

  assert.equal(await repository.transition(context.run.runId, "pzu_login", "everest_search"), true);
  assert.equal((await repository.load(context.run.runId))?.status, "everest_search");
  assert.deepEqual(repository.events().map(({ status }) => status), ["pzu_login", "everest_search"]);
  const eventPayload = JSON.stringify(repository.events());
  assert.equal(eventPayload.includes(identity.pesel), false);
  assert.equal(eventPayload.includes("pesel"), false);
});

test("porównanie oczekiwanego statusu chroni checkpoint przed podwójnym zdarzeniem", async () => {
  const repository = new MemoryRunRepository(context, clock);
  assert.equal(await repository.transition(context.run.runId, "awaiting_portal_adapter", "pzu_login"), true);
  assert.equal(await repository.transition(context.run.runId, "awaiting_portal_adapter", "pzu_login"), false);
  assert.equal(repository.events().length, 1);
});
