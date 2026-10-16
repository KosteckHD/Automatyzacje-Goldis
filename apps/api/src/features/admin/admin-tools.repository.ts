import { Inject, Injectable } from "@nestjs/common";
import type { Sequelize, Transaction } from "sequelize";
import { API_DATABASE } from "../../infrastructure/database";
import { Tool, ToolSettings } from "../../infrastructure/database/db";
import type { AdminToolSettingsUpdate } from "./admin-tools.dto";

@Injectable()
export class AdminToolsRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  transaction<T>(work: (transaction: Transaction) => Promise<T>) {
    return this.database.transaction(work);
  }

  listTools() {
    return Tool.findAll({
      order: [
        ["sortOrder", "ASC"],
        ["toolId", "ASC"],
      ],
    });
  }

  async findSettings(tenantId: string, toolId: string, transaction?: Transaction, lock = false) {
    const queryOptions = transaction ? { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) } : {};
    const [tool, settings] = await Promise.all([
      Tool.findByPk(toolId, { attributes: ["toolId"], ...queryOptions }),
      ToolSettings.findOne({ where: { tenantId, toolId }, ...queryOptions }),
    ]);
    return tool && settings ? settings : null;
  }

  saveSettings(
    settings: ToolSettings,
    actorUserId: string,
    input: AdminToolSettingsUpdate,
    transaction: Transaction,
  ): Promise<ToolSettings> {
    Object.assign(settings, {
      enabledForNewRuns: input.enabledForNewRuns,
      maxNewRunsPerHour: input.maxNewRunsPerHour,
      allowedLocalStart: input.allowedLocalStart,
      allowedLocalEnd: input.allowedLocalEnd,
      timezone: input.timezone,
      updatedBy: actorUserId,
      updatedAt: new Date(),
      version: settings.version + 1,
    });
    return settings.save({ transaction }).then(() => settings);
  }
}
