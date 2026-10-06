import { randomUUID } from "node:crypto";
import type { Transaction } from "sequelize";

export type AuditedAction =
  | "login.succeeded"
  | "login.failed"
  | "logout.succeeded"
  | "session.revoked"
  | "password.changed"
  | "import.created"
  | "run.created"
  | "run.cancelled"
  | "run.auth_resumed"
  | "run.review_resumed"
  | "run.manual_data_corrected"
  | "sms.submitted"
  | "regon.correction.proposed"
  | "artifact.downloaded"
  | "user.created"
  | "user.updated"
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
  resourceType: "import" | "run" | "challenge" | "correction" | "artifact" | "user" | "session" | "tool" | "intervention" | "settings";
  resourceId: string | null;
  outcome: AuditOutcome;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}>;
export type AuditActorContext = Readonly<{ tenantId: string; actorUserId: string }>;

const sensitiveKey = /(pesel|nip|regon|sms|password|cookie|token|secret|credential|firstname|lastname|fullname|address|phone|email|contact)/i;

export function assertAuditMetadataSafe(value: unknown): asserts value is Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AUDIT_METADATA_MUST_BE_AN_OBJECT");
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey.test(key)) throw new Error("AUDIT_METADATA_SENSITIVE_KEY");
    if (child === null || typeof child === "string" || typeof child === "boolean") continue;
    if (typeof child === "number" && Number.isFinite(child)) continue;
    throw new Error("AUDIT_METADATA_VALUE_INVALID");
  }
}

export async function recordAuditEvent(input: AuditEventInput, transaction?: Transaction): Promise<void> {
  assertAuditMetadataSafe(input.metadata ?? {});
  const { AuditEvent } = await import("./db");
  await AuditEvent.create({
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
  }, transaction ? { transaction } : undefined);
}
