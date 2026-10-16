import type { Locator, Page } from "playwright";

/** An ambiguous selector must never choose a portal write target by document order. */
export async function uniquePortalLocator(page: Page, selector: string): Promise<Locator> {
  const locator = page.locator(selector);
  if (await locator.count() !== 1) throw new Error("PORTAL_SELECTOR_NOT_UNIQUE");
  return locator;
}

export async function uniquePortalMarkerVisible(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector);
  const count = await locator.count();
  if (count > 1) throw new Error("PORTAL_SELECTOR_NOT_UNIQUE");
  return count === 1 && await locator.isVisible();
}

/** Await an API-rendered action, but never resolve ambiguity by choosing first. */
export async function waitForUniquePortalAction(page: Page, selector: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) throw new Error("PORTAL_ACTION_ABORTED");
    const target = page.locator(selector);
    const count = await target.count();
    if (count > 1) throw new Error("PORTAL_SELECTOR_NOT_UNIQUE");
    if (count === 1 && await target.isVisible() && await target.isEnabled()
      && await target.getAttribute("aria-disabled") !== "true") return target;
    if (Date.now() >= deadline) throw new Error("PORTAL_ACTION_UNAVAILABLE");
    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}
