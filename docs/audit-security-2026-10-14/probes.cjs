"use strict";

// Synthetic HTTP audit: no real credentials, customer data, DB or portal requests.
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
process.env.DATABASE_URL = "postgres://audit:unused@127.0.0.1:1/audit";
process.env.SESSION_SECRET = "synthetic-security-audit-session-secret-at-least-32";
process.env.PUBLIC_APP_ORIGIN = "http://127.0.0.1:3000";
process.env.NODE_ENV = "test";
delete process.env.APP_ENV;
delete process.env.TRUST_PROXY_IPS;
require("reflect-metadata");
const api = (name) => require(path.join(root, "apps/api/dist", name));

async function main() {
  const { Module } = require("@nestjs/common");
  const { AdminController, AdminOnlyGuard } = api("admin.js");
  const { SessionGuard, SESSION_ROLE_RESOLVER, SESSION_PASSWORD_CHANGE_RESOLVER } = api("session.js");
  const { RequestProtectionGuard } = api("request-protection.js");
  const { createHttpApplication } = api("http-bootstrap.js");
  const { PublicExceptionFilter } = api("public-output.js");
  const models = api("db.js");
  const adminId = "11111111-1111-4111-8111-111111111111";
  const operatorId = "22222222-2222-4222-8222-222222222222";
  const tenantId = "99999999-9999-4999-8999-999999999999";
  let saves = 0;
  const settings = {
    version: 1, enabledForNewRuns: false, maxNewRunsPerHour: 1,
    allowedLocalStart: null, allowedLocalEnd: null, timezone: "Europe/Warsaw",
    async save() { saves += 1; },
  };
  models.sequelize.query = async () => [];
  models.sequelize.transaction = async (fn) => fn({ LOCK: { UPDATE: "UPDATE" }, sequelize: models.sequelize });
  models.User.findByPk = async () => ({ status: "active", credentialRevision: 1 });
  models.TenantMembership.findOne = async () => ({ role: "admin", status: "active" });
  models.UserSession.findOne = async () => ({ credentialRevision: 1, expiresAt: new Date(Date.now() + 60000) });
  models.Tool.findByPk = async () => ({ toolId: "oc-policy-verification" });
  models.ToolSettings.findOne = async () => settings;
  models.AuditEvent.create = async () => ({});
  class AuditModule {}
  Module({
    controllers: [AdminController],
    providers: [SessionGuard, AdminOnlyGuard,
      { provide: SESSION_ROLE_RESOLVER, useValue: async (id) => id === adminId ? "admin" : id === operatorId ? "operator" : null },
      { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false }],
  })(AuditModule);
  const app = await createHttpApplication(AuditModule, { logger: false });
  app.useGlobalGuards(new RequestProtectionGuard());
  app.useGlobalFilters(new PublicExceptionFilter());
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl();
  const csrf = "synthetic-csrf-token-for-security-audit-123456789012345";
  const cookie = (userId) => {
    const payload = Buffer.from(JSON.stringify({ v: 2, userId, tenantId, sessionId: "33333333-3333-4333-8333-333333333333", exp: Date.now() + 60000, csrf })).toString("base64url");
    const signature = createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
    return `goldis_session=${payload}.${signature}; goldis_csrf=${csrf}`;
  };
  const body = { enabledForNewRuns: true, maxNewRunsPerHour: 10000, allowedLocalStart: null, allowedLocalEnd: null, timezone: "Europe/Warsaw", expectedVersion: 1 };
  const probe = async (cookies, origin = process.env.PUBLIC_APP_ORIGIN, csrfHeader = csrf) => {
    const response = await fetch(`${base}/api/admin/tools/oc-policy-verification/settings`, {
      method: "PATCH", headers: { "content-type": "application/json", origin, ...(cookies ? { cookie: cookies } : {}), ...(csrfHeader ? { "x-csrf-token": csrfHeader } : {}) }, body: JSON.stringify(body),
    });
    await response.text();
    return response.status;
  };
  try {
    const anonymous = await probe(null);
    const operator = await probe(cookie(operatorId));
    const crossOrigin = await probe(cookie(adminId), "https://attacker.invalid");
    const missingCsrf = await probe(cookie(adminId), process.env.PUBLIC_APP_ORIGIN, null);
    const adminWithoutConfirmation = await probe(cookie(adminId));
    assert.equal(anonymous, 401);
    assert.equal(operator, 403);
    assert.equal(crossOrigin, 403);
    assert.equal(missingCsrf, 403);
    assert.equal(adminWithoutConfirmation, 200);
    assert.equal(saves, 1);
    const { toolAccessFromRecords } = api("tool-access.js");
    const absentGrant = toolAccessFromRecords({ userId: operatorId, tenantId, role: "operator" }, { toolId: "oc-policy-verification", status: "available" }, null);
    const deniedGrant = toolAccessFromRecords({ userId: operatorId, tenantId, role: "operator" }, { toolId: "oc-policy-verification", status: "disabled" }, { canDiscover: false, canExecute: false, canViewResults: false, canDownloadResults: false });
    assert.equal(absentGrant.canDownloadResults, true);
    assert.equal(deniedGrant.canDownloadResults, true);
    const { passwordPolicyFailure } = api("password-policy.js");
    assert.equal(passwordPolicyFailure("passwordpassword"), null);
    const { assertAuditMetadataSafe } = api("audit.js");
    assert.throws(() => assertAuditMetadataSafe({ credentialReset: true }), /AUDIT_METADATA_SENSITIVE_KEY/);
    console.log(JSON.stringify({ fixtureOnly: true, settingsHttp: { anonymous, operator, crossOrigin, missingCsrf, adminWithoutConfirmation, saves }, sharedOc: { absentGrant, disabledToolAndDeniedGrant: deniedGrant }, passwordpasswordAccepted: true, passwordResetAuditMetadataError: "AUDIT_METADATA_SENSITIVE_KEY" }, null, 2));
  } finally {
    await app.close();
    await models.sequelize.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
