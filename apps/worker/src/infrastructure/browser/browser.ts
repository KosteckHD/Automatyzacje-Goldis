import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
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
  private profileLockPending: Promise<void> | null = null;
  private profileLock: FileHandle | null = null;
  private profileLockPath: string | null = null;
  private navigationPolicy: Readonly<Record<Portal, PortalNavigationPolicy>> | null = null;
  private readonly blockedNavigation = new Set<Portal>();
  private readonly navigationTrace = new Map<Portal, Array<{ kind: string; origin: string; path: string; status?: number }>>();

  /** Bounded authentication diagnostics: no query strings, headers, bodies or identifiers. */
  navigationDiagnostics(portal: Portal) {
    return { blocked: this.blockedNavigation.has(portal), events: [...(this.navigationTrace.get(portal) ?? [])] };
  }

  /** Refresh only the stalled F5 access-policy session; retain remembered MFA devices. */
  async clearStalledPzuAccessSession(): Promise<void> {
    const context = await this.open();
    await context.clearCookies({ name: /^(MRHSession|LastMRH_Session)$/,
      domain: /^\.?(?:zaloguj\.)?pzu\.pl$/ });
  }

  private traceNavigation(portal: Portal, kind: string, target: string, status?: number): void {
    try {
      const url = new URL(target);
      const knownPaths = ["/my.policy", "/pc/PolicyCenter.do", "/internalauth/authenticate/sms", "/", "/my.logout.php3"];
      const events = this.navigationTrace.get(portal) ?? [];
      events.push({ kind, origin: url.origin, path: knownPaths.includes(url.pathname) ? url.pathname : "<other>",
        ...(status === undefined ? {} : { status }) });
      this.navigationTrace.set(portal, events.slice(-12));
    } catch { /* Invalid URLs never enter diagnostics. */ }
  }

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

  /** Atomically reserves this profile across worker processes, including workers on another database. */
  async reserve(): Promise<void> {
    if (this.profileLock) return;
    if (this.profileLockPending) return this.profileLockPending;
    const pending = this.acquireReservation();
    this.profileLockPending = pending;
    try {
      await pending;
    } finally {
      if (this.profileLockPending === pending) this.profileLockPending = null;
    }
  }

  private async acquireReservation(): Promise<void> {
    const directory = resolve(this.options.profileDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = join(directory, ".goldis-worker.lock");
    let lock: FileHandle;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new Error("WORKER_PROFILE_ALREADY_IN_USE");
      }
      throw new Error("WORKER_PROFILE_LOCK_UNAVAILABLE");
    }
    try {
      await lock.writeFile(JSON.stringify({ sessionId: this.sessionId, processId: process.pid, startedAt: new Date().toISOString() }));
      await lock.sync();
      this.profileLock = lock;
      this.profileLockPath = lockPath;
    } catch {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw new Error("WORKER_PROFILE_LOCK_UNAVAILABLE");
    }
  }

  private async releaseReservation(): Promise<void> {
    const lock = this.profileLock;
    const lockPath = this.profileLockPath;
    this.profileLock = null;
    this.profileLockPath = null;
    await lock?.close().catch(() => undefined);
    if (!lockPath) return;
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as { sessionId?: unknown };
      if (owner.sessionId === this.sessionId) await unlink(lockPath);
    } catch {
      // Leave an unreadable or replaced lock in place; a later worker must fail closed.
    }
  }

  async open(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.opening) return this.opening;
    await this.reserve();
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
          if (owner) { this.blockedNavigation.add(owner); this.traceNavigation(owner, "blocked", request.url()); }
          return route.abort("blockedbyclient");
        }
        this.traceNavigation(owner, "navigation", request.url());
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
    page.on("response", response => {
      try {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          this.traceNavigation(portal, "response", response.url(), response.status());
        }
      } catch { /* Detached frames have no useful diagnostic. */ }
    });
    if (this.navigationPolicy) page.on("popup", popup => {
      this.blockedNavigation.add(portal);
      void popup.close().catch(() => undefined);
    });
    return page;
  }

  async close(): Promise<void> {
    try {
      const context = this.context ?? await this.opening;
      await context?.close();
    } finally {
      this.context = null;
      this.opening = null;
      this.pages.clear();
      await this.releaseReservation();
    }
  }
}
