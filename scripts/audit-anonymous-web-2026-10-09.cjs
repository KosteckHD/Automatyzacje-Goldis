"use strict";
// Run against an isolated copy of the production build. Never rewrite the user's .next.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createServer } = require("node:net");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

module.exports = async function auditAnonymousWeb(apiBase, routes, marker) {
  const root = path.resolve(__dirname, "..");
  const webDirectory = path.join(root, "apps/web");
  const isolated = path.join(webDirectory, ".anonymous-audit-" + randomUUID());
  let child;
  let browser;
  const output = [];
  try {
    await fs.mkdir(isolated);
    await fs.cp(path.join(webDirectory, ".next"), path.join(isolated, ".next"), {
      recursive: true, filter: (source) => !source.startsWith(path.join(webDirectory, ".next/cache")),
    });
    await fs.copyFile(path.join(webDirectory, "package.json"), path.join(isolated, "package.json"));
    try { await fs.cp(path.join(webDirectory, "public"), path.join(isolated, "public"), { recursive: true }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const manifestPath = path.join(isolated, ".next/routes-manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    for (const items of Object.values(manifest.rewrites)) {
      for (const item of items) if (item.source === "/api/:path*") item.destination = apiBase + "/api/:path*";
    }
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const requiredPath = path.join(isolated, ".next/required-server-files.json");
    const required = JSON.parse(await fs.readFile(requiredPath, "utf8"));
    required.appDir = isolated;
    await fs.writeFile(requiredPath, JSON.stringify(required));
    const socket = createServer();
    await new Promise((resolve, reject) => socket.listen(0, "127.0.0.1", resolve).once("error", reject));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const base = `http://localhost:${port}`;
    const localRequire = createRequire(path.join(webDirectory, "package.json"));
    const nextBin = path.resolve(path.dirname(localRequire.resolve("next")), "../bin/next");
    const environment = { ...process.env, NODE_ENV: "production", API_INTERNAL_URL: apiBase, NEXT_TELEMETRY_DISABLED: "1" };
    for (const key of Object.keys(environment)) {
      if (/SECRET|PASSWORD|PESEL_ENCRYPTION|STAGING_KEY|GUS_BIR_USER_KEY|CACHE_HMAC_KEY|^DATABASE_URL$|^REDIS_URL$/.test(key)) delete environment[key];
    }
    child = spawn(process.execPath, [nextBin, "start", isolated, "-H", "127.0.0.1", "-p", String(port)], {
      cwd: isolated, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error("ANONYMOUS_NEXT_EXITED " + output.join(""));
      try { if ((await fetch(base)).status === 200) { ready = true; break; } } catch { /* local fixture starting */ }
      await delay(200);
    }
    assert.ok(ready, "isolated Next server must start");
    const proxyChecks = [];
    for (const route of routes.filter((route) => route.protectedBy !== "public")) {
      const response = await fetch(base + route.endpoint, { method: route.method, headers: {
        origin: process.env.PUBLIC_APP_ORIGIN, "content-type": "application/json",
      }, ...(route.method === "GET" ? {} : { body: "{}" }) });
      assert.ok([401, 403].includes(response.status), `Next rewrite ${route.method} ${route.template}: ${response.status}`);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.ok(!(await response.text()).includes(marker));
      proxyChecks.push({ method: route.method, route: route.template, status: response.status });
    }
    const guessedFiles = ["/.env", "/.git/config", "/exports/file.xlsx", "/uploads/file.xlsx", "/artifacts/file.xlsx", "/docs/source.xlsx"];
    const guessedFileChecks = [];
    for (const endpoint of guessedFiles) {
      const response = await fetch(base + endpoint);
      assert.equal(response.status, 404);
      assert.ok(!(await response.text()).includes(marker));
      guessedFileChecks.push({ endpoint, status: response.status });
    }
    const id = "11111111-1111-4111-8111-111111111111";
    const pages = ["/", "/account", "/admin", "/audit", "/imports", `/imports/${id}`, "/results", "/review", "/runs", `/runs/${id}`, `/submissions/${id}`, "/tools/oc-policy-verification"];
    const pageChecks = [];
    const { chromium } = require("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    for (const endpoint of pages) {
      const page = await context.newPage();
      const apiResponses = [];
      page.on("response", (response) => {
        if (response.url().startsWith(base + "/api/")) apiResponses.push({ url: response.url().slice(base.length), status: response.status() });
      });
      const [response] = await Promise.all([
        page.goto(base + endpoint, { waitUntil: "domcontentloaded", timeout: 15_000 }),
        page.waitForResponse((item) => item.url() === base + "/api/auth/me", { timeout: 15_000 }),
      ]);
      await page.locator("body").filter({ hasText: /zaloguj|sesja|nieprawidłow|nie udało|unauthorized|dostęp/i }).waitFor({ timeout: 10_000 });
      assert.equal(response.status(), 200);
      assert.equal(response.headers()["cache-control"], "private, no-store");
      assert.ok(!(await page.content()).includes(marker));
      assert.ok(apiResponses.some((item) => item.url === "/api/auth/me" && item.status === 401), `${endpoint}: must observe denied auth check`);
      assert.ok(apiResponses.every((item) => item.status === 401 || item.status === 403), `${endpoint}: unexpected anonymous private API success`);
      const observed = await page.locator("body").innerText();
      pageChecks.push({ endpoint, status: response.status(), authCheckStatus: 401,
        containsLoginOrDeniedMessage: /zaloguj|sesja|nieprawidłow|nie udało|unauthorized|dostęp/i.test(observed), apiResponses });
      await page.close();
    }
    const result = { auditDate: "2026-10-09", productionBuildCopy: true, customerData: false,
      fixture: "Isolated copy of existing production .next. API rewrite target changed ONLY in the copy to the synthetic audit API. No TLS proxy/VPS tested.",
      proxyChecks, guessedFileChecks, pageChecks, anonymousPageCustomerMarkerFound: false };
    await fs.writeFile(path.join(root, "docs/security/anonymous-web-evidence-2026-10-09.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(`ANONYMOUS_NEXT_BROWSER_PASS proxyRoutes=${proxyChecks.length} pages=${pageChecks.length} guessedFiles=${guessedFileChecks.length} privateMarkerFound=false`);
    return result;
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    assert.equal(path.dirname(path.resolve(isolated)), path.resolve(webDirectory));
    assert.ok(path.basename(isolated).startsWith(".anonymous-audit-"));
    await fs.rm(isolated, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
};
