import type { Locator, Page } from "playwright";
import type { BrowserSession, Portal } from "./browser";

export type PortalSessionState =
  | "authenticated"
  | "login_required"
  | "waiting_for_sms"
  | "access_denied"
  | "navigation_error"
  | "unknown";

export type SmsSubmissionResult = "accepted" | "rejected" | "expired" | "uncertain" | "session_lost";

export type PortalSessionSelectors = Readonly<{
  authenticated: string;
  loginForm: string;
  usernameInput: string;
  passwordInput: string;
  loginSubmit: string;
  smsChallenge: string;
  smsFrame?: string;
  smsCodeInput?: string;
  smsCodeSubmit?: string;
  smsRememberDevice?: string;
  smsResendCode?: string;
  /** Explicit portal markers; a retained SMS form alone is never treated as rejection. */
  smsCodeRejected?: string;
  smsCodeExpired?: string;
  accessDenied: string;
  /** Visible marker on an SSO landing page that must return to the configured application URL. */
  postLoginLanding?: string;
}>;

export type PortalSessionOptions = Readonly<{
  entryUrl: string;
  /** Explicit HTTPS origins are needed if the portal redirects between its application and login host. */
  allowedOrigins?: readonly string[];
  selectors: PortalSessionSelectors;
  transitionTimeoutMs?: number;
  /** Fenced per-run authorization checked immediately before an external portal action. */
  beforeAction?: () => Promise<void>;
}>;

export type PortalCredentials = Readonly<{ username: string; password: string }>;

/** Shared session boundary for an explicitly configured portal; never reads or solves MFA challenges. */
export class PortalSession {
  private loginAttempted = false;

  constructor(
    private readonly browser: BrowserSession,
    private readonly portal: Portal,
    private readonly options: PortalSessionOptions,
    configErrorCode = `${portal.toUpperCase()}_SESSION_CONFIG_INVALID`,
  ) {
    let url: URL;
    try {
      url = new URL(options.entryUrl);
    } catch {
      throw new Error(configErrorCode);
    }
    const allowedOrigins = options.allowedOrigins ?? [url.origin];
    const requiredSelectors = [options.selectors.authenticated, options.selectors.loginForm, options.selectors.usernameInput,
      options.selectors.passwordInput, options.selectors.loginSubmit, options.selectors.smsChallenge, options.selectors.accessDenied];
    const optionalSmsSelectorInvalid = Boolean(options.selectors.smsCodeInput) !== Boolean(options.selectors.smsCodeSubmit)
      || [options.selectors.smsFrame, options.selectors.smsCodeInput, options.selectors.smsCodeSubmit,
        options.selectors.smsRememberDevice, options.selectors.smsResendCode,
        options.selectors.smsCodeRejected, options.selectors.smsCodeExpired, options.selectors.postLoginLanding]
        .some((selector) => selector !== undefined && !selector.trim());
    const timeout = options.transitionTimeoutMs ?? 10_000;
    if (url.protocol !== "https:" || requiredSelectors.some((selector) => !selector.trim()) || optionalSmsSelectorInvalid
      || allowedOrigins.length === 0 || allowedOrigins.some((origin) => {
        try {
          return new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin;
        } catch {
          return true;
        }
      })
      || !Number.isInteger(timeout) || timeout < 100 || timeout > 30_000) {
      throw new Error(configErrorCode);
    }
  }

  /** Reuses the persistent page and recognizes its current screen before navigating or logging in. */
  async ensureAuthenticated(verifyExisting = false): Promise<PortalSessionState> {
    const page = await this.browser.page(this.portal);
    if (page.url().startsWith("chrome-error://")) return "navigation_error";
    if (verifyExisting && page.url() !== "about:blank") {
      const state = await this.readState(page);
      if (state === "authenticated" || state === "waiting_for_sms") return state;
    }
    if (page.url() === "about:blank" || verifyExisting) {
      try {
        await this.options.beforeAction?.();
        await page.goto(this.options.entryUrl, { waitUntil: "domcontentloaded" });
      } catch {
        return "navigation_error";
      }
    }
    const allowedOrigins = this.options.allowedOrigins ?? [new URL(this.options.entryUrl).origin];
    try {
      if (!allowedOrigins.includes(new URL(page.url()).origin)) return "access_denied";
    } catch {
      return "navigation_error";
    }
    return this.readState(page);
  }

  /** Makes one credential attempt only after the configured login marker is visible. */
  async signIn(credentials?: PortalCredentials, verifyExisting = false): Promise<PortalSessionState> {
    const currentState = await this.ensureAuthenticated(verifyExisting);
    if (currentState === "authenticated") this.loginAttempted = false;
    if (currentState !== "login_required" || !credentials?.username || !credentials.password || this.loginAttempted) return currentState;
    this.loginAttempted = true;

    const page = await this.browser.page(this.portal);
    try {
      await page.locator(this.options.selectors.usernameInput).first().fill(credentials.username);
      await page.locator(this.options.selectors.passwordInput).first().fill(credentials.password);
      await this.options.beforeAction?.();
      await page.locator(this.options.selectors.loginSubmit).first().click();
    } catch {
      return "unknown";
    }
    return this.waitForOutcome(page);
  }

  /** A new explicit login cycle may start after the portal has rejected a prior attempt. */
  resetLoginAttempt(): void {
    this.loginAttempted = false;
  }

  /** Starts a fresh portal login cycle after an operator has closed an expired SMS incident. */
  async reopenAfterSmsTimeout(): Promise<PortalSessionState> {
    this.resetLoginAttempt();
    const page = await this.browser.page(this.portal);
    try {
      await this.options.beforeAction?.();
      await page.goto(this.options.entryUrl, { waitUntil: "domcontentloaded" });
      return this.readState(page);
    } catch { return "navigation_error"; }
  }

  /** One operator-requested resend; delayed DOM availability never triggers a fresh login. */
  async resendSmsCodeIfAvailable(waitTimeoutMs = 25_000): Promise<"resent" | "unavailable" | "error"> {
    const selector = this.options.selectors.smsResendCode;
    if (!selector) return "unavailable";
    const page = await this.browser.page(this.portal);
    if (await this.ensureAuthenticated() !== "waiting_for_sms") return "unavailable";
    try {
      if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 100 || waitTimeoutMs > 30_000) return "error";
      const deadline = Date.now() + waitTimeoutMs;
      while (true) {
        await this.options.beforeAction?.();
        // This observes the current DOM only: no resend or login request while waiting.
        if (!await this.isVisible(page, this.options.selectors.smsChallenge)) return "error";
        const buttons = this.smsLocators(page, selector);
        const count = await buttons.count();
        if (count > 1) return "error";
        if (count === 1 && await buttons.isVisible() && await buttons.isEnabled()
          && await buttons.getAttribute("aria-disabled") !== "true") {
          await this.options.beforeAction?.();
          await buttons.click({ timeout: 1_000 });
          return "resent";
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return "error";
        await page.waitForTimeout(Math.min(500, remaining));
      }
    } catch { return "error"; }
  }

  /** Submits an operator-provided code once, then clears both the browser field and caller-owned bytes. */
  async submitSmsCode(code: Buffer, expiresAt?: Date): Promise<SmsSubmissionResult> {
    const selectors = this.options.selectors;
    try {
      if (!Buffer.isBuffer(code) || !/^\d{4,10}$/.test(code.toString("ascii"))) return "uncertain";
      if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || Date.now() >= expiresAt.getTime())) return "expired";
      const state = await this.ensureAuthenticated();
      if (state === "access_denied" || state === "navigation_error" || state === "login_required") return "session_lost";
      if (state !== "waiting_for_sms") return "uncertain";
      if (!selectors.smsCodeInput || !selectors.smsCodeSubmit) return "uncertain";

      const page = await this.browser.page(this.portal);
      if (selectors.smsCodeExpired && await this.isVisibleInSmsFrame(page, selectors.smsCodeExpired)) return "expired";
      if (this.portal === "pzu" && selectors.smsRememberDevice) {
        const rememberMatches = this.smsLocators(page, selectors.smsRememberDevice);
        if (await rememberMatches.count() > 1) return "uncertain";
        const remember = rememberMatches.first();
        if (await remember.isVisible()) {
          if (await remember.evaluate((element) => element.tagName.toLowerCase()) !== "input"
            || await remember.getAttribute("type") !== "checkbox") return "uncertain";
          await this.options.beforeAction?.();
          await remember.check();
        }
      }
      const input = this.smsLocators(page, selectors.smsCodeInput);
      if (await input.count() !== 1 || !await input.isVisible() || !await input.isEnabled()) return "uncertain";
      await this.options.beforeAction?.();
      if (expiresAt && Date.now() >= expiresAt.getTime()) return "expired";
      await input.fill(code.toString("ascii"));
      const submit = this.smsLocators(page, selectors.smsCodeSubmit);
      if (await submit.count() !== 1 || !await submit.first().isVisible() || !await submit.isEnabled()) return "uncertain";
      await this.options.beforeAction?.();
      if (expiresAt && Date.now() >= expiresAt.getTime()) return "expired";
      await submit.click();
      return await this.waitForSmsSubmission(page);
    } catch {
      return "uncertain";
    } finally {
      if (Buffer.isBuffer(code)) code.fill(0);
      if (selectors.smsCodeInput) {
        try {
          const page = await this.browser.page(this.portal);
          await this.smsLocator(page, selectors.smsCodeInput).evaluate((element) => {
            if ("value" in element) (element as HTMLInputElement).value = "";
          });
        } catch {
          // The portal may replace the MFA form after submission; the input buffer is still zeroed.
        }
      }
    }
  }

  private smsLocator(page: Page, selector: string): Locator {
    return this.smsLocators(page, selector).first();
  }

  private smsLocators(page: Page, selector: string): Locator {
    const frame = this.options.selectors.smsFrame;
    return frame ? page.frameLocator(frame).locator(selector) : page.locator(selector);
  }

  private async waitForOutcome(page: Page): Promise<PortalSessionState> {
    const deadline = Date.now() + (this.options.transitionTimeoutMs ?? 10_000);
    let state = await this.readState(page);
    while (state === "login_required" || state === "unknown") {
      if (Date.now() >= deadline) return state;
      await page.waitForTimeout(100);
      state = await this.readState(page);
    }
    return state;
  }

  private async waitForSmsOutcome(page: Page): Promise<PortalSessionState> {
    const deadline = Date.now() + (this.options.transitionTimeoutMs ?? 10_000);
    let state = await this.readState(page);
    while (state === "waiting_for_sms" || state === "unknown") {
      if (Date.now() >= deadline) return state;
      await page.waitForTimeout(100);
      state = await this.readState(page);
    }
    return state;
  }

  private async waitForSmsSubmission(page: Page): Promise<SmsSubmissionResult> {
    const selectors = this.options.selectors;
    const deadline = Date.now() + (this.options.transitionTimeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      if (selectors.smsCodeExpired && await this.isVisibleInSmsFrame(page, selectors.smsCodeExpired)) return "expired";
      if (selectors.smsCodeRejected && await this.isVisibleInSmsFrame(page, selectors.smsCodeRejected)) return "rejected";
      const state = await this.readState(page);
      if (state === "authenticated") return "accepted";
      if (state === "access_denied" || state === "navigation_error" || state === "login_required") return "session_lost";
      await page.waitForTimeout(100);
    }
    return "uncertain";
  }

  private async isVisibleInSmsFrame(page: Page, selector: string): Promise<boolean> {
    try { return await this.smsLocators(page, selector).first().isVisible(); }
    catch { return false; }
  }

  private async readState(page: Page, allowLandingRedirect = true): Promise<PortalSessionState> {
    if (page.url().startsWith("chrome-error://")) return "navigation_error";
    const allowedOrigins = this.options.allowedOrigins ?? [new URL(this.options.entryUrl).origin];
    try {
      if (!allowedOrigins.includes(new URL(page.url()).origin)) return "access_denied";
    } catch {
      return "navigation_error";
    }
    if (await this.isVisible(page, this.options.selectors.accessDenied)) return "access_denied";
    if (allowLandingRedirect && this.options.selectors.postLoginLanding
      && await this.isVisible(page, this.options.selectors.postLoginLanding)) {
      try {
        await this.options.beforeAction?.();
        await page.goto(this.options.entryUrl, { waitUntil: "domcontentloaded" });
      } catch {
        return "navigation_error";
      }
      return this.readState(page, false);
    }
    if (await this.isVisible(page, this.options.selectors.smsChallenge)) return "waiting_for_sms";
    if (await this.isVisible(page, this.options.selectors.loginForm)) return "login_required";
    if (await this.isVisible(page, this.options.selectors.authenticated)) return "authenticated";
    return "unknown";
  }

  private async isVisible(page: Page, selector: string): Promise<boolean> {
    try {
      return await page.locator(selector).first().isVisible();
    } catch {
      return false;
    }
  }
}
