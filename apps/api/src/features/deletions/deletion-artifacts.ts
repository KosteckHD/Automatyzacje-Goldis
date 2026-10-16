import type { Stats } from "node:fs";
import { lstat, realpath, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { resolveArtifactPath } from "../../infrastructure/artifacts/artifact-storage";

function normalizedAbsolutePath(value: string): string {
  const absolute = resolve(value).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

export async function removePrivateArtifact(root: string, storageKey: string): Promise<void> {
  let filePath: string;
  try {
    filePath = resolveArtifactPath(root, storageKey);
  } catch {
    throw new Error("ARTIFACT_DELETE_KEY_INVALID");
  }
  const absoluteRoot = resolve(root);
  let rootInfo: Stats;
  let canonicalRoot: string;
  try {
    rootInfo = await lstat(absoluteRoot);
    canonicalRoot = await realpath(absoluteRoot);
  } catch {
    throw new Error("ARTIFACT_DELETE_ROOT_UNAVAILABLE");
  }
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    normalizedAbsolutePath(canonicalRoot) !== normalizedAbsolutePath(absoluteRoot)
  ) {
    throw new Error("ARTIFACT_DELETE_ROOT_UNSAFE");
  }
  const expectedDirectory = resolve(absoluteRoot, "artifacts");
  if (!filePath.startsWith(`${expectedDirectory}${sep}`) || dirname(filePath) !== expectedDirectory) {
    throw new Error("ARTIFACT_DELETE_PATH_UNSAFE");
  }
  let directoryInfo: Stats;
  try {
    directoryInfo = await lstat(expectedDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("ARTIFACT_DELETE_DIRECTORY_UNAVAILABLE");
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error("ARTIFACT_DELETE_DIRECTORY_UNSAFE");
  let fileInfo: Stats;
  try {
    fileInfo = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("ARTIFACT_DELETE_FILE_UNAVAILABLE");
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("ARTIFACT_DELETE_FILE_UNSAFE");
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("ARTIFACT_DELETE_FILE_UNAVAILABLE");
  }
}
