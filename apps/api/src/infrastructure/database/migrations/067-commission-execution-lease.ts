import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn(
      "commission_runs",
      "execution_lease_until",
      { type: DataTypes.DATE, allowNull: true },
      { transaction },
    );
    await context.addIndex("commission_runs", ["status", "execution_lease_until"], {
      name: "commission_runs_execution_lease_idx",
      transaction,
    });
  });
}

export async function down(): Promise<void> {
  throw new Error("COMMISSION_EXECUTION_LEASE_MIGRATION_IS_NOT_REVERSED_AUTOMATICALLY");
}
