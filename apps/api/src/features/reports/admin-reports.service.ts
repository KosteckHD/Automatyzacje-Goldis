import { Inject, Injectable } from "@nestjs/common";
import { AdminReportsRepository } from "./admin-reports.repository";

@Injectable()
export class AdminReportsService {
  constructor(@Inject(AdminReportsRepository) private readonly repository: AdminReportsRepository) {}

  searchAudit(...args: Parameters<AdminReportsRepository["searchAudit"]>) {
    return this.repository.searchAudit(...args);
  }

  overview(...args: Parameters<AdminReportsRepository["overview"]>) {
    return this.repository.overview(...args);
  }

  failures(...args: Parameters<AdminReportsRepository["failures"]>) {
    return this.repository.failures(...args);
  }

  interventions(...args: Parameters<AdminReportsRepository["interventions"]>) {
    return this.repository.interventions(...args);
  }

  throughput(...args: Parameters<AdminReportsRepository["throughput"]>) {
    return this.repository.throughput(...args);
  }
}
