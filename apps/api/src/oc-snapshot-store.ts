import { randomUUID } from "node:crypto";
import {
  validateIdentityMatchV1,
  validateOcSnapshotV1,
  type IdentityMatchV1,
  type OcPolicy,
  type OcSnapshotV1,
} from "@goldis/core";
import { AutomationRun, OcPolicyRecord, OcSnapshot, RunIdentity, SourceRow, sequelize } from "./db";
import { decryptPesel, encryptIdentityForPersistence, peselErrorCodeForLog } from "./pesel-crypto";
import { assertWorkerExecution, WorkerExecutionConflict, type WorkerExecutionFence } from "./worker-execution";

export class SnapshotPersistenceError extends Error {
  constructor(readonly code: "SNAPSHOT_INPUT_INVALID" | "RUN_NOT_FOUND" | "IDENTITY_RUN_MISMATCH" | "SNAPSHOT_CONFLICT" | "IDENTITY_CIPHERTEXT_INVALID" | "SNAPSHOT_WRITE_FAILED") {
    super(code);
    this.name = "SnapshotPersistenceError";
  }
}

export type SnapshotStoreOptions = Readonly<{
  execution?: WorkerExecutionFence;
  environment?: Readonly<Record<string, string | undefined>>;
  /** Test seam used only to prove transaction rollback after an actual partial DB write. */
  afterPolicyChunk?: (insertedCount: number) => void | Promise<void>;
}>;

const policyChunkSize = 50;
const policyFields: readonly (keyof OcPolicy)[] = [
  "sourceOrdinal", "insuredName", "policyTypeAndNumber", "contractType", "insuredClaimCount",
  "vehicleRegistration", "vehicleGroup", "vehicleMake", "vehicleModel", "insurer", "coverageFrom", "coverageTo",
];

function comparable(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");
}

function sameIdentity(stored: RunIdentity, identity: IdentityMatchV1, runId: string, environment: SnapshotStoreOptions["environment"]): boolean {
  let pesel: string;
  try {
    pesel = decryptPesel(
      { ciphertext: stored.peselCiphertext, keyVersion: stored.peselKeyVersion },
      { runId, sourceRowId: identity.sourceRowId },
      environment,
    );
  } catch (error) {
    throw new SnapshotPersistenceError(peselErrorCodeForLog(error) === "PESEL_DECRYPT_FAILED"
      ? "IDENTITY_CIPHERTEXT_INVALID"
      : "SNAPSHOT_WRITE_FAILED");
  }
  return stored.sourceRowId === identity.sourceRowId
    && stored.regon === identity.regon
    && comparable(stored.companyName) === comparable(identity.companyName)
    && comparable(stored.firstName) === comparable(identity.firstName)
    && comparable(stored.lastName) === comparable(identity.lastName)
    && pesel === identity.pesel
    && stored.matchMethod === identity.matchMethod
    && stored.adapterVersion === identity.adapterVersion;
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

function samePolicy(left: OcPolicy, right: OcPolicy): boolean {
  return policyFields.every((field) => left[field] === right[field]);
}

function sameSnapshot(
  storedHeader: OcSnapshot,
  storedPolicies: readonly OcPolicyRecord[],
  snapshot: OcSnapshotV1,
): boolean {
  if (storedHeader.totalCount !== snapshot.totalCount || storedHeader.parserVersion !== snapshot.parserVersion
    || storedPolicies.length !== snapshot.policies.length) return false;
  const storedByOrdinal = new Map(storedPolicies.map((record) => [record.sourceOrdinal, toPolicy(record)]));
  return snapshot.policies.every((policy) => {
    const existing = storedByOrdinal.get(policy.sourceOrdinal!);
    return existing !== undefined && samePolicy(existing, policy);
  });
}

/** Persists encrypted identity, the UFG summary and every OC row as one all-or-nothing checkpoint. */
export async function persistOcSnapshot(
  runId: string,
  identityInput: IdentityMatchV1,
  snapshotInput: OcSnapshotV1,
  options: SnapshotStoreOptions = {},
): Promise<void> {
  let identity: IdentityMatchV1;
  let snapshot: OcSnapshotV1;
  try {
    identity = validateIdentityMatchV1(identityInput);
    snapshot = validateOcSnapshotV1(snapshotInput);
  } catch {
    throw new SnapshotPersistenceError("SNAPSHOT_INPUT_INVALID");
  }
  const encryptedIdentity = encryptIdentityForPersistence(identity, runId, options.environment);

  try {
    await sequelize.transaction(async (transaction) => {
      const run = await AutomationRun.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!run) throw new SnapshotPersistenceError("RUN_NOT_FOUND");
      assertWorkerExecution(run, options.execution, ["reading_oc", "export_ready", "completed", "no_matching_policies"]);
      const source = await SourceRow.findByPk(run.sourceRowId, { transaction });
      if (!source || run.sourceRowId !== identity.sourceRowId || source.effectiveRegon !== identity.regon
        || comparable(source.companyName) !== comparable(identity.companyName)
        || (source.decisionMakerName !== null
          && comparable(`${identity.firstName} ${identity.lastName}`) !== comparable(source.decisionMakerName))) {
        throw new SnapshotPersistenceError("IDENTITY_RUN_MISMATCH");
      }

      const storedIdentity = await RunIdentity.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
      if (storedIdentity) {
        if (!sameIdentity(storedIdentity, identity, runId, options.environment)) {
          throw new SnapshotPersistenceError("SNAPSHOT_CONFLICT");
        }
      } else {
        await RunIdentity.create({ ...encryptedIdentity, createdAt: new Date(snapshot.capturedAt) }, { transaction });
      }

      const storedHeader = await OcSnapshot.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
      const storedPolicies = await OcPolicyRecord.findAll({
        where: { runId },
        order: [["sourceOrdinal", "ASC"]],
        transaction,
        ...(storedHeader ? { lock: transaction.LOCK.UPDATE } : {}),
      });
      if (storedHeader) {
        if (!sameSnapshot(storedHeader, storedPolicies, snapshot)) throw new SnapshotPersistenceError("SNAPSHOT_CONFLICT");
        assertWorkerExecution(run, options.execution, ["reading_oc", "export_ready", "completed", "no_matching_policies"]);
        return;
      }
      if (storedPolicies.length > 0) throw new SnapshotPersistenceError("SNAPSHOT_CONFLICT");

      await OcSnapshot.create({
        runId,
        totalCount: snapshot.totalCount,
        capturedAt: new Date(snapshot.capturedAt),
        parserVersion: snapshot.parserVersion,
      }, { transaction });

      for (let offset = 0; offset < snapshot.policies.length; offset += policyChunkSize) {
        const chunk = snapshot.policies.slice(offset, offset + policyChunkSize);
        await OcPolicyRecord.bulkCreate(chunk.map((policy) => ({ ...policy, id: randomUUID(), runId })), { transaction });
        await options.afterPolicyChunk?.(offset + chunk.length);
      }
      assertWorkerExecution(run, options.execution, ["reading_oc"]);
    });
  } catch (error) {
    if (error instanceof SnapshotPersistenceError || error instanceof WorkerExecutionConflict) throw error;
    throw new SnapshotPersistenceError("SNAPSHOT_WRITE_FAILED");
  }
}
