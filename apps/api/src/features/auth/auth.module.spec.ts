import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditModule } from "../audit/public";
import { IdentityModule } from "../identity";
import { AuthController } from "./auth.controller";
import { AuthModule } from "./auth.module";
import { AuthService } from "./auth.service";
import { AuthenticationRepository } from "./authentication.repository";
import { LoginRateLimiter } from "./login-rate-limiter";
import { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } from "./session.guard";
import { SessionService } from "./session.service";

test("AuthModule declares its controllers, auth providers and cross-feature exports", () => {
  assert.deepEqual(Reflect.getMetadata("imports", AuthModule), [IdentityModule, AuditModule]);
  const metadata = Reflect.getMetadata("controllers", AuthModule) as unknown[];
  const providers = Reflect.getMetadata("providers", AuthModule) as Array<unknown | { provide?: unknown }>;
  const exports = Reflect.getMetadata("exports", AuthModule) as unknown[];

  assert.deepEqual(metadata, [AuthController]);
  assert.ok(providers.includes(SessionGuard));
  assert.ok(providers.includes(SessionService));
  assert.ok(providers.includes(AuthenticationRepository));
  assert.ok(providers.includes(AuthService));
  assert.ok(providers.includes(LoginRateLimiter));
  const providerTokens = providers.flatMap((provider) =>
    provider && typeof provider === "object" && "provide" in provider ? [provider.provide] : [],
  );
  for (const token of [SESSION_ROLE_RESOLVER, SESSION_PASSWORD_CHANGE_RESOLVER]) {
    assert.ok(providerTokens.includes(token));
  }
  const roleResolver = providers.find(
    (provider) =>
      provider && typeof provider === "object" && "provide" in provider && provider.provide === SESSION_ROLE_RESOLVER,
  ) as { inject?: unknown[] } | undefined;
  assert.deepEqual(roleResolver?.inject, [SessionService]);
  assert.deepEqual(exports, [SessionGuard, LoginRateLimiter]);
});
