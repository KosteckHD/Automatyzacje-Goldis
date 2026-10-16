import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountRecoveryModule } from "../account-recovery";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth";
import { AdminModule } from "./admin.module";
import { AdminOnlyGuard } from "./admin.support";
import { AdminMutationsRepository } from "./admin-mutations.repository";
import { AdminMutationsService } from "./admin-mutations.service";
import { AdminOperationsController } from "./admin-operations.controller";
import { AdminOperationsRepository } from "./admin-operations.repository";
import { AdminOperationsService } from "./admin-operations.service";
import { AdminOverviewController } from "./admin-overview.controller";
import { AdminOverviewRepository } from "./admin-overview.repository";
import { AdminOverviewService } from "./admin-overview.service";
import { AdminToolsController } from "./admin-tools.controller";
import { AdminToolsRepository } from "./admin-tools.repository";
import { AdminToolsService } from "./admin-tools.service";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersRepository } from "./admin-users.repository";
import { AdminUsersService } from "./admin-users.service";

test("AdminModule composes admin routes, authentication, account recovery, and audit", () => {
  assert.deepEqual(Reflect.getMetadata("imports", AdminModule), [AuthModule, AccountRecoveryModule, AuditModule]);
  assert.deepEqual(Reflect.getMetadata("controllers", AdminModule), [
    AdminOverviewController,
    AdminUsersController,
    AdminToolsController,
    AdminOperationsController,
  ]);
  assert.deepEqual(Reflect.getMetadata("providers", AdminModule), [
    AdminOnlyGuard,
    AdminMutationsRepository,
    AdminMutationsService,
    AdminOperationsRepository,
    AdminOperationsService,
    AdminOverviewRepository,
    AdminOverviewService,
    AdminToolsRepository,
    AdminToolsService,
    AdminUsersRepository,
    AdminUsersService,
  ]);
});
