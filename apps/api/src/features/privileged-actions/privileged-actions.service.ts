import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { BadRequestException, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Transaction } from "sequelize";
import { loadApiSecretConfig } from "../../infrastructure/config";
import { AuditService } from "../audit/public";
import { verifyPassword } from "../auth";
import { LoginRateLimiter, type SessionPrincipal } from "../auth/public";
import { canonicalJsonStringify } from "../results/public";
import { parseCreatePrivilegedActionInput } from "./privileged-actions.dto";
import type { PrivilegedActionPersistence } from "./privileged-actions.persistence";
import { PrivilegedActionRepository } from "./privileged-actions.repository";

export const privilegedActionLifetimeMs = 5 * 60_000;

function validUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export class ReauthRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Za dużo prób ponownego uwierzytelnienia. Spróbuj później.");
    this.name = "ReauthRateLimitError";
  }
}

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
  "admin.user.commission-dictionary-grant": ["admin"],
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

export async function consumePrivilegedAction(
  input: ConfirmationInput,
  persistence: PrivilegedActionPersistence,
): Promise<
  | { readonly kind: "execute"; readonly confirmationId: string }
  | { readonly kind: "replay"; readonly response: unknown }
  | null
> {
  if (
    !input.actor.sessionId ||
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
  return persistence.consume({
    actor: input.actor,
    confirmationId: match[1].toLowerCase(),
    tokenHash: hashPrivilegedActionToken(input.token),
    action: input.action,
    targetId: input.targetId,
    payloadFingerprint: fingerprint,
    idempotencyKey: input.idempotencyKey,
    transaction: input.transaction,
  });
}

export async function completePrivilegedAction(
  confirmationId: string,
  idempotencyKey: string,
  response: unknown,
  transaction: Transaction,
  persistence: PrivilegedActionPersistence,
): Promise<void> {
  return persistence.complete(confirmationId, idempotencyKey, response, transaction);
}

export async function runConfirmedPrivilegedAction<T>(
  input: ConfirmationInput,
  operation: () => Promise<T>,
  persistence: PrivilegedActionPersistence,
): Promise<T> {
  const confirmation = await consumePrivilegedAction(input, persistence);
  if (!confirmation)
    throw new UnauthorizedException("Potwierdzenie wygasło lub nie pasuje do tej operacji. Potwierdź ją ponownie.");
  if (confirmation.kind === "replay") return confirmation.response as T;
  const result = await operation();
  await completePrivilegedAction(
    confirmation.confirmationId,
    String(input.idempotencyKey),
    result,
    input.transaction,
    persistence,
  );
  return result;
}

@Injectable()
export class PrivilegedActionService {
  constructor(
    @Inject(LoginRateLimiter) private readonly loginRateLimiter: LoginRateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PrivilegedActionRepository) private readonly repository: PrivilegedActionRepository,
  ) {}

  async create(actor: SessionPrincipal, input: unknown, clientIp: string) {
    if (!actor.sessionId) throw new UnauthorizedException();
    const body = parseCreatePrivilegedActionInput(input);
    if (!privilegedActionAllowed(actor.role, body.action))
      throw new BadRequestException("Nieprawidłowe dane potwierdzenia");
    const { action, targetId, idempotencyKey, payload } = body;
    const attempt = await this.loginRateLimiter.consumeReauthAttempt(actor.userId, actor.sessionId, clientIp);
    if (!attempt.allowed) throw new ReauthRateLimitError(attempt.retryAfterSeconds);
    const { user, membership, session } = await this.repository.loadReauthenticationContext(actor);
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
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      await this.loginRateLimiter.recordReauthFailure(actor.userId, attempt);
      throw new UnauthorizedException("Nieprawidłowe obecne hasło");
    }
    const tokenId = randomUUID();
    const token = `${tokenId}.${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + privilegedActionLifetimeMs);
    const fingerprint = privilegedActionFingerprint(action, targetId, payload);
    try {
      await this.repository.transaction(async (transaction: Transaction) => {
        const current = await this.repository.lockActorForConfirmation(actor, transaction);
        const currentUser = current.user;
        const currentMembership = current.membership;
        const currentSession = current.session;
        if (
          currentUser?.status !== "active" ||
          currentUser.passwordHash !== user.passwordHash ||
          currentUser.credentialRevision !== user.credentialRevision ||
          !currentMembership ||
          currentMembership.role !== actor.role ||
          !privilegedActionAllowed(currentMembership.role, action) ||
          !currentSession ||
          currentSession.expiresAt.getTime() <= now.getTime() ||
          currentSession.credentialRevision !== currentUser.credentialRevision
        ) {
          throw new ForbiddenException("Sesja lub uprawnienia zmieniły się podczas potwierdzania");
        }
        await this.repository.insertConfirmation(
          {
            actor,
            confirmationId: tokenId,
            action,
            targetId,
            payloadFingerprint: fingerprint,
            tokenHash: hashPrivilegedActionToken(token),
            idempotencyKey,
            credentialRevision: currentUser.credentialRevision,
            now,
            expiresAt,
          },
          transaction,
        );
        await this.audit.record(
          {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: "privileged_action.confirmed",
            resourceType: "user",
            resourceId: actor.userId,
            outcome: "succeeded",
            metadata: { action, targetId, confirmationId: tokenId },
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
