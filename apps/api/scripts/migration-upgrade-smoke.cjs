"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { QueryTypes, Sequelize } = require("sequelize");
const { SequelizeStorage, Umzug } = require("umzug");

const targetDatabase = process.argv[2];
const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl || !/^goldis_migration_smoke_[a-z0-9_]+$/.test(targetDatabase ?? "")) {
  console.error("MIGRATION_UPGRADE_USAGE: a disposable goldis_migration_smoke_* database is required");
  process.exit(2);
}

const databaseUrl = new URL(sourceUrl);
databaseUrl.pathname = `/${targetDatabase}`;
const sequelize = new Sequelize(databaseUrl.toString(), { logging: false });
const migrationPath = path.join(__dirname, "../dist/infrastructure/database/migrations/0{0[1-9],1[0-9],2[0-9],3[0-9],4[0-9],5[0-9],6[0-2]}-*.js").replace(/\\/g, "/");
const umzug = new Umzug({
  migrations: { glob: migrationPath },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: undefined,
});

const lockTables = [
  "import_batches",
  "users",
  "tenant_memberships",
  "tools",
  "tool_grants",
  "automation_runs",
  "regon_corrections",
  "entity_grouping_conflicts",
  "source_entity_links",
].sort();

async function selectedRows(sql, bind) {
  return sequelize.query(sql, { bind, type: QueryTypes.SELECT });
}

async function preservedData(seed) {
  const [user] = await selectedRows(
    `SELECT user_id::text, username, username_normalized, password_hash, status,
            created_at::text, updated_at::text, last_login_at::text
       FROM users WHERE user_id = $1`,
    [seed.userId],
  );
  const [membership] = await selectedRows(
    `SELECT tenant_id::text, user_id::text, role, status, created_at::text, updated_at::text
       FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
    [seed.tenantId, seed.userId],
  );
  if (!user || !membership) throw new Error("SYNTHETIC_UPGRADE_SENTINEL_MISSING");
  return JSON.stringify({ user, membership });
}

async function lockCapabilityState(expectedPresent) {
  const columns = await selectedRows(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'enrichment_worker_lock_capability'
      ORDER BY table_name`,
  );
  if (columns.length !== (expectedPresent ? lockTables.length : 0)
    || (expectedPresent && columns.some((row, index) => row.table_name !== lockTables[index]))) {
    throw new Error("LOCK_CAPABILITY_COLUMN_SET_MISMATCH");
  }
  if (!expectedPresent) return;

  const constraints = await selectedRows(
    `SELECT relation.relname AS table_name, pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
        AND constraint_row.contype = 'c'
        AND pg_get_constraintdef(constraint_row.oid) ILIKE '%enrichment_worker_lock_capability%'
      ORDER BY relation.relname`,
    [lockTables],
  );
  if (constraints.length !== lockTables.length
    || constraints.some((row, index) => row.table_name !== lockTables[index]
      || !row.definition.toLowerCase().includes("enrichment_worker_lock_capability")
      || !row.definition.toLowerCase().includes("= false"))) {
    throw new Error("LOCK_CAPABILITY_CONSTRAINT_SET_MISMATCH");
  }

  const [batch] = await selectedRows(
    "SELECT enrichment_worker_lock_capability FROM users WHERE user_id = $1",
    [currentSeed.userId],
  );
  const [membership] = await selectedRows(
    `SELECT enrichment_worker_lock_capability FROM tenant_memberships
      WHERE tenant_id = $1 AND user_id = $2`,
    [currentSeed.tenantId, currentSeed.userId],
  );
  if (!batch || batch.enrichment_worker_lock_capability !== false
    || !membership || membership.enrichment_worker_lock_capability !== false) {
    throw new Error("LOCK_CAPABILITY_DEFAULT_MISMATCH");
  }
}

let currentSeed;
let stage = "connect";

async function main() {
  await sequelize.authenticate();
  stage = "apply-schema-061";
  await umzug.up({ to: "061-optional-run-contact-person.js" });
  const beforeUpgrade = await umzug.executed();
  if (beforeUpgrade.length !== 61 || beforeUpgrade.at(-1)?.name !== "061-optional-run-contact-person.js") {
    throw new Error("SCHEMA_061_BASELINE_MISMATCH");
  }

  stage = "seed-synthetic-user-and-membership";
  const [tenant] = await selectedRows("SELECT tenant_id::text FROM tenants WHERE slug = 'goldis'");
  if (!tenant) throw new Error("SYNTHETIC_UPGRADE_TENANT_MISSING");
  currentSeed = {
    tenantId: tenant.tenant_id,
    userId: randomUUID(),
    username: `Synthetic.Upgrade.${randomUUID().slice(0, 8)}`,
  };
  await sequelize.query(
    `INSERT INTO users (user_id, username, username_normalized, password_hash, status, created_at, updated_at, last_login_at)
     VALUES ($1, $2, $3, repeat('x', 64), 'active', now(), now(), NULL)`,
    { bind: [currentSeed.userId, currentSeed.username, currentSeed.username.toLowerCase()] },
  );
  await sequelize.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, 'operator', 'active', now(), now())`,
    { bind: [currentSeed.tenantId, currentSeed.userId] },
  );
  const snapshotBefore = await preservedData(currentSeed);

  stage = "apply-062";
  await umzug.up();
  stage = "verify-data-after-upgrade";
  if ((await preservedData(currentSeed)) !== snapshotBefore) throw new Error("UPGRADE_CHANGED_EXISTING_DATA");
  stage = "verify-lock-columns-after-upgrade";
  await lockCapabilityState(true);

  stage = "rollback-to-061";
  await umzug.down();
  const afterRollback = await umzug.executed();
  if (afterRollback.length !== 61 || afterRollback.at(-1)?.name !== "061-optional-run-contact-person.js") {
    throw new Error("ROLLBACK_DID_NOT_RESTORE_SCHEMA_061");
  }
  stage = "verify-lock-columns-after-rollback";
  await lockCapabilityState(false);
  stage = "verify-data-after-rollback";
  if ((await preservedData(currentSeed)) !== snapshotBefore) throw new Error("ROLLBACK_CHANGED_EXISTING_DATA");

  stage = "reapply-062";
  await umzug.up();
  if ((await umzug.executed()).length !== 62) throw new Error("REAPPLY_DID_NOT_RESTORE_SCHEMA_062");
  stage = "verify-lock-columns-after-reapply";
  await lockCapabilityState(true);
  stage = "verify-data-after-reapply";
  if ((await preservedData(currentSeed)) !== snapshotBefore) throw new Error("REAPPLY_CHANGED_EXISTING_DATA");

  console.log("MIGRATION_UPGRADE_PASS from=061 to=062 rows=user,membership preserved=true rollback=true reapply=true lock_capability_columns=9 lock_capability_default=false");
}

main()
  .catch((error) => {
    const code = error?.parent?.code ?? error?.original?.code ?? error?.name ?? "UNKNOWN";
    const reason = typeof error?.message === "string" && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "UNCLASSIFIED";
    console.error(`MIGRATION_UPGRADE_FAILED stage=${stage} code=${code} reason=${reason}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close().catch(() => undefined);
  });
