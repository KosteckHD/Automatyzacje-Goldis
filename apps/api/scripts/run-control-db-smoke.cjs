const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { mkdir, mkdtemp, rm, writeFile, access } = require("node:fs/promises");
const { basename, dirname, join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { Pool } = require("pg");

module.exports = async function verifyRunControlDatabase(seed) {
  const { AuthChallenge, AutomationRun, ManualIntervention } = require("../dist/infrastructure/database/db");
  const { RunService } = require("../dist/features/runs/runs.service");
  const { RunDispatchService } = require("../dist/features/runs/run-dispatch.service");
  const { RunCancellationRepository } = require("../dist/features/runs/run-cancellation.repository");
  const { RunCancellationService } = require("../dist/features/runs/run-cancellation.service");
  const { RunControlRepository } = require("../dist/features/runs/run-control.repository");
  const { RunControlService } = require("../dist/features/runs/run-control.service");
  const { RunRecoveryRepository } = require("../dist/features/runs/run-recovery.repository");
  const { RunRecoveryService } = require("../dist/features/runs/run-recovery.service");
  const { RunResumeRepository } = require("../dist/features/runs/run-resume.repository");
  const { RunResumeService } = require("../dist/features/runs/run-resume.service");
  const { AuthChallengeService } = require("../dist/features/interventions/auth-challenge.service");
  const { WorkerResultStagingStore } = require("../../worker/dist/infrastructure/staging/result-staging");
  const { reconcileCompletedStaging } = require("../../worker/dist/features/results/result-staging-checkpoint");
  const { PgRunRepository } = require("../../worker/dist/infrastructure/database/pg-run-repository");
  const { releaseRunExecution } = require("../../worker/dist/features/execution/execution-lease");
  const runId = seed.goldis.runId;
  const actor = { tenantId: seed.goldisTenantId, actorUserId: seed.goldisActorId };
  const now = new Date();
  const executionId = "723e4567-e89b-42d3-a456-426614174000";
  const workerSessionId = "823e4567-e89b-42d3-a456-426614174000";
  const dispatchId = "923e4567-e89b-42d3-a456-426614174000";
  const resumeChallengeId = randomUUID();
  const resumeMfaCycleId = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const service = Object.create(RunService.prototype);
  service.dispatch = new RunDispatchService();
  service.publishOutbox = async () => undefined;
  service.dispatch.publishOutbox = async () => undefined;
  const invalidatedChallenges = [];
  service.codeForwarder = { invalidate: async (challengeId) => { invalidatedChallenges.push(challengeId); } };
  service.cancellation = new RunCancellationService(new RunCancellationRepository(), service.codeForwarder);
  service.control = new RunControlService(new RunControlRepository(), service.dispatch);
  service.recovery = new RunRecoveryService(new RunRecoveryRepository(), service.dispatch);
  service.resume = new RunResumeService(new RunResumeRepository(), service.dispatch, service.codeForwarder);
  let deliveryStarted;
  let finishDelivery;
  const started = new Promise((resolve) => { deliveryStarted = resolve; });
  const delivery = new Promise((resolve) => { finishDelivery = resolve; });
  const smsService = new AuthChallengeService({
    deliver: async () => { deliveryStarted(); await delivery; },
    invalidate: async () => undefined,
  });
  const challengeId = "a2345678-1234-4234-8234-123456789abc";
  const mfaCycleId = "b2345678-1234-4234-8234-123456789abc";
  const stagingFileId = randomUUID();
  const previousStagingDirectory = process.env.WORKER_STAGING_DIR;
  const ownsStagingDirectory = !previousStagingDirectory;
  const stagingDirectory = previousStagingDirectory ?? await mkdtemp(join(tmpdir(), "goldis-run-control-staging-"));
  process.env.WORKER_STAGING_DIR = stagingDirectory;
  const previousStagingKeyVersion = process.env.WORKER_STAGING_KEY_VERSION;
  const previousStagingKey = process.env.WORKER_STAGING_KEY_V1;
  process.env.WORKER_STAGING_KEY_VERSION = "1";
  process.env.WORKER_STAGING_KEY_V1 = randomBytes(32).toString("base64url");
  const stagingStore = new WorkerResultStagingStore(process.env);
  let pendingSmsSubmission;
  try {
    await AutomationRun.update({
      status: "compensa_form", currentStep: "compensa_form", controlState: "running", controlRevision: "0",
      controlAckRevision: "0", controlRequestedBy: null, controlRequestedAt: null,
      controlAcknowledgedAt: null, controlCheckpointStatus: null,
      executionId, workerSessionId, leaseExpiresAt, startedByUserId: actor.actorUserId,
    }, { where: { id: runId } });

    const pauseRequest = { expectedRevision: "0", idempotencyKey: `synthetic-pause-${runId}` };
    const requested = await RunService.prototype.pause.call(service, runId, actor, pauseRequest);
    assert.equal(requested.controlState, "pause_requested");
    assert.equal(requested.controlRevision, "1");
    const pauseReplay = await RunService.prototype.pause.call(service, runId, actor, pauseRequest);
    assert.deepEqual(pauseReplay, requested, "retry after an uncertain HTTP outcome replays the original pause response");
    await assert.rejects(RunService.prototype.pause.call(service, runId, actor, {
      ...pauseRequest, idempotencyKey: `synthetic-stale-${runId}`,
    }), (error) => error && error.getStatus?.() === 409, "a new command with a stale revision is rejected");

    const lease = { runId, dispatchId, executionId, workerSessionId, intentType: "recovery", leaseExpiresAt: leaseExpiresAt.toISOString() };
    const repository = new PgRunRepository(pool, () => lease);
    assert.equal(await repository.pauseAtSafeBoundary(runId), true);
    let current = await AutomationRun.findByPk(runId);
    assert.equal(current.controlState, "paused");
    assert.equal(String(current.controlAckRevision), "1");
    assert.equal(current.controlCheckpointStatus, "compensa_form");

    await releaseRunExecution(pool, lease);
    const resumeRequest = { expectedRevision: "1", idempotencyKey: `synthetic-resume-${runId}` };
    const resumed = await RunService.prototype.resumePaused.call(service, runId, actor, resumeRequest);
    assert.equal(resumed.controlState, "running");
    assert.equal(String(resumed.controlRevision), "2");
    const resumeReplay = await RunService.prototype.resumePaused.call(service, runId, actor, resumeRequest);
    assert.deepEqual(resumeReplay, resumed, "duplicate resume does not create another dispatch or control revision");
    assert.equal(String(resumed.controlAckRevision), "1");
    const pendingDispatch = await pool.query(
      "SELECT intent_type, status FROM run_dispatch_outbox WHERE run_id = $1 AND status IN ('pending','publishing','published')", [runId],
    );
    assert.equal(pendingDispatch.rowCount, 1);
    assert.equal(pendingDispatch.rows[0].intent_type, "recovery");

    const pausedWithoutWorker = await RunService.prototype.pause.call(service, runId, actor, {
      expectedRevision: "2", idempotencyKey: `synthetic-pause-no-worker-${runId}`,
    });
    assert.equal(pausedWithoutWorker.controlState, "paused");
    assert.equal(String(pausedWithoutWorker.controlAckRevision), "3");
    const remainingDispatch = await pool.query(
      "SELECT 1 FROM run_dispatch_outbox WHERE run_id = $1 AND status IN ('pending','publishing','published')", [runId],
    );
    assert.equal(remainingDispatch.rowCount, 0);
    const requestCount = await pool.query("SELECT count(*)::int AS count FROM run_control_requests WHERE run_id = $1", [runId]);
    assert.equal(requestCount.rows[0].count, 3, "each unique accepted command has one durable idempotency record");

    const resumeNow = new Date();
    await AuthChallenge.create({
      challengeId: resumeChallengeId, runId, portal: "pzu", accountKey: "e".repeat(64),
      browserSessionId: workerSessionId, returnStep: "pzu_login", status: "active", attemptCount: 0,
      attemptLimit: 5, expiresAt: new Date(resumeNow.getTime() + 60_000), claimedAt: null, consumedAt: null,
      createdAt: resumeNow, updatedAt: resumeNow, mfaCycleId: resumeMfaCycleId,
    });
    await ManualIntervention.create({
      interventionId: randomUUID(), runId, challengeId: resumeChallengeId, portal: "pzu", kind: "sms",
      status: "open", reasonCode: "SMS_CODE_REJECTED", createdAt: resumeNow, updatedAt: resumeNow,
      revision: 1, fieldCode: null, resolvedAt: null, resolvedBy: null, assigneeUserId: null, priority: "normal",
      dueAt: null, assignedAt: null, assignedBy: null,
    });
    await AutomationRun.update({
      status: "waiting_for_sms", currentStep: "waiting_for_sms", errorCode: "SMS_CODE_REJECTED",
      currentAuthChallengeId: resumeChallengeId, authCycleId: resumeMfaCycleId, authCyclePortal: "pzu",
      authCycleStartedAt: resumeNow, authCycleExpiresAt: new Date(resumeNow.getTime() + 60_000),
      pzuSmsRetryCount: 0, compensaSmsRetryCount: 0,
    }, { where: { id: runId } });
    const resumedAuth = await service.resumeAuth(runId, actor);
    assert.equal(resumedAuth.status, "pzu_login");
    assert.equal(resumedAuth.errorCode, "SMS_RETRY_QUEUED");
    assert.equal((await AuthChallenge.findByPk(resumeChallengeId)).status, "expired");
    assert.equal((await AutomationRun.findByPk(runId)).pzuSmsRetryCount, 1);
    assert.deepEqual(invalidatedChallenges, [resumeChallengeId], "the old challenge is invalidated only after the retry transaction commits");
    await pool.query("UPDATE run_dispatch_outbox SET status = 'cancelled', updated_at = now() WHERE run_id = $1", [runId]);

    await AutomationRun.update({
      status: "queued", currentStep: "queued", controlState: "running", technicalAttemptCount: 0,
      technicalCycleId: null, executionId: null, workerSessionId: null, leaseExpiresAt: null,
    }, { where: { id: runId } });
    await service.recovery.recoverOrphanRuns();
    const recoveredRun = await AutomationRun.findByPk(runId);
    assert.equal(recoveredRun.technicalAttemptCount, 1, "orphan recovery persists the incremented attempt in its transaction");
    const recoveryIntent = await pool.query(
      "SELECT intent_type, status FROM run_dispatch_outbox WHERE run_id = $1 AND status = 'pending'", [runId],
    );
    assert.equal(recoveryIntent.rowCount, 1);
    assert.equal(recoveryIntent.rows[0].intent_type, "recovery");
    await service.recovery.recoverOrphanRuns();
    assert.equal((await AutomationRun.findByPk(runId)).technicalAttemptCount, 1,
      "an unresolved recovery dispatch prevents duplicate orphan recovery attempts");
    await pool.query("UPDATE run_dispatch_outbox SET status = 'cancelled', updated_at = now() WHERE run_id = $1", [runId]);
    await AutomationRun.update({
      status: "queued", currentStep: "queued", technicalAttemptCount: 2, leaseExpiresAt: null,
    }, { where: { id: runId } });
    await service.recovery.recoverOrphanRuns();
    const escalatedRun = await AutomationRun.findByPk(runId);
    assert.equal(escalatedRun.status, "waiting_for_manual_data");
    assert.equal(escalatedRun.errorCode, "PORTAL_FAILURE");
    assert.equal(await ManualIntervention.count({ where: { runId, status: "open", reasonCode: "PORTAL_FAILURE" } }), 1,
      "exhausted recovery creates one operator intervention");
    const reviewIncident = await ManualIntervention.findOne({ where: { runId, status: "open", reasonCode: "PORTAL_FAILURE" } });
    reviewIncident.portal = "compensa";
    reviewIncident.fieldCode = "PORTAL_ACTION_REVIEW";
    reviewIncident.updatedAt = new Date();
    await reviewIncident.save();
    await AutomationRun.update({
      status: "waiting_for_manual_data", currentStep: "waiting_for_manual_data",
      lastSafeStep: "compensa_offer_draft_open", externalCaseRef: "synthetic-case-12345",
    }, { where: { id: runId } });
    const resumedReview = await service.resumeReview(runId, actor);
    assert.equal(resumedReview.status, "compensa_login");
    assert.equal(resumedReview.errorCode, "REVIEW_RETRY_QUEUED");
    assert.equal(await ManualIntervention.count({ where: { interventionId: reviewIncident.interventionId, status: "resolved" } }), 1);

    assert.ok(stagingDirectory, "run-control smoke owns a disposable staging directory");
    await mkdir(stagingDirectory, { recursive: true });
    const stagingPath = join(stagingDirectory, `${stagingFileId}.stage`);
    await writeFile(stagingPath, "synthetic encrypted-stage-placeholder");
    const reconcileNow = new Date();
    const liveLeaseExpiry = new Date(reconcileNow.getTime() + 60_000);
    await AutomationRun.update({
      status: "completed", currentStep: "completed", finishedAt: reconcileNow,
      stagingFileId, stagingSha256: "d".repeat(64), stagingKeyVersion: 1, stagingFormatVersion: 1,
      executionId, workerSessionId, leaseExpiresAt: liveLeaseExpiry,
    }, { where: { id: runId } });
    assert.equal(await reconcileCompletedStaging(pool, stagingStore, reconcileNow), 0,
      "a terminal row with a live lease is still owned and must not be cleaned");
    await access(stagingPath);
    await AutomationRun.update({ leaseExpiresAt: new Date(reconcileNow.getTime() - 1) }, { where: { id: runId } });
    assert.equal(await reconcileCompletedStaging(pool, stagingStore, reconcileNow), 1,
      "an expired terminal checkpoint is reclaimed by the reconcile pass");
    await assert.rejects(access(stagingPath), (error) => error?.code === "ENOENT");
    const reconciledRun = await AutomationRun.findByPk(runId);
    assert.equal(reconciledRun.stagingFileId, null);
    assert.equal(await reconcileCompletedStaging(pool, stagingStore, reconcileNow), 0, "reconcile is idempotent");

    const smsNow = new Date();
    const smsExpires = new Date(smsNow.getTime() + 120_000);
    await AuthChallenge.create({
      challengeId, runId, portal: "compensa", accountKey: "c".repeat(64), browserSessionId: workerSessionId,
      returnStep: "compensa_login", status: "active", attemptCount: 0, attemptLimit: 5,
      expiresAt: smsExpires, claimedAt: null, consumedAt: null, createdAt: smsNow, updatedAt: smsNow, mfaCycleId,
    });
    await AutomationRun.update({
      status: "waiting_for_sms", currentStep: "waiting_for_sms", currentAuthChallengeId: challengeId,
      authCycleId: mfaCycleId, authCyclePortal: "compensa", authCycleStartedAt: smsNow,
      authCycleExpiresAt: smsExpires, executionId: null, workerSessionId: null, leaseExpiresAt: null,
    }, { where: { id: runId } });

    pendingSmsSubmission = smsService.submitCode(challengeId, runId, "123456", actor);
    await started;
    await assert.rejects(service.cancel(runId, actor), (error) => error && error.getStatus?.() === 409,
      "cancel must not claim success while the claimed SMS code is crossing the worker boundary");
    assert.equal((await AutomationRun.findByPk(runId)).status, "waiting_for_sms");
    assert.equal((await AuthChallenge.findByPk(challengeId)).status, "claimed");
    assert.deepEqual(invalidatedChallenges, [resumeChallengeId], "a rejected cancel does not invalidate the in-flight challenge");

    finishDelivery();
    assert.deepEqual(await pendingSmsSubmission, { accepted: true, challengeId, attemptCount: 1 });
    assert.equal((await AuthChallenge.findByPk(challengeId)).status, "submitted");
    const cancelled = await service.cancel(runId, actor);
    assert.equal(cancelled.status, "cancelled", "cancel can be retried after delivery has a durable outcome");
    assert.equal((await AuthChallenge.findByPk(challengeId)).status, "invalidated");
    assert.deepEqual(invalidatedChallenges, [resumeChallengeId, challengeId]);
    console.log("RUN_CONTROL_DB_PASS apiRequest=true staleRevisionRejected=true idempotentReplay=true workerSafeAck=true leaseRelease=true sameRunResume=true smsRetryResume=true manualReviewResume=true noWorkerPause=true outboxCancelled=true orphanRecovery=true orphanRecoveryIdempotent=true orphanEscalation=true smsCancelRaceSafe=true terminalStagingReconcile=true");
  } finally {
    finishDelivery?.();
    await pendingSmsSubmission?.catch(() => undefined);
    await AutomationRun.update({
      status: "failed", currentStep: "failed", controlState: "running", controlRequestedBy: null,
      currentAuthChallengeId: null, authCycleId: null, authCyclePortal: null, authCycleStartedAt: null,
      authCycleExpiresAt: null, executionId: null, workerSessionId: null, leaseExpiresAt: null,
    }, { where: { id: runId } }).catch(() => undefined);
    await ManualIntervention.destroy({ where: { runId } }).catch(() => undefined);
    await AuthChallenge.destroy({ where: { challengeId: resumeChallengeId } }).catch(() => undefined);
    await AuthChallenge.destroy({ where: { challengeId } }).catch(() => undefined);
    await stagingStore.remove(stagingFileId).catch(() => undefined);
    stagingStore.destroyKey();
    if (previousStagingKeyVersion === undefined) delete process.env.WORKER_STAGING_KEY_VERSION;
    else process.env.WORKER_STAGING_KEY_VERSION = previousStagingKeyVersion;
    if (previousStagingKey === undefined) delete process.env.WORKER_STAGING_KEY_V1;
    else process.env.WORKER_STAGING_KEY_V1 = previousStagingKey;
    if (previousStagingDirectory === undefined) delete process.env.WORKER_STAGING_DIR;
    else process.env.WORKER_STAGING_DIR = previousStagingDirectory;
    if (ownsStagingDirectory) {
      const resolvedStagingDirectory = resolve(stagingDirectory);
      if (dirname(resolvedStagingDirectory) !== resolve(tmpdir())
        || !basename(resolvedStagingDirectory).startsWith("goldis-run-control-staging-")) {
        throw new Error("RUN_CONTROL_STAGING_PATH_OWNERSHIP_INVALID");
      }
      await rm(resolvedStagingDirectory, { recursive: true, force: true });
    }
    await pool.end();
  }
};
