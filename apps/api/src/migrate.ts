import "reflect-metadata";
import { join } from "node:path";
import { SequelizeStorage, Umzug } from "umzug";
import { sequelize } from "./db";

async function migrate() {
  await sequelize.authenticate();
  const runner = new Umzug({
    migrations: { glob: join(__dirname, "migrations", "*.js") },
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
