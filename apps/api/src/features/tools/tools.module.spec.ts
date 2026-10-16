import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthModule } from "../auth";
import { ToolCatalogController } from "./tool-catalog.controller";
import { ToolCatalogRepository } from "./tool-catalog.repository";
import { ToolsModule } from "./tools.module";
import { ToolsService } from "./tools.service";

test("ToolsModule owns the catalog route, data access and use case", () => {
  assert.deepEqual(Reflect.getMetadata("imports", ToolsModule), [AuthModule]);
  assert.deepEqual(Reflect.getMetadata("controllers", ToolsModule), [ToolCatalogController]);
  assert.deepEqual(Reflect.getMetadata("providers", ToolsModule), [ToolCatalogRepository, ToolsService]);
  assert.deepEqual(Reflect.getMetadata("exports", ToolsModule), [ToolsService]);
});
