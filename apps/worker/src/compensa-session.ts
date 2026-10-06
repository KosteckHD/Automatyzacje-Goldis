import type { BrowserSession } from "./browser";
import { PortalSession, type PortalCredentials, type PortalSessionOptions, type PortalSessionState } from "./portal-session";

export type CompensaSessionOptions = PortalSessionOptions;
export type CompensaSessionState = PortalSessionState;
export type CompensaCredentials = PortalCredentials;

/** Compensa uses the same persistent profile and manual-MFA boundary as Everest. */
export class CompensaPortalSession extends PortalSession {
  constructor(browser: BrowserSession, options: CompensaSessionOptions) {
    super(browser, "compensa", options, "COMPENSA_SESSION_CONFIG_INVALID");
  }
}
