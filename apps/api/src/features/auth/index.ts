export { AuthController } from "./auth.controller";
export { AuthModule } from "./auth.module";
export { AuthService } from "./auth.service";
export { AuthenticationRepository } from "./authentication.repository";
export { LOGIN_RATE_LIMIT_REDIS, LoginRateLimiter } from "./login-rate-limiter";
export { applyPasswordChange, assertCredentialSnapshot, type PasswordChangeReason } from "./password-change";
export { hashPassword, needsRehash, verifyPassword } from "./password-hash";
export { assertNewPassword, type PasswordPolicyFailure, passwordPolicyFailure } from "./password-policy";
export {
  resolveActiveSessionRole,
  resolveCurrentSessionRole,
  resolveMustChangePassword,
  SESSION_PASSWORD_CHANGE_RESOLVER,
  SESSION_ROLE_RESOLVER,
  SessionGuard,
} from "./session.guard";
export type {
  SessionPasswordChangeResolver,
  SessionRoleResolver,
} from "./session.service";
export { SessionService } from "./session.service";
export type {
  SessionClaims,
  SessionPrincipal,
} from "./session-principal";
export {
  issueSession,
  readSessionClaims,
  readSessionPrincipal,
  verifyCsrfRequest,
} from "./session-principal";
