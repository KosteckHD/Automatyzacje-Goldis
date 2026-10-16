"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { PzuEverestSession } = require("../dist/portals/pzu/pzu-session.js");
const { CompensaPortalSession } = require("../dist/portals/compensa/compensa-session.js");
const { EverestIdentityProvider } = require("../dist/portals/pzu/everest-identity-provider.js");

module.exports = async ({ command, runtime, root, state }) => {
  const config = runtime.liveConfig;
  const completedDiagnostic = /^diagnose-completed-ufg (context-[a-z0-9-]+\.json)$/.exec(command);
  if (completedDiagnostic) {
    const context = JSON.parse(await fs.readFile(path.join(root, "exports/live-acceptance", completedDiagnostic[1]), "utf8"));
    const row = (await runtime.pool.query("SELECT external_case_ref,last_safe_step,status FROM automation_runs WHERE id=$1", [context.runId])).rows[0];
    if (!["failed", "waiting_for_manual_data"].includes(row?.status) || row.last_safe_step !== "ufg_verification_intent" || !row.external_case_ref) throw new Error("COMPLETED_UFG_DIAGNOSTIC_CONTEXT_REQUIRED");
    const modulePath = require.resolve("../dist/portals/compensa/compensa-ufg.js");
    delete require.cache[modulePath];
    delete require.cache[require.resolve("../dist/features/results/oc.js")];
    const session = new CompensaPortalSession(runtime.browser, { entryUrl: config.compensa.entryUrl, allowedOrigins: config.compensa.allowedOrigins, selectors: config.compensa.session });
    const reader = new (require(modulePath).CompensaUfgReader)(runtime.browser, session, { selectors: config.compensa.ufg, parserVersion: config.compensa.parserVersion,
      authorizeVerification: async () => { throw new Error("DIAGNOSTIC_MUST_NOT_REPEAT_UFG"); } });
    const result = await reader.readSnapshot(context.runId, row.external_case_ref);
    console.log(JSON.stringify(result.kind === "snapshot" ? { result: "snapshot", totalCount: result.snapshot.totalCount, readCount: result.snapshot.policies.length } : { result: result.kind, errorCode: result.errorCode }));
    if (result.kind === "snapshot") {
      try {
        require("@goldis/core").validateOcSnapshotV1(result.snapshot); console.log("LIVE_SNAPSHOT_VALIDATED");
      }
      catch (error) { console.log(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "LIVE_SNAPSHOT_VALIDATION_FAILED"); }
    }
    return;
  }
  if (command === '{"action":"diagnose-case"}') {
    try {
      const page = await runtime.browser.page("compensa");
      const target = page.locator(config.compensa.save.caseReference);
      if (await target.count() !== 1 || !await target.isVisible()) throw new Error("CASE_MARKER_NOT_UNIQUE_OR_VISIBLE");
      const value = (await target.innerText()).trim().replace(/\s*\/\s*/g, "/");
      console.log(JSON.stringify({ caseMarkerVisible: await target.isVisible(), normalizedReferenceValid: /^[\p{L}\p{N}._/-]{1,200}$/u.test(value),
        firstNameInputCount: await page.locator(config.compensa.form.firstNameInput).count(),
        firstNameVisibleCount: await page.locator(config.compensa.form.firstNameInput + ':visible').count(),
        editClientButtonCount: await page.locator('button:has(> span.i-edit_underlined):visible').count() }));
    } catch (error) { console.log(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "CASE_DIAGNOSTIC_FAILED"); }
    return;
  }
  const credentials = prefix => ({ username: process.env[`${prefix}_LOGIN`], password: process.env[`${prefix}_PASSWORD`] });
  if (process.env.ACCEPTANCE_FRESH_PZU_SESSION === "1" && !["pzu-login", "pzu-status", "pzu-sms-selectors", "pzu-wait-login", "pzu-reconcile-login-test"].includes(command)) throw new Error("PZU_LOGIN_ONLY_SESSION");
  state.pzu ||= new PzuEverestSession(runtime.browser, { everestEntryUrl: config.pzu.entryUrl, allowedOrigins: config.pzu.allowedOrigins, selectors: config.pzu.session });
  if (command === "pzu-status") {
    console.log(JSON.stringify({ portal: "pzu", state: await state.pzu.ensureAuthenticated() }));
    return;
  }
  if (command === "pzu-reconcile-login-test") {
    if (await state.pzu.ensureAuthenticated() !== "authenticated") throw new Error("PZU_NOT_AUTHENTICATED");
    const runId = process.env.WORKER_PZU_LOGIN_TEST_RUN_ID;
    const row = (await runtime.pool.query(`SELECT execution_id, worker_session_id, lease_expires_at, current_auth_challenge_id FROM automation_runs WHERE id=$1 AND worker_session_id=$2 AND lease_expires_at>now()`, [runId, runtime.browser.sessionId])).rows[0];
    if (!row?.current_auth_challenge_id) throw new Error("PZU_ACTIVE_CHALLENGE_MISSING");
    const lease = { runId, executionId: row.execution_id, workerSessionId: row.worker_session_id, leaseExpiresAt: row.lease_expires_at.toISOString() };
    const authPath = require.resolve("../dist/features/authentication/auth-challenges.js"); delete require.cache[authPath];
    const reconciled = await require(authPath).reconcileAuthenticatedPortal(runtime.pool, { challengeId: row.current_auth_challenge_id, portal: "pzu", browserSessionId: runtime.browser.sessionId, lease });
    if (!reconciled) throw new Error("PZU_CHALLENGE_RECONCILIATION_CONFLICT");
    runtime.inbox.invalidate(row.current_auth_challenge_id);
    const { PgRunRepository } = require("../dist/infrastructure/database/pg-run-repository.js");
    const paused = await new PgRunRepository(runtime.pool, () => lease).confirmPzuLoginAndPause(runId);
    console.log(JSON.stringify({ portal: "pzu", authenticatedWithoutCode: true, paused }));
    return;
  }
  if (command === "pzu-sms-selectors") {
    const page = await runtime.browser.page("pzu");
    const selectors = config.pzu.session;
    const challenge = page.locator(selectors.smsChallenge);
    const scope = selectors.smsFrame ? page.frameLocator(selectors.smsFrame) : page;
    const code = scope.locator(selectors.smsCodeInput);
    const submit = scope.locator(selectors.smsCodeSubmit);
    console.log(JSON.stringify({ portal: "pzu", challengeCount: await challenge.count(), codeInputCount: await code.count(), submitCount: await submit.count(), codeVisible: await code.isVisible(), submitVisible: await submit.isVisible(), submitEnabled: await submit.isEnabled() }));
    return;
  }
  if (command === "pzu-wait-login") {
    const deadline = Date.now() + 300_000;
    let result;
    do {
      result = await state.pzu.ensureAuthenticated();
      if (result !== "waiting_for_sms") break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    console.log(JSON.stringify({ portal: "pzu", state: result }));
    return;
  }
  state.compensa ||= new CompensaPortalSession(runtime.browser, { entryUrl: config.compensa.entryUrl, allowedOrigins: config.compensa.allowedOrigins, selectors: config.compensa.session });
  if (command === "pzu-login" || command === "compensa-login") {
    const portal = command === "pzu-login" ? "pzu" : "compensa";
    console.log(JSON.stringify({ portal, state: await state[portal].signIn(credentials(portal === "pzu" ? "PZU" : "COMPENSA")) }));
    return;
  }
  if (command === "lookup18001") {
    const context = JSON.parse(await fs.readFile(path.join(root, "exports/live-acceptance/context-compose.json"), "utf8"));
    const row = (await runtime.pool.query(`SELECT id, company_name AS "companyName", decision_maker_name AS "decisionMakerName", effective_regon AS "effectiveRegon" FROM source_rows WHERE batch_id=$1 AND row_number=18001`, [context.batchId])).rows[0];
    if (!row) throw new Error("SOURCE_ROW_MISSING");
    const provider = new EverestIdentityProvider(runtime.browser, state.pzu, { selectors: config.pzu.everest, adapterVersion: config.pzu.adapterVersion, credentials: () => credentials("PZU") });
    const result = await provider.findIdentity({ source: row });
    if (result.kind === "matched") state.identity = result.identity;
    console.log(JSON.stringify({ rowNumber: 18001, result: result.kind }));
    return;
  }
  const page = await runtime.browser.page("compensa");
  const exact = async selector => {
    const target = page.locator(selector);
    if (await target.count() !== 1 || !await target.isVisible() || !await target.isEnabled()) throw new Error("ACTION_TARGET_NOT_UNIQUE_OR_ENABLED");
    return target;
  };
  if (command === "search-existing-step7-client") {
    const context = JSON.parse(await fs.readFile(path.join(root, "exports/live-acceptance/context-step7.json"), "utf8"));
    const { PgRunRepository } = require("../dist/infrastructure/database/pg-run-repository.js");
    const run = await new PgRunRepository(runtime.pool).load(context.runId);
    if (!run?.identity || run.source.rowNumber !== 18001 || run.status !== "waiting_for_manual_data") throw new Error("EXISTING_TEST_CONTEXT_REQUIRED");
    await runtime.browser.assertNavigationAllowed("compensa", true);
    await (await exact('input[placeholder="PESEL / REGON"]:visible')).fill(run.identity.pesel);
    await (await exact('button:has-text("Przejdź do Klient 360"):visible')).click();
    state.identity = run.identity;
    state.testRunId = context.runId;
    console.log("EXISTING_CLIENT_LOOKUP_SUBMITTED_NO_OFFER_STARTED");
    return;
  }
  if (command === "open-communication") {
    if (await state.compensa.ensureAuthenticated() !== "authenticated") throw new Error("COMPENSA_AUTH_REQUIRED");
    await (await exact(config.compensa.form.communicationTile)).click();
    await page.locator(config.compensa.form.startDialog).waitFor({ state: "visible" });
    console.log("START_DIALOG_VISIBLE_NO_START_CLICKED");
    return;
  }
  if (command === "start-communication") {
    if (!state.identity || state.startClicked) throw new Error("SUPERVISED_START_NOT_ALLOWED");
    const form = config.compensa.form;
    await (await exact(form.roleSelect)).click();
    await (await exact(form.identifierInput)).fill(state.identity.pesel);
    await (await exact(form.registrationInput)).fill(config.compensa.registrationNumber);
    const start = await exact(form.startCommunication);
    state.startClicked = true;
    await start.click();
    console.log("SUPERVISED_START_CLICKED_ONCE");
    return;
  }
  const input = JSON.parse(command);
  if (input.action === "read-oc") {
    if (!state.identityVerified) throw new Error("IDENTITY_NOT_VERIFIED");
    const { readOcSnapshot, selectCurrentPolicies } = require("../dist/features/results/oc.js");
    const snapshot = await readOcSnapshot(page, new Date().toISOString(), config.compensa.parserVersion);
    state.snapshot = snapshot;
    const current = selectCurrentPolicies(snapshot.policies, "2026-10-09");
    console.log(JSON.stringify({ rowNumber: 18001, totalOcCount: snapshot.totalCount, readRows: snapshot.policies.length, matchingDateCount: current.length, referenceDate: "2026-10-09", completenessConfirmed: snapshot.totalCount === snapshot.policies.length }));
    return;
  }
  if (input.action === "verify-identity") {
    if (!state.identity) throw new Error("IDENTITY_MISSING");
    const checks = {};
    for (const [label, field] of [["Imię", "firstName"], ["Nazwisko", "lastName"], ["PESEL", "pesel"]]) {
      const locator = page.locator(`insured-section div.row:has(> label:text-is("${label}")) input`);
      checks[field] = await locator.count() === 1 && (await locator.inputValue()).trim().toLocaleLowerCase("pl-PL") === state.identity[field].trim().toLocaleLowerCase("pl-PL");
    }
    state.identityVerified = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ identityVerified: state.identityVerified, checks }));
    return;
  }
  if (input.action === "structure" && typeof input.selector === "string") {
    const target = page.locator(input.selector);
    console.log(JSON.stringify(await target.evaluateAll(elements => elements.slice(0, 120).map(element => ({ tag: element.tagName.toLowerCase(), id: element.id, className: typeof element.className === "string" ? element.className : "", parentTag: element.parentElement?.tagName.toLowerCase(), parentClass: element.parentElement?.className, isOfferCaption: /^Oferta Nr\s/.test(element.textContent.trim()), knownLabel: /^(?:Zapisz|Dane ubezpieczonych|Imię|Nazwisko|Kod pocztowy|Powiat|Weryfikacja UFG|Szczegóły|Akceptuj)$/i.test(element.textContent.trim()) ? element.textContent.trim() : "" })))));
    return;
  }
  if (input.action === "click" && typeof input.selector === "string") {
    await (await exact(input.selector)).click();
    console.log("SUPERVISED_UNIQUE_TARGET_CLICKED");
    return;
  }
  throw new Error("SUPERVISED_COMMAND_UNKNOWN");
};
