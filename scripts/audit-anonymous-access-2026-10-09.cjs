"use strict";

// Read-only security audit of real routes/guards/KDF with synthetic storage.
// No .env, production database, live portal or customer workbook is used.
process.env.DATABASE_URL = "postgres://synthetic:unused@127.0.0.1:1/anonymous_audit";
delete process.env.REDIS_URL;
process.env.SESSION_SECRET = "synthetic-anonymous-audit-session-secret-2026";
process.env.WORKER_AUTH_SECRET = "synthetic-anonymous-audit-worker-secret-2026";
process.env.PUBLIC_APP_ORIGIN = "https://anonymous-audit.example";
process.env.TRUST_PROXY_IPS = "";
process.env.NODE_ENV = "production";
process.env.WORKER_LIVE_PORTALS = "0";
process.env.GOLDIS_ENRICHMENT_PROVIDER = "disabled";
require("reflect-metadata");
const assert = require("node:assert/strict");
const { createHmac, randomUUID, randomBytes, scrypt: nativeScrypt, randomInt } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Module, RequestMethod } = require("@nestjs/common");
const { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } = require("@nestjs/common/constants");
const api = (name) => require(`../apps/api/dist/${name}`);
const root = path.resolve(__dirname, "..");
const marker = "SYNTHETIC_PRIVATE_CUSTOMER_MARKER_20261009";
const ids = { user: randomUUID(), tenant: randomUUID(), resource: randomUUID(), activeSession: randomUUID(), revokedSession: randomUUID() };
const csrf = "A".repeat(48);
let activeSession = true;
let sessionState = "active";
let businessCalls = 0;
const sessions = new Map();

function token(sessionId, options = {}) {
  const payload = Buffer.from(JSON.stringify({ v: 2, sessionId, userId: ids.user, tenantId: ids.tenant,
    exp: Date.now() + 3600_000, csrf, ...options })).toString("base64url");
  return `${payload}.${createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url")}`;
}
function cookie(value) { return `goldis_session=${value}; goldis_csrf=${csrf}`; }
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => Number(sorted[Math.floor((sorted.length - 1) * p)].toFixed(2));
  return { samples: values.length, medianMs: percentile(0.5), p10Ms: percentile(0.1), p90Ms: percentile(0.9) };
}
function shuffled(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}

async function main() {
  const models = api("db");
  const { AuthController, SessionGuard } = api("session");
  const { PermissionGuard } = api("authorization-guard");
  const { WorkerResultGuard } = api("worker-results");
  const { AdminOnlyGuard } = api("admin");
  const { LoginRateLimiter } = api("login-rate-limiter");
  const { AppModule } = api("module");
  const { createHttpApplication } = api("http-bootstrap");
  const { hashPassword } = api("password-hash");
  const knownPassword = "Synthetic Timing Password 12345!";
  const currentHash = await hashPassword(knownPassword);
  const legacySalt = randomBytes(16);
  const legacyKey = await new Promise((resolve, reject) => nativeScrypt(knownPassword, legacySalt, 64,
    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
  const legacyHash = `scrypt$${legacySalt.toString("base64url")}$${legacyKey.toString("base64url")}`;
  const users = Object.fromEntries(["audit.current", "audit.legacy", "audit.disabled"].map((username) => [username, {
    userId: ids.user, username, passwordHash: username === "audit.legacy" ? legacyHash : currentHash,
    credentialRevision: 1, status: username === "audit.disabled" ? "disabled" : "active", mustChangePassword: false,
    async save() {},
  }]));
  models.User.findOne = async ({ where }) => users[where.usernameNormalized] ?? null;
  models.User.findByPk = async () => ({ ...users["audit.current"],
    status: sessionState === "disabled-user" ? "disabled" : "active",
    credentialRevision: sessionState === "changed-credentials" ? 2 : 1 });
  models.Tenant.findOne = async () => ({ tenantId: ids.tenant });
  models.TenantMembership.findOne = async () => sessionState === "revoked-membership" ? null : ({ role: "operator", status: "active" });
  models.UserSession.findOne = async ({ where }) => {
    if (sessionState === "database-unavailable") throw new Error("SYNTHETIC_DATABASE_UNAVAILABLE");
    if (where.sessionId === ids.activeSession && activeSession) return {
      sessionId: ids.activeSession, expiresAt: new Date(Date.now() + (sessionState === "database-expired" ? -1 : 3600_000)),
      lastSeenAt: new Date(), lastActivityAt: new Date(Date.now() - (sessionState === "idle-expired" ? 31 * 60_000 : 0)), credentialRevision: 1,
    };
    return sessions.get(where.sessionId) ?? null;
  };
  models.UserSession.create = async (row) => { sessions.set(row.sessionId, row); return row; };
  models.UserSession.update = async (_values, { where }) => {
    if (where.sessionId === ids.activeSession) activeSession = false;
    if (sessions.has(where.sessionId)) sessions.delete(where.sessionId);
    return [1];
  };
  models.AuditEvent.create = async (row) => row;
  models.ImportBatch.findByPk = async () => ({ id: ids.resource, tenantId: ids.tenant, ownerUserId: ids.user, toolId: "oc-policy-verification" });
  models.Tool.findByPk = async () => ({ toolId: "oc-policy-verification", status: "available" });
  models.ToolGrant.findOne = async () => ({ canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true });
  models.sequelize.transaction = async (callback) => callback({ LOCK: { UPDATE: "UPDATE" }, sequelize: models.sequelize });
  models.sequelize.query = async () => [];
  models.sequelize.authenticate = async () => { throw new Error("SYNTHETIC_DEPENDENCY_UNAVAILABLE"); };
  const limiter = { async consumeAttempt() { return { allowed: true, retryAfterSeconds: 0 }; },
    async recordFailure() {}, async clearPair() {}, async shouldSampleLoginFailure() { return false; } };

  const controllers = Reflect.getMetadata("controllers", AppModule);
  const originalProviders = Reflect.getMetadata("providers", AppModule);
  const realGuards = new Set([SessionGuard, PermissionGuard, WorkerResultGuard, AdminOnlyGuard]);
  const providers = originalProviders.map((provider) => {
    if (typeof provider !== "function" || realGuards.has(provider)) return provider;
    if (provider === LoginRateLimiter) return { provide: provider, useValue: limiter };
    const fake = {};
    for (const name of Object.getOwnPropertyNames(provider.prototype)) {
      if (["constructor", "onModuleInit", "onModuleDestroy"].includes(name)) continue;
      fake[name] = async () => { businessCalls++; return { companyName: marker, privateData: marker }; };
    }
    return { provide: provider, useValue: fake };
  });
  class AuditModule {}
  Module({ controllers, providers })(AuditModule);
  const app = await createHttpApplication(AuditModule, { logger: false, cors: false });
  let workerReceiver;
  try {
    await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    const routes = [];
    for (const controller of controllers) {
      const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) ?? "";
      const controllerGuards = Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        if (name === "constructor") continue;
        const handler = controller.prototype[name];
        if (typeof handler !== "function" || !Reflect.hasMetadata(METHOD_METADATA, handler)) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)];
        const handlerPaths = Reflect.getMetadata(PATH_METADATA, handler);
        for (const handlerPath of Array.isArray(handlerPaths) ? handlerPaths : [handlerPaths ?? ""]) {
          const route = ("/api/" + [controllerPath, handlerPath].filter(Boolean).join("/")).replace(/\/+/g, "/");
          const guards = [...controllerGuards, ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])];
          routes.push({ controller: controller.name, handler: name, method, template: route.replace(/\/$/, ""),
            endpoint: route.replace(/:([A-Za-z0-9_]+)/g, ids.resource).replace(/\/$/, ""),
            protectedBy: guards.includes(SessionGuard) ? "session" : guards.includes(WorkerResultGuard) ? "service-secret" : "public" });
        }
      }
    }
    const valid = token(ids.activeSession);
    const variants = [
      { name: "no-cookie", headers: {} },
      { name: "empty-cookie", headers: { cookie: "goldis_session=" } },
      { name: "malformed-cookie", headers: { cookie: cookie("not-a-token") } },
      { name: "tampered-signature", headers: { cookie: cookie(valid.slice(0, -3) + "BAD") } },
      { name: "expired-token", headers: { cookie: cookie(token(ids.activeSession, { exp: Date.now() - 1 })) } },
      { name: "revoked-or-missing-session", headers: { cookie: cookie(token(ids.revokedSession)) } },
      { name: "legacy-without-session-registry", headers: { cookie: cookie(token(undefined, { v: undefined })) } },
      { name: "forged-identity-headers", headers: { "x-role": "admin", "x-user-id": ids.user, "x-tenant-id": ids.tenant, authorization: "Bearer " + valid } },
    ];
    const checks = [];
    const protectedRoutes = routes.filter((route) => route.protectedBy !== "public");
    for (const route of protectedRoutes) {
      for (const variant of variants) {
        const response = await fetch(base + route.endpoint, { method: route.method,
          headers: { origin: process.env.PUBLIC_APP_ORIGIN, "content-type": "application/json", "x-csrf-token": csrf, ...variant.headers },
          ...(route.method === "GET" || route.method === "HEAD" ? {} : { body: "{}" }), redirect: "manual" });
        const body = await response.text();
        assert.ok([401, 403].includes(response.status), `${route.method} ${route.template} ${variant.name}: ${response.status}`);
        assert.ok(!body.includes(marker));
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        checks.push({ route: route.template, method: route.method, variant: variant.name, status: response.status });
      }
      if (route.method === "GET") {
        const response = await fetch(base + route.endpoint, { method: "HEAD" });
        assert.ok([401, 403].includes(response.status));
        assert.equal((await response.arrayBuffer()).byteLength, 0);
      }
    }
    assert.equal(businessCalls, 0, "Denied requests must never invoke the business service");
    const sessionStateChecks = [];
    for (const state of ["disabled-user", "revoked-membership", "changed-credentials", "database-expired", "idle-expired", "database-unavailable"]) {
      sessionState = state;
      activeSession = true;
      const response = await fetch(base + `/api/imports/${ids.resource}`, { headers: { cookie: cookie(valid) } });
      assert.equal(response.status, state === "database-unavailable" ? 503 : 401);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.ok(!(await response.text()).includes(marker));
      sessionStateChecks.push({ state, status: response.status });
    }
    assert.equal(businessCalls, 0, "Invalid server-side session state must never invoke the business service");
    sessionState = "active";
    activeSession = true;
    const positive = await fetch(base + `/api/imports/${ids.resource}`, { headers: { cookie: cookie(valid) } });
    assert.equal(positive.status, 200);
    assert.ok((await positive.text()).includes(marker), "Positive control must reach synthetic private data");
    const loggedOut = await fetch(base + "/api/auth/logout", { method: "POST", headers: {
      origin: process.env.PUBLIC_APP_ORIGIN, cookie: cookie(valid), "x-csrf-token": csrf,
    } });
    assert.equal(loggedOut.status, 201);
    for (const headers of [{}, { cookie: cookie(valid) }]) {
      const response = await fetch(base + `/api/imports/${ids.resource}`, { headers });
      assert.equal(response.status, 401);
      assert.ok(!(await response.text()).includes(marker));
    }
    const publicChecks = [];
    for (const route of routes.filter((route) => route.protectedBy === "public")) {
      const response = await fetch(base + route.endpoint, { method: route.method,
        headers: { origin: process.env.PUBLIC_APP_ORIGIN, "content-type": "application/json" },
        ...(route.method === "GET" ? {} : { body: "{}" }) });
      const body = await response.text();
      assert.ok(!body.includes(marker));
      assert.ok(!response.headers.get("set-cookie") || route.endpoint.endsWith("/logout"));
      publicChecks.push({ route: route.template, method: route.method, status: response.status, body });
    }
    const guessedFiles = ["/exports/file.xlsx", "/uploads/file.xlsx", "/artifacts/file.xlsx", "/.env", "/api/.env", "/api/exports/file.xlsx", "/api/imports/%2e%2e/%2e%2e/.env"];
    for (const endpoint of guessedFiles) {
      const response = await fetch(base + endpoint);
      assert.ok([401, 403, 404].includes(response.status));
      assert.ok(!(await response.text()).includes(marker));
    }
    const { OneTimeCodeInbox, startWorkerCodeReceiver } = require("../apps/worker/dist/features/authentication/code-inbox");
    workerReceiver = await startWorkerCodeReceiver({ inbox: new OneTimeCodeInbox(), host: "127.0.0.1", port: 0, serviceSecret: process.env.WORKER_AUTH_SECRET });
    for (const authorization of [undefined, "Bearer invalid", "Bearer " + valid]) {
      const response = await fetch(`http://127.0.0.1:${workerReceiver.address.port}/internal/auth-challenges/${ids.resource}/code`, {
        method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: '{"code":"123456"}',
      });
      assert.equal(response.status, 401);
    }
    console.log(`ANONYMOUS_ROUTE_MATRIX_PASS routes=${routes.length} protected=${protectedRoutes.length} denialChecks=${checks.length} businessCallsBeforePositiveControl=0 logoutReplay=401`);

    if (process.argv.includes("--web-only")) {
      await require("./audit-anonymous-web-2026-10-09.cjs")(base, routes, marker);
      return;
    }

    // Fixed-length guesses, randomized order, sequential calls: avoids KDF queue saturation.
    const prefixGuess = (prefix) => knownPassword.slice(0, prefix) + "X".repeat(knownPassword.length - prefix);
    const scenarios = [
      { name: "unknown-login-wrong-password", username: "audit.unknown", password: prefixGuess(0) },
      { name: "current-wrong-prefix-0", username: "audit.current", password: prefixGuess(0) },
      { name: "current-wrong-prefix-half", username: "audit.current", password: prefixGuess(16) },
      { name: "current-wrong-last-character", username: "audit.current", password: prefixGuess(knownPassword.length - 1) },
      { name: "legacy-wrong-password", username: "audit.legacy", password: prefixGuess(0) },
      { name: "disabled-wrong-password", username: "audit.disabled", password: prefixGuess(0) },
      { name: "current-correct-password", username: "audit.current", password: knownPassword },
    ];
    const samples = Object.fromEntries(scenarios.map((scenario) => [scenario.name, []]));
    const responseSignatures = {};
    for (let round = -2; round < 16; round++) {
      for (const scenario of shuffled(scenarios)) {
        const start = performance.now();
        const response = await fetch(base + "/api/auth/login", { method: "POST", headers: {
          origin: process.env.PUBLIC_APP_ORIGIN, "content-type": "application/json",
        }, body: JSON.stringify({ username: scenario.username, password: scenario.password }) });
        const body = await response.text();
        const elapsed = performance.now() - start;
        assert.equal(response.status, scenario.name === "current-correct-password" ? 201 : 401);
        if (response.status === 401) {
          assert.equal(response.headers.get("set-cookie"), null);
          responseSignatures[scenario.name] = { status: response.status, body };
        }
        if (round >= 0) samples[scenario.name].push(elapsed);
      }
    }
    assert.equal(new Set(Object.values(responseSignatures).map(JSON.stringify)).size, 1, "Failed credentials must return the same HTTP status/body");
    const timing = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, stats(values)]));
    const result = { auditDate: "2026-10-09", customerData: false, livePortalRequests: 0, realDatabaseConnections: 0,
      setup: "Real Nest controllers/guards/production HTTP bootstrap and real crypto KDF; synthetic services/DB/limiter. Timing is local HTTP, not a deployed VPS measurement.",
      routes, protectedRoutes: protectedRoutes.length, checks, sessionStateChecks, publicChecks, guessedFiles,
      logoutReplayStatus: 401, workerUnauthenticatedCases: 3, identicalFailedStatusAndBody: true,
      timing, timingSamplesMs: samples, conclusions: {
        legacyAccountTimingRisk: timing["legacy-wrong-password"].medianMs < timing["unknown-login-wrong-password"].medianMs / 2,
        passwordPrefixOracleProven: false,
        allPossibleTimingChannelsRuledOut: false,
        successfulAndFailedLoginMayDiffer: "Success additionally creates a session; status already reveals success. This does not by itself expose password prefixes.",
      } };
    await fs.writeFile(path.join(root, "docs/security/anonymous-access-evidence-2026-10-09.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ timing, conclusions: result.conclusions }, null, 2));
  } finally {
    if (workerReceiver) await workerReceiver.close();
    await app.close();
    await models.sequelize.close();
  }
}

main().catch((error) => { console.error("ANONYMOUS_AUDIT_FAILED", error instanceof Error ? error.message : "unknown"); process.exitCode = 1; });
