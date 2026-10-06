import {
  policyMatchesDate,
  validateOcSnapshotV1,
  type OcPolicy,
} from "@goldis/core";
import { Transaction } from "sequelize";
import { AutomationRun, OcPolicyRecord, OcSnapshot, RunIdentity, SourceRow, sequelize } from "./db";
import { exportOcWorkbook } from "./export";
import { decryptPesel } from "./pesel-crypto";

export class RunExportError extends Error {
  constructor(readonly code: "RUN_NOT_FOUND" | "RUN_NOT_EXPORT_READY" | "EXPORT_DATA_INCOMPLETE" | "IDENTITY_CIPHERTEXT_INVALID" | "EXPORT_GENERATION_FAILED") {
    super(code);
    this.name = "RunExportError";
  }
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
    pesel: string;
    referenceDate: string;
    policies: OcPolicy[];
  };
  try {
    input = await sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ }, async (transaction) => {
      const run = await AutomationRun.findByPk(runId, { transaction });
      if (!run) throw new RunExportError("RUN_NOT_FOUND");
      if (run.status !== "export_ready") throw new RunExportError("RUN_NOT_EXPORT_READY");

      const source = await SourceRow.findByPk(run.sourceRowId, { transaction });
      const identity = await RunIdentity.findByPk(runId, { transaction });
      const header = await OcSnapshot.findByPk(runId, { transaction });
      const records = await OcPolicyRecord.findAll({ where: { runId }, order: [["sourceOrdinal", "ASC"]], transaction });
      if (!source || !identity || !header || !source.effectiveRegon
        || identity.sourceRowId !== source.id || identity.regon !== source.effectiveRegon
        || comparable(identity.companyName) !== comparable(source.companyName)
        || header.totalCount !== records.length) {
        throw new RunExportError("EXPORT_DATA_INCOMPLETE");
      }

      let pesel: string;
      try {
        pesel = decryptPesel(
          { ciphertext: identity.peselCiphertext, keyVersion: identity.peselKeyVersion },
          { runId, sourceRowId: source.id },
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

      if (source.decisionMakerName
        && comparable(`${identity.firstName} ${identity.lastName}`) !== comparable(source.decisionMakerName)) {
        throw new RunExportError("EXPORT_DATA_INCOMPLETE");
      }
      return {
        regon: source.effectiveRegon,
        companyName: source.companyName,
        decisionMakerName: source.decisionMakerName,
        pesel,
        referenceDate: run.referenceDate,
        policies,
      };
    });
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
