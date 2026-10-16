"use strict";

// Explicit five-row acceptance: current API, real queue, production worker and portals.
// Private input, downloads, credentials and logs stay in ignored local paths.
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const ExcelJS = require("exceljs");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const directory = path.join(root, "exports/live-acceptance");
const envPath = path.join(root, ".env.acceptance.local");
const attempt = process.argv.find(value => /^--attempt-[2-9][0-9]*$/.test(value));
const suffix = attempt ? `-v${attempt.slice("--attempt-".length)}` : "";
const contextPath = path.join(directory, `context-five-full-20261015${suffix}.json`);
const reportPath = path.join(directory, `five-full-20261015${suffix}.json`);
const rowNumbers = process.argv.includes("--rows-5") ? [18005] : process.argv.includes("--rows-4-5") ? [18004, 18005] : [18001, 18002, 18003, 18004, 18005];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function parseEnv(text) { return Object.fromEntries(text.split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^['"]|['"]$/g, "")])); }
const safeCode = error => /^[A-Z][A-Z0-9_]+$/.test(error?.message || "") ? error.message : "FIVE_ROW_ACCEPTANCE_FAILED";

async function main() {
  const env = { ...process.env, ...parseEnv(await fs.readFile(envPath, "utf8")), APP_ENV: "development", NODE_ENV: "development" };
  if (env.COMPOSE_PROJECT_NAME !== "goldis-acceptance-20261015") throw new Error("ISOLATED_ACCEPTANCE_PROJECT_REQUIRED");
  env.GOLDIS_DELETION_JOURNAL_DIR = path.join(directory, "isolated-runtime/deletion-journal");
  const report = { startedAt: new Date().toISOString(), rowNumbers, project: env.COMPOSE_PROJECT_NAME,
    mode: "api-production-queue-full-live-flow", http429: [], portalDiagnostics: [], runs: [], complete: false };
  const children = [];
  let runtime;
  let verificationPool;
  let api;
  const child = (file, label, overrides = {}) => {
    const log = syncFs.openSync(path.join(directory, `five-full-${label}.log`), "a");
    const process = spawn(global.process.execPath, [path.join(root, file)], {
      cwd: root, env: { ...env, ...overrides }, windowsHide: true, stdio: ["ignore", log, log],
    });
    syncFs.closeSync(log);
    children.push(process);
    return process;
  };
  const oneShot = async (file, label, overrides) => {
    const process = child(file, label, overrides);
    await new Promise((resolve, reject) => {
      process.once("error", () => reject(new Error("ACCEPTANCE_CHILD_START_FAILED")));
      process.once("exit", code => code === 0 ? resolve() : reject(new Error(`ACCEPTANCE_${label.toUpperCase().replace(/-/g, "_")}_FAILED`)));
    });
    console.log(JSON.stringify({ startupStage: label, ok: true }));
  };
  try {
    try {
      const previous = JSON.parse(await fs.readFile(reportPath, "utf8"));
      report.portalDiagnostics = previous.portalDiagnostics || [];
      report.http429 = previous.http429 || [];
      report.startedAt = previous.startedAt || report.startedAt;
      report.recheckedAt = new Date().toISOString();
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await oneShot("apps/api/dist/infrastructure/database/migrate.js", "migrations", { DATABASE_URL: env.MIGRATOR_DATABASE_URL });
    await oneShot("apps/api/dist/infrastructure/database/apply-runtime-grants.js", "grants", { DATABASE_URL: env.MIGRATOR_DATABASE_URL });
    await oneShot("apps/api/dist/processes/bootstrap-admin/composition/main.js", "bootstrap", { DATABASE_URL: env.MIGRATOR_DATABASE_URL });
    child("apps/api/dist/import-parser-main.js", "parser");
    await delay(1000);
    const apiProcess = child("scripts/acceptance-api-diagnostics.cjs", "api", { GOLDIS_ADMIN_PASSWORD: "", GOLDIS_ADMIN_USER: "" });
    const deadline = Date.now() + 90000;
    let ready = false;
    let readyStatus;
    while (Date.now() < deadline && apiProcess.exitCode === null) {
      try {
        const response = await fetch("http://127.0.0.1:3001/api/health/ready", { signal: AbortSignal.timeout(2000) });
        ready = response.ok;
        if (readyStatus !== response.status) { readyStatus = response.status; console.log(JSON.stringify({ apiReadinessStatus: readyStatus })); }
      } catch {}
      if (ready) break;
      await delay(3000);
    }
    if (!ready) throw new Error("ACCEPTANCE_API_NOT_READY");
    let cookie = "", csrf = "";
    api = async (route, body, method = "POST", binary = false) => {
      const multipart = body instanceof FormData;
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch("http://127.0.0.1:3001/api" + route, {
        method, headers: { origin: env.PUBLIC_APP_ORIGIN, cookie, "x-csrf-token": csrf,
          ...(body !== undefined && !multipart ? { "content-type": "application/json" } : {}) },
        ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
      });
      if (response.status !== 429 || method !== "GET" || attempt === 2) break;
      console.log("LOCAL_API_POLL_THROTTLED_WAITING_RETRY_AFTER");
      await delay(Math.min(60000, Math.max(1000, Number(response.headers.get("retry-after") || 10) * 1000)));
      }
      if (!response.ok) { console.error(JSON.stringify({ failedRoute: route, status: response.status })); throw new Error(`ACCEPTANCE_HTTP_${response.status}`); }
      if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      if (binary) return Buffer.from(await response.arrayBuffer());
      const text = await response.text();
      const result = text ? JSON.parse(text) : null;
      if (result?.csrfToken) csrf = result.csrfToken;
      return result;
    };
    const auth = await api("/auth/login", { username: env.GOLDIS_ADMIN_USER, password: env.GOLDIS_ADMIN_PASSWORD });
    if (auth.mustChangePassword) {
      const nextPassword = randomBytes(32).toString("hex");
      await api("/auth/change-password", { currentPassword: env.GOLDIS_ADMIN_PASSWORD, newPassword: nextPassword });
      const text = await fs.readFile(envPath, "utf8");
      await fs.writeFile(envPath, text.replace(/^GOLDIS_ADMIN_PASSWORD=.*$/m, () => "GOLDIS_ADMIN_PASSWORD=" + nextPassword));
    }
    let saved;
    try { saved = JSON.parse(await fs.readFile(contextPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (saved && JSON.stringify(saved.rowNumbers) !== JSON.stringify(rowNumbers)) throw new Error("ACCEPTANCE_CONTEXT_SCOPE_INVALID");
    if (!saved) {
      const original = new ExcelJS.Workbook();
      await original.xlsx.readFile(path.join(root, "docs/BAZA TRANSPORTOWA.xlsx"));
      const sheet = original.getWorksheet("Realizacja");
      const input = new ExcelJS.Workbook();
      const target = input.addWorksheet("Realizacja");
      for (const number of [1, ...rowNumbers]) sheet.getRow(number).eachCell((cell, col) => {
        target.getRow(number).getCell(col).value = structuredClone(cell.value);
      });
      const bytes = Buffer.from(await input.xlsx.writeBuffer());
      const { parseTransportWorkbook } = require("../apps/api/dist/features/imports/workbook.js");
      const parsed = await parseTransportWorkbook(bytes);
      assert.deepEqual(parsed.map(row => row.rowNumber), rowNumbers);
      assert.ok(parsed.every(row => !row.issues.length && row.effectiveRegon));
      const form = new FormData();
      form.append("file", new Blob([bytes]), "input-18001-18005.xlsx");
      const imported = await api("/imports", form);
      assert.equal(imported.totalRows, rowNumbers.length); assert.equal(imported.invalidRows, 0);
      saved = { rowNumbers, batchId: imported.id, runs: [] };
      await fs.writeFile(contextPath, JSON.stringify(saved, null, 2));
    }
    if (!saved.preparationId) {
      const prepared = await api(`/imports/${saved.batchId}/preparations`, { idempotencyKey: `five-full-${saved.batchId}` });
      saved.preparationId = prepared.preparationId;
      await fs.writeFile(contextPath, JSON.stringify(saved, null, 2));
    }
    let prepared;
    for (let attempt = 0; attempt < 90; attempt++) {
      prepared = await api(`/imports/${saved.batchId}/preparations/${saved.preparationId}`, undefined, "GET");
      if (["completed", "failed", "cancelled"].includes(prepared.status)) break;
      await delay(1000);
    }
    console.log(JSON.stringify({ preparation: prepared.status, counts: prepared.counts }));
    if (prepared.status !== "completed") throw new Error("ACCEPTANCE_PREPARATION_NOT_READY");
    await fs.mkdir(env.WORKER_STAGING_DIR, { recursive: true });
    Object.assign(process.env, env, { DATABASE_URL: env.WORKER_DATABASE_URL, REDIS_URL: env.WORKER_REDIS_URL,
      WORKER_LIVE_PORTALS: "1", WORKER_STAGING_DIR: await fs.realpath(env.WORKER_STAGING_DIR) });
    const { EverestIdentityProvider } = require("../apps/worker/dist/portals/pzu/everest-identity-provider.js");
    const findIdentity = EverestIdentityProvider.prototype.findIdentity;
    EverestIdentityProvider.prototype.findIdentity = async function (input) {
      try {
        const result = await findIdentity.call(this, input);
        const diagnostic = { rowNumber: input.source.rowNumber, portal: "pzu", kind: result.kind, reason: result.reason };
        report.portalDiagnostics.push(diagnostic); console.log(JSON.stringify(diagnostic));
        return result;
      } catch (error) {
        const diagnostic = { rowNumber: input.source.rowNumber, portal: "pzu", errorCode: safeCode(error) };
        report.portalDiagnostics.push(diagnostic); console.log(JSON.stringify(diagnostic));
        const page = await this.browser.page("pzu");
        await page.screenshot({ path: path.join(directory, `full-pzu-${input.source.rowNumber}-failure.png`) }).catch(() => {});
        throw error;
      }
    };
    const { CompensaFormAssistant } = require("../apps/worker/dist/portals/compensa/compensa-form.js");
    const prepareInsuredForm = CompensaFormAssistant.prototype.prepareInsuredForm;
    CompensaFormAssistant.prototype.prepareInsuredForm = async function (...args) {
      const result = await prepareInsuredForm.apply(this, args);
      const diagnostic = { rowNumber: args[0].source.rowNumber, portal: "compensa", preparation: result.kind, fieldCode: result.fieldCode, errorCode: result.errorCode };
      report.portalDiagnostics.push(diagnostic); console.log(JSON.stringify(diagnostic));
      if (result.kind !== "ready_to_save" && result.kind !== "waiting_for_sms") {
        const page = await this.browser.page("compensa");
        await page.screenshot({ path: path.join(directory, `full-compensa-${args[0].source.rowNumber}-failure.png`) }).catch(() => {});
      }
      return result;
    };
    const { CompensaClientChoice } = require("../apps/worker/dist/portals/compensa/compensa-client-choice.js");
    const selectIfVisible = CompensaClientChoice.prototype.selectIfVisible;
    CompensaClientChoice.prototype.selectIfVisible = async function (...args) {
      const selected = await selectIfVisible.apply(this, args);
      if (selected !== "absent") { const diagnostic = { portal: "compensa", businessCardChoice: selected };
        report.portalDiagnostics.push(diagnostic); console.log(JSON.stringify(diagnostic)); }
      return selected;
    };
    const resolvePersonName = CompensaClientChoice.prototype.resolvePersonName;
    CompensaClientChoice.prototype.resolvePersonName = async function (...args) {
      const name = await resolvePersonName.apply(this, args);
      const diagnostic = { portal: "compensa", businessPersonNameResolved: Boolean(name) };
      report.portalDiagnostics.push(diagnostic); console.log(JSON.stringify(diagnostic));
      return name;
    };
    const { startRunWorker } = require("../apps/worker/dist/run-worker.js");
    runtime = await startRunWorker({ startPaused: true });
    const browserContext = await runtime.browser.open();
    browserContext.on("response", response => {
      if (response.status() !== 429) return;
      const host = new URL(response.url()).hostname;
      if (!runtime.liveConfig.pzu.allowedOrigins.concat(runtime.liveConfig.compensa.allowedOrigins).some(origin => new URL(origin).hostname === host)) return;
      report.http429.push({ at: new Date().toISOString(), host, resourceType: response.request().resourceType() });
      console.log("LIVE_PORTAL_HTTP_429_QUEUE_PAUSED");
      void runtime.worker.pause(true);
    });
    for (const rowNumber of rowNumbers) {
      if (saved.runs.some(run => run.rowNumber === rowNumber)) continue;
      const run = await api("/runs", { batchId: saved.batchId, rowNumber });
      saved.runs.push({ rowNumber, runId: run.id, referenceDate: run.referenceDate });
      await fs.writeFile(contextPath, JSON.stringify(saved, null, 2));
    }
    const active = (await runtime.pool.query("SELECT id,row_number,batch_id FROM automation_runs WHERE status IN ('queued','validating','awaiting_portal_adapter','pzu_login','everest_search','compensa_login','compensa_form','ufg_verification','reading_oc','export_ready')")).rows;
    if (active.some(run => run.batch_id !== saved.batchId || !saved.runs.some(target => target.runId === run.id && target.rowNumber === run.row_number))) throw new Error("ACCEPTANCE_UNEXPECTED_ACTIVE_RUN");
    await runtime.worker.resume();
    console.log(JSON.stringify({ fullFlowStarted: true, runs: saved.runs }));
    const last = new Map();
    const terminal = ["completed", "failed", "no_matching_policies", "cancelled", "identity_review", "waiting_for_manual_data"];
    const finishDeadline = Date.now() + 8 * 60000;
    while (Date.now() < finishDeadline) {
      report.runs = [];
      for (const target of saved.runs) {
        const run = await api(`/runs/${target.runId}`, undefined, "GET");
        const value = { ...target, status: run.status, currentStep: run.currentStep, errorCode: run.errorCode,
          incident: run.incident ? { kind: run.incident.kind, portal: run.incident.portal, reasonCode: run.incident.reasonCode } : null };
        report.runs.push(value);
        const key = JSON.stringify(value);
        if (last.get(target.runId) !== key) { console.log(key); last.set(target.runId, key); }
      }
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
      if (report.http429.length || report.runs.every(run => terminal.includes(run.status))) break;
      await delay(5000);
    }
    await runtime.worker.pause();
    const { PgRunRepository } = require("../apps/worker/dist/infrastructure/database/pg-run-repository.js");
    const { Pool } = require("pg");
    verificationPool = new Pool({ connectionString: env.DATABASE_URL });
    const repository = new PgRunRepository(verificationPool);
    const literal = value => /^[=+\-@]/.test(value || "") ? "'" + value : value ?? "";
    for (const item of report.runs) {
      const events = (await verificationPool.query("SELECT step,error_code FROM run_events WHERE run_id=$1 ORDER BY created_at", [item.runId])).rows;
      item.steps = events.map(event => ({ step: event.step, errorCode: event.error_code }));
      if (item.status !== "completed") continue;
      const run = await repository.load(item.runId);
      const policies = (await verificationPool.query("SELECT *,coverage_from::text AS coverage_from,coverage_to::text AS coverage_to FROM oc_policies WHERE run_id=$1 ORDER BY source_ordinal", [item.runId])).rows;
      const header = (await verificationPool.query("SELECT total_count FROM oc_snapshots WHERE run_id=$1", [item.runId])).rows[0];
      const frozen = (await verificationPool.query("SELECT input_snapshot FROM automation_runs WHERE id=$1", [item.runId])).rows[0].input_snapshot;
      assert.equal(header.total_count, policies.length);
      const selected = policies.filter(policy => policy.coverage_to >= item.referenceDate);
      const bytes = await api(`/runs/${item.runId}/artifact`, undefined, "GET", true);
      await fs.writeFile(path.join(directory, `result-${item.runId}.xlsx`), bytes);
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
      const sheet = workbook.getWorksheet("Wynik OC"); assert.ok(sheet);
      assert.equal(sheet.rowCount, selected.length + 5);
      assert.deepEqual(sheet.getRow(2).values.slice(1), [frozen.companyName, frozen.effectiveRegon,
        frozen.decisionMakerName, frozen.mobile, frozen.phone, frozen.email, run.identity.pesel].map(literal));
      selected.forEach((policy, index) => assert.deepEqual(sheet.getRow(index + 6).values.slice(1), [
        index + 1, literal(policy.insured_name), literal(policy.policy_type_and_number), literal(policy.contract_type),
        policy.insured_claim_count, literal(policy.vehicle_registration), literal(policy.vehicle_group), literal(policy.vehicle_make),
        literal(policy.vehicle_model), literal(policy.insurer), policy.coverage_from || "", policy.coverage_to,
      ]));
      for (const step of ["compensa_offer_draft_open", "compensa_insured_data_saved", "ufg_verification_intent"]) assert.equal(events.filter(event => event.step === step).length, 1);
      Object.assign(item, { totalOcCount: policies.length, exportedPolicyCount: selected.length, artifactMatchesPersistedData: true, singleDraftSaveAndUfg: true });
      console.log(JSON.stringify({ rowNumber: item.rowNumber, artifactVerified: true, totalOcCount: policies.length, exportedPolicyCount: selected.length }));
    }
    report.complete = report.runs.length === rowNumbers.length && report.runs.every(run => terminal.includes(run.status));
  } catch (error) {
    report.errorCode = safeCode(error);
    console.error(report.errorCode);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    if (runtime) await runtime.shutdown();
    if (verificationPool) await verificationPool.end();
    if (api) await api("/auth/logout", {}).catch(() => {});
    for (const process of children) if (process.exitCode === null) process.kill();
    console.log(JSON.stringify({ reportSaved: true, completed: report.complete, http429Count: report.http429.length }));
  }
}
main().catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
