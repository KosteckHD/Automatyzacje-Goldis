import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";

export type PortalId = "pzu" | "compensa";
export type AuthChallengeStatus = "active" | "claimed" | "submitted" | "consumed" | "invalidated" | "expired";
export type ManualInterventionKind = "sms" | "identity_review" | "portal_error";
export type ManualInterventionStatus = "open" | "resolved" | "cancelled" | "expired";

export class AuthChallengeModel extends Model {
  declare challengeId: string;

  declare runId: string;

  declare portal: PortalId;

  /** Opaque SHA-256/HMAC account fingerprint; never a username or credential. */

  declare accountKey: string;

  /** Opaque worker-owned browser session identifier, not a portal cookie. */

  declare browserSessionId: string;

  declare returnStep: string;

  declare status: AuthChallengeStatus;

  declare attemptCount: number;

  declare attemptLimit: number;

  declare expiresAt: Date;

  declare claimedAt: Date | null;

  declare consumedAt: Date | null;

  declare createdAt: Date;

  declare updatedAt: Date;

  declare mfaCycleId: string | null;
}

registerModel(
  AuthChallengeModel,
  {
    challengeId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "challenge_id" },

    runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },

    portal: { type: DataTypes.STRING(16), allowNull: false },

    accountKey: { type: DataTypes.STRING(64), allowNull: false, field: "account_key" },

    browserSessionId: { type: DataTypes.STRING(128), allowNull: false, field: "browser_session_id" },

    returnStep: { type: DataTypes.STRING(80), allowNull: false, field: "return_step" },

    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "active" },

    attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "attempt_count" },

    attemptLimit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5, field: "attempt_limit" },

    expiresAt: { type: DataTypes.DATE, allowNull: false, field: "expires_at" },

    claimedAt: { type: DataTypes.DATE, allowNull: true, field: "claimed_at" },

    consumedAt: { type: DataTypes.DATE, allowNull: true, field: "consumed_at" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },

    mfaCycleId: { type: DataTypes.UUID, allowNull: true, field: "mfa_cycle_id" },
  },
  { tableName: "auth_challenges", timestamps: false, modelName: "AuthChallenge" },
);

export class ManualInterventionModel extends Model {
  declare interventionId: string;

  declare runId: string;

  declare challengeId: string | null;

  declare portal: PortalId | null;

  declare kind: ManualInterventionKind;

  declare status: ManualInterventionStatus;

  /** Safe classification only. User-entered SMS values and portal text are never stored. */

  declare reasonCode: string | null;

  declare createdAt: Date;

  declare updatedAt: Date;

  declare revision: number;

  declare fieldCode: string | null;

  declare resolvedAt: Date | null;

  declare resolvedBy: string | null;

  declare assigneeUserId: string | null;

  declare priority: "normal" | "high";

  declare dueAt: Date | null;

  declare assignedAt: Date | null;

  declare assignedBy: string | null;
}

registerModel(
  ManualInterventionModel,
  {
    interventionId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "intervention_id" },

    runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },

    challengeId: { type: DataTypes.UUID, allowNull: true, field: "challenge_id" },

    portal: { type: DataTypes.STRING(16), allowNull: true },

    kind: { type: DataTypes.STRING(32), allowNull: false },

    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "open" },

    reasonCode: { type: DataTypes.STRING(80), allowNull: true, field: "reason_code" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },

    revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

    fieldCode: { type: DataTypes.STRING(48), allowNull: true, field: "field_code" },

    resolvedAt: { type: DataTypes.DATE, allowNull: true, field: "resolved_at" },

    resolvedBy: { type: DataTypes.UUID, allowNull: true, field: "resolved_by" },

    assigneeUserId: { type: DataTypes.UUID, allowNull: true, field: "assignee_user_id" },

    priority: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "normal" },

    dueAt: { type: DataTypes.DATE, allowNull: true, field: "due_at" },

    assignedAt: { type: DataTypes.DATE, allowNull: true, field: "assigned_at" },

    assignedBy: { type: DataTypes.UUID, allowNull: true, field: "assigned_by" },
  },
  { tableName: "manual_interventions", timestamps: false, modelName: "ManualIntervention" },
);

export class InterventionActivityModel extends Model {
  declare activityId: string;

  declare interventionId: string;

  declare actorUserId: string;

  declare eventType: "assigned" | "unassigned" | "priority_changed" | "resolved";

  declare previousAssigneeUserId: string | null;

  declare nextAssigneeUserId: string | null;

  declare priority: "normal" | "high" | null;

  declare createdAt: Date;
}

registerModel(
  InterventionActivityModel,
  {
    activityId: { type: DataTypes.UUID, primaryKey: true, field: "activity_id" },

    interventionId: { type: DataTypes.UUID, allowNull: false, field: "intervention_id" },

    actorUserId: { type: DataTypes.UUID, allowNull: false, field: "actor_user_id" },

    eventType: { type: DataTypes.STRING(24), allowNull: false, field: "event_type" },

    previousAssigneeUserId: { type: DataTypes.UUID, allowNull: true, field: "previous_assignee_user_id" },

    nextAssigneeUserId: { type: DataTypes.UUID, allowNull: true, field: "next_assignee_user_id" },

    priority: { type: DataTypes.STRING(12), allowNull: true },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "intervention_activity", timestamps: false, modelName: "InterventionActivity" },
);

export class InterventionUserReadModel extends Model {
  declare interventionId: string;

  declare userId: string;

  declare seenRevision: number;

  declare updatedAt: Date;
}

registerModel(
  InterventionUserReadModel,
  {
    interventionId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "intervention_id" },

    userId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "user_id" },

    seenRevision: { type: DataTypes.INTEGER, allowNull: false, field: "seen_revision" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "intervention_user_reads", timestamps: false, modelName: "InterventionUserRead" },
);
