import { validateIdentityMatchV1 } from "@goldis/core";
import type { BrowserSession } from "../../infrastructure/browser/browser";
import type { WorkerRunContext } from "../../features/execution/ports";
import type { CompensaCredentials, CompensaPortalSession } from "./compensa-session";
import { uniquePortalLocator, uniquePortalMarkerVisible, waitForUniquePortalAction } from "../shared/portal-locator";
import { CompensaClientChoice } from "./compensa-client-choice";

export type CompensaFormSelectors = Readonly<{
  communicationTile: string;
  startDialog: string;
  identifierInput: string;
  registrationInput: string;
  startCommunication: string;
  insuredDataSection: string;
  roleSelect: string;
  firstNameInput: string;
  lastNameInput: string;
  peselInput: string;
  addressInput?: string;
  postalCodeInput: string;
  cityInput?: string;
  countyInput: string;
  saveButton: string;
  vehicleLookupFailure?: string;
  customerMatches?: string;
  customerMatchSelect?: string;
  editInsuredData?: string;
}>;

export type CompensaFormOptions = Readonly<{
  selectors: CompensaFormSelectors;
  configuredRegistrationNumber: string;
  adapterVersion: string;
  credentials?: () => CompensaCredentials | undefined;
  /** Require the portal to resolve the insured person before continuing the live flow. */
  requirePrefilledIdentity?: boolean;
  vehicleLookupTimeoutMs?: number;
  /** Must persist an idempotent create-intent before the portal can create a draft offer. */
  authorizeStart: (input: Readonly<{ runId: string; sourceRowId: string; identitySourceRowId: string; adapterVersion: string }>) => Promise<boolean>;
  /** Persist the exact visible draft reference before a form correction can be resumed. */
  recordDraftReference: (input: Readonly<{ runId: string }>) => Promise<boolean>;
  beforeAction?: () => Promise<void>;
}>;

export type CompensaFormPreparation =
  | Readonly<{ kind: "ready_to_save" }>
  | Readonly<{ kind: "waiting_for_sms"; portal: "compensa" }>
  | Readonly<{ kind: "identity_review"; reason: "identity_mismatch" }>
  | Readonly<{ kind: "waiting_for_manual_data"; fieldCode: "ADDRESS" | "POSTAL_CODE" | "CITY" | "COUNTY" | "PORTAL_ACTION_REVIEW" }>
  | Readonly<{ kind: "portal_error"; errorCode: "PORTAL_FAILURE" | "PORTAL_SESSION_EXPIRED" | "PORTAL_SCHEMA_CHANGED" }>
  | Readonly<{ kind: "cancelled" }>;

function comparable(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");
}

function validateOptions(options: CompensaFormOptions): void {
  const selectors = Object.values(options.selectors);
  if (selectors.some((selector) => !selector?.trim())
    || !/^[A-Za-z0-9._-]{1,64}$/.test(options.adapterVersion)
    || !/^[A-Z0-9 -]{4,12}$/i.test(options.configuredRegistrationNumber)
    || typeof options.authorizeStart !== "function" || typeof options.recordDraftReference !== "function"
    || !Number.isInteger(options.vehicleLookupTimeoutMs ?? 60_000)
    || (options.vehicleLookupTimeoutMs ?? 60_000) < 100 || (options.vehicleLookupTimeoutMs ?? 60_000) > 120_000) {
    throw new Error("COMPENSA_FORM_CONFIG_INVALID");
  }
}

/** Prepares and validates the insured-person screen; it deliberately stops before Save/UFG. */
export class CompensaFormAssistant {
  constructor(
    private readonly browser: BrowserSession,
    private readonly session: CompensaPortalSession,
    private readonly options: CompensaFormOptions,
  ) {
    validateOptions(options);
  }

  async prepareInsuredForm(context: WorkerRunContext, identityInput: unknown, signal?: AbortSignal, verifyExisting = false): Promise<CompensaFormPreparation> {
    if (signal?.aborted) return { kind: "cancelled" };
    let identity;
    try {
      identity = validateIdentityMatchV1(identityInput);
    } catch {
      return { kind: "identity_review", reason: "identity_mismatch" };
    }
    if (identity.sourceRowId !== context.source.id) return { kind: "identity_review", reason: "identity_mismatch" };

    // A new row starts at the application entry, never in the previous row's
    // open case. Reconciliation keeps the already-open exact case in place.
    if (!verifyExisting && context.status === "compensa_login") {
      const entryState = await this.session.openApplicationEntry();
      if (entryState === "navigation_error" || entryState === "access_denied") {
        return { kind: "portal_error", errorCode: "PORTAL_SESSION_EXPIRED" };
      }
    }
    const sessionState = await this.session.signIn(this.options.credentials?.());
    if (sessionState === "waiting_for_sms") return { kind: "waiting_for_sms", portal: "compensa" };
    if (sessionState !== "authenticated") {
      return { kind: "portal_error", errorCode: sessionState === "access_denied" ? "PORTAL_SESSION_EXPIRED" : "PORTAL_FAILURE" };
    }
    if (signal?.aborted) return { kind: "cancelled" };

    const page = await this.browser.page("compensa");
    const selectors = this.options.selectors;
    let startActionAttempted = false;
    let draftRecordedDuringLookup = false;
    try {
      const chooseInsuringParty = async (): Promise<boolean> => {
        const roles = page.locator(selectors.roleSelect);
        if (await roles.count() === 0) return false;
        const role = await uniquePortalLocator(page, selectors.roleSelect);
        if (!await role.isVisible()) return false;
        if (await role.evaluate((element) => element.tagName.toLowerCase()) === "select") {
          await this.options.beforeAction?.();
          await role.selectOption({ label: "Ubezpieczający" });
        } else {
          await this.options.beforeAction?.();
          await role.click();
        }
        return true;
      };
      if (!await uniquePortalMarkerVisible(page, selectors.insuredDataSection)) {
        if (verifyExisting) return { kind: "waiting_for_manual_data", fieldCode: "PORTAL_ACTION_REVIEW" };
        if (!await uniquePortalMarkerVisible(page, selectors.startDialog)) {
          await this.options.beforeAction?.();
          await (await uniquePortalLocator(page, selectors.communicationTile)).click();
          await page.locator(selectors.startDialog).waitFor({ state: "visible" });
        }
        const roleChosenInDialog = await chooseInsuringParty();
        await (await uniquePortalLocator(page, selectors.identifierInput)).fill(identity.pesel);
        await (await uniquePortalLocator(page, selectors.registrationInput)).fill(this.options.configuredRegistrationNumber);
        if (signal?.aborted) return { kind: "cancelled" };
        const startButton = await uniquePortalLocator(page, selectors.startCommunication);
        if (!await startButton.isVisible() || !await startButton.isEnabled()) throw new Error("PORTAL_START_UNAVAILABLE");
        let mayStart: boolean;
        try {
          mayStart = await this.options.authorizeStart({
            runId: context.run.runId,
            sourceRowId: context.source.id,
            identitySourceRowId: identity.sourceRowId,
            adapterVersion: this.options.adapterVersion,
          });
        } catch {
          return { kind: "portal_error", errorCode: "PORTAL_FAILURE" };
        }
        if (!mayStart) return { kind: "waiting_for_manual_data", fieldCode: "PORTAL_ACTION_REVIEW" };
        await this.options.beforeAction?.();
        startActionAttempted = true;
        await startButton.click();
        const deadline = Date.now() + (this.options.vehicleLookupTimeoutMs ?? 60_000);
        let clientSelected = false;
        let editorOpened = false;
        while (true) {
          if (signal?.aborted) return { kind: "cancelled" };
          // This choice belongs AFTER the home Communication dialog has been
          // submitted with PESEL + registration. Do not route through Client 360.
          if (selectors.customerMatches && selectors.customerMatchSelect) {
            if (clientSelected && await page.locator(selectors.customerMatches).filter({ visible: true }).count()) {
              return { kind: "identity_review", reason: "identity_mismatch" };
            }
            const choice = new CompensaClientChoice(this.browser, this.session, {
              selectors: { cards: selectors.customerMatches, selectButton: selectors.customerMatchSelect }, beforeAction: this.options.beforeAction,
            });
            const selected = await choice.selectIfVisible(context.source.effectiveRegon!, identity.pesel);
            if (selected === "mismatch") return { kind: "identity_review", reason: "identity_mismatch" };
            if (selected === "selected") clientSelected = true;
          }
          if (!draftRecordedDuringLookup) {
            try { draftRecordedDuringLookup = await this.options.recordDraftReference({ runId: context.run.runId }); }
            catch { /* The reference may not have appeared yet. Never restart the creation action. */ }
          }
          const sections = page.locator(selectors.insuredDataSection);
          if (await sections.count() > 1) throw new Error("PORTAL_SELECTOR_NOT_UNIQUE");
          if (draftRecordedDuringLookup && !await sections.isVisible().catch(() => false)
            && selectors.editInsuredData && !editorOpened) {
            const edit = page.locator(selectors.editInsuredData).filter({ visible: true });
            if (await edit.count() > 1) return { kind: "waiting_for_manual_data", fieldCode: "PORTAL_ACTION_REVIEW" };
            if (await edit.count() === 1 && await edit.isEnabled()) {
              await this.options.beforeAction?.();
              editorOpened = true;
              await edit.click();
            }
          }
          // The person section can render before the offer number. Both must
          // be ready before leaving this bounded lookup/recovery boundary.
          if (draftRecordedDuringLookup && await sections.count() === 1 && await sections.isVisible()) break;
          if (selectors.vehicleLookupFailure && await page.locator(selectors.vehicleLookupFailure).isVisible()) {
            return { kind: "waiting_for_manual_data", fieldCode: "PORTAL_ACTION_REVIEW" };
          }
          if (Date.now() >= deadline) return { kind: "waiting_for_manual_data", fieldCode: "PORTAL_ACTION_REVIEW" };
          await page.waitForTimeout(100);
        }
        if (!roleChosenInDialog) await chooseInsuringParty();
      }
      let draftRecorded: boolean;
      try { draftRecorded = draftRecordedDuringLookup || await this.options.recordDraftReference({ runId: context.run.runId }); }
      catch { draftRecorded = false; }
      if (!draftRecorded) return { kind: "waiting_for_manual_data", fieldCode: "PORTAL_ACTION_REVIEW" };
      if (signal?.aborted) return { kind: "cancelled" };
      await chooseInsuringParty();
      const identityFields = [
        { selector: selectors.firstNameInput, expected: identity.firstName, normalize: comparable },
        { selector: selectors.lastNameInput, expected: identity.lastName, normalize: comparable },
        { selector: selectors.peselInput, expected: identity.pesel, normalize: (value: string) => value.trim() },
      ];
      for (const field of identityFields) {
        const input = await uniquePortalLocator(page, field.selector);
        const current = (await input.inputValue()).trim();
        if (!current) {
          if (this.options.requirePrefilledIdentity) return { kind: "identity_review", reason: "identity_mismatch" };
          await input.fill(field.expected);
        } else if (field.normalize(current) !== field.normalize(field.expected)) {
          return { kind: "identity_review", reason: "identity_mismatch" };
        }
      }

      const requiredFields = [
        { selector: selectors.addressInput, value: context.source.address, code: "ADDRESS" as const },
        { selector: selectors.postalCodeInput, value: context.source.postalCode, code: "POSTAL_CODE" as const },
        { selector: selectors.cityInput, value: context.source.city, code: "CITY" as const },
      ];
      for (const field of requiredFields) {
        if (!field.selector) continue;
        const input = await uniquePortalLocator(page, field.selector);
        const current = (await input.inputValue()).trim();
        if (current) continue;
        if (!field.value.trim()) return { kind: "waiting_for_manual_data", fieldCode: field.code };
        await input.fill(field.value);
      }

      const county = await uniquePortalLocator(page, selectors.countyInput);
      const countyValue = await county.evaluate((element) => (element as HTMLInputElement).value.trim());
      if (!countyValue) {
        const countyCode = context.source.countyCode?.trim();
        if (!countyCode) return { kind: "waiting_for_manual_data", fieldCode: "COUNTY" };
        const isSelect = await county.evaluate((element) => element.tagName.toLowerCase() === "select");
        if (!isSelect) return { kind: "waiting_for_manual_data", fieldCode: "COUNTY" };
        const optionExists = await county.locator("option").evaluateAll((options, expected) =>
          options.some((option) => (option as HTMLOptionElement).value === expected), countyCode);
        if (!optionExists) return { kind: "waiting_for_manual_data", fieldCode: "COUNTY" };
        await this.options.beforeAction?.();
        await county.selectOption({ value: countyCode });
      }

      // Maiden name is intentionally optional; validation succeeds when it is blank.
      await waitForUniquePortalAction(page, selectors.saveButton, 15_000, signal);
      return { kind: "ready_to_save" };
    } catch {
      if (startActionAttempted) return { kind: "waiting_for_manual_data", fieldCode: "PORTAL_ACTION_REVIEW" };
      return { kind: "portal_error", errorCode: "PORTAL_SCHEMA_CHANGED" };
    }
  }
}
