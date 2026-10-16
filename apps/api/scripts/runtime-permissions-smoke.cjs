const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { assertRuntimeDatabaseRole } = require("@goldis/core");

const roleUrls = [
  ["goldis_migrator", process.env.MIGRATOR_DATABASE_URL],
  ["goldis_api", process.env.DATABASE_URL],
  ["goldis_worker", process.env.WORKER_DATABASE_URL],
  ["goldis_enrichment", process.env.ENRICHMENT_DATABASE_URL],
];

async function inspect(name, url) {
  if (!url) throw new Error(`MISSING_${name.toUpperCase()}_URL`);
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3_000 });
  try {
    const result = await pool.query(`SELECT current_user AS role,
      r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolinherit,
      has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
      has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
      EXISTS (SELECT 1 FROM pg_auth_members WHERE member = current_user::regrole) AS inherited_role,
      COALESCE((SELECT array_agg(parent.rolname::text ORDER BY parent.rolname)
        FROM pg_auth_members membership
        JOIN pg_roles parent ON parent.oid = membership.roleid
        WHERE membership.member = r.oid), ARRAY[]::text[]) AS memberships,
      has_table_privilege(current_user, 'public.automation_runs', 'UPDATE') AS can_update_runs,
      has_table_privilege(current_user, 'public.audit_events', 'UPDATE') AS can_update_audit,
      has_table_privilege(current_user, 'public.audit_events', 'SELECT') AS can_read_audit,
      has_table_privilege(current_user, 'public.audit_events', 'INSERT') AS can_append_audit,
      has_table_privilege(current_user, 'public.registry_provider_daily_budgets', 'SELECT') AS can_read_registry_daily_budget,
      has_table_privilege(current_user, 'public.registry_provider_daily_budgets', 'UPDATE') AS can_update_registry_daily_budget,
      has_table_privilege(current_user, 'public.run_events', 'UPDATE') AS can_update_run_events,
      has_table_privilege(current_user, 'public.enrichment_jobs', 'UPDATE') AS can_update_enrichment_jobs,
      has_table_privilege(current_user, 'public.source_rows', 'UPDATE') AS can_update_source_rows,
      has_column_privilege(current_user, 'public.users', 'password_hash', 'SELECT') AS can_read_password_hash,
      has_column_privilege(current_user, 'public.users', 'status', 'SELECT') AS can_read_user_status,
      has_function_privilege(current_user, 'public.audit_metadata_has_sensitive_key(jsonb)', 'EXECUTE') AS can_validate_audit_metadata,
      has_column_privilege(current_user, 'public.import_batches', 'id', 'SELECT') AS can_read_import_key,
      has_column_privilege(current_user, 'public.import_batches', 'file_name', 'SELECT') AS can_read_import_filename,
      has_table_privilege(current_user, 'public.import_batches', 'UPDATE') AS can_update_import_batches,
      has_column_privilege(current_user, 'public.import_batches', 'tenant_id', 'UPDATE') AS can_change_import_tenant,
      has_column_privilege(current_user, 'public.import_batches', 'enrichment_worker_lock_capability', 'UPDATE') AS can_lock_import_batch,
      has_table_privilege(current_user, 'public.users', 'UPDATE') AS can_update_users,
      has_column_privilege(current_user, 'public.users', 'status', 'UPDATE') AS can_change_user_status,
      has_column_privilege(current_user, 'public.users', 'enrichment_worker_lock_capability', 'UPDATE') AS can_lock_user,
      has_table_privilege(current_user, 'public.tenant_memberships', 'UPDATE') AS can_update_memberships,
      has_column_privilege(current_user, 'public.tenant_memberships', 'role', 'UPDATE') AS can_change_membership_role,
      has_column_privilege(current_user, 'public.tenant_memberships', 'enrichment_worker_lock_capability', 'UPDATE') AS can_lock_membership,
      has_table_privilege(current_user, 'public.tools', 'UPDATE') AS can_update_tools,
      has_column_privilege(current_user, 'public.tools', 'status', 'UPDATE') AS can_change_tool_status,
      has_column_privilege(current_user, 'public.tools', 'enrichment_worker_lock_capability', 'UPDATE') AS can_lock_tool,
      has_table_privilege(current_user, 'public.tool_grants', 'UPDATE') AS can_update_tool_grants,
      has_column_privilege(current_user, 'public.tool_grants', 'can_execute', 'UPDATE') AS can_change_tool_grant,
      has_column_privilege(current_user, 'public.tool_grants', 'enrichment_worker_lock_capability', 'UPDATE') AS can_lock_tool_grant,
      has_table_privilege(current_user, 'public.automation_runs', 'UPDATE') AS can_update_automation_runs,
      has_column_privilege(current_user, 'public.automation_runs', 'enrichment_worker_lock_capability', 'UPDATE') AS can_lock_automation_run,
      has_table_privilege(current_user, 'public.regon_corrections', 'UPDATE') AS can_update_corrections,
      has_column_privilege(current_user, 'public.regon_corrections', 'enrichment_worker_lock_capability', 'UPDATE') AS can_lock_correction,
      has_table_privilege(current_user, 'public.entity_grouping_conflicts', 'UPDATE') AS can_update_grouping_conflicts,
      has_column_privilege(current_user, 'public.entity_grouping_conflicts', 'enrichment_worker_lock_capability', 'UPDATE') AS can_lock_grouping_conflict,
      has_table_privilege(current_user, 'public.source_entity_links', 'UPDATE') AS can_update_entity_links,
      has_column_privilege(current_user, 'public.source_entity_links', 'enrichment_worker_lock_capability', 'UPDATE') AS can_lock_entity_link,
      has_table_privilege(current_user, 'public.canonical_entities', 'UPDATE') AS can_update_canonical_entities,
      has_column_privilege(current_user, 'public.resource_tombstones', 'state', 'SELECT') AS can_check_deletion_barrier
      FROM pg_roles r WHERE r.rolname = current_user`);
    assert.equal(result.rows[0].role, name, `${name}: wrong current role`);
    assertRuntimeDatabaseRole(result.rows[0], name);
    if (name === "goldis_api") {
      const validation = await pool.query(`SELECT audit_metadata_has_sensitive_key('{"nested":{"pesel":"synthetic"}}'::jsonb) AS rejected,
        audit_metadata_has_sensitive_key('{"stage":"login"}'::jsonb) AS safe`);
      assert.equal(validation.rows[0].rejected, true);
      assert.equal(validation.rows[0].safe, false);
    }
    return result.rows[0];
  } finally { await pool.end(); }
}

async function inspectOwnershipAndPublicPrivileges(url) {
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3_000 });
  try {
    const result = await pool.query(`SELECT
      (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS database_owner,
      (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS schema_owner,
      EXISTS (
        SELECT 1 FROM pg_database d
        CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d'::"char", d.datdba))) acl
        WHERE d.datname = current_database() AND acl.grantee = 0
      ) AS public_database_privileges,
      EXISTS (
        SELECT 1 FROM pg_namespace n
        CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n'::"char", n.nspowner))) acl
        WHERE n.nspname = 'public' AND acl.grantee = 0
      ) AS public_schema_privileges,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND pg_get_userbyid(c.relowner) <> 'goldis_migrator') AS relations_with_wrong_owner,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND EXISTS (
            SELECT 1 FROM aclexplode(COALESCE(c.relacl,
              acldefault(CASE WHEN c.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner))) acl
            WHERE acl.grantee = 0
          )) AS relations_with_public_privileges,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'goldis_migrator') AS functions_with_wrong_owner,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND EXISTS (
          SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f'::"char", p.proowner))) acl
          WHERE acl.grantee = 0
        )) AS functions_with_public_privileges`);
    const security = result.rows[0];
    assert.equal(security.database_owner, "goldis_migrator", "database owner");
    assert.equal(security.schema_owner, "goldis_migrator", "public schema owner");
    assert.equal(security.public_database_privileges, false, "PUBLIC has database privileges");
    assert.equal(security.public_schema_privileges, false, "PUBLIC has schema privileges");
    assert.equal(security.relations_with_wrong_owner, 0, "public relation has an unexpected owner");
    assert.equal(security.relations_with_public_privileges, 0, "PUBLIC has table or sequence privileges");
    assert.equal(security.functions_with_wrong_owner, 0, "public function has an unexpected owner");
    assert.equal(security.functions_with_public_privileges, 0, "PUBLIC can execute a public function");
    console.log("RUNTIME_DB_OWNERSHIP_PUBLIC_ACL_PASS database=schema=relations=functions:goldis_migrator publicGrants=0");
  } finally { await pool.end(); }
}

async function main() {
  const roles = Object.fromEntries(await Promise.all(roleUrls.map(async ([name, url]) => [name, await inspect(name, url)])));
  await inspectOwnershipAndPublicPrivileges(process.env.MIGRATOR_DATABASE_URL);
  for (const [name, role] of Object.entries(roles)) {
    assert.equal(role.rolsuper, false, `${name}: superuser`);
    assert.equal(role.rolcreatedb, false, `${name}: createdb`);
    assert.equal(role.rolcreaterole, false, `${name}: createrole`);
    assert.equal(role.rolreplication, false, `${name}: replication`);
    assert.equal(role.rolbypassrls, false, `${name}: bypassrls`);
    assert.equal(role.rolinherit, false, `${name}: inherit`);
    assert.equal(role.inherited_role, false, `${name}: inherited membership`);
    assert.equal(role.public_usage, true, `${name}: public schema usage`);
  }
  assert.equal(roles.goldis_migrator.public_create, true);
  for (const name of ["goldis_api", "goldis_worker", "goldis_enrichment"]) {
    assert.equal(roles[name].public_create, false, `${name}: DDL access`);
  }
  assert.equal(roles.goldis_api.can_update_audit, false, "API can mutate audit history");
  assert.equal(roles.goldis_api.can_append_audit, true, "API cannot append audit history");
  assert.equal(roles.goldis_api.can_read_registry_daily_budget, true, "API cannot read the admin registry budget summary");
  assert.equal(roles.goldis_api.can_update_registry_daily_budget, false, "API can mutate registry worker budgets");
  assert.equal(roles.goldis_api.can_validate_audit_metadata, true, "API cannot evaluate audit constraint");
  assert.equal(roles.goldis_api.can_update_run_events, false, "API can mutate run history");
  assert.equal(roles.goldis_worker.can_update_runs, true, "portal worker cannot update runs");
  assert.equal(roles.goldis_worker.can_validate_audit_metadata, false, "portal worker can execute unrelated audit functions");
  assert.equal(roles.goldis_worker.can_read_import_key, true, "portal worker cannot evaluate deletion trigger");
  assert.equal(roles.goldis_worker.can_read_import_filename, false, "portal worker has unnecessary import metadata access");
  assert.equal(roles.goldis_worker.can_check_deletion_barrier, true, "portal worker cannot check tombstones");
  assert.equal(roles.goldis_enrichment.can_check_deletion_barrier, true, "registry worker cannot check tombstones");
  assert.equal(roles.goldis_worker.can_read_password_hash, false, "portal worker can read password hashes");
  assert.equal(roles.goldis_worker.can_update_enrichment_jobs, false, "portal worker can update enrichment jobs");
  assert.equal(roles.goldis_enrichment.can_update_enrichment_jobs, true, "enrichment worker cannot update jobs");
  assert.equal(roles.goldis_enrichment.can_update_source_rows, true, "enrichment worker cannot apply REGON result");
  assert.equal(roles.goldis_enrichment.can_update_canonical_entities, true,
    "enrichment worker cannot resolve canonical grouping");
  assert.equal(roles.goldis_enrichment.can_update_runs, false, "enrichment worker can mutate portal execution");
  assert.equal(roles.goldis_enrichment.can_read_user_status, true, "enrichment worker cannot revalidate actor status");
  assert.equal(roles.goldis_enrichment.can_read_password_hash, false, "enrichment worker can read password hashes");
  assert.equal(roles.goldis_enrichment.can_append_audit, true, "enrichment worker cannot append completion audit events");
  assert.equal(roles.goldis_enrichment.can_update_audit, false, "enrichment worker can mutate audit history");
  assert.equal(roles.goldis_enrichment.can_read_audit, false, "enrichment worker can read audit history");
  assert.equal(roles.goldis_enrichment.can_validate_audit_metadata, true,
    "enrichment worker cannot satisfy the audit metadata check constraint");
  assert.equal(roles.goldis_enrichment.can_update_import_batches, false, "enrichment worker can mutate imports");
  assert.equal(roles.goldis_enrichment.can_change_import_tenant, false, "enrichment worker can reassign an import tenant");
  assert.equal(roles.goldis_enrichment.can_lock_import_batch, true, "enrichment worker cannot lock an import batch");
  for (const [tablePrivilege, sensitivePrivilege, lockPrivilege] of [
    ["can_update_users", "can_change_user_status", "can_lock_user"],
    ["can_update_memberships", "can_change_membership_role", "can_lock_membership"],
    ["can_update_tools", "can_change_tool_status", "can_lock_tool"],
    ["can_update_tool_grants", "can_change_tool_grant", "can_lock_tool_grant"],
    ["can_update_automation_runs", null, "can_lock_automation_run"],
    ["can_update_corrections", null, "can_lock_correction"],
    ["can_update_grouping_conflicts", null, "can_lock_grouping_conflict"],
    ["can_update_entity_links", null, "can_lock_entity_link"],
  ]) {
    assert.equal(roles.goldis_enrichment[tablePrivilege], false, `enrichment worker has table-wide UPDATE: ${tablePrivilege}`);
    if (sensitivePrivilege) assert.equal(roles.goldis_enrichment[sensitivePrivilege], false,
      `enrichment worker can mutate authorization data: ${sensitivePrivilege}`);
    assert.equal(roles.goldis_enrichment[lockPrivilege], true, `enrichment worker cannot acquire a row lock: ${lockPrivilege}`);
  }
  console.log("RUNTIME_DB_PERMISSION_SMOKE_PASS");
}

main().catch((error) => {
  console.error("RUNTIME_DB_PERMISSION_SMOKE_FAIL", error instanceof Error ? error.message : "UNKNOWN");
  process.exitCode = 1;
});
