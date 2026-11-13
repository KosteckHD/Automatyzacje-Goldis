const { QueryTypes } = require("sequelize");
const { createHash, randomBytes, randomUUID } = require("node:crypto");

module.exports = async function commissionDatabaseSmoke(seed) {
  const { sequelize } = require("../dist/infrastructure/database/db");
  if (!seed?.goldisTenantId) throw new Error("COMMISSION_SMOKE_GOLDIS_TENANT_REQUIRED");

  const expectedTables = [
    "commission_agents", "commission_files", "commission_dictionary_versions",
    "commission_dictionary_grants", "commission_runs", "commission_run_files",
    "commission_run_snapshots", "commission_dispatches", "commission_resolutions",
    "commission_exports",
  ];
  const rows = await sequelize.query(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
    { bind: [expectedTables], type: QueryTypes.SELECT },
  );
  const foundTables = new Set(rows.map(({ name }) => name));
  const missingTables = expectedTables.filter((name) => !foundTables.has(name));
  if (missingTables.length) throw new Error(`COMMISSION_TABLES_MISSING:${missingTables.join(",")}`);

  const leaseColumn = await sequelize.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='commission_runs' AND column_name='execution_lease_until'`,
    { type: QueryTypes.SELECT },
  );
  const leaseIndex = await sequelize.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='commission_runs'
      AND indexname='commission_runs_execution_lease_idx'`,
    { type: QueryTypes.SELECT },
  );
  if (leaseColumn.length !== 1 || leaseIndex.length !== 1) throw new Error("COMMISSION_EXECUTION_LEASE_SCHEMA_MISSING");

  const agents = await sequelize.query(
    "SELECT agent_key FROM commission_agents WHERE tenant_id = $1 AND is_active = true ORDER BY agent_key",
    { bind: [seed.goldisTenantId], type: QueryTypes.SELECT },
  );
  if (agents.map(({ agent_key }) => agent_key).join(",") !== "maciek,ola") {
    throw new Error("COMMISSION_DEFAULT_AGENTS_NOT_SEEDED");
  }

  const tools = await sequelize.query(
    "SELECT tool_id FROM tools WHERE tool_id = 'commission-comparison'",
    { type: QueryTypes.SELECT },
  );
  if (tools.length !== 1) throw new Error("COMMISSION_TOOL_NOT_REGISTERED");

  const settings = await sequelize.query(
    "SELECT enabled_for_new_runs FROM tool_settings WHERE tenant_id = $1 AND tool_id = 'commission-comparison'",
    { bind: [seed.goldisTenantId], type: QueryTypes.SELECT },
  );
  if (settings.length !== 1 || settings[0].enabled_for_new_runs !== true) {
    throw new Error("COMMISSION_TOOL_SETTINGS_NOT_SEEDED");
  }

  const auditChecks = await sequelize.query(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'audit_events'::regclass AND conname = 'audit_event_action_valid'`,
    { type: QueryTypes.SELECT },
  );
  const auditDefinition = auditChecks[0]?.definition ?? "";
  if (!auditDefinition.includes("commission.run.completed")
      || !auditDefinition.includes("commission.dictionary.grant.updated")) {
    throw new Error("COMMISSION_AUDIT_ACTIONS_NOT_ALLOWED");
  }

  await verifyDictionaryMutationIntegrity(sequelize, seed);
  await verifyExecutionLifecycle(sequelize, seed);

  console.log("COMMISSION_DB_SMOKE_PASS tables=10 agents=2 lease=ready tool=registered audit=allowed");
};

async function verifyDictionaryMutationIntegrity(sequelize, seed) {
  const environmentKeys = [
    "APP_ENV",
    "ARTIFACT_REQUIRE_ENCRYPTION",
    "ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION",
    "ARTIFACT_ENCRYPTION_KEYS_BASE64",
  ];
  const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  const artifactKey = randomBytes(32).toString("base64");
  const cryptoEnvironment = {
    APP_ENV: "test",
    ARTIFACT_REQUIRE_ENCRYPTION: "1",
    ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
    ARTIFACT_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify({ "1": artifactKey }), "utf8").toString("base64"),
  };
  Object.assign(process.env, cryptoEnvironment);

  try {
    const { encryptArtifactBytes, decryptStoredArtifactBytes } = require("../dist/features/results/artifact-crypto");
    const { AuditRepository } = require("../dist/features/audit/audit.repository");
    const { AuditService } = require("../dist/features/audit/audit.service");
    const { CommissionsRepository } = require("../dist/features/commissions/commissions.repository");
    const { CommissionsService } = require("../dist/features/commissions/commissions.service");
    const service = new CommissionsService(
      new CommissionsRepository(sequelize),
      new AuditService(new AuditRepository()),
    );
    const tenantId = seed.goldisTenantId;
    const validScope = { tenantId, userId: seed.goldisActorId, role: "admin" };
    const dictionaryVersionId = randomUUID();
    const versionRows = await sequelize.query(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM commission_dictionary_versions WHERE tenant_id=$1",
      { bind: [tenantId], type: QueryTypes.SELECT },
    );
    const versionNumber = Number(versionRows[0].next);
    const snapshot = {
      client_dictionary: {
        entries: [{
          id: "SMOKE-ENTRY-1", risk: "OC", source: "synthetic.xlsx", sheet: "Synthetic", variant: "A",
          agents: {
            Ola: { status: "RATE", rate: 10, rule_id: "SMOKE_RULE_OLA", cell: "D8", raw: 10 },
            Maciek: { status: "RATE", rate: 12, rule_id: "SMOKE_RULE_MACIEK", cell: "E8", raw: 12 },
          },
        }],
      },
      rules: { SMOKE_RULE_OLA: { rate: 10 }, SMOKE_RULE_MACIEK: { rate: 12 } },
    };

    async function insertDraft(id, number) {
      const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
      const ciphertext = encryptArtifactBytes(id, bytes, cryptoEnvironment);
      await sequelize.query(
        `INSERT INTO commission_dictionary_versions
           (dictionary_version_id, tenant_id, version_number, status, is_active, revision, snapshot_ciphertext,
            snapshot_sha256, entry_count, source_file_id, previous_version_id, created_by, published_by,
            created_at, published_at)
         VALUES ($1,$2,$3,'draft',false,1,$4,$5,1,NULL,NULL,$6,NULL,now(),NULL)`,
        { bind: [id, tenantId, number, ciphertext, createHash("sha256").update(bytes).digest("hex"), seed.goldisActorId] },
      );
    }

    async function readDictionary(id) {
      const rows = await sequelize.query(
        `SELECT status, revision, snapshot_ciphertext, snapshot_sha256
           FROM commission_dictionary_versions WHERE tenant_id=$1 AND dictionary_version_id=$2`,
        { bind: [tenantId, id], type: QueryTypes.SELECT },
      );
      if (!rows[0]) throw new Error("COMMISSION_DICTIONARY_SMOKE_ROW_MISSING");
      const bytes = decryptStoredArtifactBytes(id, rows[0].snapshot_ciphertext, cryptoEnvironment).bytes;
      return { ...rows[0], preset: JSON.parse(bytes.toString("utf8")) };
    }

    async function dictionaryAuditCount(id, action) {
      const rows = await sequelize.query(
        "SELECT count(*)::integer AS count FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND action=$3",
        { bind: [tenantId, id, action], type: QueryTypes.SELECT },
      );
      return Number(rows[0].count);
    }

    await insertDraft(dictionaryVersionId, versionNumber);

    let auditInsertFailureObserved = false;
    try {
      await service.editDictionaryEntry(
        { ...validScope, userId: randomUUID() },
        dictionaryVersionId,
        "SMOKE-ENTRY-1",
        { revision: 1, agent: "Ola", status: "RATE", rate: 19 },
      );
    } catch (error) {
      auditInsertFailureObserved = error?.original?.code === "23503" || error?.parent?.code === "23503";
    }
    const afterAuditFailure = await readDictionary(dictionaryVersionId);
    if (!auditInsertFailureObserved || afterAuditFailure.revision !== 1 || afterAuditFailure.preset.rules.SMOKE_RULE_OLA.rate !== 10
        || await dictionaryAuditCount(dictionaryVersionId, "commission.dictionary.edited") !== 0) {
      throw new Error("COMMISSION_DICTIONARY_AUDIT_ROLLBACK_FAILED");
    }

    const edits = await Promise.allSettled([
      service.editDictionaryEntry(validScope, dictionaryVersionId, "SMOKE-ENTRY-1", {
        revision: 1, agent: "Ola", status: "RATE", rate: 25,
      }),
      service.editDictionaryEntry(validScope, dictionaryVersionId, "SMOKE-ENTRY-1", {
        revision: 1, agent: "Ola", status: "RATE", rate: 30,
      }),
    ]);
    const editWinners = edits.filter((item) => item.status === "fulfilled");
    const editLosers = edits.filter((item) => item.status === "rejected");
    if (editWinners.length !== 1 || editLosers.length !== 1
        || typeof editLosers[0].reason?.getStatus !== "function" || editLosers[0].reason.getStatus() !== 409) {
      throw new Error("COMMISSION_DICTIONARY_REVISION_RACE_NOT_EXCLUSIVE");
    }
    const expectedRate = editWinners[0].value.entry.agents.Ola.rate;
    const afterEditRace = await readDictionary(dictionaryVersionId);
    if (afterEditRace.revision !== 2 || afterEditRace.preset.rules.SMOKE_RULE_OLA.rate !== expectedRate
        || await dictionaryAuditCount(dictionaryVersionId, "commission.dictionary.edited") !== 1) {
      throw new Error("COMMISSION_DICTIONARY_REVISION_RACE_STATE_MISMATCH");
    }

    const publishRaceId = randomUUID();
    await insertDraft(publishRaceId, versionNumber + 1);
    const publishRace = await Promise.allSettled([
      service.editDictionaryEntry(validScope, publishRaceId, "SMOKE-ENTRY-1", {
        revision: 1, agent: "Ola", status: "RATE", rate: 35,
      }),
      service.publishDictionary(validScope, publishRaceId, 1),
    ]);
    const raceWinners = publishRace.filter((item) => item.status === "fulfilled");
    const raceLosers = publishRace.filter((item) => item.status === "rejected");
    if (raceWinners.length !== 1 || raceLosers.length !== 1) {
      throw new Error("COMMISSION_DICTIONARY_EDIT_PUBLISH_RACE_NOT_SERIALIZED");
    }
    const finalRace = await readDictionary(publishRaceId);
    const editedCount = await dictionaryAuditCount(publishRaceId, "commission.dictionary.edited");
    const publishedCount = await dictionaryAuditCount(publishRaceId, "commission.dictionary.published");
    const finalRate = finalRace.preset.rules.SMOKE_RULE_OLA.rate;
    if (finalRace.status === "published") {
      if (finalRace.revision !== 1 || editedCount !== 0 || publishedCount !== 1 || finalRate !== 10) {
        throw new Error("COMMISSION_DICTIONARY_PUBLISH_WON_INCONSISTENTLY");
      }
    } else if (finalRace.status === "draft") {
      if (finalRace.revision !== 2 || editedCount !== 1 || publishedCount !== 0 || finalRate !== 35) {
        throw new Error("COMMISSION_DICTIONARY_EDIT_WON_INCONSISTENTLY");
      }
    } else {
      throw new Error("COMMISSION_DICTIONARY_EDIT_PUBLISH_RACE_INVALID_STATE");
    }
    console.log("COMMISSION_DICTIONARY_MUTATIONS_PASS auditRollback=atomic revisionRace=exclusive editPublish=serialized");
  } finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function verifyExecutionLifecycle(sequelize, seed) {
  const { claimRunExecution, commitRunResult, markFailure, publishOutbox } = require("../dist/commission-worker");
  const tenantId = seed.goldisTenantId;
  const ownerUserId = seed.goldisActorId;
  const dictionaryVersionId = randomUUID();
  const now = new Date();
  const versions = await sequelize.query(
    "SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM commission_dictionary_versions WHERE tenant_id=$1",
    { bind: [tenantId], type: QueryTypes.SELECT },
  );
  const snapshotCiphertext = Buffer.from("synthetic-worker-snapshot");
  await sequelize.query(
    `INSERT INTO commission_dictionary_versions
       (dictionary_version_id, tenant_id, version_number, status, is_active, revision, snapshot_ciphertext,
        snapshot_sha256, entry_count, created_by, created_at)
     VALUES ($1,$2,$3,'draft',false,1,$4,$5,0,$6,$7)`,
    { bind: [dictionaryVersionId, tenantId, Number(versions[0].next), snapshotCiphertext,
      createHash("sha256").update(snapshotCiphertext).digest("hex"), ownerUserId, now] },
  );

  async function addRun(dispatchStatus = "published") {
    const runId = randomUUID();
    const dispatchId = randomUUID();
    await sequelize.query(
      `INSERT INTO commission_runs
         (run_id, tenant_id, owner_user_id, start_date, end_date, status, progress_stage, dictionary_version_id,
          engine_version, request_hash, idempotency_key, counters, active_attempt_token, created_at)
       VALUES ($1,$2,$3,'2026-01-01','2026-01-31','queued','queued',$4,'synthetic-engine-v1',$5,$6,'{}'::jsonb,NULL,now())`,
      { bind: [runId, tenantId, ownerUserId, dictionaryVersionId, "0".repeat(64), `commission-smoke-${randomUUID()}`] },
    );
    await sequelize.query(
      `INSERT INTO commission_dispatches
         (dispatch_id, tenant_id, run_id, status, attempt_count, next_attempt_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,0,now(),now(),now())`,
      { bind: [dispatchId, tenantId, runId, dispatchStatus] },
    );
    return { runId, dispatchId };
  }

  async function readRun(runId) {
    const rows = await sequelize.query(
      `SELECT status, active_attempt_token, execution_lease_until, result_sha256
         FROM commission_runs WHERE tenant_id=$1 AND run_id=$2`,
      { bind: [tenantId, runId], type: QueryTypes.SELECT },
    );
    return rows[0];
  }

  async function readDispatch(dispatchId) {
    const rows = await sequelize.query(
      "SELECT status FROM commission_dispatches WHERE tenant_id=$1 AND dispatch_id=$2",
      { bind: [tenantId, dispatchId], type: QueryTypes.SELECT },
    );
    return rows[0];
  }

  async function auditCount(runId, action) {
    const rows = await sequelize.query(
      "SELECT count(*)::integer AS count FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND action=$3",
      { bind: [tenantId, runId, action], type: QueryTypes.SELECT },
    );
    return Number(rows[0].count);
  }

  const parallel = await addRun();
  const claims = await Promise.all([
    claimRunExecution(parallel.dispatchId),
    claimRunExecution(parallel.dispatchId),
  ]);
  if (claims.filter(Boolean).length !== 1) throw new Error("COMMISSION_PARALLEL_CLAIM_NOT_EXCLUSIVE");
  const firstClaim = claims.find(Boolean);
  if (!firstClaim || claims.filter((claim) => claim === null).length !== 1) {
    throw new Error("COMMISSION_PARALLEL_CLAIM_RESULT_INVALID");
  }
  await sequelize.query(
    "UPDATE commission_runs SET execution_lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND run_id=$2",
    { bind: [tenantId, parallel.runId] },
  );
  const recovered = await claimRunExecution(parallel.dispatchId);
  if (!recovered || recovered.active_attempt_token === firstClaim.active_attempt_token) {
    throw new Error("COMMISSION_EXPIRED_LEASE_RECOVERY_FAILED");
  }
  await markFailure(firstClaim, parallel.dispatchId, new Error("STALE_WORKER_FAILURE"), true);
  const staleResult = await commitRunResult(
    firstClaim, parallel.dispatchId, firstClaim.active_attempt_token, Buffer.from("stale-ciphertext"),
    Buffer.from("stale-result"), { report_records: 1 },
  );
  if (staleResult !== "obsolete" || (await readRun(parallel.runId)).active_attempt_token !== recovered.active_attempt_token) {
    throw new Error("COMMISSION_STALE_ATTEMPT_FENCE_FAILED");
  }

  const publish = await addRun();
  const publishClaim = await claimRunExecution(publish.dispatchId);
  if (!publishClaim) throw new Error("COMMISSION_PUBLISH_CLAIM_FAILED");
  const bytes = Buffer.from('{"synthetic":true}');
  const ciphertext = Buffer.from("synthetic-encrypted-result");
  const summary = { report_records: 1, missing_policies: 0, candidate_policies: 0, wrong_rate_rows: 0, unverified_rate_rows: 0 };
  const badActor = { ...publishClaim, owner_user_id: randomUUID() };
  let auditFailureObserved = false;
  try {
    await commitRunResult(badActor, publish.dispatchId, publishClaim.active_attempt_token, ciphertext, bytes, summary);
  } catch {
    auditFailureObserved = true;
  }
  if (!auditFailureObserved) throw new Error("COMMISSION_PUBLICATION_AUDIT_FAILURE_NOT_OBSERVED");
  const rolledBack = await readRun(publish.runId);
  const rolledBackSnapshots = await sequelize.query(
    "SELECT count(*)::integer AS count FROM commission_run_snapshots WHERE run_id=$1",
    { bind: [publish.runId], type: QueryTypes.SELECT },
  );
  if (rolledBack.status !== "running" || rolledBack.result_sha256 !== null || Number(rolledBackSnapshots[0].count) !== 0
      || (await readDispatch(publish.dispatchId)).status !== "published"
      || await auditCount(publish.runId, "commission.run.completed") !== 0) {
    throw new Error("COMMISSION_PUBLICATION_NOT_ATOMIC");
  }
  if (await commitRunResult(publishClaim, publish.dispatchId, publishClaim.active_attempt_token, ciphertext, bytes, summary) !== "completed") {
    throw new Error("COMMISSION_PUBLICATION_COMMIT_FAILED");
  }
  const completed = await readRun(publish.runId);
  const committedSnapshots = await sequelize.query(
    "SELECT count(*)::integer AS count FROM commission_run_snapshots WHERE run_id=$1",
    { bind: [publish.runId], type: QueryTypes.SELECT },
  );
  if (completed.status !== "completed" || Number(committedSnapshots[0].count) !== 1
      || (await readDispatch(publish.dispatchId)).status !== "completed"
      || await auditCount(publish.runId, "commission.run.completed") !== 1) {
    throw new Error("COMMISSION_PUBLICATION_STATE_MISMATCH");
  }
  if (await claimRunExecution(publish.dispatchId) !== null) throw new Error("COMMISSION_TERMINAL_REPLAY_CLAIMED");
  await markFailure(publishClaim, publish.dispatchId, new Error("STALE_TERMINAL_FAILURE"), true);
  if ((await readRun(publish.runId)).status !== "completed" || await auditCount(publish.runId, "commission.run.failed") !== 0) {
    throw new Error("COMMISSION_TERMINAL_RUN_WAS_OVERWRITTEN");
  }

  const cancel = await addRun();
  const cancelClaim = await claimRunExecution(cancel.dispatchId);
  if (!cancelClaim) throw new Error("COMMISSION_CANCEL_CLAIM_FAILED");
  await sequelize.query(
    "UPDATE commission_runs SET status='cancel_requested', progress_stage='cancel_requested' WHERE tenant_id=$1 AND run_id=$2",
    { bind: [tenantId, cancel.runId] },
  );
  const cancelResult = await commitRunResult(
    cancelClaim, cancel.dispatchId, cancelClaim.active_attempt_token, ciphertext, bytes, summary,
  );
  const cancelled = await readRun(cancel.runId);
  const cancelledSnapshots = await sequelize.query(
    "SELECT count(*)::integer AS count FROM commission_run_snapshots WHERE run_id=$1",
    { bind: [cancel.runId], type: QueryTypes.SELECT },
  );
  if (cancelResult !== "cancelled" || cancelled.status !== "cancelled" || Number(cancelledSnapshots[0].count) !== 0
      || (await readDispatch(cancel.dispatchId)).status !== "cancelled"
      || await auditCount(cancel.runId, "commission.run.cancelled") !== 1) {
    throw new Error("COMMISSION_CANCEL_PUBLICATION_RACE_FAILED");
  }
  await verifyBullOutbox({ sequelize, seed, addRun, readRun, readDispatch, claimRunExecution, publishOutbox });
  console.log("COMMISSION_EXECUTION_LIFECYCLE_PASS concurrentClaims=exclusive recovery=fenced publication=atomic cancel=atomic replay=blocked bullRedelivery=exclusive");
}

async function verifyBullOutbox({ sequelize, seed, addRun, readRun, readDispatch, claimRunExecution, publishOutbox }) {
  const redisUrl = process.env.REDIS_URL;
  if (process.env.GOLDIS_TEST_REDIS_DISPOSABLE !== "1" || !redisUrl) throw new Error("COMMISSION_SMOKE_DISPOSABLE_REDIS_REQUIRED");
  const { Queue, Worker } = require("bullmq");
  const RedisModule = require("ioredis");
  const Redis = RedisModule.default || RedisModule;
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
  const queueName = `commission-security-smoke-${randomUUID()}`;
  const queue = new Queue(queueName, { connection: redis });
  const run = await addRun("pending");
  let firstWorker;
  let secondWorker;
  let firstWorkerRedis;
  let secondWorkerRedis;
  try {
    await publishOutbox(queue);
    const dispatch = await readDispatch(run.dispatchId);
    const row = await sequelize.query(
      "SELECT attempt_count FROM commission_dispatches WHERE tenant_id=$1 AND dispatch_id=$2",
      { bind: [seed.goldisTenantId, run.dispatchId], type: QueryTypes.SELECT },
    );
    const publishedJobId = `${run.dispatchId}-1`;
    const publishedJob = await queue.getJob(publishedJobId);
    if (dispatch.status !== "published" || Number(row[0].attempt_count) !== 1
        || !publishedJob || publishedJob.data.dispatchId !== run.dispatchId) {
      throw new Error("COMMISSION_OUTBOX_JOB_NOT_PUBLISHED");
    }
    await queue.add("compare", { dispatchId: run.dispatchId }, {
      jobId: `${run.dispatchId}-2`, attempts: 1, removeOnComplete: true, removeOnFail: false,
    });

    let completions = 0;
    let claimWinners = 0;
    let processorStarts = 0;
    let resolveBothProcessors;
    const bothProcessorsStarted = new Promise((resolve) => { resolveBothProcessors = resolve; });
    let resolveCompleted;
    let rejectCompleted;
    const completed = new Promise((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    const processor = async (job) => {
      if (job.data.dispatchId !== run.dispatchId) throw new Error("COMMISSION_OUTBOX_PAYLOAD_MISMATCH");
      processorStarts += 1;
      if (processorStarts === 2) resolveBothProcessors();
      await bothProcessorsStarted;
      if (await claimRunExecution(job.data.dispatchId)) claimWinners += 1;
      return { accepted: true };
    };
    firstWorkerRedis = redis.duplicate();
    secondWorkerRedis = redis.duplicate();
    firstWorker = new Worker(queueName, processor, { connection: firstWorkerRedis, concurrency: 1, autorun: false });
    secondWorker = new Worker(queueName, processor, { connection: secondWorkerRedis, concurrency: 1, autorun: false });
    const onCompleted = () => {
      completions += 1;
      if (completions === 2) resolveCompleted();
    };
    const onError = (error) => rejectCompleted(error);
    firstWorker.on("completed", onCompleted);
    secondWorker.on("completed", onCompleted);
    firstWorker.on("error", onError);
    secondWorker.on("error", onError);
    void firstWorker.run().catch(onError);
    void secondWorker.run().catch(onError);
    let timeout;
    try {
      await Promise.race([
        completed,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("COMMISSION_BULL_WORKER_TIMEOUT")), 15_000); }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const state = await readRun(run.runId);
    if (claimWinners !== 1 || state.status !== "running" || !state.active_attempt_token) {
      throw new Error("COMMISSION_BULL_REDELIVERY_NOT_FENCED");
    }
  } finally {
    await firstWorker?.close(true).catch(() => undefined);
    await secondWorker?.close(true).catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await firstWorkerRedis?.quit().catch(() => firstWorkerRedis.disconnect());
    await secondWorkerRedis?.quit().catch(() => secondWorkerRedis.disconnect());
    await redis.quit().catch(() => redis.disconnect());
  }
}
