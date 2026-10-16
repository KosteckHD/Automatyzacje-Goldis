import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditModule, AuditService } from "../audit/public";
import { AuthModule, LoginRateLimiter } from "../auth";
import { PasswordRecoveryController } from "./account-recovery.controller";
import { AccountRecoveryModule } from "./account-recovery.module";
import { AccountRecoveryRepository } from "./account-recovery.repository";
import { PasswordRecoveryService } from "./account-recovery.service";
import { AuthMailDispatcher } from "./auth-mail-dispatcher";
import { AUTH_MAIL_PROVIDER } from "./auth-mail-provider";
import { ResendMailProvider } from "./resend-mail-provider";

test("AccountRecoveryModule owns recovery routes and the mail adapter behind its provider token", () => {
  assert.deepEqual(Reflect.getMetadata("imports", AccountRecoveryModule), [AuthModule, AuditModule]);
  assert.deepEqual(Reflect.getMetadata("controllers", AccountRecoveryModule), [PasswordRecoveryController]);
  const providers = Reflect.getMetadata("providers", AccountRecoveryModule) as Array<
    unknown | { provide?: unknown; useClass?: unknown }
  >;
  assert.ok(providers.includes(PasswordRecoveryService));
  assert.deepEqual(Reflect.getMetadata("design:paramtypes", PasswordRecoveryService), [
    LoginRateLimiter,
    AuditService,
    AccountRecoveryRepository,
  ]);
  assert.ok((Reflect.getMetadata("providers", AccountRecoveryModule) as unknown[]).includes(AccountRecoveryRepository));
  assert.ok(providers.includes(AuthMailDispatcher));
  assert.ok(
    providers.some((provider) => {
      if (!provider || typeof provider !== "object") return false;
      const registration = provider as { provide?: unknown; useClass?: unknown };
      return registration.provide === AUTH_MAIL_PROVIDER && registration.useClass === ResendMailProvider;
    }),
  );
  assert.deepEqual(Reflect.getMetadata("exports", AccountRecoveryModule), [PasswordRecoveryService]);
});
