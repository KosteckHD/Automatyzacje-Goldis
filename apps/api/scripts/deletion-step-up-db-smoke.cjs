"use strict";

const assert = require("node:assert/strict");
const { createHmac, randomUUID } = require("node:crypto");

function signedRequest(input) {
  const csrf = randomUUID() + randomUUID();
  const payload = Buffer.from(JSON.stringify({
    v: 2, sessionId: input.sessionId, exp: Date.now() + 60_000,
    userId: input.userId, tenantId: input.tenantId, csrf,
  })).toString("base64url");
  const signature = createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
  return {
    ip: "203.0.113.31", socket: { remoteAddress: "203.0.113.31" },
    headers: { cookie: `goldis_session=${payload}.${signature}; goldis_csrf=${csrf}`, "x-csrf-token": csrf },
    goldisPrincipal: {
      exp: Date.now() + 60_000, csrf, userId: input.userId, tenantId: input.tenantId,
      actorRef: input.userId, sessionId: input.sessionId, version: 2, role: input.role,
    },
  };
}

module.exports = async function verifyDeletionStepUpDatabase(seed) {
  const models = require("../dist/infrastructure/database/db");
  const { recordAuditEvent } = require("../dist/features/audit/public");
  const audit = { record: recordAuditEvent };
  const { hashPassword } = require("../dist/features/auth/index");
  const { AuthController } = require("../dist/features/auth/index");
  const { AuthService } = require("../dist/features/auth/auth.service");
  const { AuthenticationRepository } = require("../dist/features/auth/authentication.repository");
  const { SessionService } = require("../dist/features/auth/session.service");
  const { IdentityRepository } = require("../dist/features/identity/identity.repository");
  const { DeletionStepUpController } = require("../dist/features/deletions/deletion-step-up.controller");
  const { DeletionStepUpRepository } = require("../dist/features/deletions/deletion-step-up.repository");
  const { DeletionStepUpService } = require("../dist/features/deletions/deletion-step-up.service");
  const { DeletionsPreviewRepository } = require("../dist/features/deletions/deletions.repository");
  const { DeletionsService } = require("../dist/features/deletions/deletions.service");
  const { AdminMutationsService } = require("../dist/features/admin/admin-mutations.service");
  const { AdminMutationsRepository } = require("../dist/features/admin/admin-mutations.repository");
  const { AdminUsersRepository } = require("../dist/features/admin/admin-users.repository");
  const { AdminUsersService } = require("../dist/features/admin/admin-users.service");
  const { DeletionController } = require("../dist/features/deletions/public");
  const { hashPrivilegedActionToken, privilegedActionFingerprint, PrivilegedActionService } = require("../dist/features/privileged-actions/privileged-actions.service");
  const { consumeDeletionStepUpGrant, createDeletionStepUpGrant } = require("../dist/features/deletions/deletion-step-up");
  const { QueryTypes } = require("sequelize");
  const previousSecret = process.env.SESSION_SECRET;
  const previousBindingKey = process.env.PRIVILEGED_ACTION_BINDING_KEY;
  process.env.SESSION_SECRET = "synthetic-deletion-step-up-session-secret-42";
  process.env.PRIVILEGED_ACTION_BINDING_KEY = "synthetic-deletion-step-up-binding-key-32-bytes-minimum";
  const tenantId = seed.goldisTenantId;
  const now = new Date();
  const password = "Synthetic-only Deletion Manager Password!";
  const ids = { admin: randomUUID(), manager: randomUUID(), adminSession: randomUUID(), managerSession: randomUUID() };
  const cleanBatchId = randomUUID();
  try {
    for (const [key, role] of [["admin", "admin"], ["manager", "manager"]]) {
      const username = `Synthetic.Deletion.${key}.${randomUUID().slice(0, 8)}`;
      const user = await models.User.create({
        userId: ids[key], username, usernameNormalized: username.toLowerCase(), passwordHash: await hashPassword(password),
        status: "active", createdAt: now, updatedAt: now, lastLoginAt: null, mustChangePassword: false, credentialRevision: 1,
      });
      await models.TenantMembership.create({
        tenantId, userId: user.userId, role, status: "active", createdAt: now, updatedAt: now,
      });
      const sessionId = key === "admin" ? ids.adminSession : ids.managerSession;
      await models.UserSession.create({
        sessionId, tenantId, userId: user.userId, credentialRevision: 1, createdAt: now,
        lastSeenAt: now, lastActivityAt: now, expiresAt: new Date(now.getTime() + 60 * 60_000),
        revokedAt: null, revokedBy: null, revokeReason: null, ipHash: null, browserLabel: "Synthetic fixture",
      });
    }
    const grantBefore = await models.sequelize.query(
      `SELECT can_delete_data, deletion_grant_version FROM tenant_memberships WHERE tenant_id = :tenantId AND user_id = :userId`,
      { replacements: { tenantId, userId: ids.manager }, type: QueryTypes.SELECT },
    );
    assert.equal(grantBefore[0].can_delete_data, false, "migracja nadaje grant domyślnie wyłączony");
    assert.equal(Number(grantBefore[0].deletion_grant_version), 0);

    const admin = new AdminUsersService(new AdminUsersRepository(models.sequelize), new AdminMutationsService(new AdminMutationsRepository(models.sequelize)), audit);
    const calls = { failed: 0, cleared: 0 };
    const limiter = {
      async consumeReauthAttempt(userId, sessionId) {
        assert.equal(userId, ids.manager); assert.equal(sessionId, ids.managerSession);
        return { allowed: true, retryAfterSeconds: 0, generation: "synthetic" };
      },
      async recordReauthFailure() { calls.failed += 1; },
      async clearReauth() { calls.cleared += 1; },
    };
    const auth = new AuthController(
      limiter,
      new AuthService(new AuthenticationRepository(audit)),
      new SessionService(new IdentityRepository(audit)),
    );
    const stepUp = new DeletionStepUpController(
      limiter,
      new DeletionStepUpService(new DeletionStepUpRepository(audit)),
    );
    const deletions = new DeletionController(new DeletionsService(new DeletionsPreviewRepository()));
    const managerActor = { userId: ids.manager, tenantId, sessionId: ids.managerSession, role: "manager" };
    const adminActor = { userId: ids.admin, tenantId, sessionId: ids.adminSession, role: "admin" };
    const privilegedActions = new PrivilegedActionService({
      async consumeReauthAttempt() { return { allowed: true, retryAfterSeconds: 0, generation: "synthetic" }; },
      async recordReauthFailure() {},
      async clearReauth() {},
    }, audit);
    const confirmAdminAction = async (action, targetId, payload) => {
      const idempotencyKey = randomUUID();
      const confirmation = await privilegedActions.create(adminActor, signedRequest({
        userId: ids.admin, tenantId, sessionId: ids.adminSession, role: "admin",
      }), { action, targetId, payload, currentPassword: password, idempotencyKey }, { setHeader() {} });
      return { confirmationToken: confirmation.token, idempotencyKey };
    };
    const actorRequest = signedRequest({
      userId: ids.manager, tenantId, sessionId: ids.managerSession, role: "manager",
    });
    assert.equal((await auth.me(actorRequest)).canDeleteData, false,
      "sesja Menedżera odzwierciedla brak grantu kasowania");
    await assert.rejects(deletions.preview({ targetType: "import", targetId: seed.goldis.batchId }, actorRequest),
      (error) => error && error.getStatus?.() === 403);
    await assert.rejects(stepUp.requestStepUp({ currentPassword: password, previewId: randomUUID() }, actorRequest, { setHeader() {} }),
      (error) => error && error.getStatus?.() === 403);
    assert.equal(calls.cleared, 1, "brak uprawnienia odrzuca step-up i zwalnia próbę ponownego uwierzytelnienia");

    const grantPayload = { canDeleteData: true, expectedVersion: 0 };
    const grantConfirmation = await confirmAdminAction("admin.user.deletion-grant", ids.manager, grantPayload);
    const confirmationId = grantConfirmation.confirmationToken.split(".")[0];
    const confirmationRows = await models.sequelize.query(
      `SELECT tenant_id AS "tenantId", user_id AS "userId", session_id AS "sessionId", action,
              target_id AS "targetId", payload_fingerprint AS "payloadFingerprint",
              token_hash AS "tokenHash", idempotency_key AS "idempotencyKey", expires_at AS "expiresAt"
         FROM privileged_action_confirmations WHERE confirmation_id = :confirmationId`,
      { replacements: { confirmationId }, type: QueryTypes.SELECT },
    );
    const storedConfirmation = confirmationRows[0];
    assert.ok(storedConfirmation, "potwierdzenie uprzywilejowane zapisano w transakcji");
    assert.equal(storedConfirmation.tenantId, tenantId);
    assert.equal(storedConfirmation.userId, ids.admin);
    assert.equal(storedConfirmation.sessionId, ids.adminSession);
    assert.equal(storedConfirmation.action, "admin.user.deletion-grant");
    assert.equal(storedConfirmation.targetId, ids.manager);
    assert.equal(
      storedConfirmation.payloadFingerprint,
      privilegedActionFingerprint("admin.user.deletion-grant", ids.manager, grantPayload),
    );
    assert.equal(storedConfirmation.tokenHash, hashPrivilegedActionToken(grantConfirmation.confirmationToken));
    assert.equal(storedConfirmation.idempotencyKey, grantConfirmation.idempotencyKey);
    assert.ok(new Date(storedConfirmation.expiresAt).getTime() > Date.now());
    const contextRows = await models.sequelize.query(
      `SELECT u.status AS "userStatus", u.credential_revision AS "userRevision",
              m.status AS "membershipStatus", m.role,
              s.credential_revision AS "sessionRevision", s.expires_at AS "sessionExpiresAt",
              s.revoked_at AS "sessionRevokedAt"
         FROM users u
         JOIN tenant_memberships m ON m.user_id = u.user_id AND m.tenant_id = :tenantId
         JOIN user_sessions s ON s.user_id = u.user_id AND s.tenant_id = m.tenant_id AND s.session_id = :sessionId
        WHERE u.user_id = :userId`,
      { replacements: { tenantId, userId: ids.admin, sessionId: ids.adminSession }, type: QueryTypes.SELECT },
    );
    assert.deepEqual(contextRows[0], {
      userStatus: "active",
      userRevision: 1,
      membershipStatus: "active",
      role: "admin",
      sessionRevision: 1,
      sessionExpiresAt: contextRows[0].sessionExpiresAt,
      sessionRevokedAt: null,
    });
    assert.ok(new Date(contextRows[0].sessionExpiresAt).getTime() > Date.now());
    const grantResult = await admin.setDeletionGrant(adminActor, ids.manager, { ...grantPayload, ...grantConfirmation });
    assert.deepEqual(grantResult, { userId: ids.manager, canDeleteData: true, version: 1 });
    assert.equal((await auth.me(actorRequest)).canDeleteData, true,
      "aktywna sesja Menedżera widzi nadany grant bez ponownego logowania");
    await assert.rejects(deletions.preview({ targetType: "import", targetId: seed.other.batchId }, actorRequest),
      (error) => error && error.getStatus?.() === 404);
    const staleGrantPayload = { canDeleteData: true, expectedVersion: 0 };
    const staleGrantConfirmation = await confirmAdminAction("admin.user.deletion-grant", ids.manager, staleGrantPayload);
    await assert.rejects(
      admin.setDeletionGrant(adminActor, ids.manager, { ...staleGrantPayload, ...staleGrantConfirmation }),
      (error) => error && error.getStatus?.() === 409,
    );
    await assert.rejects(deletions.preview({ targetType: "tenant" }, actorRequest),
      (error) => error && error.getStatus?.() === 403);
    const adminTenantPreview = await deletions.preview({ targetType: "tenant" }, signedRequest({
      userId: ids.admin, tenantId, sessionId: ids.adminSession, role: "admin",
    }));
    assert.equal(adminTenantPreview.targetType, "tenant");
    assert.equal(adminTenantPreview.targetId, null);
    assert.equal(adminTenantPreview.requiresStepUp, true);
    const blockedPreview = await deletions.preview({ targetType: "import", targetId: seed.goldis.batchId }, actorRequest);
    assert.ok(blockedPreview.summary.blockers.length > 0, "import z aktywnym przebiegiem pokazuje blokadę zamiast udawać bezpieczne kasowanie");
    await assert.rejects(stepUp.requestStepUp({ currentPassword: password, previewId: blockedPreview.previewId }, actorRequest, { setHeader() {} }),
      (error) => error && error.getStatus?.() === 409);

    await models.ImportBatch.create({
      id: cleanBatchId, tenantId, ownerUserId: ids.manager, toolId: "oc-policy-verification",
      fileName: "synthetic-deletion-preview.xlsx", sha256: "e".repeat(64), totalRows: 0, invalidRows: 0, createdAt: new Date(),
    });
    const stalePreview = await deletions.preview({ targetType: "import", targetId: cleanBatchId }, actorRequest);
    await models.ImportBatch.update({ totalRows: 1 }, { where: { id: cleanBatchId } });
    await assert.rejects(stepUp.requestStepUp({ currentPassword: password, previewId: stalePreview.previewId }, actorRequest, { setHeader() {} }),
      (error) => error && error.getStatus?.() === 409);
    await models.ImportBatch.update({ totalRows: 0 }, { where: { id: cleanBatchId } });
    const preview = await deletions.preview({ targetType: "import", targetId: cleanBatchId }, actorRequest);
    assert.equal(preview.requiresStepUp, true);
    assert.equal(preview.summary.counts.imports, 1);
    assert.equal(preview.summary.counts.sourceRows >= 0, true);
    assert.deepEqual(preview.summary.blockers, []);
    assert.match(preview.previewId, /^[0-9a-f-]{36}$/i);
    assert.equal(Object.hasOwn(preview, "fingerprint"), false, "fingerprint nalezy do serwera i nie jest inputem klienta");
    const persistedPreview = await models.sequelize.query(
      `SELECT scope_fingerprint, summary, actor_user_id, session_id FROM deletion_previews WHERE preview_id = :previewId`,
      { replacements: { previewId: preview.previewId }, type: QueryTypes.SELECT },
    );
    assert.equal(persistedPreview.length, 1);
    assert.match(persistedPreview[0].scope_fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(persistedPreview[0].summary, preview.summary);
    assert.equal(persistedPreview[0].actor_user_id, ids.manager);
    assert.equal(persistedPreview[0].session_id, ids.managerSession);
    const issued = await stepUp.requestStepUp({ currentPassword: password, previewId: preview.previewId }, actorRequest, { setHeader() {} });
    assert.match(issued.stepUpToken, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/i);
    assert.equal(Date.parse(issued.expiresAt) > Date.now(), true);
    const persisted = await models.sequelize.query(
      `SELECT token_hash, preview_id, scope_fingerprint, deletion_grant_version FROM deletion_step_up_grants WHERE grant_id = :grantId`,
      { replacements: { grantId: issued.stepUpToken.split(".")[0] }, type: QueryTypes.SELECT },
    );
    assert.equal(persisted.length, 1);
    assert.notEqual(persisted[0].token_hash, issued.stepUpToken, "DB przechowuje wyłącznie hash tokenu");
    assert.equal(persisted[0].preview_id, preview.previewId);
    assert.equal(persisted[0].scope_fingerprint, persistedPreview[0].scope_fingerprint);
    assert.equal(Number(persisted[0].deletion_grant_version), 1);

    const consume = (token, previewId, scopeFingerprint, credentialRevision = 1, deletionGrantVersion = 1) =>
      models.sequelize.transaction((transaction) => consumeDeletionStepUpGrant({
        token, actor: managerActor, previewId, credentialRevision, deletionGrantVersion, scopeFingerprint, transaction,
      }));
    const fingerprint = persistedPreview[0].scope_fingerprint;
    assert.equal(await consume(issued.stepUpToken, preview.previewId, fingerprint), true);
    assert.equal(await consume(issued.stepUpToken, preview.previewId, fingerprint), false, "ten sam token może zostać zużyty tylko raz");

    const secondPreview = await deletions.preview({ targetType: "import", targetId: cleanBatchId }, actorRequest);
    const secondStored = await models.sequelize.query(
      `SELECT scope_fingerprint FROM deletion_previews WHERE preview_id = :previewId`,
      { replacements: { previewId: secondPreview.previewId }, type: QueryTypes.SELECT },
    );
    const secondFingerprint = secondStored[0].scope_fingerprint;
    const second = await stepUp.requestStepUp({ currentPassword: password, previewId: secondPreview.previewId }, actorRequest, { setHeader() {} });
    await assert.rejects(stepUp.requestStepUp({ currentPassword: password, previewId: secondPreview.previewId }, actorRequest, { setHeader() {} }),
      (error) => error && error.getStatus?.() === 409);
    assert.equal(await consume(second.stepUpToken, secondPreview.previewId, secondFingerprint, 2, 1), false, "zmiana rewizji poświadczeń unieważnia token");
    assert.equal(await consume(second.stepUpToken, secondPreview.previewId, secondFingerprint, 1, 2), false, "zmiana rewizji grantu unieważnia token");
    assert.equal(await consume(second.stepUpToken, preview.previewId, secondFingerprint), false, "token jest związany z identyfikatorem podglądu");
    assert.equal(await consume(second.stepUpToken, secondPreview.previewId, "c".repeat(64)), false, "token jest związany z fingerprintem podglądu");
    assert.equal(await consume(second.stepUpToken, secondPreview.previewId, secondFingerprint), true, "odmowa nie zużywa grantu z aktualnego podglądu");
    assert.equal(calls.cleared, 6);
    assert.equal(calls.failed, 0);

    const expiredToken = await models.sequelize.transaction((transaction) => createDeletionStepUpGrant({
      actor: managerActor, previewId: secondPreview.previewId, credentialRevision: 1, deletionGrantVersion: 1,
      scopeFingerprint: secondFingerprint, now: new Date(Date.now() - 6 * 60_000), transaction,
    }));
    assert.equal(await consume(expiredToken, secondPreview.previewId, secondFingerprint), false, "token wygasł po pięciu minutach");

    const rolePayload = { role: "operator" };
    const roleConfirmation = await confirmAdminAction("admin.user.role", ids.manager, rolePayload);
    await admin.updateRole(adminActor, { userId: ids.manager, ...rolePayload, ...roleConfirmation });
    const revoked = await models.sequelize.query(
      `SELECT role, can_delete_data, deletion_grant_version FROM tenant_memberships WHERE tenant_id = :tenantId AND user_id = :userId`,
      { replacements: { tenantId, userId: ids.manager }, type: QueryTypes.SELECT },
    );
    assert.equal(revoked[0].role, "operator");
    assert.equal(revoked[0].can_delete_data, false, "zmiana roli cofa grant kasowania");
    assert.equal(Number(revoked[0].deletion_grant_version), 2);
    console.log("DELETION_STEP_UP_DB_PASS authoritativePreview=true defaultGrant=false managerSessionGrantRefresh=true unauthorizedManagerDenied=true adminGrantCAS=true managerPasswordStepUp=true hashedOneUseToken=true boundPreviewFingerprintSessionCredentialAndGrantRevision=true expiration=true roleChangeRevokesGrant=true");
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousBindingKey === undefined) delete process.env.PRIVILEGED_ACTION_BINDING_KEY;
    else process.env.PRIVILEGED_ACTION_BINDING_KEY = previousBindingKey;
    await models.ImportBatch.destroy({ where: { id: cleanBatchId } }).catch(() => {});
    await models.UserSession.destroy({ where: { sessionId: [ids.adminSession, ids.managerSession] } }).catch(() => {});
    await models.TenantMembership.destroy({ where: { tenantId, userId: [ids.admin, ids.manager] } }).catch(() => {});
    await models.User.destroy({ where: { userId: [ids.admin, ids.manager] } }).catch(() => {});
  }
};
