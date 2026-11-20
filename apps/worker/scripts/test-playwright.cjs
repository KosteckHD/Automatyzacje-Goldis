const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { discoverNodeTests } = require("../../../scripts/run-node-tests.cjs");

const testsDirectory = join(__dirname, "..", "dist");
const testFiles = discoverNodeTests(testsDirectory);

if (testFiles.length === 0) {
  console.error("PLAYWRIGHT_TESTS_NOT_BUILT");
  process.exit(2);
}

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_INTEGRATION: "1" },
});

if (result.error) {
  console.error("PLAYWRIGHT_TEST_RUNNER_FAILED");
  process.exit(1);
}
process.exit(result.status ?? 1);
