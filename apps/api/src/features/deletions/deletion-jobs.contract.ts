export const deletionJobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const deletionIdempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,119}$/;

export type DeletionJobView = Readonly<{
  jobId: string;
  targetType: string;
  targetId: string;
  status: string;
  version: number;
  attemptCount: number;
  fileCount: number;
  filesRemoved: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}>;

export function safeJob(row: Record<string, unknown>, fileCount: number, filesRemoved: number): DeletionJobView {
  const date = (value: unknown) => (value == null ? null : new Date(String(value)).toISOString());
  return {
    jobId: String(row.jobId),
    targetType: String(row.targetType),
    targetId: String(row.targetId),
    status: String(row.status),
    version: Number(row.version),
    attemptCount: Number(row.attemptCount),
    fileCount,
    filesRemoved,
    errorCode: typeof row.errorCode === "string" ? row.errorCode : null,
    createdAt: date(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: date(row.updatedAt) ?? new Date(0).toISOString(),
    finishedAt: date(row.finishedAt),
  };
}
