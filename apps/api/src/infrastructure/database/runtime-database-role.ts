import { assertRuntimeDatabaseRole, RUNTIME_DATABASE_ROLE_PROBE_SQL, type RuntimeDatabaseRoleName, type RuntimeDatabaseRoleSnapshot } from "@goldis/core";
import { QueryTypes, type Sequelize } from "sequelize";

export async function assertSequelizeRuntimeDatabaseRole(
  connection: Sequelize,
  expected: RuntimeDatabaseRoleName,
): Promise<void> {
  const rows = await connection.query<RuntimeDatabaseRoleSnapshot>(RUNTIME_DATABASE_ROLE_PROBE_SQL, {
    type: QueryTypes.SELECT,
  });
  assertRuntimeDatabaseRole(rows[0], expected);
}
