const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { Pool } = require("pg");

/** Runs only in the migration runner's disposable DB, never against platform data. */
module.exports = async function verifyWorkerExecutionFence(seeded) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: "goldis-fence-regression", max: 4 });
  const { createAuthChallenge, invalidateUncertainAuthChallenge, pauseExpiredAuthChallenge, recordAuthChallengeOutcome } =
    require("../../worker/dist/features/authentication/auth-challenges");
  const { PgPortalActionGate } = require("../../worker/dist/portals/shared/portal-action-gate");
  const leaseFor = (run) => ({ runId: run.runId, ...run.execution, dispatchId: randomUUID(), intentType: "create",
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString() });
  const inputFor = (run, lease) => ({ runId: run.runId, portal: "pzu", accountKey: randomBytes(32).toString("hex"),
    browserSessionId: lease.workerSessionId, returnStep: "pzu_login", expiresAt: new Date(Date.now() + 300000), lease });
  async function replaceExecution(run, client = pool) {
    const executionId = randomUUID();
    await client.query("UPDATE automation_runs SET execution_id=$2, lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1",
      [run.runId, executionId]);
    return { ...leaseFor(run), executionId };
  }
  async function snapshot(runId) {
    const run = await pool.query("SELECT status, last_safe_step, current_auth_challenge_id FROM automation_runs WHERE id=$1", [runId]);
    const challenges = await pool.query("SELECT challenge_id, status, attempt_count FROM auth_challenges WHERE run_id=$1 ORDER BY challenge_id", [runId]);
    const events = await pool.query("SELECT count(*)::int AS count FROM run_events WHERE run_id=$1", [runId]);
    const incidents = await pool.query("SELECT intervention_id, status, reason_code FROM manual_interventions WHERE run_id=$1 ORDER BY intervention_id", [runId]);
    return { run: run.rows, challenges: challenges.rows, events: events.rows, incidents: incidents.rows };
  }
  try {
    const database = (await pool.query("SELECT current_database() AS name")).rows[0].name;
    assert.match(database, /^goldis_migration_smoke_[a-z0-9_]+$/);

    // The old worker waits behind the new owner's UPDATE, then must reject
    // after the row lock is released. This exercises real PostgreSQL locking.
    const run = await seeded("pzu_login");
    const lease = leaseFor(run);
    const blocker = await pool.connect();
    let blockedOutcome;
    try {
      await blocker.query("BEGIN");
      await replaceExecution(run, blocker);
      blockedOutcome = assert.rejects(createAuthChallenge(pool, inputFor(run, lease)), /RUN_EXECUTION_LEASE_LOST/);
      let observedLock = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND application_name='goldis-fence-regression' AND wait_event_type='Lock'
          AND query LIKE '%automation_runs%'`);
        if (waiting.rowCount) { observedLock = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(observedLock, true, "the stale creator must actually wait on the run row lock");
      await blocker.query("COMMIT");
      await blockedOutcome;
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      if (blockedOutcome) await blockedOutcome;
    }
    assert.equal((await snapshot(run.runId)).challenges.length, 0);

    for (const mutation of ["expire", "uncertain", "accepted"]) {
      const smsRun = await seeded("pzu_login");
      const smsLease = leaseFor(smsRun);
      const challenge = await createAuthChallenge(pool, inputFor(smsRun, smsLease));
      if (mutation === "accepted") await pool.query(
        "UPDATE auth_challenges SET status='submitted', attempt_count=1, claimed_at=clock_timestamp() WHERE challenge_id=$1", [challenge.challengeId]);
      const newLease = await replaceExecution(smsRun);
      const before = await snapshot(smsRun.runId);
      const mutate = (owner) => mutation === "expire"
        ? pauseExpiredAuthChallenge(pool, challenge.challengeId, new Date(Date.now() + 360000), owner)
        : mutation === "uncertain" ? invalidateUncertainAuthChallenge(pool, challenge.challengeId, new Date(), owner)
        : recordAuthChallengeOutcome(pool, challenge.challengeId, "accepted", new Date(), owner);
      await assert.rejects(mutate(smsLease), /RUN_EXECUTION_LEASE_LOST/);
      assert.deepEqual(await snapshot(smsRun.runId), before, `${mutation}: stale execution must not change any checkpoint`);
      await mutate(newLease);
      assert.notDeepEqual(await snapshot(smsRun.runId), before, `${mutation}: the current execution can continue`);
    }

    for (const action of ["start", "ufg"]) {
      const actionRun = await seeded(action === "start" ? "compensa_login" : "ufg_verification");
      if (action === "ufg") await pool.query(
        "UPDATE automation_runs SET last_safe_step='compensa_insured_data_saved', external_case_ref='SYNTH-FENCE/1' WHERE id=$1", [actionRun.runId]);
      const oldLease = leaseFor(actionRun);
      let currentLease;
      const staleGate = new PgPortalActionGate(pool, async () => { currentLease = await replaceExecution(actionRun); }, () => oldLease);
      const invoke = (gate) => action === "start"
        ? gate.authorizeStart({ runId: actionRun.runId, sourceRowId: actionRun.sourceRowId, identitySourceRowId: actionRun.sourceRowId, adapterVersion: "fence-fixture-v1" })
        : gate.authorizeUfg({ runId: actionRun.runId, caseReference: "SYNTH-FENCE/1", parserVersion: "fence-fixture-v1" });
      const before = await snapshot(actionRun.runId);
      await assert.rejects(invoke(staleGate), /RUN_EXECUTION_LEASE_LOST/);
      assert.deepEqual(await snapshot(actionRun.runId), before);
      const activeGate = new PgPortalActionGate(pool, undefined, () => currentLease);
      assert.equal(await invoke(activeGate), true);
      assert.equal(await invoke(activeGate), false, "the same action cannot be authorized twice");
    }
    console.log("WORKER_EXECUTION_FENCE_DB_SMOKE_PASS realRowLock=true staleSms=blocked currentSms=allowed staleStart=blocked staleUfg=blocked actionReplay=blocked");
  } finally {
    await pool.end();
  }
};
