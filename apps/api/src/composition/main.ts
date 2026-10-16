import "reflect-metadata";
import { AppModule } from "./module";
import { apiRequestBudgetMiddleware, createHttpApplication } from "../infrastructure/http";
import { LoginRateLimiter } from "../features/auth";
import { assertDeletionJournalApplied } from "../features/deletions/deletion-journal-admission";
import { assertImportParserClientConfiguration } from "../features/imports/import-parser-client";
import { configureApiRuntimeConfig, loadDatabaseProcessRuntimeConfig } from "../infrastructure/config";
import { API_DATABASE, assertSequelizeRuntimeDatabaseRole } from "../infrastructure/database";
import { configureDefaultDatabaseUrl } from "../infrastructure/database/db";

async function bootstrap() {
  const runtimeConfig = configureApiRuntimeConfig();
  const databaseConfig = loadDatabaseProcessRuntimeConfig(process.env, "goldis_api");
  configureDefaultDatabaseUrl(databaseConfig.databaseUrl);
  assertImportParserClientConfiguration();
  const app = await createHttpApplication(AppModule, { cors: false }, undefined, {
    trustProxyIps: runtimeConfig.trustProxyIps,
  });
  app.enableShutdownHooks();
  try {
    await assertSequelizeRuntimeDatabaseRole(app.get(API_DATABASE), "goldis_api");
    await assertDeletionJournalApplied();
    const limiter = app.get(LoginRateLimiter);
    app.use("/api", apiRequestBudgetMiddleware((ip) => limiter.consumeApiRequest(ip)));
    await app.listen(runtimeConfig.port, "0.0.0.0");
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

bootstrap().catch((error) => {
  console.error("API_START_FAILED", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
