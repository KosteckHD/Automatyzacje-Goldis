import { createHash, randomUUID } from "node:crypto";
import { type OcPolicy, validateOcSnapshotV1 } from "@goldis/core";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { QueryTypes, type Transaction } from "sequelize";
import {
  AutomationRun,
  type BusinessLead,
  ImportBatch,
  LeadResultSnapshot,
  OcPolicyRecord,
  OcSnapshot,
  type ResultSet,
  RunIdentity,
  SourceRow,
  sequelize,
} from "../../infrastructure/database/db";
import { canonicalJsonStringify } from "./canonical-json";
import { exportOcWorkbook } from "./export";
import { decryptPesel } from "./pesel-crypto";
import { validateRunInputSnapshotForExport } from "./run-export-snapshot";

export function leadResultSnapshotChecksum(input: {
  leadId: string;
  tenantId: string;
  runId: string;
  sourceRowId: string;
  sourceOwnerUserId: string;
  referenceDate: string;
  companyFields: Record<string, unknown>;
  peselCiphertext: string;
  peselKeyVersion: number;
  policies: OcPolicy[];
}): string {
  return createHash("sha256").update(canonicalJsonStringify(input), "utf8").digest("hex");
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

/** Saves an immutable, encrypted identity and complete policy list for each positive completed run. */
export async function materializeLeadResultSnapshots(
  lead: BusinessLead,
  resultSet: ResultSet,
  transaction: Transaction,
): Promise<void> {
  if (lead.resultStatus !== "ready" || !resultSet.batchId) return;
  const batch = await ImportBatch.findOne({
    where: { id: resultSet.batchId, tenantId: resultSet.tenantId },
    transaction,
  });
  if (!batch) throw new ConflictException("Nie można zabezpieczyć wyniku bez źródłowego importu");
  const ownerUserId = batch.ownerUserId ?? resultSet.actorUserId;
  const runs = await sequelize.query<{ runId: string }>(
    `SELECT DISTINCT run.id AS "runId"
       FROM lead_run_links link
       JOIN run_submission_groups grp ON grp.group_id = link.group_id AND grp.tenant_id = link.tenant_id
       JOIN automation_runs run ON run.id = grp.run_id
      WHERE link.lead_id = :leadId AND link.tenant_id = :tenantId AND run.status = 'completed'
      ORDER BY run.id`,
    { replacements: { leadId: lead.leadId, tenantId: lead.tenantId }, type: QueryTypes.SELECT, transaction },
  );
  for (const { runId } of runs) {
    const run = await AutomationRun.findByPk(runId, { transaction });
    if (!run || run.status !== "completed") continue;
    const header = await OcSnapshot.findByPk(runId, { transaction });
    if (!header || header.totalCount < 1) continue;
    const already = await LeadResultSnapshot.findOne({
      where: { leadId: lead.leadId, originalRunId: runId },
      transaction,
    });
    if (already) continue;
    const identity = await RunIdentity.findByPk(runId, { transaction });
    if (!identity || identity.sourceRowId !== run.sourceRowId)
      throw new ConflictException("Brak zaszyfrowanej tożsamości wyniku");
    const records = await OcPolicyRecord.findAll({ where: { runId }, order: [["sourceOrdinal", "ASC"]], transaction });
    if (records.length !== header.totalCount) throw new ConflictException("Niepełna lista polis w wyniku");
    const raw = run.inputSnapshot;
    let source: ReturnType<typeof validateRunInputSnapshotForExport>;
    try {
      source = validateRunInputSnapshotForExport(raw, run.sourceRowId);
    } catch {
      throw new ConflictException("Nieprawidłowy zapis wejściowych danych firmy");
    }
    const legacy =
      source.schemaVersion === 1
        ? await SourceRow.findOne({ where: { id: run.sourceRowId, batchId: resultSet.batchId }, transaction })
        : null;
    if (source.schemaVersion === 1 && !legacy) throw new ConflictException("Brak źródłowych danych kontaktowych");
    const companyFields = {
      schemaVersion: 2 as const,
      companyName: source.companyName,
      effectiveRegon: source.effectiveRegon,
      decisionMakerName: source.decisionMakerName,
      mobile: source.schemaVersion === 2 ? source.mobile : legacy!.mobile,
      phone: source.schemaVersion === 2 ? source.phone : legacy!.phone,
      email: source.schemaVersion === 2 ? source.email : legacy!.email,
    };
    if (
      identity.regon !== companyFields.effectiveRegon ||
      comparable(identity.companyName) !== comparable(companyFields.companyName)
    ) {
      throw new ConflictException("Dane firmy nie zgadzają się z wynikiem automatyzacji");
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
      decryptPesel(
        { ciphertext: identity.peselCiphertext, keyVersion: identity.peselKeyVersion },
        { runId, sourceRowId: run.sourceRowId },
      );
    } catch {
      throw new ConflictException("Nie można sprawdzić integralności PESEL lub polis");
    }
    const checksumInput = {
      leadId: lead.leadId,
      tenantId: lead.tenantId,
      runId,
      sourceRowId: run.sourceRowId,
      sourceOwnerUserId: ownerUserId,
      referenceDate: run.referenceDate,
      companyFields,
      peselCiphertext: identity.peselCiphertext,
      peselKeyVersion: identity.peselKeyVersion,
      policies,
    };
    const checksum = leadResultSnapshotChecksum(checksumInput);
    await LeadResultSnapshot.create(
      {
        snapshotId: randomUUID(),
        tenantId: lead.tenantId,
        leadId: lead.leadId,
        originalRunId: runId,
        originalSourceRowId: run.sourceRowId,
        sourceOwnerUserId: ownerUserId,
        referenceDate: run.referenceDate,
        companyFields,
        peselCiphertext: identity.peselCiphertext,
        peselKeyVersion: identity.peselKeyVersion,
        policies,
        policyCount: policies.length,
        checksum,
        schemaVersion: 1,
        createdAt: new Date(),
      },
      { transaction },
    );
  }
}

export async function buildLeadSnapshotWorkbook(input: {
  tenantId: string;
  leadId: string;
  runId: string;
}): Promise<{ fileName: string; bytes: Buffer; policyCount: number; referenceDate: string }> {
  const snapshot = await LeadResultSnapshot.findOne({
    where: {
      tenantId: input.tenantId,
      leadId: input.leadId,
      originalRunId: input.runId,
    },
  });
  if (!snapshot) throw new NotFoundException("Nie znaleziono zachowanego wyniku");
  const checksumInput = {
    leadId: snapshot.leadId,
    tenantId: snapshot.tenantId,
    runId: snapshot.originalRunId,
    sourceRowId: snapshot.originalSourceRowId,
    sourceOwnerUserId: snapshot.sourceOwnerUserId,
    referenceDate: snapshot.referenceDate,
    companyFields: snapshot.companyFields,
    peselCiphertext: snapshot.peselCiphertext,
    peselKeyVersion: snapshot.peselKeyVersion,
    policies: snapshot.policies as unknown as OcPolicy[],
  };
  if (
    snapshot.schemaVersion !== 1 ||
    leadResultSnapshotChecksum(checksumInput) !== snapshot.checksum ||
    snapshot.policyCount !== snapshot.policies.length ||
    snapshot.policyCount < 1
  ) {
    throw new ConflictException("Zachowany wynik nie przeszedł kontroli integralności");
  }
  let pesel: string;
  try {
    pesel = decryptPesel(
      { ciphertext: snapshot.peselCiphertext, keyVersion: snapshot.peselKeyVersion },
      { runId: snapshot.originalRunId, sourceRowId: snapshot.originalSourceRowId },
    );
  } catch {
    throw new ConflictException("Nie można odszyfrować PESEL zachowanego wyniku");
  }
  const company = snapshot.companyFields;
  const exported = await exportOcWorkbook({
    regon: company.effectiveRegon,
    companyName: company.companyName,
    decisionMakerName: company.decisionMakerName,
    mobile: company.mobile,
    phone: company.phone,
    email: company.email,
    pesel,
    referenceDate: snapshot.referenceDate,
    policies: snapshot.policies as unknown as OcPolicy[],
  });
  if (!exported || exported.policyCount < 1) throw new ConflictException("Zachowany wynik nie zawiera aktywnych polis");
  return { ...exported, referenceDate: snapshot.referenceDate };
}
