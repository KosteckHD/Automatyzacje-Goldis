import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

test("offline admin reset refuses to run without the explicit production maintenance confirmation", () => {
  const script = path.resolve(__dirname, "../../../scripts/offline-admin-password-reset.cjs");
  const result = spawnSync(process.execPath, [script, "synthetic.admin"], {
    encoding: "utf8",
    env: {
      ...process.env,
      APP_ENV: "production",
      GOLDIS_OFFLINE_ADMIN_RECOVERY: "",
      DATABASE_URL: "postgres://api:synthetic@postgres:5432/goldis",
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "OFFLINE_ADMIN_RECOVERY_MAINTENANCE_CONFIRMATION_REQUIRED");
});
