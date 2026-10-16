import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { NotificationsModule } from "../notifications/public";
import { BusinessLeadController } from "./business-leads.controller";
import { BusinessLeadService } from "./business-leads.service";

@Module({
  imports: [DatabaseModule, NotificationsModule],
  controllers: [BusinessLeadController],
  providers: [BusinessLeadService],
  exports: [BusinessLeadService],
})
export class LeadsModule {}
