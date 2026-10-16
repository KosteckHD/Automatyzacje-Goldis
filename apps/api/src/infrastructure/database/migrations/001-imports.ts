import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.createTable("import_batches", {
    id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
    file_name: { type: DataTypes.STRING(255), allowNull: false },
    sha256: { type: DataTypes.STRING(64), allowNull: false },
    total_rows: { type: DataTypes.INTEGER, allowNull: false },
    invalid_rows: { type: DataTypes.INTEGER, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  });
  await context.createTable("source_rows", {
    id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
    batch_id: { type: DataTypes.UUID, allowNull: false, references: { model: "import_batches", key: "id" }, onDelete: "CASCADE" },
    row_number: { type: DataTypes.INTEGER, allowNull: false },
    company_name: { type: DataTypes.TEXT, allowNull: false },
    regon_raw: { type: DataTypes.TEXT, allowNull: false },
    regon: { type: DataTypes.STRING(14), allowNull: true },
    issues: { type: DataTypes.JSONB, allowNull: false },
  });
  await context.addIndex("source_rows", ["batch_id", "row_number"], { unique: true, name: "source_rows_batch_row_unique" });
  await context.addIndex("source_rows", ["batch_id", "regon"], { name: "source_rows_batch_regon_idx" });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.dropTable("source_rows");
  await context.dropTable("import_batches");
}
