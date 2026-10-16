"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { runRuntimeCheck, validateBaseUrl } = require("./runtime-check.cjs");

test("runtime check accepts API, queue, MF VAT health while portal live mode is intentionally off", async () => {
  const bodies = [
    { status: "alive" }, { status: "ready" },
    { servicesReady: true, worker: "online", portalMode: "off", automationReady: false },
    { available: true, worker: "ready", providerName: "mf-vat" },
  ];
  const report = await runRuntimeCheck({
    baseUrl: "https://goldis.example.test", expectedProvider: "mf-vat", expectPortalLive: false, now: 0,
    fetchImpl: async () => new Response(JSON.stringify(bodies.shift()), { status: 200 }),
  });
  assert.equal(report.status, "pass");
  assert.equal(report.checks.portalMode, "off");
  assert.equal(report.checkedAt, "1970-01-01T00:00:00.000Z");
});

test("runtime check fails closed for a missing dependency and never echoes response details", async () => {
  const privateMarker = "SYNTHETIC_PRIVATE_RESPONSE_BODY";
  const bodies = [
    { status: "alive", diagnostic: privateMarker }, { status: "not_ready", diagnostic: privateMarker },
    { servicesReady: false, worker: "offline", diagnostic: privateMarker },
    { available: false, providerName: null, diagnostic: privateMarker },
  ];
  const report = await runRuntimeCheck({
    baseUrl: "https://goldis.example.test", now: 0,
    fetchImpl: async () => new Response(JSON.stringify(bodies.shift()), { status: 503 }),
  });
  assert.equal(report.status, "fail");
  assert.equal(JSON.stringify(report).includes(privateMarker), false);
});

test("runtime check requires HTTPS for a remote host and accepts local HTTP only", () => {
  assert.throws(() => validateBaseUrl("http://goldis.example.test"), /RUNTIME_CHECK_BASE_URL_INVALID/);
  assert.equal(validateBaseUrl("http://127.0.0.1:3000").host, "127.0.0.1:3000");
});
