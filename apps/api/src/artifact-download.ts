import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AutomationRun, ExportArtifact } from "./db";
import { configuredArtifactRoot, resolveArtifactPath } from "./private-artifact-store";

export class ArtifactDownloadError extends Error {
  constructor(readonly code: "ARTIFACT_NOT_FOUND" | "ARTIFACT_INTEGRITY_FAILED" | "ARTIFACT_STORAGE_UNAVAILABLE") {
    super(code);
    this.name = "ArtifactDownloadError";
  }
}

export type VerifiedArtifactDownload = Readonly<{ fileName: string; bytes: Buffer; sha256: string }>;

/** Retrieves only a ready artifact belonging to a completed run and verifies bytes before returning them. */
export async function getVerifiedArtifactDownload(runId: string): Promise<VerifiedArtifactDownload> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    throw new ArtifactDownloadError("ARTIFACT_NOT_FOUND");
  }
  try {
    const run = await AutomationRun.findByPk(runId);
    if (!run || run.status !== "completed") throw new ArtifactDownloadError("ARTIFACT_NOT_FOUND");
    const artifact = await ExportArtifact.findOne({
      where: { runId, state: "ready" },
      order: [["readyAt", "DESC"], ["createdAt", "DESC"]],
    });
    if (!artifact || artifact.policyCount < 1 || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      throw new ArtifactDownloadError("ARTIFACT_NOT_FOUND");
    }
    let filePath: string;
    try {
      filePath = resolveArtifactPath(configuredArtifactRoot(), artifact.storageKey);
    } catch {
      throw new ArtifactDownloadError("ARTIFACT_STORAGE_UNAVAILABLE");
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      throw new ArtifactDownloadError("ARTIFACT_NOT_FOUND");
    }
    const actual = createHash("sha256").update(bytes).digest();
    const expected = Buffer.from(artifact.sha256, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ArtifactDownloadError("ARTIFACT_INTEGRITY_FAILED");
    }
    return { fileName: artifact.fileName, bytes, sha256: artifact.sha256 };
  } catch (error) {
    if (error instanceof ArtifactDownloadError) throw error;
    throw new ArtifactDownloadError("ARTIFACT_STORAGE_UNAVAILABLE");
  }
}

