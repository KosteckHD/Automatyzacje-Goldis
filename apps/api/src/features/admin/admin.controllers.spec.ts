import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { SessionGuard } from "../auth";
import { AdminOnlyGuard } from "./admin.support";
import { AdminOperationsController } from "./admin-operations.controller";
import { AdminOverviewController } from "./admin-overview.controller";
import { AdminToolsController } from "./admin-tools.controller";
import { AdminUsersController } from "./admin-users.controller";

test("admin route groups keep explicit feature ownership and the shared authorization guards", () => {
  const groups = [
    { controller: AdminOverviewController, methods: ["overview", "runtime"] },
    {
      controller: AdminUsersController,
      methods: [
        "users",
        "createUser",
        "grants",
        "setGrant",
        "setDeletionGrant",
        "revokeGrant",
        "userSessions",
        "revokeUserSession",
        "revokeUserSessions",
        "disableUser",
        "enableUser",
        "updateRole",
        "resetPassword",
        "requestPasswordResetLink",
        "requestUserRecoveryEmail",
      ],
    },
    { controller: AdminToolsController, methods: ["adminTools", "getSettings", "updateSettings"] },
    {
      controller: AdminOperationsController,
      methods: [
        "operationsSummary",
        "operationsRuns",
        "adminInterventions",
        "assignIntervention",
        "setInterventionPriority",
        "interventionActivity",
      ],
    },
  ];

  for (const { controller, methods } of groups) {
    assert.equal(Reflect.getMetadata(PATH_METADATA, controller), "admin");
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, controller), [SessionGuard, AdminOnlyGuard]);
    const prototype = controller.prototype as object;
    const routes = Object.getOwnPropertyNames(prototype).filter(
      (name) =>
        name !== "constructor" &&
        Reflect.getMetadata(PATH_METADATA, (prototype as Record<string, object>)[name]) !== undefined,
    );
    assert.deepEqual(routes, methods);
  }
});
