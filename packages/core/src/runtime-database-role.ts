/** Runtime database identities used by long-lived application processes. */
export type RuntimeDatabaseRoleName =
  | "goldis_api"
  | "goldis_worker"
  | "goldis_enrichment"
  | "goldis_migrator";

/** Read-only role metadata returned by the PostgreSQL startup probe. */
export type RuntimeDatabaseRoleSnapshot = Readonly<{
  role: string;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolinherit: boolean;
  memberships: readonly string[];
  public_usage: boolean;
  public_create: boolean;
}>;

/** The same probe is used by API and worker processes before they accept work. */
export const RUNTIME_DATABASE_ROLE_PROBE_SQL = [
  "SELECT current_user AS role,",
  "  r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolinherit,",
  "  COALESCE((",
  "    SELECT array_agg(parent.rolname::text ORDER BY parent.rolname)",
  "    FROM pg_auth_members membership",
  "    JOIN pg_roles parent ON parent.oid = membership.roleid",
  "    WHERE membership.member = r.oid",
  "  ), ARRAY[]::text[]) AS memberships,",
  "  has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,",
  "  has_schema_privilege(current_user, 'public', 'CREATE') AS public_create",
  "FROM pg_roles r WHERE r.rolname = current_user",
].join("\n");

/** Fails closed if a process connects as the wrong or over-privileged role. */
export function assertRuntimeDatabaseRole(
  value: unknown,
  expected: RuntimeDatabaseRoleName,
): asserts value is RuntimeDatabaseRoleSnapshot {
  if (!value || typeof value !== "object") throw new Error("RUNTIME_DATABASE_ROLE_CHECK_FAILED");
  const row = value as Partial<RuntimeDatabaseRoleSnapshot>;
  if (
    typeof row.role !== "string"
    || typeof row.rolsuper !== "boolean"
    || typeof row.rolcreatedb !== "boolean"
    || typeof row.rolcreaterole !== "boolean"
    || typeof row.rolreplication !== "boolean"
    || typeof row.rolbypassrls !== "boolean"
    || typeof row.rolinherit !== "boolean"
    || !Array.isArray(row.memberships)
    || !row.memberships.every((membership) => typeof membership === "string")
    || typeof row.public_usage !== "boolean"
    || typeof row.public_create !== "boolean"
  ) {
    throw new Error("RUNTIME_DATABASE_ROLE_CHECK_FAILED");
  }
  if (row.role !== expected) throw new Error("RUNTIME_DATABASE_ROLE_MISMATCH");
  if (
    row.rolsuper
    || row.rolcreatedb
    || row.rolcreaterole
    || row.rolreplication
    || row.rolbypassrls
    || row.rolinherit
    || row.memberships.length > 0
    || !row.public_usage
    || (expected === "goldis_migrator" ? !row.public_create : row.public_create)
  ) {
    throw new Error("RUNTIME_DATABASE_ROLE_PRIVILEGED");
  }
}
