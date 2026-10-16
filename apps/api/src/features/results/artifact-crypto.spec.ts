import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptStoredArtifactBytes, encryptArtifactBytes } from "./artifact-crypto";

const artifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function environment(active: string, entries: Record<string, Buffer>): Readonly<Record<string, string>> {
  const keyring = Object.fromEntries(
    Object.entries(entries).map(([version, key]) => [version, key.toString("base64")]),
  );
  return {
    ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION: active,
    ARTIFACT_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify(keyring)).toString("base64"),
  };
}

test("artefakt szyfruje się w spoczynku, wspiera rotację kluczy i wiąże się z identyfikatorem", () => {
  const keyV1 = Buffer.alloc(32, 1);
  const keyV2 = Buffer.alloc(32, 2);
  const oldConfig = environment("1", { "1": keyV1 });
  const bytes = Buffer.from("synthetic workbook with PESEL");
  const stored = encryptArtifactBytes(artifactId, bytes, oldConfig);
  assert.notDeepEqual(stored, bytes);

  const rotatedConfig = environment("2", { "1": keyV1, "2": keyV2 });
  assert.deepEqual(decryptStoredArtifactBytes(artifactId, stored, rotatedConfig), { bytes, encrypted: true });
  assert.throws(() => decryptStoredArtifactBytes("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", stored, rotatedConfig), {
    code: "ARTIFACT_DECRYPT_FAILED",
  });
  const tampered = Buffer.from(stored);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptStoredArtifactBytes(artifactId, tampered, rotatedConfig), {
    code: "ARTIFACT_DECRYPT_FAILED",
  });
});

test("stare pliki XLSX pozostają czytelne do kontrolowanej migracji magazynu", () => {
  const bytes = Buffer.from("legacy xlsx bytes");
  assert.deepEqual(decryptStoredArtifactBytes(artifactId, bytes), { bytes, encrypted: false });
  assert.throws(
    () =>
      decryptStoredArtifactBytes(artifactId, bytes, {
        ...environment("1", { "1": Buffer.alloc(32, 1) }),
        APP_ENV: "production",
      }),
    { code: "ARTIFACT_DECRYPT_FAILED" },
  );
  assert.throws(
    () =>
      decryptStoredArtifactBytes(artifactId, bytes, {
        ...environment("1", { "1": Buffer.alloc(32, 1) }),
        ARTIFACT_REQUIRE_ENCRYPTION: "1",
      }),
    { code: "ARTIFACT_DECRYPT_FAILED" },
  );
});
