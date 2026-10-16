"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, createHmac } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");
const root = path.resolve(__dirname, "../..");
const owner = randomUUID();
const container = `goldis-security-audit-${owner}`;
const passwords = Object.fromEntries(["owner", "migrator", "api", "worker", "enrichment"].map((name) => [name, randomBytes(32).toString("hex")]));
let created = false;
function command(name, args, env = process.env) {
  const result = spawnSync(name, args, { cwd: root, env, encoding: "utf8", timeout: 120000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.stderr || result.stdout || result.error?.message}`);
  return result.stdout.trim();
}
async function main() {
  command("docker", ["run", "-d", "--name", container, "--label", `goldis.audit.owner=${owner}`, "-e", "POSTGRES_USER=goldis", "-e", "POSTGRES_DB=goldis", "-e", `POSTGRES_PASSWORD=${passwords.owner}`, "-p", "127.0.0.1::5432", "postgres:17-alpine"]);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "goldis", "-d", "goldis"], { windowsHide: true });
    if (result.status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true);
  command("docker", ["cp", path.join(root, "docker/postgres/ensure-runtime-roles.sh"), `${container}:/tmp/roles.sh`]);
  command("docker", ["exec", "-e", "POSTGRES_USER=goldis", "-e", "POSTGRES_DB=goldis", "-e", `DB_PASSWORD=${passwords.owner}`, "-e", `MIGRATOR_DB_PASSWORD=${passwords.migrator}`, "-e", `API_DB_PASSWORD=${passwords.api}`, "-e", `WORKER_DB_PASSWORD=${passwords.worker}`, "-e", `ENRICHMENT_DB_PASSWORD=${passwords.enrichment}`, container, "sh", "/tmp/roles.sh"]);
  const binding = command("docker", ["port", container, "5432/tcp"]);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const url = (role) => `postgres://goldis_${role}:${passwords[role]}@${binding}/goldis`;
  if (process.argv.includes("--allow-temp-fixture")) {
    const dbOwner = new Client({ connectionString: `postgres://goldis:${passwords.owner}@${binding}/goldis` });
    await dbOwner.connect();
    try { await dbOwner.query("GRANT TEMPORARY ON DATABASE goldis TO goldis_migrator"); }
    finally { await dbOwner.end(); }
    console.log("TEST_ONLY_TEMP_GRANT: disposable migrator adjusted to continue past the separately reproduced migration defect");
  }
  const childEnv = { ...process.env, APP_ENV: "test", NODE_ENV: "test", DATABASE_URL: url("migrator"), WORKER_LIVE_PORTALS: "0" };
  fs.writeFileSync(path.join(__dirname, "runtime-db-migrations.log"), command(process.execPath, ["apps/api/dist/migrate.js"], childEnv));
  console.log(command(process.execPath, ["apps/api/dist/apply-runtime-grants.js"], childEnv));
  try {
    console.log(command(process.execPath, ["apps/api/scripts/runtime-permissions-smoke.cjs"], { ...childEnv, MIGRATOR_DATABASE_URL: url("migrator"), DATABASE_URL: url("api"), WORKER_DATABASE_URL: url("worker"), ENRICHMENT_DATABASE_URL: url("enrichment") }));
  } catch (failure) {
    if (!failure.message.includes('missing FROM-clause entry for table "r"')) throw failure;
    console.log('EXISTING_RUNTIME_PERMISSION_GATE_FAIL: missing FROM-clause entry for table "r"; continuing with independent read-only privilege assertions');
  }
  const privileges = [];
  for (const role of ["migrator", "api", "worker", "enrichment"]) {
    const pg = new Client({ connectionString: url(role) });
    await pg.connect();
    try {
      const result = await pg.query(`SELECT current_user AS role, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolinherit,
        has_schema_privilege(current_user,'public','CREATE') AS ddl,
        has_column_privilege(current_user,'public.users','password_hash','SELECT') AS password_hash_read,
        has_table_privilege(current_user,'public.audit_events','UPDATE') AS audit_update,
        has_table_privilege(current_user,'public.audit_events','DELETE') AS audit_delete,
        has_table_privilege(current_user,'public.automation_runs','UPDATE') AS run_update
        FROM pg_roles r WHERE r.rolname=current_user`);
      const checked = result.rows[0];
      for (const key of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"]) assert.equal(checked[key], false, `${role}:${key}`);
      assert.equal(checked.ddl, role === "migrator");
      if (role !== "migrator") { assert.equal(checked.audit_update, false); assert.equal(checked.audit_delete, false); }
      if (role === "worker" || role === "enrichment") assert.equal(checked.password_hash_read, false);
      if (role === "worker") assert.equal(checked.run_update, true);
      if (role === "enrichment") assert.equal(checked.run_update, false);
      privileges.push(checked);
    } finally { await pg.end(); }
  }
  console.log(JSON.stringify({ independentRuntimePrivilegeAssertions: "PASS", privileges }, null, 2));
  process.env.DATABASE_URL = url("api");
  process.env.SESSION_SECRET = "synthetic-runtime-audit-session-secret-at-least-32";
  process.env.PRIVILEGED_ACTION_BINDING_KEY = "synthetic-runtime-audit-binding-secret-at-least-32";
  require("reflect-metadata");
  const api = (name) => require(path.join(root, "apps/api/dist", name));
  const models = api("db.js");
  try {
    const { hashPassword } = api("password-hash.js");
    const actions = api("privileged-actions.js");
    const { AdminController } = api("admin.js");
    const { TeamService } = api("team.js");
    const tenant = await models.Tenant.findOne({ where: { slug: "goldis" } });
    assert.ok(tenant);
    const now = new Date();
    const adminId = randomUUID(), targetId = randomUUID(), sessionId = randomUUID();
    const originalHash = await hashPassword("Synthetic-only-original-password-2026!");
    for (const [userId, role] of [[adminId, "admin"], [targetId, "operator"]]) {
      await models.User.create({ userId, username: userId, usernameNormalized: userId, passwordHash: originalHash, status: "active", mustChangePassword: false, credentialRevision: 1, createdAt: now, updatedAt: now });
      await models.TenantMembership.create({ tenantId: tenant.tenantId, userId, role, status: "active", createdAt: now, updatedAt: now });
    }
    await models.UserSession.create({ sessionId, tenantId: tenant.tenantId, userId: adminId, credentialRevision: 1, createdAt: now, lastSeenAt: now, lastActivityAt: now, expiresAt: new Date(Date.now() + 600000), revokedAt: null, browserLabel: "Synthetic audit" });
    const csrf = randomBytes(32).toString("base64url");
    const actor = { userId: adminId, actorRef: adminId, tenantId: tenant.tenantId, sessionId, csrf, role: "admin", exp: Date.now() + 600000, version: 2 };
    const payload = Buffer.from(JSON.stringify({ ...actor, v: 2 })).toString("base64url");
    const signature = createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
    const request = { goldisPrincipal: actor, headers: { cookie: `goldis_session=${payload}.${signature}; goldis_csrf=${csrf}`, "x-csrf-token": csrf } };
    const pg = new Client({ connectionString: url("api") });
    await pg.connect();
    try {
      const outcomes = [];
      for (const action of ["admin.user.password", "team.user.password"]) {
        const confirmationId = randomUUID(), idempotencyKey = randomUUID();
        const token = `${confirmationId}.${randomBytes(32).toString("base64url")}`;
        const data = { temporaryPassword: "Synthetic-only-replacement-password-2026!" };
        await pg.query(`INSERT INTO privileged_action_confirmations (confirmation_id,tenant_id,user_id,session_id,credential_revision,action,target_id,payload_fingerprint,token_hash,idempotency_key,created_at,expires_at) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,now(),now()+interval '5 minutes')`, [confirmationId, tenant.tenantId, adminId, sessionId, action, targetId, actions.privilegedActionFingerprint(action, targetId, data), actions.hashPrivilegedActionToken(token), idempotencyKey]);
        let error;
        try {
          if (action.startsWith("admin")) await new AdminController().resetPassword(targetId, { ...data, confirmationToken: token, idempotencyKey }, request);
          else await new TeamService().resetPassword(actor, targetId, { ...data, confirmationToken: token, idempotencyKey });
        } catch (failure) { error = failure.message; }
        assert.equal(error, "AUDIT_METADATA_SENSITIVE_KEY");
        const unchanged = await models.User.findByPk(targetId);
        assert.equal(unchanged.passwordHash, originalHash);
        assert.equal(unchanged.credentialRevision, 1);
        const confirmation = await pg.query("SELECT consumed_at FROM privileged_action_confirmations WHERE confirmation_id=$1", [confirmationId]);
        assert.equal(confirmation.rows[0].consumed_at, null);
        outcomes.push({ action, error, passwordChangeRolledBack: true, confirmationConsumptionRolledBack: true });
      }
      console.log(JSON.stringify({ syntheticDatabaseOnly: true, passwordResetReproduction: outcomes }, null, 2));
    } finally { await pg.end(); }
  } finally { await models.sequelize.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  if (!created) return;
  const inspected = JSON.parse(command("docker", ["inspect", container]));
  assert.equal(inspected[0].Config.Labels["goldis.audit.owner"], owner);
  command("docker", ["rm", "-f", container]);
  console.log("AUDIT_DISPOSABLE_CONTAINER_REMOVED");
});
