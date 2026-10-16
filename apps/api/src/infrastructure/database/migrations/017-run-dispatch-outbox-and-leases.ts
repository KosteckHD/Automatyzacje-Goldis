import { DataTypes, type QueryInterface } from "sequelize";

/** Durable queue intent and fenced execution lease; it stores no portal credentials or run results. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("run_dispatch_outbox", {
      dispatch_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      run_id: {
        type: DataTypes.UUID, allowNull: false,
        references: { model: "automation_runs", key: "id" }, onDelete: "CASCADE",
      },
      intent_type: { type: DataTypes.STRING(32), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },
      attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      next_attempt_at: { type: DataTypes.DATE, allowNull: false },
      claimed_at: { type: DataTypes.DATE, allowNull: true },
      claimed_by: { type: DataTypes.UUID, allowNull: true },
      last_error_code: { type: DataTypes.STRING(80), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });

    await context.sequelize.query(
      `INSERT INTO run_dispatch_outbox
         (dispatch_id, run_id, intent_type, status, attempt_count, next_attempt_at, claimed_at, claimed_by,
          last_error_code, created_at, updated_at)
       SELECT gen_random_uuid(), id, 'create', 'pending', 0, now(), NULL, NULL, NULL, now(), now()
       FROM automation_runs WHERE status = 'queued'`, { transaction },
    );

    await context.addColumn("automation_runs", "execution_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await context.addColumn("automation_runs", "worker_session_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await context.addColumn("automation_runs", "lease_expires_at", { type: DataTypes.DATE, allowNull: true }, { transaction });
    await context.addColumn("automation_runs", "technical_cycle_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await context.addColumn("automation_runs", "technical_attempt_count", {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 0,
    }, { transaction });
    await context.addColumn("automation_runs", "staging_file_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await context.addColumn("automation_runs", "staging_sha256", { type: DataTypes.STRING(64), allowNull: true }, { transaction });
    await context.addColumn("automation_runs", "staging_key_version", { type: DataTypes.INTEGER, allowNull: true }, { transaction });
    await context.addColumn("automation_runs", "staging_format_version", { type: DataTypes.INTEGER, allowNull: true }, { transaction });

    await context.addIndex("run_dispatch_outbox", ["status", "next_attempt_at", "created_at"], {
      name: "run_dispatch_outbox_pending_idx", transaction,
    });
    await context.addIndex("run_dispatch_outbox", ["run_id", "created_at"], {
      name: "run_dispatch_outbox_run_idx", transaction,
    });
    await context.sequelize.query(
      `CREATE UNIQUE INDEX run_dispatch_outbox_one_unresolved_per_run
         ON run_dispatch_outbox (run_id) WHERE status IN ('pending', 'publishing', 'published');
       ALTER TABLE run_dispatch_outbox
         ADD CONSTRAINT run_dispatch_outbox_intent_valid
           CHECK (intent_type IN ('create', 'resume_auth', 'resume_review', 'recovery', 'result_delivery')),
         ADD CONSTRAINT run_dispatch_outbox_status_valid
           CHECK (status IN ('pending', 'publishing', 'published', 'consumed', 'cancelled', 'blocked')),
         ADD CONSTRAINT run_dispatch_outbox_attempts_nonnegative CHECK (attempt_count >= 0);
       ALTER TABLE automation_runs
         ADD CONSTRAINT automation_runs_execution_lease_shape
           CHECK ((execution_id IS NULL AND worker_session_id IS NULL AND lease_expires_at IS NULL)
             OR (execution_id IS NOT NULL AND worker_session_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
         ADD CONSTRAINT automation_runs_technical_attempts_valid
           CHECK (technical_attempt_count BETWEEN 0 AND 3),
         ADD CONSTRAINT automation_runs_staging_metadata_shape
           CHECK ((staging_file_id IS NULL AND staging_sha256 IS NULL AND staging_key_version IS NULL AND staging_format_version IS NULL)
             OR (staging_file_id IS NOT NULL AND staging_sha256 IS NOT NULL AND staging_sha256 ~ '^[0-9a-f]{64}$'
               AND staging_key_version IS NOT NULL AND staging_key_version > 0
               AND staging_format_version IS NOT NULL AND staging_format_version > 0));`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query(
      `ALTER TABLE automation_runs
         DROP CONSTRAINT automation_runs_staging_metadata_shape,
         DROP CONSTRAINT automation_runs_technical_attempts_valid,
         DROP CONSTRAINT automation_runs_execution_lease_shape;`, { transaction },
    );
    for (const column of ["staging_format_version", "staging_key_version", "staging_sha256", "staging_file_id",
      "technical_attempt_count", "technical_cycle_id", "lease_expires_at", "worker_session_id", "execution_id"]) {
      await context.removeColumn("automation_runs", column, { transaction });
    }
    await context.dropTable("run_dispatch_outbox", { transaction });
  });
}
