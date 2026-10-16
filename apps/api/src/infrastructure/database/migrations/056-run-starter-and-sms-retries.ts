import { DataTypes, type QueryInterface } from "sequelize";

/** Records the run starter and allows the two agreed SMS resend attempts per portal. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("automation_runs", "started_by_user_id", {
      type: DataTypes.UUID, allowNull: true,
    }, { transaction });
    await context.addColumn("automation_runs", "compensa_sms_retry_count", {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 0,
    }, { transaction });
    await context.sequelize.query(
      `UPDATE automation_runs run
          SET started_by_user_id = COALESCE(
            (SELECT audit.actor_user_id FROM audit_events audit
              WHERE audit.action = 'run.created' AND audit.resource_type = 'run' AND audit.resource_id = run.id::text
              ORDER BY audit.created_at, audit.event_id LIMIT 1),
            (SELECT submission.actor_user_id
               FROM run_submission_groups grp
               JOIN run_submissions submission ON submission.submission_id = grp.submission_id
              WHERE grp.run_id = run.id ORDER BY submission.created_at, submission.submission_id LIMIT 1),
            (SELECT event.actor_id FROM run_events event
              WHERE event.run_id = run.id AND event.actor_id IS NOT NULL
              ORDER BY event.created_at, event.id LIMIT 1)
          )
        WHERE run.started_by_user_id IS NULL;
       ALTER TABLE automation_runs DROP CONSTRAINT automation_runs_pzu_sms_retry_count_valid;
       ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_pzu_sms_retry_count_valid
         CHECK (pzu_sms_retry_count BETWEEN 0 AND 2);
       ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_compensa_sms_retry_count_valid
         CHECK (compensa_sms_retry_count BETWEEN 0 AND 2);
       ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_started_by_fk
         FOREIGN KEY (started_by_user_id) REFERENCES users (user_id) ON DELETE SET NULL;
       CREATE INDEX automation_runs_started_by_idx ON automation_runs (started_by_user_id, status, created_at DESC);`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("RUN_STARTER_AND_SMS_RETRY_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
