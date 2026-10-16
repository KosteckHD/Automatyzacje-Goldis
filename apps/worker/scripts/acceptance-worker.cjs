"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { startRunWorker } = require("../dist/run-worker.js");
const { loadPortalRuntimeConfig } = require("../dist/portals/shared/portal-runtime-config.js");

async function envFile(file) {
  const result = {};
  for (const line of (await fs.readFile(file, "utf8")).split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) result[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return result;
}
function merge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object") merge(target[key], value);
    else target[key] = value;
  }
}

async function main() {
  const root = path.resolve(__dirname, "../../..");
  let loginTestRunId = process.env.ACCEPTANCE_PZU_LOGIN_RUN_ID;
  const fullAcceptance = process.env.ACCEPTANCE_FULL_RUN === "1";
  Object.assign(process.env, await envFile(path.join(root, ".env.local")));
  if (process.env.ACCEPTANCE_DOCKER_BRIDGE === "1") {
    const { execFileSync } = require("node:child_process");
    const inspect = name => JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8" }))[0];
    const worker = inspect("goldis-automatyzacje-worker-1");
    const dockerEnv = Object.fromEntries(worker.Config.Env.map(item => { const i = item.indexOf("="); return [item.slice(0, i), item.slice(i + 1)]; }));
    for (const key of ["DATABASE_URL", "REDIS_URL", "WORKER_AUTH_SECRET", "WORKER_STAGING_KEY_VERSION", "WORKER_STAGING_KEY_V1", "PESEL_ENCRYPTION_ACTIVE_KEY_VERSION", "PESEL_ENCRYPTION_KEYS_BASE64"]) process.env[key] = dockerEnv[key];
    for (const [key, container, port] of [["DATABASE_URL", "postgres", "5432/tcp"], ["REDIS_URL", "redis", "6379/tcp"]]) {
      const binding = inspect(`goldis-automatyzacje-${container}-1`).NetworkSettings.Ports[port]?.find(item => item.HostIp === "127.0.0.1");
      if (!binding) throw new Error("ACCEPTANCE_LOCAL_PORT_MISSING");
      const url = new URL(process.env[key]); url.hostname = "127.0.0.1"; url.port = binding.HostPort;
      process.env[key] = url.toString();
    }
    process.env.GOLDIS_API_READY_URL = "http://127.0.0.1:3001/api/health/ready";
    process.env.WORKER_RESULT_API_URL = "http://127.0.0.1:3001";
    process.env.WORKER_INTERNAL_HOST = "0.0.0.0";
    process.env.WORKER_INTERNAL_PORT = "3022";
    process.env.WORKER_HEADLESS = "0";
  }
  const credentials = await envFile(path.join(root, ".env"));
  // Windows packaged applications can redirect LocalAppData. Configure the
  // actual staging directory; retain the store's symlink/path checks.
  if (process.platform === "win32" && process.env.WORKER_STAGING_DIR) {
    await fs.mkdir(process.env.WORKER_STAGING_DIR, { recursive: true, mode: 0o700 });
    process.env.WORKER_STAGING_DIR = await fs.realpath(process.env.WORKER_STAGING_DIR);
  }
  if (fullAcceptance) {
    if (loginTestRunId || process.env.ACCEPTANCE_SUPERVISED_STEPS !== "1") throw new Error("FULL_ACCEPTANCE_REQUIRES_PAUSED_QUEUE");
    delete process.env.WORKER_PZU_LOGIN_TEST_RUN_ID;
  }
  for (const key of ["PZU_LOGIN", "PZU_PASSWORD", "COMPENSA_LOGIN", "COMPENSA_PASSWORD"]) process.env[key] = credentials[key];
  process.env.WORKER_LIVE_PORTALS = "1";
  process.env.WORKER_PORTAL_CONFIG_PATH = path.join(root, "exports/live-acceptance/candidate-portals.json");
  if (fullAcceptance) {
    const { execFileSync } = require("node:child_process");
    execFileSync(process.execPath, [path.join(root, "scripts/prepare-acceptance-portal-config.cjs")], { stdio: "pipe" });
    console.log("FULL_ACCEPTANCE_CONFIG_REGENERATED_FROM_OBSERVED_SELECTORS");
  }
  if (loginTestRunId) {
    if (!/^[0-9a-f-]{36}$/i.test(loginTestRunId)) throw new Error("PZU_LOGIN_TEST_RUN_ID_INVALID");
    process.env.WORKER_PZU_LOGIN_TEST_RUN_ID = loginTestRunId;
  }
  if (process.env.ACCEPTANCE_PZU_EXISTING_PROFILE) {
    if (process.env.ACCEPTANCE_SUPERVISED_STEPS !== "1") throw new Error("PZU_PROFILE_REOPEN_REQUIRES_PAUSED_QUEUE");
    const parent = await fs.realpath(path.join(process.env.LOCALAPPDATA, "Goldis"));
    const selected = await fs.realpath(process.env.ACCEPTANCE_PZU_EXISTING_PROFILE);
    if (path.dirname(selected).toLowerCase() !== parent.toLowerCase() || !/^pzu-login-[a-z0-9]+$/i.test(path.basename(selected))) throw new Error("PZU_TEST_PROFILE_SCOPE_INVALID");
    process.env.WORKER_PROFILE_DIR = selected;
    if (!fullAcceptance) process.env.ACCEPTANCE_FRESH_PZU_SESSION = "1";
    console.log("EXISTING_PZU_TEST_PROFILE_REOPENED");
  } else if (process.env.ACCEPTANCE_FRESH_PZU_SESSION === "1") {
    if (process.env.ACCEPTANCE_SUPERVISED_STEPS !== "1") throw new Error("FRESH_PZU_SESSION_REQUIRES_PAUSED_QUEUE");
    process.env.WORKER_PROFILE_DIR = await fs.mkdtemp(path.join(process.env.LOCALAPPDATA, "Goldis", "pzu-login-"));
    console.log("FRESH_ISOLATED_PZU_PROFILE_SELECTED");
  }
  const runtime = await startRunWorker({ startPaused: process.env.ACCEPTANCE_SUPERVISED_STEPS === "1" });
  if (process.env.ACCEPTANCE_SUPERVISED_STEPS === "1") {
    await runtime.worker.pause();
    console.log("QUEUE_CONSUMPTION_PAUSED_FOR_SUPERVISED_PORTAL_STEPS");
  }
  const supervisedState = {};
  console.log("SUPERVISED_ACCEPTANCE_PRODUCTION_QUEUE_WORKER_READY");
  console.log("Only this worker owns the configured profile. Candidate selectors are not certified production configuration.");
  let portal = "pzu";
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    for await (const line of input) {
      try {
        const command = line.trim();
        if (command === "quit") break;
        if (command.startsWith("start-platform-test ")) {
          const selectedRunIds = command.slice("start-platform-test ".length).split(",");
          if (!fullAcceptance || !runtime.worker.isPaused() || selectedRunIds.length > 2 || new Set(selectedRunIds).size !== selectedRunIds.length || selectedRunIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw new Error("FULL_TEST_BINDING_INVALID");
          const active = (await runtime.pool.query("SELECT id,row_number,tool_id FROM automation_runs WHERE status IN ('queued','validating','awaiting_portal_adapter','pzu_login','everest_search','compensa_login','compensa_form','ufg_verification','reading_oc','export_ready') AND control_state='running'")).rows;
          if (active.length !== selectedRunIds.length || active.some(run => !selectedRunIds.includes(run.id) || ![18001,18002].includes(run.row_number) || run.tool_id !== "oc-policy-verification") || new Set(active.map(run => run.row_number)).size !== selectedRunIds.length) throw new Error("FULL_TEST_REQUIRES_EXACT_ACTIVE_TARGETS");
          await runtime.worker.resume();
          console.log(`FULL_PLATFORM_TEST_QUEUE_RESUMED_${selectedRunIds.length}_TARGETS`);
          continue;
        }
        if (command.startsWith("bind-pzu-platform-test ")) {
          const selectedRunId = command.slice("bind-pzu-platform-test ".length);
          if (!loginTestRunId || !runtime.worker.isPaused() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selectedRunId)) throw new Error("PZU_TEST_BINDING_INVALID");
          const selected = (await runtime.pool.query("SELECT id FROM automation_runs WHERE id=$1 AND status='queued' AND tool_id='oc-policy-verification' AND row_number=18001", [selectedRunId])).rows[0];
          if (!selected) throw new Error("PZU_TEST_QUEUED_RUN_REQUIRED");
          loginTestRunId = selectedRunId;
          process.env.WORKER_PZU_LOGIN_TEST_RUN_ID = selectedRunId;
          console.log("PZU_LOGIN_TEST_RUN_BOUND_WHILE_QUEUE_PAUSED");
          continue;
        }
        if (command === "start-pzu-platform-test") {
          if (!loginTestRunId) throw new Error("PZU_LOGIN_TEST_RUN_ID_REQUIRED");
          await runtime.worker.resume();
          console.log("PZU_PLATFORM_LOGIN_TEST_QUEUE_RESUMED");
          continue;
        }
        if (["pzu", "compensa"].includes(command)) {
          if (process.env.ACCEPTANCE_FRESH_PZU_SESSION === "1" && command !== "pzu") throw new Error("PZU_LOGIN_ONLY_SESSION");
          portal = command; continue;
        }
        if (command.startsWith("step ")) {
          if (process.env.ACCEPTANCE_SUPERVISED_STEPS !== "1") throw new Error("SUPERVISED_STEPS_DISABLED");
          const actionsPath = path.join(__dirname, "supervised-portal-steps.cjs");
          delete require.cache[require.resolve(actionsPath)];
          await require(actionsPath)({ command: command.slice(5), runtime, root, state: supervisedState });
          continue;
        }
        if (command === "screenshot") {
          const page = await runtime.browser.page(portal);
          await page.screenshot({ path: path.join(root, `exports/live-acceptance/${portal}-supervised.png`) });
          console.log("PRIVATE_SCREENSHOT_SAVED");
          continue;
        }
        if (command === "reload") {
          const replacement = await loadPortalRuntimeConfig(process.env.WORKER_PORTAL_CONFIG_PATH);
          await runtime.worker.pause();
          try { merge(runtime.liveConfig, replacement); }
          finally { if (process.env.ACCEPTANCE_SUPERVISED_STEPS !== "1") await runtime.worker.resume(); }
          console.log("PILOT_SELECTORS_RELOADED_WITHOUT_BROWSER_RESTART");
          continue;
        }
        const page = await runtime.browser.page(portal);
        if (page.url() === "about:blank") { console.log("PORTAL_NOT_OPENED_BY_RUN_YET"); continue; }
        const selectors = command === "inspect" ? "input,button,select,a,iframe,label,h1,h2,h3,h4" : JSON.parse(command).selector;
        if (typeof selectors !== "string") throw new Error("READ_ONLY_SELECTOR_REQUIRED");
        const locator = page.locator(selectors);
        const nodes = await locator.evaluateAll(elements => elements.filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .slice(0, 100).map(element => ({ tag: element.tagName.toLowerCase(), id: element.id,
            className: typeof element.className === "string" ? element.className : "", type: element.getAttribute("type"),
            name: element.getAttribute("name"), placeholder: element.getAttribute("placeholder"),
            textLength: element.textContent.trim().length,
            looksLikeCaseNumber: /^[\p{L}\p{N}._/-]{5,200}$/u.test(element.textContent.trim()) && /\d/.test(element.textContent),
            label: /^(?:Imię|Nazwisko|PESEL|Adres|Kod pocztowy|Miasto|Powiat|Zapisz|Weryfikacja UFG|Szczegóły|Numer oferty|Nr oferty|Ubezpieczający|Compensa Komunikacja)$/i.test(element.textContent.trim()) ? element.textContent.trim() : "",
            parent: element.parentElement ? { tag: element.parentElement.tagName.toLowerCase(), className: element.parentElement.className, id: element.parentElement.id } : null,
          })));
        console.log(JSON.stringify({ portal, origin: new URL(page.url()).origin, count: await locator.count(), nodes }));
      } catch { console.log("ACCEPTANCE_WORKER_INSPECTION_FAILED"); }
    }
  } finally { input.close(); await runtime.shutdown(); }
}
main().catch(error => { console.error(/^[A-Z][A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "ACCEPTANCE_WORKER_START_FAILED"); process.exitCode = 1; });
