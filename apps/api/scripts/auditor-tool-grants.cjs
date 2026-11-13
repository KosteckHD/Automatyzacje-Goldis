"use strict";

const { randomUUID } = require("node:crypto");
const { QueryTypes } = require("sequelize");
const { sequelize, configureDefaultDatabaseUrl } = require("../dist/infrastructure/database/db");

function parseMode(args) {
  if (args.length === 0) return "dry-run";
  if (args.length === 1 && args[0] === "--apply") return "apply";
  throw new Error("USAGE: node apps/api/scripts/auditor-tool-grants.cjs [--apply]");
}

async function listAuditorMemberships(transaction) {
  return sequelize.query(
    `SELECT tenant_id, user_id FROM tenant_memberships
      WHERE role='auditor'
      ORDER BY tenant_id, user_id FOR UPDATE`,
    { type: QueryTypes.SELECT, transaction },
  );
}

async function inspectGrants(transaction) {
  return sequelize.query(
    `SELECT g.tenant_id, g.user_id, g.tool_id,
            g.can_discover, g.can_execute, g.can_view_results, g.can_download_results
       FROM tool_grants AS g
       JOIN tenant_memberships AS member ON member.tenant_id=g.tenant_id AND member.user_id=g.user_id
      WHERE member.role='auditor'
      ORDER BY grant.tenant_id, grant.user_id, grant.tool_id
      ${transaction ? "FOR UPDATE OF g" : ""}`,
    { type: QueryTypes.SELECT, transaction },
  );
}

function summarize(rows) {
  return {
    affectedMemberships: new Set(rows.map((row) => `${row.tenant_id}/${row.user_id}`)).size,
    grants: rows.length,
    capabilities: rows.reduce((count, row) => count + [
      row.can_discover,
      row.can_execute,
      row.can_view_results,
      row.can_download_results,
    ].filter(Boolean).length, 0),
    items: rows.map(({ tenant_id, user_id, tool_id }) => ({ tenantId: tenant_id, userId: user_id, toolId: tool_id })),
  };
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
  configureDefaultDatabaseUrl(process.env.DATABASE_URL);
  await sequelize.authenticate();

  if (mode === "dry-run") {
    const rows = await inspectGrants();
    console.log(JSON.stringify({ mode, ...summarize(rows) }, null, 2));
    return;
  }

  const result = await sequelize.transaction(async (transaction) => {
    await listAuditorMemberships(transaction);
    const grants = await inspectGrants(transaction);
    if (!grants.length) return { affectedMemberships: 0, grants: 0, capabilities: 0, items: [] };
    const deleted = await sequelize.query(
      `DELETE FROM tool_grants AS g USING tenant_memberships AS member
        WHERE member.role='auditor' AND member.tenant_id=g.tenant_id AND member.user_id=g.user_id
        RETURNING g.tenant_id, g.user_id, g.tool_id`,
      { type: QueryTypes.SELECT, transaction },
    );
    const { AuditEvent } = require("../dist/infrastructure/database/db");
    for (const grant of deleted) {
      await AuditEvent.create({
        eventId: randomUUID(),
        tenantId: grant.tenant_id,
        actorUserId: null,
        action: "tool.grant.revoked",
        resourceType: "tool",
        resourceId: grant.tool_id,
        outcome: "succeeded",
        requestRef: randomUUID(),
        metadata: { userId: grant.user_id, reason: "auditor_role_policy" },
        createdAt: new Date(),
      }, { transaction, returning: false });
    }
    return summarize(deleted);
  });
  console.log(JSON.stringify({ mode, ...result }, null, 2));
}

main().catch((error) => {
  const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "AUDITOR_GRANT_REMEDIATION_FAILED";
  console.error(code);
  process.exitCode = 1;
}).finally(async () => {
  await Promise.resolve().then(() => sequelize.close()).catch(() => undefined);
});
