import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { QueryTypes } from "sequelize";
import { sequelize } from "../../infrastructure/database/db";
import { parseIsoDateTime } from "../../shared/list-query";
import { canAccessTool } from "../authorization/public";

const toolId = "oc-policy-verification";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseRange(from?: string, to?: string) {
  const start = new Date(parseIsoDateTime(from, "from") as string);
  const end = new Date(parseIsoDateTime(to, "to") as string);
  if (start >= end || end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw new BadRequestException("Zakres raportu musi być rosnący i nie może przekraczać 366 dni");
  }
  return { start, end };
}

type Actor = Readonly<{ tenantId: string; userId: string; role: string }>;

@Injectable()
export class ContactReportService {
  async overview(current: Actor, from?: string, to?: string, resultSetId?: string) {
    const startEnd = parseRange(from, to);
    if (resultSetId !== undefined && !uuidPattern.test(resultSetId))
      throw new BadRequestException("Nieprawidłowy identyfikator operacji");
    const allowedRole = current.role === "manager" || current.role === "admin";
    if (
      !allowedRole ||
      !(await canAccessTool(
        { tenantId: current.tenantId, userId: current.userId, role: current.role as "manager" | "admin" },
        toolId,
        "view_results",
      ))
    ) {
      throw new ForbiddenException("Raporty kontaktów są dostępne dla menedżerów i administratorów");
    }
    const replacements = {
      tenantId: current.tenantId,
      toolId,
      from: startEnd.start,
      to: startEnd.end,
      resultSetId: resultSetId ?? null,
    };
    const [totals, people] = await Promise.all([
      sequelize.query<{
        total: number;
        unassigned: number;
        assigned: number;
        notContacted: number;
        accepted: number;
        notInterested: number;
      }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE lead.assigned_to_user_id IS NULL)::int AS unassigned,
                count(*) FILTER (WHERE lead.assigned_to_user_id IS NOT NULL)::int AS assigned,
                count(*) FILTER (WHERE lead.contact_status = 'not_contacted')::int AS "notContacted",
                count(*) FILTER (WHERE lead.contact_status = 'offer_accepted')::int AS accepted,
                count(*) FILTER (WHERE lead.contact_status = 'not_interested')::int AS "notInterested"
           FROM business_leads lead
           JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
          WHERE lead.tenant_id = :tenantId AND lead.tool_id = :toolId AND result_set.status = 'completed'
            AND lead.result_status = 'ready' AND lead.created_at >= :from AND lead.created_at < :to
            AND NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
              AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')
            AND (:resultSetId IS NULL OR lead.result_set_id = CAST(:resultSetId AS uuid))`,
        { replacements, type: QueryTypes.SELECT },
      ),
      sequelize.query<{
        userId: string;
        username: string;
        membershipStatus: string;
        assigned: number;
        notContacted: number;
        accepted: number;
        notInterested: number;
      }>(
        `SELECT membership.user_id AS "userId", account.username, membership.status AS "membershipStatus",
                count(*)::int AS assigned,
                count(*) FILTER (WHERE lead.contact_status = 'not_contacted')::int AS "notContacted",
                count(*) FILTER (WHERE lead.contact_status = 'offer_accepted')::int AS accepted,
                count(*) FILTER (WHERE lead.contact_status = 'not_interested')::int AS "notInterested"
           FROM business_leads lead
           JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
           JOIN tenant_memberships membership ON membership.tenant_id = lead.tenant_id AND membership.user_id = lead.assigned_to_user_id
           JOIN users account ON account.user_id = membership.user_id
          WHERE lead.tenant_id = :tenantId AND lead.tool_id = :toolId AND result_set.status = 'completed'
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
    const summary = totals[0] ?? {
      total: 0,
      unassigned: 0,
      assigned: 0,
      notContacted: 0,
      accepted: 0,
      notInterested: 0,
    };
    return {
      period: {
        from: startEnd.start.toISOString(),
        to: startEnd.end.toISOString(),
        basis: "lead_created_at",
        description:
          "Okres wybiera leady utworzone w tym czasie; statusy pokazują ich bieżący stan, a nie historię połączeń.",
      },
      resultSetId: resultSetId ?? null,
      summary: Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, Number(value)])),
      employees: people.map((person) => ({
        ...person,
        assigned: Number(person.assigned),
        notContacted: Number(person.notContacted),
        accepted: Number(person.accepted),
        notInterested: Number(person.notInterested),
      })),
    };
  }
}
