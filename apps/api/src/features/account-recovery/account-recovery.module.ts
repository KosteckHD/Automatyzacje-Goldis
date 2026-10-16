import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth";
import { PasswordRecoveryController } from "./account-recovery.controller";
import { AccountRecoveryRepository } from "./account-recovery.repository";
import { PasswordRecoveryService } from "./account-recovery.service";
import { AuthMailDispatcher } from "./auth-mail-dispatcher";
import { AUTH_MAIL_PROVIDER } from "./auth-mail-provider";
import { ResendMailProvider } from "./resend-mail-provider";

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [PasswordRecoveryController],
  providers: [
    PasswordRecoveryService,
    AccountRecoveryRepository,
    AuthMailDispatcher,
    { provide: AUTH_MAIL_PROVIDER, useClass: ResendMailProvider },
  ],
  exports: [PasswordRecoveryService],
})
export class AccountRecoveryModule {}
