import { createHash } from "node:crypto";

export type DeletionTargetType = "artifact" | "run" | "import" | "tenant";

export const deletionTargetTypes: readonly DeletionTargetType[] = ["artifact", "run", "import", "tenant"];
export const deletionPreviewLifetimeMs = 5 * 60_000;

export type DeletionPreviewSummary = Readonly<{
  targetType: DeletionTargetType;
  targetId: string | null;
  counts: Readonly<Record<string, number>>;
  blockers: readonly string[];
}>;

export type PreviewSnapshot = Readonly<{
  summary: DeletionPreviewSummary;
  sourceVersion: string;
}>;

export function previewFingerprint(tenantId: string, snapshot: PreviewSnapshot): string {
  const canonical = JSON.stringify({
    version: 1,
    tenantId,
    targetType: snapshot.summary.targetType,
    targetId: snapshot.summary.targetId,
    sourceVersion: snapshot.sourceVersion,
    counts: snapshot.summary.counts,
    blockers: snapshot.summary.blockers,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
