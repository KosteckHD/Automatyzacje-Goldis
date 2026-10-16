import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityForPermission, showToolInSession, type ToolPrincipal, toolAccessFromRecords } from "./tool-access";

const tool = { toolId: "oc-policy-verification", status: "available" };
const operator: ToolPrincipal = {
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  role: "operator",
};

test("aktywny pracownik ma wspólny odczyt wyników OC bez prawa uruchomienia", () => {
  assert.deepEqual(toolAccessFromRecords(operator, tool, null), {
    toolId: tool.toolId,
    canDiscover: true,
    canExecute: false,
    canViewResults: true,
    canDownloadResults: true,
  });
});

test("uprawnienie uruchomienia jest niezależne od wspólnego odczytu wyników OC", () => {
  const executeOnly = toolAccessFromRecords(operator, tool, {
    canDiscover: false,
    canExecute: true,
    canViewResults: false,
    canDownloadResults: false,
  });
  assert.equal(executeOnly.canDiscover, true);
  assert.equal(executeOnly.canExecute, true);
  assert.equal(executeOnly.canViewResults, true);
  assert.equal(executeOnly.canDownloadResults, true);

  const downloadOnly = toolAccessFromRecords(operator, tool, {
    canDiscover: false,
    canExecute: false,
    canViewResults: false,
    canDownloadResults: true,
  });
  assert.equal(downloadOnly.canViewResults, true);
  assert.equal(downloadOnly.canDownloadResults, true);
  assert.equal(downloadOnly.canExecute, false);
  assert.equal(showToolInSession(downloadOnly), true, "wspólny odczyt pokazuje wyniki bez prawa uruchomienia");
});

test("wspólny odczyt OC pozostaje dostępny mimo braku indywidualnego grantu", () => {
  const hidden = toolAccessFromRecords(operator, tool, {
    canDiscover: false,
    canExecute: false,
    canViewResults: false,
    canDownloadResults: false,
  });
  assert.equal(showToolInSession(hidden), true);
  assert.equal(hidden.canExecute, false);
});

test("wspólna widoczność OC nie rozszerza dostępu do drugiej automatyzacji", () => {
  const secondTool = { toolId: "second-automation", status: "available" };
  assert.deepEqual(toolAccessFromRecords(operator, secondTool, null), {
    toolId: secondTool.toolId,
    canDiscover: false,
    canExecute: false,
    canViewResults: false,
    canDownloadResults: false,
  });
});

test("maintenance blokuje nowe uruchomienia, a wyłączone OC zachowuje wspólny odczyt historycznych wyników", () => {
  const grant = { canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: false };
  assert.deepEqual(toolAccessFromRecords(operator, { ...tool, status: "maintenance" }, grant), {
    toolId: tool.toolId,
    canDiscover: true,
    canExecute: false,
    canViewResults: true,
    canDownloadResults: true,
  });
  const disabled = toolAccessFromRecords(operator, { ...tool, status: "disabled" }, grant);
  assert.equal(disabled.canDiscover, false);
  assert.equal(disabled.canExecute, false);
  assert.equal(disabled.canViewResults, true);
  assert.equal(disabled.canDownloadResults, true);
});

test("admin can inspect every catalogued tool but maintenance still blocks new runs", () => {
  const admin: ToolPrincipal = { ...operator, role: "admin" };
  assert.deepEqual(toolAccessFromRecords(admin, { ...tool, status: "maintenance" }, null), {
    toolId: tool.toolId,
    canDiscover: true,
    canExecute: false,
    canViewResults: true,
    canDownloadResults: true,
  });
});

test("submission reads use view_results independently from execute", () => {
  assert.equal(capabilityForPermission("submission:read"), "view_results");
  assert.equal(capabilityForPermission("submission:cancel"), "execute");
  assert.equal(capabilityForPermission("submission:unreviewed-extension"), null);
});
