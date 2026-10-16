"use strict";

// Synthetic, bounded, offline audit probes. No DB, credentials or portal calls.
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const { validateWorkbookArchive } = require("../../apps/api/dist/workbook-archive");
const { LiveRunProcessor } = require("../../apps/worker/dist/live-run");
const { isTerminalRunStatus } = require("../../packages/core/dist");
const { decryptStoredArtifactBytes } = require("../../apps/api/dist/artifact-crypto");

async function columnExpansion() {
  const original = new ExcelJS.Workbook();
  const sheet = original.addWorksheet("Realizacja");
  sheet.addRow(["Nazwa", "REGON"]);
  sheet.addRow(["Firma syntetyczna", "123456789"]);
  const zip = await JSZip.loadAsync(await original.xlsx.writeBuffer());
  const xml = await zip.file("xl/worksheets/sheet1.xml").async("string");
  // 25,000 objects is deliberately bounded; do not run a large exhaustion payload.
  zip.file("xl/worksheets/sheet1.xml", xml.replace("<sheetData>",
    '<cols><col min="1" max="25000" width="10" customWidth="1"/></cols><sheetData>'));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await validateWorkbookArchive(bytes);
  const parsed = new ExcelJS.Workbook();
  await parsed.xlsx.load(bytes);
  const allocatedColumns = parsed.getWorksheet("Realizacja").columns.length;
  assert.equal(allocatedColumns, 25000);
  console.log(JSON.stringify({ probe: "xlsx_column_expansion", archiveBytes: bytes.length,
    preflight: "accepted", allocatedColumns, physicalCells: 4,
    conclusion: "column range expansion is not bounded by workbook preflight" }));
}

async function identityOutcome(result) {
  let status = "everest_search";
  let reasonCode;
  const runId = "11111111-1111-4111-8111-111111111111";
  const processor = Object.create(LiveRunProcessor.prototype);
  Object.assign(processor, {
    currentLease: null, currentSignal: null, environment: {},
    assertLease: async () => undefined,
    repository: {
      pauseAtSafeBoundary: async () => false,
      load: async () => ({ status, cancelRequested: false, source: { id: runId } }),
      pauseForReview: async (_id, expected, next, details) => {
        assert.equal(status, expected); status = next; reasonCode = details.reasonCode;
      },
    },
    everest: { findIdentity: async () => result },
  });
  await processor.process(runId, { lease: {}, signal: new AbortController().signal, intent: "recovery" });
  assert.equal(status, "identity_review");
  assert.equal(isTerminalRunStatus(status), false);
  console.log(JSON.stringify({ probe: "live_identity_outcome", input: result.kind,
    detail: result.reason ?? null, status, reasonCode, terminal: isTerminalRunStatus(status) }));
}

(async () => {
  await columnExpansion();
  const legacy = decryptStoredArtifactBytes("11111111-1111-4111-8111-111111111111",
    Buffer.from("synthetic legacy bytes"), { NODE_ENV: "production" });
  assert.equal(legacy.encrypted, false);
  console.log(JSON.stringify({ probe: "production_legacy_artifact_default",
    nodeEnv: "production", requireEncryption: "unset", legacyAccepted: true }));
  await identityOutcome({ kind: "not_found" });
  await identityOutcome({ kind: "identity_review", reason: "missing_pesel", candidateCount: 1 });
  await identityOutcome({ kind: "identity_review", reason: "unsupported_entity_type", candidateCount: 1 });
})().catch((error) => { console.error(error); process.exitCode = 1; });
