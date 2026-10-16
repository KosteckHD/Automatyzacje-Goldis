import { randomUUID } from "node:crypto";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthenticationRepository } from "./authentication.repository";
import { hashPassword, needsRehash, verifyPassword } from "./password-hash";
import { browserLabel, issueSession, sessionLifetimeMs } from "./session-principal";

export type LoginResult = Readonly<{
  userId: string;
  tenantId: string;
  sessionId: string;
  role: string;
  mustChangePassword: boolean;
}>;

export type PasswordChangeActor = Readonly<{ userId: string; tenantId: string; sessionId?: string }>;

/** Login use case: verifies credentials and asks the repository to persist a guarded session. */
@Injectable()
export class AuthService {
  constructor(@Inject(AuthenticationRepository) private readonly authentication: AuthenticationRepository) {}

  async recordSampledLoginFailure(): Promise<void> {
    try {
      await this.authentication.recordSampledLoginFailure();
    } catch {
      // Anonymous telemetry is best-effort and can never turn a denial into a success.
    }
  }

  async login(username: string, password: string, userAgent?: string): Promise<LoginResult> {
    const user = await this.authentication.findLoginUser(username.toLowerCase());
    const validPassword = await verifyPassword(password, user?.passwordHash ?? "");
    if (user?.status !== "active" || !validPassword) {
      throw new UnauthorizedException("Nieprawidłowy login lub hasło");
    }
    const upgradedPasswordHash = needsRehash(user.passwordHash) ? await hashPassword(password) : null;
    const tenant = await this.authentication.findGoldisTenant();
    if (!tenant) throw new UnauthorizedException("Nieprawidłowy login lub hasło");

    const now = new Date();
    const sessionId = randomUUID();
    const session = await this.authentication.persistLoginSession({
      userId: user.userId,
      tenantId: tenant.tenantId,
      expectedPasswordHash: user.passwordHash,
      expectedCredentialRevision: user.credentialRevision,
      upgradedPasswordHash,
      sessionId,
      now,
      expiresAt: new Date(now.getTime() + sessionLifetimeMs),
      browserLabel: browserLabel(userAgent),
    });
    return {
      userId: user.userId,
      tenantId: tenant.tenantId,
      sessionId,
      role: session.role,
      mustChangePassword: session.mustChangePassword,
    };
  }

  async changePassword(
    actor: PasswordChangeActor,
    currentPassword: string,
    newPassword: string,
    userAgent?: string,
  ): Promise<{ sessionToken: string; csrfToken: string }> {
    const currentSessionId = actor.sessionId;
    if (!currentSessionId) throw new UnauthorizedException();
    const user = await this.authentication.findPasswordUser(actor.userId);
    const validPassword = await verifyPassword(currentPassword, user?.passwordHash ?? "");
    if (user?.status !== "active" || !validPassword) {
      throw new UnauthorizedException("Nieprawidłowe obecne hasło");
    }
    const expectedPasswordHash = user.passwordHash;
    const expectedCredentialRevision = user.credentialRevision;
    const passwordHash = await hashPassword(newPassword);
    const now = new Date();
    const sessionId = randomUUID();
    const tokens = issueSession(actor.userId, actor.tenantId, sessionId);
    await this.authentication.persistPasswordChange({
      userId: actor.userId,
      tenantId: actor.tenantId,
      currentSessionId,
      expectedPasswordHash,
      expectedCredentialRevision,
      passwordHash,
      nextSessionId: sessionId,
      now,
      expiresAt: new Date(now.getTime() + sessionLifetimeMs),
      browserLabel: browserLabel(userAgent),
    });
    return tokens;
  }
}
