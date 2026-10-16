import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { GoldisRole } from "../../contracts/identity";
import {
  hasRecentUserActivitySignal,
  resolveIdentityActiveSessionRole,
  resolveIdentityCurrentSessionRole,
  resolveIdentityMustChangePassword,
} from "../identity";
import type { SessionPasswordChangeResolver, SessionRoleResolver } from "./session.service";
import { type AuthenticatedRequest, readSessionClaims } from "./session-principal";

export const SESSION_ROLE_RESOLVER = "GOLDIS_SESSION_ROLE_RESOLVER";
export const SESSION_PASSWORD_CHANGE_RESOLVER = "GOLDIS_SESSION_PASSWORD_CHANGE_RESOLVER";

export const resolveActiveSessionRole = resolveIdentityActiveSessionRole;
export const resolveMustChangePassword = resolveIdentityMustChangePassword;
export const resolveCurrentSessionRole = resolveIdentityCurrentSessionRole;

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Optional() @Inject(SESSION_ROLE_RESOLVER) private readonly roleResolver?: SessionRoleResolver,
    @Optional()
    @Inject(SESSION_PASSWORD_CHANGE_RESOLVER)
    private readonly passwordChangeResolver?: SessionPasswordChangeResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const claims = readSessionClaims(request);
    if (!claims) throw new UnauthorizedException();
    let role: GoldisRole | null;
    try {
      role = await (this.roleResolver ?? resolveIdentityCurrentSessionRole)(
        claims.userId,
        claims.tenantId,
        claims.sessionId,
        hasRecentUserActivitySignal(request),
      );
    } catch {
      throw new ServiceUnavailableException();
    }
    if (!role) throw new UnauthorizedException();
    const path = request.path ?? "";
    if (
      !path.endsWith("/auth/me") &&
      !path.endsWith("/auth/change-password") &&
      !path.endsWith("/auth/logout") &&
      !path.endsWith("/auth/sessions") &&
      !path.match(/\/auth\/sessions\/[^/]+$/)
    ) {
      try {
        if (await (this.passwordChangeResolver ?? resolveIdentityMustChangePassword)(claims.userId)) {
          throw new ForbiddenException("PASSWORD_CHANGE_REQUIRED");
        }
      } catch (error) {
        if (error instanceof UnauthorizedException || error instanceof ForbiddenException) throw error;
        throw new ServiceUnavailableException();
      }
    }
    request.goldisPrincipal = { ...claims, role };
    return true;
  }
}
