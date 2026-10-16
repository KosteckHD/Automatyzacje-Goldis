"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { BrowserSession } = require("../apps/worker/dist/infrastructure/browser/browser");

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "goldis-chromium-sandbox-"));
  const browser = new BrowserSession({ profileDirectory: profile, headless: true, chromiumSandbox: true });
  try {
    const page = await browser.page("pzu");
    await page.setContent("<main>Chromium sandbox active</main>");
    assert.equal(await page.locator("main").textContent(), "Chromium sandbox active");
    process.stdout.write("CHROMIUM_SANDBOX_SMOKE_PASS\n");
  } finally {
    await browser.close();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  if (process.env.GOLDIS_SANDBOX_DIAGNOSTICS === "1" && error instanceof Error) {
    process.stderr.write(`${error.message.replace(/[\r\n]+/g, " ").slice(0, 3000)}\n`);
  }
  process.stderr.write("CHROMIUM_SANDBOX_SMOKE_FAILED\n");
  process.exitCode = 1;
});
