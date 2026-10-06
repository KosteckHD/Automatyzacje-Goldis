import type { OcSnapshotV1 } from "@goldis/core";
import type { BrowserSession } from "./browser";
import type { CompensaCredentials, CompensaPortalSession } from "./compensa-session";
import { readOcSnapshot } from "./oc";

export type CompensaUfgOptions = Readonly<{
  selectors: Readonly<{
    caseReference: string;
    verifyUfgButton: string;
    summaryTable: string;
    openUfgSummary: string;
  }>;
  parserVersion: string;
  credentials?: () => CompensaCredentials | undefined;
  resultTimeoutMs?: number;
  authorizeVerification: (input: Readonly<{ runId: string; caseReference: string; parserVersion: string }>) => Promise<boolean>;
  beforeAction?: () => Promise<void>;
}>;

export type CompensaUfgResult =
  | Readonly<{ kind: "snapshot"; snapshot: OcSnapshotV1 }>
  | Readonly<{ kind: "waiting_for_sms"; portal: "compensa" }>
  | Readonly<{ kind: "waiting_for_manual_data"; fieldCode: "UFG_ACTION_REVIEW" | "CASE_REFERENCE_REVIEW" }>
  | Readonly<{ kind: "portal_error"; errorCode: "PORTAL_FAILURE" | "PORTAL_SESSION_EXPIRED" | "PORTAL_SCHEMA_CHANGED" | "UFG_INCOMPLETE" | "COVERAGE_DATE_INVALID" }>;

function safePortalError(error: unknown): Extract<CompensaUfgResult, { kind: "portal_error" }>["errorCode"] {
  const code = error instanceof Error ? error.message : "";
  if (code === "UFG_INCOMPLETE" || code === "UFG_COUNT_INVALID" || code === "UFG_COUNT_MISMATCH"
    || code === "UFG_ORDINAL_INVALID" || code === "UFG_ORDINAL_CONFLICT") return "UFG_INCOMPLETE";
  if (code === "UFG_SCHEMA_CHANGED") return "PORTAL_SCHEMA_CHANGED";
  if (code === "COVERAGE_TO_INVALID" || code === "COVERAGE_FROM_INVALID") return "COVERAGE_DATE_INVALID";
  return "PORTAL_FAILURE";
}

/** Reads a verified Compensa case once and returns the complete OC set for the shared W2 pipeline. */
export class CompensaUfgReader {
  constructor(
    private readonly browser: BrowserSession,
    private readonly session: CompensaPortalSession,
    private readonly options: CompensaUfgOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    const selectors = Object.values(options.selectors);
    const timeout = options.resultTimeoutMs ?? 15_000;
    if (selectors.some((selector) => !selector.trim())
      || !/^[A-Za-z0-9._-]{1,64}$/.test(options.parserVersion)
      || !Number.isInteger(timeout) || timeout < 100 || timeout > 60_000
      || typeof options.authorizeVerification !== "function") {
      throw new Error("COMPENSA_UFG_CONFIG_INVALID");
    }
  }

  async readSnapshot(runId: string, expectedCaseReference: string): Promise<CompensaUfgResult> {
    const sessionState = await this.session.signIn(this.options.credentials?.());
    if (sessionState === "waiting_for_sms") return { kind: "waiting_for_sms", portal: "compensa" };
    if (sessionState !== "authenticated") {
      return { kind: "portal_error", errorCode: sessionState === "access_denied" ? "PORTAL_SESSION_EXPIRED" : "PORTAL_FAILURE" };
    }
    const page = await this.browser.page("compensa");
    try {
      const visibleCaseReference = (await page.locator(this.options.selectors.caseReference).first().innerText()).trim().replace(/\s*\/\s*/g, "/");
      if (!visibleCaseReference || visibleCaseReference !== expectedCaseReference) {
        return { kind: "waiting_for_manual_data", fieldCode: "CASE_REFERENCE_REVIEW" };
      }

      const summary = page.locator(this.options.selectors.summaryTable).first();
      if (!await summary.isVisible()) {
        let authorized = false;
        try {
          authorized = await this.options.authorizeVerification({
            runId, caseReference: expectedCaseReference, parserVersion: this.options.parserVersion,
          });
        } catch {
          return { kind: "portal_error", errorCode: "PORTAL_FAILURE" };
        }
        if (!authorized) return { kind: "waiting_for_manual_data", fieldCode: "UFG_ACTION_REVIEW" };
        await this.options.beforeAction?.();
        await page.locator(this.options.selectors.verifyUfgButton).first().click();
        await summary.waitFor({ state: "visible", timeout: this.options.resultTimeoutMs ?? 15_000 });
      }

      const detailsHeading = page.getByText("Szczegóły polis OC", { exact: true }).first();
      if (!await detailsHeading.isVisible().catch(() => false)) {
        await this.options.beforeAction?.();
        await page.locator(this.options.selectors.openUfgSummary).first().click();
        await detailsHeading.waitFor({ state: "visible", timeout: this.options.resultTimeoutMs ?? 15_000 });
      }

      const capturedAt = this.now();
      if (!Number.isFinite(capturedAt.getTime())) return { kind: "portal_error", errorCode: "PORTAL_FAILURE" };
      const snapshot = await readOcSnapshot(page, capturedAt.toISOString(), this.options.parserVersion);
      return { kind: "snapshot", snapshot };
    } catch (error) {
      return { kind: "portal_error", errorCode: safePortalError(error) };
    }
  }
}
