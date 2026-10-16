"use strict";

// Audit evidence, not a regression suite: some assertions confirm missing controls.
// No .env loading, real database, external portal, or customer workbook is used.
process.env.DATABASE_URL = "postgres://synthetic:unused@127.0.0.1:1/synthetic_audit";
process.env.REDIS_URL = "redis://127.0.0.1:1/15";
process.env.WORKER_LIVE_PORTALS = "0";
process.env.GOLDIS_ENRICHMENT_PROVIDER = "disabled";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const ExcelJS = require("exceljs");
const root = path.resolve(__dirname, "..");
const evidence = [];

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "goldis-confidentiality-audit-"));
  const models = require("../apps/api/dist/infrastructure/database/db");
  try {
    const { ImportService } = require("../apps/api/dist/features/imports/import.service");
    const originals = {
      transaction: models.sequelize.transaction, tool: models.Tool.findByPk,
      batch: models.ImportBatch.create, rows: models.SourceRow.bulkCreate,
      audit: models.AuditEvent.create,
    };
    const inputWorkbook = new ExcelJS.Workbook();
    const sheet = inputWorkbook.addWorksheet("Realizacja");
    sheet.addRow(["Nazwa", "NIP", "REGON", "Osoba decyzyjna", "Adres", "Kod pocztowy", "Miasto"]);
    sheet.addRow(["Synthetic Audit Company", "5260250274", "012345678", "Synthetic Person", "Synthetic Street 1", "00-001", "Synthetic City"]);
    let persistedRows;
    models.sequelize.transaction = async (callback) => callback({});
    models.Tool.findByPk = async () => ({ toolId: "oc-policy-verification", status: "available" });
    models.ImportBatch.create = async (row) => ({ ...row, id: randomUUID() });
    models.SourceRow.bulkCreate = async (rows) => { persistedRows = rows; return rows; };
    models.AuditEvent.create = async () => ({});
    try {
      await new ImportService().create({ originalname: "synthetic.xlsx", buffer: Buffer.from(await inputWorkbook.xlsx.writeBuffer()) }, randomUUID(), randomUUID());
      assert.equal(persistedRows[0].companyName, "Synthetic Audit Company");
      assert.equal(persistedRows[0].decisionMakerName, "Synthetic Person");
      assert.equal(persistedRows[0].address, "Synthetic Street 1");
      assert.equal(persistedRows[0].nipRaw, "5260250274");
      evidence.push({ id: "VPS-01", test: "ImportService plaintext persistence", confirmed: true, limitation: "Captured ORM payload with stubbed storage; not a disk or database encryption measurement." });
    } finally {
      models.sequelize.transaction = originals.transaction;
      models.Tool.findByPk = originals.tool;
      models.ImportBatch.create = originals.batch;
      models.SourceRow.bulkCreate = originals.rows;
      models.AuditEvent.create = originals.audit;
    }

    const { exportOcWorkbook } = require("../apps/api/dist/features/results/export");
    const { writeArtifactAtomically, resolveArtifactPath } = require("../apps/api/dist/features/results/public");
    const syntheticPesel = "01234567890";
    const exported = await exportOcWorkbook({
      regon: "012345678", companyName: "Synthetic Audit Company", pesel: syntheticPesel,
      referenceDate: "2026-10-09", policies: [{ sourceOrdinal: 1, insuredName: "Synthetic Person",
        policyTypeAndNumber: "Synthetic OC 001", contractType: "Nowa", insuredClaimCount: 0,
        vehicleRegistration: "SYN12345", vehicleGroup: "Samochod", vehicleMake: "Synthetic",
        vehicleModel: "Synthetic", insurer: "Synthetic", coverageFrom: "01.01.2026", coverageTo: "31.12.2026" }],
    });
    assert.ok(exported);
    const artifact = await writeArtifactAtomically(temporary, randomUUID(), exported.bytes);
    const raw = await fs.readFile(resolveArtifactPath(temporary, artifact.storageKey));
    assert.equal(raw.subarray(0, 2).toString(), "PK");
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(raw);
    assert.equal(reopened.getWorksheet("Polisy OC").getRow(2).getCell(3).value, syntheticPesel);
    evidence.push({ id: "VPS-02", test: "Private artifact is standard XLSX; PESEL readable without key", confirmed: true });

    const { BrowserSession } = require("../apps/worker/dist/infrastructure/browser/browser");
    let launchOptions;
    const browser = new BrowserSession({ profileDirectory: path.join(temporary, "profile"), launch: async (_directory, options) => {
      launchOptions = options;
      return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async close() {} };
    } });
    await browser.open();
    assert.equal(launchOptions.chromiumSandbox, undefined);
    assert.equal(launchOptions.acceptDownloads, false);
    await browser.close();
    evidence.push({ id: "VPS-07", test: "Browser launch does not enable Chromium sandbox", confirmed: true, limitation: "Launch capture; default false verified separately against Playwright documentation. No browser exploit executed." });

    const { loadPortalRuntimeConfig } = require("../apps/worker/dist/portals/shared/portal-runtime-config");
    const selectors = (names) => Object.fromEntries(names.split(" ").map((name) => [name, "#synthetic-" + name]));
    const session = selectors("authenticated loginForm usernameInput passwordInput loginSubmit smsChallenge smsCodeInput smsCodeSubmit accessDenied");
    const config = {
      pzu: { entryUrl: "https://egress-audit.example.com/", allowedOrigins: ["https://egress-audit.example.com"], session, adapterVersion: "synthetic-1",
        everest: { ...selectors("searchInput resultRows noResults"), fields: selectors("accountType personName pesel") } },
      compensa: { entryUrl: "https://egress-audit.example.com/", allowedOrigins: ["https://egress-audit.example.com"], session, adapterVersion: "synthetic-1", parserVersion: "synthetic-1", registrationNumber: "SYN12345",
        form: selectors("communicationTile startDialog identifierInput registrationInput startCommunication insuredDataSection roleSelect firstNameInput lastNameInput peselInput postalCodeInput countyInput saveButton"),
        save: selectors("insuredDataSection caseReference saveButton savedConfirmation"), ufg: selectors("caseReference verifyUfgButton summaryTable openUfgSummary") },
    };
    const configPath = path.join(temporary, "synthetic-config.json");
    await fs.writeFile(configPath, JSON.stringify(config));
    const accepted = await loadPortalRuntimeConfig(configPath);
    assert.equal(new URL(accepted.pzu.entryUrl).hostname, "egress-audit.example.com");
    evidence.push({ id: "VPS-08", test: "Portal config accepts arbitrary HTTPS host named in same config", confirmed: true, limitation: "Requires control of operator configuration; not customer XLSX SSRF. No network request made." });

    const { toolAccessFromRecords } = require("../apps/api/dist/features/authorization/tool-access");
    const access = toolAccessFromRecords({ tenantId: randomUUID(), userId: randomUUID(), role: "admin" },
      { toolId: "oc-policy-verification", status: "disabled" },
      { canDiscover: false, canExecute: false, canViewResults: false, canDownloadResults: false });
    assert.equal(access.canDownloadResults, true);
    evidence.push({ id: "VPS-05", test: "Admin download privilege is unconditional within role policy", confirmed: true, limitation: "Intentional role behavior; tenant guard still applies. Not an authorization bypass." });

    await fs.writeFile(path.join(root, "docs/security/confidentiality-evidence-2026-10-09.json"), JSON.stringify({
      auditDate: "2026-10-09", usesCustomerData: false, externalRequests: 0, realDatabaseConnections: 0,
      meaning: "Confirms observed behaviors, including missing controls; success does not certify security.", evidence,
    }, null, 2) + "\n");
    console.log(`CONFIDENTIALITY_EVIDENCE_REPRODUCED checks=${evidence.length} customerData=false externalRequests=0 databaseConnections=0`);
  } finally {
    await models.sequelize.close();
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("goldis-confidentiality-audit-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

main().catch(() => { console.error("CONFIDENTIALITY_AUDIT_FAILED; inspect the synthetic audit script locally"); process.exitCode = 1; });
