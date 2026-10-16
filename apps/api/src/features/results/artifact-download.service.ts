import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Inject, Injectable } from "@nestjs/common";
import { decryptStoredArtifactBytes } from "./artifact-crypto";
import { ArtifactDownloadError, type VerifiedArtifactDownload } from "./artifact-download.contract";
import { ArtifactDownloadRepository } from "./artifact-download.repository";
import { configuredArtifactRoot, resolveArtifactPath } from "./artifact-store";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ArtifactDownloadService {
  constructor(@Inject(ArtifactDownloadRepository) private readonly repository: ArtifactDownloadRepository) {}

  /** Retrieves a ready artifact for a completed run and verifies its bytes before returning them. */
  async download(runId: string): Promise<VerifiedArtifactDownload> {
    if (!uuidPattern.test(runId)) throw new ArtifactDownloadError("ARTIFACT_NOT_FOUND");
    try {
      return await this.repository.withReadyArtifact(runId, async (artifact) => {
        let filePath: string;
        try {
          filePath = resolveArtifactPath(configuredArtifactRoot(), artifact.storageKey);
        } catch {
          throw new ArtifactDownloadError("ARTIFACT_STORAGE_UNAVAILABLE");
        }
        let storedBytes: Buffer;
        try {
          storedBytes = await readFile(filePath);
        } catch {
          throw new ArtifactDownloadError("ARTIFACT_NOT_FOUND");
        }
        let bytes: Buffer;
        try {
          bytes = decryptStoredArtifactBytes(artifact.artifactId, storedBytes).bytes;
        } catch {
          throw new ArtifactDownloadError("ARTIFACT_STORAGE_UNAVAILABLE");
        }
        const actual = createHash("sha256").update(bytes).digest();
        const expected = Buffer.from(artifact.sha256, "hex");
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
          throw new ArtifactDownloadError("ARTIFACT_INTEGRITY_FAILED");
        }
        return { fileName: artifact.fileName, bytes, sha256: artifact.sha256 };
      });
    } catch (error) {
      if (error instanceof ArtifactDownloadError) throw error;
      throw new ArtifactDownloadError("ARTIFACT_STORAGE_UNAVAILABLE");
    }
  }
}
