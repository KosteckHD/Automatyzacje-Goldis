import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "./audit.module";
import { AuditRepository } from "./audit.repository";
import { AuditService } from "./audit.service";

test("AuditModule owns and exports its persistence-backed service", () => {
  assert.deepEqual(Reflect.getMetadata("imports", AuditModule), [DatabaseModule]);
  assert.deepEqual(Reflect.getMetadata("providers", AuditModule), [AuditRepository, AuditService]);
  assert.deepEqual(Reflect.getMetadata("exports", AuditModule), [AuditService]);
});
