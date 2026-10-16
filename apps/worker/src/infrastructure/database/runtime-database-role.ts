import { assertRuntimeDatabaseRole, RUNTIME_DATABASE_ROLE_PROBE_SQL, type RuntimeDatabaseRoleName } from "@goldis/core";
import type { Pool } from "pg";

export async function assertPoolRuntimeDatabaseRole(
  pool: Pick<Pool, "query">,
  expected: RuntimeDatabaseRoleName,
): Promise<void> {
  const result = await pool.query(RUNTIME_DATABASE_ROLE_PROBE_SQL);
  assertRuntimeDatabaseRole(result.rows[0], expected);
}
