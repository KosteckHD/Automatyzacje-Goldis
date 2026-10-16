import { DataTypes, type QueryInterface } from "sequelize";

/** Adds per-operation company leads and fixed, idempotent assignments. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("result_sets", {
      result_set_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      batch_id: { type: DataTypes.UUID, allowNull: false },
      tool_id: { type: DataTypes.STRING(80), allowNull: false },
      actor_user_id: { type: DataTypes.UUID, allowNull: false },
      source_type: { type: DataTypes.STRING(32), allowNull: false },
      source_id: { type: DataTypes.UUID, allowNull: false },
      reference_date: { type: DataTypes.DATEONLY, allowNull: false },
      status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "queued" },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      finished_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE source_rows
         ADD COLUMN phone text NOT NULL DEFAULT '',
         ADD COLUMN email text NOT NULL DEFAULT '';`,
      { transaction },
    );
    await context.sequelize.query(
      `ALTER TABLE result_sets
         ADD CONSTRAINT result_sets_batch_fk FOREIGN KEY (tenant_id, batch_id)
           REFERENCES import_batches (tenant_id, id) ON DELETE CASCADE,
         ADD CONSTRAINT result_sets_actor_fk FOREIGN KEY (tenant_id, actor_user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT result_sets_tool_fk FOREIGN KEY (tool_id) REFERENCES tools (tool_id) ON DELETE RESTRICT,
         ADD CONSTRAINT result_sets_id_tenant_uidx UNIQUE (result_set_id, tenant_id),
         ADD CONSTRAINT result_sets_source_uidx UNIQUE (tenant_id, source_type, source_id),
         ADD CONSTRAINT result_sets_source_type_valid CHECK (source_type IN ('prepared_set_execution', 'run_submission')),
         ADD CONSTRAINT result_sets_status_valid CHECK (status IN ('queued', 'running', 'waiting_attention', 'completed', 'cancelled', 'failed'));
       CREATE INDEX result_sets_tenant_tool_created_idx ON result_sets (tenant_id, tool_id, created_at DESC, result_set_id DESC);
       ALTER TABLE run_submissions ADD COLUMN result_set_id uuid;
       ALTER TABLE run_submissions
         ADD CONSTRAINT run_submissions_result_set_fk FOREIGN KEY (result_set_id)
           REFERENCES result_sets (result_set_id) ON DELETE CASCADE;`,
      { transaction },
    );
    await context.addIndex("run_submissions", ["result_set_id"], {
      name: "run_submissions_result_set_idx", transaction,
    });

    await context.createTable("business_leads", {
      lead_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      result_set_id: { type: DataTypes.UUID, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      tool_id: { type: DataTypes.STRING(80), allowNull: false },
      canonical_entity_id: { type: DataTypes.UUID, allowNull: false },
      source_row_ids: { type: DataTypes.JSONB, allowNull: false },
      company_name: { type: DataTypes.TEXT, allowNull: false },
      nip: { type: DataTypes.STRING(10), allowNull: true },
      regon: { type: DataTypes.STRING(14), allowNull: true },
      address: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      postal_code: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      city: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      decision_maker_names: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      contact_data: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      result_status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "processing" },
      contact_status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "not_contacted" },
      assigned_to_user_id: { type: DataTypes.UUID, allowNull: true },
      assigned_by_user_id: { type: DataTypes.UUID, allowNull: true },
      assigned_at: { type: DataTypes.DATE, allowNull: true },
      contact_status_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      contact_status_updated_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE business_leads
         ADD CONSTRAINT business_leads_result_set_tenant_fk FOREIGN KEY (result_set_id, tenant_id)
           REFERENCES result_sets (result_set_id, tenant_id) ON DELETE CASCADE,
         ADD CONSTRAINT business_leads_entity_fk FOREIGN KEY (tenant_id, canonical_entity_id)
           REFERENCES canonical_entities (tenant_id, canonical_entity_id) ON DELETE RESTRICT,
         ADD CONSTRAINT business_leads_assignee_fk FOREIGN KEY (tenant_id, assigned_to_user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT business_leads_assigner_fk FOREIGN KEY (tenant_id, assigned_by_user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT business_leads_operation_company_uidx UNIQUE (result_set_id, canonical_entity_id),
         ADD CONSTRAINT business_leads_id_tenant_uidx UNIQUE (lead_id, tenant_id),
         ADD CONSTRAINT business_leads_source_rows_valid CHECK (jsonb_typeof(source_row_ids) = 'array'),
         ADD CONSTRAINT business_leads_decision_makers_valid CHECK (jsonb_typeof(decision_maker_names) = 'array'),
         ADD CONSTRAINT business_leads_contacts_valid CHECK (jsonb_typeof(contact_data) = 'array'),
         ADD CONSTRAINT business_leads_result_status_valid CHECK (result_status IN ('processing', 'ready', 'failed')),
         ADD CONSTRAINT business_leads_contact_status_valid CHECK (contact_status IN ('not_contacted', 'offer_accepted', 'not_interested')),
         ADD CONSTRAINT business_leads_assignment_pair CHECK ((assigned_to_user_id IS NULL) = (assigned_at IS NULL)
           AND ((assigned_to_user_id IS NULL) = (assigned_by_user_id IS NULL))),
         ADD CONSTRAINT business_leads_contact_version_valid CHECK (contact_status_version >= 1);` ,
      { transaction },
    );
    await context.addIndex("business_leads", ["tenant_id", "tool_id", "result_status", "created_at", "lead_id"], {
      name: "business_leads_pool_idx", transaction,
    });
    await context.addIndex("business_leads", ["tenant_id", "assigned_to_user_id", "contact_status", "created_at", "lead_id"], {
      name: "business_leads_mine_idx", transaction,
    });
    await context.sequelize.query(
      `ALTER TABLE run_submission_groups
         ADD CONSTRAINT run_submission_groups_id_tenant_uidx UNIQUE (group_id, tenant_id);`,
      { transaction },
    );

    await context.createTable("lead_run_links", {
      link_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      lead_id: { type: DataTypes.UUID, allowNull: false },
      group_id: { type: DataTypes.UUID, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE lead_run_links
         ADD CONSTRAINT lead_run_links_lead_fk FOREIGN KEY (lead_id, tenant_id)
           REFERENCES business_leads (lead_id, tenant_id) ON DELETE CASCADE,
         ADD CONSTRAINT lead_run_links_group_fk FOREIGN KEY (group_id, tenant_id)
           REFERENCES run_submission_groups (group_id, tenant_id) ON DELETE CASCADE,
         ADD CONSTRAINT lead_run_links_group_uidx UNIQUE (group_id);
       CREATE INDEX lead_run_links_lead_idx ON lead_run_links (tenant_id, lead_id, group_id);`,
      { transaction },
    );

    await context.createTable("lead_allocations", {
      allocation_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      tool_id: { type: DataTypes.STRING(80), allowNull: false },
      actor_user_id: { type: DataTypes.UUID, allowNull: false },
      recipient_user_id: { type: DataTypes.UUID, allowNull: false },
      idempotency_key: { type: DataTypes.STRING(120), allowNull: false },
      request_hash: { type: DataTypes.STRING(64), allowNull: false },
      count: { type: DataTypes.INTEGER, allowNull: false },
      assigned_lead_ids: { type: DataTypes.JSONB, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE lead_allocations
         ADD CONSTRAINT lead_allocations_actor_fk FOREIGN KEY (tenant_id, actor_user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT lead_allocations_recipient_fk FOREIGN KEY (tenant_id, recipient_user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT lead_allocations_tool_fk FOREIGN KEY (tool_id) REFERENCES tools (tool_id) ON DELETE RESTRICT,
         ADD CONSTRAINT lead_allocations_actor_key_uidx UNIQUE (tenant_id, actor_user_id, idempotency_key),
         ADD CONSTRAINT lead_allocations_key_valid CHECK (length(trim(idempotency_key)) BETWEEN 16 AND 120),
         ADD CONSTRAINT lead_allocations_hash_valid CHECK (request_hash ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT lead_allocations_count_valid CHECK (count BETWEEN 1 AND 5000),
         ADD CONSTRAINT lead_allocations_leads_valid CHECK (jsonb_typeof(assigned_lead_ids) = 'array'
           AND jsonb_array_length(assigned_lead_ids) = count);` ,
      { transaction },
    );

    // Keep existing imports and finished operations visible after the new
    // result-set model is introduced.
    await context.sequelize.query(
      `INSERT INTO result_sets (result_set_id, tenant_id, batch_id, tool_id, actor_user_id, source_type, source_id,
                               reference_date, status, created_at, updated_at, finished_at)
       SELECT execution.execution_id, execution.tenant_id, execution.batch_id, 'oc-policy-verification',
              execution.actor_user_id, 'prepared_set_execution', execution.execution_id, execution.reference_date,
              CASE execution.status WHEN 'paused' THEN 'waiting_attention' WHEN 'pause_requested' THEN 'running'
                   ELSE execution.status END,
              execution.created_at, execution.updated_at,
              CASE WHEN execution.status IN ('completed', 'cancelled', 'failed') THEN execution.finished_at ELSE NULL END
         FROM prepared_set_executions execution;

       INSERT INTO result_sets (result_set_id, tenant_id, batch_id, tool_id, actor_user_id, source_type, source_id,
                                reference_date, status, created_at, updated_at, finished_at)
       SELECT submission.submission_id, submission.tenant_id, submission.import_batch_id, submission.tool_id,
              submission.actor_user_id, 'run_submission', submission.submission_id, submission.reference_date,
              CASE WHEN submission.status = 'cancelled' THEN 'cancelled'
                   WHEN NOT EXISTS (SELECT 1 FROM run_submission_groups grp WHERE grp.submission_id = submission.submission_id) THEN 'waiting_attention'
                   WHEN EXISTS (SELECT 1 FROM run_submission_groups grp LEFT JOIN automation_runs run ON run.id = grp.run_id
                                WHERE grp.submission_id = submission.submission_id
                                  AND (grp.admission_state = 'blocked' OR run.status IN ('identity_review', 'waiting_for_manual_data', 'waiting_for_sms'))) THEN 'waiting_attention'
                   WHEN NOT EXISTS (SELECT 1 FROM run_submission_groups grp LEFT JOIN automation_runs run ON run.id = grp.run_id
                                    WHERE grp.submission_id = submission.submission_id
                                      AND (grp.admission_state NOT IN ('accepted', 'cancelled')
                                           OR (grp.admission_state = 'accepted' AND (run.id IS NULL OR run.status NOT IN ('completed', 'failed', 'no_matching_policies', 'cancelled'))))) THEN 'completed'
                   ELSE 'running' END,
              submission.created_at, submission.updated_at,
              CASE WHEN submission.status = 'cancelled'
                    OR (EXISTS (SELECT 1 FROM run_submission_groups grp WHERE grp.submission_id = submission.submission_id)
                        AND NOT EXISTS (SELECT 1 FROM run_submission_groups grp LEFT JOIN automation_runs run ON run.id = grp.run_id
                                        WHERE grp.submission_id = submission.submission_id
                                          AND (grp.admission_state NOT IN ('accepted', 'cancelled')
                                               OR (grp.admission_state = 'accepted' AND (run.id IS NULL OR run.status NOT IN ('completed', 'failed', 'no_matching_policies', 'cancelled'))))))
                   THEN submission.updated_at ELSE NULL END
         FROM run_submissions submission
        WHERE NOT EXISTS (SELECT 1 FROM prepared_set_chunks chunk WHERE chunk.child_submission_id = submission.submission_id);

       UPDATE run_submissions submission SET result_set_id = chunk.execution_id
         FROM prepared_set_chunks chunk
        WHERE chunk.child_submission_id = submission.submission_id AND submission.result_set_id IS NULL;
       UPDATE run_submissions submission SET result_set_id = submission.submission_id
        WHERE submission.result_set_id IS NULL;

       WITH company_results AS (
         SELECT result_set.result_set_id, result_set.tenant_id, result_set.tool_id, entity.canonical_entity_id,
                jsonb_agg(DISTINCT source.id) AS source_row_ids, entity.business_name AS company_name,
                entity.nip_normalized AS nip, entity.regon,
                (array_agg(source.address ORDER BY source.row_number))[1] AS address,
                (array_agg(source.postal_code ORDER BY source.row_number))[1] AS postal_code,
                (array_agg(source.city ORDER BY source.row_number))[1] AS city,
                COALESCE(jsonb_agg(DISTINCT source.decision_maker_name)
                  FILTER (WHERE NULLIF(trim(source.decision_maker_name), '') IS NOT NULL), '[]'::jsonb) AS decision_maker_names,
                (COALESCE(jsonb_agg(DISTINCT jsonb_build_object('type', 'phone', 'value', source.phone, 'sourceRowId', source.id))
                   FILTER (WHERE NULLIF(trim(source.phone), '') IS NOT NULL), '[]'::jsonb) ||
                 COALESCE(jsonb_agg(DISTINCT jsonb_build_object('type', 'email', 'value', source.email, 'sourceRowId', source.id))
                   FILTER (WHERE NULLIF(trim(source.email), '') IS NOT NULL), '[]'::jsonb)) AS contact_data,
                count(DISTINCT grp.group_id) AS group_count,
                bool_and(COALESCE(run.status IN ('completed', 'no_matching_policies'), false)) AS all_groups_succeeded,
                result_set.status AS result_set_status
           FROM run_submissions submission
           JOIN result_sets result_set ON result_set.result_set_id = submission.result_set_id
           JOIN run_submission_groups grp ON grp.submission_id = submission.submission_id
           JOIN run_submission_items item ON item.submission_id = submission.submission_id AND item.group_id = grp.group_id
           JOIN source_rows source ON source.id = item.source_row_id
           JOIN canonical_entities entity ON entity.canonical_entity_id = grp.canonical_entity_id AND entity.tenant_id = grp.tenant_id
           LEFT JOIN automation_runs run ON run.id = grp.run_id
          GROUP BY result_set.result_set_id, result_set.tenant_id, result_set.tool_id, entity.canonical_entity_id,
                   entity.business_name, entity.nip_normalized, entity.regon, result_set.status
       )
       INSERT INTO business_leads (lead_id, result_set_id, tenant_id, tool_id, canonical_entity_id, source_row_ids,
                                   company_name, nip, regon, address, postal_code, city, decision_maker_names,
                                   contact_data, result_status, contact_status, assigned_to_user_id, assigned_by_user_id,
                                   assigned_at, contact_status_version, contact_status_updated_at, created_at, updated_at)
       SELECT (substr(md5(result.result_set_id::text || ':' || result.canonical_entity_id::text), 1, 8) || '-' ||
               substr(md5(result.result_set_id::text || ':' || result.canonical_entity_id::text), 9, 4) || '-' ||
               substr(md5(result.result_set_id::text || ':' || result.canonical_entity_id::text), 13, 4) || '-' ||
               substr(md5(result.result_set_id::text || ':' || result.canonical_entity_id::text), 17, 4) || '-' ||
               substr(md5(result.result_set_id::text || ':' || result.canonical_entity_id::text), 21, 12))::uuid,
              result.result_set_id, result.tenant_id, result.tool_id, result.canonical_entity_id, result.source_row_ids,
              result.company_name, result.nip, result.regon, COALESCE(result.address, ''), COALESCE(result.postal_code, ''),
              COALESCE(result.city, ''), result.decision_maker_names, result.contact_data,
              CASE WHEN result.result_set_status = 'completed' AND result.group_count > 0 AND result.all_groups_succeeded
                   THEN 'ready' WHEN result.result_set_status IN ('completed', 'cancelled', 'failed') THEN 'failed' ELSE 'processing' END,
              'not_contacted', NULL, NULL, NULL, 1, NULL, now(), now()
         FROM company_results result;

       INSERT INTO lead_run_links (link_id, tenant_id, lead_id, group_id, created_at)
       SELECT (substr(md5(grp.group_id::text || ':lead-link'), 1, 8) || '-' ||
               substr(md5(grp.group_id::text || ':lead-link'), 9, 4) || '-' ||
               substr(md5(grp.group_id::text || ':lead-link'), 13, 4) || '-' ||
               substr(md5(grp.group_id::text || ':lead-link'), 17, 4) || '-' ||
               substr(md5(grp.group_id::text || ':lead-link'), 21, 12))::uuid,
              grp.tenant_id, lead.lead_id, grp.group_id, now()
         FROM run_submission_groups grp
         JOIN run_submissions submission ON submission.submission_id = grp.submission_id
         JOIN business_leads lead ON lead.result_set_id = submission.result_set_id
                                  AND lead.canonical_entity_id = grp.canonical_entity_id
        ON CONFLICT (group_id) DO NOTHING;`,
      { transaction },
    );

    await context.sequelize.query(
      `ALTER TABLE audit_events DROP CONSTRAINT audit_event_action_valid;
       ALTER TABLE audit_events ADD CONSTRAINT audit_event_action_valid CHECK (action IN (
         'login.succeeded', 'login.failed', 'logout.succeeded', 'session.revoked', 'password.changed',
         'import.created', 'import.preparation.started', 'import.preparation.completed', 'import.preparation.cancelled',
         'import.preparation.workflow.started', 'import.preparation.workflow.completed',
         'import.preparation.workflow.cancelled', 'import.preparation.workflow.failed',
         'run.created', 'run.cancelled', 'run.auth_resumed', 'run.review_resumed', 'run.manual_data_corrected',
         'run.pause_requested', 'run.resumed_from_pause', 'run.submission.created', 'run.submission.cancelled',
         'run.submission.group_admitted', 'run.prepared_set.created', 'run.prepared_set.completed',
         'run.prepared_set.cancelled', 'run.prepared_set.failed', 'run.prepared_set.pause_requested',
         'run.prepared_set.resumed', 'lead.allocated', 'lead.status.updated', 'sms.submitted',
         'regon.correction.proposed', 'regon.correction.reviewed', 'entity.conflict.reviewed',
         'enrichment.job.created', 'enrichment.job.cancelled', 'enrichment.job.completed', 'artifact.downloaded',
         'user.created', 'user.updated', 'user.deletion_grant.updated', 'deletion.step_up.granted',
         'deletion.preview.created', 'deletion.job.created', 'deletion.job.completed', 'deletion.job.failed',
         'tool.grant.created', 'tool.grant.updated', 'tool.grant.revoked', 'intervention.assigned',
         'intervention.unassigned', 'intervention.priority_changed', 'intervention.resolved', 'settings.updated'
       ));`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("BUSINESS_LEAD_ASSIGNMENTS_ARE_NOT_SAFE_TO_REVERSE");
}
