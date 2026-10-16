"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const ExcelJS = require("exceljs");
const { BrowserSession } = require("../apps/worker/dist/infrastructure/browser/browser.js");
const { CompensaPortalSession } = require("../apps/worker/dist/portals/compensa/compensa-session.js");
const { CompensaOfferSaver } = require("../apps/worker/dist/portals/compensa/compensa-offer-saver.js");
const { CompensaUfgReader } = require("../apps/worker/dist/portals/compensa/compensa-ufg.js");
const { LiveRunProcessor } = require("../apps/worker/dist/features/execution/live-run.js");
const { exportOcWorkbook } = require("../apps/api/dist/features/results/export.js");
const { selectCurrentPolicies } = require("../apps/worker/dist/features/results/oc.js");
const { loadPortalRuntimeConfig } = require("../apps/worker/dist/portals/shared/portal-runtime-config.js");
const { buildAcceptancePortalConfig } = require("./prepare-acceptance-portal-config.cjs");
const root = path.resolve(__dirname, "..");

// Real portal adapters and state loop; only persistence/transport use memory.
// No live accounts, existing offers, login or real queue are touched.
for (const suffix of ["37c6d177-d007-476d-80f4-d44e70dfa11f", "another-render-uuid"]) {
  test(`authenticated Compensa happy flow to XLSX with user DOM and dynamic ID ${suffix}`, async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "goldis-compensa-happy-"));
    const configPath = path.join(profile, "fixture-config.json");
    await fs.writeFile(configPath, JSON.stringify(await buildAcceptancePortalConfig()));
    const config = await loadPortalRuntimeConfig(configPath);
    let html = await fs.readFile(path.join(root, "apps/worker/test-fixtures/compensa-portal.html"), "utf8");
    const button = (action, id, icon, caption) => `<button type="button" disabled.bind="isButtonDisabled" class.bind="cssClass" click.trigger="onButtonClicked()" id.bind="btnId" class="au-target btn btn-outline-greenG tm-btnIcoLSepa ml-2 tm-btnDl mb-2 mb-xl-0" au-target-id="60" id="${id}" data-fixture-action="${action}"><span><span class="au-target ${icon}" au-target-id="61"></span><span class="au-target" au-target-id="62">${caption}</span></span></button>`;
    html = html.replace('<section id="insured-data" aria-label="Dane ubezpieczonych" hidden>', '<insured-section id="insured-data" aria-label="Dane ubezpieczonych">')
      .replace('<table id="ufg-summary">', '<table id="ufg-summary" class="table table-borderless"><tr><td>Liczba zdarzeń</td><td>0</td><td>0</td><td>0</td></tr>')
      .replace('<main>', '<main><table class="table-borderless"><tr><td>Liczba polis</td><td>999</td></tr></table>')
      .replace(/<\/section>\s*<\/main>/, '</insured-section></main>')
      .replace('<p>Oferta Nr <span id="offer-reference">SYNTH-CASE-1</span></p>', '<div><span class="mr-2">Oferta Nr</span><span class="tm-textGray14B">SYNTH-CASE-1</span></div>')
      .replace('<button type="button" id="save-insured">Zapisz</button>', button("save", "id_cpabyh", "i-save", "Zapisz"))
      .replace('<span id="saved-confirmation" data-saved-confirmation hidden>Zapis danych ubezpieczonych potwierdzony</span>', '<table id="saved-confirmation" hidden><tr><th>Rola</th><th>Akcje</th></tr><tr><td>Ubezpieczający</td><td></td></tr></table>')
      .replace('<button type="button" id="verify-ufg">Weryfikacja UFG</button>', button("verify", "VerificationStatus" + suffix, "i-accept", "Weryfikacja<br>UFG"))
      .replace('<button type="button" id="open-ufg-summary">Szczegóły</button>', button("details", "id_cpabyh", "i-search", "Szczegóły<br>weryfikacji UFG"))
      .replaceAll("document.querySelector('#save-insured')", "document.querySelector('[data-fixture-action=save]')")
      .replaceAll("document.querySelector('#verify-ufg')", "document.querySelector('[data-fixture-action=verify]')")
      .replaceAll("document.querySelector('#open-ufg-summary')", "document.querySelector('[data-fixture-action=details]')")
      .replace('const dialog =', `window.actionOrder = []; ${suffix === "another-render-uuid" ? "for (const action of ['save','verify','details']) { const button = document.querySelector('[data-fixture-action=' + action + ']'); button.disabled = true; button.hidden = true; } setTimeout(() => { const button = document.querySelector('[data-fixture-action=save]'); button.disabled = false; button.hidden = false; }, 900);" : ""} const dialog =`)
      .replace('window.syntheticSaveClickCount =', 'window.actionOrder.push("save"); window.syntheticSaveClickCount =')
      .replace('window.syntheticVerifyCount =', 'window.actionOrder.push("verify"); window.syntheticVerifyCount =')
      .replace("document.querySelector('#ufg-details').hidden = false;", 'window.actionOrder.push("details"); document.querySelector(\'#ufg-details\').hidden = false;')
      .replace("document.querySelector('#oc-table').hidden = false;", 'window.actionOrder.push("oc-details"); document.querySelector(\'#oc-table\').hidden = false;');
    if (suffix === "another-render-uuid") {
      html = html.replace('window.actionOrder.push("save");', 'window.actionOrder.push("save"); setTimeout(() => { const button = document.querySelector("[data-fixture-action=verify]"); button.hidden = false; button.disabled = false; }, 600);')
        .replace('window.actionOrder.push("verify");', 'window.actionOrder.push("verify"); setTimeout(() => { const button = document.querySelector("[data-fixture-action=details]"); button.hidden = false; button.disabled = false; }, 600);');
    }
    const browser = new BrowserSession({ profileDirectory: profile });
    try {
      const page = await browser.page("compensa");
      let requests = 0;
      await page.route("**/*", route => { requests++; return route.fulfill({ status: 200, contentType: "text/html", body: html }); });
      await page.goto("https://goldis.test/compensa");
      const session = new CompensaPortalSession(browser, { entryUrl: "https://goldis.test/compensa", selectors: {
        authenticated: '[data-screen="home"]', loginForm: '#absent-login', usernameInput: '#absent-user', passwordInput: '#absent-password', loginSubmit: '#absent-submit', smsChallenge: '#absent-sms', accessDenied: '#absent-denied',
      } });
      let checkpoint = "draft";
      const store = {
        load: async () => checkpoint === "saved" ? { kind: "saved", caseReference: "SYNTH-CASE-1" } : { kind: "ready" },
        recordDraftReference: async (_id, ref) => ref === "SYNTH-CASE-1",
        beginSave: async () => { assert.equal(checkpoint, "draft"); checkpoint = "intent"; return "started"; },
        recordSaved: async () => { assert.equal(checkpoint, "intent"); checkpoint = "saved"; return true; },
      };
      const saver = new CompensaOfferSaver(browser, session, store, { selectors: config.compensa.save, adapterVersion: config.compensa.adapterVersion,
        lookupSave: async () => ({ kind: "unknown" }) });
      let verificationIntents = 0;
      const ufg = new CompensaUfgReader(browser, session, { selectors: config.compensa.ufg, parserVersion: config.compensa.parserVersion,
        authorizeVerification: async () => { assert.equal(checkpoint, "saved"); verificationIntents++; return true; } });
      const runId = "11111111-1111-4111-8111-111111111111";
      const lease = { runId, executionId: "22222222-2222-4222-8222-222222222222", workerSessionId: browser.sessionId, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() };
      let status = "compensa_form";
      let snapshot, artifact;
      const stages = [status];
      const identity = { pesel: "90010100016" };
      const processor = Object.create(LiveRunProcessor.prototype);
      Object.assign(processor, { currentLease: null, currentSignal: null, environment: {}, saver, ufg,
        repository: {
          pauseAtSafeBoundary: async () => false,
          load: async () => ({ status, identity, source: { id: "33333333-3333-4333-8333-333333333333" }, cancelRequested: false }),
          transition: async (_id, expected, next) => { assert.equal(status, expected); status = next; stages.push(next); return true; },
          pauseForReview: async () => { assert.fail("unexpected intervention in happy flow"); },
        },
        stagingCheckpoint: { commitSnapshot: async () => { status = "reading_oc"; stages.push(status); return true; }, clearAfterFinalization: async () => {} },
        dependencies: {
          pool: { query: async sql => {
            if (sql.includes("SELECT 1 FROM automation_runs")) return { rowCount: 1, rows: [{}] };
            if (sql.includes("external_case_ref")) return { rowCount: 1, rows: [{ external_case_ref: "SYNTH-CASE-1" }] };
            assert.fail("unexpected SQL");
          } },
          staging: { write: async (_id, _source, _identity, value) => { snapshot = value; return { fileId: "synthetic-staging" }; }, remove: async () => {} },
          resultForwarder: { store: async (_id, _identity, value) => {
            assert.equal(status, "reading_oc"); status = "export_ready"; stages.push(status);
            artifact = await exportOcWorkbook({ regon: "012345678", companyName: "Firma syntetyczna", decisionMakerName: "Ala Testowa", mobile: "500000000", phone: "220000000", email: "test@example.invalid", pesel: identity.pesel, referenceDate: "2026-09-30", policies: value.policies });
            assert.ok(artifact); status = "completed"; stages.push(status);
          } },
        },
      });
      await processor.process(runId, { lease, signal: new AbortController().signal, intent: "recovery" });
      assert.deepEqual(stages, ["compensa_form", "ufg_verification", "reading_oc", "export_ready", "completed"]);
      assert.equal(snapshot.totalCount, 3); assert.equal(snapshot.policies.length, 3);
      assert.equal(artifact.policyCount, 2);
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(artifact.bytes);
      const sheet = workbook.getWorksheet("Wynik OC"); assert.ok(sheet); assert.equal(sheet.rowCount, 7);
      assert.deepEqual(sheet.getRow(2).values.slice(1), ["Firma syntetyczna", "012345678", "Ala Testowa", "500000000", "220000000", "test@example.invalid", identity.pesel]);
      const selected = selectCurrentPolicies(snapshot.policies, "2026-09-30");
      selected.forEach((policy, index) => assert.deepEqual(sheet.getRow(index + 6).values.slice(1), [
        index + 1, policy.insuredName, policy.policyTypeAndNumber, policy.contractType,
        policy.insuredClaimCount, policy.vehicleRegistration, policy.vehicleGroup, policy.vehicleMake, policy.vehicleModel, policy.insurer, policy.coverageFrom, policy.coverageTo,
      ]));
      assert.deepEqual(await page.evaluate(() => window.actionOrder), ["save", "verify", "details", "oc-details"]);
      assert.equal(verificationIntents, 1);
      assert.equal(requests, 1, "no navigation or login after the already-open case");
      assert.equal((await saver.saveInsuredData(runId)).kind, "already_saved");
      assert.equal((await ufg.readSnapshot(runId, "SYNTH-CASE-1")).kind, "snapshot");
      await processor.process(runId, { lease, signal: new AbortController().signal, intent: "recovery" });
      assert.deepEqual(await page.evaluate(() => window.actionOrder), ["save", "verify", "details", "oc-details"], "no second save, UFG or new offer on repeat");
      assert.equal(verificationIntents, 1);
    } finally {
      await browser.close();
      assert.equal(path.dirname(profile), os.tmpdir());
      await fs.rm(profile, { recursive: true, force: true });
    }
  });
}
