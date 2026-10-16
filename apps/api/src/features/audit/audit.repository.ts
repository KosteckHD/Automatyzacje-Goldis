import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { Transaction } from "sequelize";

export type AuditedAction =
  | "login.succeeded"
  | "login.failed"
  | "logout.succeeded"
  | "session.revoked"
  | "password.changed"
  | "auth.recovery.requested"
  | "auth.recovery.completed"
  | "auth.recovery.email.requested"
  | "auth.recovery.email.verified"
  | "auth.recovery.email.changed"
  | "auth.recovery.admin_link.requested"
  | "import.created"
  | "import.preparation.started"
  | "import.preparation.completed"
  | "import.preparation.cancelled"
  | "import.preparation.workflow.started"
  | "import.preparation.workflow.completed"
  | "import.preparation.workflow.cancelled"
  | "import.preparation.workflow.failed"
  | "run.created"
  | "run.cancelled"
  | "run.auth_resumed"
  | "run.review_resumed"
  | "run.pause_requested"
  | "run.resumed_from_pause"
  | "run.manual_data_corrected"
  | "sms.submitted"
  | "regon.correction.proposed"
  | "regon.correction.reviewed"
  | "entity.conflict.reviewed"
  | "enrichment.job.created"
  | "enrichment.job.cancelled"
  | "enrichment.job.completed"
  | "run.submission.created"
  | "run.submission.cancelled"
  | "run.submission.group_admitted"
  | "run.prepared_set.created"
  | "run.prepared_set.completed"
  | "run.prepared_set.cancelled"
  | "run.prepared_set.failed"
  | "run.prepared_set.pause_requested"
  | "run.prepared_set.resumed"
  | "lead.allocated"
  | "lead.status.updated"
  | "lead.assignment.released"
  | "artifact.downloaded"
  | "user.created"
  | "user.updated"
  | "privileged_action.confirmed"
  | "user.deletion_grant.updated"
  | "deletion.step_up.granted"
  | "deletion.preview.created"
  | "deletion.job.created"
  | "deletion.job.completed"
  | "deletion.job.failed"
  | "tool.grant.created"
  | "tool.grant.updated"
  | "tool.grant.revoked"
  | "intervention.assigned"
  | "intervention.unassigned"
  | "intervention.priority_changed"
  | "intervention.resolved"
  | "settings.updated";

export type AuditOutcome = "succeeded" | "denied" | "failed";
export type AuditEventInput = Readonly<{
  tenantId: string;
  actorUserId: string | null;
  action: AuditedAction;
  resourceType:
    | "import"
    | "preparation_workflow"
    | "prepared_set_execution"
    | "run"
    | "challenge"
    | "correction"
    | "entity_conflict"
    | "enrichment_job"
    | "run_submission"
    | "artifact"
    | "deletion"
    | "user"
    | "session"
    | "tool"
    | "intervention"
    | "settings"
    | "business_lead";
  resourceId: string | null;
  outcome: AuditOutcome;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}>;
export type AuditActorContext = Readonly<{ tenantId: string; actorUserId: string }>;

const sensitiveKey =
  /(pesel|nip|regon|sms|password|cookie|token|secret|credential|firstname|lastname|fullname|address|phone|email|contact)/i;

export function assertAuditMetadataSafe(
  value: unknown,
): asserts value is Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AUDIT_METADATA_MUST_BE_AN_OBJECT");
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey.test(key)) throw new Error("AUDIT_METADATA_SENSITIVE_KEY");
    if (child === null || typeof child === "string" || typeof child === "boolean") continue;
    if (typeof child === "number" && Number.isFinite(child)) continue;
    throw new Error("AUDIT_METADATA_VALUE_INVALID");
  }
}

async function persistAuditEvent(input: AuditEventInput, transaction?: Transaction): Promise<void> {
  assertAuditMetadataSafe(input.metadata ?? {});
  const { AuditEvent } = await import("../../infrastructure/database/db");
  await AuditEvent.create(
    {
      eventId: randomUUID(),
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      outcome: input.outcome,
      requestRef: randomUUID(),
      metadata: input.metadata ?? {},
      createdAt: new Date(),
    },
    { returning: false, ...(transaction ? { transaction } : {}) },
  );
}

@Injectable()
export class AuditRepository {
  record(input: AuditEventInput, transaction?: Transaction): Promise<void> {
    return persistAuditEvent(input, transaction);
  }
}

/** Compatibility entry point for non-Nest workers and services being migrated. */
export function recordAuditEvent(input: AuditEventInput, transaction?: Transaction): Promise<void> {
  return persistAuditEvent(input, transaction);
}
