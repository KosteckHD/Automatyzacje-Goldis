import { DataTypes, type QueryInterface } from "sequelize";

/** Stores the spreadsheet's mobile field independently from its landline/phone field. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.addColumn("source_rows", "mobile", {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: "",
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.removeColumn("source_rows", "mobile");
}
