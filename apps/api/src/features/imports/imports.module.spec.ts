import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { ReportsModule } from "../reports/public";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";
import { ImportsModule } from "./imports.module";
import { ImportsRepository } from "./imports.repository";

test("ImportsModule owns the XLSX routes and exports its import use case", () => {
  assert.deepEqual(Reflect.getMetadata("imports", ImportsModule), [
    DatabaseModule,
    AuditModule,
    AuthModule,
    AuthorizationModule,
    ReportsModule,
  ]);
  assert.deepEqual(Reflect.getMetadata("controllers", ImportsModule), [ImportController]);
  assert.deepEqual(Reflect.getMetadata("providers", ImportsModule), [ImportService, ImportsRepository]);
  assert.deepEqual(Reflect.getMetadata("exports", ImportsModule), [ImportService]);
});
