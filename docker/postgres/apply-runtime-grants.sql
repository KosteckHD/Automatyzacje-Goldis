-- Versioned allowlist. Run as goldis_migrator after every database migration.
-- A new table receives no runtime rights until it is reviewed here.

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment;
GRANT USAGE ON SCHEMA public TO goldis_api, goldis_worker, goldis_enrichment;

-- API is the application authorization boundary. It owns user/team, import,
-- run orchestration, result, deletion and audit operations. Append-only logs
-- are excluded from UPDATE/DELETE below.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  tenants, users, user_sessions, tenant_memberships, tools, tool_grants, tool_settings,
  auth_challenges, import_batches, source_rows, run_submissions, run_submission_items,
  run_submission_groups, run_source_rows, automation_runs, run_dispatch_outbox, run_identities,
  run_manual_data_overrides, manual_interventions, oc_policies, oc_snapshots, result_sets,
  export_artifacts, intervention_activity, intervention_user_reads,
  import_preparations, import_prepared_rows, import_preparation_workflows,
  import_preparation_workflow_jobs, prepared_set_chunks, prepared_set_executions,
  canonical_entities, source_entity_links, entity_grouping_conflicts, regon_corrections,
  regon_enrichment_audits, registry_lookup_cache,
  enrichment_jobs, enrichment_job_items,
  deletion_previews, deletion_jobs, deletion_job_files, deletion_journal_state,
  deletion_step_up_grants, privileged_action_confirmations, account_recovery_tokens, auth_mail_outbox, run_control_requests, lead_allocations, lead_result_snapshots,
  lead_run_links, business_leads, user_notifications, resource_tombstones
TO goldis_api;

-- These tables are append-only from the runtime application; deletion is handled
-- by explicit journaled routines and does not grant general log mutation.
GRANT SELECT, INSERT ON TABLE audit_events, run_events TO goldis_api;
GRANT INSERT ON TABLE audit_events TO goldis_enrichment;
GRANT EXECUTE ON FUNCTION audit_metadata_has_sensitive_key(jsonb) TO goldis_enrichment;

-- Health endpoints may read worker state. Only the owning process writes it.
GRANT SELECT ON TABLE worker_runtime_status, enrichment_worker_runtime_status TO goldis_api;
-- Admin operations summary includes the registry providers' current daily budget.
GRANT SELECT ON TABLE registry_provider_daily_budgets TO goldis_api;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO goldis_api;

-- Portal worker: only run execution, its dispatch/checkpoint data and SMS/manual
-- intervention state. No access to user/session/tenant/team/permission tables.
GRANT SELECT, UPDATE ON TABLE automation_runs TO goldis_worker;
GRANT SELECT ON TABLE source_rows, run_source_rows, run_manual_data_overrides, oc_snapshots TO goldis_worker;
-- The deletion-barrier trigger reads these keys while the worker updates a run.
GRANT SELECT (id, tenant_id) ON TABLE import_batches TO goldis_worker;
GRANT SELECT (tombstone_id, tenant_id, resource_type, resource_id, state) ON TABLE resource_tombstones TO goldis_worker, goldis_enrichment;
GRANT SELECT, INSERT, UPDATE ON TABLE run_identities TO goldis_worker;
GRANT SELECT, INSERT ON TABLE run_events TO goldis_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE manual_interventions, auth_challenges, run_dispatch_outbox TO goldis_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE worker_runtime_status TO goldis_worker;

-- Registry worker: queue/job state, source identity fields, narrowly selected
-- authorization columns, registry evidence/cache and canonical grouping only.
GRANT SELECT, UPDATE ON TABLE enrichment_jobs TO goldis_enrichment;
GRANT SELECT, UPDATE ON TABLE enrichment_job_items, enrichment_worker_slots TO goldis_enrichment;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE enrichment_worker_runtime_status TO goldis_enrichment;
GRANT SELECT ON TABLE import_batches, automation_runs, run_source_rows TO goldis_enrichment;
-- PostgreSQL requires UPDATE on at least one column for SELECT ... FOR SHARE/UPDATE.
-- Locked-false markers give the worker only no-op row-lock capabilities, not domain-data mutation.
GRANT UPDATE (enrichment_worker_lock_capability) ON TABLE
  import_batches, users, tenant_memberships, tools, tool_grants,
  automation_runs, regon_corrections, entity_grouping_conflicts, source_entity_links
TO goldis_enrichment;
GRANT SELECT (user_id, status) ON TABLE users TO goldis_enrichment;
GRANT SELECT (tenant_id, user_id, role, status) ON TABLE tenant_memberships TO goldis_enrichment;
GRANT SELECT (tool_id, status) ON TABLE tools TO goldis_enrichment;
GRANT SELECT (tenant_id, tool_id, user_id, can_execute) ON TABLE tool_grants TO goldis_enrichment;
GRANT SELECT, UPDATE ON TABLE source_rows TO goldis_enrichment;
GRANT SELECT ON TABLE regon_corrections, entity_grouping_conflicts TO goldis_enrichment;
GRANT SELECT, INSERT ON TABLE regon_enrichment_audits TO goldis_enrichment;
GRANT SELECT, INSERT, UPDATE ON TABLE registry_lookup_cache, registry_result_cache,
  registry_provider_daily_budgets, registry_provider_request_pacing TO goldis_enrichment;
GRANT DELETE ON TABLE registry_result_cache TO goldis_enrichment;
GRANT SELECT, INSERT, UPDATE ON TABLE canonical_entities TO goldis_enrichment;
GRANT SELECT, INSERT ON TABLE source_entity_links, entity_grouping_conflicts TO goldis_enrichment;

-- Audit INSERT evaluates this pure JSON validator in a CHECK constraint.
-- Trigger functions and other application functions remain non-executable.
GRANT EXECUTE ON FUNCTION audit_metadata_has_sensitive_key(jsonb) TO goldis_api;
