"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ROWS, campaignEnvironment, assertScope, verifyWorkbook, requiresStop, assertReviewedContinuation, assertPostFixContinuation, assertReadOnlyContinuation } = require("./live-acceptance-18010-18020.cjs");

const settings = { COMPOSE_PROJECT_NAME: "goldis-acceptance-20261015", DATABASE_URL: "postgres://goldis_api:test@127.0.0.1:52257/goldis", MIGRATOR_DATABASE_URL: "postgres://goldis_migrator:test@127.0.0.1:52257/goldis", WORKER_DATABASE_URL: "postgres://goldis_worker:test@127.0.0.1:52257/goldis", REDIS_URL: "redis://goldis_api:test@127.0.0.1:52258/0", WORKER_REDIS_URL: "redis://goldis_worker:test@127.0.0.1:52258/0" };
test("scope includes exactly the eleven physical rows and rejects missing or extra rows", () => {
  assert.deepEqual(ROWS, [18010,18011,18012,18013,18014,18015,18016,18017,18018,18019,18020]);
  assertScope(ROWS); assert.throws(() => assertScope(ROWS.slice(1)), /SCOPE/); assert.throws(() => assertScope([...ROWS,18021]), /SCOPE/);
});
test("main local database and inherited test/secret settings cannot enter acceptance", () => {
  assert.throws(() => campaignEnvironment({ ...settings, DATABASE_URL: "postgres://user:test@127.0.0.1:56897/goldis" }), /DATABASE_SCOPE/);
  assert.throws(() => campaignEnvironment({ ...settings, WORKER_REDIS_URL: "redis://127.0.0.1:56898/0" }), /REDIS_SCOPE/);
  const env = campaignEnvironment(settings, { Path: "os-path", DATABASE_URL_FILE: "private", WORKER_PZU_LOGIN_TEST_RUN_ID: "unrelated", WORKER_LIVE_PORTALS: "1", GOLDIS_TEST_MODE: "1" });
  assert.equal(env.Path, "os-path"); assert.equal(env.WORKER_LIVE_PORTALS, "0"); assert.equal(env.API_PORT, "3101");
  assert.equal(env.WORKER_INTERNAL_URL, "http://127.0.0.1:3122"); assert.equal(env.DATABASE_URL_FILE, undefined); assert.equal(env.WORKER_PZU_LOGIN_TEST_RUN_ID, undefined); assert.equal(env.GOLDIS_TEST_MODE, undefined);
});
test("a row outcome before portal mutations may continue, uncertain portal actions halt", () => {
  assert.equal(requiresStop({ status: "failed", errorCode: "IDENTITY_NOT_FOUND" }, []), false);
  assert.equal(requiresStop({ status: "identity_review", errorCode: "IDENTITY_AMBIGUOUS" }, []), false);
  assert.equal(requiresStop({ status: "failed", errorCode: "IDENTITY_NOT_FOUND" }, [{ step: "compensa_start_intent" }]), true);
  assert.equal(requiresStop({ status: "waiting_for_manual_data", errorCode: "PORTAL_ACTION_REVIEW" }, []), true);
});
test("reviewed continuation preserves the failed run and refuses uncertain Compensa actions", () => {
  const report = { state: "paused_for_review", stopReason: "REVIEW_ROW_18013_PORTAL_FAILURE", rows: [{ rowNumber: 18013, status: "waiting_for_manual_data" }] };
  const diagnostic = { rowNumber: 18013, mode: "identity_lookup_only", authenticatedAfter: "authenticated", result: { kind: "identity_review" } };
  assertReviewedContinuation(report, diagnostic, []);
  assert.throws(() => assertReviewedContinuation(report, diagnostic, [{ step: "compensa_start_intent" }]), /WITHOUT_PORTAL_MUTATIONS/);
  assert.throws(() => assertReviewedContinuation(report, { ...diagnostic, errorCode: "PORTAL_FAILURE" }, []), /WITHOUT_PORTAL_MUTATIONS/);
  assert.equal(report.rows[0].status, "waiting_for_manual_data");
});
test("post-fix revision accepts only the three unstarted rows and never replays an offer", () => {
  const report = { state: "paused_for_review", stopReason: "REVIEW_ROW_18017_PORTAL_FAILURE", rows: [{ rowNumber: 18017, status: "waiting_for_manual_data" }, ...[18018,18019,18020].map(rowNumber => ({ rowNumber, status: "not_started" }))] };
  const diagnostic = { rowNumber: 18017, authenticatedAfter: "authenticated", resolutionFailure: { stage: "compensa_identity_name_lookup", timeout: true, customerCards: 0, client360Visible: true } };
  assertPostFixContinuation(report, diagnostic, []);
  assert.throws(() => assertPostFixContinuation(report, diagnostic, [{ step: "compensa_start_intent" }]), /POST_FIX_CONTINUATION/);
  assert.throws(() => assertPostFixContinuation({ ...report, rows: [...report.rows, { rowNumber: 18021, status: "not_started" }] }, diagnostic, []), /SCOPE_MISMATCH/);
});
test("a reviewed read-only failure can continue only the last two rows without portal mutations", () => {
  const report = { revision: 2, state: "paused_for_review", stopReason: "REVIEW_ROW_18018_PORTAL_FAILURE", rows: [{ rowNumber: 18018, status: "waiting_for_manual_data" }, ...[18019,18020].map(rowNumber => ({ rowNumber, status: "not_started" }))] };
  assertReadOnlyContinuation(report, []);
  assert.throws(() => assertReadOnlyContinuation(report, [{ step: "ufg_verification_intent" }]), /READ_ONLY_CONTINUATION/);
  const row = { status: "waiting_for_manual_data", errorCode: "PORTAL_FAILURE", allowReadOnlyFailureContinuation: true };
  assert.equal(requiresStop(row, []), false);
  assert.equal(requiresStop(row, [{ step: "compensa_start_intent" }]), true);
});
test("an export with another identity or policy value never passes verification", async () => {
  const ExcelJS = require("exceljs"), w = new ExcelJS.Workbook(), s = w.addWorksheet("Wynik OC");
  const frozen = { input_snapshot: { companyName: "Example", effectiveRegon: "123", decisionMakerName: null, mobile: "", phone: "", email: "" } };
  s.addRow(["headers"]); s.addRow(["Example","123","","","","","synthetic-id"]); s.addRow([]); s.addRow(["section"]); s.addRow(["headers"]);
  const p = { insured_name: "Person", policy_type_and_number: "OC x", contract_type: "OC", insured_claim_count: 0, vehicle_registration: "ABC", vehicle_group: "car", vehicle_make: "Make", vehicle_model: "Model", insurer: "Insurer", coverage_from: "2026-01-01", coverage_to: "2027-01-01" };
  s.addRow([1,"Person","OC x","OC",0,"ABC","car","Make","Model","Insurer","2026-01-01","2027-01-01"]);
  verifyWorkbook(s, frozen, "synthetic-id", [p]);
  assert.throws(() => verifyWorkbook(s, frozen, "other-id", [p]), /IDENTITY_MISMATCH/);
  assert.throws(() => verifyWorkbook(s, frozen, "synthetic-id", [{ ...p, insurer: "Different" }]), /POLICY_MISMATCH/);
});

test("the new campaign uses exactly rows 18020–18030 and its own report directory", () => {
  const { execFileSync } = require("node:child_process");
  const code = `const m=require(${JSON.stringify(require.resolve("./live-acceptance-18010-18020.cjs"))}); console.log(JSON.stringify({rows:m.ROWS,directory:m.DIRECTORY}));`;
  const scope = JSON.parse(execFileSync(process.execPath, ["-e", code, "--", "--range-18020-18030"], { encoding: "utf8" }));
  assert.deepEqual(scope.rows, Array.from({ length: 11 }, (_, i) => 18020 + i));
  assert.match(scope.directory, /acceptance-18020-18030-20261017$/);
});

test("incomplete Compensa data is a separate outcome only with direct evidence and no save intent", () => {
  const { isBlockedCompensaCustomer } = require("./live-acceptance-18010-18020.cjs");
  const row = { status: "failed", errorCode: "MANUAL_DATA_REQUIRED", portalEvidence: { incompleteCustomer: true, postalDisabled: true, countyDisabled: true } };
  const events = [{ step: "compensa_start_intent" }, { step: "compensa_offer_draft_open" }];
  assert.equal(isBlockedCompensaCustomer(row, events), true);
  assert.equal(isBlockedCompensaCustomer({ ...row, portalEvidence: undefined }, events), false);
  assert.equal(isBlockedCompensaCustomer(row, [...events, { step: "compensa_insured_save_intent" }]), false);
  assert.equal(isBlockedCompensaCustomer(row, [...events, events[0]]), false);
});

test("the policy check is restricted to row 18025 and stops on any unexpected write intent", () => {
  const { execFileSync } = require("node:child_process");
  const code = `const m=require(${JSON.stringify(require.resolve("./live-acceptance-18010-18020.cjs"))}); console.log(JSON.stringify(m.ROWS));`;
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ["-e", code, "--", "--skip-policy-18025"], { encoding: "utf8" })), [18025]);
  const skipped = { status: "failed", errorCode: "COMPENSA_PAYER_DATA_SKIPPED" };
  assert.equal(requiresStop(skipped, [{ step: "compensa_start_intent" }]), false);
  assert.equal(requiresStop(skipped, [{ step: "compensa_insured_save_intent" }]), true);
});
