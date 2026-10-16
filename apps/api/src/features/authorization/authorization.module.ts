import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuthorizationRepository } from "./authorization.repository";
import { PERMISSION_RESOURCE_RESOLVER, PermissionGuard } from "./authorization-guard";

/** Owns role policies and request-time resource authorization. */
@Module({
  imports: [DatabaseModule],
  providers: [
    PermissionGuard,
    AuthorizationRepository,
    {
      provide: PERMISSION_RESOURCE_RESOLVER,
      useFactory: (repository: AuthorizationRepository) => repository.resolveResource.bind(repository),
      inject: [AuthorizationRepository],
    },
  ],
  exports: [PermissionGuard, PERMISSION_RESOURCE_RESOLVER],
})
export class AuthorizationModule {}
