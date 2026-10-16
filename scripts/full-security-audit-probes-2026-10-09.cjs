"use strict";

// Bounded, synthetic probes. No live services, .env, portal or customer data.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const root = path.resolve(__dirname, "..");
const evidenceDirectory = path.join(root, "docs/security/full-audit-2026-10-09");

async function spreadsheetProbe() {
  const ExcelJS = require("exceljs");
  const JSZip = require("jszip");
  const { validateWorkbookArchive } = require("../apps/api/dist/features/imports/workbook-archive");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["Nazwa", "REGON"]);
  sheet.addRow(["Synthetic Company", "012345678"]);
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const sheetPath = "xl/worksheets/sheet1.xml";
  const xml = await zip.file(sheetPath).async("string");
  zip.file(sheetPath, xml.replace("</worksheet>", '<mergeCells count="1"><mergeCell ref="A3:XFD1000"/></mergeCells></worksheet>'));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await validateWorkbookArchive(bytes);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "goldis-full-audit-xlsx-"));
  try {
    const file = path.join(directory, "synthetic.xlsx");
    await fs.writeFile(file, bytes);
    const code = 'const fs=require("node:fs"); const {parseTransportWorkbook}=require("./apps/api/dist/features/imports/workbook"); parseTransportWorkbook(fs.readFileSync(process.argv[1])).then(rows=>console.log(JSON.stringify({rows:rows.length}))).catch(e=>{console.log(e.code||e.message);process.exitCode=2});';
    const started = Date.now();
    const child = spawnSync(process.execPath, ["--max-old-space-size=96", "-e", code, file], {
      cwd: root, timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "postgres://synthetic:unused@127.0.0.1:1/audit", WORKER_LIVE_PORTALS: "0" },
    });
    const result = {
      compressedBytes: bytes.length, physicalRows: 2, physicalCells: 4,
      mergedRange: "A3:XFD1000", impliedMergedCells: 16384 * 998,
      archiveValidation: "accepted", isolatedParserHeapLimitMiB: 96,
      parserExitCode: child.status, parserSignal: child.signal,
      parserTimeout: child.error?.code === "ETIMEDOUT", elapsedMs: Date.now() - started,
      outOfMemory: /heap out of memory|Reached heap limit|Allocation failed/i.test(child.stderr || ""),
      stdout: (child.stdout || "").slice(0, 500),
    };
    assert.ok(result.outOfMemory || result.parserTimeout, "expected bounded child to exhaust memory or time");
    return result;
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("goldis-full-audit-xlsx-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function forwardingProbe() {
  const express = require("express");
  const { apiRequestBudgetMiddleware, trustedProxyAddresses } = require("../apps/api/dist/infrastructure/http/index");
  const counts = new Map();
  const app = express();
  const proxies = new Set(trustedProxyAddresses("127.0.0.1,::1"));
  app.set("trust proxy", address => proxies.has(address.replace(/^::ffff:/, "")));
  // Small synthetic budget; production uses the same request.ip with Redis and limit 300.
  app.use("/api", apiRequestBudgetMiddleware(async ip => {
    const count = (counts.get(ip) || 0) + 1;
    counts.set(ip, count);
    return { allowed: count <= 3, retryAfterSeconds: 60 };
  }));
  app.get("/api/audit-ip", (req, res) => res.json({ ip: req.ip }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const webDirectory = path.join(root, "apps/web");
  const isolated = path.join(webDirectory, ".full-security-audit-" + randomUUID());
  let child;
  let browser;
  try {
    await fs.mkdir(isolated);
    await fs.cp(path.join(webDirectory, ".next"), path.join(isolated, ".next"), {
      recursive: true, filter: source => !source.startsWith(path.join(webDirectory, ".next/cache")),
    });
    await fs.copyFile(path.join(webDirectory, "package.json"), path.join(isolated, "package.json"));
    const manifestPath = path.join(isolated, ".next/routes-manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    for (const entries of Object.values(manifest.rewrites)) {
      for (const entry of entries) if (entry.source === "/api/:path*") entry.destination = apiBase + "/api/:path*";
    }
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const requiredPath = path.join(isolated, ".next/required-server-files.json");
    const required = JSON.parse(await fs.readFile(requiredPath, "utf8"));
    required.appDir = isolated;
    await fs.writeFile(requiredPath, JSON.stringify(required));
    const net = require("node:net");
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const environment = { ...process.env, NODE_ENV: "production", API_INTERNAL_URL: apiBase, NEXT_TELEMETRY_DISABLED: "1" };
    for (const key of Object.keys(environment)) {
      if (/SECRET|PASSWORD|PESEL_ENCRYPTION|STAGING_KEY|GUS_BIR_USER_KEY|CACHE_HMAC_KEY|^DATABASE_URL$|^REDIS_URL$/.test(key)) delete environment[key];
    }
    child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", isolated, "-H", "127.0.0.1", "-p", String(port)], {
      cwd: isolated, env: environment, stdio: "ignore", windowsHide: true,
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("AUDIT_NEXT_EXITED");
      try { if ((await fetch(base)).status === 200) { ready = true; break; } } catch {}
      await delay(200);
    }
    assert.ok(ready);
    const checks = [];
    for (const suppliedIp of ["198.51.100.10", "198.51.100.10", "198.51.100.10", "198.51.100.10", "198.51.100.11"]) {
      const response = await fetch(base + "/api/audit-ip", { headers: { "x-forwarded-for": suppliedIp } });
      checks.push({ suppliedIp, status: response.status, body: await response.json() });
    }
    assert.deepEqual(checks.map(check => check.status), [200, 200, 200, 429, 200]);
    assert.equal(checks[0].body.ip, checks[0].suppliedIp);
    browser = await require("playwright").chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route(base + "/", async route => {
      const response = await route.fetch();
      const html = (await response.text()).replace("<head>", "<head><script>window.__fullAuditInlineExecuted=1</script>");
      await route.fulfill({ response, body: html });
    });
    const document = await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    const headers = document.headers();
    assert.ok(headers["content-security-policy"]?.includes("'strict-dynamic'"));
    assert.ok(!headers["content-security-policy"].includes("'unsafe-eval'"));
    assert.equal(headers["cache-control"], "private, no-store");
    assert.equal(headers["x-frame-options"], "DENY");
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(await page.evaluate(() => window.__fullAuditInlineExecuted), undefined);
    const browserSecurity = { inlineScriptBlocked: true, cspStrictDynamic: true, unsafeEval: false,
      noStore: true, frameDenied: true, nosniff: true, limitation: "Injected HTML in synthetic browser; no stored-XSS or real DB tested." };
    return { productionNextBuildCopy: true, backendTrustsImmediateWebProxy: true, syntheticIpBudget: 3, checks, browserSecurity,
      limitation: "Synthetic backend matches API trust and middleware; no real Redis, live application or external edge used." };
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(isolated)), path.resolve(webDirectory));
    assert.ok(path.basename(isolated).startsWith(".full-security-audit-"));
    await fs.rm(isolated, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function keyConfigurationProbe() {
  const { inspectRuntimeEnvironment } = require("./preflight-contract.cjs");
  const { encryptPesel } = require("../packages/core/dist/pesel-crypto");
  const keyring = Buffer.from(JSON.stringify({ "local-v1": Buffer.alloc(32, 7).toString("base64") })).toString("base64");
  const environment = {
    DATABASE_URL: "postgres://synthetic:unused@127.0.0.1:1/audit", REDIS_URL: "redis://127.0.0.1:1/15",
    WORKER_AUTH_SECRET: "synthetic-only-worker-secret-with-more-than-32-bytes",
    WORKER_PROFILE_DIR: path.join(os.tmpdir(), "synthetic-profile"), PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "local-v1", PESEL_ENCRYPTION_KEYS_BASE64: keyring, WORKER_LIVE_PORTALS: "0",
  };
  const preflight = inspectRuntimeEnvironment(environment);
  assert.deepEqual(preflight.errors, []);
  let encryptionError;
  try { encryptPesel("01234567890", { runId: randomUUID(), sourceRowId: randomUUID() }, environment); }
  catch (error) { encryptionError = error.code; }
  assert.equal(encryptionError, "PESEL_ENCRYPTION_CONFIG_INVALID");
  return { reproducesGeneratedLocalVersion: "local-v1", preflight, encryptionError,
    limitation: "Synthetic configuration reproduces setup script; existing .env files not read or changed. Encryption fails closed." };
}

(async () => {
  await fs.mkdir(evidenceDirectory, { recursive: true });
  const result = { date: "2026-10-09", customerData: false, spreadsheet: await spreadsheetProbe(), forwarding: await forwardingProbe(), keyConfiguration: keyConfigurationProbe() };
  await fs.writeFile(path.join(evidenceDirectory, "new-probes.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
