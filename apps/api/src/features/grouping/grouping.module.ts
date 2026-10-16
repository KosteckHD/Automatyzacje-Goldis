import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { EntityGroupingService } from "./grouping.service";

@Module({
  imports: [DatabaseModule],
  providers: [EntityGroupingService],
  exports: [EntityGroupingService],
})
export class GroupingModule {}
