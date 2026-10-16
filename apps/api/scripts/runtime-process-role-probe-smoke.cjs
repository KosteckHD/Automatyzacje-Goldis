const { Sequelize } = require("sequelize");
const { assertSequelizeRuntimeDatabaseRole } = require("../dist/infrastructure/database/runtime-database-role.js");

async function verify(name, url, expected) {
  if (!url) throw new Error("MISSING_" + name.toUpperCase() + "_URL");
  const sequelize = new Sequelize(url, { logging: false, pool: { max: 1, min: 0 } });
  try {
    await sequelize.authenticate();
    await assertSequelizeRuntimeDatabaseRole(sequelize, expected);
  } finally {
    await sequelize.close();
  }
}

async function main() {
  await verify("api", process.env.DATABASE_URL, "goldis_api");
  await verify("enrichment", process.env.ENRICHMENT_DATABASE_URL, "goldis_enrichment");
  await verify("migrator", process.env.MIGRATOR_DATABASE_URL, "goldis_migrator");
  console.log("SEQUELIZE_RUNTIME_ROLE_PROBE_PASS processes=api,enrichment,migrator");
}

main().catch((error) => {
  console.error("SEQUELIZE_RUNTIME_ROLE_PROBE_FAIL", error instanceof Error ? error.message : "UNKNOWN");
  process.exitCode = 1;
});
