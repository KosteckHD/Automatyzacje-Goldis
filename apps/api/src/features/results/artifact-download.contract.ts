export class ArtifactDownloadError extends Error {
  constructor(readonly code: "ARTIFACT_NOT_FOUND" | "ARTIFACT_INTEGRITY_FAILED" | "ARTIFACT_STORAGE_UNAVAILABLE") {
    super(code);
    this.name = "ArtifactDownloadError";
  }
}

export type VerifiedArtifactDownload = Readonly<{ fileName: string; bytes: Buffer; sha256: string }>;

export type ReadyArtifact = Readonly<{
  artifactId: string;
  storageKey: string;
  fileName: string;
  sha256: string;
  policyCount: number;
}>;
