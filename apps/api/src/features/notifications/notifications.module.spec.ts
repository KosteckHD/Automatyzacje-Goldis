import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuthModule } from "../auth/public";
import { NotificationController } from "./notifications.controller";
import { NotificationsModule } from "./notifications.module";
import { NotificationsRepository } from "./notifications.repository";
import { NotificationService } from "./notifications.service";

test("NotificationsModule owns the notification route and exports its event service", () => {
  assert.deepEqual(Reflect.getMetadata("imports", NotificationsModule), [DatabaseModule, AuthModule]);
  assert.deepEqual(Reflect.getMetadata("controllers", NotificationsModule), [NotificationController]);
  assert.deepEqual(Reflect.getMetadata("providers", NotificationsModule), [
    NotificationService,
    NotificationsRepository,
  ]);
  assert.deepEqual(Reflect.getMetadata("exports", NotificationsModule), [NotificationService]);
  assert.equal(Reflect.getMetadata("path", NotificationController), "notifications");
});
