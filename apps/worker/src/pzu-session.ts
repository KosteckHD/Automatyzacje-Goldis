import type { BrowserSession } from "./browser";
import { PortalSession, type PortalCredentials, type PortalSessionOptions, type PortalSessionSelectors, type PortalSessionState } from "./portal-session";

export type PzuSessionState = PortalSessionState;
export type PzuSessionSelectors = PortalSessionSelectors;
export type PzuSessionOptions = Readonly<Omit<PortalSessionOptions, "entryUrl"> & { everestEntryUrl: string }>;
export type PzuCredentials = PortalCredentials;

/** Everest-specific name over the shared persistent portal-session implementation. */
export class PzuEverestSession extends PortalSession {
  constructor(browser: BrowserSession, options: PzuSessionOptions) {
    super(browser, "pzu", {
      entryUrl: options.everestEntryUrl,
      allowedOrigins: options.allowedOrigins,
      selectors: options.selectors,
      transitionTimeoutMs: options.transitionTimeoutMs,
      beforeAction: options.beforeAction,
    }, "PZU_SESSION_CONFIG_INVALID");
  }
}
