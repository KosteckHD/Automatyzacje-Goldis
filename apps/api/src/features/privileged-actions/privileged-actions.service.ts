import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { QueryTypes, type Transaction } from "sequelize";
import { lockUsersInTransaction } from "../../contracts/user-serialization";
import { loadApiSecretConfig } from "../../infrastructure/config";
import { AuditService } from "../audit/public";
import {
  LoginRateLimiter,
  readSessionPrincipal,
  SessionGuard,
  type SessionPrincipal,
  verifyCsrfRequest,
} from "../auth/public";
import { canonicalJsonStringify } from "../results/public";

export const privilegedActionLifetimeMs = 5 * 60_000;

const actionRoles: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "team.user.create": ["manager", "admin"],
  "team.user.status": ["manager", "admin"],
  "team.user.password": ["manager", "admin"],
  "team.user.recovery-link": ["manager", "admin"],
  "team.user.recovery-email": ["manager", "admin"],
  "team.user.access": ["manager", "admin"],
  "admin.user.create": ["admin"],
  "admin.user.grant.set": ["admin"],
  "admin.user.grant.revoke": ["admin"],
  "admin.user.deletion-grant": ["admin"],
  "admin.user.session.revoke": ["admin"],
  "admin.user.sessions.revoke": ["admin"],
  "admin.user.status": ["admin"],
  "admin.user.role": ["admin"],
  "admin.user.password": ["admin"],
  "admin.user.recovery-link": ["admin"],
  "admin.user.recovery-email": ["admin"],
});

type ConfirmationInput = Readonly<{
  actor: SessionPrincipal;
  action: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  token: unknown;
  idempotencyKey: unknown;
  transaction: Transaction;
}>;

type ConfirmationRow = {
  confirmationId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  credentialRevision: number;
  action: string;
  targetId: string | null;
  payloadFingerprint: string;
  idempotencyKey: string;
  expiresAt: Date;
  consumedAt: Date | null;
  response: unknown;
};

type ActiveActionContext = {
  userStatus: string;
  userRevision: number;
  membershipStatus: string;
  role: string;
  sessionRevision: number;
  sessionExpiresAt: Date;
  sessionRevokedAt: Date | null;
};

function bindingKey(): string {
  const value = loadApiSecretConfig().privilegedActionBindingKey;
  if (!value || Buffer.byteLength(value, "utf8") < 32)
    throw new Error("PRIVILEGED_ACTION_BINDING_KEY must have at least 32 bytes");
  return value;
}

export function privilegedActionFingerprint(
  action: string,
  targetId: string | null,
  payload: Record<string, unknown>,
): string {
  const canonical = canonicalJsonStringify({ action, targetId, payload });
  return createHmac("sha256", bindingKey())
    .update("goldis:privileged-action:v1\0", "utf8")
    .update(canonical, "utf8")
    .digest("hex");
}

export function hashPrivilegedActionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function privilegedActionAllowed(role: string, action: string): boolean {
  return actionRoles[action]?.includes(role) === true;
}

function validUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function safePayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("Nieprawidłowy zakres potwierdzenia");
  let serialized: string;
  try {
    serialized = canonicalJsonStringify(value);
  } catch {
    throw new BadRequestException("Nieprawidłowy zakres potwierdzenia");
  }
  if (Buffer.byteLength(serialized, "utf8") > 16_384)
    throw new BadRequestException("Zakres potwierdzenia jest za duży");
  return value as Record<string, unknown>;
}

export async function consumePrivilegedAction(
  input: ConfirmationInput,
): Promise<
  | { readonly kind: "execute"; readonly confirmationId: string }
  | { readonly kind: "replay"; readonly response: unknown }
  | null
> {
  const { sequelize } = await import("../../infrastructure/database/db");
  if (
    typeof input.token !== "string" ||
    input.token.length > 128 ||
    !validUuid(input.idempotencyKey) ||
    !privilegedActionAllowed(input.actor.role, input.action)
  )
    return null;
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{40,})$/i.exec(
      input.token,
    );
  if (!match) return null;
  let fingerprint: string;
  try {
    fingerprint = privilegedActionFingerprint(input.action, input.targetId, input.payload);
  } catch {
    return null;
  }
  const contextRows = await sequelize.query<ActiveActionContext>(
    `SELECT u.status AS "userStatus", u.credential_revision AS "userRevision",
            m.status AS "membershipStatus", m.role,
            s.credential_revision AS "sessionRevision", s.expires_at AS "sessionExpiresAt",
            s.revoked_at AS "sessionRevokedAt"
       FROM users u
       JOIN tenant_memberships m ON m.user_id = u.user_id AND m.tenant_id = :tenantId
       JOIN user_sessions s ON s.user_id = u.user_id AND s.tenant_id = m.tenant_id AND s.session_id = :sessionId
      WHERE u.user_id = :userId`,
    {
      replacements: { tenantId: input.actor.tenantId, userId: input.actor.userId, sessionId: input.actor.sessionId },
      type: QueryTypes.SELECT,
      transaction: input.transaction,
    },
  );
  const context = contextRows[0];
  if (
    context?.userStatus !== "active" ||
    context.membershipStatus !== "active" ||
    context.role !== input.actor.role ||
    context.sessionRevokedAt !== null ||
    new Date(context.sessionExpiresAt).getTime() <= Date.now() ||
    context.userRevision !== context.sessionRevision
  )
    return null;
  const rows = await sequelize.query<ConfirmationRow>(
    `SELECT confirmation_id AS "confirmationId", tenant_id AS "tenantId", user_id AS "userId",
            session_id AS "sessionId", credential_revision AS "credentialRevision", action,
            target_id AS "targetId", payload_fingerprint AS "payloadFingerprint",
            idempotency_key AS "idempotencyKey", expires_at AS "expiresAt", consumed_at AS "consumedAt",
            response
       FROM privileged_action_confirmations
      WHERE confirmation_id = :confirmationId AND token_hash = :tokenHash
      FOR UPDATE`,
    {
      replacements: { confirmationId: match[1].toLowerCase(), tokenHash: hashPrivilegedActionToken(input.token) },
      type: QueryTypes.SELECT,
      transaction: input.transaction,
    },
  );
  const row = rows[0];
  if (
    !row ||
    row.tenantId !== input.actor.tenantId ||
    row.userId !== input.actor.userId ||
    row.sessionId !== input.actor.sessionId ||
    row.credentialRevision < 1 ||
    row.credentialRevision !== context.userRevision ||
    row.action !== input.action ||
    row.targetId !== input.targetId ||
    row.payloadFingerprint !== fingerprint ||
    row.idempotencyKey !== input.idempotencyKey
  )
    return null;
  const now = new Date();
  if (row.consumedAt) {
    if (new Date(row.expiresAt).getTime() <= now.getTime() || row.response === null || row.response === undefined)
      return null;
    return { kind: "replay", response: row.response };
  }
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return null;
  const changed = await sequelize.query<{ confirmationId: string }>(
    `UPDATE privileged_action_confirmations SET consumed_at = :now
      WHERE confirmation_id = :confirmationId AND consumed_at IS NULL AND expires_at > :now
      RETURNING confirmation_id AS "confirmationId"`,
    {
      replacements: { confirmationId: row.confirmationId, now },
      type: QueryTypes.SELECT,
      transaction: input.transaction,
    },
  );
  if (!changed.length) return null;
  return { kind: "execute", confirmationId: row.confirmationId };
}

export async function completePrivilegedAction(
  confirmationId: string,
  idempotencyKey: string,
  response: unknown,
  transaction: Transaction,
): Promise<void> {
  const { sequelize } = await import("../../infrastructure/database/db");
  const encoded = JSON.stringify(response);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 16_384)
    throw new Error("PRIVILEGED_ACTION_RESPONSE_INVALID");
  const rows = await sequelize.query<{ confirmationId: string }>(
    `UPDATE privileged_action_confirmations SET response = CAST(:response AS jsonb)
      WHERE confirmation_id = :confirmationId AND idempotency_key = :idempotencyKey AND consumed_at IS NOT NULL
      RETURNING confirmation_id AS "confirmationId"`,
    { replacements: { confirmationId, idempotencyKey, response: encoded }, type: QueryTypes.SELECT, transaction },
  );
  if (!rows.length) throw new Error("PRIVILEGED_ACTION_CONFIRMATION_COMPLETION_FAILED");
}

export async function runConfirmedPrivilegedAction<T>(
  input: ConfirmationInput,
  operation: () => Promise<T>,
): Promise<T> {
  const confirmation = await consumePrivilegedAction(input);
  if (!confirmation)
    throw new UnauthorizedException("Potwierdzenie wygasło lub nie pasuje do tej operacji. Potwierdź ją ponownie.");
  if (confirmation.kind === "replay") return confirmation.response as T;
  const result = await operation();
  await completePrivilegedAction(confirmation.confirmationId, String(input.idempotencyKey), result, input.transaction);
  return result;
}

@Injectable()
export class PrivilegedActionService {
  constructor(
    @Inject(LoginRateLimiter) private readonly loginRateLimiter: LoginRateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(actor: SessionPrincipal, request: Request, input: unknown, response: Response) {
    if (!actor.sessionId) throw new UnauthorizedException();
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new BadRequestException("Nieprawidłowe dane potwierdzenia");
    const body = input as Record<string, unknown>;
    const allowedKeys = new Set(["action", "targetId", "payload", "currentPassword", "idempotencyKey"]);
    if (
      Object.keys(body).some((key) => !allowedKeys.has(key)) ||
      typeof body.action !== "string" ||
      !privilegedActionAllowed(actor.role, body.action) ||
      !validUuid(body.idempotencyKey) ||
      (body.targetId !== null && (typeof body.targetId !== "string" || body.targetId.length > 180)) ||
      typeof body.currentPassword !== "string" ||
      body.currentPassword.length > 1024 ||
      Buffer.byteLength(body.currentPassword, "utf8") > 4096
    ) {
      throw new BadRequestException("Nieprawidłowe dane potwierdzenia");
    }
    const targetId = body.targetId as string | null;
    const payload = safePayload(body.payload);
    const clientIp = request.ip || request.socket.remoteAddress || "unknown";
    const attempt = await this.loginRateLimiter.consumeReauthAttempt(actor.userId, actor.sessionId, clientIp);
    if (!attempt.allowed) {
      response.setHeader("Retry-After", String(attempt.retryAfterSeconds));
      throw new HttpException("Za dużo prób ponownego uwierzytelnienia. Spróbuj później.", 429);
    }
    const { User, UserSession, TenantMembership, sequelize } = await import("../../infrastructure/database/db");
    const user = await User.findByPk(actor.userId, {
      attributes: ["userId", "passwordHash", "credentialRevision", "status"],
    });
    const membership = await TenantMembership.findOne({
      where: { userId: actor.userId, tenantId: actor.tenantId, status: "active" },
    });
    const session = await UserSession.findOne({
      where: { sessionId: actor.sessionId, userId: actor.userId, tenantId: actor.tenantId, revokedAt: null },
    });
    const validContext =
      user?.status === "active" &&
      membership &&
      session &&
      session.expiresAt.getTime() > Date.now() &&
      session.credentialRevision === user.credentialRevision &&
      membership.role === actor.role;
    if (!validContext) {
      await this.loginRateLimiter.clearReauth(actor.userId, actor.sessionId, attempt);
      throw new ForbiddenException("Sesja lub uprawnienia nie są już aktywne");
    }
    const { verifyPassword } = await import("../auth");
    if (!(await verifyPassword(body.currentPassword as string, user.passwordHash))) {
      await this.loginRateLimiter.recordReauthFailure(actor.userId, attempt);
      throw new UnauthorizedException("Nieprawidłowe obecne hasło");
    }
    const tokenId = randomUUID();
    const token = `${tokenId}.${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + privilegedActionLifetimeMs);
    const fingerprint = privilegedActionFingerprint(body.action, targetId, payload);
    try {
      await sequelize.transaction(async (transaction: Transaction) => {
        await lockUsersInTransaction([actor.userId], transaction);
        const currentUser = await User.findByPk(actor.userId, { transaction, lock: transaction.LOCK.UPDATE });
        const currentMembership = await TenantMembership.findOne({
          where: { tenantId: actor.tenantId, userId: actor.userId, status: "active" },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const currentSession = await UserSession.findOne({
          where: { tenantId: actor.tenantId, userId: actor.userId, sessionId: actor.sessionId, revokedAt: null },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (
          currentUser?.status !== "active" ||
          currentUser.passwordHash !== user.passwordHash ||
          currentUser.credentialRevision !== user.credentialRevision ||
          !currentMembership ||
          currentMembership.role !== actor.role ||
          !privilegedActionAllowed(currentMembership.role, body.action as string) ||
          !currentSession ||
          currentSession.expiresAt.getTime() <= now.getTime() ||
          currentSession.credentialRevision !== currentUser.credentialRevision
        ) {
          throw new ForbiddenException("Sesja lub uprawnienia zmieniły się podczas potwierdzania");
        }
        await sequelize.query(
          "DELETE FROM privileged_action_confirmations WHERE expires_at <= :now OR (consumed_at IS NOT NULL AND created_at < :retentionCutoff)",
          {
            replacements: { now, retentionCutoff: new Date(now.getTime() - 24 * 60 * 60_000) },
            transaction,
          },
        );
        await sequelize.query(
          `INSERT INTO privileged_action_confirmations
             (confirmation_id, tenant_id, user_id, session_id, credential_revision, action, target_id,
              payload_fingerprint, token_hash, idempotency_key, created_at, expires_at, consumed_at, response)
           VALUES (:confirmationId, :tenantId, :userId, :sessionId, :credentialRevision, :action, :targetId,
              :payloadFingerprint, :tokenHash, :idempotencyKey, :now, :expiresAt, NULL, NULL)`,
          {
            replacements: {
              confirmationId: tokenId,
              tenantId: actor.tenantId,
              userId: actor.userId,
              sessionId: actor.sessionId,
              credentialRevision: currentUser.credentialRevision,
              action: body.action,
              targetId,
              payloadFingerprint: fingerprint,
              tokenHash: hashPrivilegedActionToken(token),
              idempotencyKey: body.idempotencyKey,
              now,
              expiresAt,
            },
            transaction,
          },
        );
        await this.audit.record(
          {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: "privileged_action.confirmed",
            resourceType: "user",
            resourceId: actor.userId,
            outcome: "succeeded",
            metadata: { action: body.action as string, targetId, confirmationId: tokenId },
          },
          transaction,
        );
      });
    } catch (error) {
      await this.loginRateLimiter.clearReauth(actor.userId, actor.sessionId, attempt);
      throw error;
    }
    await this.loginRateLimiter.clearReauth(actor.userId, actor.sessionId, attempt);
    return { token, expiresAt: expiresAt.toISOString() };
  }
}

@Controller("admin/privileged-confirmations")
@UseGuards(SessionGuard)
export class PrivilegedActionController {
  constructor(@Inject(PrivilegedActionService) private readonly privilegedActions: PrivilegedActionService) {}

  @Post()
  create(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() input: unknown) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const actor = readSessionPrincipal(request);
    if (!actor) throw new UnauthorizedException();
    return this.privilegedActions.create(actor, request, input, response);
  }
}
