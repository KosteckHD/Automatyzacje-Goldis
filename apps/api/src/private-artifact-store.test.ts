import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactStoreError,
  configuredArtifactRoot,
  findOrphanedArtifacts,
  resolveArtifactPath,
  writeArtifactAtomically,
} from "./private-artifact-store";

const artifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function withDirectory(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "goldis-artifact-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("atomowo publikuje kompletny plik w prywatnym katalogu", async () => {
  await withDirectory(async (root) => {
    const bytes = Buffer.from("synthetic-xlsx-bytes");
    const result = await writeArtifactAtomically(root, artifactId, bytes);
    assert.equal(result.storageKey, `artifacts/${artifactId}.xlsx`);
    assert.equal(result.sizeBytes, bytes.length);
    assert.deepEqual(await readFile(resolveArtifactPath(root, result.storageKey)), bytes);
    const entries = await readdir(join(root, "artifacts"));
    assert.deepEqual(entries, [`${artifactId}.xlsx`]);
    if (process.platform !== "win32") {
      const rootMode = (await stat(join(root, "artifacts"))).mode & 0o777;
      const fileMode = (await stat(resolveArtifactPath(root, result.storageKey))).mode & 0o777;
      assert.equal(rootMode, 0o700);
      assert.equal(fileMode, 0o600);
    }
  });
});

test("błąd przed rename usuwa plik tymczasowy i nie publikuje artefaktu", async () => {
  await withDirectory(async (root) => {
    await assert.rejects(
      writeArtifactAtomically(root, artifactId, Buffer.from("synthetic"), { beforeRename: () => { throw new Error("synthetic stop"); } }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === "ARTIFACT_WRITE_FAILED",
    );
    assert.deepEqual(await readdir(join(root, "artifacts")), []);
    assert.deepEqual(await findOrphanedArtifacts(root, new Set()), []);
  });
});

test("wykrywa plik po publikacji bez metadanych i tymczasowy plik po przerwaniu", async () => {
  await withDirectory(async (root) => {
    const result = await writeArtifactAtomically(root, artifactId, Buffer.from("synthetic"));
    const tempName = ".bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.cccccccc-cccc-4ccc-8ccc-cccccccccccc.tmp";
    await writeFile(join(root, "artifacts", tempName), "partial");
    const orphans = await findOrphanedArtifacts(root, new Set());
    assert.deepEqual(orphans, [
      { storageKey: `artifacts/${tempName}`, kind: "temporary" },
      { storageKey: result.storageKey, kind: "published" },
    ].sort((left, right) => left.storageKey.localeCompare(right.storageKey)));
    assert.deepEqual(await findOrphanedArtifacts(root, new Set([result.storageKey])), [
      { storageKey: `artifacts/${tempName}`, kind: "temporary" },
    ]);
  });
});

test("odrzuca zły katalog, pusty plik i klucz z traversal", async () => {
  assert.throws(() => configuredArtifactRoot({}), { code: "ARTIFACT_STORAGE_CONFIG_INVALID" });
  assert.throws(() => resolveArtifactPath("/private", "../public/secret.xlsx"), { code: "ARTIFACT_KEY_INVALID" });
  await withDirectory(async (root) => {
    await assert.rejects(writeArtifactAtomically(root, artifactId, Buffer.alloc(0)), { code: "ARTIFACT_EMPTY" });
  });
});
