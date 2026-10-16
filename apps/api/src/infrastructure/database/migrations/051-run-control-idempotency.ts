import { DataTypes, type QueryInterface } from "sequelize";

/** Makes per-run pause/resume commands revision-aware and safely replayable. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("run_control_requests", {
      request_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tenants", key: "tenant_id" }, onDelete: "RESTRICT" },
      run_id: { type: DataTypes.UUID, allowNull: false, references: { model: "automation_runs", key: "id" }, onDelete: "CASCADE" },
      actor_user_id: { type: DataTypes.UUID, allowNull: false },
      idempotency_key: { type: DataTypes.STRING(120), allowNull: false },
      action: { type: DataTypes.STRING(12), allowNull: false },
      expected_revision: { type: DataTypes.BIGINT, allowNull: false },
      result_revision: { type: DataTypes.BIGINT, allowNull: false },
      response: { type: DataTypes.JSONB, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE run_control_requests
         ADD CONSTRAINT run_control_requests_actor_fk FOREIGN KEY (tenant_id, actor_user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT run_control_requests_key_valid CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,119}$'),
         ADD CONSTRAINT run_control_requests_action_valid CHECK (action IN ('pause', 'resume')),
         ADD CONSTRAINT run_control_requests_revision_valid CHECK (expected_revision >= 0 AND result_revision >= expected_revision),
         ADD CONSTRAINT run_control_requests_response_object CHECK (jsonb_typeof(response) = 'object'),
         ADD CONSTRAINT run_control_requests_idempotency_unique UNIQUE (tenant_id, run_id, actor_user_id, idempotency_key);
       CREATE INDEX run_control_requests_run_created_idx ON run_control_requests (tenant_id, run_id, created_at DESC);`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("RUN_CONTROL_REQUEST_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
