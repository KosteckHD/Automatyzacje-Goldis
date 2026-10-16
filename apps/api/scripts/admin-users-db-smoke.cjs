"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const models = require("../dist/infrastructure/database/db");
const { hashPassword } = require("../dist/features/auth/password-hash");

module.exports = async function verifyAdminUserCreation(seed) {
  const previousBindingKey = process.env.PRIVILEGED_ACTION_BINDING_KEY;
  process.env.PRIVILEGED_ACTION_BINDING_KEY = "synthetic-admin-users-db-binding-key-32-bytes";
  let stage = "seed_admin";
  try {
    const { AdminMutationsService } = require("../dist/features/admin/admin-mutations.service");
    const { AdminMutationsRepository } = require("../dist/features/admin/admin-mutations.repository");
    const { AdminUsersRepository } = require("../dist/features/admin/admin-users.repository");
    const { AdminUsersService } = require("../dist/features/admin/admin-users.service");
    const { parseAdminCreateUserInput } = require("../dist/features/admin/admin-users.dto");
    const { AuditRepository } = require("../dist/features/audit/audit.repository");
    const { AuditService } = require("../dist/features/audit/audit.service");
    const { PrivilegedActionService } = require("../dist/features/privileged-actions/privileged-actions.service");
    const audit = new AuditService(new AuditRepository());

    const now = new Date();
    const actorUserId = randomUUID();
    const sessionId = randomUUID();
    const password = "Synthetic-only Admin Owner Password!";
    const username = `Synthetic.Admin.Owner.${randomUUID().slice(0, 8)}`;
    await models.User.create({
      userId: actorUserId,
      username,
      usernameNormalized: username.toLowerCase(),
      passwordHash: await hashPassword(password),
      status: "active",
      credentialRevision: 1,
      mustChangePassword: false,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    });
    await models.TenantMembership.create({
      tenantId: seed.goldisTenantId,
      userId: actorUserId,
      role: "admin",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await models.UserSession.create({
      sessionId,
      tenantId: seed.goldisTenantId,
      userId: actorUserId,
      credentialRevision: 1,
      createdAt: now,
      lastSeenAt: now,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      ipHash: null,
      browserLabel: "Synthetic Admin DB smoke",
    });

    const actor = {
      userId: actorUserId,
      tenantId: seed.goldisTenantId,
      actorRef: actorUserId,
      role: "admin",
      sessionId,
      exp: Date.now() + 3_600_000,
      csrf: "synthetic-admin-users-csrf-token-0123456789",
      version: 2,
    };
    const confirmations = new PrivilegedActionService({
      async consumeReauthAttempt() { return { allowed: true, retryAfterSeconds: 0 }; },
      async clearReauth() {},
      async recordReauthFailure() {},
    }, audit);
    const confirm = async (action, targetId, payload, idempotencyKey) => confirmations.create(
      actor,
      { ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } },
      { action, targetId, payload, currentPassword: password, idempotencyKey },
      { setHeader() {} },
    );
    const repository = new AdminUsersRepository(models.sequelize);
    const mutations = new AdminMutationsService(new AdminMutationsRepository(models.sequelize));
    const service = new AdminUsersService(repository, mutations, audit);

    const input = {
      username: `Synthetic.Admin.Created.${randomUUID().slice(0, 8)}`,
      password: "Synthetic-only Admin Created User Password!",
      role: "operator",
    };
    const idempotencyKey = randomUUID();
    stage = "create_account";
    const confirmation = await confirm("admin.user.create", null, input, idempotencyKey);
    const request = parseAdminCreateUserInput({ ...input, confirmationToken: confirmation.token, idempotencyKey });
    const created = await service.createUser(actor, request);
    assert.equal(created.role, "operator");
    assert.equal(created.status, "active");
    assert.equal(created.mustChangePassword, true);
    const replay = await service.createUser(actor, request);
    assert.deepEqual(replay, created, "same idempotency key replays the created account");
    assert.equal(await models.User.count({ where: { usernameNormalized: input.username.toLowerCase() } }), 1);
    assert.equal(await models.TenantMembership.count({ where: { tenantId: seed.goldisTenantId, userId: created.userId } }), 1);
    assert.equal(await models.AuditEvent.count({ where: { action: "user.created", resourceId: created.userId } }), 1);

    const createdUser = await models.User.findByPk(created.userId);
    const targetSessionId = randomUUID();
    const laterSessionId = randomUUID();
    const expiredSessionId = randomUUID();
    const addSession = async (sessionId, expiresAt, createdAt = now) => models.UserSession.create({
      sessionId,
      tenantId: seed.goldisTenantId,
      userId: created.userId,
      credentialRevision: createdUser.credentialRevision,
      createdAt,
      lastSeenAt: createdAt,
      lastActivityAt: createdAt,
      expiresAt,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      ipHash: null,
      browserLabel: "Synthetic Admin DB smoke target",
    });
    await addSession(targetSessionId, new Date(now.getTime() + 3_600_000));
    const revokeOneKey = randomUUID();
    stage = "revoke_one_session";
    const revokeOneConfirmation = await confirm(
      "admin.user.session.revoke",
      `${created.userId}/${targetSessionId}`,
      {},
      revokeOneKey,
    );
    const revokedOne = await service.revokeSession(actor, {
      userId: created.userId,
      sessionId: targetSessionId,
      confirmationToken: revokeOneConfirmation.token,
      idempotencyKey: revokeOneKey,
    });
    assert.equal(revokedOne.revoked, true);
    assert.equal(revokedOne.currentSession, false);
    assert.ok((await models.UserSession.findByPk(targetSessionId)).revokedAt);

    await addSession(laterSessionId, new Date(now.getTime() + 3_600_000));
    await addSession(
      expiredSessionId,
      new Date(now.getTime() - 3_600_000),
      new Date(now.getTime() - 7_200_000),
    );
    const revokeAllKey = randomUUID();
    stage = "revoke_active_sessions";
    const revokeAllConfirmation = await confirm("admin.user.sessions.revoke", created.userId, {}, revokeAllKey);
    const revokedAll = await service.revokeSessions(actor, {
      userId: created.userId,
      confirmationToken: revokeAllConfirmation.token,
      idempotencyKey: revokeAllKey,
    });
    assert.equal(revokedAll.revokedCount, 1, "bulk revocation changes only unexpired active sessions");
    assert.ok((await models.UserSession.findByPk(laterSessionId)).revokedAt);
    assert.equal((await models.UserSession.findByPk(expiredSessionId)).revokedAt, null);

    const roleSessionId = randomUUID();
    await addSession(roleSessionId, new Date(now.getTime() + 3_600_000));
    const rolePayload = { role: "reviewer" };
    const roleKey = randomUUID();
    stage = "change_role";
    const roleConfirmation = await confirm("admin.user.role", created.userId, rolePayload, roleKey);
    const roleResult = await service.updateRole(actor, {
      userId: created.userId,
      ...rolePayload,
      confirmationToken: roleConfirmation.token,
      idempotencyKey: roleKey,
    });
    assert.equal(roleResult.role, "reviewer");
    assert.equal((await models.TenantMembership.findOne({ where: { tenantId: seed.goldisTenantId, userId: created.userId } })).role, "reviewer");
    assert.ok((await models.UserSession.findByPk(roleSessionId)).revokedAt, "role changes revoke current target sessions");

    const temporaryPassword = "Synthetic-only Admin Reset Password!";
    const passwordPayload = { temporaryPassword };
    const passwordKey = randomUUID();
    stage = "reset_password";
    const passwordConfirmation = await confirm("admin.user.password", created.userId, passwordPayload, passwordKey);
    const passwordResult = await service.resetPassword(actor, {
      userId: created.userId,
      ...passwordPayload,
      confirmationToken: passwordConfirmation.token,
      idempotencyKey: passwordKey,
    });
    assert.equal(passwordResult.mustChangePassword, true);
    assert.equal((await models.User.findByPk(created.userId)).mustChangePassword, true);

    const disableKey = randomUUID();
    stage = "disable_user";
    const disableConfirmation = await confirm("admin.user.status", created.userId, { status: "disabled" }, disableKey);
    const disabled = await service.setUserStatus(actor, {
      userId: created.userId,
      status: "disabled",
      confirmationToken: disableConfirmation.token,
      idempotencyKey: disableKey,
    });
    assert.equal(disabled.status, "disabled");
    assert.equal((await models.TenantMembership.findOne({ where: { tenantId: seed.goldisTenantId, userId: created.userId } })).status, "disabled");
    assert.equal((await models.User.findByPk(created.userId)).status, "disabled");

    const enableKey = randomUUID();
    stage = "enable_user";
    const enableConfirmation = await confirm("admin.user.status", created.userId, { status: "active" }, enableKey);
    const enabled = await service.setUserStatus(actor, {
      userId: created.userId,
      status: "active",
      confirmationToken: enableConfirmation.token,
      idempotencyKey: enableKey,
    });
    assert.equal(enabled.status, "active");
    assert.equal((await models.TenantMembership.findOne({ where: { tenantId: seed.goldisTenantId, userId: created.userId } })).status, "active");
    assert.equal((await models.User.findByPk(created.userId)).status, "active");

    const rollbackInput = {
      username: `Synthetic.Admin.Rollback.${randomUUID().slice(0, 8)}`,
      password: "Synthetic-only Admin Rollback Password!",
      role: "reviewer",
    };
    const rollbackKey = randomUUID();
    stage = "rollback_audit";
    const rollbackConfirmation = await confirm("admin.user.create", null, rollbackInput, rollbackKey);
    const rollbackRequest = parseAdminCreateUserInput({
      ...rollbackInput,
      confirmationToken: rollbackConfirmation.token,
      idempotencyKey: rollbackKey,
    });
    let rollbackUserId;
    const failingAudit = new AuditService({
      async record(event, transaction) {
        assert.ok(transaction, "audit write receives the user-creation transaction");
        rollbackUserId = event.resourceId;
        throw new Error("SYNTHETIC_ADMIN_AUDIT_FAILURE");
      },
    });
    const rollbackService = new AdminUsersService(repository, mutations, failingAudit);
    await assert.rejects(rollbackService.createUser(actor, rollbackRequest), /SYNTHETIC_ADMIN_AUDIT_FAILURE/);
    assert.equal(await models.User.count({ where: { usernameNormalized: rollbackInput.username.toLowerCase() } }), 0,
      "audit failure rolls the user insert back");
    assert.equal(await models.TenantMembership.count({ where: { tenantId: seed.goldisTenantId, userId: rollbackUserId } }), 0,
      "audit failure rolls the membership insert back");
    console.log("ADMIN_USER_DB_SMOKE_PASS create=true idempotency=true tenant=true audit=true rollback=true");
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    throw new Error(`ADMIN_USER_DB_SMOKE_FAILED stage=${stage} cause=${message}`, { cause: error });
  } finally {
    if (previousBindingKey === undefined) delete process.env.PRIVILEGED_ACTION_BINDING_KEY;
    else process.env.PRIVILEGED_ACTION_BINDING_KEY = previousBindingKey;
  }
};
