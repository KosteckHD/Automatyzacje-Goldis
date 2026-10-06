import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { type AutomationErrorCodeV1, type RunStatus } from "@goldis/core";
import { createAuthChallenge, fingerprintPortalAccount, invalidateUncertainAuthChallenge, pauseExpiredAuthChallenge, recordAuthChallengeOutcome } from "./auth-challenges";
import { BrowserSession, type Portal } from "./browser";
import { OneTimeCodeInbox } from "./code-inbox";
import { CompensaFormAssistant } from "./compensa-form";
import { PgCompensaOfferCheckpointStore } from "./compensa-offer-checkpoint";
import { CompensaOfferSaver } from "./compensa-offer-saver";
import { CompensaPortalSession } from "./compensa-session";
import { CompensaUfgReader } from "./compensa-ufg";
import { EverestIdentityProvider } from "./everest-identity-provider";
import { PgRunRepository } from "./pg-run-repository";
import { PgPortalActionGate } from "./portal-action-gate";
import type { PortalRuntimeConfig } from "./portal-runtime-config";
import { PzuEverestSession } from "./pzu-session";
import { WorkerResultForwarder } from "./result-forwarder";
import { ownsRunExecution, type DispatchIntent, type RunExecutionLease } from "./execution-lease";
import { WorkerResultStagingStore } from "./result-staging";
import { PgResultStagingCheckpoint } from "./result-staging-checkpoint";

type Dependencies = Readonly<{
  pool: Pool;
  browser: BrowserSession;
  inbox: OneTimeCodeInbox;
  config: PortalRuntimeConfig;
  resultForwarder: WorkerResultForwarder;
  staging: WorkerResultStagingStore;
  environment?: NodeJS.ProcessEnv;
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
  private readonly environment: NodeJS.ProcessEnv;
  private readonly stagingCheckpoint: PgResultStagingCheckpoint;
  private currentLease: RunExecutionLease | null = null;
  private currentSignal: AbortSignal | null = null;

  constructor(private readonly dependencies: Dependencies) {
    const { pool, browser, config } = dependencies;
    this.environment = dependencies.environment ?? process.env;
    this.repository = new PgRunRepository(pool, () => this.currentLease);
    this.stagingCheckpoint = new PgResultStagingCheckpoint(pool);
    this.pzuSession = new PzuEverestSession(browser, {
      everestEntryUrl: config.pzu.entryUrl,
      allowedOrigins: config.pzu.allowedOrigins,
      selectors: config.pzu.session,
      beforeAction: () => this.assertLease(),
    });
    this.compensaSession = new CompensaPortalSession(browser, {
      entryUrl: config.compensa.entryUrl,
      allowedOrigins: config.compensa.allowedOrigins,
      selectors: config.compensa.session,
      beforeAction: () => this.assertLease(),
    });
    const gates = new PgPortalActionGate(pool, () => this.assertLease());
    const checkpoints = new PgCompensaOfferCheckpointStore(pool, () => new Date(), () => this.currentLease);
    this.everest = new EverestIdentityProvider(browser, this.pzuSession, {
      selectors: config.pzu.everest,
      adapterVersion: config.pzu.adapterVersion,
      credentials: () => this.credentials("pzu"),
      beforeAction: () => this.assertLease(),
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
        if (!await page.locator(config.compensa.save.insuredDataSection).first().isVisible().catch(() => false)) return false;
        const reference = (await page.locator(config.compensa.save.caseReference).first().innerText().catch(() => ""))
          .trim().replace(/\s*\/\s*/g, "/");
        if (!reference) return false;
        return checkpoints.recordDraftReference(runId, reference);
      },
      beforeAction: () => this.assertLease(),
    });
    this.saver = new CompensaOfferSaver(browser, this.compensaSession, checkpoints, {
      selectors: config.compensa.save,
      adapterVersion: config.compensa.adapterVersion,
      credentials: () => this.credentials("compensa"),
      lookupSave: async ({ page, caseReference }) => {
        const confirmed = await page.locator(config.compensa.save.savedConfirmation).first().isVisible().catch(() => false);
        if (!confirmed) return { kind: "unknown" };
        const visibleReference = (await page.locator(config.compensa.save.caseReference).first().innerText()).trim().replace(/\s*\/\s*/g, "/");
        return visibleReference === caseReference
          ? { kind: "saved", caseReference }
          : { kind: "unknown" };
      },
      beforeAction: () => this.assertLease(),
    });
    this.ufg = new CompensaUfgReader(browser, this.compensaSession, {
      selectors: config.compensa.ufg,
      parserVersion: config.compensa.parserVersion,
      credentials: () => this.credentials("compensa"),
      authorizeVerification: (input) => gates.authorizeUfg(input),
      beforeAction: () => this.assertLease(),
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
      code = await this.dependencies.inbox.waitForCode(challenge.challengeId, signal);
    } catch {
      if (signal?.aborted) {
        this.dependencies.inbox.invalidate(challenge.challengeId);
        return false;
      }
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
    for (let stage = 0; stage < maxStagesPerDelivery; stage += 1) {
      await this.assertLease();
      if (signal.aborted) return;
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
        if (result.kind === "not_found") {
          await this.repository.pauseForReview(runId, "everest_search", "identity_review", {
            portal: "pzu", kind: "identity_review", reasonCode: "IDENTITY_NOT_FOUND",
          });
          return;
        }
        if (result.kind === "ambiguous" || result.kind === "identity_review") {
          await this.repository.pauseForReview(runId, "everest_search", "identity_review", {
            portal: "pzu", kind: "identity_review", reasonCode: "IDENTITY_AMBIGUOUS",
            fieldCode: result.kind === "identity_review" && result.reason === "missing_expected_person" ? "EXPECTED_PERSON" : undefined,
          });
          return;
        }
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
        if (safeStep === "compensa_offer_draft_open") {
          const result = await this.form.prepareInsuredForm(context, context.identity, undefined, true);
          if (result.kind === "waiting_for_sms") { if (!await this.awaitSms(runId, "compensa", signal)) return; continue; }
          if (result.kind === "identity_review") {
            await this.repository.pauseForReview(runId, status, "identity_review", {
              portal: "compensa", kind: "identity_review", reasonCode: "IDENTITY_AMBIGUOUS",
            });
            return;
          }
          if (result.kind === "waiting_for_manual_data" || result.kind === "portal_error") {
            await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
              portal: "compensa", kind: "portal_error",
              reasonCode: result.kind === "portal_error" ? result.errorCode : "MANUAL_DATA_REQUIRED",
              fieldCode: result.kind === "waiting_for_manual_data" ? result.fieldCode : undefined,
            });
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
          await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
            portal: "compensa", kind: "portal_error", reasonCode: "MANUAL_DATA_REQUIRED", fieldCode: result.fieldCode,
          });
          return;
        }
        if (result.kind === "cancelled") return;
        if (result.kind === "portal_error") {
          await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
            portal: "compensa", kind: "portal_error", reasonCode: result.errorCode,
          });
          return;
        }
        await this.move(runId, status, "compensa_form");
        continue;
      }
      if (status === "compensa_form") {
        const result = await this.saver.saveInsuredData(runId);
        if (result.kind === "waiting_for_sms") {
          await this.move(runId, status, "compensa_login");
          if (!await this.awaitSms(runId, "compensa", signal)) return;
          continue;
        }
        if (result.kind === "waiting_for_manual_data" || result.kind === "outcome_uncertain") {
          await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
            portal: "compensa", kind: "portal_error", reasonCode: "OFFER_SAVE_UNCONFIRMED",
          });
          return;
        }
        if (result.kind === "cancelled") return;
        if (result.kind === "portal_error") {
          await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
            portal: "compensa", kind: "portal_error", reasonCode: result.errorCode,
          });
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
          await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
            portal: "compensa", kind: "portal_error", reasonCode: "OFFER_SAVE_UNCONFIRMED",
          });
          return;
        }
        const result = await this.ufg.readSnapshot(runId, caseReference);
        if (result.kind === "waiting_for_sms") {
          await this.move(runId, status, "compensa_login");
          if (!await this.awaitSms(runId, "compensa", signal)) return;
          continue;
        }
        if (result.kind === "waiting_for_manual_data") {
          await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
            portal: "compensa", kind: "portal_error", reasonCode: "PORTAL_FAILURE",
          });
          return;
        }
        if (result.kind === "portal_error") {
          await this.repository.pauseForReview(runId, status, "waiting_for_manual_data", {
            portal: "compensa", kind: "portal_error", reasonCode: result.errorCode,
          });
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
