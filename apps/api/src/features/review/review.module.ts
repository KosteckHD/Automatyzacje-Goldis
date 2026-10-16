import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { GroupingModule } from "../grouping/public";
import { ReviewController } from "./review.controller";
import { ReviewService } from "./review.service";

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, AuthorizationModule, GroupingModule],
  controllers: [ReviewController],
  providers: [ReviewService],
})
export class ReviewModule {}
