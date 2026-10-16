import { DataTypes, Op, type QueryInterface } from "sequelize";

/** Adds optimistic concurrency for assignment release while retaining the lead and allocation history. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("business_leads", "assignment_version", {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 1,
    }, { transaction });
    await context.sequelize.query(
      "ALTER TABLE business_leads ADD CONSTRAINT business_leads_assignment_version_valid CHECK (assignment_version >= 1)",
      { transaction },
    );
    await context.removeConstraint("audit_events", "audit_event_action_valid", { transaction });
    await context.addConstraint("audit_events", {
      fields: ["action"], type: "check", name: "audit_event_action_valid",
      where: { action: { [Op.in]: [
        "login.succeeded", "login.failed", "logout.succeeded", "session.revoked", "password.changed",
        "import.created", "import.preparation.started", "import.preparation.completed", "import.preparation.cancelled",
        "import.preparation.workflow.started", "import.preparation.workflow.completed",
        "import.preparation.workflow.cancelled", "import.preparation.workflow.failed",
        "run.created", "run.cancelled", "run.auth_resumed", "run.review_resumed", "run.manual_data_corrected",
        "run.pause_requested", "run.resumed_from_pause", "run.submission.created", "run.submission.cancelled",
        "run.submission.group_admitted", "run.prepared_set.created", "run.prepared_set.completed",
        "run.prepared_set.cancelled", "run.prepared_set.failed", "run.prepared_set.pause_requested",
        "run.prepared_set.resumed", "lead.allocated", "lead.status.updated", "lead.assignment.released", "sms.submitted",
        "regon.correction.proposed", "regon.correction.reviewed", "entity.conflict.reviewed",
        "enrichment.job.created", "enrichment.job.cancelled", "enrichment.job.completed", "artifact.downloaded",
        "user.created", "user.updated", "user.deletion_grant.updated", "deletion.step_up.granted",
        "deletion.preview.created", "deletion.job.created", "deletion.job.completed", "deletion.job.failed",
        "tool.grant.created", "tool.grant.updated", "tool.grant.revoked", "intervention.assigned",
        "intervention.unassigned", "intervention.priority_changed", "intervention.resolved", "settings.updated",
      ] } }, transaction,
    });
  });
}

export async function down(): Promise<void> {
  throw new Error("LEAD_ASSIGNMENT_RELEASE_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
