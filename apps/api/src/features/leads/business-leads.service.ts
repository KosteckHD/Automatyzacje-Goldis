import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import ExcelJS from "exceljs";
import { Op, QueryTypes, type Transaction } from "sequelize";
import { isResourceTombstoned } from "../../contracts/deletion-barrier";
import {
  BusinessLead,
  CanonicalEntity,
  LeadAllocation,
  LeadResultSnapshot,
  LeadRunLink,
  ResultSet,
  SourceEntityLink,
  SourceRow,
  sequelize,
  TenantMembership,
  User,
} from "../../infrastructure/database/db";
import { sanitizePublicPhone, sanitizePublicText } from "../../infrastructure/http";
import { recordAuditEvent } from "../audit";
import { canAccessTool } from "../authorization/public";
import { NotificationService } from "../notifications/public";
import { buildLeadSnapshotWorkbook, materializeLeadResultSnapshots } from "../results/public";

const toolId = "oc-policy-verification";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,119}$/;

type Actor = Readonly<{ tenantId: string; userId: string; role: string }>;
type GroupInput = Readonly<{ groupId: string; canonicalEntityId: string; leadIdentityKey: string }>;
type Cursor = Readonly<{ createdAt: string; leadId: string }>;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function parseStatus(value: unknown): BusinessLead["contactStatus"] {
  if (value === "not_contacted" || value === "offer_accepted" || value === "not_interested") return value;
  throw new BadRequestException("Wybierz jeden z dostępnych statusów kontaktu");
}

function parseCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof decoded.createdAt !== "string" ||
      !Number.isFinite(Date.parse(decoded.createdAt)) ||
      typeof decoded.leadId !== "string" ||
      !uuidPattern.test(decoded.leadId)
    )
      throw new Error();
    return { createdAt: new Date(decoded.createdAt).toISOString(), leadId: decoded.leadId };
  } catch {
    throw new BadRequestException("Nieprawidłowy kursor listy wyników");
  }
}

function encodeCursor(createdAt: Date | string, leadId: string): string {
  return Buffer.from(JSON.stringify({ createdAt: new Date(createdAt).toISOString(), leadId }), "utf8").toString(
    "base64url",
  );
}

function roleCanRead(role: string): boolean {
  return ["operator", "manager", "admin", "reviewer", "auditor"].includes(role);
}
function roleCanAssign(role: string): boolean {
  return role === "manager" || role === "admin";
}

function allocationCandidateWhere(): string {
  return `lead.tenant_id = :tenantId AND lead.tool_id = :toolId
    AND lead.result_status = 'ready' AND lead.assigned_to_user_id IS NULL
    AND result_set.batch_id IS NOT NULL
    AND result_set.status = 'completed'
    AND NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
      AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')
    AND (:resultSetId IS NULL OR lead.result_set_id = CAST(:resultSetId AS uuid))`;
}

@Injectable()
export class BusinessLeadService {
  constructor(@Optional() @Inject(NotificationService) private readonly notifications?: NotificationService) {}

  /** Adds one company lead per logical result set, even when its people span chunks. */
  async attachSubmissionGroups(
    resultSetId: string,
    groups: readonly GroupInput[],
    transaction: Transaction,
  ): Promise<void> {
    if (!groups.length) return;
    const resultSet = await ResultSet.findByPk(resultSetId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!resultSet || !["queued", "running", "waiting_attention"].includes(resultSet.status)) {
      throw new ConflictException("Operacja nie przyjmuje już nowych wyników");
    }
    if (resultSet.toolId !== toolId) throw new ConflictException("Nieobsługiwane narzędzie dla listy leadów");

    // Resolve source rows through immutable submission items so each company
    // stays attached to the operation that accepted it, including later chunks.
    const createdAt = new Date();
    const byEntity = new Map<string, GroupInput[]>();
    for (const group of groups) {
      const entries = byEntity.get(group.canonicalEntityId) ?? [];
      entries.push(group);
      byEntity.set(group.canonicalEntityId, entries);
    }
    for (const [canonicalEntityId, companyGroups] of byEntity) {
      const canonical = await CanonicalEntity.findOne({
        where: { canonicalEntityId, tenantId: resultSet.tenantId },
        transaction,
      });
      if (!canonical) throw new ConflictException("Nie znaleziono firmy dla wyniku automatyzacji");
      const groupIds = companyGroups.map((item) => item.groupId);
      const items = await sequelize.query<{ sourceRowId: string }>(
        `SELECT DISTINCT source_row_id AS "sourceRowId"
           FROM run_submission_items
          WHERE group_id IN (:groupIds)
          ORDER BY source_row_id`,
        { replacements: { groupIds }, type: QueryTypes.SELECT, transaction },
      );
      const linkedRows = await SourceEntityLink.findAll({
        where: { tenantId: resultSet.tenantId, canonicalEntityId },
        attributes: ["sourceRowId"],
        transaction,
      });
      const rowIds = [
        ...new Set([...items.map((item) => item.sourceRowId), ...linkedRows.map((item) => item.sourceRowId)]),
      ];
      const rows = rowIds.length
        ? await SourceRow.findAll({
            where: { batchId: resultSet.batchId, id: { [Op.in]: rowIds } },
            order: [["rowNumber", "ASC"]],
            transaction,
          })
        : [];
      if (!rows.length) throw new ConflictException("Nie znaleziono źródłowych wierszy firmy");

      let lead = await BusinessLead.findOne({
        where: { resultSetId, canonicalEntityId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const decisionMakers = [
        ...new Set(rows.map((row) => row.decisionMakerName?.trim()).filter((name): name is string => Boolean(name))),
      ];
      const sourceRowIds = [...new Set(rows.map((row) => row.id))];
      const contactData = rows.flatMap((row) => [
        ...(row.mobile.trim() ? [{ type: "mobile" as const, value: row.mobile.trim(), sourceRowId: row.id }] : []),
        ...(row.phone.trim() ? [{ type: "phone" as const, value: row.phone.trim(), sourceRowId: row.id }] : []),
        ...(row.email.trim() ? [{ type: "email" as const, value: row.email.trim(), sourceRowId: row.id }] : []),
      ]);
      if (!lead) {
        lead = await BusinessLead.create(
          {
            leadId: randomUUID(),
            resultSetId,
            tenantId: resultSet.tenantId,
            toolId: resultSet.toolId,
            canonicalEntityId,
            sourceRowIds,
            companyName: rows[0].companyName,
            nip: canonical.nipNormalized,
            regon: canonical.regon,
            address: rows[0].address,
            postalCode: rows[0].postalCode,
            city: rows[0].city,
            decisionMakerNames: decisionMakers,
            contactData,
            resultStatus: "processing",
            contactStatus: "not_contacted",
            assignedToUserId: null,
            assignedByUserId: null,
            assignedAt: null,
            contactStatusVersion: 1,
            contactStatusUpdatedAt: null,
            createdAt,
            updatedAt: createdAt,
          },
          { transaction },
        );
      } else {
        lead.sourceRowIds = [...new Set([...lead.sourceRowIds, ...sourceRowIds])];
        lead.decisionMakerNames = [...new Set([...lead.decisionMakerNames, ...decisionMakers])];
        const knownContacts = new Set(
          lead.contactData.map((item) => `${item.type}\0${item.value}\0${item.sourceRowId}`),
        );
        lead.contactData = [
          ...lead.contactData,
          ...contactData.filter((item) => !knownContacts.has(`${item.type}\0${item.value}\0${item.sourceRowId}`)),
        ];
        lead.updatedAt = createdAt;
        await lead.save({ transaction });
      }
      for (const group of companyGroups) {
        await LeadRunLink.findOrCreate({
          where: { groupId: group.groupId },
          defaults: {
            linkId: randomUUID(),
            tenantId: resultSet.tenantId,
            leadId: lead.leadId,
            groupId: group.groupId,
            createdAt,
          },
          transaction,
        });
      }
    }
    resultSet.status = "running";
    resultSet.updatedAt = createdAt;
    await resultSet.save({ transaction });
  }

  /** A set becomes assignable only after the user-level operation is durable and terminal. */
  async completeResultSet(
    resultSetId: string,
    terminal: "completed" | "cancelled" | "failed",
    transaction: Transaction,
  ) {
    const resultSet = await ResultSet.findByPk(resultSetId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!resultSet) return;
    const wasTerminal =
      resultSet.finishedAt !== null || ["completed", "cancelled", "failed"].includes(resultSet.status);
    const now = new Date();
    resultSet.status = terminal;
    resultSet.finishedAt = now;
    resultSet.updatedAt = now;
    await resultSet.save({ transaction });
    const leads = await BusinessLead.findAll({ where: { resultSetId }, transaction, lock: transaction.LOCK.UPDATE });
    if (terminal !== "completed") {
      await BusinessLead.update({ resultStatus: "failed", updatedAt: now }, { where: { resultSetId }, transaction });
      return;
    }
    for (const lead of leads) {
      const runStates = await sequelize.query<{ status: string | null }>(
        `SELECT run.status
           FROM lead_run_links link
           JOIN run_submission_groups grp ON grp.group_id = link.group_id AND grp.tenant_id = link.tenant_id
           LEFT JOIN automation_runs run ON run.id = grp.run_id
          WHERE link.lead_id = :leadId AND link.tenant_id = :tenantId`,
        { replacements: { leadId: lead.leadId, tenantId: lead.tenantId }, type: QueryTypes.SELECT, transaction },
      );
      const terminalStatuses = new Set(["completed", "failed", "no_matching_policies", "cancelled"]);
      const complete =
        runStates.length > 0 &&
        runStates.some((item) => item.status === "completed") &&
        runStates.every((item) => item.status !== null && terminalStatuses.has(item.status));
      lead.resultStatus = complete ? "ready" : "failed";
      lead.updatedAt = now;
      await lead.save({ transaction });
      if (lead.resultStatus === "ready") await materializeLeadResultSnapshots(lead, resultSet, transaction);
    }
    if (terminal === "completed" && !wasTerminal) {
      await this.notifications?.recordResultSetEvent(resultSet, "result_ready", transaction);
    }
  }

  private async requireReadAccess(actor: Actor) {
    if (!roleCanRead(actor.role)) throw new ForbiddenException("Ta rola nie ma dostępu do wyników firm");
    if (
      !(await canAccessTool(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          role: actor.role as "operator" | "manager" | "admin" | "reviewer" | "auditor",
        },
        toolId,
        "view_results",
      ))
    ) {
      throw new ForbiddenException("Brak prawa do odczytu wyników automatyzacji OC");
    }
  }

  private mapLead(row: Record<string, unknown>) {
    const status = String(row.contactStatus);
    return {
      id: row.leadId,
      resultSetId: row.resultSetId,
      automationId: row.toolId,
      operationId: row.sourceId,
      sourceImportId: row.sourceImportDeleted ? null : typeof row.batchId === "string" ? row.batchId : null,
      sourceImportDeleted: Boolean(row.sourceImportDeleted),
      sourceRowIds: Array.isArray(row.sourceRowIds)
        ? row.sourceRowIds.filter((item): item is string => typeof item === "string")
        : [],
      createdAt: new Date(String(row.createdAt)).toISOString(),
      referenceDate: String(row.referenceDate),
      company: sanitizePublicText(String(row.companyName)),
      nip: row.nip ? String(row.nip) : null,
      regon: row.regon ? String(row.regon) : null,
      address: sanitizePublicText(String(row.address ?? "")),
      postalCode: sanitizePublicText(String(row.postalCode ?? "")),
      city: sanitizePublicText(String(row.city ?? "")),
      decisionMakers: Array.isArray(row.decisionMakerNames)
        ? row.decisionMakerNames.filter((item): item is string => typeof item === "string").map(sanitizePublicText)
        : [],
      contacts: Array.isArray(row.contactData)
        ? row.contactData.flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const contact = item as Record<string, unknown>;
            if (
              (contact.type !== "mobile" && contact.type !== "phone" && contact.type !== "email") ||
              typeof contact.value !== "string"
            )
              return [];
            return [
              {
                type: contact.type,
                value:
                  contact.type === "phone" ? sanitizePublicPhone(contact.value) : sanitizePublicText(contact.value),
                sourceRowId: typeof contact.sourceRowId === "string" ? contact.sourceRowId : null,
              },
            ];
          })
        : [],
      resultStatus: row.resultStatus,
      contactStatus: status,
      contactStatusVersion: Number(row.contactStatusVersion),
      assignmentVersion: Number(row.assignmentVersion),
      contactStatusUpdatedAt: row.contactStatusUpdatedAt
        ? new Date(String(row.contactStatusUpdatedAt)).toISOString()
        : null,
      assignedToUserId: row.assignedToUserId ?? null,
      assignedTo: row.assignedTo ?? null,
      assignedByUserId: row.assignedByUserId ?? null,
      assignedAt: row.assignedAt ? new Date(String(row.assignedAt)).toISOString() : null,
      runCount: Number(row.runCount ?? 0),
      policyCount: Number(row.policyCount ?? 0),
      runs: Array.isArray(row.runIds) ? row.runIds.filter((item): item is string => typeof item === "string") : [],
      snapshots: Array.isArray(row.savedSnapshots)
        ? row.savedSnapshots.flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const snapshot = item as Record<string, unknown>;
            if (typeof snapshot.runId !== "string" || typeof snapshot.referenceDate !== "string") return [];
            return [
              {
                runId: snapshot.runId,
                referenceDate: snapshot.referenceDate,
                policyCount: Number(snapshot.policyCount ?? 0),
              },
            ];
          })
        : [],
      canEditContactStatus: row.assignedToUserId === row.currentUserId,
      canReleaseAssignment: row.assignedToUserId === row.currentUserId,
    };
  }

  async list(
    actor: Actor,
    input: Readonly<{
      scope?: string;
      contactStatus?: string;
      resultSetId?: string;
      query?: string;
      cursor?: string;
      limit?: string;
    }>,
  ) {
    await this.requireReadAccess(actor);
    const scope = input.scope ?? "pool";
    if (scope !== "pool" && scope !== "mine") throw new BadRequestException("Nieprawidłowy zakres listy leadów");
    if (scope === "mine" && !["operator", "manager", "admin"].includes(actor.role)) throw new ForbiddenException();
    const contactStatus = input.contactStatus ? parseStatus(input.contactStatus) : null;
    const resultSetId = input.resultSetId ? input.resultSetId : null;
    if (resultSetId && !uuidPattern.test(resultSetId))
      throw new BadRequestException("Nieprawidłowy identyfikator wyników");
    const query = typeof input.query === "string" ? input.query.trim().slice(0, 120) : "";
    const limit = input.limit === undefined ? 25 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException("Limit wyników musi wynosić od 1 do 50");
    const cursor = parseCursor(input.cursor);
    const replacements: Record<string, unknown> = {
      tenantId: actor.tenantId,
      toolId,
      userId: actor.userId,
      limit: limit + 1,
      search: query ? `%${query.replace(/[\\%_]/g, "\\$&")}%` : null,
      contactStatus,
      resultSetId,
      cursorCreatedAt: cursor?.createdAt ?? null,
      cursorLeadId: cursor?.leadId ?? null,
    };
    const rows = await sequelize.query<Record<string, unknown>>(
      `SELECT lead.lead_id AS "leadId", lead.result_set_id AS "resultSetId", lead.tenant_id AS "tenantId",
              lead.tool_id AS "toolId", lead.source_row_ids AS "sourceRowIds", lead.company_name AS "companyName",
              lead.nip, lead.regon, lead.address, lead.postal_code AS "postalCode", lead.city,
              lead.decision_maker_names AS "decisionMakerNames", lead.contact_data AS "contactData",
              lead.result_status AS "resultStatus", lead.contact_status AS "contactStatus",
              lead.contact_status_version AS "contactStatusVersion", lead.contact_status_updated_at AS "contactStatusUpdatedAt",
              lead.assignment_version AS "assignmentVersion",
              lead.assigned_to_user_id AS "assignedToUserId", assignee.username AS "assignedTo",
              lead.assigned_by_user_id AS "assignedByUserId", lead.assigned_at AS "assignedAt",
              lead.created_at AS "createdAt", result_set.source_id AS "sourceId", result_set.batch_id AS "batchId",
              result_set.reference_date AS "referenceDate",
              (result_set.batch_id IS NULL OR EXISTS (SELECT 1 FROM resource_tombstones archived
                WHERE archived.tenant_id = result_set.tenant_id AND archived.resource_type = 'import'
                  AND archived.resource_id = result_set.batch_id AND archived.state <> 'completed')) AS "sourceImportDeleted",
              :userId AS "currentUserId", run_stats.run_count AS "runCount", run_stats.policy_count AS "policyCount",
              run_stats.run_ids AS "runIds",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('runId', saved.original_run_id::text,
                  'referenceDate', saved.reference_date::text, 'policyCount', saved.policy_count)
                ORDER BY saved.reference_date, saved.original_run_id)
                FROM lead_result_snapshots saved WHERE saved.lead_id = lead.lead_id AND saved.tenant_id = lead.tenant_id), '[]'::jsonb) AS "savedSnapshots"
         FROM business_leads lead
         JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
         LEFT JOIN tenant_memberships assignee_membership
           ON assignee_membership.tenant_id = lead.tenant_id AND assignee_membership.user_id = lead.assigned_to_user_id
         LEFT JOIN users assignee ON assignee.user_id = assignee_membership.user_id
         LEFT JOIN LATERAL (
           SELECT CASE WHEN result_set.batch_id IS NULL OR EXISTS (SELECT 1 FROM resource_tombstones archived
                    WHERE archived.tenant_id = result_set.tenant_id AND archived.resource_type = 'import'
                      AND archived.resource_id = result_set.batch_id AND archived.state <> 'completed') THEN
                    (SELECT count(*)::int FROM lead_result_snapshots saved WHERE saved.lead_id = lead.lead_id AND saved.tenant_id = lead.tenant_id)
                  ELSE (SELECT count(DISTINCT grp.group_id)::int FROM lead_run_links link
                    JOIN run_submission_groups grp ON grp.group_id = link.group_id AND grp.tenant_id = link.tenant_id
                   WHERE link.lead_id = lead.lead_id AND link.tenant_id = lead.tenant_id) END AS run_count,
                  CASE WHEN result_set.batch_id IS NULL OR EXISTS (SELECT 1 FROM resource_tombstones archived
                    WHERE archived.tenant_id = result_set.tenant_id AND archived.resource_type = 'import'
                      AND archived.resource_id = result_set.batch_id AND archived.state <> 'completed') THEN
                    (SELECT COALESCE(sum(saved.policy_count), 0)::int FROM lead_result_snapshots saved WHERE saved.lead_id = lead.lead_id AND saved.tenant_id = lead.tenant_id)
                  ELSE (SELECT COALESCE(sum(snapshot.total_count), 0)::int FROM lead_run_links link
                    JOIN run_submission_groups grp ON grp.group_id = link.group_id AND grp.tenant_id = link.tenant_id
                    LEFT JOIN oc_snapshots snapshot ON snapshot.run_id = grp.run_id
                   WHERE link.lead_id = lead.lead_id AND link.tenant_id = lead.tenant_id) END AS policy_count,
                  CASE WHEN result_set.batch_id IS NULL OR EXISTS (SELECT 1 FROM resource_tombstones archived
                    WHERE archived.tenant_id = result_set.tenant_id AND archived.resource_type = 'import'
                      AND archived.resource_id = result_set.batch_id AND archived.state <> 'completed') THEN
                    (SELECT array_agg(saved.original_run_id::text ORDER BY saved.reference_date, saved.original_run_id)
                       FROM lead_result_snapshots saved WHERE saved.lead_id = lead.lead_id AND saved.tenant_id = lead.tenant_id)
                  ELSE (SELECT array_agg(DISTINCT grp.run_id::text) FILTER (WHERE grp.run_id IS NOT NULL) FROM lead_run_links link
                    JOIN run_submission_groups grp ON grp.group_id = link.group_id AND grp.tenant_id = link.tenant_id
                   WHERE link.lead_id = lead.lead_id AND link.tenant_id = lead.tenant_id) END AS run_ids
         ) run_stats ON TRUE
        WHERE lead.tenant_id = :tenantId AND lead.tool_id = :toolId
          AND result_set.status = 'completed' AND lead.result_status = 'ready'
          AND (result_set.batch_id IS NULL OR NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
            AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')
            OR (:scopeMine = TRUE AND lead.assigned_to_user_id = :userId AND EXISTS
              (SELECT 1 FROM lead_result_snapshots saved WHERE saved.lead_id = lead.lead_id AND saved.tenant_id = lead.tenant_id
                AND saved.source_owner_user_id <> lead.assigned_to_user_id)))
          AND (:scopeMine = FALSE OR lead.assigned_to_user_id = :userId)
          AND (:scopeMine = TRUE OR result_set.batch_id IS NOT NULL)
          AND (:contactStatus IS NULL OR lead.contact_status = :contactStatus)
          AND (:resultSetId IS NULL OR lead.result_set_id = CAST(:resultSetId AS uuid))
          AND (:search IS NULL OR lead.company_name ILIKE :search ESCAPE '\\'
            OR COALESCE(lead.nip, '') LIKE :search OR COALESCE(lead.regon, '') LIKE :search)
          AND (:cursorCreatedAt IS NULL OR (lead.created_at, lead.lead_id) < (:cursorCreatedAt, CAST(:cursorLeadId AS uuid)))
        ORDER BY lead.created_at DESC, lead.lead_id DESC
        LIMIT :limit`,
      { replacements: { ...replacements, scopeMine: scope === "mine" }, type: QueryTypes.SELECT },
    );
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => this.mapLead(row));
    const last = hasMore ? rows[limit - 1] : null;
    return { items, nextCursor: last ? encodeCursor(last.createdAt as Date | string, String(last.leadId)) : null };
  }

  async get(actor: Actor, leadId: string) {
    await this.requireReadAccess(actor);
    if (!uuidPattern.test(leadId)) throw new NotFoundException("Nie znaleziono wyniku firmy");
    const rows = await sequelize.query<Record<string, unknown>>(
      `SELECT lead.lead_id AS "leadId", lead.result_set_id AS "resultSetId", lead.tenant_id AS "tenantId",
              lead.tool_id AS "toolId", lead.source_row_ids AS "sourceRowIds", lead.company_name AS "companyName",
              lead.nip, lead.regon, lead.address, lead.postal_code AS "postalCode", lead.city,
              lead.decision_maker_names AS "decisionMakerNames", lead.contact_data AS "contactData",
              lead.result_status AS "resultStatus", lead.contact_status AS "contactStatus",
              lead.contact_status_version AS "contactStatusVersion", lead.contact_status_updated_at AS "contactStatusUpdatedAt",
              lead.assignment_version AS "assignmentVersion",
              lead.assigned_to_user_id AS "assignedToUserId", assignee.username AS "assignedTo",
              lead.assigned_by_user_id AS "assignedByUserId", lead.assigned_at AS "assignedAt",
              lead.created_at AS "createdAt", result_set.source_id AS "sourceId", result_set.batch_id AS "batchId",
              result_set.reference_date AS "referenceDate",
              (result_set.batch_id IS NULL OR EXISTS (SELECT 1 FROM resource_tombstones archived
                WHERE archived.tenant_id = result_set.tenant_id AND archived.resource_type = 'import'
                  AND archived.resource_id = result_set.batch_id AND archived.state <> 'completed')) AS "sourceImportDeleted",
              :userId AS "currentUserId", run_stats.run_count AS "runCount", run_stats.policy_count AS "policyCount",
              run_stats.run_ids AS "runIds",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('runId', saved.original_run_id::text,
                  'referenceDate', saved.reference_date::text, 'policyCount', saved.policy_count)
                ORDER BY saved.reference_date, saved.original_run_id)
                FROM lead_result_snapshots saved WHERE saved.lead_id = lead.lead_id AND saved.tenant_id = lead.tenant_id), '[]'::jsonb) AS "savedSnapshots"
         FROM business_leads lead
         JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
         LEFT JOIN tenant_memberships assignee_membership
           ON assignee_membership.tenant_id = lead.tenant_id AND assignee_membership.user_id = lead.assigned_to_user_id
         LEFT JOIN users assignee ON assignee.user_id = assignee_membership.user_id
         LEFT JOIN LATERAL (
           SELECT CASE WHEN result_set.batch_id IS NULL OR EXISTS (SELECT 1 FROM resource_tombstones archived
                    WHERE archived.tenant_id = result_set.tenant_id AND archived.resource_type = 'import'
                      AND archived.resource_id = result_set.batch_id AND archived.state <> 'completed') THEN
                    (SELECT count(*)::int FROM lead_result_snapshots saved WHERE saved.lead_id = lead.lead_id AND saved.tenant_id = lead.tenant_id)
                  ELSE (SELECT count(DISTINCT grp.group_id)::int FROM lead_run_links link
                    JOIN run_submission_groups grp ON grp.group_id = link.group_id AND grp.tenant_id = link.tenant_id
                   WHERE link.lead_id = lead.lead_id AND link.tenant_id = lead.tenant_id) END AS run_count,
                  CASE WHEN result_set.batch_id IS NULL OR EXISTS (SELECT 1 FROM resource_tombstones archived
                    WHERE archived.tenant_id = result_set.tenant_id AND archived.resource_type = 'import'
                      AND archived.resource_id = result_set.batch_id AND archived.state <> 'completed') THEN
                    (SELECT COALESCE(sum(saved.policy_count), 0)::int FROM lead_result_snapshots saved WHERE saved.lead_id = lead.lead_id AND saved.tenant_id = lead.tenant_id)
                  ELSE (SELECT COALESCE(sum(snapshot.total_count), 0)::int FROM lead_run_links link
                    JOIN run_submission_groups grp ON grp.group_id = link.group_id AND grp.tenant_id = link.tenant_id
                    LEFT JOIN oc_snapshots snapshot ON snapshot.run_id = grp.run_id
                   WHERE link.lead_id = lead.lead_id AND link.tenant_id = lead.tenant_id) END AS policy_count,
                  CASE WHEN result_set.batch_id IS NULL OR EXISTS (SELECT 1 FROM resource_tombstones archived
                    WHERE archived.tenant_id = result_set.tenant_id AND archived.resource_type = 'import'
                      AND archived.resource_id = result_set.batch_id AND archived.state <> 'completed') THEN
                    (SELECT array_agg(saved.original_run_id::text ORDER BY saved.reference_date, saved.original_run_id)
                       FROM lead_result_snapshots saved WHERE saved.lead_id = lead.lead_id AND saved.tenant_id = lead.tenant_id)
                  ELSE (SELECT array_agg(DISTINCT grp.run_id::text) FILTER (WHERE grp.run_id IS NOT NULL) FROM lead_run_links link
                    JOIN run_submission_groups grp ON grp.group_id = link.group_id AND grp.tenant_id = link.tenant_id
                   WHERE link.lead_id = lead.lead_id AND link.tenant_id = lead.tenant_id) END AS run_ids
         ) run_stats ON TRUE
        WHERE lead.lead_id = :leadId AND lead.tenant_id = :tenantId AND lead.tool_id = :toolId
          AND result_set.status = 'completed'`,
      { replacements: { leadId, tenantId: actor.tenantId, toolId, userId: actor.userId }, type: QueryTypes.SELECT },
    );
    const row = rows[0];
    if (!row) throw new NotFoundException("Nie znaleziono wyniku firmy");
    const lead = this.mapLead(row);
    if (lead.sourceImportId === null) {
      if (lead.assignedToUserId !== actor.userId) throw new NotFoundException("Nie znaleziono wyniku firmy");
      const saved = await LeadResultSnapshot.findAll({
        where: { tenantId: actor.tenantId, leadId },
        order: [
          ["referenceDate", "ASC"],
          ["originalRunId", "ASC"],
        ],
      });
      if (!saved.length || saved.some((snapshot) => snapshot.sourceOwnerUserId === actor.userId))
        throw new NotFoundException("Nie znaleziono wyniku firmy");
      return {
        ...lead,
        sourceRows: [],
        sourceImportId: null,
        sourceImportDeleted: true,
        snapshots: saved.map((snapshot) => ({
          runId: snapshot.originalRunId,
          referenceDate: snapshot.referenceDate,
          policyCount: snapshot.policyCount,
        })),
      };
    }
    if (await isResourceTombstoned("import", lead.sourceImportId))
      throw new NotFoundException("Nie znaleziono wyniku firmy");
    const sourceRows = await SourceRow.findAll({
      where: { batchId: lead.sourceImportId, id: { [Op.in]: lead.sourceRowIds } },
      order: [["rowNumber", "ASC"]],
      attributes: [
        "id",
        "rowNumber",
        "companyName",
        "decisionMakerName",
        "nipRaw",
        "regonRaw",
        "address",
        "postalCode",
        "city",
        "mobile",
        "phone",
        "email",
      ],
    });
    return {
      ...lead,
      sourceRows: sourceRows.map((source) => ({
        rowNumber: source.rowNumber,
        companyName: sanitizePublicText(source.companyName),
        decisionMakerName: source.decisionMakerName ? sanitizePublicText(source.decisionMakerName) : null,
        nip: sanitizePublicText(source.nipRaw),
        regon: sanitizePublicText(source.regonRaw),
        address: sanitizePublicText(source.address),
        postalCode: sanitizePublicText(source.postalCode),
        city: sanitizePublicText(source.city),
        mobile: sanitizePublicPhone(source.mobile),
        phone: sanitizePublicPhone(source.phone),
        email: sanitizePublicText(source.email),
      })),
    };
  }

  async exportWorkbook(actor: Actor) {
    if (
      !roleCanRead(actor.role) ||
      !(await canAccessTool(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          role: actor.role as "operator" | "manager" | "admin" | "reviewer" | "auditor",
        },
        toolId,
        "download_results",
      ))
    ) {
      throw new ForbiddenException("Brak prawa do pobrania wyników OC");
    }
    const rows = await sequelize.query<Record<string, unknown>>(
      `SELECT lead.company_name AS company, lead.nip, lead.regon, lead.address, lead.postal_code AS "postalCode", lead.city,
              lead.decision_maker_names AS "decisionMakers", lead.contact_data AS contacts,
              lead.contact_status AS "contactStatus", assignee.username AS "assignedTo",
              result_set.result_set_id AS "resultSetId", result_set.source_id AS "operationId",
              result_set.reference_date AS "referenceDate", result_set.batch_id AS "sourceImportId"
         FROM business_leads lead
         JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
         LEFT JOIN tenant_memberships membership ON membership.tenant_id = lead.tenant_id AND membership.user_id = lead.assigned_to_user_id
         LEFT JOIN users assignee ON assignee.user_id = membership.user_id
        WHERE lead.tenant_id = :tenantId AND lead.tool_id = :toolId AND result_set.status = 'completed' AND lead.result_status = 'ready'
          AND (result_set.batch_id IS NOT NULL OR lead.assigned_to_user_id = :userId)
          AND (result_set.batch_id IS NULL OR NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
            AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')
          )
        ORDER BY lead.created_at DESC, lead.lead_id DESC LIMIT 50001`,
      { replacements: { tenantId: actor.tenantId, toolId, userId: actor.userId }, type: QueryTypes.SELECT },
    );
    if (rows.length > 50000)
      throw new BadRequestException("Eksport przekracza limit 50 000 leadów. Zawęź wyniki do jednej automatyzacji.");
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Goldis";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Wyniki OC");
    sheet.columns = [
      { header: "Firma", key: "company", width: 36 },
      { header: "NIP", key: "nip", width: 14 },
      { header: "REGON", key: "regon", width: 16 },
      { header: "Adres", key: "address", width: 30 },
      { header: "Kod pocztowy", key: "postalCode", width: 15 },
      { header: "Miasto", key: "city", width: 22 },
      { header: "Osoby decyzyjne", key: "decisionMakers", width: 28 },
      { header: "Komórka", key: "mobiles", width: 22 },
      { header: "Telefon", key: "phones", width: 22 },
      { header: "E-mail", key: "emails", width: 30 },
      { header: "Status kontaktu", key: "contactStatus", width: 24 },
      { header: "Pracownik", key: "assignedTo", width: 24 },
      { header: "ID wyników", key: "resultSetId", width: 38 },
      { header: "ID operacji", key: "operationId", width: 38 },
      { header: "Data odniesienia", key: "referenceDate", width: 18 },
      { header: "ID importu", key: "sourceImportId", width: 38 },
    ];
    sheet.getRow(1).font = { bold: true, color: { argb: "FFD9B65F" } };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const contactValues = (value: unknown, type: "mobile" | "phone" | "email") =>
      Array.isArray(value)
        ? value.flatMap((item) =>
            item &&
            typeof item === "object" &&
            (item as { type?: unknown }).type === type &&
            typeof (item as { value?: unknown }).value === "string"
              ? [(item as { value: string }).value]
              : [],
          )
        : [];
    for (const row of rows) {
      const names = Array.isArray(row.decisionMakers)
        ? row.decisionMakers.filter((item): item is string => typeof item === "string")
        : [];
      sheet.addRow({
        ...row,
        decisionMakers: names.join(", "),
        mobiles: contactValues(row.contacts, "mobile").join(", "),
        phones: contactValues(row.contacts, "phone").join(", "),
        emails: contactValues(row.contacts, "email").join(", "),
        contactStatus: row.contactStatus,
      });
    }
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(new Date());
    await recordAuditEvent({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "artifact.downloaded",
      resourceType: "artifact",
      resourceId: null,
      outcome: "succeeded",
      metadata: { toolId, rows: rows.length, format: "xlsx" },
    });
    return {
      fileName: `wyniki-oc-${date}.xlsx`,
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      count: rows.length,
    };
  }

  async downloadSnapshot(actor: Actor, leadId: string, runId: string) {
    if (!uuidPattern.test(leadId) || !uuidPattern.test(runId))
      throw new NotFoundException("Nie znaleziono zachowanego wyniku");
    if (
      !roleCanRead(actor.role) ||
      !(await canAccessTool(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          role: actor.role as "operator" | "manager" | "admin" | "reviewer" | "auditor",
        },
        toolId,
        "download_results",
      ))
    ) {
      throw new ForbiddenException("Brak prawa do pobrania wyników OC");
    }
    const lead = await BusinessLead.findOne({ where: { leadId, tenantId: actor.tenantId, toolId } });
    if (!lead || lead.assignedToUserId !== actor.userId)
      throw new NotFoundException("Nie znaleziono zachowanego wyniku");
    const resultSet = await ResultSet.findOne({ where: { resultSetId: lead.resultSetId, tenantId: actor.tenantId } });
    if (!resultSet) {
      throw new NotFoundException("Nie znaleziono zachowanego wyniku");
    }
    const importIsDeleting = resultSet.batchId ? await isResourceTombstoned("import", resultSet.batchId) : false;
    if (!(resultSet.batchId === null && resultSet.sourceImportDeletedAt) && !importIsDeleting) {
      throw new NotFoundException("Nie znaleziono zachowanego wyniku");
    }
    const snapshot = await LeadResultSnapshot.findOne({
      where: { tenantId: actor.tenantId, leadId, originalRunId: runId },
    });
    if (!snapshot || snapshot.sourceOwnerUserId === actor.userId)
      throw new NotFoundException("Nie znaleziono zachowanego wyniku");
    const file = await buildLeadSnapshotWorkbook({ tenantId: actor.tenantId, leadId, runId });
    await recordAuditEvent({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "artifact.downloaded",
      resourceType: "business_lead",
      resourceId: leadId,
      outcome: "succeeded",
      metadata: { toolId, format: "preserved_lead_snapshot_xlsx", runId, policyCount: file.policyCount },
    });
    return { ...file, count: file.policyCount };
  }

  async recipients(actor: Actor) {
    await this.requireReadAccess(actor);
    if (!roleCanAssign(actor.role)) throw new ForbiddenException("Tylko menedżer może przydzielać leady");
    const recipients = await sequelize.query<{ userId: string; username: string; role: string }>(
      `SELECT membership.user_id AS "userId", users.username, membership.role
         FROM tenant_memberships membership JOIN users ON users.user_id = membership.user_id
        WHERE membership.tenant_id = :tenantId AND membership.status = 'active' AND users.status = 'active'
          AND membership.role IN ('operator', 'manager')
        ORDER BY membership.role, users.username, membership.user_id`,
      { replacements: { tenantId: actor.tenantId }, type: QueryTypes.SELECT },
    );
    return {
      items: recipients.map((item) => ({
        userId: item.userId,
        name: sanitizePublicText(item.username),
        role: item.role,
      })),
    };
  }

  async allocate(actor: Actor, input: unknown) {
    if (!roleCanAssign(actor.role)) throw new ForbiddenException("Tylko menedżer może przydzielać leady");
    await this.requireReadAccess(actor);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new BadRequestException("Nieprawidłowe przydzielenie leadów");
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some((key) => !["recipientUserId", "count", "resultSetId", "idempotencyKey"].includes(key))) {
      throw new BadRequestException("Nieprawidłowe przydzielenie leadów");
    }
    const recipientUserId = body.recipientUserId;
    const count = body.count;
    const resultSetId = body.resultSetId ?? null;
    const idempotencyKey = body.idempotencyKey;
    if (
      typeof recipientUserId !== "string" ||
      !uuidPattern.test(recipientUserId) ||
      !Number.isSafeInteger(count) ||
      Number(count) < 1 ||
      Number(count) > 5000 ||
      (resultSetId !== null && (typeof resultSetId !== "string" || !uuidPattern.test(resultSetId))) ||
      typeof idempotencyKey !== "string" ||
      !keyPattern.test(idempotencyKey)
    ) {
      throw new BadRequestException("Wprowadź odbiorcę, liczbę leadów i klucz przydziału");
    }
    const requestHash = hash({ recipientUserId, count, resultSetId, toolId });
    const now = new Date();
    return sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))", {
        replacements: { lockKey: `${actor.tenantId}:${actor.userId}:${idempotencyKey}` },
        type: QueryTypes.SELECT,
        transaction,
      });
      const duplicate = await LeadAllocation.findOne({
        where: { tenantId: actor.tenantId, actorUserId: actor.userId, idempotencyKey },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (duplicate) {
        if (duplicate.requestHash !== requestHash)
          throw new ConflictException("Ten klucz został użyty dla innego przydziału");
        return {
          allocationId: duplicate.allocationId,
          recipientUserId: duplicate.recipientUserId,
          count: duplicate.count,
          leadIds: duplicate.assignedLeadIds,
          replayed: true,
        };
      }
      const recipient = await TenantMembership.findOne({
        where: {
          tenantId: actor.tenantId,
          userId: recipientUserId,
          status: "active",
          role: { [Op.in]: ["operator", "manager"] },
        },
        transaction,
        lock: transaction.LOCK.SHARE,
      });
      const recipientAccount = recipient
        ? await User.findOne({ where: { userId: recipientUserId, status: "active" }, transaction })
        : null;
      if (!recipient || !recipientAccount)
        throw new BadRequestException("Odbiorca nie ma aktywnego konta pracownika lub menedżera");
      const rows = await sequelize.query<{ leadId: string }>(
        `SELECT lead.lead_id AS "leadId"
           FROM business_leads lead
           JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
          WHERE ${allocationCandidateWhere()}
          ORDER BY lead.created_at ASC, lead.lead_id ASC
          LIMIT :count FOR UPDATE OF lead SKIP LOCKED`,
        {
          replacements: { tenantId: actor.tenantId, toolId, resultSetId, count },
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      if (rows.length !== count)
        throw new ConflictException({
          code: "LEAD_POOL_CHANGED",
          availableCount: rows.length,
          message: `Dostępnych jest ${rows.length} z żądanych ${count} leadów. Odśwież pulę i wybierz liczbę ponownie.`,
        });
      const leadIds = rows.map((row) => row.leadId);
      const [updated] = await BusinessLead.update(
        {
          assignedToUserId: recipientUserId,
          assignedByUserId: actor.userId,
          assignedAt: now,
          assignmentVersion: sequelize.literal("assignment_version + 1"),
          updatedAt: now,
        },
        { where: { leadId: { [Op.in]: leadIds }, tenantId: actor.tenantId, assignedToUserId: null }, transaction },
      );
      if (updated !== count)
        throw new ConflictException({
          code: "LEAD_POOL_CHANGED",
          message: "Pula leadów zmieniła się. Odśwież dostępność i przygotuj przydział ponownie.",
        });
      const allocation = await LeadAllocation.create(
        {
          allocationId: randomUUID(),
          tenantId: actor.tenantId,
          toolId,
          actorUserId: actor.userId,
          recipientUserId,
          idempotencyKey,
          requestHash,
          count,
          assignedLeadIds: leadIds,
          createdAt: now,
        },
        { transaction },
      );
      await recordAuditEvent(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "lead.allocated",
          resourceType: "business_lead",
          resourceId: allocation.allocationId,
          outcome: "succeeded",
          metadata: { count, toolId },
        },
        transaction,
      );
      return { allocationId: allocation.allocationId, recipientUserId, count, leadIds, replayed: false };
    });
  }

  async allocationSummary(actor: Actor, resultSetIdInput?: string) {
    if (!roleCanAssign(actor.role))
      throw new ForbiddenException("Tylko menedżer lub administrator może przydzielać leady");
    await this.requireReadAccess(actor);
    const resultSetId = resultSetIdInput || null;
    if (resultSetId !== null && !uuidPattern.test(resultSetId))
      throw new BadRequestException("Nieprawidłowy zestaw wyników");
    const rows = await sequelize.query<{ availableCount: number }>(
      `SELECT count(*)::int AS "availableCount"
         FROM business_leads lead
         JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
        WHERE ${allocationCandidateWhere()}`,
      { replacements: { tenantId: actor.tenantId, toolId, resultSetId }, type: QueryTypes.SELECT },
    );
    return {
      availableCount: Number(rows[0]?.availableCount ?? 0),
      resultSetId,
      checkedAt: new Date().toISOString(),
    };
  }

  async updateContactStatus(actor: Actor, leadId: string, input: unknown) {
    await this.requireReadAccess(actor);
    if (!uuidPattern.test(leadId) || !input || typeof input !== "object" || Array.isArray(input)) {
      throw new BadRequestException("Nieprawidłowa zmiana statusu kontaktu");
    }
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).some((key) => !["status", "expectedVersion"].includes(key)) ||
      !Number.isSafeInteger(body.expectedVersion) ||
      Number(body.expectedVersion) < 1
    ) {
      throw new BadRequestException("Odśwież rekord i wybierz poprawny status");
    }
    const status = parseStatus(body.status);
    const now = new Date();
    return sequelize.transaction(async (transaction) => {
      const lead = await BusinessLead.findOne({
        where: { leadId, tenantId: actor.tenantId, toolId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!lead || lead.assignedToUserId !== actor.userId)
        throw new NotFoundException("Nie znaleziono przydzielonego wyniku");
      const resultSet = await ResultSet.findOne({
        where: { resultSetId: lead.resultSetId, tenantId: actor.tenantId },
        transaction,
      });
      if (!resultSet || (resultSet.batchId && (await isResourceTombstoned("import", resultSet.batchId, transaction))))
        throw new NotFoundException("Nie znaleziono przydzielonego wyniku");
      if (lead.contactStatusVersion !== Number(body.expectedVersion))
        throw new ConflictException("Status kontaktu został zmieniony. Odśwież listę przed kolejną zmianą.");
      lead.contactStatus = status;
      lead.contactStatusVersion += 1;
      lead.contactStatusUpdatedAt = now;
      lead.updatedAt = now;
      await lead.save({ transaction });
      await recordAuditEvent(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "lead.status.updated",
          resourceType: "business_lead",
          resourceId: lead.leadId,
          outcome: "succeeded",
          metadata: { status, version: lead.contactStatusVersion },
        },
        transaction,
      );
      return {
        leadId: lead.leadId,
        contactStatus: lead.contactStatus,
        contactStatusVersion: lead.contactStatusVersion,
        contactStatusUpdatedAt: lead.contactStatusUpdatedAt?.toISOString() ?? null,
      };
    });
  }

  async releaseAssignment(actor: Actor, leadId: string, input: unknown) {
    await this.requireReadAccess(actor);
    if (!uuidPattern.test(leadId) || !input || typeof input !== "object" || Array.isArray(input)) {
      throw new BadRequestException("Nieprawidłowe zwolnienie przydziału");
    }
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).some((key) => key !== "expectedVersion") ||
      !Number.isSafeInteger(body.expectedVersion) ||
      Number(body.expectedVersion) < 1
    ) {
      throw new BadRequestException("Odśwież wynik przed zwolnieniem przydziału");
    }
    return sequelize.transaction(async (transaction) => {
      const lead = await BusinessLead.findOne({
        where: { leadId, tenantId: actor.tenantId, toolId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!lead || lead.assignedToUserId !== actor.userId)
        throw new NotFoundException("Nie znaleziono przydzielonego wyniku");
      if (lead.assignmentVersion !== Number(body.expectedVersion))
        throw new ConflictException("Przydział został już zmieniony. Odśwież wyniki.");
      const resultSet = await ResultSet.findOne({
        where: { resultSetId: lead.resultSetId, tenantId: actor.tenantId },
        transaction,
      });
      if (
        resultSet?.status !== "completed" ||
        lead.resultStatus !== "ready" ||
        (resultSet.batchId && (await isResourceTombstoned("import", resultSet.batchId, transaction)))
      ) {
        throw new NotFoundException("Nie znaleziono przydzielonego wyniku");
      }
      lead.assignedToUserId = null;
      lead.assignedByUserId = null;
      lead.assignedAt = null;
      lead.assignmentVersion += 1;
      lead.updatedAt = new Date();
      await lead.save({ transaction });
      await recordAuditEvent(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "lead.assignment.released",
          resourceType: "business_lead",
          resourceId: lead.leadId,
          outcome: "succeeded",
          metadata: { assignmentVersion: lead.assignmentVersion },
        },
        transaction,
      );
      return { leadId, assignedToUserId: null, assignmentVersion: lead.assignmentVersion };
    });
  }
}
