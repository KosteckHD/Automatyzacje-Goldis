export const COMMISSION_ENGINE_SCHEMA_VERSION = 1 as const;
export const COMMISSION_TOOL_ID = "commission-comparison" as const;

export type CommissionSourceTypeV1 = "CRM" | "ASF" | "WARTA";

export type CommissionInputFileV1 = Readonly<{
  sourceType: CommissionSourceTypeV1;
  fileName: string;
  sha256: string;
  contentBase64: string;
}>;

export type CommissionEngineRequestV1 = Readonly<{
  schemaVersion: typeof COMMISSION_ENGINE_SCHEMA_VERSION;
  requestId: string;
  executionId: string;
  attemptToken: string;
  engineVersion: string;
  start: string;
  end: string;
  preset: Readonly<Record<string, unknown>>;
  files: readonly CommissionInputFileV1[];
}>;

export type CommissionDictionaryImportRequestV1 = Readonly<{
  schemaVersion: typeof COMMISSION_ENGINE_SCHEMA_VERSION;
  requestId: string;
  executionId: string;
  attemptToken: string;
  version: string;
  fileName: string;
  sha256: string;
  contentBase64: string;
  previousPreset?: Readonly<Record<string, unknown>>;
}>;

export type CommissionEngineSummaryV1 = Readonly<{
  policies: number;
  missing_policies: number;
  candidate_policies: number;
  matched_policies: number;
  wrong_rate_rows: number;
  wrong_rate_policies: number;
  checked_rate_rows: number;
  unverified_rate_rows: number;
  report_records: number;
  duplicate_files: number;
}>;

export type CommissionEngineResultV1 = Readonly<{
  schema_version: typeof COMMISSION_ENGINE_SCHEMA_VERSION;
  engine_version: string;
  request_id: string;
  execution_id: string;
  attempt_token: string;
  start: string;
  end: string;
  summary: CommissionEngineSummaryV1;
  preset_version: string;
  issues: readonly Readonly<Record<string, unknown>>[];
  unresolved: readonly Readonly<Record<string, unknown>>[];
  details: readonly Readonly<Record<string, unknown>>[];
  policies: readonly Readonly<Record<string, unknown>>[];
  reverse_audit: Readonly<{
    crm_policies_all_dates: number;
    report_record_status_counts: Readonly<Record<string, number>>;
    rows: readonly Readonly<Record<string, unknown>>[];
    note: string;
  }>;
  warnings: readonly string[];
  assumptions: readonly string[];
  [key: string]: unknown;
}>;

export class CommissionEngineContractError extends Error {
  constructor(readonly code: "INVALID_ENGINE_REQUEST" | "INVALID_ENGINE_RESULT" | "INVALID_DICTIONARY_SNAPSHOT") {
    super(code);
    this.name = "CommissionEngineContractError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmpty(value: unknown, max = 160): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function validateCommissionEngineRequestV1(value: unknown): CommissionEngineRequestV1 {
  if (!record(value) || value.schemaVersion !== COMMISSION_ENGINE_SCHEMA_VERSION ||
      !nonEmpty(value.requestId, 80) || !nonEmpty(value.executionId, 80) || !nonEmpty(value.attemptToken, 80) ||
      !nonEmpty(value.engineVersion, 80) || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.start)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(value.end)) || !record(value.preset) || !Array.isArray(value.files) ||
      value.files.length < 1 || value.files.length > 40) throw new CommissionEngineContractError("INVALID_ENGINE_REQUEST");
  for (const file of value.files) {
    if (!record(file) || !["CRM", "ASF", "WARTA"].includes(String(file.sourceType)) ||
        !nonEmpty(file.fileName, 255) || !/^[a-f0-9]{64}$/i.test(String(file.sha256)) ||
        !nonEmpty(file.contentBase64, 25 * 1024 * 1024)) throw new CommissionEngineContractError("INVALID_ENGINE_REQUEST");
  }
  return value as unknown as CommissionEngineRequestV1;
}

export function validateCommissionEngineResultV1(value: unknown): CommissionEngineResultV1 {
  if (!record(value) || value.schema_version !== COMMISSION_ENGINE_SCHEMA_VERSION ||
      !nonEmpty(value.engine_version, 80) || !nonEmpty(value.request_id, 80) ||
      !nonEmpty(value.execution_id, 80) || !nonEmpty(value.attempt_token, 80) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(value.start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.end)) ||
      !nonEmpty(value.preset_version, 80) || !record(value.summary) || !Array.isArray(value.issues) ||
      !Array.isArray(value.unresolved) || !Array.isArray(value.details) || !Array.isArray(value.policies) ||
      !record(value.reverse_audit) || !Array.isArray(value.reverse_audit.rows) ||
      !Number.isSafeInteger(value.reverse_audit.crm_policies_all_dates) ||
      !record(value.reverse_audit.report_record_status_counts) || typeof value.reverse_audit.note !== "string" ||
      !Array.isArray(value.warnings) || value.warnings.some((item) => typeof item !== "string") ||
      !Array.isArray(value.assumptions) || value.assumptions.some((item) => typeof item !== "string")) throw new CommissionEngineContractError("INVALID_ENGINE_RESULT");
  if ([...value.issues, ...value.unresolved, ...value.details, ...value.policies, ...value.reverse_audit.rows].some((item) => !record(item)))
    throw new CommissionEngineContractError("INVALID_ENGINE_RESULT");
  const summary = value.summary as Record<string, unknown>;
  const counters = ["policies", "missing_policies", "candidate_policies", "matched_policies", "wrong_rate_rows",
    "wrong_rate_policies", "checked_rate_rows", "unverified_rate_rows", "report_records", "duplicate_files"];
  if (counters.some((key) => !Number.isSafeInteger(summary[key]) || Number(summary[key]) < 0))
    throw new CommissionEngineContractError("INVALID_ENGINE_RESULT");
  if (Number(value.summary.policies) !== Number(value.summary.missing_policies) +
      Number(value.summary.candidate_policies) + Number(value.summary.matched_policies))
    throw new CommissionEngineContractError("INVALID_ENGINE_RESULT");
  return value as unknown as CommissionEngineResultV1;
}

export function validateCommissionDictionarySnapshotV1(value: unknown): Readonly<Record<string, unknown>> {
  if (!record(value) || !nonEmpty(value.version, 80) || !record(value.client_dictionary) ||
      !Array.isArray(value.client_dictionary.entries) || !record(value.rules) ||
      !Array.isArray(value.confirmed_formats)) throw new CommissionEngineContractError("INVALID_DICTIONARY_SNAPSHOT");
  return value;
}
