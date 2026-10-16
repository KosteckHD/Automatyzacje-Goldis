import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { classifyIdentityLookup, type AutomationErrorCodeV1, type RunStatus } from "@goldis/core";
import { createAuthChallenge, fingerprintPortalAccount, invalidateUncertainAuthChallenge, pauseExpiredAuthChallenge, recordAuthChallengeOutcome, reconcileAuthenticatedPortal } from "../authentication/auth-challenges";
import { BrowserSession, type Portal } from "../../infrastructure/browser/browser";
import { OneTimeCodeInbox } from "../authentication/code-inbox";
import { CompensaFormAssistant } from "../../portals/compensa/compensa-form";
import { CompensaClientChoice } from "../../portals/compensa/compensa-client-choice";
import { PgCompensaOfferCheckpointStore } from "../../portals/compensa/compensa-offer-checkpoint";
import { CompensaOfferSaver } from "../../portals/compensa/compensa-offer-saver";
import { CompensaPortalSession } from "../../portals/compensa/compensa-session";
import { CompensaUfgReader } from "../../portals/compensa/compensa-ufg";
import { EverestIdentityProvider } from "../../portals/pzu/everest-identity-provider";
import { PgRunRepository } from "../../infrastructure/database/pg-run-repository";
import { PgPortalActionGate } from "../../portals/shared/portal-action-gate";
import type { PortalRuntimeConfig } from "../../portals/shared/portal-runtime-config";
import { PortalActionPacer, portalActionIntervalFromEnvironment } from "../../portals/shared/portal-action-pacer";
import { PzuEverestSession } from "../../portals/pzu/pzu-session";
import { WorkerResultForwarder } from "../results/result-forwarder";
import { ownsRunExecution, type DispatchIntent, type RunExecutionLease } from "./execution-lease";
import { WorkerResultStagingStore } from "../../infrastructure/staging/result-staging";
import { PgResultStagingCheckpoint } from "../results/result-staging-checkpoint";
import { uniquePortalLocator, uniquePortalMarkerVisible } from "../../portals/shared/portal-locator";

type Dependencies = Readonly<{
  pool: Pool;
  browser: BrowserSession;
  inbox: OneTimeCodeInbox;
  config: PortalRuntimeConfig;
  resultForwarder: WorkerResultForwarder;
  staging: WorkerResultStagingStore;
  environment: Readonly<Record<string, string | undefined>>;
}>;

const maxStagesPerDelivery = 16;

/** One production Playwright flow. All portal actions use the worker-owned persistent context. */
export class LiveRunProcessor {
  private readonly repository: PgRunRepository;
  private readonly pzuSession: PzuEverestSession;
  private readonly compensaSession: CompensaPortalSession;
  private readonly everest: EverestIdentityProvider;
  private readonly form: CompensaFormAssistant;
  private readonly saver: CompensaOfferSaver;
  private readonly ufg: CompensaUfgReader;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly portalActionPacer: PortalActionPacer;
  private readonly portalProfileKey: string;
  private readonly stagingCheckpoint: PgResultStagingCheckpoint;
  private currentLease: RunExecutionLease | null = null;
  private currentSignal: AbortSignal | null = null;

  constructor(private readonly dependencies: Dependencies) {
    const { pool, browser, config } = dependencies;
    this.environment = dependencies.environment;
    browser.configureNavigationPolicy({ pzu: config.pzu, compensa: config.compensa });
    if (this.environment.WORKER_PZU_LOGIN_TEST_RUN_ID
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(this.environment.WORKER_PZU_LOGIN_TEST_RUN_ID)) {
      throw new Error("PZU_LOGIN_TEST_RUN_ID_INVALID");
    }
    this.portalActionPacer = new PortalActionPacer(portalActionIntervalFromEnvironment(this.environment));
    this.portalProfileKey = browser.sessionId;
    this.repository = new PgRunRepository(pool, () => this.currentLease);
    this.stagingCheckpoint = new PgResultStagingCheckpoint(pool);
    this.pzuSession = new PzuEverestSession(browser, {
      everestEntryUrl: config.pzu.entryUrl,
      allowedOrigins: config.pzu.allowedOrigins,
      selectors: config.pzu.session,
      beforeAction: () => this.beforePortalAction("pzu"),
    });
    this.compensaSession = new CompensaPortalSession(browser, {
      entryUrl: config.compensa.entryUrl,
      allowedOrigins: config.compensa.allowedOrigins,
      selectors: config.compensa.session,
      beforeAction: () => this.beforePortalAction("compensa"),
    });
    const gates = new PgPortalActionGate(pool, () => this.beforePortalAction("compensa", true));
    const checkpoints = new PgCompensaOfferCheckpointStore(pool, () => new Date(), () => this.currentLease);
    this.everest = new EverestIdentityProvider(browser, this.pzuSession, {
      selectors: config.pzu.everest,
      adapterVersion: config.pzu.adapterVersion,
      credentials: () => this.credentials("pzu"),
      resolvePersonName: config.compensa.form.customerMatches && config.compensa.form.customerMatchSelect
        ? (context, pesel) => new CompensaClientChoice(browser, this.compensaSession, {
          selectors: { cards: config.compensa.form.customerMatches!, selectButton: config.compensa.form.customerMatchSelect! },
          credentials: () => this.credentials("compensa"), beforeAction: () => this.beforePortalAction("compensa"),
        }).resolvePersonName(context.source.effectiveRegon!, pesel)
        : undefined,
      beforeAction: () => this.beforePortalAction("pzu", true),
    });
    this.form = new CompensaFormAssistant(browser, this.compensaSession, {
      selectors: config.compensa.form,
      configuredRegistrationNumber: config.compensa.registrationNumber,
      adapterVersion: config.compensa.adapterVersion,
      credentials: () => this.credentials("compensa"),
      requirePrefilledIdentity: true,
      authorizeStart: (input) => gates.authorizeStart(input),
      recordDraftReference: async ({ runId }) => {
        await this.assertLease();
        const page = await browser.page("compensa");
        // Capture the reference of the just-started case even while CEP is
        // loading. Waiting for the editable form loses the recovery anchor.
        if (!await uniquePortalMarkerVisible(page, config.compensa.save.caseReference)) return false;
        const reference = (await (await uniquePortalLocator(page, config.compensa.save.caseReference)).innerText())
          .trim().replace(/\s*\/\s*/g, "/");
        if (!reference) return false;
        return checkpoints.recordDraftReference(runId, reference);
      },
      beforeAction: () => this.beforePortalAction("compensa", true),
    });
    this.saver = new CompensaOfferSaver(browser, this.compensaSession, checkpoints, {
      selectors: config.compensa.save,
      adapterVersion: config.compensa.adapterVersion,
      credentials: () => this.credentials("compensa"),
      lookupSave: async ({ page, caseReference }) => {
        const confirmed = await uniquePortalMarkerVisible(page, config.compensa.save.savedConfirmation);
        if (!confirmed) return { kind: "unknown" };
        const visibleReference = (await (await uniquePortalLocator(page, config.compensa.save.caseReference)).innerText()).trim().replace(/\s*\/\s*/g, "/");
        return visibleReference === caseReference
          ? { kind: "saved", caseReference }
          : { kind: "unknown" };
      },
      beforeAction: () => this.beforePortalAction("compensa", true),
    });
    this.ufg = new CompensaUfgReader(browser, this.compensaSession, {
      selectors: config.compensa.ufg,
      parserVersion: config.compensa.parserVersion,
      credentials: () => this.credentials("compensa"),
      authorizeVerification: (input) => gates.authorizeUfg(input),
      beforeAction: () => this.beforePortalAction("compensa", true),
    });
  }

  private credentials(portal: Portal): { username: string; password: string } | undefined {
    const prefix = portal === "pzu" ? "PZU" : "COMPENSA";
    const username = this.environment[`${prefix}_LOGIN`];
    const password = this.environment[`${prefix}_PASSWORD`];
    return username && password ? { username, password } : undefined;
  }

  private async move(runId: string, expected: RunStatus, next: RunStatus, errorCode: AutomationErrorCodeV1 | null = null): Promise<void> {
    await this.assertLease();
    if (!await this.repository.transition(runId, expected, next, errorCode)) throw new Error("RUN_STATE_CONFLICT");
  }

  private async assertLease(): Promise<void> {
    const lease = this.currentLease;
    if (!lease || this.currentSignal?.aborted || !await ownsRunExecution(this.dependencies.pool, lease)) {
      throw new Error("RUN_EXECUTION_LEASE_LOST");
    }
  }

  private async beforePortalAction(portal: Portal, applicationOnly = false): Promise<void> {
    await this.portalActionPacer.beforeAction(this.portalProfileKey, () => this.assertLease(), this.currentSignal ?? undefined);
    const runId = this.currentLease?.runId;
    if (runId && await this.repository.pauseAtSafeBoundary(runId)) throw new Error("RUN_PAUSE_ACKNOWLEDGED");
    await this.dependencies.browser.assertNavigationAllowed(portal, applicationOnly);
  }

  private async fail(runId: string, status: RunStatus, code: AutomationErrorCodeV1): Promise<void> {
    await this.move(runId, status, "failed", code);
  }

  private async waitForSubmitted(challengeId: string, expiresAt: Date, signal?: AbortSignal): Promise<boolean> {
    const deadline = Math.min(expiresAt.getTime(), Date.now() + 8_000);
    while (Date.now() < deadline && !signal?.aborted) {
      const result = await this.dependencies.pool.query<{ status: string }>(
        "SELECT status FROM auth_challenges WHERE challenge_id = $1", [challengeId],
      );
      if (result.rows[0]?.status === "submitted") return true;
      if (result.rows[0]?.status !== "active" && result.rows[0]?.status !== "claimed") return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  private async awaitSms(runId: string, portal: Portal, signal?: AbortSignal): Promise<boolean> {
    await this.assertLease();
    const account = this.environment[portal === "pzu" ? "PZU_LOGIN" : "COMPENSA_LOGIN"];
    const key = this.environment.WORKER_AUTH_SECRET;
    if (!account || !key || key.length < 32) throw new Error("PORTAL_ACCOUNT_CONFIG_INVALID");
    const expiresAt = new Date(Date.now() + (portal === "pzu" ? 300_000 : 120_000));
    const candidateId = randomUUID();
    this.dependencies.inbox.register(candidateId, expiresAt);
    let challenge;
    try {
      challenge = await createAuthChallenge(this.dependencies.pool, {
        challengeId: candidateId,
        runId,
        portal,
        accountKey: fingerprintPortalAccount(portal, account, key),
        browserSessionId: this.dependencies.browser.sessionId,
        returnStep: portal === "pzu" ? "pzu_login" : "compensa_login",
        expiresAt,
      });
    } catch {
      this.dependencies.inbox.invalidate(candidateId);
      throw new Error("AUTH_CHALLENGE_CREATE_FAILED");
    }
    if (challenge.challengeId !== candidateId) {
      this.dependencies.inbox.invalidate(candidateId);
      try {
        this.dependencies.inbox.register(challenge.challengeId, new Date(challenge.expiresAt));
      } catch {
        // A prior waiter for the same challenge is still active.
      }
    }
    let code: Buffer;
    try {
      const received = await this.waitForCodeOrAuthentication(challenge.challengeId, portal, signal);
      if (!received) return true;
      code = received;
    } catch {
      if (signal?.aborted) {
        this.dependencies.inbox.invalidate(challenge.challengeId);
        return false;
      }
      await this.assertLease();
      if (await pauseExpiredAuthChallenge(this.dependencies.pool, challenge.challengeId)) return false;
      const pending = await this.dependencies.pool.query<{ status: string }>(
        "SELECT status FROM automation_runs WHERE id = $1", [runId],
      );
      if (pending.rows[0]?.status === "waiting_for_sms") {
        await invalidateUncertainAuthChallenge(this.dependencies.pool, challenge.challengeId);
      }
      return false;
    }
    try {
      if (!await this.waitForSubmitted(challenge.challengeId, new Date(challenge.expiresAt), signal)) {
        if (signal?.aborted) return false;
        this.dependencies.inbox.invalidate(challenge.challengeId);
        if (await pauseExpiredAuthChallenge(this.dependencies.pool, challenge.challengeId)) return false;
        const pending = await this.dependencies.pool.query<{ status: string }>(
          "SELECT status FROM automation_runs WHERE id = $1", [runId],
        );
        if (pending.rows[0]?.status !== "waiting_for_sms") return false;
        await invalidateUncertainAuthChallenge(this.dependencies.pool, challenge.challengeId);
        return false;
      }
      const session = portal === "pzu" ? this.pzuSession : this.compensaSession;
      await this.assertLease();
      const state = await session.submitSmsCode(code, new Date(challenge.expiresAt));
      if (state === "uncertain" || state === "session_lost") {
        await invalidateUncertainAuthChallenge(this.dependencies.pool, challenge.challengeId);
        return false;
      }
      const outcome = await recordAuthChallengeOutcome(
        this.dependencies.pool, challenge.challengeId, state,
      );
      if (outcome.outcome === "attempt_limit_reached" || outcome.outcome === "expired") return false;
      // A recognized rejection opens a fresh one-time handoff inside the same MFA cycle.
      // The portal does not receive an automatic resend and the original cycle deadline is kept.
      return true;
    } finally {
      code.fill(0);
    }
  }

  private async waitForCodeOrAuthentication(challengeId: string, portal: Portal, signal?: AbortSignal): Promise<Buffer | null> {
    let observing = true;
    let receivedCode: Buffer | undefined;
    let handedOff = false;
    let finished = false;
    const code = this.dependencies.inbox.waitForCode(challengeId, signal)
      .then(value => { receivedCode = value; if (finished && !handedOff) value.fill(0); return { kind: "code" as const, value }; })
      .catch(error => ({ kind: "error" as const, error }));
    const session = portal === "pzu" ? this.pzuSession : this.compensaSession;
    const observation = (async () => {
      while (observing && !signal?.aborted) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!observing || signal?.aborted) break;
        await this.assertLease();
        if (await session.ensureAuthenticated() === "authenticated") {
          const reconciled = await reconcileAuthenticatedPortal(this.dependencies.pool, {
            challengeId, portal, browserSessionId: this.dependencies.browser.sessionId, lease: this.currentLease!,
          });
          if (reconciled) return { kind: "authenticated" as const };
        }
      }
      return { kind: "stopped" as const };
    })().catch(error => ({ kind: "error" as const, error }));
    try {
      const result = await Promise.race([code, observation]);
      observing = false;
      await observation;
      if (result.kind === "code") { handedOff = true; return result.value; }
      if (result.kind === "authenticated") {
        this.dependencies.inbox.invalidate(challengeId);
        return null;
      }
      if (result.kind === "error") throw result.error;
      throw new Error("AUTH_WAIT_INTERRUPTED");
    } finally {
      observing = false;
      finished = true;
      if (!handedOff) {
        this.dependencies.inbox.invalidate(challengeId);
        receivedCode?.fill(0);
      }
    }
  }

  async process(runId: string, execution: Readonly<{ lease: RunExecutionLease; signal: AbortSignal; intent: DispatchIntent }>): Promise<void> {
    if (this.currentLease) throw new Error("RUN_PROCESSOR_ALREADY_ACTIVE");
    this.currentLease = execution.lease;
    this.currentSignal = execution.signal;
    try {
      await this.processActive(runId, execution.intent, execution.signal);
    } finally {
      this.currentLease = null;
      this.currentSignal = null;
    }
  }

  private async processActive(runId: string, intent: DispatchIntent, signal: AbortSignal): Promise<void> {
    const loginTestRunId = this.environment.WORKER_PZU_LOGIN_TEST_RUN_ID;
    if (loginTestRunId && runId !== loginTestRunId) return;
    for (let stage = 0; stage < maxStagesPerDelivery; stage += 1) {
      await this.assertLease();
      if (signal.aborted) return;
      if (await this.repository.pauseAtSafeBoundary(runId)) throw new Error("RUN_PAUSE_ACKNOWLEDGED");
      const context = await this.repository.load(runId);
      if (!context || context.cancelRequested) return;
      const status = context.status;
      if (intent === "result_delivery" && status !== "reading_oc" && status !== "export_ready") return;
      // The intent limits entry, not subsequent stages of the same authenticated run.
      if (stage === 0 && intent === "resume_auth" && status !== "pzu_login" && status !== "compensa_login") return;
      if (["completed", "cancelled", "failed", "no_matching_policies", "identity_review", "waiting_for_manual_data"].includes(status)) return;
      if (intent === "resume_auth" && (status === "pzu_login" || status === "compensa_login")
        && (context.errorCode === "SMS_RETRY_QUEUED" || context.errorCode === "SMS_RETRY_REQUIRED")) {
        const portal: Portal = status === "pzu_login" ? "pzu" : "compensa";
        const session = portal === "pzu" ? this.pzuSession : this.compensaSession;
        await this.assertLease();
        const resend = portal === "pzu" ? await session.resendSmsCodeIfAvailable() : "unavailable";
        const reopened = resend === "unavailable" ? await session.reopenAfterSmsTimeout() : null;
        if (resend === "error" || reopened === "waiting_for_sms" || reopened === "navigation_error"
          || reopened === "access_denied" || reopened === "unknown") {
          await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
            portal, kind: "portal_error", reasonCode: "PORTAL_SESSION_EXPIRED",
          });
          return;
        }
        if (reopened === "login_required") session.resetLoginAttempt();
        await this.repository.clearErrorCode(runId, status);
      }
      if (status === "awaiting_portal_adapter") {
        await this.move(runId, status, "pzu_login");
        continue;
      }
      if (status === "pzu_login" || status === "everest_search") {
        if (loginTestRunId) {
          if (status !== "pzu_login") return;
          const authentication = await this.pzuSession.signIn(this.credentials("pzu"));
          if (authentication === "waiting_for_sms") {
            if (!await this.awaitSms(runId, "pzu", signal)) return;
            continue;
          }
          if (authentication === "authenticated") {
            await this.assertLease();
            if (!await this.repository.confirmPzuLoginAndPause(runId)) throw new Error("RUN_STATE_CONFLICT");
          } else {
            await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
              portal: "pzu", kind: "portal_error", reasonCode: "PORTAL_SESSION_EXPIRED",
            });
          }
          return;
        }
        let result;
        try {
          result = await this.everest.findIdentity(context);
        } catch (error) {
          await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
            portal: "pzu", kind: "portal_error",
            reasonCode: error instanceof Error && error.message === "EVEREST_OVERLAY_UNHANDLED"
              ? "PORTAL_SCHEMA_CHANGED" : "PORTAL_FAILURE",
          });
          return;
        }
        if (result.kind === "waiting_for_sms") {
          if (status === "everest_search") await this.move(runId, status, "pzu_login");
          if (!await this.awaitSms(runId, "pzu", signal)) return;
          continue;
        }
        if (status === "pzu_login") await this.move(runId, status, "everest_search");
        const identityDecision = classifyIdentityLookup(result);
        if (identityDecision.disposition === "failed") {
          await this.fail(runId, "everest_search", identityDecision.errorCode);
          return;
        }
        if (identityDecision.disposition === "review") {
          await this.repository.pauseForReview(runId, "everest_search", "identity_review", {
            portal: "pzu", kind: "identity_review", reasonCode: identityDecision.errorCode,
          });
          return;
        }
        if (result.kind !== "matched") { await this.fail(runId, "everest_search", "INPUT_INVALID"); return; }
        await this.repository.saveIdentity(runId, result.identity);
        await this.move(runId, "everest_search", "compensa_login");
        continue;
      }
      if (status === "compensa_login") {
        if (!context.identity) { await this.fail(runId, status, "INPUT_INVALID"); return; }
        const checkpoint = await this.dependencies.pool.query<{ last_safe_step: string | null }>(
          "SELECT last_safe_step FROM automation_runs WHERE id = $1", [runId],
        );
        const safeStep = checkpoint.rows[0]?.last_safe_step;
        if (safeStep === "compensa_offer_draft_open" || safeStep === "compensa_start_intent") {
          const result = await this.form.prepareInsuredForm(context, context.identity, signal, true);
          if (result.kind === "waiting_for_sms") { if (!await this.awaitSms(runId, "compensa", signal)) return; continue; }
          if (result.kind === "identity_review") {
            await this.repository.pauseForReview(runId, status, "identity_review", {
              portal: "compensa", kind: "identity_review", reasonCode: "IDENTITY_AMBIGUOUS",
            });
            return;
          }
          if (result.kind === "waiting_for_manual_data" || result.kind === "portal_error") {
            await this.fail(runId, status, result.kind === "portal_error" ? result.errorCode : "MANUAL_DATA_REQUIRED");
            return;
          }
          if (result.kind === "cancelled") return;
          await this.move(runId, status, "compensa_form");
          continue;
        }
        if (["compensa_insured_save_intent", "compensa_insured_save_confirmed_absent"].includes(safeStep ?? "")) {
          const auth = await this.compensaSession.signIn(this.credentials("compensa"));
          if (auth === "waiting_for_sms") { if (!await this.awaitSms(runId, "compensa", signal)) return; continue; }
          if (auth !== "authenticated") {
            await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
              portal: "compensa", kind: "portal_error", reasonCode: "PORTAL_SESSION_EXPIRED",
            });
            return;
          }
          await this.move(runId, status, "compensa_form");
          continue;
        }
        if (safeStep === "compensa_insured_data_saved" || safeStep === "ufg_verification_intent") {
          const auth = await this.compensaSession.signIn(this.credentials("compensa"));
          if (auth === "waiting_for_sms") { if (!await this.awaitSms(runId, "compensa", signal)) return; continue; }
          if (auth !== "authenticated") {
            await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
              portal: "compensa", kind: "portal_error", reasonCode: "PORTAL_SESSION_EXPIRED",
            });
            return;
          }
          await this.move(runId, status, "ufg_verification");
          continue;
        }
        // No checkpoint means a new case: enter Compensa Komunikacja from the home page.
        // Requiring an already open draft here prevented every fresh production run.
        const result = await this.form.prepareInsuredForm(context, context.identity, signal);
        if (result.kind === "waiting_for_sms") {
          if (!await this.awaitSms(runId, "compensa", signal)) return;
          continue;
        }
        if (result.kind === "identity_review") {
          await this.repository.pauseForReview(runId, status, "identity_review", {
            portal: "compensa", kind: "identity_review", reasonCode: "IDENTITY_AMBIGUOUS",
          });
          return;
        }
        if (result.kind === "waiting_for_manual_data") {
          await this.fail(runId, status, "MANUAL_DATA_REQUIRED");
          return;
        }
        if (result.kind === "cancelled") return;
        if (result.kind === "portal_error") {
          await this.fail(runId, status, result.errorCode);
          return;
        }
        await this.move(runId, status, "compensa_form");
        continue;
      }
      if (status === "compensa_form") {
        const result = await this.saver.saveInsuredData(runId, signal);
        if (result.kind === "waiting_for_sms") {
          await this.move(runId, status, "compensa_login");
          if (!await this.awaitSms(runId, "compensa", signal)) return;
          continue;
        }
        if (result.kind === "waiting_for_manual_data" || result.kind === "outcome_uncertain") {
          await this.fail(runId, status, "OFFER_SAVE_UNCONFIRMED");
          return;
        }
        if (result.kind === "cancelled") return;
        if (result.kind === "portal_error") {
          await this.fail(runId, status, result.errorCode);
          return;
        }
        await this.move(runId, status, "ufg_verification");
        continue;
      }
      if (status === "ufg_verification") {
        const caseResult = await this.dependencies.pool.query<{ external_case_ref: string | null }>(
          "SELECT external_case_ref FROM automation_runs WHERE id = $1", [runId],
        );
        const caseReference = caseResult.rows[0]?.external_case_ref;
        if (!caseReference) {
          await this.fail(runId, status, "OFFER_SAVE_UNCONFIRMED");
          return;
        }
        const result = await this.ufg.readSnapshot(runId, caseReference);
        if (result.kind === "waiting_for_sms") {
          await this.move(runId, status, "compensa_login");
          if (!await this.awaitSms(runId, "compensa", signal)) return;
          continue;
        }
        if (result.kind === "waiting_for_manual_data") {
          await this.fail(runId, status, "PORTAL_FAILURE");
          return;
        }
        if (result.kind === "portal_error") {
          await this.fail(runId, status, result.errorCode);
          return;
        }
        if (!context.identity) { await this.fail(runId, status, "INPUT_INVALID"); return; }
        const staged = await this.dependencies.staging.write(runId, context.source.id, context.identity, result.snapshot);
        if (!await this.stagingCheckpoint.commitSnapshot(runId, context.source.id, this.currentLease!, staged)) {
          await this.dependencies.staging.remove(staged.fileId);
          return;
        }
        await this.assertLease();
        await this.dependencies.resultForwarder.store(runId, context.identity, result.snapshot, this.currentLease!);
        await this.cleanupStaging(runId, staged.fileId);
        return;
      }
      if (status === "reading_oc") {
        const staged = await this.stagingCheckpoint.load(runId);
        if (staged) {
          const payload = await this.dependencies.staging.read(runId, staged.sourceRowId, staged.metadata);
          await this.assertLease();
          await this.dependencies.resultForwarder.store(runId, payload.identity, payload.snapshot, this.currentLease!);
          await this.cleanupStaging(runId, staged.metadata.fileId);
          return;
        }
        const persisted = await this.dependencies.pool.query(
          "SELECT 1 FROM oc_snapshots WHERE run_id = $1", [runId],
        );
        if (persisted.rowCount !== 1) {
          await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
            portal: "compensa", kind: "portal_error", reasonCode: "PORTAL_FAILURE",
          });
          return;
        }
      }
      if (status === "reading_oc" || status === "export_ready") {
        await this.assertLease();
        await this.dependencies.resultForwarder.finalize(runId, this.currentLease!);
        const staged = await this.stagingCheckpoint.load(runId);
        if (staged) await this.cleanupStaging(runId, staged.metadata.fileId);
        return;
      }
      throw new Error("RUN_STATE_UNSUPPORTED");
    }
    throw new Error("RUN_STAGE_LIMIT_REACHED");
  }

  private async cleanupStaging(runId: string, fileId: string): Promise<void> {
    await this.dependencies.staging.remove(fileId);
    if (this.currentLease) await this.stagingCheckpoint.clearAfterFinalization(runId, this.currentLease, fileId);
  }
}
