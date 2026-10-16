import { type OcPolicy, policyMatchesDate, validateOcSnapshotV1 } from "@goldis/core";
import { QueryTypes, Transaction } from "sequelize";
import { AutomationRun, OcPolicyRecord, OcSnapshot, RunIdentity, sequelize } from "../../infrastructure/database/db";
import { exportOcWorkbook } from "./export";
import { decryptPesel } from "./pesel-crypto";
import { type RunInputSnapshotForExport, validateRunInputSnapshotForExport } from "./run-export-snapshot";

export {
  type RunInputSnapshotForExport,
  type RunInputSnapshotForExportV1,
  type RunInputSnapshotForExportV2,
  validateRunInputSnapshotForExport,
} from "./run-export-snapshot";

export class RunExportError extends Error {
  constructor(
    readonly code:
      | "RUN_NOT_FOUND"
      | "RUN_NOT_EXPORT_READY"
      | "EXPORT_DATA_INCOMPLETE"
      | "IDENTITY_CIPHERTEXT_INVALID"
      | "EXPORT_GENERATION_FAILED",
  ) {
    super(code);
    this.name = "RunExportError";
  }
}

async function loadLegacySourceContacts(sourceRowId: string, transaction: Transaction) {
  const rows = await sequelize.query<{ source: Record<string, unknown> }>(
    "SELECT to_jsonb(source) AS source FROM source_rows source WHERE source.id = $1",
    { bind: [sourceRowId], type: QueryTypes.SELECT, transaction },
  );
  const source = rows[0]?.source;
  if (!source) return null;
  return {
    sourceRowId: String(source.id),
    companyName: String(source.company_name ?? ""),
    decisionMakerName: typeof source.decision_maker_name === "string" ? source.decision_maker_name : null,
    effectiveRegon: String(source.effective_regon ?? ""),
    mobile: typeof source.mobile === "string" ? source.mobile : "",
    phone: typeof source.phone === "string" ? source.phone : "",
    email: typeof source.email === "string" ? source.email : "",
  };
}

function toPolicy(record: OcPolicyRecord): OcPolicy {
  return {
    sourceOrdinal: record.sourceOrdinal,
    insuredName: record.insuredName,
    policyTypeAndNumber: record.policyTypeAndNumber,
    contractType: record.contractType,
    insuredClaimCount: record.insuredClaimCount,
    vehicleRegistration: record.vehicleRegistration,
    vehicleGroup: record.vehicleGroup,
    vehicleMake: record.vehicleMake,
    vehicleModel: record.vehicleModel,
    insurer: record.insurer,
    coverageFrom: record.coverageFrom,
    coverageTo: record.coverageTo,
  };
}

function comparable(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");
}

/** Builds an XLSX only from the committed run/source/identity/snapshot rows in PostgreSQL. */
export async function exportRunWorkbook(runId: string): Promise<{
  runId: string;
  fileName: string;
  bytes: Buffer;
  policyCount: number;
} | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    throw new RunExportError("RUN_NOT_FOUND");
  }

  let input: {
    regon: string;
    companyName: string;
    decisionMakerName: string | null;
    mobile: string;
    phone: string;
    email: string;
    pesel: string;
    referenceDate: string;
    policies: OcPolicy[];
  };
  try {
    input = await sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async (transaction) => {
        const run = await AutomationRun.findByPk(runId, { transaction });
        if (!run) throw new RunExportError("RUN_NOT_FOUND");
        if (run.status !== "export_ready") throw new RunExportError("RUN_NOT_EXPORT_READY");
        const [snapshotColumn] = await sequelize.query<{ present: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'automation_runs' AND column_name = 'input_snapshot') AS present`,
          { type: QueryTypes.SELECT, transaction },
        );
        let sourceIdentity: Pick<
          RunInputSnapshotForExport,
          "sourceRowId" | "companyName" | "decisionMakerName" | "effectiveRegon"
        > & { mobile: string; phone: string; email: string };
        if (snapshotColumn?.present) {
          const snapshotRows = await sequelize.query<{ input_snapshot: unknown }>(
            "SELECT input_snapshot FROM automation_runs WHERE id = $1",
            { bind: [runId], type: QueryTypes.SELECT, transaction },
          );
          try {
            const frozen = validateRunInputSnapshotForExport(snapshotRows[0]?.input_snapshot, run.sourceRowId);
            if (frozen.schemaVersion === 2) sourceIdentity = frozen;
            else {
              const source = await loadLegacySourceContacts(run.sourceRowId, transaction);
              if (!source) throw new Error("SOURCE_ROW_UNAVAILABLE_FOR_LEGACY_CONTACTS");
              sourceIdentity = { ...frozen, mobile: source.mobile, phone: source.phone, email: source.email };
            }
          } catch {
            throw new RunExportError("EXPORT_DATA_INCOMPLETE");
          }
        } else if (process.env.GOLDIS_TEST_MODULE_RUNNER === "1") {
          // Historical migration fixtures stop before migration 039; production must always export from the frozen snapshot.
          const source = await loadLegacySourceContacts(run.sourceRowId, transaction);
          if (!source) throw new RunExportError("EXPORT_DATA_INCOMPLETE");
          sourceIdentity = source;
        } else {
          throw new RunExportError("EXPORT_DATA_INCOMPLETE");
        }
        const identity = await RunIdentity.findByPk(runId, { transaction });
        const header = await OcSnapshot.findByPk(runId, { transaction });
        const records = await OcPolicyRecord.findAll({
          where: { runId },
          order: [["sourceOrdinal", "ASC"]],
          transaction,
        });
        if (
          !identity ||
          !header ||
          !sourceIdentity.effectiveRegon ||
          identity.sourceRowId !== sourceIdentity.sourceRowId ||
          identity.regon !== sourceIdentity.effectiveRegon ||
          comparable(identity.companyName) !== comparable(sourceIdentity.companyName) ||
          header.totalCount !== records.length
        ) {
          throw new RunExportError("EXPORT_DATA_INCOMPLETE");
        }

        let pesel: string;
        try {
          pesel = decryptPesel(
            { ciphertext: identity.peselCiphertext, keyVersion: identity.peselKeyVersion },
            { runId, sourceRowId: sourceIdentity.sourceRowId },
          );
        } catch {
          throw new RunExportError("IDENTITY_CIPHERTEXT_INVALID");
        }

        const policies = records.map(toPolicy);
        try {
          validateOcSnapshotV1({
            schemaVersion: 1,
            totalCount: header.totalCount,
            policies,
            capturedAt: header.capturedAt.toISOString(),
            parserVersion: header.parserVersion,
          });
        } catch {
          throw new RunExportError("EXPORT_DATA_INCOMPLETE");
        }

        if (
          sourceIdentity.decisionMakerName &&
          comparable(`${identity.firstName} ${identity.lastName}`) !== comparable(sourceIdentity.decisionMakerName)
        ) {
          throw new RunExportError("EXPORT_DATA_INCOMPLETE");
        }
        return {
          regon: sourceIdentity.effectiveRegon,
          companyName: sourceIdentity.companyName,
          decisionMakerName: sourceIdentity.decisionMakerName,
          mobile: sourceIdentity.mobile,
          phone: sourceIdentity.phone,
          email: sourceIdentity.email,
          pesel,
          referenceDate: run.referenceDate,
          policies,
        };
      },
    );
  } catch (error) {
    if (error instanceof RunExportError) throw error;
    throw new RunExportError("EXPORT_DATA_INCOMPLETE");
  }

  if (input.policies.filter((policy) => policyMatchesDate(policy, input.referenceDate)).length === 0) return null;
  try {
    const exported = await exportOcWorkbook(input);
    if (!exported || exported.policyCount < 1) return null;
    return { runId, ...exported };
  } catch {
    throw new RunExportError("EXPORT_GENERATION_FAILED");
  }
}
