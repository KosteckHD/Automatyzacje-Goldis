// Read-only UI audit. All API responses are synthetic; no customer services are used.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const root = path.resolve(__dirname, '../..');
const { chromium } = require(path.join(root, 'node_modules/playwright'));
const fixturePath = path.join(root, 'docs/design/goldis/implemented-chat-2026-10-11/capture-review-2026-10-12.cjs');
const fixture = new Module(fixturePath, module);
fixture.filename = fixturePath;
fixture.paths = Module._nodeModulePaths(path.dirname(fixturePath));
fixture._compile(fs.readFileSync(fixturePath, 'utf8').replace(/main\(\)\.catch\([\s\S]*$/, 'module.exports = { responseFor };'), fixturePath);
const { responseFor } = fixture.exports;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: path.join(root, 'apps/web'), stdio: 'ignore', windowsHide: true,
    env: { ...process.env, NODE_ENV: 'production', API_INTERNAL_URL: 'http://127.0.0.1:1' },
  });
  let browser;
  const results = [];
  const errors = [];
  const unexpected = new Set();
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await fetch(base)).ok) break; } catch {}
      await delay(200);
    }
    browser = await chromium.launch({ headless: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
      const context = await browser.newContext({ viewport });
      let role = 'manager';
      let healthFailure = false;
      let toolsFailure = false;
      await context.route('**/api/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        let answer;
        if (url.pathname === '/api/health/automation') answer = healthFailure
          ? [503, { message: 'synthetic outage' }]
          : [200, { automationReady: false, servicesReady: true, worker: 'offline', portalMode: 'off', portalConfig: 'valid', message: 'Automatyzacja jest wyłączona.' }];
        else if (url.pathname === '/api/leads/allocation-summary') answer = [200, { availableCount: 42, checkedAt: new Date().toISOString(), resultSetId: null }];
        else if (url.pathname === '/api/auth/recovery-status') answer = [200, { enabled: false }];
        else if (url.pathname === '/api/tools' && toolsFailure) answer = [503, { message: 'synthetic outage' }];
        else answer = responseFor(url.pathname, url, request.method(), role, request);
        if (answer[0] === 404) unexpected.add(url.pathname);
        await route.fulfill({ status: answer[0], contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(answer[1]) });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push({ viewport, url: page.url(), message: error.message }));
      async function capture(name, route, asRole = 'manager') {
        role = asRole;
        await page.goto(base + route, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1100);
        await page.screenshot({ path: path.join(__dirname, `${name}-${viewport.width}.png`), fullPage: true, animations: 'disabled' });
        const scan = await page.evaluate(() => {
          const visible = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const elements = [...document.querySelectorAll('a,button,input,select,textarea')].filter(visible);
          const controls = elements.map(element => {
            const rect = element.getBoundingClientRect();
            const name = element.getAttribute('aria-label') || [...(element.labels || [])].map(label => label.textContent).join(' ') || element.textContent || element.getAttribute('title') || '';
            return { tag: element.tagName, name: name.trim().slice(0, 90), width: Math.round(rect.width), height: Math.round(rect.height) };
          });
          return {
            width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            smallControls: controls.filter(control => control.width < 24 || control.height < 24),
            controlsBelow44: controls.filter(control => control.width < 44 || control.height < 44).length,
            unnamedControls: controls.filter(control => !control.name),
            headings: [...document.querySelectorAll('h1,h2,h3')].filter(visible).map(element => element.textContent),
            alerts: [...document.querySelectorAll('[role=alert]')].filter(visible).map(element => element.textContent),
          };
        });
        results.push({ name, route, role, viewport, ...scan });
        console.log('CAPTURE', name, viewport.width, JSON.stringify({ overflow: scan.scrollWidth > scan.width, alerts: scan.alerts }));
      }
      await capture('login', '/', null);
      await capture('dashboard', '/dashboard');
      await capture('tools', '/tools');
      await capture('oc', '/tools/oc-policy-verification', 'operator');
      await capture('results', '/results/oc-policy-verification');
      await capture('review', '/review', 'reviewer');
      await capture('account', '/account', 'operator');
      await capture('team', '/team');
      healthFailure = true;
      await capture('oc-health-outage', '/tools/oc-policy-verification', 'operator');
      results.at(-1).healthText = await page.locator('.automation-status').allTextContents().catch(() => []);
      results.at(-1).bodyText = await page.locator('body').innerText();
      healthFailure = false;
      toolsFailure = true;
      await capture('tools-outage', '/tools');
      toolsFailure = false;
      await context.close();
    }
    fs.writeFileSync(path.join(__dirname, 'ui-results.json'), JSON.stringify({ source: 'Current production Next build, Chromium, synthetic API only', capturedAt: new Date().toISOString(), results, errors, unexpected: [...unexpected] }, null, 2));
    console.log('AUDIT_COMPLETE', JSON.stringify({ captures: results.length, errors, unexpected: [...unexpected] }));
  } finally {
    await browser?.close();
    server.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
