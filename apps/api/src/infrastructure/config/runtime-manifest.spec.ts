import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeBuildManifest } from "./runtime-manifest";

test("runtime manifest exposes only bounded build identifiers", () => {
  assert.deepEqual(runtimeBuildManifest({
    GOLDIS_BUILD_VERSION: "0.1.7-rc.2", GOLDIS_BUILD_COMMIT: "ABCDEF1234567890",
    GOLDIS_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`, DATABASE_URL: "postgres://user:secret@db/private",
  }), {
    version: "0.1.7-rc.2", commit: "abcdef1234567890", imageDigest: `sha256:${"a".repeat(64)}`,
  });
  assert.deepEqual(runtimeBuildManifest({
    GOLDIS_BUILD_VERSION: "C:\\private\\release", GOLDIS_BUILD_COMMIT: "unknown",
    GOLDIS_IMAGE_DIGEST: "secret-value", SESSION_SECRET: "synthetic-secret",
  }), { version: "0.1.0", commit: null, imageDigest: null });
});
