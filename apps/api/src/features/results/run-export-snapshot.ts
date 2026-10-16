type SnapshotBase = Readonly<{
  sourceRowId: string;
  rowVersion: number;
  companyName: string;
  decisionMakerName: string | null;
  effectiveRegon: string;
  issues: readonly string[];
}>;

export type RunInputSnapshotForExportV1 = SnapshotBase &
  Readonly<{
    schemaVersion: 1;
  }>;

export type RunInputSnapshotForExportV2 = SnapshotBase &
  Readonly<{
    schemaVersion: 2;
    mobile: string;
    phone: string;
    email: string;
  }>;

export type RunInputSnapshotForExport = RunInputSnapshotForExportV1 | RunInputSnapshotForExportV2;

/** Validates immutable identity data and uses a separate V2 shape for frozen contacts. */
export function validateRunInputSnapshotForExport(
  value: unknown,
  expectedSourceRowId: string,
): RunInputSnapshotForExport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RUN_INPUT_SNAPSHOT_INVALID");
  const snapshot = value as Record<string, unknown>;
  if (
    (snapshot.schemaVersion !== 1 && snapshot.schemaVersion !== 2) ||
    snapshot.sourceRowId !== expectedSourceRowId ||
    !Number.isSafeInteger(snapshot.rowVersion) ||
    Number(snapshot.rowVersion) < 1 ||
    typeof snapshot.companyName !== "string" ||
    !snapshot.companyName.trim() ||
    !(snapshot.decisionMakerName === null || typeof snapshot.decisionMakerName === "string") ||
    typeof snapshot.effectiveRegon !== "string" ||
    !/^\d{9}(?:\d{5})?$/.test(snapshot.effectiveRegon) ||
    !Array.isArray(snapshot.issues) ||
    snapshot.issues.length !== 0 ||
    (snapshot.schemaVersion === 2 &&
      [snapshot.mobile, snapshot.phone, snapshot.email].some((field) => typeof field !== "string"))
  ) {
    throw new Error("RUN_INPUT_SNAPSHOT_INVALID");
  }
  return snapshot as unknown as RunInputSnapshotForExport;
}
