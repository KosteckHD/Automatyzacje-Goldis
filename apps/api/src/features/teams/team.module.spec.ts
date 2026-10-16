import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountRecoveryModule } from "../account-recovery";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth";
import { TeamController } from "./team.controller";
import { TeamModule } from "./team.module";
import { TeamRepository } from "./team.repository";
import { TeamService } from "./team.service";

test("TeamModule owns team routes and imports account-recovery plus audit contracts", () => {
  assert.deepEqual(Reflect.getMetadata("imports", TeamModule), [AuthModule, AccountRecoveryModule, AuditModule]);
  assert.deepEqual(Reflect.getMetadata("controllers", TeamModule), [TeamController]);
  assert.deepEqual(Reflect.getMetadata("providers", TeamModule), [TeamRepository, TeamService]);
  assert.deepEqual(Reflect.getMetadata("exports", TeamModule), [TeamService]);
});
