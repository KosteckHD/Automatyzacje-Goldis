export type AutomationDraftIdentity = { tenantId: string; userId: string };
export type AutomationDraftAttempt = {
  kind: "selected" | "all";
  preparationId: string;
  revision: number;
  sourceFingerprint: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
};
export type AutomationDraft = {
  version: 1;
  tenantId: string;
  userId: string;
  batchId: string;
  preparationId: string;
  revision: number;
  sourceFingerprint: string;
  mode: "range" | "list";
  selectionMode: "companies" | "advanced";
  selectedRows: number[];
  fromRow: string;
  toRow: string;
  rowList: string;
  updatedAt: string;
  pendingAttempt: AutomationDraftAttempt | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[0-9a-f]{64}$/i;
const KEY = /^[0-9a-f-]{16,80}$/i;

export function automationDraftStorageKey(identity: AutomationDraftIdentity, batchId: string): string | null {
  if (!identity.tenantId || !identity.userId || !batchId || identity.tenantId.length > 120 || identity.userId.length > 120 || batchId.length > 120) return null;
  return `goldis:oc-draft:v1:${encodeURIComponent(identity.tenantId)}:${encodeURIComponent(identity.userId)}:${encodeURIComponent(batchId)}`;
}

function validAttempt(value: unknown): value is AutomationDraftAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Partial<AutomationDraftAttempt>;
  if ((attempt.kind !== "selected" && attempt.kind !== "all") || typeof attempt.preparationId !== "string" || !UUID.test(attempt.preparationId)
    || !Number.isInteger(attempt.revision) || typeof attempt.sourceFingerprint !== "string" || !FINGERPRINT.test(attempt.sourceFingerprint)
    || typeof attempt.idempotencyKey !== "string" || !KEY.test(attempt.idempotencyKey) || !attempt.payload || typeof attempt.payload !== "object" || Array.isArray(attempt.payload)) return false;
  const payload = attempt.payload as Record<string, unknown>;
  const allowed = attempt.kind === "all"
    ? new Set(["preparationId", "snapshotFingerprint", "idempotencyKey"])
    : new Set(["fromRow", "toRow", "rowNumbers", "selectionFingerprint", "idempotencyKey"]);
  if (Object.keys(payload).some((key) => !allowed.has(key)) || payload.idempotencyKey !== attempt.idempotencyKey) return false;
  if (attempt.kind === "all") return payload.preparationId === attempt.preparationId
    && typeof payload.snapshotFingerprint === "string" && FINGERPRINT.test(payload.snapshotFingerprint);
  return typeof payload.selectionFingerprint === "string" && FINGERPRINT.test(payload.selectionFingerprint)
    && (typeof payload.fromRow === "number" && Number.isSafeInteger(payload.fromRow)
      && typeof payload.toRow === "number" && Number.isSafeInteger(payload.toRow)
      || Array.isArray(payload.rowNumbers) && payload.rowNumbers.length > 0 && payload.rowNumbers.length <= 500
        && payload.rowNumbers.every((row) => typeof row === "number" && Number.isSafeInteger(row) && row >= 2));
}

export function readAutomationDraft(storage: Storage | null, key: string): AutomationDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > 100_000) return null;
    const value = JSON.parse(raw) as Partial<AutomationDraft>;
    if (value.version !== 1 || typeof value.tenantId !== "string" || typeof value.userId !== "string"
      || typeof value.batchId !== "string" || typeof value.preparationId !== "string" || !UUID.test(value.preparationId)
      || !Number.isInteger(value.revision) || typeof value.sourceFingerprint !== "string" || !FINGERPRINT.test(value.sourceFingerprint)
      || (value.mode !== "range" && value.mode !== "list")
      || (value.selectionMode !== undefined && value.selectionMode !== "companies" && value.selectionMode !== "advanced")
      || (value.selectedRows !== undefined && (!Array.isArray(value.selectedRows) || value.selectedRows.length > 500
        || value.selectedRows.some((row) => typeof row !== "number" || !Number.isSafeInteger(row) || row < 2)
        || new Set(value.selectedRows).size !== value.selectedRows.length))
      || typeof value.fromRow !== "string" || value.fromRow.length > 12
      || typeof value.toRow !== "string" || value.toRow.length > 12 || typeof value.rowList !== "string" || value.rowList.length > 2500
      || typeof value.updatedAt !== "string" || !(value.pendingAttempt === null || validAttempt(value.pendingAttempt))) return null;
    return { ...value, selectionMode: value.selectionMode ?? "companies", selectedRows: value.selectedRows ?? [] } as AutomationDraft;
  } catch { return null; }
}

export function writeAutomationDraft(storage: Storage | null, key: string, draft: AutomationDraft): boolean {
  if (!storage) return false;
  try { storage.setItem(key, JSON.stringify(draft)); return true; } catch { return false; }
}

export function clearAutomationDraft(storage: Storage | null, key: string): void {
  try { storage?.removeItem(key); } catch { /* Storage is optional for the workflow. */ }
}
