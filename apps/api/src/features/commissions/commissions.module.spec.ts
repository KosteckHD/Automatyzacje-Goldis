import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { CommissionsController } from "./commissions.controller";
import { CommissionsModule } from "./commissions.module";
import { CommissionsRepository } from "./commissions.repository";
import { CommissionsService } from "./commissions.service";

test("CommissionsModule exposes authenticated endpoints and owns commission persistence", () => {
  assert.deepEqual(Reflect.getMetadata("imports", CommissionsModule), [
    DatabaseModule,
    AuditModule,
    AuthModule,
    AuthorizationModule,
  ]);
  assert.deepEqual(Reflect.getMetadata("controllers", CommissionsModule), [CommissionsController]);
  assert.deepEqual(Reflect.getMetadata("providers", CommissionsModule), [CommissionsRepository, CommissionsService]);
  assert.deepEqual(Reflect.getMetadata("exports", CommissionsModule), [CommissionsService]);
});
