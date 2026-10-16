"use strict";

const paths = ["/api/health/live", "/api/health/ready", "/api/health/automation", "/api/health/enrichment"];

function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("RUNTIME_CHECK_BASE_URL_INVALID"); }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!(["https:"].includes(url.protocol) || (local && url.protocol === "http:")) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) throw new Error("RUNTIME_CHECK_BASE_URL_INVALID");
  return url;
}

async function getJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: "application/json" } });
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > 16_384) return { httpOk: false, body: null };
    let body = null;
    try { body = JSON.parse(raw); } catch { /* report a safe failed check */ }
    return { httpOk: response.ok, body };
  } catch {
    return { httpOk: false, body: null };
  } finally { clearTimeout(timer); }
}

async function runRuntimeCheck(options = {}) {
  const url = validateBaseUrl(options.baseUrl || process.env.GOLDIS_RUNTIME_BASE_URL || "https://goldis.example.com");
  const timeoutMs = options.timeoutMs ?? Number(process.env.GOLDIS_RUNTIME_TIMEOUT_MS || 3000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10_000) throw new Error("RUNTIME_CHECK_TIMEOUT_INVALID");
  const expectedProvider = options.expectedProvider ?? process.env.GOLDIS_EXPECT_ENRICHMENT_PROVIDER ?? "mf-vat";
  if (!new Set(["mf-vat", "disabled"]).has(expectedProvider)) throw new Error("RUNTIME_CHECK_PROVIDER_INVALID");
  const expectPortalLive = options.expectPortalLive ?? process.env.GOLDIS_EXPECT_PORTAL_LIVE === "1";
  const fetchImpl = options.fetchImpl || fetch;
  const [live, ready, automation, enrichment] = await Promise.all(paths.map((path) => getJson(fetchImpl, new URL(path, url), timeoutMs)));
  const checks = {
    live: live.httpOk && live.body?.status === "alive",
    ready: ready.httpOk && ready.body?.status === "ready",
    services: automation.httpOk && automation.body?.servicesReady === true,
    portalWorkerOnline: automation.body?.worker === "online",
    portalMode: ["off", "live", "unknown"].includes(automation.body?.portalMode) ? automation.body.portalMode : "unknown",
    portalLive: automation.body?.automationReady === true,
    enrichmentAvailable: enrichment.httpOk && enrichment.body?.available === true,
    enrichmentProvider: typeof enrichment.body?.providerName === "string" ? enrichment.body.providerName : null,
  };
  const expectedEnrichment = expectedProvider === "disabled"
    ? checks.enrichmentProvider === null
    : checks.enrichmentProvider === expectedProvider;
  const passed = checks.live && checks.ready && checks.services && checks.enrichmentAvailable && expectedEnrichment
    && (!expectPortalLive || checks.portalLive);
  return {
    status: passed ? "pass" : "fail",
    checkedAt: new Date(options.now ?? Date.now()).toISOString(),
    targetHost: url.host,
    checks,
    policy: { expectedEnrichmentProvider: expectedProvider, expectPortalLive },
  };
}

async function main() {
  try {
    const report = await runRuntimeCheck();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error && /^RUNTIME_CHECK_[A-Z0-9_]+$/.test(error.message) ? error.message : "RUNTIME_CHECK_FAILED"}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) void main();

module.exports = { runRuntimeCheck, validateBaseUrl };
