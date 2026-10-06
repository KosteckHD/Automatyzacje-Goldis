import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { open, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exportArtifactsDirectory = "artifacts";

export class ArtifactStoreError extends Error {
  constructor(readonly code: "ARTIFACT_STORAGE_CONFIG_INVALID" | "ARTIFACT_KEY_INVALID" | "ARTIFACT_EMPTY" | "ARTIFACT_WRITE_FAILED") {
    super(code);
    this.name = "ArtifactStoreError";
  }
}

export type OrphanedArtifact = Readonly<{ storageKey: string; kind: "published" | "temporary" }>;

export function configuredArtifactRoot(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  const value = environment.API_EXPORT_DIR;
  if (!value?.trim()) throw new ArtifactStoreError("ARTIFACT_STORAGE_CONFIG_INVALID");
  return resolve(value);
}

export function resolveArtifactPath(root: string, storageKey: string): string {
  const match = /^artifacts\/([0-9a-f-]{36})\.xlsx$/i.exec(storageKey);
  if (!match || !uuidPattern.test(match[1])) throw new ArtifactStoreError("ARTIFACT_KEY_INVALID");
  const absoluteRoot = resolve(root);
  const filePath = resolve(absoluteRoot, ...storageKey.split("/"));
  if (!filePath.startsWith(`${absoluteRoot}${sep}`)) throw new ArtifactStoreError("ARTIFACT_KEY_INVALID");
  return filePath;
}

/** Writes to a unique same-directory temp file, fsyncs, then atomically renames into the private store. */
export async function writeArtifactAtomically(
  root: string,
  artifactId: string,
  bytes: Uint8Array,
  hooks: Readonly<{ beforeRename?: () => void | Promise<void> }> = {},
): Promise<{ storageKey: string; sizeBytes: number }> {
  if (!uuidPattern.test(artifactId)) throw new ArtifactStoreError("ARTIFACT_KEY_INVALID");
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new ArtifactStoreError("ARTIFACT_EMPTY");
  const storageKey = `${exportArtifactsDirectory}/${artifactId}.xlsx`;
  const destination = resolveArtifactPath(root, storageKey);
  const directory = dirname(destination);
  const temporaryPath = resolve(directory, `.${artifactId}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await hooks.beforeRename?.();
    await rename(temporaryPath, destination);
    return { storageKey, sizeBytes: bytes.byteLength };
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new ArtifactStoreError("ARTIFACT_WRITE_FAILED");
  }
}

/** Reports final files lacking DB metadata and temp files left by an abrupt process stop. */
export async function findOrphanedArtifacts(root: string, knownStorageKeys: ReadonlySet<string>): Promise<OrphanedArtifact[]> {
  const directory = resolve(root, exportArtifactsDirectory);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ArtifactStoreError("ARTIFACT_WRITE_FAILED");
  }
  const orphans: OrphanedArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const publishedMatch = /^([0-9a-f-]{36})\.xlsx$/i.exec(entry.name);
    if (publishedMatch && uuidPattern.test(publishedMatch[1])) {
      const storageKey = `${exportArtifactsDirectory}/${entry.name}`;
      if (!knownStorageKeys.has(storageKey)) orphans.push({ storageKey, kind: "published" });
      continue;
    }
    if (/^\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/i.test(entry.name)) {
      orphans.push({ storageKey: `${exportArtifactsDirectory}/${entry.name}`, kind: "temporary" });
    }
  }
  return orphans.sort((left, right) => left.storageKey.localeCompare(right.storageKey));
}
