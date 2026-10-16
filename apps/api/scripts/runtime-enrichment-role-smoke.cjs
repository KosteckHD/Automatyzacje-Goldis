"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { configureDefaultDatabaseUrl, sequelize } = require("../dist/infrastructure/database/db");
const { assertSequelizeRuntimeDatabaseRole } = require("../dist/infrastructure/database/runtime-database-role");
const { RegistryEnrichmentJobRunner } = require("../dist/features/enrichment/public");

function readFixture() {
  const fixturePath = process.env.GOLDIS_TEST_RUNTIME_ENRICHMENT_FIXTURE_PATH;
  const exportRoot = path.resolve(process.env.API_EXPORT_DIR || "");
  const resolvedFixture = path.resolve(fixturePath || "");
  if (!fixturePath || path.dirname(resolvedFixture) !== exportRoot || path.basename(resolvedFixture) !== "runtime-enrichment-fixture.json") {
    throw new Error("RUNTIME_ENRICHMENT_FIXTURE_PATH_INVALID");
  }
  const fixture = JSON.parse(fs.readFileSync(resolvedFixture, "utf8"));
  if (fixture.companyName !== "Firma syntetyczna runtime" || fixture.nipRaw !== "1234563218"
    || fixture.expectedRegon !== "123456789" || fixture.rowNumber !== 2
    || !/^[0-9a-f-]{36}$/i.test(fixture.batchId) || !/^[0-9a-f-]{36}$/i.test(fixture.jobId)
    || !/^[0-9a-f-]{36}$/i.test(fixture.sourceRowId)) {
    throw new Error("RUNTIME_ENRICHMENT_FIXTURE_INVALID");
  }
  return fixture;
}

function assertDisposableDatabase() {
  if (process.env.GOLDIS_TEST_APP_MODULE_SMOKE !== "1") throw new Error("RUNTIME_ENRICHMENT_SMOKE_MARKER_REQUIRED");
  const database = new URL(process.env.DATABASE_URL || "");
  if (!new Set(["postgres:", "postgresql:"]).has(database.protocol) || database.username !== "goldis_enrichment"
    || !database.pathname.startsWith("/goldis_migration_smoke_")
    || !new Set(["localhost", "127.0.0.1", "::1"]).has(database.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("RUNTIME_ENRICHMENT_DATABASE_TARGET_INVALID");
  }
}

async function main() {
  assertDisposableDatabase();
  const fixture = readFixture();
  configureDefaultDatabaseUrl(process.env.DATABASE_URL);
  try {
    await sequelize.authenticate();
    await assertSequelizeRuntimeDatabaseRole(sequelize, "goldis_enrichment");
    const provider = {
      cacheNamespace: "runtime-enrichment-smoke",
      async lookupByNip(nipNormalized) {
        if (nipNormalized !== "1234563218") throw new Error("RUNTIME_ENRICHMENT_UNEXPECTED_NIP");
        return {
          providerName: "runtime-smoke-provider",
          providerVersion: "1",
          dataVersion: "synthetic-fixture",
          fetchedAt: new Date(),
          candidates: [{ nip: "1234563218", name: fixture.companyName, regon: fixture.expectedRegon }],
        };
      },
    };
    const runner = new RegistryEnrichmentJobRunner(provider);
    if (!await runner.processOne()) throw new Error("RUNTIME_ENRICHMENT_JOB_NOT_CLAIMED");
    console.log("RUNTIME_ENRICHMENT_WORKER_PASS role=goldis_enrichment processed=true provider=synthetic");
  } finally {
    await sequelize.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("RUNTIME_ENRICHMENT_WORKER_FAIL", error instanceof Error ? error.message : "UNKNOWN");
  process.exitCode = 1;
});
