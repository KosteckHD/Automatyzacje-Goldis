const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { join } = require("node:path");

const testsDirectory = join(__dirname, "..", "dist");
const testFiles = readdirSync(testsDirectory)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(testsDirectory, name));

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
