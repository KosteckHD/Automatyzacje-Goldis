import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { GroupingModule } from "../grouping/public";
import { ReviewController } from "./review.controller";
import { ReviewModule } from "./review.module";
import { ReviewService } from "./review.service";

test("ReviewModule owns review routes and consumes grouping through its public module", () => {
  assert.deepEqual(Reflect.getMetadata("imports", ReviewModule), [
    DatabaseModule,
    AuditModule,
    AuthModule,
    AuthorizationModule,
    GroupingModule,
  ]);
  assert.deepEqual(Reflect.getMetadata("controllers", ReviewModule), [ReviewController]);
  assert.deepEqual(Reflect.getMetadata("providers", ReviewModule), [ReviewService]);
});
