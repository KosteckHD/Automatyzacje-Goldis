"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const models = require("../dist/infrastructure/database/db");
const { hashPassword } = require("../dist/features/auth/index");

async function createAccount(tenantId, role, suffix, now) {
  const userId = randomUUID();
  const username = `Synthetic.Team.${suffix}.${randomUUID().slice(0, 6)}`;
  const password = `Synthetic-only ${suffix} Password!`;
  await models.User.create({ userId, username, usernameNormalized: username.toLowerCase(),
    passwordHash: await hashPassword(password), status: "active", credentialRevision: 1,
    mustChangePassword: false, createdAt: now, updatedAt: now, lastLoginAt: null });
  await models.TenantMembership.create({ tenantId, userId, role, status: "active", createdAt: now, updatedAt: now });
  return { userId, username, password };
}

module.exports = async function verifyTeamFlows(seed) {
  let smokeStage = "setup";
  const previousBindingKey = process.env.PRIVILEGED_ACTION_BINDING_KEY;
  process.env.PRIVILEGED_ACTION_BINDING_KEY = "synthetic-team-db-binding-key-32-bytes-minimum";
  try {
    const { TeamService } = require("../dist/features/teams/index");
    const { TeamRepository } = require("../dist/features/teams/team.repository");
    const { recordAuditEvent } = require("../dist/features/audit/public");
    const { PrivilegedActionService } = require("../dist/features/privileged-actions/privileged-actions.service");
    const { BadRequestException, ConflictException, NotFoundException } = require("@nestjs/common");
    const team = new TeamService({ record: recordAuditEvent }, new TeamRepository(models.sequelize));
    const now = new Date();
    const tenantId = seed.goldisTenantId;
    const manager = await createAccount(tenantId, "manager", "Manager", now);
    const managerSessionId = randomUUID();
    await models.UserSession.create({ sessionId: managerSessionId, tenantId, userId: manager.userId,
      credentialRevision: 1, createdAt: now, lastSeenAt: now, lastActivityAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000), revokedAt: null, revokedBy: null,
      revokeReason: null, ipHash: null, browserLabel: "Synthetic Team DB smoke" });
    const actor = { userId: manager.userId, tenantId, actorRef: manager.userId, role: "manager", sessionId: managerSessionId,
      exp: Date.now() + 3_600_000, csrf: "synthetic-team-db-csrf-token-0123456789", version: 2 };

    const confirmationService = new PrivilegedActionService({
      async consumeReauthAttempt() { return { allowed: true, retryAfterSeconds: 0 }; },
      async clearReauth() {},
      async recordReauthFailure() {},
    }, { record: recordAuditEvent });
    const confirmAction = (action, targetId, payload, idempotencyKey) => confirmationService.create(actor,
      { ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } },
      { action, targetId, payload, currentPassword: manager.password, idempotencyKey }, { setHeader() {} });

    smokeStage = "strict_dto_validation";
    await assert.rejects(team.create(actor, { username: "Synthetic.Unknown.Field", temporaryPassword: "Synthetic-only valid Password!", extra: true }),
      (error) => error instanceof BadRequestException, "team create rejects unknown DTO properties");

    smokeStage = "tenant_a_create_and_idempotency";
    const createPayload = { username: `Synthetic.Team.Created.${randomUUID().slice(0, 8)}`,
      temporaryPassword: "Synthetic-only Created User Password!" };
    const createIdempotencyKey = randomUUID();
    const createConfirmation = await confirmAction("team.user.create", null, createPayload, createIdempotencyKey);
    const createInput = { ...createPayload, confirmationToken: createConfirmation.token, idempotencyKey: createIdempotencyKey };
    const created = await team.create(actor, createInput);
    assert.equal(created.role, "operator");
    assert.equal(created.mustChangePassword, true);
    const replay = await team.create(actor, createInput);
    assert.deepEqual(replay, created, "create retries with the same idempotency key replay the original result");
    assert.equal(await models.User.count({ where: { usernameNormalized: createPayload.username.toLowerCase() } }), 1,
      "an idempotent create persists exactly one account");

    smokeStage = "tenant_b_isolation";
    const otherTenantId = randomUUID();
    await models.Tenant.create({ tenantId: otherTenantId, slug: `team-${randomUUID().slice(0, 12)}`,
      displayName: "Synthetic Team Tenant B", createdAt: now });
    const foreignOperator = await createAccount(otherTenantId, "operator", "TenantB", now);
    const listed = await team.list(actor);
    assert.ok(listed.items.some((item) => item.userId === created.userId), "manager sees its own tenant's operator");
    assert.equal(listed.items.some((item) => item.userId === foreignOperator.userId), false, "manager list never returns another tenant's operator");
    await assert.rejects(team.access(actor, foreignOperator.userId),
      (error) => error instanceof NotFoundException, "cross-tenant operator access is indistinguishable from a missing operator");

    smokeStage = "grant_versioning";
    const accessPayload = { canExecute: true, expectedVersion: 0 };
    const accessKey = randomUUID();
    const accessConfirmation = await confirmAction("team.user.access", created.userId, accessPayload, accessKey);
    const accessInput = { ...accessPayload, confirmationToken: accessConfirmation.token, idempotencyKey: accessKey };
    const granted = await team.setAccess(actor, created.userId, accessInput);
    assert.deepEqual({ canExecute: granted.canExecute, version: granted.version }, { canExecute: true, version: 1 });
    const repeatedGrant = await team.setAccess(actor, created.userId, accessInput);
    assert.deepEqual(repeatedGrant, granted, "same idempotency key replays a grant update");
    const stalePayload = { canExecute: false, expectedVersion: 0 };
    const staleKey = randomUUID();
    const staleConfirmation = await confirmAction("team.user.access", created.userId, stalePayload, staleKey);
    await assert.rejects(team.setAccess(actor, created.userId, { ...stalePayload,
      confirmationToken: staleConfirmation.token, idempotencyKey: staleKey }),
    (error) => error instanceof ConflictException, "stale grant versions are rejected");
    const currentGrant = await team.access(actor, created.userId);
    assert.deepEqual({ canExecute: currentGrant.canExecute, version: currentGrant.version }, { canExecute: true, version: 1 },
      "a rejected stale update leaves the current grant unchanged");

    smokeStage = "password_reset_revocation";
    const createdUser = await models.User.findByPk(created.userId);
    const createdSessionId = randomUUID();
    await models.UserSession.create({ sessionId: createdSessionId, tenantId, userId: created.userId,
      credentialRevision: createdUser.credentialRevision, createdAt: now, lastSeenAt: now, lastActivityAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000), revokedAt: null, revokedBy: null,
      revokeReason: null, ipHash: null, browserLabel: "Synthetic Team target session" });
    const resetPayload = { temporaryPassword: "Synthetic-only Reset Password!" };
    const resetKey = randomUUID();
    const resetConfirmation = await confirmAction("team.user.password", created.userId, resetPayload, resetKey);
    const reset = await team.resetPassword(actor, created.userId, { ...resetPayload,
      confirmationToken: resetConfirmation.token, idempotencyKey: resetKey });
    assert.equal(reset.mustChangePassword, true);
    assert.equal(reset.revokedSessions, 1, "manager password reset revokes the target's active session");
    const revokedTargetSession = await models.UserSession.findByPk(createdSessionId);
    assert.ok(revokedTargetSession.revokedAt);

    smokeStage = "account_disable_revocation";
    const statusTarget = await createAccount(tenantId, "operator", "DisableTarget", now);
    const statusSessionId = randomUUID();
    await models.UserSession.create({ sessionId: statusSessionId, tenantId, userId: statusTarget.userId,
      credentialRevision: 1, createdAt: now, lastSeenAt: now, lastActivityAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000), revokedAt: null, revokedBy: null,
      revokeReason: null, ipHash: null, browserLabel: "Synthetic Team status target" });
    const statusPayload = { status: "disabled" };
    const statusKey = randomUUID();
    const statusConfirmation = await confirmAction("team.user.status", statusTarget.userId, statusPayload, statusKey);
    const status = await team.setStatus(actor, statusTarget.userId, { ...statusPayload,
      confirmationToken: statusConfirmation.token, idempotencyKey: statusKey });
    assert.deepEqual({ status: status.status, revokedSessions: status.revokedSessions }, { status: "disabled", revokedSessions: 1 });
    assert.equal((await models.User.findByPk(statusTarget.userId)).status, "disabled");
    assert.equal((await models.TenantMembership.findOne({ where: { tenantId, userId: statusTarget.userId } })).status, "disabled");
    assert.ok((await models.UserSession.findByPk(statusSessionId)).revokedAt);

    console.log("TEAM_DB_PASS strictDtos=true createIdempotency=true tenantIsolation=true grantVersioning=true passwordResetRevokesSessions=true disableRevokesSessions=true");
  } catch (error) {
    const query = error?.sql ?? error?.parent?.sql;
    if (query) console.error("TEAM_SQL_ERROR", error?.parent?.position ?? error?.position ?? "", query);
    error.message = `team_${smokeStage}: ${error?.parent?.message ?? error?.message ?? "UNKNOWN"}${query ? ` SQL=${query}` : ""}`;
    throw error;
  } finally {
    if (previousBindingKey === undefined) delete process.env.PRIVILEGED_ACTION_BINDING_KEY;
    else process.env.PRIVILEGED_ACTION_BINDING_KEY = previousBindingKey;
  }
};
