import { QueryTypes, type QueryInterface } from "sequelize";

/** Adds the tenant-scoped operational manager role without changing existing memberships. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query(
      `ALTER TABLE tenant_memberships DROP CONSTRAINT tenant_memberships_role_valid;
       ALTER TABLE tenant_memberships ADD CONSTRAINT tenant_memberships_role_valid
         CHECK (role IN ('admin', 'manager', 'operator', 'reviewer', 'auditor'));`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    const managers = await context.sequelize.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tenant_memberships WHERE role = 'manager'",
      { transaction, type: QueryTypes.SELECT, plain: true },
    );
    if (Number(managers?.count ?? 0) > 0) throw new Error("Cannot remove manager role while manager memberships exist");
    await context.sequelize.query(
      `ALTER TABLE tenant_memberships DROP CONSTRAINT tenant_memberships_role_valid;
       ALTER TABLE tenant_memberships ADD CONSTRAINT tenant_memberships_role_valid
         CHECK (role IN ('admin', 'operator', 'reviewer', 'auditor'));`,
      { transaction },
    );
  });
}
