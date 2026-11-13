import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { parseIsoDateTime } from "../../shared/list-query";
import { canAccessTool } from "../authorization/public";
import { ContactReportRepository } from "./contact-report.repository";

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
  constructor(@Inject(ContactReportRepository) private readonly repository: ContactReportRepository) {}

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
    const { totals, employees } = await this.repository.overview({
      tenantId: current.tenantId,
      toolId,
      from: startEnd.start,
      to: startEnd.end,
      resultSetId: resultSetId ?? null,
    });
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
      employees: employees.map((person) => ({
        ...person,
        assigned: Number(person.assigned),
        notContacted: Number(person.notContacted),
        accepted: Number(person.accepted),
        notInterested: Number(person.notInterested),
      })),
    };
  }
}
