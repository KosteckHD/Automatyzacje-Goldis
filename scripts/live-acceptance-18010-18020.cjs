"use strict";

// Human-selected scope: eleven physical rows, inclusive. Nothing runs on import.
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { Pool } = require("pg");
const ExcelJS = require("exceljs");
const { explain, classify } = require("./supervised-live-report.cjs");
const { buildAcceptancePortalConfig } = require("./prepare-acceptance-portal-config.cjs");

const ROOT = path.resolve(__dirname, "..");
const POLICY = process.argv.includes("--skip-policy-18025");
const RANGE = process.argv.includes("--range-18020-18030");
const CLOSURE = process.argv.includes("--closure-12-14");
const RETEST = CLOSURE || process.argv.includes("--retest-reviewed");
const ROWS = Object.freeze(POLICY ? [18025] : RANGE ? Array.from({ length: 11 }, (_, i) => 18020 + i) : CLOSURE ? [18012,18014] : RETEST ? [18012,18013,18014,18015,18017,18018,18019,18020] : Array.from({ length: 11 }, (_, i) => 18010 + i));
const ORIGINAL_DIRECTORY = path.join(ROOT, "exports/acceptance-18010-18020-20261017");
const DIRECTORY = POLICY ? path.join(ROOT, "exports/acceptance-18025-skip-policy-20261017") : RANGE ? path.join(ROOT, "exports/acceptance-18020-18030-20261017") : CLOSURE ? path.join(ORIGINAL_DIRECTORY, "closure-runs") : RETEST ? path.join(ORIGINAL_DIRECTORY, "retest-v3") : ORIGINAL_DIRECTORY;
const PORTS = Object.freeze({ web: 3100, api: 3101, parser: 3110, worker: 3122 });
const TERMINAL = new Set(["completed", "no_matching_policies", "failed", "cancelled", "identity_review", "waiting_for_manual_data"]);
const ACTIVE = "'queued','validating','awaiting_portal_adapter','pzu_login','everest_search','compensa_login','compensa_form','ufg_verification','reading_oc','export_ready','waiting_for_sms'";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeCode = e => /^[A-Z][A-Z0-9_]{1,100}$/.test(e?.message || "") ? e.message : "ACCEPTANCE_UNCLASSIFIED_ERROR";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const literal = value => /^[=+\-@]/.test(value || "") ? "'" + value : value ?? "";
const same = (a, b, code) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(code); };

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map(m => [m[1], m[2].trim().replace(/^['"]|['"]$/g, "")]));
}

function campaignEnvironment(settings, inherited = process.env) {
  if (settings.COMPOSE_PROJECT_NAME !== "goldis-acceptance-20261015") throw new Error("ACCEPTANCE_PROJECT_MISMATCH");
  for (const name of ["DATABASE_URL", "WORKER_DATABASE_URL", "MIGRATOR_DATABASE_URL"]) {
    const url = new URL(settings[name]);
    if (url.hostname !== "127.0.0.1" || url.port !== "52257" || url.pathname !== "/goldis") throw new Error("ACCEPTANCE_DATABASE_SCOPE_MISMATCH");
  }
  for (const name of ["REDIS_URL", "WORKER_REDIS_URL"]) {
    const url = new URL(settings[name]);
    if (url.hostname !== "127.0.0.1" || url.port !== "52258") throw new Error("ACCEPTANCE_REDIS_SCOPE_MISMATCH");
  }
  // Inherit OS settings, not arbitrary worker/test overrides or *_FILE secrets.
  const os = Object.fromEntries(Object.entries(inherited).filter(([name]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|HOMEDRIVE|HOMEPATH|USERNAME|NUMBER_OF_PROCESSORS)$/i.test(name)));
  const result = { ...os, ...settings, APP_ENV: "development", NODE_ENV: "development",
    API_PORT: String(PORTS.api), PUBLIC_APP_ORIGIN: `http://127.0.0.1:${PORTS.web}`,
    API_INTERNAL_URL: `http://127.0.0.1:${PORTS.api}`, GOLDIS_API_READY_URL: `http://127.0.0.1:${PORTS.api}/api/health/ready`,
    WORKER_RESULT_API_URL: `http://127.0.0.1:${PORTS.api}`, WORKER_INTERNAL_URL: `http://127.0.0.1:${PORTS.worker}`,
    WORKER_INTERNAL_HOST: "127.0.0.1", WORKER_INTERNAL_PORT: String(PORTS.worker),
    IMPORT_PARSER_HOST: "127.0.0.1", IMPORT_PARSER_PORT: String(PORTS.parser), IMPORT_PARSER_URL: `http://127.0.0.1:${PORTS.parser}`,
    WORKER_LIVE_PORTALS: "0", WORKER_PORTAL_CONFIG_PATH: path.join(DIRECTORY, "portals.json"),
    API_EXPORT_DIR: path.join(DIRECTORY, "encrypted-results"), WORKER_STAGING_DIR: path.join(DIRECTORY, "staging"),
    GOLDIS_DELETION_JOURNAL_DIR: path.join(ROOT, "exports/live-acceptance/isolated-runtime/deletion-journal"),
    GOLDIS_ENRICHMENT_PROVIDER: "disabled", GOLDIS_EMAIL_PROVIDER: "disabled", GOLDIS_PASSWORD_RECOVERY_ENABLED: "0",
    TRUST_PROXY_IPS: "", GOLDIS_DELETION_WORKER: "0" };
  for (const name of Object.keys(result)) if (name.endsWith("_FILE") || /^ACCEPTANCE_|^WORKER_PZU_LOGIN_TEST_|^GOLDIS_TEST_/.test(name)) delete result[name];
  return result;
}

function assertScope(rows) { same(rows.map(r => typeof r === "number" ? r : r.rowNumber), ROWS, "ACCEPTANCE_INPUT_SCOPE_MISMATCH"); }

function verifyWorkbook(sheet, frozen, pesel, policies) {
  if (!sheet || sheet.rowCount !== policies.length + 5) throw new Error("ARTIFACT_ROW_COUNT_MISMATCH");
  const s = frozen.input_snapshot;
  same(sheet.getRow(2).values.slice(1), [s.companyName, s.effectiveRegon, s.decisionMakerName, s.mobile, s.phone, s.email, pesel].map(literal), "ARTIFACT_IDENTITY_MISMATCH");
  policies.forEach((p, i) => same(sheet.getRow(i + 6).values.slice(1), [i + 1, literal(p.insured_name), literal(p.policy_type_and_number), literal(p.contract_type), p.insured_claim_count, literal(p.vehicle_registration), literal(p.vehicle_group), literal(p.vehicle_make), literal(p.vehicle_model), literal(p.insurer), p.coverage_from || "", p.coverage_to], "ARTIFACT_POLICY_MISMATCH"));
}

function isBlockedCompensaCustomer(row, events) {
  const evidence = row.portalEvidence;
  return row.status === "failed" && row.errorCode === "MANUAL_DATA_REQUIRED"
    && evidence?.incompleteCustomer === true && evidence.postalDisabled === true && evidence.countyDisabled === true
    && events.filter(e => e.step === "compensa_start_intent").length === 1
    && events.filter(e => e.step === "compensa_offer_draft_open").length === 1
    && !events.some(e => ["compensa_insured_save_intent", "compensa_insured_data_saved", "ufg_verification_intent"].includes(e.step));
}

function requiresStop(row, events) {
  if (row.status === "completed" || row.status === "no_matching_policies" || row.status === "input_review" || row.status === "duplicate") return false;
  if (row.status === "failed" && ["COMPENSA_PAYER_DATA_SKIPPED", "COMPENSA_CUSTOMER_DATA_INCOMPLETE"].includes(row.errorCode)
    && !events.some(e => ["compensa_insured_save_intent", "compensa_insured_data_saved", "ufg_verification_intent"].includes(e.step))) return false;
  if (RANGE && isBlockedCompensaCustomer(row, events)) return false;
  // A missing/ambiguous identity before opening a case is an independent row outcome.
  const mutations = events.some(e => ["compensa_start_intent", "compensa_offer_draft_open", "compensa_insured_data_saved", "ufg_verification_intent"].includes(e.step));
  if (RETEST && row.rowNumber === 18014 && row.status === "failed" && row.errorCode === "MANUAL_DATA_REQUIRED"
    && !events.some(e => ["compensa_insured_save_intent", "compensa_insured_data_saved", "ufg_verification_intent"].includes(e.step))) return false;
  if (row.errorCode === "PORTAL_FAILURE" && !mutations && row.allowReadOnlyFailureContinuation) return false;
  return mutations || !["IDENTITY_NOT_FOUND", "IDENTITY_EXPECTED_PERSON_MISSING", "IDENTITY_PESEL_MISSING", "IDENTITY_PESEL_INVALID", "IDENTITY_UNSUPPORTED_TYPE", "IDENTITY_AMBIGUOUS", "IDENTITY_MISMATCH", "INPUT_INVALID"].includes(row.errorCode);
}

function assertReadOnlyContinuation(report, events) {
  const row = report.rows.find(r => r.rowNumber === 18018);
  if (report.revision !== 2 || report.state !== "paused_for_review" || report.stopReason !== "REVIEW_ROW_18018_PORTAL_FAILURE"
    || row?.status !== "waiting_for_manual_data"
    || events.some(e => ["compensa_start_intent", "compensa_offer_draft_open", "compensa_insured_data_saved", "ufg_verification_intent"].includes(e.step))) throw new Error("READ_ONLY_CONTINUATION_REQUIRES_REVIEW");
  same(report.rows.filter(r => r.status === "not_started").map(r => r.rowNumber), [18019,18020], "READ_ONLY_REMAINING_SCOPE_MISMATCH");
}

function assertReviewedContinuation(report, diagnostic, events) {
  const row = report.rows.find(r => r.rowNumber === 18013);
  if (report.state !== "paused_for_review" || report.stopReason !== "REVIEW_ROW_18013_PORTAL_FAILURE"
    || row?.status !== "waiting_for_manual_data" || diagnostic.rowNumber !== 18013
    || diagnostic.mode !== "identity_lookup_only" || diagnostic.errorCode
    || diagnostic.authenticatedAfter !== "authenticated" || diagnostic.result?.kind !== "identity_review"
    || events.some(e => ["compensa_start_intent", "compensa_offer_draft_open", "compensa_insured_data_saved", "ufg_verification_intent"].includes(e.step))) {
    throw new Error("CONTINUATION_REQUIRES_REVIEW_WITHOUT_PORTAL_MUTATIONS");
  }
}

function assertPostFixContinuation(report, diagnostic, events) {
  const row = report.rows.find(r => r.rowNumber === 18017);
  const failure = diagnostic.resolutionFailure;
  if (report.state !== "paused_for_review" || report.stopReason !== "REVIEW_ROW_18017_PORTAL_FAILURE"
    || row?.status !== "waiting_for_manual_data" || diagnostic.rowNumber !== 18017
    || failure?.stage !== "compensa_identity_name_lookup" || failure.timeout !== true
    || failure.customerCards !== 0 || failure.client360Visible !== true
    || diagnostic.authenticatedAfter !== "authenticated"
    || events.some(e => ["compensa_start_intent", "compensa_offer_draft_open", "compensa_insured_data_saved", "ufg_verification_intent"].includes(e.step))) throw new Error("POST_FIX_CONTINUATION_REQUIRES_REVIEW");
  same(report.rows.filter(r => r.status === "not_started").map(r => r.rowNumber), [18018, 18019, 18020], "POST_FIX_REMAINING_SCOPE_MISMATCH");
}

async function saveReport(report) {
  report.updatedAt = new Date().toISOString();
  report.summary = {};
  for (const row of report.rows) { const c = classify(row); report.summary[c] = (report.summary[c] || 0) + 1; }
  await fs.writeFile(path.join(DIRECTORY, "report.json.tmp"), JSON.stringify(report, null, 2));
  await fs.rename(path.join(DIRECTORY, "report.json.tmp"), path.join(DIRECTORY, "report.json"));
  const esc = x => String(x ?? "—").replace(/[|\r\n]/g, " ");
  const lines = [`# Odbiór ${POLICY ? "18025 — pomijanie dodatkowego formularza" : RANGE ? "18020–18030" : "18010–18020"} — ${POLICY ? "1 wiersz" : CLOSURE ? "osobna próba 18012 i 18014" : RETEST ? "ponowienie 8 wierszy po analizie użytkownika" : "11 wierszy"}`, "", `Stan: ${report.state}. Aktualizacja: ${report.updatedAt}.`,
    `Panel odbiorowy: http://127.0.0.1:${PORTS.web}/`, "", "Przebieg: API → BullMQ → główny worker → rzeczywiste portale → wynik → pobrany i sprawdzony XLSX.", "",
    "| Wiersz | Rewizja | Wynik | Etap | Przyczyna | Polisy UFG / eksport | Plik |", "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const r of report.rows) lines.push(`| ${r.rowNumber} | ${r.revision ?? "—"} | ${classify(r)} | ${esc(r.currentStep)} | ${esc(r.reason || "Nie uruchomiono")} | ${r.totalOcCount ?? "—"} / ${r.exportedPolicyCount ?? "—"} | ${r.artifactFile ? `[XLSX](${r.artifactFile})` : "—"} |`);
  if (report.stopReason) lines.push("", `Zatrzymanie: ${esc(report.stopReason)}.`);
  lines.push("", "Brak dopasowania wymaga oceny biznesowej. Stan completed bez sprawdzenia pliku nie zalicza eksportu. Ręczne dokończenie nie zalicza pełnego przebiegu automatu.");
  await fs.writeFile(path.join(DIRECTORY, "RAPORT.md"), lines.join("\n") + "\n");
}

async function prepareInput() {
  const source = new ExcelJS.Workbook();
  await source.xlsx.readFile(path.join(ROOT, "docs/BAZA TRANSPORTOWA.xlsx"));
  const original = source.getWorksheet("Realizacja");
  if (!original) throw new Error("SOURCE_SHEET_MISSING");
  const input = new ExcelJS.Workbook(), target = input.addWorksheet("Realizacja");
  for (const number of [1, ...ROWS]) {
    if (!original.getRow(number).hasValues) throw new Error("SOURCE_ROW_MISSING");
    original.getRow(number).eachCell((cell, column) => { target.getRow(number).getCell(column).value = structuredClone(cell.value); });
  }
  const bytes = Buffer.from(await input.xlsx.writeBuffer());
  const parsed = await require("../apps/api/dist/features/imports/workbook.js").parseTransportWorkbook(bytes);
  assertScope(parsed);
  await fs.writeFile(path.join(DIRECTORY, "input.xlsx"), bytes);
  return { bytes, parsed };
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error("ACCEPTANCE_PORT_BUSY_" + port)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

async function main(args = process.argv.slice(2)) {
  if (args.some(a => !["--prepare-only", "--run", "--serve-only", "--serve-after", "--continue-reviewed", "--finish-after-fix", "--continue-read-only", "--retest-reviewed", "--continue-company-selector-fix", "--closure-12-14", "--range-18020-18030", "--continue-range-reviewed", "--skip-policy-18025"].includes(a)) || args.filter(a => ["--run", "--prepare-only", "--serve-only"].includes(a)).length !== 1) throw new Error("USE_PREPARE_ONLY_OR_RUN");
  if (args.filter(a => ["--closure-12-14", "--retest-reviewed", "--range-18020-18030", "--skip-policy-18025"].includes(a)).length > 1) throw new Error("CONFLICTING_ACCEPTANCE_SCOPES");
  await fs.mkdir(DIRECTORY, { recursive: true });
  const lock = await fs.open(path.join(DIRECTORY, "runner.lock"), "wx").catch(() => { throw new Error("ACCEPTANCE_CAMPAIGN_LOCKED"); });
  const children = [];
  let pool, runtime, api, report;
  const servingOnly = args.includes("--serve-only");
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const environment = campaignEnvironment(parseEnv(await fs.readFile(path.join(ROOT, ".env.acceptance.local"), "utf8")));
  const launch = (file, label, overrides = {}, argv = []) => {
    const fd = syncFs.openSync(path.join(DIRECTORY, label + ".log"), "a");
    const child = spawn(process.execPath, [file, ...argv], { cwd: ROOT, env: { ...environment, ...overrides }, windowsHide: true, stdio: ["ignore", fd, fd] });
    syncFs.closeSync(fd); children.push(child); child.once("error", () => { stopping = true; });
    return child;
  };
  const once = async (file, label, overrides) => {
    const child = launch(path.join(ROOT, file), label, overrides);
    await new Promise((resolve, reject) => { child.once("error", () => reject(new Error("ACCEPTANCE_CHILD_FAILED"))); child.once("exit", code => code === 0 ? resolve() : reject(new Error("ACCEPTANCE_" + label.toUpperCase() + "_FAILED"))); });
  };
  try {
    try { report = JSON.parse(await fs.readFile(path.join(DIRECTORY, "report.json"), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (servingOnly) {
      if (!report?.batchId || !report.state.startsWith("finished") || report.rows.some(r => !TERMINAL.has(r.status) && !["input_review", "duplicate"].includes(r.status))) throw new Error("SERVE_ONLY_REQUIRES_FINISHED_CAMPAIGN");
      assertScope(report.rows);
      for (const port of Object.values(PORTS)) await assertPortAvailable(port);
      launch(path.join(ROOT, "apps/api/dist/import-parser-main.js"), "parser");
      const apiChild = launch(path.join(ROOT, "scripts/acceptance-api-diagnostics.cjs"), "api", { GOLDIS_ADMIN_USER: "", GOLDIS_ADMIN_PASSWORD: "" });
      let ready = false;
      for (let i = 0; i < 40 && apiChild.exitCode === null; i++) {
        try { ready = (await fetch(environment.GOLDIS_API_READY_URL, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
        if (ready) break; await delay(1500);
      }
      if (!ready) throw new Error("ACCEPTANCE_API_NOT_READY");
      launch(require.resolve("next/dist/bin/next"), "web", { NODE_ENV: "development" }, ["dev", "apps/web", "--hostname", "127.0.0.1", "--port", String(PORTS.web)]);
      await fs.writeFile(path.join(DIRECTORY, "panel-processes.json"), JSON.stringify({ controller: process.pid, children: children.map(c => c.pid), ports: PORTS }, null, 2));
      console.log("ACCEPTANCE_READ_ONLY_PANEL_STARTED_WITHOUT_PORTAL_WORKER");
      while (!syncFs.existsSync(path.join(DIRECTORY, "STOP"))) await delay(1500);
      return;
    }
    const continuing = report?.rows.some(r => r.runId);
    const afterFix = args.includes("--finish-after-fix");
    const readOnlyContinuation = args.includes("--continue-read-only");
    const companySelectorFix = RETEST && args.includes("--continue-company-selector-fix");
    const rangeReviewed = RANGE && args.includes("--continue-range-reviewed");
    if (continuing && !args.includes("--continue-reviewed") && !afterFix && !readOnlyContinuation && !companySelectorFix && !rangeReviewed) throw new Error("EXISTING_ATTEMPTS_REQUIRE_REVIEW_NOT_REPLAY");
    pool = new Pool({ connectionString: environment.MIGRATOR_DATABASE_URL, connectionTimeoutMillis: 5000 });
    if (POLICY && !continuing) {
      const previous = JSON.parse(await fs.readFile(path.join(ROOT, "exports/acceptance-18020-18030-20261017/report.json"), "utf8"));
      const prior = previous.rows.find(r => r.rowNumber === 18025);
      const actual = (await pool.query("SELECT status,last_safe_step,external_case_ref FROM automation_runs WHERE id=$1", [prior?.runId])).rows[0];
      const events = (await pool.query("SELECT step FROM run_events WHERE run_id=$1", [prior?.runId])).rows;
      if (actual?.status !== "failed" || actual.last_safe_step !== "compensa_start_intent" || actual.external_case_ref
        || events.filter(e => e.step === "compensa_start_intent").length !== 1
        || events.some(e => ["compensa_offer_draft_open", "compensa_insured_save_intent", "compensa_insured_data_saved", "ufg_verification_intent"].includes(e.step))) throw new Error("SKIP_POLICY_BASELINE_CHANGED");
    }
    if (CLOSURE && !continuing) {
      const baseline = JSON.parse(await fs.readFile(path.join(ORIGINAL_DIRECTORY, "retest-v3/report.json"), "utf8"));
      for (const number of ROWS) {
        const old = baseline.rows.find(r => r.rowNumber === number);
        const actual = (await pool.query("SELECT status,error_code,last_safe_step FROM automation_runs WHERE id=$1", [old?.runId])).rows[0];
        const events = (await pool.query("SELECT step FROM run_events WHERE run_id=$1", [old?.runId])).rows;
        if (old?.status !== "failed" || actual?.status !== "failed" || actual.error_code !== "MANUAL_DATA_REQUIRED"
          || actual.last_safe_step !== "compensa_offer_draft_open"
          || events.filter(e => e.step === "compensa_start_intent").length !== 1
          || events.some(e => ["compensa_insured_save_intent", "compensa_insured_data_saved", "ufg_verification_intent"].includes(e.step))) throw new Error("CLOSURE_BASELINE_CHANGED");
      }
      if (args.includes("--run")) {
        const approval = JSON.parse(await fs.readFile(path.join(ORIGINAL_DIRECTORY, "closure/new-attempt-authorization.json"), "utf8").catch(() => { throw new Error("CLOSURE_NEW_ATTEMPT_AUTHORIZATION_REQUIRED"); }));
        same(approval.rowNumbers, ROWS, "CLOSURE_AUTHORIZATION_SCOPE_MISMATCH");
        same(approval.previousRunIds, ROWS.map(n => baseline.rows.find(r => r.rowNumber === n).runId), "CLOSURE_AUTHORIZATION_RUN_MISMATCH");
        if (approval.allowNewAttempts !== true || approval.source !== "direct_user_reply") throw new Error("CLOSURE_NEW_ATTEMPT_AUTHORIZATION_REQUIRED");
      }
    }
    if (continuing && rangeReviewed) {
      const row = report.rows.find(r => r.rowNumber === 18025);
      const evidence = JSON.parse(await fs.readFile(path.join(DIRECTORY, "18025-review.json"), "utf8"));
      const actual = (await pool.query("SELECT status,last_safe_step,external_case_ref FROM automation_runs WHERE id=$1", [row?.runId])).rows[0];
      const events = (await pool.query("SELECT step FROM run_events WHERE run_id=$1", [row?.runId])).rows;
      if (report.state !== "paused_for_review" || report.stopReason !== "REVIEW_ROW_18025_MANUAL_DATA_REQUIRED"
        || row?.status !== "failed" || actual?.status !== "failed" || actual.last_safe_step !== "compensa_start_intent" || actual.external_case_ref
        || evidence.runId !== row.runId || evidence.payerDialogConfirmed !== true || evidence.unaccepted !== true || evidence.noDraftOrSaveOrUfg !== true
        || events.filter(e => e.step === "compensa_start_intent").length !== 1
        || events.some(e => ["compensa_offer_draft_open", "compensa_insured_save_intent", "compensa_insured_data_saved", "ufg_verification_intent"].includes(e.step))) throw new Error("RANGE_CONTINUATION_NOT_RECONCILED");
      same(report.rows.filter(r => r.status === "not_started").map(r => r.rowNumber), [18026,18027,18028,18029,18030], "RANGE_REMAINING_SCOPE_MISMATCH");
      await fs.writeFile(path.join(DIRECTORY, "report-before-row25-continuation.json"), JSON.stringify(report, null, 2), { flag: "wx" });
      (report.reviewHistory ??= []).push({ rowNumber: 18025, at: new Date().toISOString(), outcome: "unaccepted_payer_dialog_no_draft_save_or_ufg_original_failure_preserved" });
      row.reason = "Compensa pokazała okno Ubezpieczający z pustym imieniem, nazwiskiem i kodem pocztowym. Nie zatwierdzono danych; brak draftu, zapisu i UFG. Pierwotny wynik zachowany.";
    } else if (continuing && companySelectorFix) {
      const row = report.rows.find(r => r.rowNumber === 18012);
      const events = (await pool.query("SELECT step FROM run_events WHERE run_id=$1", [row?.runId])).rows;
      const startupRecovery = report.revision === 4 && report.stopReason === "ACCEPTANCE_HTTP_500";
      if ((!startupRecovery && (report.revision !== 3 || report.stopReason !== "REVIEW_ROW_18012_MANUAL_DATA_REQUIRED")) || report.state !== "paused_for_review"
        || row?.status !== "failed" || row.errorCode !== "MANUAL_DATA_REQUIRED"
        || events.filter(e => e.step === "compensa_start_intent").length !== 1
        || events.filter(e => e.step === "compensa_offer_draft_open").length !== 1
        || events.some(e => ["compensa_insured_save_intent", "compensa_insured_data_saved", "ufg_verification_intent"].includes(e.step))) throw new Error("COMPANY_FIX_CONTINUATION_NOT_RECONCILED");
      same(report.rows.filter(r => r.status === "not_started").map(r => r.rowNumber), ROWS.slice(1), "COMPANY_FIX_REMAINING_SCOPE_MISMATCH");
      await fs.writeFile(path.join(DIRECTORY, startupRecovery ? "report-v4-startup-failure.json" : "report-revision-3.json"), JSON.stringify(report, null, 2), { flag: "wx" });
      if (!startupRecovery) report.revisions = [{ revision: 3, fingerprint: report.fingerprint }, { revision: 4, reason: "Company labels observed in the opened case; corrected whitespace-sensitive selectors. Existing 18012 case is not replayed." }];
      report.revision = 4;
      row.reason = "Firma poprawnie rozpoznana; otwarto jedną ofertę, bez zapisu i UFG. Zatrzymanie przez selektory REGON/Nazwa wrażliwe na białe znaki. Poprawiono selektory; istniejącej oferty nie ponowiono.";
    } else if (continuing && readOnlyContinuation) {
      const row = report.rows.find(r => r.rowNumber === 18018);
      const events = (await pool.query("SELECT step FROM run_events WHERE run_id=$1", [row?.runId])).rows;
      assertReadOnlyContinuation(report, events);
      (report.reviewHistory ??= []).push({ at: new Date().toISOString(), rowNumber: 18018, outcome: "reviewed_read_only_failure_no_compensa_intents_original_failure_preserved" });
      row.reason = "Everest pokazał brak wyników z identyfikatorem w treści; adapter nie rozpoznał komunikatu. Pierwotny błąd techniczny zachowany. Bez oferty ani UFG.";
      for (const r of report.rows) if (r.status === "not_started") r.allowReadOnlyFailureContinuation = true;
    } else if (continuing && afterFix) {
      const diagnostic = JSON.parse(await fs.readFile(path.join(DIRECTORY, "18017-identity-diagnostic.json"), "utf8"));
      const row = report.rows.find(r => r.rowNumber === 18017);
      const events = (await pool.query("SELECT step FROM run_events WHERE run_id=$1", [row?.runId])).rows;
      assertPostFixContinuation(report, diagnostic, events);
      await fs.writeFile(path.join(DIRECTORY, "report-revision-1.json"), JSON.stringify(report, null, 2), { flag: "wx" });
      report.revisions = [{ revision: 1, fingerprint: report.fingerprint }, { revision: 2, at: new Date().toISOString(), reason: "Removed Client 360 route as instructed; only unstarted rows 18018–18020." }];
      report.revision = 2;
      for (const r of report.rows) if (r.runId) r.revision = 1;
      row.reason = "Błędna ścieżka ustalania nazwiska przez Klient 360; timeout bez okna kart klienta. Bez rozpoczęcia oferty ani UFG. Pierwotny wynik zachowany.";
    } else if (continuing) {
      const diagnostic = JSON.parse(await fs.readFile(path.join(DIRECTORY, "18013-identity-diagnostic.json"), "utf8"));
      const row = report.rows.find(r => r.rowNumber === 18013);
      const events = (await pool.query("SELECT step FROM run_events WHERE run_id=$1", [row?.runId])).rows;
      assertReviewedContinuation(report, diagnostic, events);
      (report.reviewHistory ??= []).push({ at: new Date().toISOString(), rowNumber: 18013, outcome: "original_failure_preserved_continue_unstarted_rows_only", diagnostic: "18013-identity-diagnostic.json", noCompensaMutations: true });
      row.reason = "Błąd pierwszego wyszukania. Oddzielna diagnostyka odczytu wymaga kontroli dopasowania osoby; bez oferty i UFG. Pierwotny status zachowany.";
    }
    if (RETEST && !CLOSURE && !report) {
      const previous = JSON.parse(await fs.readFile(path.join(ORIGINAL_DIRECTORY, "report.json"), "utf8"));
      for (const number of ROWS) {
        const row = previous.rows.find(r => r.rowNumber === number);
        if (!row?.runId || row.status === "completed" || row.events.some(e => ["compensa_start_intent", "compensa_insured_save_intent", "ufg_verification_intent"].includes(e.step))) throw new Error("RETEST_REQUIRES_RECONCILIATION_OF_EXISTING_CASE");
      }
    }
    report ??= { scope: { from: ROWS[0], to: ROWS.at(-1), count: ROWS.length, rowNumbers: ROWS }, revision: RETEST ? 3 : 1, startedAt: new Date().toISOString(), rows: ROWS.map(rowNumber => ({ rowNumber, status: "not_started" })), ...(RETEST ? { previousReport: "../report.json", excluded: [{ rowNumber: 18010, reason: "previous_verified_export" }, { rowNumber: 18011, reason: "invalid_regon_confirmed_by_user" }, { rowNumber: 18016, reason: "previous_verified_export" }] } : {}) };
    if (CLOSURE) { report.revision = 5; report.previousReport = "../retest-v3/report.json"; report.mode = "new_attempts_preserving_unavailable_drafts"; }
    if (POLICY) report.mode = "verify_user_requested_payer_skip_no_save_or_ufg";
    assertScope(report.rows); report.state = "preparing"; delete report.stopReason; await saveReport(report);
    const input = continuing ? { bytes: await fs.readFile(path.join(DIRECTORY, "input.xlsx")) } : await prepareInput();
    if (continuing) input.parsed = await require("../apps/api/dist/features/imports/workbook.js").parseTransportWorkbook(input.bytes);
    assertScope(input.parsed);
    const cfgPath = environment.WORKER_PORTAL_CONFIG_PATH;
    await fs.writeFile(cfgPath, JSON.stringify(await buildAcceptancePortalConfig(), null, 2));
    await require("../apps/worker/dist/portals/shared/portal-runtime-config.js").loadPortalRuntimeConfig(cfgPath);
    const fingerprint = { input: sha(input.bytes), portalConfig: sha(await fs.readFile(cfgPath)) };
    for (const file of ["apps/worker/dist/application/worker-runtime.js", "apps/worker/dist/features/execution/live-run.js", "apps/worker/dist/portals/compensa/compensa-form.js", "apps/worker/dist/portals/pzu/everest-identity-provider.js", "apps/api/dist/features/results/export.js"]) fingerprint[file] = sha(await fs.readFile(path.join(ROOT, file)));
    if (continuing && !afterFix && !companySelectorFix) same(fingerprint, report.fingerprint, "CAMPAIGN_BUILD_CHANGED_NEW_REVISION_REQUIRED");
    report.fingerprint = fingerprint;
    if (afterFix) report.revisions[1].fingerprint = fingerprint;
    if (companySelectorFix) report.revisions[1].fingerprint = fingerprint;
    report.inputValidation = input.parsed.map(r => ({ rowNumber: r.rowNumber, issues: r.issues, hasRegon: Boolean(r.effectiveRegon), hasContactPerson: Boolean(r.decisionMakerName) }));
    if ((await pool.query(`SELECT count(*)::int AS n FROM automation_runs WHERE status IN (${ACTIVE})`)).rows[0].n) throw new Error("ACCEPTANCE_EXISTING_ACTIVE_RUN");
    if ((await pool.query("SELECT count(*)::int AS n FROM run_dispatch_outbox WHERE status IN ('pending','publishing','published')")).rows[0].n) throw new Error("ACCEPTANCE_PENDING_DISPATCH");
    const { Queue } = require("bullmq");
    const redis = new URL(environment.REDIS_URL);
    const queue = new Queue("oc-verification", { connection: { host: redis.hostname, port: Number(redis.port), username: decodeURIComponent(redis.username), password: decodeURIComponent(redis.password), db: Number(redis.pathname.slice(1) || 0) } });
    try { const counts = await queue.getJobCounts("wait", "active", "delayed", "prioritized", "waiting-children"); if (Object.values(counts).some(Boolean)) throw new Error("ACCEPTANCE_REDIS_QUEUE_NOT_EMPTY"); } finally { await queue.close(); }
    for (const port of Object.values(PORTS)) await assertPortAvailable(port);
    report.state = "prepared"; await saveReport(report);
    console.log(JSON.stringify({ event: "prepared", rows: ROWS, validation: report.inputValidation, directory: DIRECTORY }));
    if (args.includes("--prepare-only")) return;
    for (const key of ["PZU_LOGIN", "PZU_PASSWORD", "COMPENSA_LOGIN", "COMPENSA_PASSWORD"]) if (!environment[key]) throw new Error("ACCEPTANCE_PORTAL_CREDENTIALS_REQUIRED");
    await once("apps/api/dist/infrastructure/database/migrate.js", "migrations", { DATABASE_URL: environment.MIGRATOR_DATABASE_URL });
    await once("apps/api/dist/infrastructure/database/apply-runtime-grants.js", "grants", { DATABASE_URL: environment.MIGRATOR_DATABASE_URL });
    launch(path.join(ROOT, "apps/api/dist/import-parser-main.js"), "parser");
    const apiChild = launch(path.join(ROOT, "scripts/acceptance-api-diagnostics.cjs"), "api", { GOLDIS_ADMIN_USER: "", GOLDIS_ADMIN_PASSWORD: "" });
    let ready = false;
    for (let i = 0; i < 40 && apiChild.exitCode === null; i++) { try { ready = (await fetch(environment.GOLDIS_API_READY_URL, { signal: AbortSignal.timeout(1500) })).ok; } catch {} if (ready) break; await delay(1500); }
    if (!ready || apiChild.exitCode !== null) throw new Error("ACCEPTANCE_API_NOT_READY");
    launch(require.resolve("next/dist/bin/next"), "web", { NODE_ENV: "development" }, ["dev", "apps/web", "--hostname", "127.0.0.1", "--port", String(PORTS.web)]);
    await fs.writeFile(path.join(DIRECTORY, "processes.json"), JSON.stringify({ controller: process.pid, children: children.map(c => c.pid), ports: PORTS }, null, 2));
    let cookie = "", csrf = "";
    api = async (route, body, method = "POST", binary = false) => {
      const multipart = body instanceof FormData;
      const response = await fetch(environment.API_INTERNAL_URL + "/api" + route, { method, headers: { origin: environment.PUBLIC_APP_ORIGIN, cookie, "x-csrf-token": csrf, ...(body !== undefined && !multipart ? { "content-type": "application/json" } : {}) }, ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
      if (!response.ok) { let code; try { const data = await response.json(); code = data.errorCode || data.message; } catch {} if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{1,90}$/.test(code)) code = "HTTP_" + response.status; throw new Error("ACCEPTANCE_" + code); }
      if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(v => v.split(";")[0]).join("; ");
      if (binary) return Buffer.from(await response.arrayBuffer());
      const text = await response.text(), value = text ? JSON.parse(text) : null;
      if (value?.csrfToken) csrf = value.csrfToken;
      return value;
    };
    const auth = await api("/auth/login", { username: environment.GOLDIS_ADMIN_USER, password: environment.GOLDIS_ADMIN_PASSWORD });
    if (auth.mustChangePassword) throw new Error("ACCEPTANCE_PASSWORD_CHANGE_REQUIRED");
    if (!report.batchId) {
      const form = new FormData(); form.append("file", new Blob([input.bytes]), RANGE ? "odbior-18020-18030.xlsx" : "odbior-18010-18020.xlsx");
      const imported = await api("/imports", form);
      if (imported.totalRows !== ROWS.length) throw new Error("ACCEPTANCE_IMPORTED_SCOPE_MISMATCH");
      report.batchId = imported.id; await saveReport(report);
    }
    if (!report.preparationId) {
      const prepared = await api(`/imports/${report.batchId}/preparations`, { idempotencyKey: "acceptance-18010-18020-" + report.batchId });
      report.preparationId = prepared.preparationId; await saveReport(report);
    }
    let preparation;
    for (let i = 0; i < 100; i++) { preparation = await api(`/imports/${report.batchId}/preparations/${report.preparationId}`, undefined, "GET"); if (["completed", "completed_with_attention", "failed", "cancelled"].includes(preparation.status)) break; await delay(2000); }
    if (!["completed", "completed_with_attention"].includes(preparation.status)) throw new Error("ACCEPTANCE_PREPARATION_NOT_READY");
    const rows = (await pool.query("SELECT row_number,status,reason_code,representative_row_number FROM import_prepared_rows WHERE preparation_id=$1 ORDER BY row_number", [report.preparationId])).rows;
    assertScope(rows.map(r => r.row_number));
    for (const p of rows) if (p.status !== "ready") {
      const row = report.rows.find(r => r.rowNumber === p.row_number);
      if (row.status === "not_started") Object.assign(row, { status: p.status === "duplicate" ? "duplicate" : "input_review", errorCode: p.reason_code, reason: p.status === "duplicate" ? `Duplikat wiersza ${p.representative_row_number}; bez ponownego zapytania.` : explain(p.reason_code) });
    }
    await fs.mkdir(environment.WORKER_STAGING_DIR, { recursive: true });
    Object.assign(process.env, environment, { DATABASE_URL: environment.WORKER_DATABASE_URL, REDIS_URL: environment.WORKER_REDIS_URL, WORKER_LIVE_PORTALS: "1", WORKER_STAGING_DIR: await fs.realpath(environment.WORKER_STAGING_DIR) });
    delete process.env.WORKER_PZU_LOGIN_TEST_RUN_ID;
    for (const [modulePath, className, method] of [
      ["portals/pzu/everest-identity-provider", "EverestIdentityProvider", "findIdentity"],
      ["portals/compensa/compensa-form", "CompensaFormAssistant", "prepareInsuredForm"],
    ]) {
      const type = require(path.join(ROOT, "apps/worker/dist", modulePath + ".js"))[className];
      const original = type.prototype[method];
      type.prototype[method] = async function (...values) {
        const row = report.rows.find(r => r.rowNumber === values[0]?.source?.rowNumber);
        try {
          const result = await original.apply(this, values);
          if (POLICY && method === "prepareInsuredForm" && result.kind === "ready_to_save") throw new Error("SKIP_POLICY_UNEXPECTED_READY_FORM");
          if ((CLOSURE || RANGE || POLICY) && method === "prepareInsuredForm" && !["ready_to_save", "waiting_for_sms"].includes(result.kind) && runtime) {
            const page = await runtime.browser.page("compensa");
            await page.screenshot({ path: path.join(DIRECTORY, `${row.rowNumber}-form-outcome.png`), fullPage: true });
            await fs.writeFile(path.join(DIRECTORY, `${row.rowNumber}-form-outcome-private.html`), await page.content());
            const body = await page.locator("body").innerText();
            await fs.writeFile(path.join(DIRECTORY, `${row.rowNumber}-form-outcome-private.txt`), body);
            if (body.includes("Dane Klienta są niekompletne.")) {
              const selectors = runtime.liveConfig.compensa.form;
              row.portalEvidence = { incompleteCustomer: true,
                postalDisabled: await page.locator(selectors.postalCodeInput).isDisabled().catch(() => false),
                countyDisabled: await page.locator(selectors.countyInput).isDisabled().catch(() => false) };
            }
          }
          if (row) { (row.diagnostics ??= []).push({ stage: method, kind: result.kind, reason: result.reason, fieldCode: result.fieldCode, errorCode: result.errorCode, candidateCount: result.candidateCount, matchMethod: result.identity?.matchMethod }); await saveReport(report); }
          return result;
        } catch (error) { if (row) { (row.diagnostics ??= []).push({ stage: method, errorCode: safeCode(error) }); await saveReport(report); } throw error; }
      };
    }
    runtime = await require("../apps/worker/dist/run-worker.js").startRunWorker({ startPaused: true });
    const browser = await runtime.browser.open();
    browser.on("response", response => { if (response.status() !== 429) return; const origin = new URL(response.url()).origin; if ([...runtime.liveConfig.pzu.allowedOrigins, ...runtime.liveConfig.compensa.allowedOrigins].includes(origin)) { stopping = true; report.stopReason = "PORTAL_HTTP_429"; } });
    report.state = "running"; await saveReport(report); await runtime.worker.resume();
    for (const row of report.rows) {
      if (row.status !== "not_started") continue;
      if (stopping || syncFs.existsSync(path.join(DIRECTORY, "PAUSE"))) break;
      const run = await api("/runs", { batchId: report.batchId, rowNumber: row.rowNumber });
      Object.assign(row, { runId: run.id, status: run.status, revision: report.revision ?? 1, startedAt: new Date().toISOString() }); await saveReport(report);
      let last = "";
      const deadline = Date.now() + 12 * 60000;
      while (Date.now() < deadline && !stopping) {
        const current = await api(`/runs/${run.id}`, undefined, "GET");
        Object.assign(row, { status: current.status, currentStep: current.currentStep, errorCode: current.errorCode, controlState: current.controlState });
        const stage = JSON.stringify([row.status, row.currentStep, row.errorCode]);
        if (last !== stage) { last = stage; await saveReport(report); console.log(JSON.stringify({ rowNumber: row.rowNumber, status: row.status, step: row.currentStep, errorCode: row.errorCode })); }
        if (TERMINAL.has(row.status)) break;
        await delay(5000);
      }
      await runtime.worker.pause();
      const events = (await pool.query("SELECT status,step,error_code,created_at FROM run_events WHERE run_id=$1 ORDER BY created_at,id", [run.id])).rows;
      row.events = events; const diagnostic = row.diagnostics?.filter(d => d.fieldCode || d.reason).at(-1);
      row.reason = explain(diagnostic?.fieldCode || row.errorCode) + (diagnostic?.reason ? ` Szczegół: ${diagnostic.reason}.` : "");
      if (isBlockedCompensaCustomer(row, events)) row.reason = "Compensa: Dane Klienta są niekompletne. Kod pocztowy i powiat są zablokowane; bez zapisu i UFG.";
      if (row.status === "completed" || row.status === "no_matching_policies") {
        const frozen = (await pool.query("SELECT input_snapshot,reference_date::text AS reference_date FROM automation_runs WHERE id=$1", [run.id])).rows[0];
        const snapshot = (await pool.query("SELECT total_count FROM oc_snapshots WHERE run_id=$1", [run.id])).rows[0];
        const all = (await pool.query("SELECT *,coverage_from::text AS coverage_from,coverage_to::text AS coverage_to FROM oc_policies WHERE run_id=$1 ORDER BY source_ordinal", [run.id])).rows;
        if (!snapshot || snapshot.total_count !== all.length) throw new Error("SNAPSHOT_COUNT_MISMATCH");
        const selected = all.filter(p => p.coverage_to >= frozen.reference_date);
        Object.assign(row, { totalOcCount: all.length, exportedPolicyCount: selected.length, referenceDate: frozen.reference_date });
        for (const step of ["compensa_start_intent", "compensa_offer_draft_open", "compensa_insured_data_saved", "ufg_verification_intent"]) if (events.filter(e => e.step === step).length !== 1) throw new Error("PORTAL_ACTION_COUNT_MISMATCH");
        if (row.status === "no_matching_policies") { if (selected.length) throw new Error("NO_POLICIES_OUTCOME_MISMATCH"); row.reason = "Pełny odczyt UFG; brak polis spełniających filtr daty."; }
        else {
          const identity = (await pool.query("SELECT source_row_id,pesel_ciphertext,pesel_key_version,match_method FROM run_identities WHERE run_id=$1", [run.id])).rows[0];
          const pesel = require("@goldis/core").decryptIdentityPesel({ matchMethod: identity.match_method, peselCiphertext: identity.pesel_ciphertext, peselKeyVersion: identity.pesel_key_version }, { runId: run.id, sourceRowId: identity.source_row_id });
          const bytes = await api(`/runs/${run.id}/artifact`, undefined, "GET", true);
          const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
          verifyWorkbook(workbook.getWorksheet("Wynik OC"), frozen, pesel, selected);
          row.artifactFile = `wynik-${row.rowNumber}.xlsx`; await fs.writeFile(path.join(DIRECTORY, row.artifactFile), bytes);
          row.artifactVerified = true; row.reason = "Pełny przebieg; pobrany XLSX porównany z tożsamością i każdą polisą.";
        }
      }
      row.finishedAt = new Date().toISOString(); row.durationSeconds = Math.round((Date.parse(row.finishedAt) - Date.parse(row.startedAt)) / 1000);
      if (requiresStop(row, events)) { report.stopReason = "REVIEW_ROW_" + row.rowNumber + "_" + (row.errorCode || row.status); stopping = true; }
      if (!TERMINAL.has(row.status)) { report.stopReason = "ROW_TIMEOUT_OR_UNFINISHED"; stopping = true; }
      if (stopping) for (const portal of ["pzu", "compensa"]) {
        const page = await runtime.browser.page(portal);
        await page.screenshot({ path: path.join(DIRECTORY, `${row.rowNumber}-${portal}.png`) }).catch(() => {});
        await fs.writeFile(path.join(DIRECTORY, `${row.rowNumber}-${portal}-private.html`), await page.content()).catch(() => {});
      }
      await saveReport(report);
      if (!stopping) { await delay(3000); await runtime.worker.resume(); }
    }
    report.state = report.stopReason ? "paused_for_review" : report.rows.some(r => r.status === "not_started") ? "paused" : report.rows.some(r => !["completed", "no_matching_policies"].includes(r.status)) ? "finished_with_findings" : "finished";
  } catch (error) {
    if (report) { report.state = "paused_for_review"; report.stopReason = safeCode(error); }
    console.error(safeCode(error)); process.exitCode = 1;
  } finally {
    if (runtime) await runtime.shutdown();
    if (api) await api("/auth/logout", {}).catch(() => {});
    if (pool) await pool.end();
    if (report && !servingOnly) { await saveReport(report); console.log(JSON.stringify({ event: "report_saved", state: report.state, summary: report.summary, stopReason: report.stopReason })); }
    if (args.includes("--serve-after") && children.some(c => c.exitCode === null)) {
      console.log("ACCEPTANCE_UI_AVAILABLE_3100_UNTIL_STOP_FILE");
      while (!syncFs.existsSync(path.join(DIRECTORY, "STOP"))) await delay(1500);
    }
    for (const child of children) if (child.exitCode === null) child.kill();
    await lock.close(); await fs.unlink(path.join(DIRECTORY, "runner.lock"));
  }
}

module.exports = { ROWS, PORTS, DIRECTORY, parseEnv, campaignEnvironment, assertScope, verifyWorkbook, requiresStop, isBlockedCompensaCustomer, assertReviewedContinuation, assertPostFixContinuation, assertReadOnlyContinuation, main };
if (require.main === module) main().catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
