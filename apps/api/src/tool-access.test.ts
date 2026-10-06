import assert from "node:assert/strict";
import { test } from "node:test";
import { showToolInSession, toolAccessFromRecords, type ToolPrincipal } from "./tool-access";

const tool = { toolId: "oc-policy-verification", status: "available" };
const operator: ToolPrincipal = { userId: "11111111-1111-4111-8111-111111111111", tenantId: "22222222-2222-4222-8222-222222222222", role: "operator" };

test("operator with no grant receives no tool capabilities", () => {
  assert.deepEqual(toolAccessFromRecords(operator, tool, null), {
    toolId: tool.toolId, canDiscover: false, canExecute: false, canViewResults: false, canDownloadResults: false,
  });
});

test("tool capabilities imply safe discover and result view without widening execution", () => {
  const executeOnly = toolAccessFromRecords(operator, tool, {
    canDiscover: false, canExecute: true, canViewResults: false, canDownloadResults: false,
  });
  assert.equal(executeOnly.canDiscover, true);
  assert.equal(executeOnly.canExecute, true);
  assert.equal(executeOnly.canViewResults, false);

  const downloadOnly = toolAccessFromRecords(operator, tool, {
    canDiscover: false, canExecute: false, canViewResults: false, canDownloadResults: true,
  });
  assert.equal(downloadOnly.canViewResults, true);
  assert.equal(downloadOnly.canDownloadResults, true);
  assert.equal(downloadOnly.canExecute, false);
  assert.equal(showToolInSession(downloadOnly), true, "uprawnienie do wyników wystarcza, by odnaleźć historię bez prawa startu");
});

test("brak discover i view_results nie pokazuje narzędzia w sesji", () => {
  const hidden = toolAccessFromRecords(operator, tool, {
    canDiscover: false, canExecute: false, canViewResults: false, canDownloadResults: false,
  });
  assert.equal(showToolInSession(hidden), false);
});

test("maintenance blocks starts and disabled tools hide every capability", () => {
  const grant = { canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: false };
  assert.deepEqual(toolAccessFromRecords(operator, { ...tool, status: "maintenance" }, grant), {
    toolId: tool.toolId, canDiscover: true, canExecute: false, canViewResults: true, canDownloadResults: false,
  });
  assert.equal(toolAccessFromRecords(operator, { ...tool, status: "disabled" }, grant).canDiscover, false);
});

test("admin can inspect every catalogued tool but maintenance still blocks new runs", () => {
  const admin: ToolPrincipal = { ...operator, role: "admin" };
  assert.deepEqual(toolAccessFromRecords(admin, { ...tool, status: "maintenance" }, null), {
    toolId: tool.toolId, canDiscover: true, canExecute: false, canViewResults: true, canDownloadResults: true,
  });
});
