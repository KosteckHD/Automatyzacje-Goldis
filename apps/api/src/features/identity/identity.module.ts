import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { IdentityRepository } from "./identity.repository";
import { IDENTITY_SESSION_REPOSITORY } from "./identity.tokens";

@Module({
  imports: [DatabaseModule, AuditModule],
  providers: [IdentityRepository, { provide: IDENTITY_SESSION_REPOSITORY, useExisting: IdentityRepository }],
  exports: [IDENTITY_SESSION_REPOSITORY],
})
export class IdentityModule {}
