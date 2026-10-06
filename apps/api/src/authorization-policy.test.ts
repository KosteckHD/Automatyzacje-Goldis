import assert from "node:assert/strict";
import { test } from "node:test";
import { canAssignIntervention, canPerform, permissionScope, type AuthorizationContext } from "./authorization-policy";

const owned: AuthorizationContext = {
  actorUserId: "user-operator-1", actorTenantId: "tenant-goldis",
  resourceOwnerId: "user-operator-1", resourceTenantId: "tenant-goldis",
};

test("przydział interwencji wymaga właściwej roli i prawa do konkretnego rodzaju pracy", () => {
  assert.equal(canAssignIntervention({ role: "operator", kind: "sms", canViewResults: false, canExecute: true }), true);
  assert.equal(canAssignIntervention({ role: "operator", kind: "sms", canViewResults: true, canExecute: false }), false);
  assert.equal(canAssignIntervention({ role: "reviewer", kind: "sms", canViewResults: true, canExecute: true }), false);
  assert.equal(canAssignIntervention({ role: "reviewer", kind: "identity_review", canViewResults: true, canExecute: false }), true);
  assert.equal(canAssignIntervention({ role: "operator", kind: "portal_error", canViewResults: false, canExecute: true }), false);
  assert.equal(canAssignIntervention({ role: "admin", kind: "sms", canViewResults: false, canExecute: false }), true);
});

test("operator może prowadzić własne zadania, SMS i propozycje korekt w swojej firmie", () => {
  for (const action of ["batch:read", "enrichment:read", "run:create", "run:read", "run:cancel", "sms:submit", "correction:propose", "artifact:download"] as const) {
    assert.equal(canPerform("operator", action, owned), true, action);
  }
  assert.equal(permissionScope("operator", "batch:create"), "tenant");
  assert.equal(canPerform("operator", "batch:create", { ...owned, resourceOwnerId: null }), true);
  assert.equal(canPerform("operator", "run:manual_data", owned), false, "poprawki wejścia są dostępne wyłącznie administratorowi");
});

test("operator nie ma dostępu do cudzych zasobów ani do zatwierdzania, konfliktów i audytu", () => {
  const otherOwner = { ...owned, resourceOwnerId: "user-operator-2" };
  for (const action of ["batch:read", "enrichment:read", "run:create", "run:read", "run:cancel", "sms:submit", "correction:propose", "artifact:download"] as const) {
    assert.equal(canPerform("operator", action, otherOwner), false, action);
  }
  for (const action of ["correction:review", "conflict:review", "audit:read", "user:manage"] as const) {
    assert.equal(canPerform("operator", action, owned), false, action);
  }
});

test("reviewer widzi i rozstrzyga dane w tenant, ale nie uruchamia portali ani nie pobiera artefaktu", () => {
  for (const action of ["batch:read", "enrichment:read", "run:read", "correction:review", "conflict:review", "audit:read"] as const) {
    assert.equal(canPerform("reviewer", action, { ...owned, resourceOwnerId: "other-user" }), true, action);
  }
  for (const action of ["run:create", "run:cancel", "sms:submit", "correction:propose", "artifact:download", "user:manage"] as const) {
    assert.equal(canPerform("reviewer", action, owned), false, action);
  }
  assert.equal(canPerform("reviewer", "run:manual_data", owned), false);
});

test("auditor czyta wyłącznie audyt; każda rola jest blokowana między tenantami", () => {
  assert.equal(canPerform("auditor", "audit:read", owned), true);
  assert.equal(canPerform("auditor", "batch:read", owned), false);
  assert.equal(canPerform("auditor", "run:manual_data", owned), false);
  assert.equal(canPerform("auditor", "artifact:download", owned), false);
  for (const role of ["admin", "operator", "reviewer", "auditor"] as const) {
    assert.equal(canPerform(role, "audit:read", { ...owned, resourceTenantId: "tenant-other" }), false, role);
    assert.equal(canPerform(role, "audit:read", { ...owned, actorTenantId: null }), false, `${role}:missing-tenant`);
  }
});

test("admin ma pełen zakres działań w swojej firmie, ale nie przekracza granicy tenanta", () => {
  for (const action of ["batch:create", "batch:read", "enrichment:read", "run:create", "run:read", "run:cancel", "run:manual_data", "sms:submit", "correction:propose", "correction:review", "conflict:review", "audit:read", "artifact:download", "user:manage"] as const) {
    assert.equal(canPerform("admin", action, owned), true, action);
    assert.equal(canPerform("admin", action, { ...owned, resourceTenantId: "tenant-other" }), false, action);
  }
});
