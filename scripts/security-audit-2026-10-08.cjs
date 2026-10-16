/* Audit evidence only. Uses built code, synthetic secrets, model stubs and a
 * loopback HTTP server. Never loads .env, connects to DB/Redis or starts workers.
 * Assertions confirm the audited behavior, including vulnerabilities; a green
 * run does NOT mean that the application is secure. Run after npm test. */
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
require('reflect-metadata');
process.env.DATABASE_URL = 'postgres://synthetic:unused@127.0.0.1:1/synthetic';
process.env.SESSION_SECRET = 'synthetic-security-audit-secret-never-use-in-production';
process.env.PUBLIC_APP_ORIGIN = 'https://goldis.example';
process.env.NODE_ENV = 'production';
process.env.TRUST_PROXY_HOPS = '0';
const root = path.resolve(__dirname, '..');
const api = (file) => require(path.join(root, 'apps/api/dist', file));
const models = api('db');
const { PermissionGuard } = api('authorization-guard');
const { AuthController, SessionGuard, verifyCsrfRequest } = api('session');
const { LoginRateLimiter } = api('login-rate-limiter');
const { RunSubmissionController, RunSubmissionService } = api('run-submissions');
const { BootstrapAdminService } = api('bootstrap-admin');
const { hashPassword, verifyPassword } = api('password-hash');
const { AdminOnlyGuard } = api('admin');
const { capabilityForPermission } = api('tool-access');
const { HealthController } = api('health');
const results = [];
const userId = '11111111-1111-4111-8111-111111111111';
const tenantId = '99999999-9999-4999-8999-999999999999';
const otherTenant = '88888888-8888-4888-8888-888888888888';
const otherUser = '22222222-2222-4222-8222-222222222222';
const batchId = '33333333-3333-4333-8333-333333333333';
const submissionId = '44444444-4444-4444-8444-444444444444';
const csrf = 'synthetic-csrf-token-for-security-audit-123456789';
const principal = { userId, tenantId, role: 'operator', csrf, exp: Date.now() + 60000, actorRef: userId };
const payload = Buffer.from(JSON.stringify({ ...principal, role: undefined, v: 2, sessionId: submissionId })).toString('base64url');
const signature = createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
const request = { headers: { cookie: `goldis_session=${payload}.${signature}; goldis_csrf=${csrf}`, 'x-csrf-token': csrf }, goldisPrincipal: principal };
function context(handler, req = request) { return { getHandler: () => handler, switchToHttp: () => ({ getRequest: () => req }) }; }
async function patched(entries, action) {
  const originals = entries.map(([object, key]) => object[key]);
  entries.forEach(([object, key, value]) => { object[key] = value; });
  try { return await action(); } finally { entries.forEach(([object, key], index) => { object[key] = originals[index]; }); }
}
async function evidence(id, action) { const detail = await action(); results.push({ id, ...detail }); }
async function main() {
  await evidence('AUTHZ-SUBMISSION', async () => {
    const batch = { id: batchId, toolId: 'oc-policy-verification', tenantId, ownerUserId: userId };
    const submission = { submissionId, importBatchId: batchId, tenantId, toolId: batch.toolId };
    const grant = { canDiscover: true, canExecute: true, canViewResults: false, canDownloadResults: false };
    return patched([
      [models.RunSubmission, 'findByPk', async () => submission],
      [models.RunSubmission, 'findOne', async () => submission],
      [models.ImportBatch, 'findByPk', async () => batch],
      [models.Tool, 'findByPk', async () => ({ toolId: batch.toolId, status: 'available' })],
      [models.ToolGrant, 'findOne', async () => grant],
      [models.sequelize, 'query', async () => [{ itemId: submissionId, sourceRowId: batchId, rowNumber: 2, runStatus: 'completed' }]],
    ], async () => {
      const req = { ...request, params: { id: submissionId } };
      assert.equal(capabilityForPermission('submission:read'), null);
      assert.equal(await new PermissionGuard().canActivate(context(RunSubmissionController.prototype.items, req)), true);
      const service = new RunSubmissionService(undefined, undefined, undefined);
      const controller = new RunSubmissionController(service);
      const data = await controller.items(submissionId, undefined, req);
      assert.equal(data.items.length, 1);
      grant.canExecute = false; grant.canViewResults = true;
      await assert.rejects(controller.items(submissionId, undefined, req), (e) => e.getStatus() === 403);
      return { executeWithoutView: 'allowed', viewWithoutExecute: '403', method: 'real guard + controller + service, DB stubs' };
    });
  });
  await evidence('AUTHZ-ASSIGNMENT-TENANT', async () => {
    return patched([
      [models.Tool, 'findByPk', async () => ({ toolId: 'oc-policy-verification', status: 'available' })],
      [models.ToolGrant, 'findOne', async () => ({ canViewResults: true, canExecute: true })],
    ], async () => {
      const guard = new PermissionGuard(async () => ({ resourceTenantId: otherTenant, resourceOwnerId: otherUser,
        resourceAssigneeId: userId, resourceToolId: 'oc-policy-verification' }));
      const { RunController } = api('runs');
      const allowed = await guard.canActivate(context(RunController.prototype.get));
      assert.equal(allowed, true);
      return { crossTenantAssignedRun: 'allowed', method: 'real guard, synthetic resolver; conditional inconsistent assignment' };
    });
  });
  await evidence('AUTHZ-GRANT-ASSIGNMENTS', async () => {
    const { AdminController } = api('admin');
    const existing = { canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: false, version: 1, async save() {} };
    let unassignmentQueries = 0;
    return patched([
      [models.sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } })],
      [models.sequelize, 'query', async () => { unassignmentQueries++; return []; }],
      [models.TenantMembership, 'findOne', async () => ({ userId, tenantId, status: 'active' })],
      [models.Tool, 'findByPk', async () => ({ toolId: 'oc-policy-verification', status: 'available' })],
      [models.ToolGrant, 'findOne', async () => existing], [models.AuditEvent, 'create', async (values) => values],
    ], async () => {
      const result = await new AdminController().setGrant(userId, 'oc-policy-verification', {
        canDiscover: true, canExecute: false, canViewResults: false, canDownloadResults: false, expectedVersion: 1,
      }, { ...request, goldisPrincipal: { ...principal, role: 'admin' } });
      assert.equal(result.canExecute, false); assert.equal(result.canViewResults, false);
      assert.equal(result.unassignedInterventions, 0); assert.equal(unassignmentQueries, 0);
      return { executeAndViewRemoved: true, unassignmentFunctionNotCalled: true,
        method: 'real admin controller + mutable Sequelize-instance stub; actual grant guard still denies further protected actions' };
    });
  });
  await evidence('AUTH-RATE-ACCOUNT', async () => {
    // Model the Redis Lua counters in memory; actual production limiter builds
    // all keys. No TTL behavior or actual Redis atomicity is tested here.
    const counters = new Map();
    const fakeRedis = { eval: async (script, keyCount, pairKey, ipKey, pairLimit, ipLimit) => {
      assert.equal(keyCount, 2); assert.ok(script.includes('redis.call'));
      if ((counters.get(pairKey) || 0) >= Number(pairLimit) || (counters.get(ipKey) || 0) >= Number(ipLimit)) return [0, 900];
      counters.set(pairKey, (counters.get(pairKey) || 0) + 1);
      counters.set(ipKey, (counters.get(ipKey) || 0) + 1);
      return [1, 0];
    }, del: async () => 0, quit: async () => {} };
    const limiter = new LoginRateLimiter(fakeRedis);
    let allowed = 0;
    for (let ip = 1; ip <= 12; ip++) for (let attempt = 0; attempt < 5; attempt++) {
      if ((await limiter.consumeAttempt('synthetic.target', `203.0.113.${ip}`)).allowed) allowed++;
    }
    assert.equal(allowed, 60);
    assert.equal((await limiter.consumeAttempt('synthetic.target', '203.0.113.1')).allowed, false);
    await limiter.onModuleDestroy();
    return { sameUsernameDifferentIpsAllowed: allowed, sixthAttemptSameIp: 'blocked', redisKeys: counters.size, method: 'real limiter, in-memory Redis counter model' };
  });
  const passwordHash = await hashPassword('Synthetic-only audit password 123!');
  const limiter = { consumeAttempt: async () => ({ allowed: true }), clearPair: async () => {} };
  await evidence('AUTH-PASSWORD-RETRIES', async () => {
    let lookups = 0;
    return patched([[models.User, 'findByPk', async () => { lookups++; return { passwordHash }; }]], async () => {
      assert.equal(verifyCsrfRequest(request), true);
      const controller = new AuthController(limiter);
      for (let attempt = 0; attempt < 12; attempt++) await assert.rejects(
        controller.changePassword({ currentPassword: 'wrong guess', newPassword: 'Synthetic-only new password 123!' }, request, {}), (e) => e.getStatus() === 401);
      assert.equal(lookups, 12);
      return { attemptsReachingPasswordVerification: lookups, statuses: '12 x 401, no 429', method: 'real controller, scrypt + valid synthetic CSRF, user stub' };
    });
  });
  await evidence('AUTH-TIMING', async () => {
    let exists = false;
    return patched([[models.User, 'findOne', async () => exists ? { passwordHash } : null]], async () => {
      const controller = new AuthController(limiter);
      async function measure(value) {
        exists = value;
        const times = [];
        for (let i = 0; i < 12; i++) {
          const start = performance.now();
          await assert.rejects(controller.login({ username: 'synthetic.target', password: 'wrong guess' }, { ip: '203.0.113.1', headers: {} }, {}), (e) => e.getStatus() === 401);
          times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b); return Number(times[Math.floor(times.length / 2)].toFixed(2));
      }
      return { missingMedianMs: await measure(false), existingMedianMs: await measure(true), method: '12 samples per branch, actual scrypt, DB + limiter stubs; not a network measurement' };
    });
  });
  await evidence('AUTH-PASSWORD-RESET-RACE', async () => {
    const adminResetHash = await hashPassword('Synthetic admin reset password 456!');
    const chosenPassword = 'Synthetic attacker chosen password 789!';
    const state = { passwordHash, mustChangePassword: false, sessions: [{ sessionId: submissionId, revokedAt: null }] };
    // Simulate a committed administrator reset in the gap after the controller
    // verifies the old password and before its own transaction begins.
    const staleUser = { passwordHash, mustChangePassword: false,
      async save() { state.passwordHash = this.passwordHash; state.mustChangePassword = this.mustChangePassword; } };
    return patched([
      [models.User, 'findByPk', async () => staleUser],
      [models.sequelize, 'transaction', async (fn) => {
        state.passwordHash = adminResetHash; state.mustChangePassword = true;
        state.sessions[0].revokedAt = new Date();
        return fn({});
      }],
      [models.UserSession, 'update', async () => [0]],
      [models.UserSession, 'create', async (values) => { state.sessions.push(values); return values; }],
      [models.AuditEvent, 'create', async (values) => values],
    ], async () => {
      await new AuthController(limiter).changePassword({ currentPassword: 'Synthetic-only audit password 123!', newPassword: chosenPassword }, request, { cookie() {} });
      assert.equal(await verifyPassword(chosenPassword, state.passwordHash), true);
      assert.equal(await verifyPassword('Synthetic admin reset password 456!', state.passwordHash), false);
      assert.equal(state.mustChangePassword, false);
      assert.equal(state.sessions.filter((s) => s.revokedAt === null).length, 1);
      return { committedAdminResetOverwritten: true, revokedOldSession: true, newActiveSession: true, mustChangePasswordCleared: true,
        method: 'real controller + hashes, DB stubs with explicit deterministic reset interleaving; not PostgreSQL concurrency test' };
    });
  });
  await evidence('AUTH-BOOTSTRAP', async () => {
    process.env.GOLDIS_ADMIN_USER = 'synthetic.audit.admin'; process.env.GOLDIS_ADMIN_PASSWORD = 'x';
    let values;
    return patched([
      [models.sequelize, 'transaction', async (fn) => fn({})], [models.sequelize, 'query', async () => []],
      [models.User, 'count', async () => 0], [models.Tenant, 'findOne', async () => ({ tenantId })],
      [models.User, 'create', async (input) => { values = input; return { ...input, mustChangePassword: false }; }],
      [models.TenantMembership, 'create', async () => ({})], [models.ImportBatch, 'update', async () => [0]],
    ], async () => {
      await new BootstrapAdminService().onModuleInit();
      assert.equal(await verifyPassword('x', values.passwordHash), true);
      assert.equal(values.mustChangePassword, undefined);
      return { oneCharacterAdminPassword: 'accepted', forcesPasswordChange: false, method: 'real bootstrap + hash, DB stubs; no real account created' };
    });
  });
  await evidence('HTTP-HEALTH-LIMITS', async () => {
    const { Module } = require('@nestjs/common');
    const { APP_GUARD } = require('@nestjs/core');
    const { RequestProtectionGuard } = api('request-protection');
    const { createHttpApplication } = api('http-bootstrap');
    class AuditModule {}
    Module({ controllers: [HealthController], providers: [{ provide: APP_GUARD, useClass: RequestProtectionGuard }] })(AuditModule);
    let dbCalls = 0; let redisCalls = 0;
    return patched([[models.sequelize, 'authenticate', async () => { dbCalls++; }],
      [HealthController.prototype, 'redisAvailable', async () => { redisCalls++; return true; }]], async () => {
      const app = await createHttpApplication(AuditModule, { logger: false, cors: false });
      try {
        await app.listen(0, '127.0.0.1');
        const url = `http://127.0.0.1:${app.getHttpServer().address().port}/api/health/ready`;
        let accepted = 0;
        for (let i = 0; i < 65; i++) {
          const response = await fetch(url); await response.text(); if (response.status === 200) accepted++;
        }
        assert.equal(accepted, 65); assert.equal(dbCalls, 65); assert.equal(redisCalls, 65);
        return { unauthenticatedResponses200: accepted, dbCalls, redisProbeCalls: redisCalls, method: 'loopback HTTP + production bootstrap/guard/controller, dependency stubs; not a load test' };
      } finally { await app.close(); }
    });
  });
  await evidence('CONTROLS', async () => {
    const { canPerform } = api('authorization-policy');
    const authorization = { actorUserId: userId, actorTenantId: tenantId, resourceTenantId: tenantId, resourceOwnerId: otherUser };
    assert.equal(canPerform('operator', 'batch:read', authorization), false);
    assert.equal(canPerform('reviewer', 'run:create', authorization), false);
    assert.equal(canPerform('auditor', 'batch:read', authorization), false);
    assert.equal(canPerform('admin', 'batch:read', { ...authorization, resourceTenantId: otherTenant }), false);
    assert.throws(() => new AdminOnlyGuard().canActivate(context(() => {})), (e) => e.getStatus() === 403);
    await assert.rejects(new SessionGuard(async () => null).canActivate(context(() => {})), (e) => e.getStatus() === 401);
    const React = require('react'); const { renderToStaticMarkup } = require('react-dom/server');
    const html = renderToStaticMarkup(React.createElement('td', null, '<img src=x onerror=alert(1)>'));
    assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;img'));
    const { injectReplacements } = require('sequelize/lib/utils/sql');
    const injected = injectReplacements('SELECT * FROM users WHERE username = :username', models.sequelize.getDialect() === 'postgres' ? models.sequelize.dialect : null,
      { username: "' OR 1=1 --" });
    assert.equal(injected, "SELECT * FROM users WHERE username = ''' OR 1=1 --'");
    return { roleAndTenantDenials: 'passed', revokedSessionDenied: true, reactTextEscaped: true, sqlPayloadQuoted: true,
      method: 'actual policy/guards + React renderer + Sequelize replacements; not browser/DB end-to-end' };
  });
  const output = { auditDate: '2026-10-08', scope: 'synthetic evidence; no real DB/Redis or portals', results };
  const outputPath = path.join(root, 'docs/security/audit-evidence-2026-10-08.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => models.sequelize.close());
