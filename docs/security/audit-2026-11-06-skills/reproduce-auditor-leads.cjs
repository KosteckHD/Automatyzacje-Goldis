// Audit reproduction only. No server, database connection, .env, or real data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function main() {
  process.env.DATABASE_URL = 'postgres://synthetic:unused@127.0.0.1:1/audit_no_connection';
  const root = path.resolve(__dirname, '../../..');
  const db = require(path.join(root, 'apps/api/dist/infrastructure/database/db.js'));
  const { BusinessLeadService } = require(path.join(root, 'apps/api/dist/features/leads/business-leads.service.js'));
  const { canPerform } = require(path.join(root, 'apps/api/dist/features/authorization/authorization-policy.js'));
  const actor = {
    tenantId: '99999999-9999-4999-8999-999999999999',
    userId: '55555555-5555-4555-8555-555555555555',
    role: 'auditor',
  };
  const originals = {
    findTool: db.Tool.findByPk,
    findGrant: db.ToolGrant.findOne,
    transaction: db.sequelize.transaction,
    query: db.sequelize.query,
  };
  let grantPresent = false;
  let scopedQueryCount = 0;
  const row = {
    leadId: '88888888-8888-4888-8888-888888888888',
    resultSetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    toolId: 'oc-policy-verification',
    sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    sourceRowIds: [],
    createdAt: '2026-11-06T00:00:00.000Z',
    referenceDate: '2026-11-06',
    companyName: 'SYNTHETIC AUDIT COMPANY',
    contactData: [{ type: 'email', value: 'synthetic@example.invalid' }],
    decisionMakerNames: ['SYNTHETIC PERSON'],
    resultStatus: 'ready',
    contactStatus: 'not_contacted',
    contactStatusVersion: 1,
    assignmentVersion: 1,
    currentUserId: actor.userId,
  };
  try {
    db.Tool.findByPk = async () => ({ toolId: 'oc-policy-verification', status: 'available' });
    db.ToolGrant.findOne = async ({ where }) => {
      assert.equal(where.tenantId, actor.tenantId);
      assert.equal(where.userId, actor.userId);
      return grantPresent ? { canDiscover: true, canExecute: false, canViewResults: true, canDownloadResults: false } : null;
    };
    db.sequelize.transaction = async (_options, work) => work({ synthetic: true });
    db.sequelize.query = async (sql, options) => {
      assert.match(sql, /FROM business_leads lead/);
      assert.equal(options.replacements.tenantId, actor.tenantId);
      assert.equal(options.replacements.userId, actor.userId);
      scopedQueryCount += 1;
      return [row];
    };
    const service = new BusinessLeadService();
    await assert.rejects(service.list(actor, { scope: 'pool' }), (error) => error.getStatus() === 403);
    grantPresent = true;
    const response = await service.list(actor, { scope: 'pool' });
    assert.equal(response.items.length, 1);
    assert.equal(response.items[0].contacts[0].value, 'synthetic@example.invalid');
    const corePolicyAllowsBatchRead = canPerform('auditor', 'batch:read', {
      actorUserId: actor.userId,
      actorTenantId: actor.tenantId,
      resourceOwnerId: actor.userId,
      resourceTenantId: actor.tenantId,
    });
    assert.equal(corePolicyAllowsBatchRead, false);
    const sourcePaths = [
      'apps/api/src/features/leads/business-leads.service.ts',
      'apps/api/src/features/authorization/tool-access.ts',
      'apps/api/src/features/authorization/authorization-policy.ts',
      'apps/api/src/features/admin/admin-users.service.ts',
      'docs/INSTRUKCJA_ADMINA.md',
    ];
    const result = {
      findingId: 'CYB-007',
      status: 'behavior_reproduced_policy_conflict_requires_resolution',
      execution: 'compiled_service_with_in_memory_database_adapters',
      runtime: process.version,
      observedAt: new Date().toISOString(),
      auditorWithoutGrant: '403',
      auditorWithViewGrant: { items: response.items.length, syntheticContactReturned: true },
      corePolicyAllowsBatchRead,
      scopedQueryCount,
      limitations: ['No real HTTP session or PostgreSQL', 'Role-change retention inferred from source, not executed', 'Whether auditor grants are intended to override the role requires policy resolution'],
      sources: sourcePaths.map((file) => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') })),
    };
    fs.writeFileSync(path.join(__dirname, 'auditor-leads-reproduction.json'), JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    db.Tool.findByPk = originals.findTool;
    db.ToolGrant.findOne = originals.findGrant;
    db.sequelize.transaction = originals.transaction;
    db.sequelize.query = originals.query;
  }
}

main().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
