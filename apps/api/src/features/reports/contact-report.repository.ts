import { Inject, Injectable } from "@nestjs/common";
import { QueryTypes, type Sequelize } from "sequelize";
import { API_DATABASE } from "../../infrastructure/database";

type ContactReportFilters = Readonly<{
  tenantId: string;
  toolId: string;
  from: Date;
  to: Date;
  resultSetId: string | null;
}>;

export type ContactReportTotals = Readonly<{
  total: number;
  unassigned: number;
  assigned: number;
  notContacted: number;
  accepted: number;
  notInterested: number;
}>;

export type ContactReportEmployee = Readonly<{
  userId: string;
  username: string;
  membershipStatus: string;
  assigned: number;
  notContacted: number;
  accepted: number;
  notInterested: number;
}>;

@Injectable()
export class ContactReportRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  async overview(filters: ContactReportFilters): Promise<{
    totals: ContactReportTotals[];
    employees: ContactReportEmployee[];
  }> {
    const replacements = {
      tenantId: filters.tenantId,
      toolId: filters.toolId,
      from: filters.from,
      to: filters.to,
      resultSetId: filters.resultSetId,
    };
    const [totals, employees] = await Promise.all([
      this.database.query<ContactReportTotals>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE lead.assigned_to_user_id IS NULL)::int AS unassigned,
                count(*) FILTER (WHERE lead.assigned_to_user_id IS NOT NULL)::int AS assigned,
                count(*) FILTER (WHERE lead.contact_status = 'not_contacted')::int AS "notContacted",
                count(*) FILTER (WHERE lead.contact_status = 'offer_accepted')::int AS accepted,
                count(*) FILTER (WHERE lead.contact_status = 'not_interested')::int AS "notInterested"
           FROM business_leads lead
           JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
          WHERE lead.tenant_id = :tenantId AND lead.tool_id = :toolId
            AND lead.result_status = 'ready' AND lead.created_at >= :from AND lead.created_at < :to
            AND NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
              AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')
            AND (:resultSetId IS NULL OR lead.result_set_id = CAST(:resultSetId AS uuid))`,
        { replacements, type: QueryTypes.SELECT },
      ),
      this.database.query<ContactReportEmployee>(
        `SELECT membership.user_id AS "userId", account.username, membership.status AS "membershipStatus",
                count(*)::int AS assigned,
                count(*) FILTER (WHERE lead.contact_status = 'not_contacted')::int AS "notContacted",
                count(*) FILTER (WHERE lead.contact_status = 'offer_accepted')::int AS accepted,
                count(*) FILTER (WHERE lead.contact_status = 'not_interested')::int AS "notInterested"
           FROM business_leads lead
           JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
           JOIN tenant_memberships membership ON membership.tenant_id = lead.tenant_id AND membership.user_id = lead.assigned_to_user_id
           JOIN users account ON account.user_id = membership.user_id
          WHERE lead.tenant_id = :tenantId AND lead.tool_id = :toolId
            AND lead.result_status = 'ready' AND lead.assigned_to_user_id IS NOT NULL
            AND lead.created_at >= :from AND lead.created_at < :to
            AND NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
              AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')
            AND (:resultSetId IS NULL OR lead.result_set_id = CAST(:resultSetId AS uuid))
          GROUP BY membership.user_id, account.username, account.username_normalized, membership.status
          ORDER BY count(*) DESC, account.username_normalized ASC`,
        { replacements, type: QueryTypes.SELECT },
      ),
    ]);
    return { totals, employees };
  }
}
