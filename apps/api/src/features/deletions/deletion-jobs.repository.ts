import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { QueryTypes, type Transaction } from "sequelize";
import { isResourceTombstoned, isRunDeletionPending } from "../../contracts/deletion-barrier";
import { AutomationRun, ImportBatch, sequelize, User, UserSession } from "../../infrastructure/database/db";
import { recordAuditEvent } from "../audit/public";
import type { SessionPrincipal } from "../auth/public";
import { safeJob } from "./deletion-jobs.contract";
import { appendDeletionJournalIntent } from "./deletion-journal";
import { canDeleteTarget, consumeDeletionStepUpGrant } from "./deletion-step-up";
import { previewFingerprint } from "./deletions.contract";
import { loadPreviewSnapshot } from "./deletions.repository";

export type ClaimedDeletionJob = Readonly<{
  jobId: string;
  tenantId: string;
  targetType: string;
  targetId: string;
  attemptCount: number;
}>;

export type PendingDeletionFile = Readonly<{ fileId: string; storageKey: string }>;

export type DeletionMembership = Readonly<{
  role: string;
  status: string;
  canDeleteData: boolean;
  deletionGrantVersion: number;
}>;

export type DeletionJobRecord = Record<string, unknown>;

export type CreateDeletionJobCommand = Readonly<{
  actor: SessionPrincipal;
  sessionId: string;
  previewId: string;
  idempotencyKey: string;
  token: string;
  tokenHash: string;
  grantId: string;
  now: Date;
  jobId: string;
}>;

type DeletionJob = Readonly<{
  jobId: string;
  tenantId: string;
  actorUserId: string;
  targetType: string;
  targetId: string;
}>;

@Injectable()
export class DeletionJobsRepository {
  async findMembership(
    tenantId: string,
    userId: string,
    transaction?: Transaction,
  ): Promise<DeletionMembership | null> {
    const rows = await sequelize.query<DeletionMembership>(
      `SELECT role, status, can_delete_data AS "canDeleteData", deletion_grant_version AS "deletionGrantVersion"
         FROM tenant_memberships WHERE tenant_id = :tenantId AND user_id = :userId AND status = 'active'
         ${transaction ? "FOR UPDATE" : ""}`,
      { replacements: { tenantId, userId }, type: QueryTypes.SELECT, transaction },
    );
    return rows[0] ?? null;
  }

  findJob(jobId: string, tenantId: string): Promise<DeletionJobRecord[]> {
    return sequelize.query<DeletionJobRecord>(
      `SELECT job_id AS "jobId", tenant_id AS "tenantId", actor_user_id AS "actorUserId", target_type AS "targetType",
              target_id AS "targetId", status, version, attempt_count AS "attemptCount", error_code AS "errorCode",
              created_at AS "createdAt", updated_at AS "updatedAt", finished_at AS "finishedAt"
         FROM deletion_jobs WHERE job_id = :jobId AND tenant_id = :tenantId`,
      { replacements: { jobId, tenantId }, type: QueryTypes.SELECT },
    );
  }

  async countJobFiles(jobId: string): Promise<{ total: number; removed: number }> {
    const rows = await sequelize.query<{ total: number; removed: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'removed')::int AS removed
         FROM deletion_job_files WHERE job_id = :jobId`,
      { replacements: { jobId }, type: QueryTypes.SELECT },
    );
    return rows[0] ?? { total: 0, removed: 0 };
  }

  listJobs(tenantId: string, actorUserId: string, isAdmin: boolean): Promise<DeletionJobRecord[]> {
    const actorFilter = isAdmin ? "" : "AND j.actor_user_id = :actorUserId";
    return sequelize.query<DeletionJobRecord>(
      `SELECT j.job_id AS "jobId", j.target_type AS "targetType", j.target_id AS "targetId", j.status,
              j.version, j.attempt_count AS "attemptCount", j.error_code AS "errorCode",
              j.created_at AS "createdAt", j.updated_at AS "updatedAt", j.finished_at AS "finishedAt",
              count(f.file_id)::int AS "fileCount",
              count(f.file_id) FILTER (WHERE f.state = 'removed')::int AS "filesRemoved"
         FROM deletion_jobs j LEFT JOIN deletion_job_files f ON f.job_id = j.job_id
        WHERE j.tenant_id = :tenantId ${actorFilter}
        GROUP BY j.job_id ORDER BY j.created_at DESC, j.job_id DESC LIMIT 25`,
      { replacements: { tenantId, actorUserId }, type: QueryTypes.SELECT },
    );
  }

  async createJob(input: CreateDeletionJobCommand) {
    const { actor, sessionId, previewId, idempotencyKey, token, tokenHash, grantId, now, jobId } = input;
    return sequelize.transaction(async (transaction) => {
      const lockKey = `${actor.tenantId}:${actor.userId}:${idempotencyKey}`;
      await sequelize.query("SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))", {
        replacements: { lockKey },
        transaction,
      });
      const existingRows = await sequelize.query<Record<string, unknown>>(
        `SELECT job_id AS "jobId", tenant_id AS "tenantId", actor_user_id AS "actorUserId", session_id AS "sessionId",
                preview_id AS "previewId", step_up_grant_id AS "stepUpGrantId", step_up_token_hash AS "stepUpTokenHash",
                target_type AS "targetType", target_id AS "targetId", scope_fingerprint AS "scopeFingerprint",
                status, version, attempt_count AS "attemptCount", error_code AS "errorCode",
                created_at AS "createdAt", updated_at AS "updatedAt", finished_at AS "finishedAt"
           FROM deletion_jobs WHERE tenant_id = :tenantId AND actor_user_id = :actorUserId AND idempotency_key = :idempotencyKey
          FOR UPDATE`,
        {
          replacements: { tenantId: actor.tenantId, actorUserId: actor.userId, idempotencyKey },
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      const existing = existingRows[0];
      if (existing) {
        if (
          existing.sessionId !== sessionId ||
          existing.previewId !== previewId ||
          existing.stepUpGrantId !== grantId ||
          existing.stepUpTokenHash !== tokenHash
        ) {
          throw new ConflictException("Klucz idempotencji był już użyty do innego żądania");
        }
        const fileCounts = await sequelize.query<{ total: number; removed: number }>(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'removed')::int AS removed
             FROM deletion_job_files WHERE job_id = :jobId`,
          { replacements: { jobId: existing.jobId }, type: QueryTypes.SELECT, transaction },
        );
        return safeJob(existing, Number(fileCounts[0]?.total ?? 0), Number(fileCounts[0]?.removed ?? 0));
      }

      const membership = await this.findMembership(actor.tenantId, actor.userId, transaction);
      if (!membership) throw new ForbiddenException("Brak aktywnego dostępu do firmy");
      const user = await User.findByPk(actor.userId, { transaction, lock: transaction.LOCK.UPDATE });
      const session = await UserSession.findOne({
        where: { sessionId: sessionId, userId: actor.userId, tenantId: actor.tenantId, revokedAt: null },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        user?.status !== "active" ||
        user.mustChangePassword ||
        !session ||
        session.expiresAt.getTime() <= now.getTime() ||
        session.credentialRevision !== user.credentialRevision
      ) {
        throw new ConflictException("Sesja lub uprawnienia zmieniły się; odśwież stronę i spróbuj ponownie");
      }
      const previewRows = await sequelize.query<{
        scopeFingerprint: string;
        targetType: "artifact" | "run" | "import" | "tenant";
        targetId: string | null;
        expiresAt: Date;
        stepUpIssuedAt: Date | null;
        consumedAt: Date | null;
        summary: { blockers?: unknown };
      }>(
        `SELECT scope_fingerprint AS "scopeFingerprint", target_type AS "targetType", target_id AS "targetId",
                expires_at AS "expiresAt", step_up_issued_at AS "stepUpIssuedAt", consumed_at AS "consumedAt", summary
           FROM deletion_previews WHERE preview_id = :previewId AND tenant_id = :tenantId
             AND actor_user_id = :actorUserId AND session_id = :sessionId FOR UPDATE`,
        {
          replacements: { previewId, tenantId: actor.tenantId, actorUserId: actor.userId, sessionId: sessionId },
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      const preview = previewRows[0];
      if (
        !preview ||
        new Date(preview.expiresAt).getTime() <= now.getTime() ||
        !preview.stepUpIssuedAt ||
        preview.consumedAt ||
        !["artifact", "run", "import"].includes(preview.targetType) ||
        !preview.targetId ||
        !Array.isArray(preview.summary?.blockers) ||
        preview.summary.blockers.length
      ) {
        throw new ConflictException("Podgląd wygasł, ma blokady, został użyty lub nie obsługuje tego zakresu");
      }
      let importId: string;
      let runIds: string[];
      if (preview.targetType === "import") {
        const batches = await sequelize.query<{ id: string }>(
          `SELECT id FROM import_batches WHERE id = :targetId AND tenant_id = :tenantId FOR UPDATE`,
          {
            replacements: { targetId: preview.targetId, tenantId: actor.tenantId },
            type: QueryTypes.SELECT,
            transaction,
          },
        );
        if (!batches.length) throw new NotFoundException();
        importId = batches[0].id;
        const runs = await sequelize.query<{ id: string }>(
          `SELECT id FROM automation_runs WHERE batch_id = :targetId ORDER BY id FOR UPDATE`,
          { replacements: { targetId: preview.targetId }, type: QueryTypes.SELECT, transaction },
        );
        runIds = runs.map((row) => row.id);
      } else if (preview.targetType === "run") {
        const runs = await sequelize.query<{ id: string; importId: string }>(
          `SELECT r.id, b.id AS "importId" FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
            WHERE r.id = :targetId AND b.tenant_id = :tenantId FOR UPDATE OF b, r`,
          {
            replacements: { targetId: preview.targetId, tenantId: actor.tenantId },
            type: QueryTypes.SELECT,
            transaction,
          },
        );
        if (!runs.length) throw new NotFoundException();
        importId = runs[0].importId;
        runIds = [runs[0].id];
      } else {
        const artifacts = await sequelize.query<{ id: string; importId: string }>(
          `SELECT r.id, b.id AS "importId" FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id
             JOIN import_batches b ON b.id = r.batch_id
            WHERE ea.artifact_id = :targetId AND b.tenant_id = :tenantId FOR UPDATE OF b, r, ea`,
          {
            replacements: { targetId: preview.targetId, tenantId: actor.tenantId },
            type: QueryTypes.SELECT,
            transaction,
          },
        );
        if (!artifacts.length) throw new NotFoundException();
        importId = artifacts[0].importId;
        runIds = [artifacts[0].id];
      }
      const targetAllowed = await canDeleteTarget({
        role: membership.role,
        canDeleteData: membership.canDeleteData,
        targetType: preview.targetType,
        targetId: preview.targetId,
        tenantId: actor.tenantId,
        userId: actor.userId,
        transaction,
      });
      if (!targetAllowed) {
        if (membership.role === "operator") throw new NotFoundException();
        throw new ForbiddenException("Brak odrębnego uprawnienia do usuwania danych");
      }
      let relatedRunDeletionPending = false;
      if (preview.targetType === "artifact")
        relatedRunDeletionPending = await isRunDeletionPending(runIds[0], transaction);
      if (preview.targetType === "import") {
        for (const runId of runIds) {
          if (await isRunDeletionPending(runId, transaction)) {
            relatedRunDeletionPending = true;
            break;
          }
        }
      }
      if (
        (await isResourceTombstoned(preview.targetType, preview.targetId, transaction)) ||
        (await isResourceTombstoned("import", importId, transaction)) ||
        relatedRunDeletionPending
      ) {
        throw new ConflictException("Usunięcie tego zasobu zostało już zlecone");
      }
      const freshSnapshot = await loadPreviewSnapshot({
        targetType: preview.targetType,
        targetId: preview.targetId,
        tenantId: actor.tenantId,
        transaction,
      });
      if (
        previewFingerprint(actor.tenantId, freshSnapshot) !== preview.scopeFingerprint ||
        freshSnapshot.summary.blockers.length
      ) {
        throw new ConflictException("Dane zmieniły się od podglądu albo pojawiła się blokada; utwórz nowy podgląd");
      }
      const artifacts = await sequelize.query<{ artifactId: string; storageKey: string; sha256: string }>(
        `SELECT ea.artifact_id AS "artifactId", ea.storage_key AS "storageKey", ea.sha256
           FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id
           JOIN import_batches b ON b.id = r.batch_id
          WHERE b.tenant_id = :tenantId AND ea.state = 'ready'
            AND ((:targetType = 'run' AND ea.run_id = :targetId)
              OR (:targetType = 'artifact' AND ea.artifact_id = :targetId)
              OR (:targetType = 'import' AND r.batch_id = :targetId))
          ORDER BY ea.artifact_id FOR UPDATE OF ea`,
        {
          replacements: { tenantId: actor.tenantId, targetType: preview.targetType, targetId: preview.targetId },
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      if (
        (preview.targetType !== "import" && !artifacts.length) ||
        (preview.targetType === "artifact" && artifacts.length !== 1)
      ) {
        throw new ConflictException("Plik zmienił stan od podglądu; utwórz nowy podgląd");
      }
      const consumed = await consumeDeletionStepUpGrant({
        token,
        actor,
        previewId,
        credentialRevision: user.credentialRevision,
        deletionGrantVersion: membership.deletionGrantVersion,
        scopeFingerprint: preview.scopeFingerprint,
        now,
        transaction,
      });
      if (!consumed)
        throw new ConflictException(
          "Potwierdzenie wygasło lub zostało już użyte; wykonaj nowy podgląd i potwierdź hasło ponownie",
        );
      const updatedPreview = await sequelize.query(
        `UPDATE deletion_previews SET consumed_at = :now
          WHERE preview_id = :previewId AND consumed_at IS NULL AND expires_at > :now RETURNING preview_id`,
        { replacements: { now, previewId }, type: QueryTypes.SELECT, transaction },
      );
      if (!updatedPreview.length) throw new ConflictException("Podgląd został już użyty; utwórz nowy");
      const summary = {
        targetType: preview.targetType,
        targetId: preview.targetId,
        counts: freshSnapshot.summary.counts,
        blockers: [],
      };
      await sequelize.query(
        `INSERT INTO deletion_jobs
           (job_id, tenant_id, actor_user_id, session_id, idempotency_key, preview_id, step_up_grant_id, step_up_token_hash,
            target_type, target_id, scope_fingerprint, status, version, attempt_count, next_attempt_at, lease_owner,
            lease_expires_at, error_code, summary, created_at, updated_at, finished_at)
         VALUES (:jobId, :tenantId, :actorUserId, :sessionId, :idempotencyKey, :previewId, :grantId, :tokenHash,
            :targetType, :targetId, :fingerprint, 'queued', 1, 0, :now, NULL, NULL, NULL, CAST(:summary AS jsonb), :now, :now, NULL)`,
        {
          replacements: {
            jobId,
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            sessionId: sessionId,
            idempotencyKey,
            previewId,
            grantId: grantId.toLowerCase(),
            tokenHash,
            targetType: preview.targetType,
            targetId: preview.targetId,
            fingerprint: preview.scopeFingerprint,
            summary: JSON.stringify(summary),
            now,
          },
          transaction,
        },
      );
      for (const artifact of artifacts) {
        await sequelize.query(
          `INSERT INTO deletion_job_files (file_id, job_id, artifact_id, storage_key, sha256, state, created_at, removed_at)
           VALUES (:fileId, :jobId, :artifactId, :storageKey, :sha256, 'pending', :now, NULL)`,
          {
            replacements: {
              fileId: randomUUID(),
              jobId,
              artifactId: artifact.artifactId,
              storageKey: artifact.storageKey,
              sha256: artifact.sha256,
              now,
            },
            transaction,
          },
        );
        await sequelize.query(
          `INSERT INTO resource_tombstones (tenant_id, resource_type, resource_id, job_id, state, created_at, completed_at)
           VALUES (:tenantId, 'artifact', :resourceId, :jobId, 'active', :now, NULL)`,
          { replacements: { tenantId: actor.tenantId, resourceId: artifact.artifactId, jobId, now }, transaction },
        );
      }
      if (preview.targetType === "run")
        await sequelize.query(
          `INSERT INTO resource_tombstones (tenant_id, resource_type, resource_id, job_id, state, created_at, completed_at)
           VALUES (:tenantId, 'run', :resourceId, :jobId, 'active', :now, NULL)`,
          { replacements: { tenantId: actor.tenantId, resourceId: preview.targetId, jobId, now }, transaction },
        );
      if (preview.targetType === "import") {
        for (const runId of runIds)
          await sequelize.query(
            `INSERT INTO resource_tombstones (tenant_id, resource_type, resource_id, job_id, state, created_at, completed_at)
           VALUES (:tenantId, 'run', :resourceId, :jobId, 'active', :now, NULL)`,
            { replacements: { tenantId: actor.tenantId, resourceId: runId, jobId, now }, transaction },
          );
        await sequelize.query(
          `INSERT INTO resource_tombstones (tenant_id, resource_type, resource_id, job_id, state, created_at, completed_at)
           VALUES (:tenantId, 'import', :resourceId, :jobId, 'active', :now, NULL)`,
          { replacements: { tenantId: actor.tenantId, resourceId: preview.targetId, jobId, now }, transaction },
        );
      }
      await recordAuditEvent(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "deletion.job.created",
          resourceType: "deletion",
          resourceId: jobId,
          outcome: "succeeded",
          metadata: { targetType: preview.targetType, fileCount: artifacts.length },
        },
        transaction,
      );
      // Write-ahead ordering is intentional: if this file write fails, the database
      // transaction rolls back and no destructive job becomes runnable.
      await appendDeletionJournalIntent(
        {
          jobId,
          tenantId: actor.tenantId,
          targetType: preview.targetType,
          targetId: preview.targetId,
        },
        {
          onAppended: async (entry) => {
            const state = await sequelize.query(
              `UPDATE deletion_journal_state SET applied_sequence = :sequence, applied_hash = :hash, updated_at = :now
            WHERE singleton_id = true AND applied_sequence = :previousSequence AND applied_hash = :previousHash
            RETURNING applied_sequence`,
              {
                replacements: {
                  sequence: entry.sequence,
                  hash: entry.hash,
                  now,
                  previousSequence: entry.sequence - 1,
                  previousHash: entry.previousHash,
                },
                type: QueryTypes.SELECT,
                transaction,
              },
            );
            if (!state.length) throw new Error("DELETION_JOURNAL_DB_STATE_CONFLICT");
          },
        },
      );
      return safeJob(
        {
          jobId,
          targetType: preview.targetType,
          targetId: preview.targetId,
          status: "queued",
          version: 1,
          attemptCount: 0,
          errorCode: null,
          createdAt: now,
          updatedAt: now,
          finishedAt: null,
        },
        artifacts.length,
        0,
      );
    });
  }

  async claim(now: Date, leaseOwner: string, leaseMs: number): Promise<ClaimedDeletionJob | null> {
    return sequelize.transaction(async (transaction) => {
      const rows = await sequelize.query<ClaimedDeletionJob>(
        `SELECT job_id AS "jobId", tenant_id AS "tenantId", target_type AS "targetType", target_id AS "targetId", attempt_count AS "attemptCount"
           FROM deletion_jobs
          WHERE ((status IN ('queued', 'failed_retryable') AND next_attempt_at <= :now)
             OR (status IN ('processing', 'verifying') AND lease_expires_at <= :now))
          ORDER BY created_at, job_id FOR UPDATE SKIP LOCKED LIMIT 1`,
        { replacements: { now }, type: QueryTypes.SELECT, transaction },
      );
      const job = rows[0];
      if (!job) return null;
      const attemptCount = Number(job.attemptCount) + 1;
      await sequelize.query(
        `UPDATE deletion_jobs SET status = 'processing', attempt_count = :attemptCount, version = version + 1,
                lease_owner = :leaseOwner, lease_expires_at = :leaseExpiresAt, updated_at = :now
          WHERE job_id = :jobId`,
        {
          replacements: {
            jobId: job.jobId,
            attemptCount,
            leaseOwner,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            now,
          },
          transaction,
        },
      );
      return { ...job, attemptCount };
    });
  }

  findPendingFiles(jobId: string): Promise<PendingDeletionFile[]> {
    return sequelize.query<PendingDeletionFile>(
      `SELECT file_id AS "fileId", storage_key AS "storageKey" FROM deletion_job_files
        WHERE job_id = :jobId AND state = 'pending' ORDER BY file_id`,
      { replacements: { jobId }, type: QueryTypes.SELECT },
    );
  }

  async markFileRemoved(fileId: string, leaseOwner: string, now: Date) {
    const marked = await sequelize.query(
      `UPDATE deletion_job_files f SET state = 'removed', removed_at = :now
        FROM deletion_jobs j WHERE f.file_id = :fileId AND f.job_id = j.job_id AND j.lease_owner = :leaseOwner
          AND j.status = 'processing' AND f.state = 'pending' RETURNING f.file_id`,
      { replacements: { fileId, leaseOwner, now }, type: QueryTypes.SELECT },
    );
    if (!marked.length) throw new Error("DELETION_JOB_LEASE_LOST");
  }

  async complete(
    jobId: string,
    leaseOwner: string,
    fileCount: number,
    purgeImportResults: (tenantId: string, importId: string, transaction: Transaction) => Promise<void>,
  ) {
    await sequelize.transaction(async (transaction) => {
      const currentRows = await sequelize.query<DeletionJob>(
        `SELECT job_id AS "jobId", tenant_id AS "tenantId", actor_user_id AS "actorUserId", target_type AS "targetType", target_id AS "targetId"
           FROM deletion_jobs WHERE job_id = :jobId AND lease_owner = :leaseOwner AND status = 'processing' FOR UPDATE`,
        { replacements: { jobId, leaseOwner }, type: QueryTypes.SELECT, transaction },
      );
      const current = currentRows[0];
      if (!current) throw new Error("DELETION_JOB_LEASE_LOST");
      const pendingFiles = await sequelize.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM deletion_job_files WHERE job_id = :jobId AND state <> 'removed'`,
        { replacements: { jobId }, type: QueryTypes.SELECT, transaction },
      );
      if (Number(pendingFiles[0]?.count ?? 0) !== 0) throw new Error("DELETION_JOB_FILES_PENDING");
      const now = new Date();
      await sequelize.query(
        `UPDATE deletion_jobs SET status = 'verifying', version = version + 1, updated_at = :now WHERE job_id = :jobId`,
        { replacements: { jobId, now }, transaction },
      );
      let remaining: Array<{ count: number }>;
      if (current.targetType === "run") {
        await AutomationRun.destroy({ where: { id: current.targetId }, transaction });
        remaining = await sequelize.query(
          `SELECT count(*)::int AS count FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
            WHERE r.id = :targetId AND b.tenant_id = :tenantId`,
          {
            replacements: { targetId: current.targetId, tenantId: current.tenantId },
            type: QueryTypes.SELECT,
            transaction,
          },
        );
      } else if (current.targetType === "artifact") {
        await sequelize.query(
          `DELETE FROM export_artifacts ea USING automation_runs r, import_batches b
            WHERE ea.run_id = r.id AND r.batch_id = b.id AND b.tenant_id = :tenantId AND ea.artifact_id = :targetId`,
          {
            replacements: { targetId: current.targetId, tenantId: current.tenantId },
            type: QueryTypes.DELETE,
            transaction,
          },
        );
        remaining = await sequelize.query(
          `SELECT count(*)::int AS count FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id
             JOIN import_batches b ON b.id = r.batch_id WHERE ea.artifact_id = :targetId AND b.tenant_id = :tenantId`,
          {
            replacements: { targetId: current.targetId, tenantId: current.tenantId },
            type: QueryTypes.SELECT,
            transaction,
          },
        );
      } else if (current.targetType === "import") {
        await purgeImportResults(current.tenantId, current.targetId, transaction);
        await ImportBatch.destroy({ where: { id: current.targetId, tenantId: current.tenantId }, transaction });
        remaining = await sequelize.query(
          `SELECT count(*)::int AS count FROM import_batches WHERE id = :targetId AND tenant_id = :tenantId`,
          {
            replacements: { targetId: current.targetId, tenantId: current.tenantId },
            type: QueryTypes.SELECT,
            transaction,
          },
        );
      } else {
        throw new Error("DELETION_SCOPE_UNSUPPORTED");
      }
      if (Number(remaining[0]?.count ?? 0) !== 0) throw new Error("DELETION_JOB_TARGET_REMAINS");
      await sequelize.query(
        `UPDATE resource_tombstones SET state = 'completed', completed_at = :now WHERE job_id = :jobId AND state = 'active'`,
        { replacements: { jobId, now }, transaction },
      );
      await sequelize.query(
        `UPDATE deletion_jobs SET status = 'completed', version = version + 1, lease_owner = NULL,
                lease_expires_at = NULL, error_code = NULL, updated_at = :now, finished_at = :now WHERE job_id = :jobId`,
        { replacements: { jobId, now }, transaction },
      );
      await recordAuditEvent(
        {
          tenantId: current.tenantId,
          actorUserId: current.actorUserId,
          action: "deletion.job.completed",
          resourceType: "deletion",
          resourceId: jobId,
          outcome: "succeeded",
          metadata: { targetType: current.targetType, fileCount },
        },
        transaction,
      );
    });
  }

  async recordFailure(jobId: string, leaseOwner: string, attemptCount: number, now: Date, maxAttempts: number) {
    await sequelize.transaction(async (transaction) => {
      const rows = await sequelize.query<{ tenantId: string; actorUserId: string; status: string }>(
        `SELECT tenant_id AS "tenantId", actor_user_id AS "actorUserId", status FROM deletion_jobs
          WHERE job_id = :jobId AND lease_owner = :leaseOwner FOR UPDATE`,
        { replacements: { jobId, leaseOwner }, type: QueryTypes.SELECT, transaction },
      );
      const job = rows[0];
      if (!job) return;
      const terminal = attemptCount >= maxAttempts;
      await sequelize.query(
        `UPDATE deletion_jobs SET status = :status, version = version + 1, lease_owner = NULL, lease_expires_at = NULL,
                error_code = 'DELETION_REQUIRES_RETRY', next_attempt_at = :nextAttemptAt,
                updated_at = :now, finished_at = :finishedAt WHERE job_id = :jobId`,
        {
          replacements: {
            jobId,
            status: terminal ? "manual_required" : "failed_retryable",
            nextAttemptAt: terminal ? now : new Date(now.getTime() + Math.min(60 * 60_000, 2 ** attemptCount * 5_000)),
            now,
            finishedAt: terminal ? now : null,
          },
          transaction,
        },
      );
      if (terminal) {
        await sequelize.query(
          `UPDATE resource_tombstones SET state = 'manual_required', completed_at = :now WHERE job_id = :jobId AND state = 'active'`,
          { replacements: { jobId, now }, transaction },
        );
        await recordAuditEvent(
          {
            tenantId: job.tenantId,
            actorUserId: job.actorUserId,
            action: "deletion.job.failed",
            resourceType: "deletion",
            resourceId: jobId,
            outcome: "failed",
            metadata: { reason: "manual_required", attempts: attemptCount },
          },
          transaction,
        );
      }
    });
  }
}
