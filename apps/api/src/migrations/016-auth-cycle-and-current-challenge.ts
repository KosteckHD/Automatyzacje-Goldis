import { DataTypes, type QueryInterface } from "sequelize";

/** Adds a run-owned MFA cycle and makes the current challenge an explicit relationship. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    const [conflicts] = await context.sequelize.query(
      `SELECT run_id, count(*)::int AS active_count
       FROM auth_challenges
       WHERE status IN ('active', 'claimed', 'submitted')
       GROUP BY run_id
       HAVING count(*) > 1`,
      { transaction },
    ) as unknown as [{ run_id: string; active_count: number }[], unknown];
    if (conflicts.length > 0) throw new Error("MIGRATION_016_MULTIPLE_ACTIVE_CHALLENGES_PER_RUN");

    await context.addColumn("automation_runs", "current_auth_challenge_id", {
      type: DataTypes.UUID,
      allowNull: true,
    }, { transaction });
    await context.addColumn("automation_runs", "auth_cycle_id", {
      type: DataTypes.UUID,
      allowNull: true,
    }, { transaction });
    await context.addColumn("automation_runs", "auth_cycle_portal", {
      type: DataTypes.STRING(16),
      allowNull: true,
    }, { transaction });
    await context.addColumn("automation_runs", "auth_cycle_started_at", {
      type: DataTypes.DATE,
      allowNull: true,
    }, { transaction });
    await context.addColumn("automation_runs", "auth_cycle_expires_at", {
      type: DataTypes.DATE,
      allowNull: true,
    }, { transaction });
    await context.addColumn("automation_runs", "pzu_sms_retry_count", {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    }, { transaction });
    await context.addColumn("auth_challenges", "mfa_cycle_id", {
      type: DataTypes.UUID,
      allowNull: true,
    }, { transaction });

    await context.sequelize.query(
      `ALTER TABLE automation_runs
         ADD CONSTRAINT automation_runs_pzu_sms_retry_count_valid
           CHECK (pzu_sms_retry_count BETWEEN 0 AND 1),
         ADD CONSTRAINT automation_runs_auth_cycle_portal_valid
           CHECK (auth_cycle_portal IS NULL OR auth_cycle_portal IN ('pzu', 'compensa')),
         ADD CONSTRAINT automation_runs_auth_cycle_shape_valid
           CHECK ((auth_cycle_id IS NULL AND auth_cycle_portal IS NULL AND auth_cycle_started_at IS NULL AND auth_cycle_expires_at IS NULL)
             OR (auth_cycle_id IS NOT NULL AND auth_cycle_portal IS NOT NULL AND auth_cycle_started_at IS NOT NULL
               AND auth_cycle_expires_at IS NOT NULL AND auth_cycle_expires_at > auth_cycle_started_at))`,
      { transaction },
    );

    await context.sequelize.query(
      `UPDATE auth_challenges
       SET mfa_cycle_id = gen_random_uuid()
       WHERE status IN ('active', 'claimed', 'submitted') AND mfa_cycle_id IS NULL`,
      { transaction },
    );
    await context.sequelize.query(
      `UPDATE automation_runs AS run
       SET current_auth_challenge_id = challenge.challenge_id,
           auth_cycle_id = challenge.mfa_cycle_id,
           auth_cycle_portal = challenge.portal,
           auth_cycle_started_at = challenge.created_at,
           auth_cycle_expires_at = challenge.expires_at
       FROM auth_challenges AS challenge
       WHERE challenge.run_id = run.id
         AND challenge.status IN ('active', 'claimed', 'submitted')`,
      { transaction },
    );

    await context.sequelize.query(
      `ALTER TABLE auth_challenges
         ADD CONSTRAINT auth_challenges_id_run_unique UNIQUE (challenge_id, run_id);
       ALTER TABLE automation_runs
         ADD CONSTRAINT automation_runs_current_auth_challenge_same_run_fk
         FOREIGN KEY (current_auth_challenge_id, id)
         REFERENCES auth_challenges (challenge_id, run_id)
         DEFERRABLE INITIALLY DEFERRED;`,
      { transaction },
    );
    await context.addIndex("auth_challenges", ["run_id"], {
      name: "auth_challenges_one_open_per_run",
      unique: true,
      where: { status: ["active", "claimed", "submitted"] },
      transaction,
    });
    await context.addIndex("auth_challenges", ["mfa_cycle_id"], {
      name: "auth_challenges_mfa_cycle_idx",
      transaction,
    });
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.removeIndex("auth_challenges", "auth_challenges_mfa_cycle_idx", { transaction });
    await context.removeIndex("auth_challenges", "auth_challenges_one_open_per_run", { transaction });
    await context.sequelize.query(
      `ALTER TABLE automation_runs DROP CONSTRAINT automation_runs_current_auth_challenge_same_run_fk;
       ALTER TABLE auth_challenges DROP CONSTRAINT auth_challenges_id_run_unique;
       ALTER TABLE automation_runs
         DROP CONSTRAINT automation_runs_auth_cycle_shape_valid,
         DROP CONSTRAINT automation_runs_auth_cycle_portal_valid,
         DROP CONSTRAINT automation_runs_pzu_sms_retry_count_valid;`,
      { transaction },
    );
    await context.removeColumn("auth_challenges", "mfa_cycle_id", { transaction });
    await context.removeColumn("automation_runs", "pzu_sms_retry_count", { transaction });
    await context.removeColumn("automation_runs", "auth_cycle_expires_at", { transaction });
    await context.removeColumn("automation_runs", "auth_cycle_started_at", { transaction });
    await context.removeColumn("automation_runs", "auth_cycle_portal", { transaction });
    await context.removeColumn("automation_runs", "auth_cycle_id", { transaction });
    await context.removeColumn("automation_runs", "current_auth_challenge_id", { transaction });
  });
}
