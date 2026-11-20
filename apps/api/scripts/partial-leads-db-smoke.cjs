const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
module.exports = async function ({ seed, leadService, tenantId, actorUserId }) {
  const m = require("../dist/infrastructure/database/db");
  const { encryptIdentityForPersistence } = require("../dist/features/results/pesel-crypto");
  const now = new Date(), resultSetId = randomUUID(), submissionId = randomUUID(), leadId = randomUUID();
  const row = await m.SourceRow.findByPk(seed.goldis.sourceRowId);
  const canonicalEntityId = randomUUID();
  await m.CanonicalEntity.create({ canonicalEntityId, tenantId, nipNormalized: randomUUID().replace(/\D/g, "").padEnd(10, "0").slice(0,10), regon: null,
    businessName: row.companyName, createdAt: now, updatedAt: now });
  await m.ResultSet.create({ resultSetId, tenantId, batchId: row.batchId, toolId: "oc-policy-verification",
    actorUserId, sourceType: "run_submission", sourceId: submissionId, referenceDate: "2026-11-19",
    status: "waiting_attention", createdAt: now, updatedAt: now, finishedAt: null });
  await m.RunSubmission.create({ submissionId, importBatchId: row.batchId, tenantId,
    toolId: "oc-policy-verification", actorUserId, idempotencyKey: randomUUID(), requestHash: "a".repeat(64),
    referenceDate: "2026-11-19", resultSetId, status: "waiting_attention", version: 1, createdAt: now, updatedAt: now });
  await m.BusinessLead.create({ leadId, resultSetId, tenantId, toolId: "oc-policy-verification", canonicalEntityId,
    sourceRowIds: [row.id], companyName: row.companyName, nip: null, regon: row.effectiveRegon,
    address: row.address, postalCode: row.postalCode, city: row.city, decisionMakerNames: [], contactData: [],
    resultStatus: "processing", contactStatus: "not_contacted", assignedToUserId: null, assignedByUserId: null,
    assignedAt: null, contactStatusVersion: 1, contactStatusUpdatedAt: null, createdAt: now, updatedAt: now });
  const groupId = randomUUID();
  await m.RunSubmissionGroup.create({ groupId, submissionId, tenantId, canonicalEntityId, leadIdentityKey: "b".repeat(64),
    runId: seed.goldis.runId, admissionState: "accepted", version: 1, createdAt: now, updatedAt: now });
  await m.LeadRunLink.create({ linkId: randomUUID(), tenantId, leadId, groupId, createdAt: now });
  await m.AutomationRun.update({ status: "waiting_for_manual_data", currentStep: "waiting_for_manual_data" },
    { where: { id: seed.goldis.runId } });
  await leadService.publishReadyResults(tenantId);
  assert.equal((await m.BusinessLead.findByPk(leadId)).resultStatus, "processing", "manual company stays unpublished");
  await m.AutomationRun.update({ status: "completed", currentStep: "completed" }, { where: { id: seed.goldis.runId } });
  await assert.rejects(leadService.publishReadyResults(tenantId), /zabezpieczonego wyniku/,
    "completed status without a valid snapshot cannot publish a company");
  assert.equal((await m.BusinessLead.findByPk(leadId)).resultStatus, "processing", "failed publication rolls back");
  const inputSnapshot = { schemaVersion: 1, sourceRowId: row.id, rowNumber: row.rowNumber,
    rowVersion: row.rowVersion, companyName: row.companyName, decisionMakerName: row.decisionMakerName,
    nipRaw: row.nipRaw, address: row.address, postalCode: row.postalCode, city: row.city,
    countyCode: null, regonRaw: row.regonRaw, regon: row.regon, effectiveRegon: row.effectiveRegon, issues: [] };
  await m.sequelize.query("UPDATE automation_runs SET input_snapshot = $1::jsonb WHERE id = $2",
    { bind: [JSON.stringify(inputSnapshot), seed.goldis.runId] });
  process.env.PESEL_ENCRYPTION_ACTIVE_KEY_VERSION = "1";
  process.env.PESEL_ENCRYPTION_KEYS_BASE64 = Buffer.from(JSON.stringify({ "1": Buffer.alloc(32, 7).toString("base64") })).toString("base64");
  await m.RunIdentity.create({ ...encryptIdentityForPersistence({ schemaVersion: 1, sourceRowId: row.id,
    regon: row.effectiveRegon, companyName: row.companyName, firstName: "Test", lastName: "Person",
    pesel: "90010100016", matchMethod: "regon_company_name_decision_maker", adapterVersion: "fixture-v1" }, seed.goldis.runId), createdAt: now });
  await m.OcSnapshot.create({ runId: seed.goldis.runId, totalCount: 1, capturedAt: now, parserVersion: "fixture-v1" });
  await m.OcPolicyRecord.create({ runId: seed.goldis.runId, sourceOrdinal: 1, policyTypeAndNumber: "SYNTHETIC-PARTIAL-1",
    coverageFrom: "2026-01-01", coverageTo: "2099-12-31" });
  // A second group of the same company must finish before publishing the first result.
  const pendingGroupId = randomUUID();
  await m.RunSubmissionGroup.create({ groupId: pendingGroupId, submissionId, tenantId, canonicalEntityId,
    leadIdentityKey: "c".repeat(64), runId: null, admissionState: "pending", version: 1, createdAt: now, updatedAt: now });
  await m.LeadRunLink.create({ linkId: randomUUID(), tenantId, leadId, groupId: pendingGroupId, createdAt: now });
  await leadService.publishReadyResults(tenantId);
  assert.equal((await m.BusinessLead.findByPk(leadId)).resultStatus, "processing", "same-company pending group blocks publication");
  await m.RunSubmissionGroup.update({ admissionState: "accepted", runId: seed.goldis.runId }, { where: { groupId: pendingGroupId } });
  await Promise.all([leadService.publishReadyResults(tenantId), leadService.publishReadyResults(tenantId)]);
  assert.equal((await m.BusinessLead.findByPk(leadId)).resultStatus, "ready");
  assert.equal((await m.ResultSet.findByPk(resultSetId)).status, "waiting_attention", "publication leaves parent operation open");
  assert.equal(await m.LeadResultSnapshot.count({ where: { leadId } }), 1, "concurrent publication creates one snapshot");
  console.log("PARTIAL_LEADS_DB_PASS manualHeld=true snapshotRequired=true sameCompanyPendingHeld=true concurrentIdempotent=true parentRemainsOpen=true");
};
