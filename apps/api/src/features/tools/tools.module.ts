import { Module } from "@nestjs/common";
import { AuthModule } from "../auth";
import { ToolCatalogController } from "./tool-catalog.controller";
import { ToolCatalogRepository } from "./tool-catalog.repository";
import { ToolsService } from "./tools.service";

@Module({
  imports: [AuthModule],
  controllers: [ToolCatalogController],
  providers: [ToolCatalogRepository, ToolsService],
  exports: [ToolsService],
})
export class ToolsModule {}
