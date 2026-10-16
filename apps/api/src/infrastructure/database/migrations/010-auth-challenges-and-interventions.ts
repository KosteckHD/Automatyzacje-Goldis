import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("auth_challenges", {
      challenge_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      run_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "automation_runs", key: "id" },
        onDelete: "CASCADE",
      },
      portal: { type: DataTypes.STRING(16), allowNull: false },
      account_key: { type: DataTypes.STRING(64), allowNull: false },
      browser_session_id: { type: DataTypes.STRING(128), allowNull: false },
      return_step: { type: DataTypes.STRING(80), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "active" },
      attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      attempt_limit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      claimed_at: { type: DataTypes.DATE, allowNull: true },
      consumed_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });

    await context.sequelize.query(
      `ALTER TABLE auth_challenges
         ADD CONSTRAINT auth_challenges_portal_valid CHECK (portal IN ('pzu', 'compensa')),
         ADD CONSTRAINT auth_challenges_account_key_valid CHECK (account_key ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT auth_challenges_status_valid CHECK (status IN ('active', 'claimed', 'submitted', 'consumed', 'invalidated', 'expired')),
         ADD CONSTRAINT auth_challenges_attempts_valid CHECK (attempt_limit BETWEEN 1 AND 10 AND attempt_count BETWEEN 0 AND attempt_limit)`,
      { transaction },
    );
    await context.addIndex("auth_challenges", ["account_key", "portal"], {
      name: "auth_challenges_one_active_per_account_portal",
      unique: true,
      where: { status: ["active", "claimed", "submitted"] },
      transaction,
    });
    await context.addIndex("auth_challenges", ["run_id", "created_at"], {
      name: "auth_challenges_run_created_idx",
      transaction,
    });
    await context.addIndex("auth_challenges", ["status", "expires_at"], {
      name: "auth_challenges_status_expiry_idx",
      transaction,
    });

    await context.createTable("manual_interventions", {
      intervention_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      run_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "automation_runs", key: "id" },
        onDelete: "CASCADE",
      },
      challenge_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: "auth_challenges", key: "challenge_id" },
        onDelete: "SET NULL",
      },
      portal: { type: DataTypes.STRING(16), allowNull: true },
      kind: { type: DataTypes.STRING(32), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "open" },
      reason_code: { type: DataTypes.STRING(80), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      resolved_at: { type: DataTypes.DATE, allowNull: true },
      resolved_by: { type: DataTypes.UUID, allowNull: true },
    }, { transaction });

    await context.sequelize.query(
      `ALTER TABLE manual_interventions
         ADD CONSTRAINT manual_interventions_portal_valid CHECK (portal IS NULL OR portal IN ('pzu', 'compensa')),
         ADD CONSTRAINT manual_interventions_kind_valid CHECK (kind IN ('sms', 'identity_review', 'portal_error')),
         ADD CONSTRAINT manual_interventions_status_valid CHECK (status IN ('open', 'resolved', 'cancelled', 'expired'))`,
      { transaction },
    );
    await context.addIndex("manual_interventions", ["run_id", "created_at"], {
      name: "manual_interventions_run_created_idx",
      transaction,
    });
    await context.addIndex("manual_interventions", ["challenge_id"], {
      name: "manual_interventions_challenge_idx",
      transaction,
    });
    await context.addIndex("manual_interventions", ["run_id"], {
      name: "manual_interventions_one_open_per_run",
      unique: true,
      where: { status: "open" },
      transaction,
    });
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.dropTable("manual_interventions", { transaction });
    await context.dropTable("auth_challenges", { transaction });
  });
}
