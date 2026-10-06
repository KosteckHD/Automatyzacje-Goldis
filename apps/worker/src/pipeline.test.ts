import { test } from "node:test";
import assert from "node:assert/strict";
import { SyntheticEverestProvider } from "./identity-fixtures";
import { SyntheticPolicyProvider } from "./oc-fixtures";
import { runPipeline } from "./pipeline";
import { MemoryRunRepository } from "./test-support/memory-run-repository";
import type { Clock, IdentityProvider, PolicyLookupResult, PolicyProvider, WorkerRunContext } from "./ports";

function makeContext(decisionMakerName: string | null = "Ala Testowa"): WorkerRunContext {
  return {
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
      decisionMakerName,
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
}

const fixedClock: Clock = { now: () => new Date("2026-10-02T08:00:00.000Z") };

test("pełny syntetyczny przebieg zachowuje referenceDate i wybiera wszystkie polisy od tej daty", async () => {
  const initial = makeContext();
  const repository = new MemoryRunRepository(initial, fixedClock);
  const result = await runPipeline(initial.run.runId, {
    identityProvider: new SyntheticEverestProvider("one_business"),
    policyProvider: new SyntheticPolicyProvider("many_policies"),
    repository,
    clock: fixedClock,
  });

  assert.equal(result.kind, "draft_result");
  if (result.kind !== "draft_result") return;
  assert.equal(result.result.outcome, "export_ready");
  assert.equal(result.result.referenceDate, "2026-09-29");
  assert.equal(result.result.totalOcCount, 3);
  assert.equal(result.result.currentOcCount, 2);
  assert.deepEqual(result.currentPolicies.map((policy) => policy.sourceOrdinal), [2, 3]);
  assert.equal(result.evaluatedAt, "2026-10-02T08:00:00.000Z");
  const checkpoint = await repository.load(initial.run.runId);
  assert.equal(checkpoint?.status, "reading_oc");
  assert.equal(checkpoint?.identity?.sourceRowId, checkpoint?.source.id);
  assert.equal(repository.events().some(({ status }) => status === "completed" || status === "no_matching_policies"), false);
});

test("niejednoznaczna tożsamość kończy się przeglądem i nie uruchamia dostawcy Compensy", async () => {
  const initial = makeContext(null);
  const repository = new MemoryRunRepository(initial, fixedClock);
  let policyCalls = 0;
  const policyProvider = new SyntheticPolicyProvider("one_policy");
  const guardedPolicyProvider = {
    verifyAndReadOc: async (...args: Parameters<typeof policyProvider.verifyAndReadOc>) => {
      policyCalls += 1;
      return policyProvider.verifyAndReadOc(...args);
    },
  };
  const result = await runPipeline(initial.run.runId, {
    identityProvider: new SyntheticEverestProvider("multiple_people"),
    policyProvider: guardedPolicyProvider,
    repository,
    clock: fixedClock,
  });

  assert.deepEqual(result, { kind: "identity_review", reason: "ambiguous" });
  assert.equal((await repository.load(initial.run.runId))?.status, "identity_review");
  assert.equal(policyCalls, 0);
  assert.equal((await repository.load(initial.run.runId))?.identity, null);
});

test("pełny snapshot bez aktualnych polis daje roboczy wynik zerowy bez terminalnego zapisu", async () => {
  const initial = makeContext();
  const repository = new MemoryRunRepository(initial, fixedClock);
  const result = await runPipeline(initial.run.runId, {
    identityProvider: new SyntheticEverestProvider("one_business"),
    policyProvider: new SyntheticPolicyProvider("zero_policies"),
    repository,
    clock: fixedClock,
  });

  assert.equal(result.kind, "draft_result");
  if (result.kind !== "draft_result") return;
  assert.equal(result.result.outcome, "no_matching_policies");
  assert.equal(result.result.currentOcCount, 0);
  assert.equal(result.currentPolicies.length, 0);
  assert.equal((await repository.load(initial.run.runId))?.status, "reading_oc");
});

test("dwukrotne równoległe dostarczenie tego samego runId uruchamia każdy adapter tylko raz", async () => {
  const initial = makeContext();
  const repository = new MemoryRunRepository(initial, fixedClock);
  const identityFixture = new SyntheticEverestProvider("one_business");
  const policyFixture = new SyntheticPolicyProvider("one_policy");
  let identityCalls = 0;
  let policyCalls = 0;
  const identityProvider: IdentityProvider = {
    findIdentity: async (context) => {
      identityCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return identityFixture.findIdentity(context);
    },
  };
  const policyProvider: PolicyProvider = {
    verifyAndReadOc: async (context, identity) => {
      policyCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return policyFixture.verifyAndReadOc(context, identity);
    },
  };
  const dependencies = { identityProvider, policyProvider, repository, clock: fixedClock };

  const results = await Promise.all([
    runPipeline(initial.run.runId, dependencies),
    runPipeline(initial.run.runId, dependencies),
  ]);

  assert.equal(results.filter((result) => result.kind === "draft_result").length, 1);
  assert.equal(results.filter((result) => result.kind === "state_conflict").length, 1);
  assert.equal(identityCalls, 1);
  assert.equal(policyCalls, 1);
  assert.equal(repository.events().filter(({ status }) => status === "pzu_login").length, 1);
});

test("anulowanie przed pierwszym etapem zewnętrznym nie wywołuje żadnego dostawcy", async () => {
  const initial = { ...makeContext(), cancelRequested: true };
  const repository = new MemoryRunRepository(initial, fixedClock);
  let identityCalls = 0;
  let policyCalls = 0;
  const result = await runPipeline(initial.run.runId, {
    identityProvider: { findIdentity: async () => { identityCalls += 1; return { kind: "not_found" }; } },
    policyProvider: { verifyAndReadOc: async () => { policyCalls += 1; return { kind: "portal_error", errorCode: "PORTAL_FAILURE" }; } },
    repository,
    clock: fixedClock,
  });

  assert.deepEqual(result, { kind: "cancelled" });
  assert.equal((await repository.load(initial.run.runId))?.status, "cancelled");
  assert.equal(identityCalls, 0);
  assert.equal(policyCalls, 0);
});

test("błędna referenceDate kończy się INPUT_INVALID przed wywołaniem portalu", async () => {
  const initial = { ...makeContext(), run: { ...makeContext().run, referenceDate: "2026-02-30" } };
  const repository = new MemoryRunRepository(initial, fixedClock);
  let identityCalls = 0;
  const result = await runPipeline(initial.run.runId, {
    identityProvider: { findIdentity: async () => { identityCalls += 1; return { kind: "not_found" }; } },
    policyProvider: new SyntheticPolicyProvider("one_policy"),
    repository,
    clock: fixedClock,
  });

  assert.deepEqual(result, { kind: "failed", errorCode: "INPUT_INVALID" });
  assert.equal((await repository.load(initial.run.runId))?.status, "failed");
  assert.equal(identityCalls, 0);
  assert.equal(repository.events().at(-1)?.errorCode, "INPUT_INVALID");
});

test("pipeline nie używa raw REGON jako zastępstwa dla pustego effectiveRegon", async () => {
  const base = makeContext();
  const initial = { ...base, source: { ...base.source, effectiveRegon: null } };
  const repository = new MemoryRunRepository(initial, fixedClock);
  let identityCalls = 0;
  const result = await runPipeline(initial.run.runId, {
    identityProvider: { findIdentity: async () => { identityCalls += 1; return { kind: "not_found" }; } },
    policyProvider: new SyntheticPolicyProvider("one_policy"),
    repository,
    clock: fixedClock,
  });

  assert.deepEqual(result, { kind: "failed", errorCode: "INPUT_INVALID" });
  assert.equal(identityCalls, 0);
  assert.equal((await repository.load(initial.run.runId))?.source.regonRaw, "012345678");
});

test("restart przed zapisem tożsamości powtarza wyszukiwanie Everest i nie uruchamia Compensy bez dopasowania", async () => {
  const initial = makeContext();
  const repository = new MemoryRunRepository(initial, fixedClock);
  assert.equal(await repository.transition(initial.run.runId, "awaiting_portal_adapter", "pzu_login"), true);
  let identityCalls = 0;
  let policyCalls = 0;

  const restarted = await runPipeline(initial.run.runId, {
    identityProvider: { findIdentity: async () => { identityCalls += 1; return { kind: "not_found" }; } },
    policyProvider: { verifyAndReadOc: async () => { policyCalls += 1; return { kind: "portal_error", errorCode: "PORTAL_FAILURE" }; } },
    repository,
    clock: fixedClock,
  });

  assert.deepEqual(restarted, { kind: "failed", errorCode: "IDENTITY_NOT_FOUND" });
  assert.equal(identityCalls, 1);
  assert.equal(policyCalls, 0);
  assert.equal((await repository.load(initial.run.runId))?.status, "failed");
});

test("restart po zatwierdzonym checkpointcie osoby nie odpytuje ponownie Everest", async () => {
  const initial = makeContext();
  const repository = new MemoryRunRepository(initial, fixedClock);
  const matched = await new SyntheticEverestProvider("one_business").findIdentity(initial);
  assert.equal(matched.kind, "matched");
  if (matched.kind !== "matched") return;

  assert.equal(await repository.transition(initial.run.runId, "awaiting_portal_adapter", "pzu_login"), true);
  assert.equal(await repository.transition(initial.run.runId, "pzu_login", "everest_search"), true);
  await repository.saveIdentity(initial.run.runId, matched.identity);
  assert.equal(await repository.transition(initial.run.runId, "everest_search", "compensa_login"), true);

  let identityCalls = 0;
  let policyCalls = 0;
  const result = await runPipeline(initial.run.runId, {
    identityProvider: { findIdentity: async () => { identityCalls += 1; return { kind: "not_found" }; } },
    policyProvider: {
      async verifyAndReadOc(context, identity) {
        policyCalls += 1;
        assert.equal(context.identity?.pesel, identity.pesel);
        return new SyntheticPolicyProvider("one_policy").verifyAndReadOc(context, identity);
      },
    },
    repository,
    clock: fixedClock,
  });

  assert.equal(result.kind, "draft_result");
  assert.equal(identityCalls, 0);
  assert.equal(policyCalls, 1);
  assert.equal((await repository.load(initial.run.runId))?.status, "reading_oc");
});

test("wyjątek adaptera jest mapowany na stały kod bez ujawniania treści wyjątku", async () => {
  const initial = makeContext();
  const repository = new MemoryRunRepository(initial, fixedClock);
  const privateMarker = "90010100016";
  const result = await runPipeline(initial.run.runId, {
    identityProvider: { findIdentity: async () => { throw new Error(`failure ${privateMarker}`); } },
    policyProvider: new SyntheticPolicyProvider("one_policy"),
    repository,
    clock: fixedClock,
  });

  assert.deepEqual(result, { kind: "failed", errorCode: "PORTAL_FAILURE" });
  assert.equal((await repository.load(initial.run.runId))?.status, "failed");
  const persisted = JSON.stringify({ result, events: repository.events() });
  assert.equal(persisted.includes(privateMarker), false);
  assert.equal(persisted.includes("failure"), false);
});

test("niekompletny snapshot UFG nie staje się wynikiem ani eksportem", async () => {
  const initial = makeContext();
  const repository = new MemoryRunRepository(initial, fixedClock);
  const invalidSnapshot = {
    schemaVersion: 1,
    totalCount: 2,
    policies: [],
    capturedAt: "2026-09-30T09:00:00.000Z",
    parserVersion: "bad-fixture",
  };
  const policyProvider: PolicyProvider = {
    verifyAndReadOc: async (): Promise<PolicyLookupResult> => ({ kind: "snapshot", snapshot: invalidSnapshot as never }),
  };
  const result = await runPipeline(initial.run.runId, {
    identityProvider: new SyntheticEverestProvider("one_business"),
    policyProvider,
    repository,
    clock: fixedClock,
  });

  assert.deepEqual(result, { kind: "failed", errorCode: "UFG_INCOMPLETE" });
  assert.equal((await repository.load(initial.run.runId))?.status, "failed");
  assert.equal(repository.events().some(({ status }) => status === "export_ready" || status === "completed"), false);
});
