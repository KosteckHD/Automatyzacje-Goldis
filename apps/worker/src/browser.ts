import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

export type Portal = "pzu" | "compensa";

export type BrowserSessionOptions = {
  profileDirectory: string;
  headless?: boolean;
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
      ...(this.options.channel ? { channel: this.options.channel } : {}),
      acceptDownloads: false,
      timezoneId: "Europe/Warsaw",
      locale: "pl-PL",
      viewport: { width: 1440, height: 900 },
    });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    return context;
  }

  async page(portal: Portal): Promise<Page> {
    const context = await this.open();
    const previous = this.pages.get(portal);
    if (previous && !previous.isClosed()) return previous;
    const page = await context.newPage();
    this.pages.set(portal, page);
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
