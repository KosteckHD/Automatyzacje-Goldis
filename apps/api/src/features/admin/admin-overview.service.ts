import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { loadApiRuntimeConfig } from "../../infrastructure/config";
import type { SessionPrincipal } from "../auth";
import { AdminOverviewRepository } from "./admin-overview.repository";

@Injectable()
export class AdminOverviewService {
  constructor(@Inject(AdminOverviewRepository) private readonly repository: AdminOverviewRepository) {}

  overview(actor: SessionPrincipal) {
    return this.repository.overviewCounts(actor.tenantId);
  }

  async runtime(actor: SessionPrincipal) {
    let schema: Awaited<ReturnType<AdminOverviewRepository["schemaVersion"]>>;
    try {
      schema = await this.repository.schemaVersion();
    } catch {
      throw new ServiceUnavailableException("Nie można odczytać wersji schematu");
    }
    return {
      build: loadApiRuntimeConfig().build,
      schema,
      enrichment: await this.repository.enrichmentOperationsSnapshot(actor.tenantId),
    };
  }
}
