const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

async function main() {
  const probe = createServer();
  await new Promise((ok, fail) => { probe.once("error", fail); probe.listen(0, "127.0.0.1", ok); });
  const port = probe.address().port;
  await new Promise((ok, fail) => probe.close((err) => err ? fail(err) : ok()));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(port)], {
    cwd: resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, NODE_ENV: "production" },
  });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch { /* starting */ }
      await new Promise((ok) => setTimeout(ok, 500));
    }
    assert.ok(ready, "Next server did not start");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const requests = [];
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.pathname + url.search);
      let body = { items: [], nextCursor: null };
      if (url.pathname === "/api/auth/me") body = { role: "admin", username: "demo", csrfToken: "synthetic", tools: [{ toolId: "oc-policy-verification", canExecute: true, canViewResults: true, canDownloadResults: true }, { toolId: "commission-comparison", canExecute: true, canViewResults: true, canDownloadResults: true }] };
      if (url.pathname === "/api/auth/recovery-status") body = { enabled: false };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.setViewportSize({ width: 1200, height: 560 });
    await page.goto(`${base}/imports`);
    await page.locator('.lead-sidebar').waitFor();
    await page.evaluate(() => { const marker = document.createElement('div'); marker.style.height = '1600px'; document.querySelector('.legacy-main').appendChild(marker); });
    console.log('BEFORE', JSON.stringify(await page.locator('.lead-sidebar').evaluate(el => ({top:el.getBoundingClientRect().top,height:el.getBoundingClientRect().height,position:getComputedStyle(el).position, parent:el.parentElement.getBoundingClientRect().height}))));
    await page.evaluate(() => window.scrollTo(0, 700));
    console.log('SCROLL', JSON.stringify(await page.locator('.lead-sidebar').evaluate(el => ({top:el.getBoundingClientRect().top,height:el.getBoundingClientRect().height, y:window.scrollY, navHeight:el.querySelector('.lead-sidebar-nav').clientHeight, navScroll:el.querySelector('.lead-sidebar-nav').scrollHeight}))));
    await page.getByRole('button', { name: 'Zwiń nawigację' }).click();
    await page.mouse.move(1100, 20);
    await page.waitForTimeout(400);
    console.log('COLLAPSED', JSON.stringify(await page.locator('.lead-sidebar').evaluate(el => ({width:el.getBoundingClientRect().width,main:document.querySelector('.legacy-main').getBoundingClientRect().x}))));
    return;
    await page.getByRole("button", { name: "Wyczyść filtry" }).waitFor();
    const labelColor = await page.getByLabel("Od dnia (Warszawa)").locator("..").evaluate((el) => getComputedStyle(el).color);
    assert.equal(labelColor, "rgb(81, 76, 67)");
    await page.getByRole("button", { name: "Wyczyść filtry" }).click();
    assert.equal(new URL(page.url()).search, "");
    assert.equal(await page.getByLabel("Od dnia (Warszawa)").inputValue(), "");
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    assert.ok(requests.some((request) => request.includes("status=failed")), "filtered history was requested");
    await page.goto(`${base}/odzyskaj-haslo`);
    await page.getByText("Odzyskiwanie hasła jest obecnie niedostępne.").waitFor();
    assert.equal(await page.locator(".auth-recovery-logo img").evaluate((img) => img.complete && img.naturalWidth > 0), true);
    assert.equal(await page.locator("html").evaluate((el) => el.scrollWidth <= innerWidth), true);
    await page.goto(`${base}/tools/commission-comparison`);
    const upload = page.getByText("Lista polis CRM", { exact: true }).first();
    await upload.waitFor();
    const uploadStyle = await upload.evaluate((el) => ({ text: getComputedStyle(el).color, surface: getComputedStyle(el.parentElement).backgroundColor }));
    assert.equal(uploadStyle.text, "rgb(37, 35, 30)");
    assert.equal(uploadStyle.surface, "rgb(250, 249, 246)");
    assert.equal(await page.locator("html").evaluate((el) => el.scrollWidth <= innerWidth), true);
    console.log("UI_POLISH_SMOKE_PASS historyClear=true readableLabels=true recoveryLogo=true commissionContrast=true mobile=true syntheticOnly=true");
  } finally {
    await browser?.close();
    server.kill();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

