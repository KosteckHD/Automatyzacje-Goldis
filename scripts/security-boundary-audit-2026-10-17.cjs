"use strict";

// Local HTTP tests with real controllers/guards and synthetic business/storage adapters.
// Run after npm run build -w @goldis/api. Never reads .env or contacts live services.
Object.assign(process.env, {
  DATABASE_URL: "postgres://synthetic:unused@127.0.0.1:1/security_audit",
  SESSION_SECRET: "synthetic-security-audit-session-secret-20261017",
  WORKER_AUTH_SECRET: "synthetic-security-audit-worker-secret-20261017",
  PUBLIC_APP_ORIGIN: "https://audit.goldis.example",
  NODE_ENV: "production", TRUST_PROXY_IPS: "", WORKER_LIVE_PORTALS: "0",
  GOLDIS_ENRICHMENT_PROVIDER: "disabled",
});
delete process.env.REDIS_URL;
require("reflect-metadata");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHmac } = require("node:crypto");
const { Module } = require("@nestjs/common");
const { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } = require("@nestjs/core");
const { createServer } = require("node:http");
const { chromium } = require("playwright");
const { report } = require("./backend-refactor-inventory.cjs");
const api = (file) => require(path.resolve(__dirname, "../apps/api/dist", file));
const { SessionGuard } = api("features/auth/session.guard");
const { PermissionGuard } = api("features/authorization/authorization-guard");
const { AdminOnlyGuard } = api("features/admin/admin.support");
const { WorkerResultGuard } = api("features/results/worker-result.controller");
const { OperationalReportsGuard } = api("features/reports/admin-reports.controller");
const { canPerform } = api("features/authorization/authorization-policy");
const { createHttpApplication, RequestProtectionGuard, PublicExceptionFilter, PublicOutputInterceptor } = api("infrastructure/http");
const models = api("infrastructure/database/db");
const ids = { user: randomUUID(), tenant: randomUUID(), otherTenant: randomUUID(), otherUser: randomUUID(), resource: randomUUID(), session: randomUUID() };
const marker = "SYNTHETIC_PRIVATE_AUDIT_MARKER";
const csrf = "synthetic-security-audit-csrf-" + "A".repeat(40);
let currentRole = "operator";
let sessionActive = true;
let foreignTenant = false;
let foreignOwner = false;
let currentTool = "oc-policy-verification";
let businessCalls = 0;
function signed(claims = {}) {
  const payload = Buffer.from(JSON.stringify({ v: 2, sessionId: ids.session, userId: ids.user,
    tenantId: ids.tenant, csrf, exp: Date.now() + 3600_000, ...claims })).toString("base64url");
  return payload + "." + createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
}
const valid = signed();
const cookies = (value) => `goldis_session=${value}; goldis_csrf=${csrf}`;
const batch = () => ({ id: ids.resource, tenantId: foreignTenant ? ids.otherTenant : ids.tenant,
  ownerUserId: foreignOwner ? ids.otherUser : ids.user, toolId: currentTool });
models.ImportBatch.findByPk = async () => batch();
models.Tool.findByPk = async () => ({ toolId: currentTool, status: "available" });
models.ToolGrant.findOne = async () => ({ canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true });
models.AutomationRun.findByPk = async () => ({ id: ids.resource, batchId: ids.resource, toolId: currentTool, startedByUserId: null });
models.ManualIntervention.findByPk = async () => ({ runId: ids.resource, assigneeUserId: null, kind: "portal_error" });
models.ManualIntervention.findOne = async () => null;
models.EnrichmentJob.findByPk = async () => ({ batchId: ids.resource, tenantId: batch().tenantId });
models.RunSubmission.findByPk = async () => ({ importBatchId: ids.resource, tenantId: batch().tenantId, toolId: currentTool });
models.RegonCorrection.findByPk = async () => ({ sourceRowId: ids.resource });
models.EntityGroupingConflict.findByPk = async () => ({ sourceRowId: ids.resource });
models.SourceRow.findByPk = async () => ({ batchId: ids.resource });
models.sequelize.query = async () => [{ exists: false }];

async function main() {
  const controllers = [...new Set(report.routes.map((r) => api(r.source.replace("apps/api/src/", "").replace(/\.ts$/, ".js"))[r.controller]))];
  assert.ok(controllers.every(Boolean));
  const guards = [SessionGuard, PermissionGuard, AdminOnlyGuard, WorkerResultGuard, OperationalReportsGuard];
  const dependencies = new Set();
  for (const controller of controllers) {
    for (const dep of Reflect.getMetadata("self:paramtypes", controller) ?? []) dependencies.add(dep.param);
    for (const dep of Reflect.getMetadata("design:paramtypes", controller) ?? []) if (dep !== Object) dependencies.add(dep);
  }
  const providers = [...guards,
    ...[...dependencies].filter((dep) => !guards.includes(dep)).map((dep) => ({ provide: dep, useValue: new Proxy({}, {
      get(_object, key) {
        if (key === "then" || String(key).startsWith("on")) return undefined;
        return async () => { businessCalls++; return { marker }; };
      },
    }) })),
    { provide: "GOLDIS_SESSION_ROLE_RESOLVER", useValue: async (_user, _tenant, sessionId) => sessionActive && sessionId === ids.session ? currentRole : null },
    { provide: "GOLDIS_SESSION_PASSWORD_CHANGE_RESOLVER", useValue: async () => false },
    { provide: APP_GUARD, useClass: RequestProtectionGuard },
    { provide: APP_FILTER, useClass: PublicExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: PublicOutputInterceptor },
  ];
  class SecurityAuditModule {}
  Module({ controllers, providers })(SecurityAuditModule);
  const app = await createHttpApplication(SecurityAuditModule, { cors: false, logger: false });
  const checks = [];
  const request = async (route, headers = {}, method = route.method) => {
    let endpoint = route.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name) => name === "toolId" ? currentTool : name === "rowNumber" ? "2" : ids.resource);
    endpoint += (endpoint.includes("?") ? "&" : "?") + `batchId=${ids.resource}&runId=${ids.resource}`;
    return fetch(base + "/api" + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: { origin: process.env.PUBLIC_APP_ORIGIN, "content-type": "application/json", "x-csrf-token": csrf, ...headers },
      ...(["GET", "HEAD", "OPTIONS"].includes(method) ? {} : { body: JSON.stringify({ runId: ids.resource, batchId: ids.resource }) }),
    });
  };
  let base;
  try {
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    const guarded = report.routes.filter((r) => [...r.controllerGuards, ...r.methodGuards].some((g) => g === "SessionGuard" || g === "WorkerResultGuard"));
    const variants = [
      ["anonymous", {}], ["empty-cookie", { cookie: "goldis_session=" }],
      ["malformed-cookie", { cookie: cookies("invalid") }],
      ["tampered-signature", { cookie: cookies(valid + "BAD") }],
      ["expired-token", { cookie: cookies(signed({ exp: Date.now() - 1 })) }],
      ["revoked-session", { cookie: cookies(signed({ sessionId: randomUUID() })) }],
      ["legacy-no-session", { cookie: cookies(signed({ sessionId: undefined, v: undefined })) }],
      ["forged-role-headers", { "x-role": "admin", "x-user-id": ids.user, "x-tenant-id": ids.tenant, authorization: "Bearer " + valid }],
    ];
    for (const route of guarded) {
      for (const [variant, headers] of variants) {
        const response = await request(route, headers);
        assert.ok([401, 403].includes(response.status), `${route.method} ${route.path} ${variant}: ${response.status}`);
        assert.ok(!(await response.text()).includes(marker));
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        checks.push({ method: route.method, path: route.path, variant, status: response.status });
      }
      if (route.method === "GET") {
        const response = await request(route, {}, "HEAD");
        assert.ok([401, 403].includes(response.status));
        await response.text();
        checks.push({ method: "HEAD", path: route.path, variant: "anonymous", status: response.status });
      }
    }
    assert.equal(businessCalls, 0);
    for (const role of ["manager", "operator", "reviewer", "auditor"]) {
      currentRole = role;
      const routes = report.routes.filter((r) => r.controllerGuards.includes("AdminOnlyGuard")
        || (r.controllerGuards.includes("OperationalReportsGuard") && !["admin", "manager"].includes(role))
        || (r.controller === "TeamController" && !["admin", "manager"].includes(role))
        || (r.permissionRequirements.length && !canPerform(role, r.permissionRequirements[0].action, {
          actorUserId: ids.user, actorTenantId: ids.tenant, resourceTenantId: ids.tenant, resourceOwnerId: ids.user,
        })));
      for (const route of routes) {
        const response = await request(route, { cookie: cookies(valid) });
        assert.ok([403, 404].includes(response.status), `${role} ${route.method} ${route.path}: ${response.status}`);
        await response.text();
        checks.push({ method: route.method, path: route.path, variant: "role:" + role, status: response.status });
      }
    }
    for (const role of ["admin", "manager", "operator", "reviewer", "auditor"]) {
      currentRole = role;
      foreignTenant = true;
      for (const route of report.routes.filter((r) => r.permissionRequirements.some((p) => !["collection", "session-list", "new-batch"].includes(p.resource)))) {
        const response = await request(route, { cookie: cookies(valid) });
        assert.equal(response.status, 404, `cross-tenant ${role} ${route.method} ${route.path}`);
        await response.text();
        checks.push({ method: route.method, path: route.path, variant: "foreign-tenant:" + role, status: response.status });
      }
    }
    foreignTenant = false;
    foreignOwner = true;
    currentTool = "synthetic-private-tool";
    currentRole = "operator";
    for (const route of report.routes.filter((r) => r.permissionRequirements.some((p) => !["collection", "session-list", "new-batch"].includes(p.resource)))) {
      const response = await request(route, { cookie: cookies(valid) });
      assert.ok([403, 404].includes(response.status), `foreign owner ${route.method} ${route.path}`);
      await response.text();
      checks.push({ method: route.method, path: route.path, variant: "foreign-owner:operator", status: response.status });
    }
    assert.equal(businessCalls, 0, "No denied request may enter a business service");
    foreignOwner = false;
    currentTool = "oc-policy-verification";
    const read = report.routes.find((r) => r.method === "GET" && r.path === "/imports/:id");
    const positive = await request(read, { cookie: cookies(valid) });
    assert.equal(positive.status, 200);
    assert.ok((await positive.text()).includes(marker));
    assert.equal(businessCalls, 1, "Positive control must prove the endpoint is reachable");
    sessionActive = false;
    const revoked = await request(read, { cookie: cookies(valid) });
    assert.equal(revoked.status, 401);
    await revoked.text();
    sessionActive = true;

    const corsChecks = [];
    for (const origin of ["https://evil.example", "null", "https://audit.goldis.example.evil.example", "https://evil.audit.goldis.example", "http://audit.goldis.example", "http://localhost:3000"]) {
      for (const method of ["GET", "OPTIONS"]) {
        const response = await request(read, { cookie: cookies(valid), origin,
          "access-control-request-method": "DELETE", "access-control-request-headers": "content-type,x-csrf-token" }, method);
        assert.equal(response.headers.get("access-control-allow-origin"), null);
        assert.equal(response.headers.get("access-control-allow-credentials"), null);
        await response.text();
        corsChecks.push({ origin, method, status: response.status, allowOrigin: null, allowCredentials: null });
      }
      const mutation = report.routes.find((r) => r.path === "/imports" && r.method === "POST");
      const response = await request(mutation, { cookie: cookies(valid), origin });
      assert.equal(response.status, 403);
      await response.text();
      corsChecks.push({ origin, method: "POST", status: response.status });
    }
    const browserCorsChecks = [];
    const attacker = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end("<!doctype html><title>synthetic hostile origin</title><main>fixture</main>");
    });
    let browser;
    try {
      await new Promise((resolve, reject) => {
        attacker.once("error", reject);
        attacker.listen(0, "127.0.0.1", resolve);
      });
      const attackerUrl = `http://127.0.0.1:${attacker.address().port}/`;
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      await context.addCookies([
        { name: "goldis_session", value: valid, url: base, httpOnly: true, sameSite: "Lax" },
        { name: "goldis_csrf", value: csrf, url: base, sameSite: "Lax" },
      ]);
      const page = await context.newPage();
      await page.goto(attackerUrl);
      const privateUrl = base + "/api/imports/" + ids.resource;
      const businessCallsBeforeRead = businessCalls;
      const readResult = await page.evaluate(async (url) => {
        try {
          const response = await fetch(url, { credentials: "include" });
          return { readable: true, status: response.status, body: await response.text() };
        } catch (error) {
          return { readable: false, error: error instanceof Error ? error.name : "FETCH_FAILED" };
        }
      }, privateUrl);
      assert.equal(readResult.readable, false, "foreign page cannot read the private HTTP response");
      assert.equal(businessCalls, businessCallsBeforeRead + 1, "the authenticated private endpoint is reached, proving the CORS read is blocked by the browser");
      browserCorsChecks.push({ type: "credentialed-private-read", origin: attackerUrl, serverStatus: 200, scriptReadable: false });
      const businessCallsBeforePreflight = businessCalls;
      const mutationResult = await page.evaluate(async ({ url, csrfToken }) => {
        try {
          const response = await fetch(url, { method: "POST", credentials: "include",
            headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ runId: "synthetic" }) });
          return { resolved: true, status: response.status };
        } catch (error) {
          return { resolved: false, error: error instanceof Error ? error.name : "FETCH_FAILED" };
        }
      }, { url: base + "/api/imports", csrfToken: csrf });
      assert.equal(mutationResult.resolved, false, "foreign preflight does not authorize a cross-origin mutation");
      assert.equal(businessCalls, businessCallsBeforePreflight, "preflight rejection happens before the mutation reaches a business service");
      browserCorsChecks.push({ type: "credentialed-json-mutation-preflight", origin: attackerUrl,
        scriptResolved: false, businessCalls: 0 });
    } finally {
      await browser?.close();
      await new Promise((resolve) => attacker.close(resolve));
    }
    const evidence = { date: "2026-10-17", source: "current working tree; rebuilt API", realDatabase: false,
      scope: "Real HTTP bootstrap, controllers and guards; synthetic sessions/storage/business services. Service-specific role checks are covered separately by API tests and DB smokes.",
      routeCount: report.routes.length, protectedRoutes: guarded.length, deniedBusinessCalls: 0,
      positiveControl: 200, revokedSession: 401, checks, corsChecks, browserCorsChecks,
      routes: report.routes.map(({ method, path, source, controllerGuards, methodGuards, permissionRequirements }) => ({ method, path: "/api" + path, source, controllerGuards, methodGuards, permissionRequirements })),
    };
    const output = path.resolve(process.env.GOLDIS_SECURITY_BOUNDARY_OUTPUT
      || path.resolve(__dirname, "../docs/security/audit-2026-10-17/http-boundaries.json"));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify({ routes: evidence.routeCount, protectedRoutes: guarded.length, denialChecks: checks.length, corsChecks: corsChecks.length, browserCorsChecks: browserCorsChecks.length, deniedBusinessCalls: 0, positiveControl: 200 }));
  } finally {
    await app.close();
    await models.sequelize.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
