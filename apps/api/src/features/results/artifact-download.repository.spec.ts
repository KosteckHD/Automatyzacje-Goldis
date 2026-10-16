import assert from "node:assert/strict";
import { test } from "node:test";

type TestTransaction = { id: string };

test("ArtifactDownloadRepository holds the run lock and deletion checks through file verification", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  const [{ ArtifactDownloadRepository }, db] = await Promise.all([
    import("./artifact-download.repository"),
    import("../../infrastructure/database/db"),
  ]);
  const originals = {
    transaction: db.sequelize.transaction,
    query: db.sequelize.query,
    artifactFind: db.ExportArtifact.findOne,
  };
  const transaction: TestTransaction = { id: "artifact-download-transaction" };
  const operations: Array<{ operation: string; transaction?: unknown }> = [];
  let tombstoneType: string | null = null;
  const artifact = {
    artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    storageKey: "artifacts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.xlsx",
    fileName: "result.xlsx",
    sha256: "a".repeat(64),
    policyCount: 2,
  };

  Reflect.set(db.sequelize, "transaction", async (work: (transaction: TestTransaction) => Promise<unknown>) => {
    operations.push({ operation: "transaction" });
    return work(transaction);
  });
  Reflect.set(
    db.sequelize,
    "query",
    async (sql: string, options: { transaction: unknown; replacements?: Record<string, unknown> }) => {
      operations.push({
        operation: sql.includes("automation_runs") ? "run.lock" : "tombstone.check",
        transaction: options.transaction,
      });
      if (sql.includes("automation_runs")) return [{ id: "run-1", status: "completed", batchId: "batch-1" }];
      return [{ exists: options.replacements?.resourceType === tombstoneType }];
    },
  );
  Reflect.set(db.ExportArtifact, "findOne", async (options: { transaction: unknown }) => {
    operations.push({ operation: "artifact.find", transaction: options.transaction });
    return artifact;
  });

  try {
    const repository = new ArtifactDownloadRepository();
    const response = await repository.withReadyArtifact("run-1", async (readyArtifact) => {
      operations.push({ operation: "artifact.verify", transaction });
      assert.deepEqual(readyArtifact, artifact);
      return "verified";
    });
    assert.equal(response, "verified");
    assert.deepEqual(
      operations.map(({ operation }) => operation),
      [
        "transaction",
        "run.lock",
        "tombstone.check",
        "tombstone.check",
        "artifact.find",
        "tombstone.check",
        "artifact.verify",
      ],
    );
    assert.ok(
      operations.filter(({ transaction: tx }) => tx !== undefined).every(({ transaction: tx }) => tx === transaction),
    );

    operations.length = 0;
    tombstoneType = "run";
    await assert.rejects(() => repository.withReadyArtifact("run-1", async () => "must not read"), {
      code: "ARTIFACT_NOT_FOUND",
    });
    assert.equal(
      operations.some(({ operation }) => operation === "artifact.find"),
      false,
    );
    assert.equal(
      operations.some(({ operation }) => operation === "artifact.verify"),
      false,
    );
  } finally {
    db.sequelize.transaction = originals.transaction;
    db.sequelize.query = originals.query;
    db.ExportArtifact.findOne = originals.artifactFind;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
