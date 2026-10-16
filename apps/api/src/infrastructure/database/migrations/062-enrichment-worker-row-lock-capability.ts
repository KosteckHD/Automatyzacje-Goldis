import { type QueryInterface } from "sequelize";

/** Give the enrichment role the narrow UPDATE capability PostgreSQL requires for row locks. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    for (const table of [
      "import_batches", "users", "tenant_memberships", "tools", "tool_grants",
      "automation_runs", "regon_corrections", "entity_grouping_conflicts", "source_entity_links",
    ]) {
      await context.addColumn(table, "enrichment_worker_lock_capability", {
        type: "BOOLEAN",
        allowNull: false,
        defaultValue: false,
      }, { transaction });
      await context.addConstraint(table, {
        fields: ["enrichment_worker_lock_capability"],
        type: "check",
        name: `${table}_enrichment_worker_lock_capability_immutable`,
        where: { enrichment_worker_lock_capability: false },
        transaction,
      });
    }
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    for (const table of [
      "source_entity_links", "entity_grouping_conflicts", "regon_corrections", "automation_runs",
      "tool_grants", "tools", "tenant_memberships", "users", "import_batches",
    ]) {
      await context.removeConstraint(table, `${table}_enrichment_worker_lock_capability_immutable`, { transaction });
      await context.removeColumn(table, "enrichment_worker_lock_capability", { transaction });
    }
  });
}
