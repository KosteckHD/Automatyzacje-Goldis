import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuthModule } from "../auth/public";
import { NotificationController } from "./notifications.controller";
import { NotificationsRepository } from "./notifications.repository";
import { NotificationService } from "./notifications.service";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationsRepository],
  exports: [NotificationService],
})
export class NotificationsModule {}
