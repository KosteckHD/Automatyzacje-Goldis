import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Transaction } from "sequelize";
import { AuditService } from "../audit/public";
import {
  applyPasswordChange,
  hashPassword,
  LoginRateLimiter,
  passwordPolicyFailure,
  type SessionPrincipal,
  verifyPassword,
} from "../auth";
import { runConfirmedPrivilegedAction } from "../privileged-actions/public";
import { AccountRecoveryRepository } from "./account-recovery.repository";
import { strictBody } from "./account-recovery.request";
import {
  consumeRecoveryToken,
  createRecoveryToken,
  findRecoveryToken,
  passwordResetLifetimeMs,
  recoveryEmailVerificationLifetimeMs,
  revokeUserRecoveryTokens,
} from "./account-recovery-tokens";
import { readAuthMailConfig } from "./auth-mail-config";
import { cancelAuthMailForToken, enqueueAuthMail } from "./auth-mail-outbox";
import {
  passwordChangedNoticeMail,
  passwordResetMail,
  recoveryEmailChangedNoticeMail,
  verifyRecoveryEmailMail,
} from "./auth-mail-templates";
import { normalizeRecoveryEmail } from "./recovery-email";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const genericRecoveryResponse = Object.freeze({
  message: "Jeśli istnieje aktywne konto z tym adresem, wyślemy link do ustawienia nowego hasła.",
});

function requireMailEnabled(): ReturnType<typeof readAuthMailConfig> {
  const config = readAuthMailConfig();
  if (!config.enabled || config.provider !== "resend" || !config.resendApiKey) {
    throw new ServiceUnavailableException("Odzyskiwanie konta jest chwilowo niedostępne");
  }
  return config;
}

function tokenPurposeError(): never {
  throw new ConflictException("Link jest nieprawidłowy, wygasł albo został już użyty. Poproś o nowy.");
}

async function minimumPublicResponse(startedAt: number): Promise<void> {
  const remaining = 220 - (Date.now() - startedAt);
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

@Injectable()
export class PasswordRecoveryService {
  constructor(
    @Inject(LoginRateLimiter) private readonly rateLimiter: LoginRateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccountRecoveryRepository) private readonly repository: AccountRecoveryRepository,
  ) {}

  private async lockRecoveryActor(
    actor: SessionPrincipal,
    transaction: Transaction,
    targetUserId: string,
  ): Promise<void> {
    const { user, membership, session } = await this.repository.lockRecoveryActor(actor, transaction, targetUserId);
    if (
      user?.status !== "active" ||
      !membership ||
      !session ||
      session.expiresAt.getTime() <= Date.now() ||
      session.credentialRevision !== user.credentialRevision
    ) {
      throw new ForbiddenException("Sesja lub uprawnienia nie są już aktywne");
    }
  }

  async requestPasswordReset(rawEmail: unknown, ip: string): Promise<typeof genericRecoveryResponse> {
    const startedAt = Date.now();
    const email = normalizeRecoveryEmail(rawEmail);
    if (!email) throw new BadRequestException("Podaj poprawny adres e-mail");
    const decision = await this.rateLimiter.consumeRecoveryRequest(email.normalized, ip);
    if (decision.kind === "limited") {
      throw new HttpException("Za dużo prób. Spróbuj ponownie później.", HttpStatus.TOO_MANY_REQUESTS);
    }
    const config = readAuthMailConfig();
    if (decision.kind === "queue" && config.enabled) {
      const accounts = await this.repository.findAccountsByVerifiedEmail(email.normalized);
      const account = accounts[0];
      if (account) {
        const now = new Date();
        await this.repository.transaction(async (transaction) => {
          await this.repository.lockUsers([account.userId], transaction);
          const current = await this.repository.lockVerifiedRecoveryAccount(
            account.userId,
            account.tenantId,
            email.normalized,
            transaction,
          );
          const live = current[0];
          if (!live) return;
          const expiresAt = new Date(now.getTime() + passwordResetLifetimeMs);
          const token = await createRecoveryToken({
            tenantId: live.tenantId,
            userId: live.userId,
            purpose: "password_reset",
            credentialRevision: live.credentialRevision,
            recoveryEmailRevision: live.recoveryEmailRevision,
            normalizedEmail: live.normalizedEmail,
            expiresAt,
            transaction,
          });
          await enqueueAuthMail({
            tenantId: live.tenantId,
            userId: live.userId,
            tokenId: token.tokenId,
            purpose: "password_reset",
            content: passwordResetMail(config, live.email, token.rawToken),
            expiresAt,
            transaction,
            now,
          });
          await this.audit.record(
            {
              tenantId: live.tenantId,
              actorUserId: null,
              action: "auth.recovery.requested",
              resourceType: "user",
              resourceId: live.userId,
              outcome: "succeeded",
              metadata: { flow: "self_service" },
            },
            transaction,
          );
        });
      }
    }
    await minimumPublicResponse(startedAt);
    return genericRecoveryResponse;
  }

  async resetPassword(rawToken: unknown, newPassword: unknown, ip: string): Promise<void> {
    requireMailEnabled();
    if (
      typeof rawToken !== "string" ||
      rawToken.length > 64 ||
      typeof newPassword !== "string" ||
      newPassword.length > 1_024 ||
      Buffer.byteLength(newPassword, "utf8") > 4_096 ||
      passwordPolicyFailure(newPassword)
    ) {
      throw new BadRequestException("Nowe hasło nie spełnia wymagań polityki haseł");
    }
    const attempt = await this.rateLimiter.consumeRecoveryTokenAttempt(ip);
    if (!attempt.allowed)
      throw new HttpException("Za dużo prób. Spróbuj ponownie później.", HttpStatus.TOO_MANY_REQUESTS);
    const initial = await findRecoveryToken(rawToken, "password_reset");
    if (!initial) tokenPurposeError();
    const passwordHash = await hashPassword(newPassword);
    const now = new Date();
    await this.repository.transaction(async (transaction) => {
      await this.repository.lockUsers([initial.userId], transaction);
      const token = await findRecoveryToken(rawToken, "password_reset", transaction, true);
      if (!token || token.tokenId !== initial.tokenId || token.tenantId !== initial.tenantId) tokenPurposeError();
      const user = await this.repository.findUser(token.userId, transaction, true);
      if (user?.status !== "active" || user.credentialRevision !== token.credentialRevision) tokenPurposeError();
      await applyPasswordChange({
        user,
        tenantId: token.tenantId,
        actorUserId: null,
        passwordHash,
        mustChangePassword: false,
        reason: "recovery",
        transaction,
        audit: this.audit,
      });
      if (!(await consumeRecoveryToken(token.tokenId, transaction, now))) tokenPurposeError();
      await revokeUserRecoveryTokens(user.userId, transaction, now);
      const config = requireMailEnabled();
      const verified = await this.repository.findVerifiedRecoveryEmail(user.userId, transaction);
      if (verified[0]?.email)
        await enqueueAuthMail({
          tenantId: token.tenantId,
          userId: user.userId,
          purpose: "password_changed_notice",
          content: passwordChangedNoticeMail(config, verified[0].email),
          transaction,
          now,
        });
      await this.audit.record(
        {
          tenantId: token.tenantId,
          actorUserId: null,
          action: "auth.recovery.completed",
          resourceType: "user",
          resourceId: user.userId,
          outcome: "succeeded",
          metadata: { flow: "self_service" },
        },
        transaction,
      );
    });
  }

  async getRecoveryEmail(userId: string, tenantId: string) {
    const rows = await this.repository.getRecoveryEmail(userId, tenantId);
    if (!rows[0]) throw new UnauthorizedException();
    return {
      enabled: readAuthMailConfig().enabled,
      recoveryEmail: rows[0].recoveryEmail,
      verifiedAt: rows[0].recoveryEmailVerifiedAt ? new Date(rows[0].recoveryEmailVerifiedAt).toISOString() : null,
      pendingEmail: rows[0].pendingRecoveryEmail,
    };
  }

  async setRecoveryEmail(
    input: Readonly<{ userId: string; tenantId: string; sessionId: string; currentPassword: unknown; email: unknown }>,
    ip: string,
  ): Promise<void> {
    const config = requireMailEnabled();
    const email = normalizeRecoveryEmail(input.email);
    if (!email) throw new BadRequestException("Podaj poprawny adres e-mail");
    if (
      typeof input.currentPassword !== "string" ||
      input.currentPassword.length > 1_024 ||
      Buffer.byteLength(input.currentPassword, "utf8") > 4_096
    )
      throw new BadRequestException("Podaj obecne hasło");
    const reauth = await this.rateLimiter.consumeReauthAttempt(input.userId, input.sessionId, ip);
    if (!reauth.allowed)
      throw new HttpException("Za dużo prób ponownego uwierzytelnienia.", HttpStatus.TOO_MANY_REQUESTS);
    const user = await this.repository.findUser(input.userId);
    const validPassword = await verifyPassword(input.currentPassword, user?.passwordHash ?? "");
    if (user?.status !== "active" || !validPassword) {
      await this.rateLimiter.recordReauthFailure(input.userId, reauth);
      throw new UnauthorizedException("Nieprawidłowe obecne hasło");
    }
    const passwordHashSnapshot = user.passwordHash;
    const credentialRevision = user.credentialRevision;
    const now = new Date();
    try {
      await this.repository.transaction(async (transaction) => {
        await this.repository.lockUsers([input.userId], transaction);
        const currentUser = await this.repository.findUser(input.userId, transaction, true);
        const membership = await this.repository.findActiveMembership(input.tenantId, input.userId, transaction);
        const session = await this.repository.findActiveSession(
          input.sessionId,
          input.tenantId,
          input.userId,
          transaction,
        );
        if (
          currentUser?.status !== "active" ||
          !membership ||
          !session ||
          session.expiresAt.getTime() <= now.getTime() ||
          session.credentialRevision !== currentUser.credentialRevision ||
          currentUser.passwordHash !== passwordHashSnapshot ||
          currentUser.credentialRevision !== credentialRevision
        ) {
          throw new ConflictException("Sesja lub dane konta zmieniły się; zaloguj się ponownie");
        }
        const profile = await this.repository.lockRecoveryEmailProfile(input.userId, transaction);
        const current = profile[0];
        if (!current || current.pendingRevision >= 2_147_483_647)
          throw new ServiceUnavailableException("Nie można zmienić adresu odzyskiwania");
        if (current.normalized === email.normalized) throw new BadRequestException("Ten adres jest już zweryfikowany");
        const pendingRevision = current.pendingRevision + 1;
        await this.repository.updatePendingRecoveryEmail(
          input.userId,
          email.address,
          email.normalized,
          pendingRevision,
          transaction,
        );
        const oldVerificationTokens = await this.repository.findActiveVerificationTokenIds(input.userId, transaction);
        for (const old of oldVerificationTokens)
          await cancelAuthMailForToken(old.tokenId, transaction, "verification_superseded");
        await this.repository.revokeActiveVerificationTokens(input.userId, now, transaction);
        const token = await createRecoveryToken({
          tenantId: input.tenantId,
          userId: input.userId,
          purpose: "email_verify",
          credentialRevision: currentUser.credentialRevision,
          recoveryEmailRevision: current.revision,
          pendingEmailRevision: pendingRevision,
          normalizedEmail: email.normalized,
          expiresAt: new Date(now.getTime() + recoveryEmailVerificationLifetimeMs),
          transaction,
        });
        await enqueueAuthMail({
          tenantId: input.tenantId,
          userId: input.userId,
          tokenId: token.tokenId,
          purpose: "email_verify",
          content: verifyRecoveryEmailMail(config, email.address, token.rawToken),
          expiresAt: token.expiresAt,
          transaction,
          now,
        });
        await this.audit.record(
          {
            tenantId: input.tenantId,
            actorUserId: input.userId,
            action: "auth.recovery.email.requested",
            resourceType: "user",
            resourceId: input.userId,
            outcome: "succeeded",
            metadata: { method: "self_service" },
          },
          transaction,
        );
      });
    } catch (error) {
      await this.rateLimiter.clearReauth(input.userId, input.sessionId, reauth);
      throw error;
    }
    await this.rateLimiter.clearReauth(input.userId, input.sessionId, reauth);
  }

  async enqueuePrivilegedResetLink(
    actor: SessionPrincipal,
    targetUserId: string,
    input: unknown,
    managerFlow: boolean,
  ) {
    if (!uuidPattern.test(targetUserId)) throw new BadRequestException("Nieprawidłowy identyfikator konta");
    const body = strictBody(input, ["confirmationToken", "idempotencyKey"]);
    const action = managerFlow ? "team.user.recovery-link" : "admin.user.recovery-link";
    if (
      (managerFlow && actor.role !== "manager" && actor.role !== "admin") ||
      (!managerFlow && actor.role !== "admin")
    ) {
      throw new ForbiddenException("Brak uprawnień do zlecenia linku odzyskiwania");
    }
    const config = requireMailEnabled();
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor,
          action,
          targetId: targetUserId,
          payload: {},
          token: body.confirmationToken,
          idempotencyKey: body.idempotencyKey,
          transaction,
        },
        async () => {
          await this.lockRecoveryActor(actor, transaction, targetUserId);
          const targetRows = await this.repository.findPrivilegedResetTarget(targetUserId, actor.tenantId, transaction);
          const target = targetRows[0];
          if (!target || (managerFlow && target.role !== "operator"))
            throw new BadRequestException("Nie znaleziono konta z tej organizacji");
          if (target.status !== "active" || !target.verifiedAt || !target.email || !target.normalizedEmail) {
            throw new ConflictException("Konto nie ma aktywnego, zweryfikowanego adresu odzyskiwania");
          }
          const now = new Date();
          const expiresAt = new Date(now.getTime() + passwordResetLifetimeMs);
          const token = await createRecoveryToken({
            tenantId: actor.tenantId,
            userId: targetUserId,
            purpose: "password_reset",
            credentialRevision: target.credentialRevision,
            recoveryEmailRevision: target.recoveryEmailRevision,
            normalizedEmail: target.normalizedEmail,
            expiresAt,
            transaction,
          });
          await enqueueAuthMail({
            tenantId: actor.tenantId,
            userId: targetUserId,
            tokenId: token.tokenId,
            purpose: "password_reset",
            content: passwordResetMail(config, target.email, token.rawToken),
            expiresAt,
            transaction,
            now,
          });
          await this.audit.record(
            {
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              action: "auth.recovery.admin_link.requested",
              resourceType: "user",
              resourceId: targetUserId,
              outcome: "succeeded",
              metadata: { actorRole: actor.role },
            },
            transaction,
          );
          return { userId: targetUserId, status: "queued" };
        },
      ),
    );
  }

  async setTargetRecoveryEmail(actor: SessionPrincipal, targetUserId: string, input: unknown, managerFlow: boolean) {
    if (!uuidPattern.test(targetUserId)) throw new BadRequestException("Nieprawidłowy identyfikator konta");
    const body = strictBody(input, ["email", "confirmationToken", "idempotencyKey"]);
    const email = normalizeRecoveryEmail(body.email);
    if (!email) throw new BadRequestException("Podaj poprawny adres e-mail");
    const action = managerFlow ? "team.user.recovery-email" : "admin.user.recovery-email";
    if (
      (managerFlow && actor.role !== "manager" && actor.role !== "admin") ||
      (!managerFlow && actor.role !== "admin")
    ) {
      throw new ForbiddenException("Brak uprawnień do zmiany adresu odzyskiwania");
    }
    const config = requireMailEnabled();
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor,
          action,
          targetId: targetUserId,
          payload: { email: body.email },
          token: body.confirmationToken,
          idempotencyKey: body.idempotencyKey,
          transaction,
        },
        async () => {
          await this.lockRecoveryActor(actor, transaction, targetUserId);
          const targetRows = await this.repository.findPrivilegedEmailTarget(targetUserId, actor.tenantId, transaction);
          const target = targetRows[0];
          if (!target || (managerFlow && target.role !== "operator"))
            throw new BadRequestException("Nie znaleziono konta z tej organizacji");
          if (target.status !== "active") throw new ConflictException("Konto jest nieaktywne");
          if (target.currentNormalized === email.normalized)
            throw new BadRequestException("Ten adres jest już zweryfikowany");
          if (target.pendingRevision >= 2_147_483_647)
            throw new ServiceUnavailableException("Nie można zmienić adresu odzyskiwania");
          const now = new Date();
          const pendingRevision = target.pendingRevision + 1;
          await this.repository.updatePendingRecoveryEmail(
            targetUserId,
            email.address,
            email.normalized,
            pendingRevision,
            transaction,
          );
          const oldTokens = await this.repository.findActiveVerificationTokenIds(targetUserId, transaction);
          for (const old of oldTokens)
            await cancelAuthMailForToken(old.tokenId, transaction, "verification_superseded");
          await this.repository.revokeActiveVerificationTokens(targetUserId, now, transaction);
          const token = await createRecoveryToken({
            tenantId: actor.tenantId,
            userId: targetUserId,
            purpose: "email_verify",
            credentialRevision: target.credentialRevision,
            recoveryEmailRevision: target.revision,
            pendingEmailRevision: pendingRevision,
            normalizedEmail: email.normalized,
            expiresAt: new Date(now.getTime() + recoveryEmailVerificationLifetimeMs),
            transaction,
          });
          await enqueueAuthMail({
            tenantId: actor.tenantId,
            userId: targetUserId,
            tokenId: token.tokenId,
            purpose: "email_verify",
            content: verifyRecoveryEmailMail(config, email.address, token.rawToken),
            expiresAt: token.expiresAt,
            transaction,
            now,
          });
          await this.audit.record(
            {
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              action: "auth.recovery.email.requested",
              resourceType: "user",
              resourceId: targetUserId,
              outcome: "succeeded",
              metadata: { method: managerFlow ? "manager" : "administrator" },
            },
            transaction,
          );
          return { userId: targetUserId, status: "pending_verification" };
        },
      ),
    );
  }

  async verifyRecoveryEmail(rawToken: unknown, ip: string): Promise<void> {
    requireMailEnabled();
    if (typeof rawToken !== "string" || rawToken.length > 64) tokenPurposeError();
    const attempt = await this.rateLimiter.consumeRecoveryTokenAttempt(ip);
    if (!attempt.allowed)
      throw new HttpException("Za dużo prób. Spróbuj ponownie później.", HttpStatus.TOO_MANY_REQUESTS);
    const initial = await findRecoveryToken(rawToken, "email_verify");
    if (!initial) tokenPurposeError();
    const config = requireMailEnabled();
    const now = new Date();
    try {
      await this.repository.transaction(async (transaction) => {
        await this.repository.lockUsers([initial.userId], transaction);
        const token = await findRecoveryToken(rawToken, "email_verify", transaction, true);
        if (!token || token.tokenId !== initial.tokenId) tokenPurposeError();
        const user = await this.repository.findUser(token.userId, transaction, true);
        if (user?.status !== "active") tokenPurposeError();
        if (!(await consumeRecoveryToken(token.tokenId, transaction, now))) tokenPurposeError();
        const profile = await this.repository.lockPendingRecoveryEmail(user.userId, transaction);
        const current = profile[0];
        if (!current?.newEmail || !current.normalized || current.revision >= 2_147_483_647) tokenPurposeError();
        await this.repository.confirmPendingRecoveryEmail(user.userId, now, transaction);
        await revokeUserRecoveryTokens(user.userId, transaction, now);
        const notificationAddresses = new Set(
          [current.oldEmail, current.newEmail].filter((address): address is string => Boolean(address)),
        );
        for (const address of notificationAddresses) {
          await enqueueAuthMail({
            tenantId: token.tenantId,
            userId: user.userId,
            purpose: "recovery_email_changed_notice",
            content: recoveryEmailChangedNoticeMail(config, address),
            transaction,
            now,
          });
        }
        await this.audit.record(
          {
            tenantId: token.tenantId,
            actorUserId: user.userId,
            action: "auth.recovery.email.verified",
            resourceType: "user",
            resourceId: user.userId,
            outcome: "succeeded",
            metadata: { method: "email_link" },
          },
          transaction,
        );
        await this.audit.record(
          {
            tenantId: token.tenantId,
            actorUserId: user.userId,
            action: "auth.recovery.email.changed",
            resourceType: "user",
            resourceId: user.userId,
            outcome: "succeeded",
            metadata: { previousValuePresent: Boolean(current.oldEmail) },
          },
          transaction,
        );
      });
    } catch (error) {
      const code =
        (error as { original?: { code?: string }; parent?: { code?: string } })?.original?.code ??
        (error as { parent?: { code?: string } })?.parent?.code;
      if (code === "23505") throw new ConflictException("Ten adres jest już przypisany do innego konta");
      throw error;
    }
  }
}
