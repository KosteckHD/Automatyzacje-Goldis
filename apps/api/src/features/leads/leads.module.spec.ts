import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { NotificationsModule } from "../notifications/public";
import { BusinessLeadController } from "./business-leads.controller";
import { BusinessLeadService } from "./business-leads.service";
import { LeadsModule } from "./leads.module";

test("LeadsModule owns lead routes and service", () => {
  assert.deepEqual(Reflect.getMetadata("imports", LeadsModule), [DatabaseModule, NotificationsModule]);
  assert.deepEqual(Reflect.getMetadata("controllers", LeadsModule), [BusinessLeadController]);
  assert.deepEqual(Reflect.getMetadata("providers", LeadsModule), [BusinessLeadService]);
  assert.deepEqual(Reflect.getMetadata("exports", LeadsModule), [BusinessLeadService]);
  assert.equal(Reflect.getMetadata("path", BusinessLeadController), "leads");
});
