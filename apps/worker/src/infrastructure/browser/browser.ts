import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { isAllowedPortalNavigation, type PortalNavigationPolicy } from "../../portals/shared/portal-navigation";

export type Portal = "pzu" | "compensa";

export type BrowserSessionOptions = {
  profileDirectory: string;
  headless?: boolean;
  chromiumSandbox?: boolean;
  channel?: "chrome" | "msedge";
  launch?: typeof chromium.launchPersistentContext;
};

/** One persistent Chromium profile and at most one active portal task per worker. */
export class BrowserSession {
  /** Opaque ID for this in-memory browser owner; it is not a cookie or profile path. */
  readonly sessionId = randomUUID();
  private context: BrowserContext | null = null;
  private readonly pages = new Map<Portal, Page>();
  private opening: Promise<BrowserContext> | null = null;
  private navigationPolicy: Readonly<Record<Portal, PortalNavigationPolicy>> | null = null;
  private readonly blockedNavigation = new Set<Portal>();

  configureNavigationPolicy(policy: Readonly<Record<Portal, PortalNavigationPolicy>>): void {
    if (this.context || this.opening || this.navigationPolicy) throw new Error("PORTAL_NAVIGATION_POLICY_ALREADY_SET");
    for (const portal of ["pzu", "compensa"] as const) {
      if (!isAllowedPortalNavigation(policy[portal], policy[portal].entryUrl, true)) throw new Error("PORTAL_NAVIGATION_POLICY_INVALID");
    }
    this.navigationPolicy = Object.freeze(Object.fromEntries((["pzu", "compensa"] as const).map(portal => [portal,
      Object.freeze({ entryUrl: policy[portal].entryUrl, allowedOrigins: Object.freeze([...policy[portal].allowedOrigins]) }),
    ]))) as Readonly<Record<Portal, PortalNavigationPolicy>>;
  }

  async assertNavigationAllowed(portal: Portal, applicationOnly = false): Promise<void> {
    if (!this.navigationPolicy) return;
    const page = this.pages.get(portal);
    if (this.blockedNavigation.has(portal)) throw new Error("PORTAL_NAVIGATION_BLOCKED");
    if (page && page.url() !== "about:blank" && !isAllowedPortalNavigation(this.navigationPolicy[portal], page.url(), applicationOnly)) {
      throw new Error("PORTAL_NAVIGATION_BLOCKED");
    }
  }

  constructor(private readonly options: BrowserSessionOptions) {
    if (!options.profileDirectory || !isAbsolute(options.profileDirectory)) {
      throw new Error("WORKER_PROFILE_DIR must be an absolute path");
    }
  }

  async open(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.opening) return this.opening;
    this.opening = this.launch();
    try {
      this.context = await this.opening;
      return this.context;
    } finally {
      this.opening = null;
    }
  }

  private async launch(): Promise<BrowserContext> {
    const directory = resolve(this.options.profileDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const launch = this.options.launch ?? chromium.launchPersistentContext.bind(chromium);
    const context = await launch(directory, {
      headless: this.options.headless ?? true,
      chromiumSandbox: this.options.chromiumSandbox ?? false,
      ...(this.options.channel ? { channel: this.options.channel } : {}),
      acceptDownloads: false,
      timezoneId: "Europe/Warsaw",
      locale: "pl-PL",
      viewport: { width: 1440, height: 900 },
    });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    if (this.navigationPolicy) {
      await context.route("**/*", async route => {
        const request = route.request();
        if (!request.isNavigationRequest()) return route.fallback();
        let targetPage: Page;
        try {
          const frame = request.frame(); targetPage = frame.page();
          if (frame !== targetPage.mainFrame()) return route.fallback();
        } catch { return route.abort("blockedbyclient"); }
        const owner = [...this.pages].find(([, page]) => page === targetPage)?.[0];
        if (!owner || !isAllowedPortalNavigation(this.navigationPolicy![owner], request.url())) {
          if (owner) this.blockedNavigation.add(owner);
          return route.abort("blockedbyclient");
        }
        return route.fallback();
      });
    }
    return context;
  }

  async page(portal: Portal): Promise<Page> {
    const context = await this.open();
    const previous = this.pages.get(portal);
    if (previous && !previous.isClosed()) return previous;
    const page = await context.newPage();
    this.pages.set(portal, page);
    if (this.navigationPolicy) page.on("popup", popup => {
      this.blockedNavigation.add(portal);
      void popup.close().catch(() => undefined);
    });
    return page;
  }

  async close(): Promise<void> {
    const context = this.context ?? await this.opening;
    this.context = null;
    this.opening = null;
    this.pages.clear();
    await context?.close();
  }
}
