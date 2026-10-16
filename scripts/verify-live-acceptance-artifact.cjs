"use strict";
// Compare a downloaded live artifact with persisted input and every selected
// policy cell. Print only counts/status; never print identities or cell values.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Pool } = require("pg");
const ExcelJS = require("exceljs");
const { PgRunRepository } = require("../apps/worker/dist/infrastructure/database/pg-run-repository.js");

async function main() {
  const name = process.env.ACCEPTANCE_CONTEXT_FILE;
  if (!name || !/^context-[a-z0-9-]+\.json$/.test(name)) throw new Error("CONTEXT_REQUIRED");
  const directory = path.resolve(__dirname, "../exports/live-acceptance");
  const context = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
  const inspect = suffix => JSON.parse(execFileSync("docker", ["inspect", `goldis-automatyzacje-${suffix}-1`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
  const env = Object.fromEntries(inspect("worker").Config.Env.map(item => { const i = item.indexOf("="); return [item.slice(0, i), item.slice(i + 1)]; }));
  for (const key of ["PESEL_ENCRYPTION_ACTIVE_KEY_VERSION", "PESEL_ENCRYPTION_KEYS_BASE64"]) process.env[key] = env[key];
  const url = new URL(env.DATABASE_URL);
  url.hostname = "127.0.0.1";
  url.port = inspect("postgres").NetworkSettings.Ports["5432/tcp"].find(item => item.HostIp === "127.0.0.1").HostPort;
  const pool = new Pool({ connectionString: url.toString() });
  const requireCheck = condition => { if (!condition) throw new Error("ARTIFACT_COMPARISON_FAILED"); };
  const literal = value => { const text = value ?? ""; return /^[=+\-@]/.test(text) ? "'" + text : text; };
  try {
    if (Array.isArray(context.runs)) {
      requireCheck(JSON.stringify(context.rowNumbers) === "[18001,18002]" && context.runs.length === 2);
      const runs = await Promise.all(context.runs.map(item => new PgRunRepository(pool).load(item.runId)));
      requireCheck(runs.every((run, index) => run?.source.rowNumber === context.rowNumbers[index] && run.run.batchId === context.batchId));
      requireCheck(runs[0].source.effectiveRegon !== runs[1].source.effectiveRegon);
      const firstId = context.runs[0].runId, secondId = context.runs[1].runId;
      const firstCompleted = (await pool.query("SELECT created_at FROM run_events WHERE run_id=$1 AND status='completed' ORDER BY created_at LIMIT 1", [firstId])).rows[0];
      const secondStarted = (await pool.query("SELECT created_at FROM run_events WHERE run_id=$1 AND status='everest_search' ORDER BY created_at LIMIT 1", [secondId])).rows[0];
      requireCheck(firstCompleted && secondStarted && firstCompleted.created_at <= secondStarted.created_at);
      const second = (await pool.query("SELECT external_case_ref FROM automation_runs WHERE id=$1", [secondId])).rows[0];
      const secondCompensaEvents = Number((await pool.query("SELECT count(*) AS count FROM run_events WHERE run_id=$1 AND step IN ('compensa_start_intent','compensa_offer_draft_open','compensa_insured_data_saved','ufg_verification_intent')", [secondId])).rows[0].count);
      requireCheck(runs[0].status === "completed" && runs[1].status === "identity_review" && !runs[1].identity && !second.external_case_ref && secondCompensaEvents === 0);
      const report = { batchId: context.batchId, sequentialExecutionConfirmed: true, distinctSourceIdentifiers: true,
        runs: context.runs.map((item, index) => ({ rowNumber: item.rowNumber, runId: item.runId, status: runs[index].status })),
        secondRowHasNoPersistedIdentityOrCompensaCase: true };
      await fs.writeFile(path.join(directory, "verification-pair-20261010.json"), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      return;
    }
    const run = await new PgRunRepository(pool).load(context.runId);
    requireCheck(run?.status === "completed" && run.identity && [18001,18002].includes(context.rowNumber) && run.source.rowNumber === context.rowNumber);
    const snapshot = (await pool.query("SELECT total_count FROM oc_snapshots WHERE run_id=$1", [context.runId])).rows[0];
    const policies = (await pool.query("SELECT *, coverage_from::text AS coverage_from, coverage_to::text AS coverage_to FROM oc_policies WHERE run_id=$1 ORDER BY source_ordinal", [context.runId])).rows;
    requireCheck(snapshot && snapshot.total_count === policies.length);
    const selected = policies.filter(policy => policy.coverage_to >= run.run.referenceDate);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(directory, `result-${context.runId}.xlsx`));
    const sheet = workbook.getWorksheet("Polisy OC");
    requireCheck(sheet && sheet.rowCount === selected.length + 1 && sheet.columnCount === 15);
    selected.forEach((policy, index) => {
      const expected = [literal(run.source.effectiveRegon), literal(run.source.companyName), literal(run.identity.pesel),
        policy.source_ordinal, literal(policy.insured_name), literal(policy.policy_type_and_number), literal(policy.contract_type),
        policy.insured_claim_count, literal(policy.vehicle_registration), literal(policy.vehicle_group), literal(policy.vehicle_make),
        literal(policy.vehicle_model), literal(policy.insurer), policy.coverage_from ?? "", policy.coverage_to];
      expected.forEach((value, column) => {
        if ((sheet.getRow(index + 2).getCell(column + 1).value ?? "") !== (value ?? "")) throw new Error(`CELL_ROW_${index + 2}_COLUMN_${column + 1}_MISMATCH`);
      });
    });
    const events = (await pool.query("SELECT step FROM run_events WHERE run_id=$1", [context.runId])).rows;
    const count = step => events.filter(event => event.step === step).length;
    requireCheck(count("compensa_offer_draft_open") === 1 && count("compensa_insured_data_saved") === 1 && count("ufg_verification_intent") === 1);
    const smsCount = Number((await pool.query("SELECT count(*) AS count FROM auth_challenges WHERE run_id=$1", [context.runId])).rows[0].count);
    console.log(JSON.stringify({ runId: context.runId, status: run.status, totalOcCount: policies.length, exportedPolicyCount: selected.length,
      columnsCompared: 15, artifactMatchesPersistedData: true, singleDraftSaveAndUfg: true, smsChallengeCount: smsCount, referenceDate: run.run.referenceDate }));
  } finally { await pool.end(); }
}
main().catch(error => { console.error("LIVE_ARTIFACT_VERIFICATION_FAILED", /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "UNEXPECTED_ERROR", /^[0-9A-Z]{5}$/.test(error.code ?? "") ? error.code : ""); process.exitCode = 1; });
