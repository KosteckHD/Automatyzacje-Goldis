import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { GroupingModule } from "./grouping.module";
import { EntityGroupingService } from "./grouping.service";

test("GroupingModule owns canonical source row resolution", () => {
  assert.deepEqual(Reflect.getMetadata("imports", GroupingModule), [DatabaseModule]);
  assert.deepEqual(Reflect.getMetadata("providers", GroupingModule), [EntityGroupingService]);
  assert.deepEqual(Reflect.getMetadata("exports", GroupingModule), [EntityGroupingService]);
});
