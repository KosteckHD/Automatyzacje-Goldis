import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("source_rows", "row_version", {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 1,
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE source_rows
         ADD CONSTRAINT source_rows_row_version_positive CHECK (row_version >= 1)`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.removeConstraint("source_rows", "source_rows_row_version_positive", { transaction });
    await context.removeColumn("source_rows", "row_version", { transaction });
  });
}
