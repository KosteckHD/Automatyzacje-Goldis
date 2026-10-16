import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("manual_interventions", "revision", {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 1,
    }, { transaction });
    await context.addColumn("manual_interventions", "updated_at", {
      type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW,
    }, { transaction });
    await context.sequelize.query(
      `UPDATE manual_interventions SET updated_at = created_at;
       ALTER TABLE manual_interventions ADD CONSTRAINT manual_interventions_revision_valid CHECK (revision > 0);`,
      { transaction },
    );
    await context.createTable("intervention_user_reads", {
      intervention_id: {
        type: DataTypes.UUID, allowNull: false, primaryKey: true,
        references: { model: "manual_interventions", key: "intervention_id" }, onDelete: "CASCADE",
      },
      user_id: {
        type: DataTypes.UUID, allowNull: false, primaryKey: true,
        references: { model: "users", key: "user_id" }, onDelete: "CASCADE",
      },
      seen_revision: { type: DataTypes.INTEGER, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE intervention_user_reads
         ADD CONSTRAINT intervention_user_reads_revision_valid CHECK (seen_revision > 0);
       CREATE INDEX intervention_user_reads_user_idx ON intervention_user_reads (user_id, updated_at DESC);`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.dropTable("intervention_user_reads", { transaction });
    await context.sequelize.query(
      "ALTER TABLE manual_interventions DROP CONSTRAINT manual_interventions_revision_valid", { transaction },
    );
    await context.removeColumn("manual_interventions", "updated_at", { transaction });
    await context.removeColumn("manual_interventions", "revision", { transaction });
  });
}
