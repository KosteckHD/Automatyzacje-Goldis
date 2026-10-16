import "reflect-metadata";
import { sequelize } from "../../infrastructure/database/db";
import { bootstrapAdminOnce } from "../../features/auth/bootstrap-admin";
import { assertSequelizeRuntimeDatabaseRole } from "../../infrastructure/database/runtime-database-role";
import { configureDefaultDatabaseUrl } from "../../infrastructure/database/db";
import { loadBootstrapAdminRuntimeConfig, loadDatabaseProcessRuntimeConfig } from "../../infrastructure/config";

async function main(): Promise<void> {
  const databaseConfig = loadDatabaseProcessRuntimeConfig(process.env, "goldis_migrator");
  const bootstrapConfig = loadBootstrapAdminRuntimeConfig(process.env);
  configureDefaultDatabaseUrl(databaseConfig.databaseUrl);
  try {
    await sequelize.authenticate();
    await assertSequelizeRuntimeDatabaseRole(sequelize, databaseConfig.expectedRole);
    await bootstrapAdminOnce(bootstrapConfig);
    console.log("BOOTSTRAP_ADMIN_COMPLETE");
  } finally {
    await sequelize.close();
  }
}

void main().catch(() => {
  console.error("BOOTSTRAP_ADMIN_FAILED");
  process.exitCode = 1;
});
