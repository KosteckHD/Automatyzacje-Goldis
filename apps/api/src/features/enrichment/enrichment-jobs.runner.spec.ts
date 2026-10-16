import assert from "node:assert/strict";
import { test } from "node:test";

test("enrichment runner in disabled mode leaves queued jobs unclaimed", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  try {
    const { RegistryEnrichmentJobRunner } = await import("./enrichment-job.runner");
    const runner = new RegistryEnrichmentJobRunner(null);
    assert.equal(await runner.processOne("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), false);
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
