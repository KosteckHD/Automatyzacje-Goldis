"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function signedRequest(input) {
  const csrf = randomUUID() + randomUUID();
  const payload = Buffer.from(JSON.stringify({
    v: 2, sessionId: input.sessionId, exp: Date.now() + 60_000,
    userId: input.userId, tenantId: input.tenantId, csrf,
  })).toString("base64url");
  const signature = require("node:crypto").createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
  return {
    ip: "203.0.113.32", socket: { remoteAddress: "203.0.113.32" },
    headers: { cookie: `goldis_session=${payload}.${signature}; goldis_csrf=${csrf}`, "x-csrf-token": csrf },
    goldisPrincipal: {
      exp: Date.now() + 60_000, csrf, userId: input.userId, tenantId: input.tenantId,
      actorRef: input.userId, sessionId: input.sessionId, version: 2, role: input.role,
    },
  };
}

function inputSnapshot(input) {
  return {
    schemaVersion: 1,
    sourceRowId: input.sourceRowId,
    rowNumber: input.rowNumber,
    rowVersion: 1,
    companyName: input.companyName,
    decisionMakerName: null,
    nipRaw: input.nipRaw,
    address: input.address,
    postalCode: input.postalCode,
    city: input.city,
    countyCode: null,
    regonRaw: input.regonRaw,
    regon: input.regon,
    effectiveRegon: input.effectiveRegon,
    issues: [],
  };
}

function createImportService() {
  const { ImportService } = require("../dist/features/imports/import.service");
  const { sequelize: database } = require("../dist/infrastructure/database/db");
  const { AuditRepository } = require("../dist/features/audit/audit.repository");
  const { AuditService } = require("../dist/features/audit/audit.service");
  const { ImportsRepository } = require("../dist/features/imports/imports.repository");
  return new ImportService(database, new ImportsRepository(database), new AuditService(new AuditRepository()));
}

module.exports = async function verifyDeletionJobsDatabase(seed) {
  const models = require("../dist/infrastructure/database/db");
  const { recordAuditEvent } = require("../dist/features/audit/public");
  const audit = { record: recordAuditEvent };
  const { hashPassword } = require("../dist/features/auth/index");
  const { DeletionStepUpController } = require("../dist/features/deletions/deletion-step-up.controller");
  const { DeletionStepUpRepository } = require("../dist/features/deletions/deletion-step-up.repository");
  const { DeletionStepUpService } = require("../dist/features/deletions/deletion-step-up.service");
  const { DeletionController } = require("../dist/features/deletions/public");
  const { DeletionsPreviewRepository } = require("../dist/features/deletions/deletions.repository");
  const { DeletionsService } = require("../dist/features/deletions/deletions.service");
  const { DeletionJobController, DeletionJobRunner } = require("../dist/features/deletions/public");
  const { ArtifactDownloadError } = require("../dist/features/results/artifact-download.contract");
  const { ArtifactDownloadRepository } = require("../dist/features/results/artifact-download.repository");
  const { ArtifactDownloadService } = require("../dist/features/results/artifact-download.service");
  const getVerifiedArtifactDownload = (runId) => new ArtifactDownloadService(new ArtifactDownloadRepository()).download(runId);
    const { finalizeRunExport, ExportFinalizeError } = require("../dist/features/results/export-finalization.service");
  const { isResourceTombstoned } = require("../dist/contracts/deletion-barrier");
  const { resolvePermissionResource } = require("../dist/features/authorization/index");
  const { HistoryService } = require("../dist/features/reports/history.service");
  const { leadResultSnapshotChecksum } = require("../dist/features/results/lead-result-snapshots");
  const { readDeletionJournal } = require("../dist/features/deletions/deletion-journal");
  const { QueryTypes } = require("sequelize");
  const previousSecret = process.env.SESSION_SECRET;
  const previousArtifactRoot = process.env.API_EXPORT_DIR;
  const previousDeletionJournalDir = process.env.GOLDIS_DELETION_JOURNAL_DIR;
  const previousRestoreMaintenance = process.env.GOLDIS_RESTORE_MAINTENANCE;
  process.env.SESSION_SECRET = "synthetic-deletion-jobs-session-secret-43";
  const tenantId = seed.goldisTenantId;
  const actorId = randomUUID();
  const retainedAssigneeId = randomUUID();
  const sessionId = randomUUID();
  const batchId = randomUUID();
  const importDeleteBatchId = randomUUID();
  const operatorOwnedBatchId = randomUUID();
  const restoreBatchId = randomUUID();
  const restoreFollowupBatchId = randomUUID();
  const restoreFailingBatchId = randomUUID();
  let retainedLeadId = null;
  let retainedResultSetId = null;
  let retainedEntityId = null;
  const sourceRowId = randomUUID();
  const runId = randomUUID();
  const artifactOnlyRunId = randomUUID();
  const artifactOnlyId = randomUUID();
  const now = new Date();
  const root = await mkdtemp(path.join(os.tmpdir(), "goldis-deletion-jobs-"));
  const artifactsDirectory = path.join(root, "artifacts");
  await mkdir(artifactsDirectory, { recursive: true });
  process.env.API_EXPORT_DIR = root;
  process.env.GOLDIS_DELETION_JOURNAL_DIR = path.join(root, "deletion-journal");
  const fileBytes = Buffer.from("synthetic private workbook");
  const artifacts = [
    { id: randomUUID(), key: null, bytes: fileBytes },
    { id: randomUUID(), key: null, bytes: Buffer.from("already missing workbook") },
  ].map((artifact) => ({ ...artifact, key: `artifacts/${artifact.id}.xlsx` }));
  let batchCreated = false;
  let importDeleteBatchCreated = false;
  let operatorOwnedBatchCreated = false;
  let actorCreated = false;
  let retainedAssigneeCreated = false;
  try {
    const username = `Synthetic.Deletion.Job.${randomUUID().slice(0, 8)}`;
    await models.User.create({
      userId: actorId, username, usernameNormalized: username.toLowerCase(), passwordHash: await hashPassword("Synthetic-only Job Deletion Password!"),
      status: "active", createdAt: now, updatedAt: now, lastLoginAt: null, mustChangePassword: false, credentialRevision: 1,
    });
    actorCreated = true;
    await models.TenantMembership.create({ tenantId, userId: actorId, role: "admin", status: "active", createdAt: now, updatedAt: now });
    const assigneeName = `Synthetic.Retention.${randomUUID().slice(0, 8)}`;
    await models.User.create({
      userId: retainedAssigneeId, username: assigneeName, usernameNormalized: assigneeName.toLowerCase(),
      passwordHash: await hashPassword("Synthetic-only Retained Lead Password!"), status: "active", createdAt: now,
      updatedAt: now, lastLoginAt: null, mustChangePassword: false, credentialRevision: 1,
    });
    await models.TenantMembership.create({ tenantId, userId: retainedAssigneeId, role: "operator", status: "active", createdAt: now, updatedAt: now });
    retainedAssigneeCreated = true;
    await models.UserSession.create({
      sessionId, tenantId, userId: actorId, credentialRevision: 1, createdAt: now,
      lastSeenAt: now, lastActivityAt: now, expiresAt: new Date(now.getTime() + 60 * 60_000),
      revokedAt: null, revokedBy: null, revokeReason: null, ipHash: null, browserLabel: "Synthetic fixture",
    });
    const retainedAssigneeSessionId = randomUUID();
    await models.UserSession.create({
      sessionId: retainedAssigneeSessionId, tenantId, userId: retainedAssigneeId, credentialRevision: 1, createdAt: now,
      lastSeenAt: now, lastActivityAt: now, expiresAt: new Date(now.getTime() + 60 * 60_000),
      revokedAt: null, revokedBy: null, revokeReason: null, ipHash: null, browserLabel: "Synthetic operator fixture",
    });
    await models.ImportBatch.create({
      id: batchId, tenantId, ownerUserId: actorId, toolId: "oc-policy-verification",
      fileName: "synthetic-deletion-job.xlsx", sha256: "d".repeat(64), totalRows: 1, invalidRows: 0, createdAt: now,
    });
    batchCreated = true;
    await models.SourceRow.create({
      id: sourceRowId, batchId, rowNumber: 19001, companyName: "Synthetic Deletion Company",
      decisionMakerName: null, nipRaw: "0000000000", address: "Test 1", postalCode: "00-000", city: "Test City",
      regonRaw: "012345678", regon: "012345678", effectiveRegon: "012345678", rowVersion: 1, issues: [],
    });
    await models.AutomationRun.create({
      id: runId, batchId, sourceRowId, rowNumber: 19001, toolId: "oc-policy-verification",
      status: "completed", currentStep: "completed", referenceDate: "2026-09-30", errorCode: null,
      inputSnapshot: inputSnapshot({ sourceRowId, rowNumber: 19001, companyName: "Synthetic Deletion Company",
        nipRaw: "0000000000", address: "Test 1", postalCode: "00-000", city: "Test City",
        regonRaw: "012345678", regon: "012345678", effectiveRegon: "012345678" }),
      createdAt: now, updatedAt: now, finishedAt: now,
    });
    await models.RunSourceRow.create({ runId, sourceRowId, rowNumber: 19001, isPrimary: true, createdAt: now });
    for (const [index, artifact] of artifacts.entries()) {
      if (index === 0) await writeFile(path.join(artifactsDirectory, `${artifact.id}.xlsx`), artifact.bytes, { flag: "wx" });
      await models.ExportArtifact.create({
        artifactId: artifact.id, runId, fileName: `synthetic-${index}.xlsx`, storageKey: artifact.key,
        sha256: createHash("sha256").update(artifact.bytes).digest("hex"), policyCount: 1,
        state: "ready", createdAt: now, readyAt: now,
      });
    }
    const artifactOnlyBytes = Buffer.from("standalone deletion workbook");
    await writeFile(path.join(artifactsDirectory, `${artifactOnlyId}.xlsx`), artifactOnlyBytes, { flag: "wx" });
    await models.AutomationRun.create({
      id: artifactOnlyRunId, batchId, sourceRowId, rowNumber: 19001, toolId: "oc-policy-verification",
      status: "completed", currentStep: "completed", referenceDate: "2026-09-30", errorCode: null,
      inputSnapshot: inputSnapshot({ sourceRowId, rowNumber: 19001, companyName: "Synthetic Deletion Company",
        nipRaw: "0000000000", address: "Test 1", postalCode: "00-000", city: "Test City",
        regonRaw: "012345678", regon: "012345678", effectiveRegon: "012345678" }),
      createdAt: now, updatedAt: now, finishedAt: now,
    });
    await models.RunSourceRow.create({ runId: artifactOnlyRunId, sourceRowId, rowNumber: 19001, isPrimary: true, createdAt: now });
    await models.ExportArtifact.create({
      artifactId: artifactOnlyId, runId: artifactOnlyRunId, fileName: "synthetic-standalone.xlsx",
      storageKey: `artifacts/${artifactOnlyId}.xlsx`, sha256: createHash("sha256").update(artifactOnlyBytes).digest("hex"),
      policyCount: 1, state: "ready", createdAt: now, readyAt: now,
    });

    const adminRequest = signedRequest({ userId: actorId, tenantId, sessionId, role: "admin" });
    const operatorRequest = signedRequest({ userId: retainedAssigneeId, tenantId, sessionId: retainedAssigneeSessionId, role: "operator" });
    const limiter = {
      async consumeReauthAttempt() { return { allowed: true, retryAfterSeconds: 0, generation: "synthetic" }; },
      async recordReauthFailure() {}, async clearReauth() {},
    };
    const stepUp = new DeletionStepUpController(
      limiter,
      new DeletionStepUpService(new DeletionStepUpRepository(audit)),
    );
    const deletionController = new DeletionController(new DeletionsService(new DeletionsPreviewRepository()));
    const jobController = new DeletionJobController();
    const artifactPreview = await deletionController.preview({ targetType: "artifact", targetId: artifactOnlyId }, adminRequest);
    assert.deepEqual(artifactPreview.summary.blockers, [], "gotowy plik może być usunięty bez kasowania runu");
    const artifactStepUp = await stepUp.requestStepUp({
      currentPassword: "Synthetic-only Job Deletion Password!", previewId: artifactPreview.previewId,
    }, adminRequest, { setHeader() {} });
    const artifactRequest = {
      previewId: artifactPreview.previewId, stepUpToken: artifactStepUp.stepUpToken,
      idempotencyKey: `synthetic-delete-artifact-${randomUUID()}`,
    };
    const blockedJournalPath = path.join(root, "not-a-directory");
    await writeFile(blockedJournalPath, "synthetic blocker");
    process.env.GOLDIS_DELETION_JOURNAL_DIR = blockedJournalPath;
    await assert.rejects(jobController.create(adminRequest, artifactRequest),
      (error) => error && error.code === "DELETION_JOURNAL_WRITE_FAILED");
    const rolledBackJob = await models.sequelize.query(
      "SELECT job_id FROM deletion_jobs WHERE idempotency_key = :idempotencyKey",
      { replacements: { idempotencyKey: artifactRequest.idempotencyKey }, type: QueryTypes.SELECT },
    );
    assert.equal(rolledBackJob.length, 0, "awaria journalu wycofuje transakcję tworzącą job");
    assert.equal(await isResourceTombstoned("artifact", artifactOnlyId), false, "brak durable intent nie blokuje zasobu w DB");
    let journalState = await models.sequelize.query(
      "SELECT applied_sequence AS sequence FROM deletion_journal_state WHERE singleton_id = true",
      { type: QueryTypes.SELECT },
    );
    assert.equal(Number(journalState[0].sequence), 0, "nieudany zapis journalu nie przesuwa stanu DB");
    process.env.GOLDIS_DELETION_JOURNAL_DIR = path.join(root, "deletion-journal");
    const artifactJob = await jobController.create(adminRequest, artifactRequest);
    assert.equal(artifactJob.targetType, "artifact");
    let journal = await readDeletionJournal({ directory: process.env.GOLDIS_DELETION_JOURNAL_DIR });
    assert.equal(journal.length, 1, "zamiar kasowania artefaktu trafia do journalu przed commit joba");
    assert.equal(journal[0].targetId, artifactOnlyId);
    journalState = await models.sequelize.query(
      "SELECT applied_sequence AS sequence FROM deletion_journal_state WHERE singleton_id = true",
      { type: QueryTypes.SELECT },
    );
    assert.equal(Number(journalState[0].sequence), 1);
    assert.equal(await isResourceTombstoned("artifact", artifactOnlyId), true);
    assert.equal(await isResourceTombstoned("run", artifactOnlyRunId), false, "zakres pliku nie oznacza runu do usunięcia");
    const overlappingRunPreview = await deletionController.preview({ targetType: "run", targetId: artifactOnlyRunId }, adminRequest);
    assert.ok(overlappingRunPreview.summary.blockers.includes("RUN_HAS_PENDING_ARTIFACT_DELETION"),
      "kasowanie runu nie może ścigać się z aktywnym kasowaniem pliku");
    await assert.rejects(stepUp.requestStepUp({ currentPassword: "Synthetic-only Job Deletion Password!", previewId: overlappingRunPreview.previewId }, adminRequest, { setHeader() {} }),
      (error) => error && error.getStatus?.() === 409);
    await assert.rejects(getVerifiedArtifactDownload(artifactOnlyRunId), (error) => error instanceof ArtifactDownloadError && error.code === "ARTIFACT_NOT_FOUND");
    await assert.rejects(finalizeRunExport(artifactOnlyRunId),
      (error) => error instanceof ExportFinalizeError && error.code === "EXPORT_STATE_CONFLICT");
    const historyWithPendingArtifact = await new HistoryService().results({ tenantId, userId: actorId, role: "admin" }, {});
    assert.equal(historyWithPendingArtifact.items.some((item) => item.id === artifactOnlyRunId && item.artifactAvailable === false), true,
      "pending artifact tombstone ukrywa pobieranie, ale pozostawia wynik w historii");
    const runner = new DeletionJobRunner();
    assert.equal(await runner.processOne(), true, "worker wykonuje najpierw zakres artefaktu");
    assert.equal((await jobController.get(artifactJob.jobId, adminRequest)).status, "completed");
    const artifactRows = await models.sequelize.query("SELECT artifact_id FROM export_artifacts WHERE artifact_id = :artifactId", {
      replacements: { artifactId: artifactOnlyId }, type: QueryTypes.SELECT,
    });
    const keptRun = await models.sequelize.query("SELECT id FROM automation_runs WHERE id = :runId", {
      replacements: { runId: artifactOnlyRunId }, type: QueryTypes.SELECT,
    });
    assert.equal(artifactRows.length, 0, "artefakt usunięto z metadanych DB");
    assert.equal(keptRun.length, 1, "samodzielne usunięcie pliku zachowuje przebieg");
    await assert.rejects(readFile(path.join(artifactsDirectory, `${artifactOnlyId}.xlsx`)), (error) => error && error.code === "ENOENT");
    const artifactTombstone = await models.sequelize.query(
      "SELECT state FROM resource_tombstones WHERE job_id = :jobId AND resource_type = 'artifact' AND resource_id = :artifactId",
      { replacements: { jobId: artifactJob.jobId, artifactId: artifactOnlyId }, type: QueryTypes.SELECT },
    );
    assert.equal(artifactTombstone[0]?.state, "completed");

    const preview = await deletionController.preview({ targetType: "run", targetId: runId }, adminRequest);
    assert.deepEqual(preview.summary.blockers, [], "completed run without downstream references is eligible");
    assert.equal(preview.summary.counts.artifacts, 2);
    assert.equal(preview.summary.counts.files, 2);
    const issued = await stepUp.requestStepUp(
      { currentPassword: "Synthetic-only Job Deletion Password!", previewId: preview.previewId }, adminRequest, { setHeader() {} },
    );
    const request = {
      previewId: preview.previewId, stepUpToken: issued.stepUpToken,
      idempotencyKey: `synthetic-delete-${randomUUID()}`,
    };
    const job = await jobController.create(adminRequest, request);
    assert.equal(job.status, "queued");
    const replay = await jobController.create(adminRequest, request);
    assert.equal(replay.jobId, job.jobId, "retry replays the same durable job");
    journal = await readDeletionJournal({ directory: process.env.GOLDIS_DELETION_JOURNAL_DIR });
    assert.equal(journal.length, 2, "retry idempotency nie dopisuje drugiego intentu dla istniejącego joba");
    assert.equal(journal[1].targetType, "run");
    assert.equal(journal[1].targetId, runId);
    journalState = await models.sequelize.query(
      "SELECT applied_sequence AS sequence FROM deletion_journal_state WHERE singleton_id = true",
      { type: QueryTypes.SELECT },
    );
    assert.equal(Number(journalState[0].sequence), 2);
    const visibleJobs = await jobController.list(adminRequest);
    assert.equal(visibleJobs.items.some((item) => item.jobId === job.jobId && item.status === "queued"), true,
      "trwałe zlecenie jest dostępne do odczytu po utworzeniu");
    assert.equal(await isResourceTombstoned("run", runId), true);
    for (const artifact of artifacts) assert.equal(await isResourceTombstoned("artifact", artifact.id), true);
    await assert.rejects(getVerifiedArtifactDownload(runId), (error) => error instanceof ArtifactDownloadError && error.code === "ARTIFACT_NOT_FOUND");
    const results = await new HistoryService().results({ tenantId, userId: actorId, role: "admin" }, {});
    assert.equal(results.items.some((item) => item.id === runId), false, "tombstoned runs are hidden from result history");

    assert.equal(await runner.processOne(), true, "worker claims a queued deletion job");
    const completed = await jobController.get(job.jobId, adminRequest);
    assert.equal(completed.status, "completed");
    assert.equal(completed.fileCount, 2);
    assert.equal(completed.filesRemoved, 2, "deleting an already missing file is idempotent");
    const completedJobs = await jobController.list(adminRequest);
    assert.equal(completedJobs.items.some((item) => item.jobId === job.jobId && item.status === "completed"), true,
      "lista odzwierciedla zakończony stan zlecenia");
    await assert.rejects(readFile(path.join(artifactsDirectory, `${artifacts[0].id}.xlsx`)), (error) => error && error.code === "ENOENT");
    const targetRows = await models.sequelize.query("SELECT id FROM automation_runs WHERE id = :runId", {
      replacements: { runId }, type: QueryTypes.SELECT,
    });
    const sourceRows = await models.sequelize.query("SELECT id FROM source_rows WHERE id = :sourceRowId", {
      replacements: { sourceRowId }, type: QueryTypes.SELECT,
    });
    const batchRows = await models.sequelize.query("SELECT id FROM import_batches WHERE id = :batchId", {
      replacements: { batchId }, type: QueryTypes.SELECT,
    });
    assert.equal(targetRows.length, 0, "run data is removed");
    assert.equal(sourceRows.length, 1, "source import rows are retained by run-scoped deletion");
    assert.equal(batchRows.length, 1, "source import batch is retained by run-scoped deletion");
    const tombstones = await models.sequelize.query(
      "SELECT resource_type, state FROM resource_tombstones WHERE job_id = :jobId ORDER BY resource_type, resource_id",
      { replacements: { jobId: job.jobId }, type: QueryTypes.SELECT },
    );
    assert.equal(tombstones.length, 3);
    assert.ok(tombstones.every((item) => item.state === "completed"));

    const importDeleteSourceRowId = randomUUID();
    const importDeleteRunId = randomUUID();
    const importDeleteArtifactId = randomUUID();
    const importDeleteBytes = Buffer.from("synthetic import deletion workbook");
    await models.ImportBatch.create({
      id: importDeleteBatchId, tenantId, ownerUserId: actorId, toolId: "oc-policy-verification",
      fileName: "synthetic-import-deletion.xlsx", sha256: "e".repeat(64), totalRows: 1, invalidRows: 0, createdAt: now,
    });
    importDeleteBatchCreated = true;
    await assert.rejects(deletionController.preview({ targetType: "import", targetId: importDeleteBatchId }, operatorRequest),
      (error) => error && error.getStatus?.() === 404, "operator cannot preview another user's import through a direct API request");
    await models.ImportBatch.create({ id: operatorOwnedBatchId, tenantId, ownerUserId: retainedAssigneeId,
      toolId: "oc-policy-verification", fileName: "synthetic-operator-owned-import.xlsx", sha256: "f".repeat(64),
      totalRows: 0, invalidRows: 0, createdAt: now });
    operatorOwnedBatchCreated = true;
    const operatorOwnedPreview = await deletionController.preview({ targetType: "import", targetId: operatorOwnedBatchId }, operatorRequest);
    assert.deepEqual(operatorOwnedPreview.summary.blockers, [], "operator may preview deletion of their own import");
    const operatorStepUp = await stepUp.requestStepUp({ currentPassword: "Synthetic-only Retained Lead Password!", previewId: operatorOwnedPreview.previewId },
      operatorRequest, { setHeader() {} });
    assert.match(operatorStepUp.stepUpToken, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/i,
      "operator confirms their own import deletion with current password");
    await models.SourceRow.create({
      id: importDeleteSourceRowId, batchId: importDeleteBatchId, rowNumber: 22001,
      companyName: "Synthetic Import Deletion Company", decisionMakerName: null, nipRaw: "0000000000",
      address: "Test 2", postalCode: "00-001", city: "Test City", regonRaw: "987654321",
      regon: "987654321", effectiveRegon: "987654321", rowVersion: 1, issues: [],
    });
    await models.AutomationRun.create({
      id: importDeleteRunId, batchId: importDeleteBatchId, sourceRowId: importDeleteSourceRowId,
      rowNumber: 22001, toolId: "oc-policy-verification", status: "completed", currentStep: "completed",
      referenceDate: "2026-10-01", errorCode: null,
      inputSnapshot: inputSnapshot({ sourceRowId: importDeleteSourceRowId, rowNumber: 22001,
        companyName: "Synthetic Import Deletion Company", nipRaw: "0000000000", address: "Test 2",
        postalCode: "00-001", city: "Test City", regonRaw: "987654321", regon: "987654321",
        effectiveRegon: "987654321" }),
      createdAt: now, updatedAt: now, finishedAt: now,
    });
    await models.RunSourceRow.create({ runId: importDeleteRunId, sourceRowId: importDeleteSourceRowId,
      rowNumber: 22001, isPrimary: true, createdAt: now });
    await writeFile(path.join(artifactsDirectory, `${importDeleteArtifactId}.xlsx`), importDeleteBytes, { flag: "wx" });
    await models.ExportArtifact.create({
      artifactId: importDeleteArtifactId, runId: importDeleteRunId, fileName: "synthetic-import-result.xlsx",
      storageKey: `artifacts/${importDeleteArtifactId}.xlsx`,
      sha256: createHash("sha256").update(importDeleteBytes).digest("hex"), policyCount: 1,
      state: "ready", createdAt: now, readyAt: now,
    });
    retainedEntityId = randomUUID();
    retainedLeadId = randomUUID();
    retainedResultSetId = randomUUID();
    const retainedNip = randomUUID().replace(/\D/g, "").padEnd(10, "7").slice(0, 10);
    const retainedRegon = randomUUID().replace(/\D/g, "").padEnd(9, "4").slice(0, 9);
    const companyFields = { schemaVersion: 2, companyName: "Synthetic Retained Lead", effectiveRegon: retainedRegon,
      decisionMakerName: "Anna Nowak", mobile: "501123456", phone: "221234567", email: "anna@example.test" };
    const policies = [{ sourceOrdinal: 0, insuredName: "Synthetic Retained Lead", policyTypeAndNumber: "OC TEST 1",
      contractType: "OC", insuredClaimCount: 0, vehicleRegistration: "WA12345", vehicleGroup: "osobowy",
      vehicleMake: "Test", vehicleModel: "Model", insurer: "ZU Test", coverageFrom: "2026-01-01", coverageTo: "2026-12-31" }];
    const snapshotData = { leadId: retainedLeadId, tenantId, runId: importDeleteRunId, sourceRowId: importDeleteSourceRowId,
      sourceOwnerUserId: actorId, referenceDate: "2026-10-01", companyFields, peselCiphertext: "synthetic-encrypted-pesel-v1",
      peselKeyVersion: 1, policies };
    await models.CanonicalEntity.create({ canonicalEntityId: retainedEntityId, tenantId, nipNormalized: retainedNip,
      regon: retainedRegon, businessName: companyFields.companyName, createdAt: now, updatedAt: now });
    await models.ResultSet.create({ resultSetId: retainedResultSetId, tenantId, batchId: importDeleteBatchId,
      toolId: "oc-policy-verification", actorUserId: actorId, sourceType: "run_submission", sourceId: randomUUID(),
      referenceDate: "2026-10-01", status: "completed", createdAt: now, updatedAt: now, finishedAt: now });
    await models.BusinessLead.create({ leadId: retainedLeadId, resultSetId: retainedResultSetId, tenantId,
      toolId: "oc-policy-verification", canonicalEntityId: retainedEntityId, sourceRowIds: [importDeleteSourceRowId],
      companyName: companyFields.companyName, nip: retainedNip, regon: retainedRegon, address: "Test 3", postalCode: "00-002",
      city: "Warszawa", decisionMakerNames: [companyFields.decisionMakerName], contactData: [
        { type: "mobile", value: companyFields.mobile, sourceRowId: importDeleteSourceRowId },
        { type: "phone", value: companyFields.phone, sourceRowId: importDeleteSourceRowId },
        { type: "email", value: companyFields.email, sourceRowId: importDeleteSourceRowId },
      ], resultStatus: "ready", contactStatus: "offer_accepted", assignedToUserId: retainedAssigneeId,
      assignedByUserId: actorId, assignedAt: now, contactStatusVersion: 3, assignmentVersion: 2,
      contactStatusUpdatedAt: now, createdAt: now, updatedAt: now });
    await models.LeadResultSnapshot.create({ snapshotId: randomUUID(), tenantId, leadId: retainedLeadId,
      originalRunId: importDeleteRunId, originalSourceRowId: importDeleteSourceRowId, sourceOwnerUserId: actorId,
      referenceDate: snapshotData.referenceDate, companyFields, peselCiphertext: snapshotData.peselCiphertext,
      peselKeyVersion: snapshotData.peselKeyVersion, policies, policyCount: policies.length,
      checksum: leadResultSnapshotChecksum(snapshotData), schemaVersion: 1, createdAt: now });

    const importPreview = await deletionController.preview({ targetType: "import", targetId: importDeleteBatchId }, adminRequest);
    assert.deepEqual(importPreview.summary.blockers, [], "completed import with a verified assigned-lead snapshot is eligible");
    assert.equal(importPreview.summary.counts.sourceRows, 1);
    assert.equal(importPreview.summary.counts.runs, 1);
    assert.equal(importPreview.summary.counts.artifacts, 1);
    assert.equal(importPreview.summary.counts.retainedAssignedLeads, 1);
    assert.equal(importPreview.summary.counts.removedLeads, 0);
    assert.equal(importPreview.summary.counts.missingLeadSnapshots, 0);
    const importStepUp = await stepUp.requestStepUp({
      currentPassword: "Synthetic-only Job Deletion Password!", previewId: importPreview.previewId,
    }, adminRequest, { setHeader() {} });
    const importJob = await jobController.create(adminRequest, {
      previewId: importPreview.previewId, stepUpToken: importStepUp.stepUpToken,
      idempotencyKey: `synthetic-delete-import-${randomUUID()}`,
    });
    assert.equal(importJob.targetType, "import");
    journal = await readDeletionJournal({ directory: process.env.GOLDIS_DELETION_JOURNAL_DIR });
    assert.equal(journal.length, 3);
    assert.equal(journal[2].targetId, importDeleteBatchId);
    journalState = await models.sequelize.query(
      "SELECT applied_sequence AS sequence FROM deletion_journal_state WHERE singleton_id = true",
      { type: QueryTypes.SELECT },
    );
    assert.equal(Number(journalState[0].sequence), 3);
    assert.equal(await isResourceTombstoned("import", importDeleteBatchId), true);
    assert.equal(await isResourceTombstoned("run", importDeleteRunId), true);
    assert.equal(await isResourceTombstoned("artifact", importDeleteArtifactId), true);
    const pendingImportHistory = await new HistoryService().imports({ tenantId, userId: actorId, role: "admin" }, {});
    assert.equal(pendingImportHistory.items.some((item) => item.id === importDeleteBatchId), false,
      "import tombstone immediately hides source rows from history");
    await assert.rejects(createImportService().get(importDeleteBatchId), (error) => error && error.getStatus?.() === 404,
      "source import detail is hidden before physical deletion finishes");
    const tombstonedImportPermission = await resolvePermissionResource("route-batch", {
      params: { id: importDeleteBatchId }, query: {}, headers: {}, body: {},
    }, adminRequest.goldisPrincipal);
    assert.equal(tombstonedImportPermission, null, "route-level permission resolver conceals tombstoned import subresources");
    await models.sequelize.query(
      `UPDATE resource_tombstones SET state = 'manual_required', completed_at = :now
        WHERE job_id = :jobId AND resource_type = 'import'`,
      { replacements: { now, jobId: importJob.jobId } },
    );
    const recoveryPreview = await deletionController.preview({ targetType: "import", targetId: importDeleteBatchId }, adminRequest);
    assert.ok(recoveryPreview.summary.blockers.includes("IMPORT_DELETION_PENDING"),
      "manual-required import tombstone remains a visible deletion barrier");
    let lateWriteError = null;
    try { await models.SourceRow.create({
      id: randomUUID(), batchId: importDeleteBatchId, rowNumber: 22002,
      companyName: "Must be blocked", decisionMakerName: null, nipRaw: "0000000001", address: "Test 3",
      postalCode: "00-002", city: "Test City", regonRaw: "", regon: null, effectiveRegon: null,
      rowVersion: 1, issues: [],
    }); } catch (error) { lateWriteError = error; }
    const lateWriteMessage = [lateWriteError?.message, lateWriteError?.original?.message, lateWriteError?.parent?.message]
      .filter((value) => typeof value === "string").join(" | ");
    assert.match(lateWriteMessage, /IMPORT_DELETION_PENDING/, `DB trigger bars late source row writes: ${lateWriteMessage || "NO_REJECTION"}`);
    let lateRunWriteError = null;
    try { await models.AutomationRun.create({
      id: randomUUID(), batchId: importDeleteBatchId, sourceRowId: importDeleteSourceRowId,
      rowNumber: 22002, toolId: "oc-policy-verification", status: "completed", currentStep: "completed",
      referenceDate: "2026-10-01", errorCode: null,
      inputSnapshot: inputSnapshot({ sourceRowId: importDeleteSourceRowId, rowNumber: 22002,
        companyName: "Synthetic Import Deletion Company", nipRaw: "0000000000", address: "Test 2",
        postalCode: "00-001", city: "Test City", regonRaw: "987654321", regon: "987654321",
        effectiveRegon: "987654321" }),
      createdAt: now, updatedAt: now, finishedAt: now,
    }); } catch (error) { lateRunWriteError = error; }
    const lateRunWriteMessage = [lateRunWriteError?.message, lateRunWriteError?.original?.message, lateRunWriteError?.parent?.message]
      .filter((value) => typeof value === "string").join(" | ");
    assert.match(lateRunWriteMessage, /IMPORT_DELETION_PENDING/, `DB trigger bars late run admission: ${lateRunWriteMessage || "NO_REJECTION"}`);
    await models.sequelize.query(
      `UPDATE resource_tombstones SET state = 'active', completed_at = NULL
        WHERE job_id = :jobId AND resource_type = 'import'`,
      { replacements: { jobId: importJob.jobId } },
    );
    await assert.rejects(getVerifiedArtifactDownload(importDeleteRunId),
      (error) => error instanceof ArtifactDownloadError && error.code === "ARTIFACT_NOT_FOUND");
    assert.equal(await runner.processOne(), true, "worker unlinks import artifact and cascades the full import scope");
    assert.equal((await jobController.get(importJob.jobId, adminRequest)).status, "completed");
    await assert.rejects(readFile(path.join(artifactsDirectory, `${importDeleteArtifactId}.xlsx`)), (error) => error && error.code === "ENOENT");
    for (const [table, column, id] of [
      ["import_batches", "id", importDeleteBatchId], ["source_rows", "id", importDeleteSourceRowId],
      ["automation_runs", "id", importDeleteRunId], ["export_artifacts", "artifact_id", importDeleteArtifactId],
    ]) {
      const remaining = await models.sequelize.query(`SELECT 1 FROM ${table} WHERE ${column} = :id`, {
        replacements: { id }, type: QueryTypes.SELECT,
      });
      assert.equal(remaining.length, 0, `${table} row is removed with its import scope`);
    }
    const retainedLead = await models.BusinessLead.findByPk(retainedLeadId);
    const retainedSet = await models.ResultSet.findByPk(retainedResultSetId);
    const retainedSnapshot = await models.LeadResultSnapshot.findOne({ where: { leadId: retainedLeadId, originalRunId: importDeleteRunId } });
    assert.ok(retainedLead, "lead assigned to another employee survives import deletion");
    assert.equal(retainedLead.assignedToUserId, retainedAssigneeId);
    assert.equal(retainedLead.contactStatus, "offer_accepted", "contact status survives import deletion");
    assert.equal(retainedSet.batchId, null, "retained result set is detached from the deleted import");
    assert.ok(retainedSet.sourceImportDeletedAt, "detached result records that its source import was deleted");
    assert.ok(retainedSnapshot, "encrypted PESEL and vehicle policy snapshot survives import deletion");
    const importTombstones = await models.sequelize.query(
      "SELECT resource_type, state FROM resource_tombstones WHERE job_id = :jobId ORDER BY resource_type, resource_id",
      { replacements: { jobId: importJob.jobId }, type: QueryTypes.SELECT },
    );
    assert.equal(importTombstones.length, 3);
    assert.ok(importTombstones.every((row) => row.state === "completed"));

    const restoreSourceId = randomUUID();
    const restoreRunId = randomUUID();
    const restoreArtifactId = randomUUID();
    const restoreBytes = Buffer.from("synthetic restored workbook");
    await models.ImportBatch.create({
      id: restoreBatchId, tenantId, ownerUserId: actorId, toolId: "oc-policy-verification",
      fileName: "synthetic-restore-import.xlsx", sha256: "f".repeat(64), totalRows: 1, invalidRows: 0, createdAt: now,
    });
    await models.SourceRow.create({
      id: restoreSourceId, batchId: restoreBatchId, rowNumber: 24001,
      companyName: "Synthetic Restore Company", decisionMakerName: null, nipRaw: "0000000000",
      address: "Test 4", postalCode: "00-003", city: "Test City", regonRaw: "012345678",
      regon: "012345678", effectiveRegon: "012345678", rowVersion: 1, issues: [],
    });
    await models.AutomationRun.create({
      id: restoreRunId, batchId: restoreBatchId, sourceRowId: restoreSourceId, rowNumber: 24001,
      toolId: "oc-policy-verification", status: "completed", currentStep: "completed",
      referenceDate: "2026-10-02", errorCode: null,
      inputSnapshot: inputSnapshot({ sourceRowId: restoreSourceId, rowNumber: 24001,
        companyName: "Synthetic Restore Company", nipRaw: "0000000000", address: "Test 4",
        postalCode: "00-003", city: "Test City", regonRaw: "012345678", regon: "012345678",
        effectiveRegon: "012345678" }),
      createdAt: now, updatedAt: now, finishedAt: now,
    });
    await models.RunSourceRow.create({ runId: restoreRunId, sourceRowId: restoreSourceId,
      rowNumber: 24001, isPrimary: true, createdAt: now });
    await writeFile(path.join(artifactsDirectory, `${restoreArtifactId}.xlsx`), restoreBytes, { flag: "wx" });
    await models.ExportArtifact.create({
      artifactId: restoreArtifactId, runId: restoreRunId, fileName: "synthetic-restore.xlsx",
      storageKey: `artifacts/${restoreArtifactId}.xlsx`, sha256: createHash("sha256").update(restoreBytes).digest("hex"),
      policyCount: 1, state: "ready", createdAt: now, readyAt: now,
    });
    const restorePreview = await deletionController.preview({ targetType: "import", targetId: restoreBatchId }, adminRequest);
    const restoreStepUp = await stepUp.requestStepUp({
      currentPassword: "Synthetic-only Job Deletion Password!", previewId: restorePreview.previewId,
    }, adminRequest, { setHeader() {} });
    const restoreJob = await jobController.create(adminRequest, {
      previewId: restorePreview.previewId, stepUpToken: restoreStepUp.stepUpToken,
      idempotencyKey: `synthetic-delete-restore-${randomUUID()}`,
    });
    journal = await readDeletionJournal({ directory: process.env.GOLDIS_DELETION_JOURNAL_DIR });
    assert.equal(journal.length, 4);
    await models.sequelize.query("DELETE FROM resource_tombstones WHERE job_id = :jobId", { replacements: { jobId: restoreJob.jobId } });
    await models.sequelize.query("DELETE FROM deletion_job_files WHERE job_id = :jobId", { replacements: { jobId: restoreJob.jobId } });
    await models.sequelize.query("DELETE FROM deletion_jobs WHERE job_id = :jobId", { replacements: { jobId: restoreJob.jobId } });
    await models.sequelize.query(
      "UPDATE deletion_journal_state SET applied_sequence = 3, applied_hash = :hash WHERE singleton_id = true",
      { replacements: { hash: journal[2].hash } },
    );
    process.env.GOLDIS_RESTORE_MAINTENANCE = "1";
    const { applyPendingDeletionJournal } = require("../dist/features/deletions/deletion-restore");
    await models.sequelize.query(`CREATE OR REPLACE FUNCTION synthetic_restore_purge_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${restoreBatchId}'::uuid THEN RAISE EXCEPTION 'SYNTHETIC_RESTORE_PURGE_FAILURE'; END IF;
        RETURN OLD;
      END $$`);
    await models.sequelize.query("CREATE TRIGGER synthetic_restore_purge_failure_trigger BEFORE DELETE ON import_batches FOR EACH ROW EXECUTE FUNCTION synthetic_restore_purge_failure()");
    await assert.rejects(applyPendingDeletionJournal(), /SYNTHETIC_RESTORE_PURGE_FAILURE/,
      "a DB purge failure after file unlink leaves the journal head unchanged for recovery");
    await models.sequelize.query("DROP TRIGGER synthetic_restore_purge_failure_trigger ON import_batches");
    await models.sequelize.query("DROP FUNCTION synthetic_restore_purge_failure()");
    assert.ok(await models.ImportBatch.findByPk(restoreBatchId), "failed DB transaction preserves the restored source rows");
    assert.ok(await models.AutomationRun.findByPk(restoreRunId), "failed DB transaction preserves the restored run");
    await assert.rejects(readFile(path.join(artifactsDirectory, `${restoreArtifactId}.xlsx`)), (error) => error && error.code === "ENOENT",
      "the filesystem unlink may have committed before the DB transaction failed");
    journalState = await models.sequelize.query(
      "SELECT applied_sequence AS sequence FROM deletion_journal_state WHERE singleton_id = true",
      { type: QueryTypes.SELECT },
    );
    assert.equal(Number(journalState[0].sequence), 3, "a failed replay does not advance the accepted journal head");
    const journalReplay = await applyPendingDeletionJournal();
    assert.deepEqual(journalReplay, { appliedEntries: 1, headSequence: 4 });
    assert.equal(await models.ImportBatch.findByPk(restoreBatchId), null, "journal replay removes data reintroduced by an older DB snapshot");
    assert.equal(await models.AutomationRun.findByPk(restoreRunId), null);
    assert.equal(await models.ExportArtifact.findByPk(restoreArtifactId), null);
    await assert.rejects(readFile(path.join(artifactsDirectory, `${restoreArtifactId}.xlsx`)), (error) => error && error.code === "ENOENT");
    journalState = await models.sequelize.query(
      "SELECT applied_sequence AS sequence, applied_hash AS hash FROM deletion_journal_state WHERE singleton_id = true",
      { type: QueryTypes.SELECT },
    );
    assert.equal(Number(journalState[0].sequence), 4);
    assert.equal(journalState[0].hash, journal[3].hash);
    assert.ok(await models.ImportBatch.create({
      id: restoreFollowupBatchId, tenantId, ownerUserId: actorId, toolId: "oc-policy-verification",
      fileName: "synthetic-restore-followup.xlsx", sha256: "a".repeat(64), totalRows: 0, invalidRows: 0, createdAt: now,
    }));
    assert.ok(await models.ImportBatch.create({
      id: restoreFailingBatchId, tenantId, ownerUserId: actorId, toolId: "oc-policy-verification",
      fileName: "synthetic-restore-failing.xlsx", sha256: "b".repeat(64), totalRows: 0, invalidRows: 0, createdAt: now,
    }));
    const { appendDeletionJournalIntent } = require("../dist/features/deletions/deletion-journal");
    await appendDeletionJournalIntent({ jobId: randomUUID(), tenantId, targetType: "import", targetId: restoreFollowupBatchId });
    await appendDeletionJournalIntent({ jobId: randomUUID(), tenantId, targetType: "import", targetId: restoreFailingBatchId });
    journal = await readDeletionJournal({ directory: process.env.GOLDIS_DELETION_JOURNAL_DIR });
    assert.equal(journal.length, 6, "two newer signed intents model a multi-entry restore after an older snapshot");
    await models.sequelize.query(`CREATE OR REPLACE FUNCTION synthetic_restore_later_entry_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${restoreFailingBatchId}'::uuid THEN RAISE EXCEPTION 'SYNTHETIC_RESTORE_LATER_ENTRY_FAILURE'; END IF;
        RETURN OLD;
      END $$`);
    await models.sequelize.query("CREATE TRIGGER synthetic_restore_later_entry_failure_trigger BEFORE DELETE ON import_batches FOR EACH ROW EXECUTE FUNCTION synthetic_restore_later_entry_failure()");
    await assert.rejects(applyPendingDeletionJournal(), /SYNTHETIC_RESTORE_LATER_ENTRY_FAILURE/,
      "a later replay entry failure preserves the checkpoint of earlier committed entries");
    await models.sequelize.query("DROP TRIGGER synthetic_restore_later_entry_failure_trigger ON import_batches");
    await models.sequelize.query("DROP FUNCTION synthetic_restore_later_entry_failure()");
    assert.equal(await models.ImportBatch.findByPk(restoreFollowupBatchId), null,
      "the first entry committed before a later journal entry failed");
    assert.ok(await models.ImportBatch.findByPk(restoreFailingBatchId),
      "the failing entry remains available for a safe retry");
    journalState = await models.sequelize.query(
      "SELECT applied_sequence AS sequence, applied_hash AS hash FROM deletion_journal_state WHERE singleton_id = true",
      { type: QueryTypes.SELECT },
    );
    assert.equal(Number(journalState[0].sequence), 5, "the checkpoint advances only through fully committed entries");
    assert.equal(journalState[0].hash, journal[4].hash);
    const checkpointReplay = await applyPendingDeletionJournal();
    delete process.env.GOLDIS_RESTORE_MAINTENANCE;
    assert.deepEqual(checkpointReplay, { appliedEntries: 1, headSequence: 6 },
      "retry resumes at the first uncommitted journal entry");
    assert.equal(await models.ImportBatch.findByPk(restoreFailingBatchId), null);
    journalState = await models.sequelize.query(
      "SELECT applied_sequence AS sequence, applied_hash AS hash FROM deletion_journal_state WHERE singleton_id = true",
      { type: QueryTypes.SELECT },
    );
    assert.equal(Number(journalState[0].sequence), 6);
    assert.equal(journalState[0].hash, journal[5].hash);
    console.log("DELETION_JOB_DB_PASS standaloneArtifactScope=true artifactTombstoneBarrier=true runPreservedOnArtifactDelete=true previewToStepUp=true idempotentCreate=true persistentJobList=true tombstoneBarrier=true hiddenFromHistory=true artifactsUnlinked=true missingFileRetrySafe=true runRemoved=true sourceImportRetained=true importScopeCascade=true routeScopeHidden=true lateWriteBarrier=true manualRequiredBarrier=true importAndRunHidden=true tombstonesRetained=true externalJournalWriteAhead=true journalIdempotentReplay=true rollbackOnJournalFailure=true oldSnapshotReplay=true replayCrashAfterFileUnlink=true replayPurgesFileAndImport=true replayMultiEntryCheckpoint=true replayResumesAfterPartialProgress=true");
  } finally {
    if (retainedLeadId) await models.BusinessLead.destroy({ where: { leadId: retainedLeadId } }).catch(() => {});
    if (retainedResultSetId) await models.ResultSet.destroy({ where: { resultSetId: retainedResultSetId } }).catch(() => {});
    if (retainedEntityId) await models.CanonicalEntity.destroy({ where: { canonicalEntityId: retainedEntityId } }).catch(() => {});
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousArtifactRoot === undefined) delete process.env.API_EXPORT_DIR;
    else process.env.API_EXPORT_DIR = previousArtifactRoot;
    if (previousDeletionJournalDir === undefined) delete process.env.GOLDIS_DELETION_JOURNAL_DIR;
    else process.env.GOLDIS_DELETION_JOURNAL_DIR = previousDeletionJournalDir;
    if (previousRestoreMaintenance === undefined) delete process.env.GOLDIS_RESTORE_MAINTENANCE;
    else process.env.GOLDIS_RESTORE_MAINTENANCE = previousRestoreMaintenance;
    if (batchCreated) await models.ImportBatch.destroy({ where: { id: batchId } }).catch(() => {});
    if (importDeleteBatchCreated) await models.ImportBatch.destroy({ where: { id: importDeleteBatchId } }).catch(() => {});
    if (operatorOwnedBatchCreated) await models.ImportBatch.destroy({ where: { id: operatorOwnedBatchId } }).catch(() => {});
    await models.ImportBatch.destroy({ where: { id: [restoreBatchId, restoreFollowupBatchId, restoreFailingBatchId] } }).catch(() => {});
    if (actorCreated) {
      await models.UserSession.destroy({ where: { sessionId } }).catch(() => {});
      await models.TenantMembership.destroy({ where: { tenantId, userId: actorId } }).catch(() => {});
      await models.User.destroy({ where: { userId: actorId } }).catch(() => {});
    }
    if (retainedAssigneeCreated) {
      await models.sequelize.query("DELETE FROM deletion_step_up_grants WHERE user_id = :userId", { replacements: { userId: retainedAssigneeId } }).catch(() => {});
      await models.sequelize.query("DELETE FROM deletion_previews WHERE actor_user_id = :userId", { replacements: { userId: retainedAssigneeId } }).catch(() => {});
      await models.UserSession.destroy({ where: { userId: retainedAssigneeId } }).catch(() => {});
      await models.TenantMembership.destroy({ where: { tenantId, userId: retainedAssigneeId } }).catch(() => {});
      await models.User.destroy({ where: { userId: retainedAssigneeId } }).catch(() => {});
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
};
