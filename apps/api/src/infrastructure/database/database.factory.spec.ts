import assert from "node:assert/strict";
import { test } from "node:test";
import { Sequelize } from "sequelize";
import { configureDefaultDatabaseUrl } from "./db";
import { createApiDatabase, releaseApiDatabase } from "./database.factory";

test("database import is inert; the factory binds the 48 models once and shares same-config leases", async () => {
  const previousUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  let connection: ReturnType<typeof createApiDatabase> | undefined;
  let leases = 0;
  try {
    const models = await import("./db");
    assert.throws(() => models.Tenant.findByPk, /DATABASE_URL is required when the database is used/);

    const connectionString = "postgres://goldis_factory_test:unused@127.0.0.1:1/goldis_factory_test";
    configureDefaultDatabaseUrl(connectionString);
    connection = createApiDatabase();
    leases += 1;
    assert.strictEqual(models.sequelize.constructor, Sequelize);
    const sequelizeConstructor = models.sequelize.constructor as unknown as { DataTypes: { STRING: unknown } };
    assert.equal(typeof sequelizeConstructor.DataTypes.STRING, "function");
    const secondLease = createApiDatabase(connectionString);
    leases += 1;

    assert.strictEqual(secondLease, connection);
    assert.equal(Object.keys(connection.models).length, 48);
    assert.equal(connection.models.Tenant.getTableName(), "tenants");
    assert.deepEqual(Object.values(connection.models.Tenant.getAttributes()).map((attribute) => attribute.field), [
      "tenant_id", "slug", "display_name", "created_at",
    ]);
    assert.deepEqual(Object.values(connection.models.User.getAttributes()).map((attribute) => attribute.field), [
      "user_id", "username", "username_normalized", "password_hash", "status", "created_at", "updated_at",
      "last_login_at", "must_change_password", "credential_revision",
    ]);
    assert.deepEqual(Object.values(connection.models.UserSession.getAttributes()).map((attribute) => attribute.field), [
      "session_id", "tenant_id", "user_id", "credential_revision", "created_at", "last_seen_at", "last_activity_at",
      "expires_at", "revoked_at", "revoked_by", "revoke_reason", "ip_hash", "browser_label",
    ]);
    assert.deepEqual(Object.values(connection.models.TenantMembership.getAttributes()).map((attribute) => attribute.field), [
      "tenant_id", "user_id", "role", "status", "created_at", "updated_at",
    ]);
    assert.ok(connection.models.Tenant.associations.TenantMemberships);
    assert.ok(connection.models.TenantMembership.associations.Tenant);
    assert.ok(connection.models.User.associations.TenantMemberships);
    assert.ok(connection.models.TenantMembership.associations.User);
    assert.deepEqual(Object.values(connection.models.Tool.getAttributes()).map((attribute) => attribute.field), [
      "tool_id", "display_name", "description", "status", "sort_order", "created_at", "updated_at",
    ]);
    assert.deepEqual(Object.values(connection.models.ToolGrant.getAttributes()).map((attribute) => attribute.field), [
      "tenant_id", "tool_id", "user_id", "can_discover", "can_execute", "can_view_results", "can_download_results",
      "granted_by", "created_at", "updated_at", "version",
    ]);
    assert.deepEqual(Object.values(connection.models.ToolSettings.getAttributes()).map((attribute) => attribute.field), [
      "tenant_id", "tool_id", "enabled_for_new_runs", "max_new_runs_per_hour", "allowed_local_start",
      "allowed_local_end", "timezone", "updated_by", "updated_at", "version",
    ]);
    assert.deepEqual(Object.values(connection.models.AuditEvent.getAttributes()).map((attribute) => attribute.field), [
      "event_id", "tenant_id", "actor_user_id", "action", "resource_type", "resource_id", "outcome", "request_ref",
      "metadata", "created_at",
    ]);
    assert.ok(connection.models.Tenant.associations.AuditEvents);
    assert.ok(connection.models.User.associations.AuditEvents);
    assert.ok(connection.models.AuditEvent.associations.Tenant);
    assert.ok(connection.models.AuditEvent.associations.User);
    assert.equal(connection.models.UserNotification.getTableName(), "user_notifications");
    assert.equal(connection.models.AccountRecoveryToken.getTableName(), "account_recovery_tokens");
    assert.deepEqual(Object.values(connection.models.AccountRecoveryToken.getAttributes()).map((attribute) => attribute.field), [
      "token_id", "tenant_id", "user_id", "purpose", "token_hash", "credential_revision", "recovery_email_revision",
      "pending_email_revision", "recipient_fingerprint", "created_at", "expires_at", "consumed_at", "revoked_at",
    ]);
    assert.equal(connection.models.AuthMailOutbox.getTableName(), "auth_mail_outbox");
    assert.deepEqual(Object.values(connection.models.AuthMailOutbox.getAttributes()).map((attribute) => attribute.field), [
      "mail_id", "tenant_id", "user_id", "token_id", "purpose", "payload_ciphertext", "payload_nonce", "payload_auth_tag",
      "key_version", "status", "attempt_count", "next_attempt_at", "lease_until", "lease_owner", "provider_message_id",
      "last_error_code", "created_at", "expires_at", "submitted_at",
    ]);
    assert.deepEqual(Object.values(connection.models.UserNotification.getAttributes()).map((attribute) => attribute.field), [
      "notification_id", "tenant_id", "recipient_user_id", "result_set_id", "event_type", "event_key",
      "title", "message", "href", "created_at", "read_at",
    ]);
    assert.ok(connection.models.AutomationRun.associations.OcSnapshot);
    const executionModelTables: Array<[string, string]> = [
      ["AutomationRun", "automation_runs"],
      ["RunSourceRow", "run_source_rows"],
      ["RunEvent", "run_events"],
      ["RunIdentity", "run_identities"],
      ["RunManualDataOverride", "run_manual_data_overrides"],
      ["RunDispatchOutbox", "run_dispatch_outbox"],
      ["AuthChallenge", "auth_challenges"],
      ["ManualIntervention", "manual_interventions"],
      ["InterventionActivity", "intervention_activity"],
      ["InterventionUserRead", "intervention_user_reads"],
      ["OcSnapshot", "oc_snapshots"],
      ["OcPolicyRecord", "oc_policies"],
      ["ExportArtifact", "export_artifacts"],
      ["ResultSet", "result_sets"],
      ["LeadResultSnapshot", "lead_result_snapshots"],
      ["RunSubmission", "run_submissions"],
      ["RunSubmissionGroup", "run_submission_groups"],
      ["RunSubmissionItem", "run_submission_items"],
      ["BusinessLead", "business_leads"],
      ["LeadRunLink", "lead_run_links"],
      ["LeadAllocation", "lead_allocations"],
    ];
    for (const [modelName, tableName] of executionModelTables) {
      const model: (typeof connection.models)[string] | undefined = connection.models[modelName];
      assert.ok(model, `${modelName} should be registered`);
      assert.equal(model.getTableName(), tableName);
      assert.ok(Object.keys(model.getAttributes()).length > 0);
    }
    assert.ok(connection.models.CanonicalEntity.associations.AutomationRuns);
    assert.ok(connection.models.AutomationRun.associations.CanonicalEntity);
    assert.ok(connection.models.AutomationRun.associations.RunSourceRows);
    assert.ok(connection.models.RunSourceRow.associations.AutomationRun);
    assert.ok(connection.models.SourceRow.associations.RunSourceRows);
    assert.ok(connection.models.RunSourceRow.associations.SourceRow);
    assert.ok(connection.models.AutomationRun.associations.RunIdentity);
    assert.ok(connection.models.RunIdentity.associations.AutomationRun);
    assert.ok(connection.models.SourceRow.associations.RunIdentities);
    assert.ok(connection.models.RunIdentity.associations.SourceRow);
    assert.ok(connection.models.AutomationRun.associations.OcPolicyRecords);
    assert.ok(connection.models.OcPolicyRecord.associations.AutomationRun);
    assert.ok(connection.models.AutomationRun.associations.ExportArtifacts);
    assert.ok(connection.models.ExportArtifact.associations.AutomationRun);
    assert.ok(connection.models.AutomationRun.associations.AuthChallenges);
    assert.ok(connection.models.AuthChallenge.associations.AutomationRun);
    assert.ok(connection.models.AutomationRun.associations.ManualInterventions);
    assert.ok(connection.models.ManualIntervention.associations.AutomationRun);
    assert.ok(connection.models.AuthChallenge.associations.ManualInterventions);
    assert.ok(connection.models.ManualIntervention.associations.AuthChallenge);
    const importedModelTables: Array<[string, string]> = [
      ["ImportBatch", "import_batches"],
      ["SourceRow", "source_rows"],
      ["ImportPreparationWorkflow", "import_preparation_workflows"],
      ["ImportPreparationWorkflowJob", "import_preparation_workflow_jobs"],
      ["ImportPreparation", "import_preparations"],
      ["ImportPreparedRow", "import_prepared_rows"],
      ["PreparedSetExecution", "prepared_set_executions"],
      ["PreparedSetChunk", "prepared_set_chunks"],
      ["RegonCorrection", "regon_corrections"],
      ["RegistryLookupCache", "registry_lookup_cache"],
      ["RegistryEnrichmentAudit", "regon_enrichment_audits"],
      ["EnrichmentJob", "enrichment_jobs"],
      ["EnrichmentJobItem", "enrichment_job_items"],
      ["CanonicalEntity", "canonical_entities"],
      ["SourceEntityLink", "source_entity_links"],
      ["EntityGroupingConflict", "entity_grouping_conflicts"],
    ];
    for (const [modelName, tableName] of importedModelTables) {
      const model: (typeof connection.models)[string] | undefined = connection.models[modelName];
      assert.ok(model, `${modelName} should be registered`);
      assert.equal(model.getTableName(), tableName);
      assert.ok(Object.keys(model.getAttributes()).length > 0);
    }
    assert.ok(connection.models.ImportBatch.associations.SourceRows);
    assert.ok(connection.models.ImportPreparation.associations.ImportPreparedRows);
    assert.ok(connection.models.ImportPreparedRow.associations.ImportPreparation);
    assert.ok(connection.models.SourceRow.associations.RegonCorrections);
    assert.ok(connection.models.RegonCorrection.associations.SourceRow);
    assert.ok(connection.models.CanonicalEntity.associations.SourceEntityLinks);
    assert.ok(connection.models.SourceEntityLink.associations.CanonicalEntity);
    assert.ok(connection.models.SourceRow.associations.SourceEntityLink);
    assert.ok(connection.models.SourceRow.associations.EntityGroupingConflicts);
    assert.ok(connection.models.EntityGroupingConflict.associations.SourceRow);
    assert.throws(() => configureDefaultDatabaseUrl("postgres://other:secret@127.0.0.1:1/other"), /DATABASE_CONFIGURATION_CONFLICT/);
    assert.throws(() => createApiDatabase("postgres://other:unused@127.0.0.1:1/other"), /DATABASE_CONFIGURATION_CONFLICT/);

    await releaseApiDatabase(connection);
    leases -= 1;
    await releaseApiDatabase(secondLease);
    leases -= 1;
    await models.sequelize.close();
  } finally {
    if (connection) {
      while (leases > 0) {
        await releaseApiDatabase(connection);
        leases -= 1;
      }
    }
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});
