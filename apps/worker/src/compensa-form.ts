import { validateIdentityMatchV1 } from "@goldis/core";
import type { BrowserSession } from "./browser";
import type { WorkerRunContext } from "./ports";
import type { CompensaCredentials, CompensaPortalSession } from "./compensa-session";

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
}>;

export type CompensaFormOptions = Readonly<{
  selectors: CompensaFormSelectors;
  configuredRegistrationNumber: string;
  adapterVersion: string;
  credentials?: () => CompensaCredentials | undefined;
  /** Require the portal to resolve the insured person before continuing the live flow. */
  requirePrefilledIdentity?: boolean;
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
    || typeof options.authorizeStart !== "function" || typeof options.recordDraftReference !== "function") {
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

    const sessionState = await this.session.signIn(this.options.credentials?.(), verifyExisting);
    if (sessionState === "waiting_for_sms") return { kind: "waiting_for_sms", portal: "compensa" };
    if (sessionState !== "authenticated") {
      return { kind: "portal_error", errorCode: sessionState === "access_denied" ? "PORTAL_SESSION_EXPIRED" : "PORTAL_FAILURE" };
    }
    if (signal?.aborted) return { kind: "cancelled" };

    const page = await this.browser.page("compensa");
    const selectors = this.options.selectors;
    let startActionAttempted = false;
    try {
      const chooseInsuringParty = async (): Promise<boolean> => {
        const role = page.locator(selectors.roleSelect).first();
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
      if (!await page.locator(selectors.insuredDataSection).first().isVisible()) {
        if (verifyExisting) return { kind: "waiting_for_manual_data", fieldCode: "PORTAL_ACTION_REVIEW" };
        if (!await page.locator(selectors.startDialog).first().isVisible()) {
          await this.options.beforeAction?.();
          await page.locator(selectors.communicationTile).first().click();
          await page.locator(selectors.startDialog).first().waitFor({ state: "visible" });
        }
        const roleChosenInDialog = await chooseInsuringParty();
        await page.locator(selectors.identifierInput).first().fill(identity.pesel);
        await page.locator(selectors.registrationInput).first().fill(this.options.configuredRegistrationNumber);
        if (signal?.aborted) return { kind: "cancelled" };

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
        await page.locator(selectors.startCommunication).first().click();
        await page.locator(selectors.insuredDataSection).first().waitFor({ state: "visible" });
        if (!roleChosenInDialog) await chooseInsuringParty();
      }
      let draftRecorded: boolean;
      try { draftRecorded = await this.options.recordDraftReference({ runId: context.run.runId }); }
      catch { draftRecorded = false; }
      if (!draftRecorded) return { kind: "waiting_for_manual_data", fieldCode: "PORTAL_ACTION_REVIEW" };
      if (signal?.aborted) return { kind: "cancelled" };
      if (await page.locator(selectors.roleSelect).first().isVisible()) await chooseInsuringParty();
      const identityFields = [
        { selector: selectors.firstNameInput, expected: identity.firstName, normalize: comparable },
        { selector: selectors.lastNameInput, expected: identity.lastName, normalize: comparable },
        { selector: selectors.peselInput, expected: identity.pesel, normalize: (value: string) => value.trim() },
      ];
      for (const field of identityFields) {
        const input = page.locator(field.selector).first();
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
        const input = page.locator(field.selector).first();
        const current = (await input.inputValue()).trim();
        if (current) continue;
        if (!field.value.trim()) return { kind: "waiting_for_manual_data", fieldCode: field.code };
        await input.fill(field.value);
      }

      const county = page.locator(selectors.countyInput).first();
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
      if (!await page.locator(selectors.saveButton).first().isEnabled()) return { kind: "waiting_for_manual_data", fieldCode: "PORTAL_ACTION_REVIEW" };
      return { kind: "ready_to_save" };
    } catch {
      if (startActionAttempted) return { kind: "waiting_for_manual_data", fieldCode: "PORTAL_ACTION_REVIEW" };
      return { kind: "portal_error", errorCode: "PORTAL_SCHEMA_CHANGED" };
    }
  }
}
