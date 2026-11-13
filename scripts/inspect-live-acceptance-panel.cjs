"use strict";
// Inspect the isolated UI without printing account credentials or customer data.
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const { DIRECTORY, parseEnv } = require("./live-acceptance-18010-18020.cjs");

async function main() {
  const env = parseEnv(await fs.readFile(path.resolve(__dirname, "../.env.acceptance.local"), "utf8"));
  const report = JSON.parse(await fs.readFile(path.join(DIRECTORY, "report.json"), "utf8"));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const origin = "http://127.0.0.1:3100";
    const login = await context.request.post(origin + "/api/auth/login", { headers: { origin }, data: { username: env.GOLDIS_ADMIN_USER, password: env.GOLDIS_ADMIN_PASSWORD } });
    if (!login.ok()) throw new Error("ACCEPTANCE_UI_LOGIN_FAILED");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", () => errors.push("PAGE_ERROR"));
    const response = await page.goto(origin + "/imports/" + report.batchId, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.locator("main").first().waitFor({ state: "visible", timeout: 30000 });
    await page.getByText("Ładowanie panelu...", { exact: true }).waitFor({ state: "hidden", timeout: 60000 });
    await page.getByText(String(report.rows[0].rowNumber), { exact: true }).first().waitFor({ state: "visible", timeout: 30000 });
    await page.screenshot({ path: path.join(DIRECTORY, "panel-import.png"), fullPage: true });
    if (!response?.ok()) throw new Error("ACCEPTANCE_UI_PAGE_FAILED");
    const api = await context.request.get(origin + "/api/imports/" + report.batchId);
    if (!api.ok()) throw new Error("ACCEPTANCE_UI_WRONG_BACKEND");
    const text = await page.locator("body").innerText();
    console.log(JSON.stringify({ pageStatus: response.status(), authenticatedImportStatus: api.status(), correctImportUrl: page.url().endsWith(report.batchId), rowMarkers: report.rows.filter(row => text.includes(String(row.rowNumber))).map(row => row.rowNumber), javascriptErrors: errors.length, screenshotSaved: true }));
  } finally { await browser.close(); }
}
main().catch(e => { console.error(/^[A-Z_]+$/.test(e.message) ? e.message : "ACCEPTANCE_UI_CHECK_FAILED", String(e.message).split("\n")[0].slice(0, 180)); process.exitCode = 1; });
