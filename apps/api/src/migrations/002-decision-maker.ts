import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.addColumn("source_rows", "decision_maker_name", { type: DataTypes.TEXT, allowNull: true });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.removeColumn("source_rows", "decision_maker_name");
}
