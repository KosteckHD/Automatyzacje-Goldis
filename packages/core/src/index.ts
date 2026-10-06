export type SourceRow = {
  rowNumber: number;
  companyName: string;
  decisionMakerName: string | null;
  nipRaw: string;
  address: string;
  postalCode: string;
  city: string;
  /** Exact existing option value selected in Compensa; it is never inferred. */
  countyCode?: string | null;
  regonRaw: string;
  regon: string | null;
  effectiveRegon: string | null;
  issues: string[];
};

export type OcPolicy = {
  sourceOrdinal: number | null;
  insuredName: string | null;
  policyTypeAndNumber: string;
  contractType: string | null;
  insuredClaimCount: number | null;
  vehicleRegistration: string | null;
  vehicleGroup: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  insurer: string | null;
  coverageFrom: string | null;
  coverageTo: string | null;
};

export type RunStatus =
  | "queued"
  | "validating"
  | "awaiting_portal_adapter"
  | "pzu_login"
  | "waiting_for_sms"
  | "everest_search"
  | "identity_review"
  | "compensa_login"
  | "compensa_form"
  | "waiting_for_manual_data"
  | "ufg_verification"
  | "reading_oc"
  | "no_matching_policies"
  | "export_ready"
  | "completed"
  | "cancelled"
  | "failed";

const allowedRunTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["validating", "cancelled", "failed"],
  validating: ["awaiting_portal_adapter", "pzu_login", "failed"],
  awaiting_portal_adapter: ["pzu_login", "cancelled", "failed"],
  pzu_login: ["waiting_for_sms", "everest_search", "waiting_for_manual_data", "failed"],
  waiting_for_sms: ["pzu_login", "compensa_login", "waiting_for_manual_data", "cancelled", "failed"],
  everest_search: ["pzu_login", "identity_review", "compensa_login", "waiting_for_manual_data", "failed"],
  identity_review: ["everest_search", "compensa_login", "cancelled", "failed"],
  compensa_login: ["waiting_for_sms", "identity_review", "compensa_form", "ufg_verification", "waiting_for_manual_data", "failed"],
  compensa_form: ["compensa_login", "waiting_for_manual_data", "ufg_verification", "cancelled", "failed"],
  waiting_for_manual_data: ["pzu_login", "everest_search", "compensa_login", "compensa_form", "ufg_verification", "cancelled", "failed"],
  ufg_verification: ["compensa_login", "waiting_for_manual_data", "reading_oc", "failed"],
  reading_oc: ["compensa_login", "ufg_verification", "export_ready", "no_matching_policies", "failed"],
  no_matching_policies: [],
  export_ready: ["completed", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "completed" || status === "no_matching_policies" || status === "cancelled" || status === "failed";
}

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return allowedRunTransitions[from].includes(to);
}

/** Validates a state transition and the artifact invariant before completion. */
export function transitionRunStatus(from: RunStatus, to: RunStatus, options: { artifactId?: string } = {}): RunStatus {
  if (!canTransitionRunStatus(from, to)) throw new Error("RUN_STATUS_TRANSITION_INVALID");
  if (to === "completed" && (!options.artifactId || !uuidPattern.test(options.artifactId))) {
    throw new Error("RUN_COMPLETED_ARTIFACT_REQUIRED");
  }
  return to;
}

/** Stable message contract passed between the API and the worker. */
export type RunInputV1 = Readonly<{
  schemaVersion: 1;
  runId: string;
  sourceRowId: string;
  batchId: string;
  referenceDate: string;
  toolId: "oc-policy-verification";
}>;

export type IdentityMatchMethodV1 = "regon_company_name_decision_maker" | "unique_business_identity";

/** Minimum identity facts required before the worker may open the Compensa flow. */
export type IdentityMatchV1 = Readonly<{
  schemaVersion: 1;
  sourceRowId: string;
  regon: string;
  companyName: string;
  firstName: string;
  lastName: string;
  pesel: string;
  matchMethod: IdentityMatchMethodV1;
  adapterVersion: string;
}>;

export type OcSnapshotV1 = Readonly<{
  schemaVersion: 1;
  totalCount: number;
  policies: readonly OcPolicy[];
  capturedAt: string;
  parserVersion: string;
}>;

export type RunResultV1 =
  | Readonly<{
      schemaVersion: 1;
      runId: string;
      referenceDate: string;
      outcome: "export_ready";
      totalOcCount: number;
      currentOcCount: number;
      artifactId: null;
    }>
  | Readonly<{
      schemaVersion: 1;
      runId: string;
      referenceDate: string;
      outcome: "completed";
      totalOcCount: number;
      currentOcCount: number;
      artifactId: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      runId: string;
      referenceDate: string;
      outcome: "no_matching_policies";
      totalOcCount: number;
      currentOcCount: 0;
      artifactId: null;
    }>;

export type AutomationErrorCodeV1 =
  | "INPUT_INVALID"
  | "IDENTITY_AMBIGUOUS"
  | "IDENTITY_NOT_FOUND"
  | "MFA_REQUIRED"
  | "MANUAL_DATA_REQUIRED"
  | "PORTAL_FAILURE"
  | "PORTAL_SESSION_EXPIRED"
  | "PORTAL_SCHEMA_CHANGED"
  | "UFG_INCOMPLETE"
  | "COVERAGE_DATE_INVALID"
  | "EXPORT_FAILED"
  | "OFFER_SAVE_UNCONFIRMED"
  | "SMS_DELIVERY_UNCERTAIN"
  | "SMS_ATTEMPT_LIMIT"
  | "SMS_RETRY_REQUIRED"
  | "SMS_RETRY_QUEUED"
  | "REVIEW_RETRY_QUEUED";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && isoDatePattern.test(value) && parsePolishDate(value) === value;
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value));
}

function isOptionalString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOcPolicy(value: unknown): value is OcPolicy {
  if (!isRecord(value)) return false;
  const optionalFields = [
    value.insuredName,
    value.contractType,
    value.vehicleRegistration,
    value.vehicleGroup,
    value.vehicleMake,
    value.vehicleModel,
    value.insurer,
    value.coverageFrom,
  ];
  return Number.isInteger(value.sourceOrdinal)
    && Number(value.sourceOrdinal) > 0
    && isNonEmptyString(value.policyTypeAndNumber)
    && optionalFields.every(isOptionalString)
    && (value.insuredClaimCount === null || (Number.isSafeInteger(value.insuredClaimCount) && Number(value.insuredClaimCount) >= 0))
    && (value.coverageFrom === null || isIsoDate(value.coverageFrom))
    && isIsoDate(value.coverageTo);
}

/** Validates an untrusted API/queue payload without logging its contents. */
export function validateRunInputV1(value: unknown): RunInputV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.runId !== "string" || !uuidPattern.test(value.runId)
    || typeof value.sourceRowId !== "string" || !uuidPattern.test(value.sourceRowId)
    || typeof value.batchId !== "string" || !uuidPattern.test(value.batchId)
    || !isIsoDate(value.referenceDate)
    || value.toolId !== "oc-policy-verification") {
    throw new Error("CONTRACT_RUN_INPUT_INVALID");
  }
  return value as unknown as RunInputV1;
}

/** Checksum and encoded Gregorian birth date, including all supported century offsets. */
export function isValidPesel(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{11}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const checksum = digits.slice(0, 10).reduce((sum, digit, index) => sum + digit * [1, 3, 7, 9, 1, 3, 7, 9, 1, 3][index], 0);
  if ((10 - checksum % 10) % 10 !== digits[10]) return false;
  const encodedMonth = Number(value.slice(2, 4));
  const century = [{ offset: 0, year: 1900 }, { offset: 20, year: 2000 }, { offset: 40, year: 2100 }, { offset: 60, year: 2200 }, { offset: 80, year: 1800 }]
    .find(({ offset }) => encodedMonth > offset && encodedMonth <= offset + 12);
  if (!century) return false;
  const year = century.year + Number(value.slice(0, 2));
  const month = encodedMonth - century.offset;
  const day = Number(value.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day));
  return day > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Ensures the person and business match before any portal data moves to Compensa. */
export function validateIdentityMatchV1(value: unknown): IdentityMatchV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.sourceRowId !== "string" || !uuidPattern.test(value.sourceRowId)
    || typeof value.regon !== "string" || !/^\d{9}(?:\d{5})?$/.test(value.regon)
    || !isNonEmptyString(value.companyName)
    || !isNonEmptyString(value.firstName)
    || !isNonEmptyString(value.lastName)
    || !isValidPesel(value.pesel)
    || (value.matchMethod !== "regon_company_name_decision_maker" && value.matchMethod !== "unique_business_identity")
    || !isNonEmptyString(value.adapterVersion)) {
    throw new Error("CONTRACT_IDENTITY_MATCH_INVALID");
  }
  return value as unknown as IdentityMatchV1;
}

/** Rejects partial, reordered, malformed, or duplicate UFG table rows. */
export function validateOcSnapshotV1(value: unknown): OcSnapshotV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Number.isInteger(value.totalCount) || Number(value.totalCount) < 0
    || !Array.isArray(value.policies)
    || value.policies.length !== value.totalCount
    || !isIsoDateTime(value.capturedAt)
    || !isNonEmptyString(value.parserVersion)
    || !value.policies.every(isOcPolicy)) {
    throw new Error("CONTRACT_OC_SNAPSHOT_INVALID");
  }
  const positions = value.policies.map((policy) => (policy as OcPolicy).sourceOrdinal);
  if (new Set(positions).size !== positions.length) throw new Error("CONTRACT_OC_SNAPSHOT_DUPLICATE_POSITION");
  return value as unknown as OcSnapshotV1;
}

/** Enforces result invariants shared by persistence, API responses, and XLSX export. */
export function validateRunResultV1(value: unknown): RunResultV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.runId !== "string" || !uuidPattern.test(value.runId)
    || !isIsoDate(value.referenceDate)
    || !Number.isInteger(value.totalOcCount) || Number(value.totalOcCount) < 0
    || !Number.isInteger(value.currentOcCount) || Number(value.currentOcCount) < 0
    || Number(value.currentOcCount) > Number(value.totalOcCount)) {
    throw new Error("CONTRACT_RUN_RESULT_INVALID");
  }
  if (value.outcome === "completed") {
    if (Number(value.currentOcCount) < 1 || typeof value.artifactId !== "string" || !uuidPattern.test(value.artifactId)) {
      throw new Error("CONTRACT_RUN_RESULT_INVALID");
    }
  } else if (value.outcome === "export_ready") {
    if (Number(value.currentOcCount) < 1 || value.artifactId !== null) throw new Error("CONTRACT_RUN_RESULT_INVALID");
  } else if (value.outcome === "no_matching_policies") {
    if (value.currentOcCount !== 0 || value.artifactId !== null) throw new Error("CONTRACT_RUN_RESULT_INVALID");
  } else {
    throw new Error("CONTRACT_RUN_RESULT_INVALID");
  }
  return value as unknown as RunResultV1;
}

export function normalizeRegon(value: unknown): { raw: string; normalized: string | null; issues: string[] } {
  if (value === null || value === undefined || value === "") {
    return { raw: "", normalized: null, issues: ["REGON_EMPTY"] };
  }
  let raw: string;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      return { raw: String(value), normalized: null, issues: ["REGON_INVALID_NUMBER"] };
    }
    raw = String(value);
  } else if (typeof value === "string") {
    raw = value.trim();
  } else {
    return { raw: String(value), normalized: null, issues: ["REGON_INVALID_TYPE"] };
  }
  if (!raw) return { raw: "", normalized: null, issues: ["REGON_EMPTY"] };
  if (!/^\d+$/.test(raw)) return { raw, normalized: null, issues: ["REGON_NON_DIGIT"] };
  if (raw.length === 8 || raw.length === 13) {
    return { raw, normalized: null, issues: ["REGON_POSSIBLE_LOST_LEADING_ZERO"] };
  }
  if (raw.length !== 9 && raw.length !== 14) {
    return { raw, normalized: null, issues: ["REGON_INVALID_LENGTH"] };
  }
  return { raw, normalized: raw, issues: [] };
}

export type EffectiveRegonSource = "approved_correction" | "import" | "none";

/** Derives the operational REGON without changing the imported source value. */
export function deriveEffectiveRegon(input: {
  regonRaw: string;
  importedRegon: string | null;
  approvedCorrection?: string | null;
}): { regonRaw: string; effectiveRegon: string | null; source: EffectiveRegonSource } {
  if (input.approvedCorrection !== undefined && input.approvedCorrection !== null) {
    if (!/^\d{9}(?:\d{5})?$/.test(input.approvedCorrection)) {
      throw new Error("EFFECTIVE_REGON_CORRECTION_INVALID");
    }
    return { regonRaw: input.regonRaw, effectiveRegon: input.approvedCorrection, source: "approved_correction" };
  }
  if (input.importedRegon === null) {
    return { regonRaw: input.regonRaw, effectiveRegon: null, source: "none" };
  }
  if (!/^\d{9}(?:\d{5})?$/.test(input.importedRegon)) {
    throw new Error("EFFECTIVE_REGON_IMPORTED_INVALID");
  }
  return { regonRaw: input.regonRaw, effectiveRegon: input.importedRegon, source: "import" };
}

/** Checks NIP without guessing digits lost by spreadsheet numeric formatting. */
export function normalizeNip(value: unknown): { raw: string; normalized: string | null; issues: string[] } {
  if (value === null || value === undefined || value === "") return { raw: "", normalized: null, issues: ["NIP_EMPTY"] };
  if (typeof value !== "string" && typeof value !== "number") return { raw: String(value), normalized: null, issues: ["NIP_INVALID_TYPE"] };
  const raw = String(value).trim();
  if (!raw) return { raw, normalized: null, issues: ["NIP_EMPTY"] };
  const normalized = raw.replace(/[\s-]/g, "");
  if (!/^\d{10}$/.test(normalized)) return { raw, normalized: null, issues: ["NIP_INVALID_FORMAT"] };
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const check = weights.reduce((sum, weight, index) => sum + weight * Number(normalized[index]), 0) % 11;
  if (check === 10 || check !== Number(normalized[9])) return { raw, normalized: null, issues: ["NIP_CHECKSUM_INVALID"] };
  return { raw, normalized, issues: [] };
}

export type RegonEnrichmentEligibility =
  | Readonly<{ eligible: true; nipNormalized: string }>
  | Readonly<{
      eligible: false;
      reasonCode: "REGON_PRESENT" | "REGON_REQUIRES_REVIEW" | "REGON_STATE_INCONSISTENT" | "NIP_INVALID";
      issueCode: string | null;
    }>;

/** Allows NIP lookup only for an actually empty REGON and a checksum-valid NIP. */
export function assessRegonEnrichmentEligibility(input: {
  regonRaw: string;
  effectiveRegon: string | null;
  nipRaw: string;
}): RegonEnrichmentEligibility {
  if (input.effectiveRegon !== null) {
    return { eligible: false, reasonCode: "REGON_PRESENT", issueCode: null };
  }
  const regon = normalizeRegon(input.regonRaw);
  if (regon.normalized !== null) {
    return { eligible: false, reasonCode: "REGON_STATE_INCONSISTENT", issueCode: null };
  }
  if (!regon.issues.includes("REGON_EMPTY")) {
    return { eligible: false, reasonCode: "REGON_REQUIRES_REVIEW", issueCode: regon.issues[0] ?? null };
  }
  const nip = normalizeNip(input.nipRaw);
  if (!nip.normalized) {
    return { eligible: false, reasonCode: "NIP_INVALID", issueCode: nip.issues[0] ?? "NIP_INVALID_FORMAT" };
  }
  return { eligible: true, nipNormalized: nip.normalized };
}

export function parsePolishDate(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const iso = trimmed.includes(".") ? `${match[3]}-${match[2]}-${match[1]}` : trimmed;
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return iso;
}

export function todayInWarsaw(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function policyMatchesDate(policy: OcPolicy, referenceDate: string): boolean {
  const end = parsePolishDate(policy.coverageTo);
  if (!end) throw new Error("COVERAGE_TO_INVALID");
  return end >= referenceDate;
}

function safeFilePart(value: string, limit: number): string {
  return value.normalize("NFKC").replace(/(?<!\d)\d{11}(?!\d)/g, "ukryto").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, limit).replace(/[. ]+$/g, "");
}

export function exportFileName(regon: string, companyName: string, decisionMakerName?: string | null): string {
  const safeCompany = safeFilePart(companyName, 100);
  const safePerson = decisionMakerName ? safeFilePart(decisionMakerName, 80) : "";
  if (!safeCompany) throw new Error("EXPORT_NAME_INCOMPLETE");
  return `${regon}_${safeCompany}${safePerson ? `_${safePerson}` : ""}.xlsx`;
}

export {
  decryptPesel,
  encryptIdentityForPersistence,
  encryptPesel,
  peselErrorCodeForLog,
  PeselEncryptionError,
  type EncryptedPeselV1,
  type EncryptedRunIdentityRecord,
  type PeselEncryptionContext,
} from "./pesel-crypto";
