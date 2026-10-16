import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ToolSettings } from "../../infrastructure/database/db";
import { AuditService } from "../audit/public";
import type { SessionPrincipal } from "../auth";
import { AdminMutationsService } from "./admin-mutations.service";
import type { AdminToolSettingsUpdate } from "./admin-tools.dto";
import { AdminToolsRepository } from "./admin-tools.repository";

@Injectable()
export class AdminToolsService {
  constructor(
    @Inject(AdminToolsRepository) private readonly repository: AdminToolsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AdminMutationsService) private readonly mutations: AdminMutationsService,
  ) {}

  async listTools() {
    const tools = await this.repository.listTools();
    return {
      items: tools.map((tool) => ({
        toolId: tool.toolId,
        displayName: tool.displayName,
        description: tool.description,
        status: tool.status,
      })),
    };
  }

  async getSettings(tenantId: string, toolId: string) {
    const settings = await this.repository.findSettings(tenantId, toolId);
    if (!settings) throw new NotFoundException();
    return this.toSettingsResponse(toolId, settings);
  }

  updateSettings(actor: SessionPrincipal, toolId: string, body: AdminToolSettingsUpdate) {
    return this.repository.transaction(async (transaction) => {
      await this.mutations.lockTenantAdminChanges(actor, transaction);
      const settings = await this.repository.findSettings(actor.tenantId, toolId, transaction, true);
      if (!settings) throw new NotFoundException();
      if (settings.version !== body.expectedVersion)
        throw new ConflictException("Ustawienia zmieniły się w innej sesji");
      const wasEnabled = settings.enabledForNewRuns;
      await this.repository.saveSettings(settings, actor.userId, body, transaction);
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "settings.updated",
          resourceType: "settings",
          resourceId: toolId,
          outcome: "succeeded",
          metadata: {
            version: settings.version,
            enabledForNewRuns: settings.enabledForNewRuns,
            wasEnabled,
          },
        },
        transaction,
      );
      return this.toSettingsResponse(toolId, settings);
    });
  }

  private toSettingsResponse(toolId: string, settings: ToolSettings) {
    return {
      toolId,
      enabledForNewRuns: settings.enabledForNewRuns,
      maxNewRunsPerHour: settings.maxNewRunsPerHour,
      allowedLocalStart: settings.allowedLocalStart,
      allowedLocalEnd: settings.allowedLocalEnd,
      timezone: settings.timezone,
      version: settings.version,
      updatedAt: settings.updatedAt,
    };
  }
}
