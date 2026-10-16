import "reflect-metadata";
import { SequelizeStorage, Umzug } from "umzug";
import { sequelize } from "./db";
import { migrationGlob } from "./migration-path";
import { assertSequelizeRuntimeDatabaseRole } from "./runtime-database-role";
import { loadDatabaseProcessRuntimeConfig } from "../config";
import { configureDefaultDatabaseUrl } from "./db";

async function migrate() {
  const runtimeConfig = loadDatabaseProcessRuntimeConfig(process.env, "goldis_migrator");
  configureDefaultDatabaseUrl(runtimeConfig.databaseUrl);
  await sequelize.authenticate();
  await assertSequelizeRuntimeDatabaseRole(sequelize, runtimeConfig.expectedRole);
  const runner = new Umzug({
    migrations: { glob: migrationGlob(__dirname) },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize }),
    logger: console,
  });
  await runner.up();
  await sequelize.close();
}

migrate().catch((error) => {
  console.error("MIGRATION_FAILED", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
