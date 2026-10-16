import { resolve, sep } from "node:path";
import { loadApiRuntimeConfig } from "../config";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ArtifactStorageConfigError extends Error {
  constructor(readonly code: "ARTIFACT_STORAGE_CONFIG_INVALID" | "ARTIFACT_KEY_INVALID") {
    super(code);
    this.name = "ArtifactStorageConfigError";
  }
}

export function configuredArtifactRoot(environment?: Readonly<Record<string, string | undefined>>): string {
  const value = environment === undefined ? loadApiRuntimeConfig().apiExportDirectory : environment.API_EXPORT_DIR;
  if (!value?.trim()) throw new ArtifactStorageConfigError("ARTIFACT_STORAGE_CONFIG_INVALID");
  return resolve(value);
}

export function resolveArtifactPath(root: string, storageKey: string): string {
  const match = /^artifacts\/([0-9a-f-]{36})\.xlsx$/i.exec(storageKey);
  if (!match || !uuidPattern.test(match[1])) throw new ArtifactStorageConfigError("ARTIFACT_KEY_INVALID");
  const absoluteRoot = resolve(root);
  const filePath = resolve(absoluteRoot, ...storageKey.split("/"));
  if (!filePath.startsWith(`${absoluteRoot}${sep}`)) throw new ArtifactStorageConfigError("ARTIFACT_KEY_INVALID");
  return filePath;
}
