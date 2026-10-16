import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { BrowserSession } from "../../infrastructure/browser/browser";
import { isAllowedPortalNavigation } from "./portal-navigation";

const pzu = { entryUrl: "https://goldis.test/everest", allowedOrigins: ["https://goldis.test", "https://login.goldis.test"] };
const compensa = { entryUrl: "https://compensa.test/Portal", allowedOrigins: ["https://compensa.test"] };

test("navigation allows application and configured SSO but rejects unrelated paths, domains and schemes", () => {
  assert.equal(isAllowedPortalNavigation(pzu, pzu.entryUrl, true), true);
  assert.equal(isAllowedPortalNavigation(pzu, `${pzu.entryUrl}?session=fixture`, true), true);
  assert.equal(isAllowedPortalNavigation(pzu, "https://login.goldis.test/my.policy"), true);
  assert.equal(isAllowedPortalNavigation(pzu, "https://login.goldis.test/my.policy", true), false);
  for (const url of ["https://goldis.test/billing", "https://goldis.test/everest-admin", "https://goldis.test/everest/admin", "https://goldis.test/everest/../billing",
    "https://goldis.test.evil.test/everest", "http://goldis.test/everest", "https://user:password@goldis.test/everest",
    "https://goldis.test:444/everest", "javascript:alert(1)", "file:///tmp/test", "not a URL"]) {
    assert.equal(isAllowedPortalNavigation(pzu, url), false, url);
  }
});

for (const scenario of ["foreign_origin", "unrelated_path", "popup"] as const) {
  test(`browser blocks ${scenario} before its fixture receives a navigation and fences subsequent actions`, {
    skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "goldis-navigation-"));
    const requested: string[] = [];
    const browser = new BrowserSession({ profileDirectory: directory,
      launch: async (profile, options) => {
        const context = await chromium.launchPersistentContext(profile, options);
        await context.route("**/*", route => {
          requested.push(route.request().url());
          return route.fulfill({ status: 200, contentType: "text/html", body: '<main id="home">Fixture</main>' });
        });
        return context;
      },
    });
    try {
      browser.configureNavigationPolicy({ pzu, compensa });
      const page = await browser.page("pzu");
      await page.goto("https://login.goldis.test/my.policy");
      await assert.rejects(browser.assertNavigationAllowed("pzu", true), /PORTAL_NAVIGATION_BLOCKED/);
      await page.goto(pzu.entryUrl);
      await browser.assertNavigationAllowed("pzu", true);
      const target = scenario === "unrelated_path" ? "https://goldis.test/billing" : "https://evil.test/wrong";
      if (scenario === "popup") {
        const originalPageCount = (await browser.open()).pages().length;
        await page.evaluate(url => window.open(url, "_blank"), target);
        await page.waitForTimeout(200);
        assert.equal((await browser.open()).pages().length, originalPageCount, "the unrequested window is closed");
      } else {
        await assert.rejects(page.goto(target), /BLOCKED_BY_CLIENT|ERR_FAILED|blocked/i);
      }
      assert.equal(requested.includes(target), false);
      await assert.rejects(browser.assertNavigationAllowed("pzu"), /PORTAL_NAVIGATION_BLOCKED/);
      const other = await browser.page("compensa");
      await other.goto(compensa.entryUrl);
      await browser.assertNavigationAllowed("compensa", true);
      assert.throws(() => browser.configureNavigationPolicy({ pzu, compensa }), /ALREADY_SET/);
    } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
