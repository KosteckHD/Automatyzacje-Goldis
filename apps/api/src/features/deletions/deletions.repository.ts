import { Injectable, NotFoundException } from "@nestjs/common";
import { QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../../infrastructure/database/db";
import { recordAuditEvent } from "../audit/public";
import type { DeletionTargetType, PreviewSnapshot } from "./deletions.contract";

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function instant(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("DELETION_PREVIEW_SNAPSHOT_INVALID");
  return date.toISOString();
}
export async function loadPreviewSnapshot(input: {
  targetType: DeletionTargetType;
  targetId: string | null;
  tenantId: string;
  transaction: Transaction;
}): Promise<PreviewSnapshot> {
  const { targetType, targetId, tenantId, transaction } = input;
  const options = { replacements: { targetId, tenantId }, type: QueryTypes.SELECT as const, transaction };
  if (targetType === "artifact") {
    const rows = await sequelize.query<{
      createdAt: Date;
      sha256: string;
      state: string;
      policyCount: number;
      deletionPending: boolean;
    }>(
      `SELECT ea.created_at AS "createdAt", ea.sha256, ea.state, ea.policy_count AS "policyCount",
              EXISTS (SELECT 1 FROM resource_tombstones rt WHERE rt.resource_type = 'artifact'
                       AND rt.resource_id = ea.artifact_id AND rt.state = 'active') AS "deletionPending"
         FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id
         JOIN import_batches b ON b.id = r.batch_id
        WHERE ea.artifact_id = :targetId AND b.tenant_id = :tenantId`,
      options,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException();
    const counts = {
      imports: 0,
      sourceRows: 0,
      runs: 0,
      submissions: 0,
      artifacts: 1,
      files: row.state === "ready" ? 1 : 0,
      activeRuns: 0,
      sharedRunReferences: 0,
    };
    return {
      summary: {
        targetType,
        targetId,
        counts,
        blockers: [
          ...(row.state === "ready" ? [] : ["ARTIFACT_NOT_READY"]),
          ...(row.deletionPending ? ["ARTIFACT_DELETION_PENDING"] : []),
        ],
      },
      sourceVersion: `${instant(row.createdAt)}:${row.sha256}:${row.state}:${number(row.policyCount)}:${row.deletionPending ? "deleting" : "active"}`,
    };
  }

  if (targetType === "run") {
    const rows = await sequelize.query<{
      status: string;
      createdAt: Date;
      updatedAt: Date;
      sourceRows: number;
      artifacts: number;
      readyArtifacts: number;
      pendingArtifacts: number;
      artifactStateDigest: string;
      submissions: number;
      sharedRunReferences: number;
      activeOutbox: number;
      stagedFiles: number;
      deletingArtifacts: number;
    }>(
      `SELECT r.status, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
              (SELECT count(*)::int FROM run_source_rows rs WHERE rs.run_id = r.id) AS "sourceRows",
              (SELECT count(*)::int FROM export_artifacts ea WHERE ea.run_id = r.id) AS artifacts,
              (SELECT count(*)::int FROM export_artifacts ea WHERE ea.run_id = r.id AND ea.state = 'ready') AS "readyArtifacts",
              (SELECT count(*)::int FROM export_artifacts ea WHERE ea.run_id = r.id AND ea.state = 'pending') AS "pendingArtifacts",
              (SELECT md5(COALESCE(string_agg(ea.artifact_id::text || ':' || ea.state || ':' || ea.sha256, ',' ORDER BY ea.artifact_id), '')) FROM export_artifacts ea WHERE ea.run_id = r.id) AS "artifactStateDigest",
              (SELECT count(DISTINCT g.submission_id)::int FROM run_submission_groups g WHERE g.run_id = r.id) AS submissions,
              (SELECT count(DISTINCT sr.batch_id)::int FROM run_source_rows rs
                 JOIN source_rows sr ON sr.id = rs.source_row_id
                WHERE rs.run_id = r.id AND sr.batch_id <> r.batch_id) AS "sharedRunReferences"
              ,(SELECT count(*)::int FROM run_dispatch_outbox o WHERE o.run_id = r.id AND o.status IN ('pending', 'publishing', 'published')) AS "activeOutbox"
              ,(r.staging_file_id IS NOT NULL)::int AS "stagedFiles"
              ,(SELECT count(*)::int FROM export_artifacts ea JOIN resource_tombstones rt
                 ON rt.resource_type = 'artifact' AND rt.resource_id = ea.artifact_id AND rt.state <> 'completed'
                 WHERE ea.run_id = r.id) AS "deletingArtifacts"
         FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
        WHERE r.id = :targetId AND b.tenant_id = :tenantId`,
      options,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException();
    const active = !["completed", "no_matching_policies", "failed", "cancelled"].includes(row.status);
    const counts = {
      imports: 0,
      sourceRows: number(row.sourceRows),
      runs: 1,
      submissions: number(row.submissions),
      artifacts: number(row.artifacts),
      files: number(row.readyArtifacts),
      activeRuns: active ? 1 : 0,
      pendingArtifacts: number(row.pendingArtifacts),
      sharedRunReferences: number(row.sharedRunReferences),
      activeOutbox: number(row.activeOutbox),
      stagedFiles: number(row.stagedFiles),
      deletingArtifacts: number(row.deletingArtifacts),
    };
    const blockers = [
      ...(active ? ["RUN_ACTIVE"] : []),
      ...(counts.submissions ? ["RUN_REFERENCED_BY_SUBMISSION"] : []),
      ...(counts.sharedRunReferences ? ["RUN_SHARED_WITH_OTHER_IMPORT"] : []),
      ...(counts.activeOutbox ? ["RUN_HAS_PENDING_DELIVERY"] : []),
      ...(counts.stagedFiles ? ["RUN_HAS_STAGED_RESULT"] : []),
      ...(counts.pendingArtifacts ? ["RUN_HAS_PENDING_EXPORT"] : []),
      ...(counts.deletingArtifacts ? ["RUN_HAS_PENDING_ARTIFACT_DELETION"] : []),
    ];
    return {
      summary: { targetType, targetId, counts, blockers },
      sourceVersion: `${instant(row.updatedAt)}:${row.status}:${counts.sourceRows}:${counts.submissions}:${counts.artifacts}:${counts.files}:${number(row.pendingArtifacts)}:${row.artifactStateDigest}:${counts.sharedRunReferences}:${counts.activeOutbox}:${counts.stagedFiles}:${counts.deletingArtifacts}`,
    };
  }

  if (targetType === "import") {
    const rows = await sequelize.query<{
      createdAt: Date;
      sha256: string;
      totalRows: number;
      sourceRows: number;
      rowRevisionDigest: string;
      runs: number;
      submissions: number;
      activeRuns: number;
      activeSubmissions: number;
      artifacts: number;
      readyArtifacts: number;
      pendingArtifacts: number;
      activePreparations: number;
      activeWorkflows: number;
      activeEnrichmentJobs: number;
      activePreparedExecutions: number;
      activeOutbox: number;
      stagedFiles: number;
      sharedRunReferences: number;
      deletingRuns: number;
      deletingArtifacts: number;
      importDeletionPending: boolean;
      runStateDigest: string;
      submissionStateDigest: string;
      artifactStateDigest: string;
      resultSets: number;
      businessLeads: number;
      leadAllocations: number;
      notifications: number;
      retainedAssignedLeads: number;
      removedLeads: number;
      missingLeadSnapshots: number;
      resultSetStateDigest: string;
      leadStateDigest: string;
      notificationStateDigest: string;
    }>(
      `SELECT b.created_at AS "createdAt", b.sha256, b.total_rows AS "totalRows",
              (SELECT count(*)::int FROM source_rows sr WHERE sr.batch_id = b.id) AS "sourceRows",
              (SELECT md5(COALESCE(string_agg(sr.id::text || ':' || sr.row_version::text, ',' ORDER BY sr.id), ''))
                 FROM source_rows sr WHERE sr.batch_id = b.id) AS "rowRevisionDigest",
              (SELECT count(*)::int FROM automation_runs r WHERE r.batch_id = b.id) AS runs,
              (SELECT count(*)::int FROM run_submissions s WHERE s.import_batch_id = b.id) AS submissions,
              (SELECT count(*)::int FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id WHERE r.batch_id = b.id) AS artifacts,
              (SELECT count(*)::int FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id WHERE r.batch_id = b.id AND ea.state = 'ready') AS "readyArtifacts",
              (SELECT count(*)::int FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id WHERE r.batch_id = b.id AND ea.state = 'pending') AS "pendingArtifacts",
              (SELECT count(*)::int FROM automation_runs r WHERE r.batch_id = b.id
                 AND r.status NOT IN ('completed', 'no_matching_policies', 'failed', 'cancelled')) AS "activeRuns",
              (SELECT count(*)::int FROM run_submissions s WHERE s.import_batch_id = b.id AND s.status IN ('queued', 'running', 'waiting_attention')) AS "activeSubmissions",
              (SELECT count(*)::int FROM import_preparations p WHERE p.batch_id = b.id AND p.status IN ('queued', 'processing', 'waiting_registry')) AS "activePreparations",
              (SELECT count(*)::int FROM import_preparation_workflows w WHERE w.batch_id = b.id AND w.status IN ('queued', 'starting_registry', 'waiting_registry', 'starting_reanalysis', 'waiting_reanalysis')) AS "activeWorkflows",
              (SELECT count(*)::int FROM enrichment_jobs j WHERE j.batch_id = b.id AND j.status IN ('queued', 'processing')) AS "activeEnrichmentJobs",
              (SELECT count(*)::int FROM prepared_set_executions e WHERE e.batch_id = b.id AND e.status IN ('queued', 'running', 'waiting_attention')) AS "activePreparedExecutions",
              (SELECT count(*)::int FROM run_dispatch_outbox o JOIN automation_runs r ON r.id = o.run_id WHERE r.batch_id = b.id AND o.status IN ('pending', 'publishing', 'published')) AS "activeOutbox",
              (SELECT count(*)::int FROM automation_runs r WHERE r.batch_id = b.id AND r.staging_file_id IS NOT NULL) AS "stagedFiles",
              (SELECT count(*)::int FROM automation_runs r JOIN resource_tombstones rt
                 ON rt.tenant_id = b.tenant_id AND rt.resource_type = 'run' AND rt.resource_id = r.id AND rt.state <> 'completed'
                WHERE r.batch_id = b.id) AS "deletingRuns",
              (SELECT count(*)::int FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id JOIN resource_tombstones rt
                 ON rt.tenant_id = b.tenant_id AND rt.resource_type = 'artifact' AND rt.resource_id = ea.artifact_id AND rt.state <> 'completed'
                WHERE r.batch_id = b.id) AS "deletingArtifacts",
              EXISTS (SELECT 1 FROM resource_tombstones rt WHERE rt.tenant_id = b.tenant_id
                AND rt.resource_type = 'import' AND rt.resource_id = b.id AND rt.state <> 'completed') AS "importDeletionPending",
              (SELECT count(DISTINCT r.id)::int FROM source_rows owned
                 JOIN run_source_rows rs ON rs.source_row_id = owned.id
                 JOIN automation_runs r ON r.id = rs.run_id
                WHERE owned.batch_id = b.id AND r.batch_id <> b.id) AS "sharedRunReferences",
              (SELECT md5(COALESCE(string_agg(r.id::text || ':' || r.status || ':' || r.updated_at::text, ',' ORDER BY r.id), ''))
                 FROM automation_runs r WHERE r.batch_id = b.id) AS "runStateDigest",
              (SELECT md5(COALESCE(string_agg(s.submission_id::text || ':' || s.status || ':' || s.updated_at::text, ',' ORDER BY s.submission_id), ''))
                 FROM run_submissions s WHERE s.import_batch_id = b.id) AS "submissionStateDigest",
              (SELECT md5(COALESCE(string_agg(ea.artifact_id::text || ':' || ea.state || ':' || ea.sha256, ',' ORDER BY ea.artifact_id), ''))
                 FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id WHERE r.batch_id = b.id) AS "artifactStateDigest",
              (SELECT count(*)::int FROM result_sets rs WHERE rs.tenant_id = b.tenant_id AND rs.batch_id = b.id) AS "resultSets",
              (SELECT count(*)::int FROM business_leads lead JOIN result_sets rs ON rs.result_set_id = lead.result_set_id AND rs.tenant_id = lead.tenant_id
                WHERE rs.tenant_id = b.tenant_id AND rs.batch_id = b.id) AS "businessLeads",
              (SELECT count(*)::int FROM business_leads lead JOIN result_sets rs ON rs.result_set_id = lead.result_set_id AND rs.tenant_id = lead.tenant_id
                WHERE rs.tenant_id = b.tenant_id AND rs.batch_id = b.id AND lead.assigned_to_user_id IS NOT NULL
                  AND lead.assigned_to_user_id <> COALESCE(b.owner_user_id, rs.actor_user_id)) AS "retainedAssignedLeads",
              (SELECT count(*)::int FROM business_leads lead JOIN result_sets rs ON rs.result_set_id = lead.result_set_id AND rs.tenant_id = lead.tenant_id
                WHERE rs.tenant_id = b.tenant_id AND rs.batch_id = b.id AND (lead.assigned_to_user_id IS NULL
                  OR lead.assigned_to_user_id = COALESCE(b.owner_user_id, rs.actor_user_id))) AS "removedLeads",
              (SELECT count(*)::int FROM business_leads lead JOIN result_sets rs ON rs.result_set_id = lead.result_set_id AND rs.tenant_id = lead.tenant_id
                WHERE rs.tenant_id = b.tenant_id AND rs.batch_id = b.id AND lead.assigned_to_user_id IS NOT NULL
                  AND lead.assigned_to_user_id <> COALESCE(b.owner_user_id, rs.actor_user_id)
                  AND (lead.result_status <> 'ready'
                    OR NOT EXISTS (SELECT 1 FROM lead_result_snapshots saved WHERE saved.lead_id = lead.lead_id)
                    OR EXISTS (SELECT 1 FROM lead_run_links link
                      JOIN run_submission_groups grp ON grp.group_id = link.group_id AND grp.tenant_id = link.tenant_id
                      JOIN automation_runs run ON run.id = grp.run_id
                      JOIN oc_snapshots oc ON oc.run_id = run.id AND oc.total_count > 0
                     WHERE link.lead_id = lead.lead_id AND link.tenant_id = lead.tenant_id AND run.status = 'completed'
                       AND NOT EXISTS (SELECT 1 FROM lead_result_snapshots snap
                         WHERE snap.lead_id = lead.lead_id AND snap.original_run_id = run.id)))) AS "missingLeadSnapshots",
              (SELECT count(*)::int FROM lead_allocations allocation
                WHERE allocation.tenant_id = b.tenant_id AND allocation.assigned_lead_ids ?| ARRAY(
                  SELECT lead.lead_id::text FROM business_leads lead JOIN result_sets rs
                    ON rs.result_set_id = lead.result_set_id AND rs.tenant_id = lead.tenant_id
                   WHERE rs.tenant_id = b.tenant_id AND rs.batch_id = b.id)) AS "leadAllocations",
              (SELECT count(*)::int FROM user_notifications notification JOIN result_sets rs
                ON rs.result_set_id = notification.result_set_id AND rs.tenant_id = notification.tenant_id
               WHERE rs.tenant_id = b.tenant_id AND rs.batch_id = b.id) AS notifications,
              (SELECT md5(COALESCE(string_agg(rs.result_set_id::text || ':' || rs.status || ':' || rs.updated_at::text, ',' ORDER BY rs.result_set_id), ''))
                 FROM result_sets rs WHERE rs.tenant_id = b.tenant_id AND rs.batch_id = b.id) AS "resultSetStateDigest",
              (SELECT md5(COALESCE(string_agg(lead.lead_id::text || ':' || lead.contact_status || ':' || lead.contact_status_version::text || ':' || COALESCE(lead.assigned_to_user_id::text, '') || ':' || lead.updated_at::text, ',' ORDER BY lead.lead_id), ''))
                 FROM business_leads lead JOIN result_sets rs ON rs.result_set_id = lead.result_set_id AND rs.tenant_id = lead.tenant_id
                WHERE rs.tenant_id = b.tenant_id AND rs.batch_id = b.id) AS "leadStateDigest",
              (SELECT md5(COALESCE(string_agg(notification.notification_id::text || ':' || COALESCE(notification.read_at::text, ''), ',' ORDER BY notification.notification_id), ''))
                 FROM user_notifications notification JOIN result_sets rs
                   ON rs.result_set_id = notification.result_set_id AND rs.tenant_id = notification.tenant_id
                WHERE rs.tenant_id = b.tenant_id AND rs.batch_id = b.id) AS "notificationStateDigest"
         FROM import_batches b WHERE b.id = :targetId AND b.tenant_id = :tenantId`,
      options,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException();
    const counts = {
      imports: 1,
      sourceRows: number(row.sourceRows),
      runs: number(row.runs),
      submissions: number(row.submissions),
      artifacts: number(row.artifacts),
      files: number(row.readyArtifacts),
      activeRuns: number(row.activeRuns),
      activeSubmissions: number(row.activeSubmissions),
      activePreparations: number(row.activePreparations),
      activeWorkflows: number(row.activeWorkflows),
      activeEnrichmentJobs: number(row.activeEnrichmentJobs),
      activePreparedExecutions: number(row.activePreparedExecutions),
      activeOutbox: number(row.activeOutbox),
      pendingArtifacts: number(row.pendingArtifacts),
      stagedFiles: number(row.stagedFiles),
      sharedRunReferences: number(row.sharedRunReferences),
      deletingRuns: number(row.deletingRuns),
      deletingArtifacts: number(row.deletingArtifacts),
      resultSets: number(row.resultSets),
      businessLeads: number(row.businessLeads),
      retainedAssignedLeads: number(row.retainedAssignedLeads),
      removedLeads: number(row.removedLeads),
      missingLeadSnapshots: number(row.missingLeadSnapshots),
      leadAllocations: number(row.leadAllocations),
      notifications: number(row.notifications),
    };
    const blockers = [
      ...(counts.activeRuns ? ["IMPORT_HAS_ACTIVE_RUNS"] : []),
      ...(counts.missingLeadSnapshots ? ["IMPORT_LEAD_SNAPSHOT_INCOMPLETE"] : []),
      ...(counts.activePreparations ? ["IMPORT_HAS_ACTIVE_PREPARATION"] : []),
      ...(counts.activeWorkflows ? ["IMPORT_HAS_ACTIVE_PREPARATION_WORKFLOW"] : []),
      ...(counts.activeEnrichmentJobs ? ["IMPORT_HAS_ACTIVE_ENRICHMENT"] : []),
      ...(counts.activePreparedExecutions ? ["IMPORT_HAS_ACTIVE_SET_EXECUTION"] : []),
      ...(counts.activeSubmissions ? ["IMPORT_HAS_ACTIVE_SUBMISSION"] : []),
      ...(counts.activeOutbox ? ["IMPORT_HAS_PENDING_DELIVERY"] : []),
      ...(counts.pendingArtifacts ? ["IMPORT_HAS_PENDING_EXPORT"] : []),
      ...(counts.stagedFiles ? ["IMPORT_HAS_STAGED_RESULT"] : []),
      ...(counts.sharedRunReferences ? ["IMPORT_HAS_SHARED_RUN_REFERENCES"] : []),
      ...(row.importDeletionPending ? ["IMPORT_DELETION_PENDING"] : []),
      ...(counts.deletingRuns ? ["IMPORT_HAS_PENDING_RUN_DELETION"] : []),
      ...(counts.deletingArtifacts ? ["IMPORT_HAS_PENDING_ARTIFACT_DELETION"] : []),
    ];
    return {
      summary: { targetType, targetId, counts, blockers },
      sourceVersion: `${instant(row.createdAt)}:${row.sha256}:${number(row.totalRows)}:${row.rowRevisionDigest}:${counts.runs}:${counts.submissions}:${counts.artifacts}:${counts.activeRuns}:${counts.activeSubmissions}:${counts.activePreparations}:${counts.activeWorkflows}:${counts.activeEnrichmentJobs}:${counts.activePreparedExecutions}:${counts.activeOutbox}:${counts.pendingArtifacts}:${counts.stagedFiles}:${counts.sharedRunReferences}:${counts.deletingRuns}:${counts.deletingArtifacts}:${counts.resultSets}:${counts.businessLeads}:${counts.retainedAssignedLeads}:${counts.removedLeads}:${counts.missingLeadSnapshots}:${counts.leadAllocations}:${counts.notifications}:${row.importDeletionPending ? "deleting" : "active"}:${row.runStateDigest}:${row.submissionStateDigest}:${row.artifactStateDigest}:${row.resultSetStateDigest}:${row.leadStateDigest}:${row.notificationStateDigest}`,
    };
  }

  const rows = await sequelize.query<{
    imports: number;
    sourceRows: number;
    rowRevisionDigest: string;
    runs: number;
    submissions: number;
    artifacts: number;
    readyArtifacts: number;
    activeRuns: number;
    activeSubmissions: number;
    activePreparations: number;
    activeWorkflows: number;
    activeEnrichmentJobs: number;
    activePreparedExecutions: number;
    activeOutbox: number;
    pendingArtifacts: number;
    stagedFiles: number;
    crossTenantRunReferences: number;
    runStateDigest: string;
    submissionStateDigest: string;
    artifactStateDigest: string;
  }>(
    `SELECT
       (SELECT count(*)::int FROM import_batches b WHERE b.tenant_id = :tenantId) AS imports,
       (SELECT count(*)::int FROM source_rows sr JOIN import_batches b ON b.id = sr.batch_id WHERE b.tenant_id = :tenantId) AS "sourceRows",
       (SELECT md5(COALESCE(string_agg(sr.id::text || ':' || sr.row_version::text, ',' ORDER BY sr.id), ''))
          FROM source_rows sr JOIN import_batches b ON b.id = sr.batch_id WHERE b.tenant_id = :tenantId) AS "rowRevisionDigest",
       (SELECT count(*)::int FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId) AS runs,
       (SELECT count(*)::int FROM run_submissions s WHERE s.tenant_id = :tenantId) AS submissions,
       (SELECT count(*)::int FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId) AS artifacts,
       (SELECT count(*)::int FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId AND ea.state = 'ready') AS "readyArtifacts",
       (SELECT count(*)::int FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
         WHERE b.tenant_id = :tenantId AND r.status NOT IN ('completed', 'no_matching_policies', 'failed', 'cancelled')) AS "activeRuns",
       (SELECT count(*)::int FROM run_submissions s WHERE s.tenant_id = :tenantId AND s.status IN ('queued', 'running', 'waiting_attention')) AS "activeSubmissions",
       (SELECT count(*)::int FROM import_preparations p WHERE p.tenant_id = :tenantId AND p.status IN ('queued', 'processing', 'waiting_registry')) AS "activePreparations",
       (SELECT count(*)::int FROM import_preparation_workflows w WHERE w.tenant_id = :tenantId AND w.status IN ('queued', 'starting_registry', 'waiting_registry', 'starting_reanalysis', 'waiting_reanalysis')) AS "activeWorkflows",
       (SELECT count(*)::int FROM enrichment_jobs j WHERE j.tenant_id = :tenantId AND j.status IN ('queued', 'processing')) AS "activeEnrichmentJobs",
       (SELECT count(*)::int FROM prepared_set_executions e WHERE e.tenant_id = :tenantId AND e.status IN ('queued', 'running', 'waiting_attention')) AS "activePreparedExecutions",
       (SELECT count(*)::int FROM run_dispatch_outbox o JOIN automation_runs r ON r.id = o.run_id JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId AND o.status IN ('pending', 'publishing', 'published')) AS "activeOutbox",
       (SELECT count(*)::int FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId AND ea.state = 'pending') AS "pendingArtifacts",
       (SELECT count(*)::int FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId AND r.staging_file_id IS NOT NULL) AS "stagedFiles",
       (SELECT count(DISTINCT r.id)::int FROM source_rows sr JOIN import_batches owned ON owned.id = sr.batch_id
          JOIN run_source_rows rs ON rs.source_row_id = sr.id JOIN automation_runs r ON r.id = rs.run_id
          JOIN import_batches run_batch ON run_batch.id = r.batch_id
         WHERE owned.tenant_id = :tenantId AND run_batch.tenant_id <> :tenantId) AS "crossTenantRunReferences",
       (SELECT md5(COALESCE(string_agg(r.id::text || ':' || r.status || ':' || r.updated_at::text, ',' ORDER BY r.id), ''))
          FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId) AS "runStateDigest",
       (SELECT md5(COALESCE(string_agg(s.submission_id::text || ':' || s.status || ':' || s.updated_at::text, ',' ORDER BY s.submission_id), ''))
          FROM run_submissions s WHERE s.tenant_id = :tenantId) AS "submissionStateDigest",
       (SELECT md5(COALESCE(string_agg(ea.artifact_id::text || ':' || ea.state || ':' || ea.sha256, ',' ORDER BY ea.artifact_id), ''))
          FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId) AS "artifactStateDigest"`,
    { replacements: { tenantId }, type: QueryTypes.SELECT, transaction },
  );
  const row = rows[0];
  if (!row) throw new Error("DELETION_PREVIEW_TENANT_SNAPSHOT_MISSING");
  const counts = {
    imports: number(row.imports),
    sourceRows: number(row.sourceRows),
    runs: number(row.runs),
    submissions: number(row.submissions),
    artifacts: number(row.artifacts),
    files: number(row.readyArtifacts),
    activeRuns: number(row.activeRuns),
    activeSubmissions: number(row.activeSubmissions),
    activePreparations: number(row.activePreparations),
    activeWorkflows: number(row.activeWorkflows),
    activeEnrichmentJobs: number(row.activeEnrichmentJobs),
    activePreparedExecutions: number(row.activePreparedExecutions),
    activeOutbox: number(row.activeOutbox),
    pendingArtifacts: number(row.pendingArtifacts),
    stagedFiles: number(row.stagedFiles),
    sharedRunReferences: number(row.crossTenantRunReferences),
  };
  const blockers = [
    ...(counts.activeRuns ? ["TENANT_HAS_ACTIVE_RUNS"] : []),
    ...(counts.activeSubmissions ? ["TENANT_HAS_ACTIVE_SUBMISSIONS"] : []),
    ...(counts.activePreparations ? ["TENANT_HAS_ACTIVE_PREPARATIONS"] : []),
    ...(counts.activeWorkflows ? ["TENANT_HAS_ACTIVE_PREPARATION_WORKFLOWS"] : []),
    ...(counts.activeEnrichmentJobs ? ["TENANT_HAS_ACTIVE_ENRICHMENT"] : []),
    ...(counts.activePreparedExecutions ? ["TENANT_HAS_ACTIVE_SET_EXECUTIONS"] : []),
    ...(counts.activeOutbox ? ["TENANT_HAS_PENDING_DELIVERIES"] : []),
    ...(counts.pendingArtifacts ? ["TENANT_HAS_PENDING_EXPORTS"] : []),
    ...(counts.stagedFiles ? ["TENANT_HAS_STAGED_RESULTS"] : []),
    ...(counts.sharedRunReferences ? ["TENANT_HAS_CROSS_SCOPE_RUN_REFERENCES"] : []),
  ];
  return {
    summary: { targetType, targetId: null, counts, blockers },
    sourceVersion: `${row.rowRevisionDigest}:${counts.imports}:${counts.sourceRows}:${counts.runs}:${counts.submissions}:${counts.artifacts}:${counts.activeRuns}:${counts.activeSubmissions}:${counts.activePreparations}:${counts.activeWorkflows}:${counts.activeEnrichmentJobs}:${counts.activePreparedExecutions}:${counts.activeOutbox}:${counts.pendingArtifacts}:${counts.stagedFiles}:${row.runStateDigest}:${row.submissionStateDigest}:${row.artifactStateDigest}:${counts.sharedRunReferences}`,
  };
}
@Injectable()
export class DeletionsPreviewRepository {
  loadSnapshot(input: Parameters<typeof loadPreviewSnapshot>[0]): Promise<PreviewSnapshot> {
    return loadPreviewSnapshot(input);
  }

  withRepeatableRead<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async (transaction) => work(transaction),
    );
  }

  async findMembership(tenantId: string, userId: string): Promise<{ role: string; canDeleteData: boolean } | null> {
    const memberships = await sequelize.query<{ role: string; canDeleteData: boolean }>(
      `SELECT role, can_delete_data AS "canDeleteData" FROM tenant_memberships
        WHERE tenant_id = :tenantId AND user_id = :userId AND status = 'active'`,
      { replacements: { tenantId, userId }, type: QueryTypes.SELECT },
    );
    return memberships[0] ?? null;
  }

  async replacePreview(
    input: {
      previewId: string;
      tenantId: string;
      actorUserId: string;
      sessionId: string;
      targetType: DeletionTargetType;
      targetId: string | null;
      fingerprint: string;
      snapshot: PreviewSnapshot;
      now: Date;
      expiresAt: Date;
    },
    transaction: Transaction,
  ): Promise<void> {
    await sequelize.query(
      `DELETE FROM deletion_previews
        WHERE expires_at <= :now OR consumed_at IS NOT NULL
           OR (session_id = :sessionId AND tenant_id = :tenantId AND actor_user_id = :actorUserId)`,
      {
        replacements: {
          now: input.now,
          sessionId: input.sessionId,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
        },
        transaction,
      },
    );
    await sequelize.query(
      `INSERT INTO deletion_previews
       (preview_id, tenant_id, actor_user_id, session_id, target_type, target_id, scope_fingerprint,
        summary, created_at, expires_at, step_up_issued_at, consumed_at)
       VALUES (:previewId, :tenantId, :actorUserId, :sessionId, :targetType, :targetId, :fingerprint,
        CAST(:summary AS jsonb), :now, :expiresAt, NULL, NULL)`,
      {
        replacements: {
          previewId: input.previewId,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          sessionId: input.sessionId,
          targetType: input.targetType,
          targetId: input.targetId,
          fingerprint: input.fingerprint,
          summary: JSON.stringify(input.snapshot.summary),
          now: input.now,
          expiresAt: input.expiresAt,
        },
        transaction,
      },
    );
    await recordAuditEvent(
      {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: "deletion.preview.created",
        resourceType: "deletion",
        resourceId: input.previewId,
        outcome: "succeeded",
        metadata: {
          targetType: input.targetType,
          blockerCount: input.snapshot.summary.blockers.length,
          expiresAt: input.expiresAt.toISOString(),
        },
      },
      transaction,
    );
  }
}
