import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public";
import { IdentityModule } from "../identity";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthenticationRepository } from "./authentication.repository";
import { LoginRateLimiter } from "./login-rate-limiter";
import { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } from "./session.guard";
import { SessionService } from "./session.service";

/** Owns authentication and session providers. */
@Module({
  imports: [IdentityModule, AuditModule],
  controllers: [AuthController],
  providers: [
    SessionGuard,
    SessionService,
    AuthenticationRepository,
    AuthService,
    LoginRateLimiter,
    {
      provide: SESSION_ROLE_RESOLVER,
      useFactory: (sessions: SessionService) => sessions.resolveCurrentSessionRole.bind(sessions),
      inject: [SessionService],
    },
    {
      provide: SESSION_PASSWORD_CHANGE_RESOLVER,
      useFactory: (sessions: SessionService) => sessions.resolveMustChangePassword.bind(sessions),
      inject: [SessionService],
    },
  ],
  exports: [SessionGuard, LoginRateLimiter],
})
export class AuthModule {}
