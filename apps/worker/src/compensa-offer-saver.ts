import type { Page } from "playwright";
import type { BrowserSession } from "./browser";
import type { CompensaCredentials, CompensaPortalSession } from "./compensa-session";
import type { CompensaOfferCheckpointStore } from "./compensa-offer-checkpoint";

export type CompensaOfferSaveSelectors = Readonly<{
  insuredDataSection: string;
  caseReference: string;
  saveButton: string;
  savedConfirmation: string;
}>;

export type CompensaSaveLookup =
  | Readonly<{ kind: "saved"; caseReference: string }>
  | Readonly<{ kind: "absent"; authoritative: true }>
  | Readonly<{ kind: "unknown" }>;

export type CompensaOfferSaverOptions = Readonly<{
  selectors: CompensaOfferSaveSelectors;
  adapterVersion: string;
  credentials?: () => CompensaCredentials | undefined;
  resultTimeoutMs?: number;
  /** Must query a portal state that is authoritative for the exact case reference. */
  lookupSave: (input: Readonly<{ page: Page; runId: string; caseReference: string }>) => Promise<CompensaSaveLookup>;
  beforeAction?: () => Promise<void>;
}>;

export type CompensaOfferSaveResult =
  | Readonly<{ kind: "saved"; caseReference: string }>
  | Readonly<{ kind: "already_saved"; caseReference: string }>
  | Readonly<{ kind: "waiting_for_sms"; portal: "compensa" }>
  | Readonly<{ kind: "waiting_for_manual_data"; fieldCode: "OFFER_SAVE_REVIEW" | "CASE_REFERENCE_REVIEW" }>
  | Readonly<{ kind: "outcome_uncertain"; errorCode: "OFFER_SAVE_UNCONFIRMED" }>
  | Readonly<{ kind: "portal_error"; errorCode: "PORTAL_FAILURE" | "PORTAL_SESSION_EXPIRED" | "PORTAL_SCHEMA_CHANGED" }>
  | Readonly<{ kind: "cancelled" }>;

function validateOptions(options: CompensaOfferSaverOptions): void {
  const timeout = options.resultTimeoutMs ?? 15_000;
  if (Object.values(options.selectors).some((selector) => !selector.trim())
    || !/^[A-Za-z0-9._-]{1,64}$/.test(options.adapterVersion)
    || !Number.isInteger(timeout) || timeout < 100 || timeout > 60_000
    || typeof options.lookupSave !== "function") {
    throw new Error("COMPENSA_OFFER_SAVER_CONFIG_INVALID");
  }
}

/** Performs the insured-data Save only behind a durable intent and a portal-state reconciliation gate. */
export class CompensaOfferSaver {
  constructor(
    private readonly browser: BrowserSession,
    private readonly session: CompensaPortalSession,
    private readonly checkpoints: CompensaOfferCheckpointStore,
    private readonly options: CompensaOfferSaverOptions,
  ) {
    validateOptions(options);
  }

  async saveInsuredData(runId: string, signal?: AbortSignal): Promise<CompensaOfferSaveResult> {
    if (signal?.aborted) return { kind: "cancelled" };
    const auth = await this.session.signIn(this.options.credentials?.());
    if (auth === "waiting_for_sms") return { kind: "waiting_for_sms", portal: "compensa" };
    if (auth !== "authenticated") {
      return { kind: "portal_error", errorCode: auth === "access_denied" ? "PORTAL_SESSION_EXPIRED" : "PORTAL_FAILURE" };
    }
    if (signal?.aborted) return { kind: "cancelled" };

    const page = await this.browser.page("compensa");
    const selectors = this.options.selectors;
    let clicked = false;
    try {
      if (!await page.locator(selectors.insuredDataSection).first().isVisible()) {
        return { kind: "waiting_for_manual_data", fieldCode: "OFFER_SAVE_REVIEW" };
      }
      const caseReference = (await page.locator(selectors.caseReference).first().innerText()).trim().replace(/\s*\/\s*/g, "/");
      if (!caseReference) return { kind: "waiting_for_manual_data", fieldCode: "CASE_REFERENCE_REVIEW" };
      if (!await this.checkpoints.recordDraftReference(runId, caseReference)) {
        return { kind: "waiting_for_manual_data", fieldCode: "CASE_REFERENCE_REVIEW" };
      }

      let checkpoint = await this.checkpoints.load(runId);
      if (!checkpoint) return { kind: "waiting_for_manual_data", fieldCode: "OFFER_SAVE_REVIEW" };
      if (checkpoint.kind === "saved") {
        return checkpoint.caseReference === caseReference
          ? { kind: "already_saved", caseReference }
          : { kind: "waiting_for_manual_data", fieldCode: "CASE_REFERENCE_REVIEW" };
      }
      if (checkpoint.kind !== "ready" && checkpoint.caseReference !== caseReference) {
        return { kind: "waiting_for_manual_data", fieldCode: "CASE_REFERENCE_REVIEW" };
      }

      if (checkpoint.kind === "save_intent") {
        let lookup: CompensaSaveLookup;
        try {
          lookup = await this.options.lookupSave({ page, runId, caseReference });
        } catch {
          return { kind: "outcome_uncertain", errorCode: "OFFER_SAVE_UNCONFIRMED" };
        }
        if (lookup.kind === "saved") {
          if (lookup.caseReference !== caseReference || !await this.checkpoints.recordSaved(runId, caseReference)) {
            return { kind: "waiting_for_manual_data", fieldCode: "CASE_REFERENCE_REVIEW" };
          }
          return { kind: "saved", caseReference };
        }
        if (lookup.kind !== "absent" || lookup.authoritative !== true) {
          return { kind: "outcome_uncertain", errorCode: "OFFER_SAVE_UNCONFIRMED" };
        }
        if (!await this.checkpoints.confirmSaveAbsent(runId, caseReference)) {
          return { kind: "waiting_for_manual_data", fieldCode: "OFFER_SAVE_REVIEW" };
        }
        checkpoint = { kind: "save_confirmed_absent", caseReference };
      }

      if (signal?.aborted) return { kind: "cancelled" };
      const button = page.locator(selectors.saveButton).first();
      if (!await button.isEnabled()) return { kind: "waiting_for_manual_data", fieldCode: "OFFER_SAVE_REVIEW" };
      if (checkpoint.kind === "ready") {
        // The draft reference and the form status must be durable before a portal write.
      } else if (checkpoint.kind !== "save_confirmed_absent") {
        return { kind: "waiting_for_manual_data", fieldCode: "OFFER_SAVE_REVIEW" };
      }
      const begin = await this.checkpoints.beginSave(runId, caseReference, this.options.adapterVersion);
      if (begin === "already_saved") return { kind: "already_saved", caseReference };
      if (begin !== "started") return { kind: "waiting_for_manual_data", fieldCode: "OFFER_SAVE_REVIEW" };
      if (signal?.aborted) return { kind: "cancelled" };
      await this.options.beforeAction?.();
      clicked = true;
      await button.click();
      await page.locator(selectors.savedConfirmation).first().waitFor({
        state: "visible", timeout: this.options.resultTimeoutMs ?? 15_000,
      });
      const confirmedReference = (await page.locator(selectors.caseReference).first().innerText()).trim().replace(/\s*\/\s*/g, "/");
      if (confirmedReference !== caseReference) return { kind: "waiting_for_manual_data", fieldCode: "CASE_REFERENCE_REVIEW" };
      if (!await this.checkpoints.recordSaved(runId, caseReference)) {
        return { kind: "outcome_uncertain", errorCode: "OFFER_SAVE_UNCONFIRMED" };
      }
      return { kind: "saved", caseReference };
    } catch {
      return clicked
        ? { kind: "outcome_uncertain", errorCode: "OFFER_SAVE_UNCONFIRMED" }
        : { kind: "portal_error", errorCode: "PORTAL_SCHEMA_CHANGED" };
    }
  }
}
