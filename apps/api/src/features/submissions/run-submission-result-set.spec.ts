import assert from "node:assert/strict";
import { test } from "node:test";
import type { OcPolicy } from "@goldis/core";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import ExcelJS from "exceljs";
import { configureDefaultDatabaseUrl, sequelize, Tool, ToolGrant } from "../../infrastructure/database/db";
import { leadResultSnapshotChecksum } from "../results/public";
import { RunSubmissionReadRepository } from "./run-submission-read.repository";
import { RunSubmissionService } from "./run-submissions.service";

const resultSetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const tenantId = "99999999-9999-4999-8999-999999999999";
const runId = "88888888-8888-4888-8888-888888888888";
const sourceRowId = "11111111-1111-4111-8111-111111111111";

const policies: OcPolicy[] = [
  {
    sourceOrdinal: 1,
    insuredName: "Firma Alfa",
    policyTypeAndNumber: "OC A-1",
    contractType: "OC",
    insuredClaimCount: 0,
    vehicleRegistration: "WX12345",
    vehicleGroup: "osobowy",
    vehicleMake: "Marka",
    vehicleModel: "Model",
    insurer: "Ubezpieczyciel",
    coverageFrom: "2026-01-01",
    coverageTo: "2026-12-31",
  },
  {
    sourceOrdinal: 2,
    insuredName: "Stara polisa",
    policyTypeAndNumber: "OC OLD",
    contractType: "OC",
    insuredClaimCount: 1,
    vehicleRegistration: "WX54321",
    vehicleGroup: "osobowy",
    vehicleMake: null,
    vehicleModel: null,
    insurer: "Ubezpieczyciel",
    coverageFrom: "2025-01-01",
    coverageTo: "2025-12-31",
  },
];

function makeService(snapshotChecksum = true) {
  const companyFields = { companyName: "=1+1", effectiveRegon: "123456789" };
  const snapshot = {
    snapshotId: "77777777-7777-4777-8777-777777777777",
    leadId: "66666666-6666-4666-8666-666666666666",
    originalRunId: runId,
    originalSourceRowId: sourceRowId,
    rowNumber: 2,
    referenceDate: "2026-10-06",
    companyFields,
    policies,
    policyCount: policies.length,
    checksum: "",
    schemaVersion: 1,
    peselCiphertext: null,
    peselKeyVersion: null,
    sourceOwnerUserId: "55555555-5555-4555-8555-555555555555",
  };
  snapshot.checksum = leadResultSnapshotChecksum({
    leadId: snapshot.leadId,
    tenantId,
    runId,
    sourceRowId,
    sourceOwnerUserId: snapshot.sourceOwnerUserId,
    referenceDate: snapshot.referenceDate,
    companyFields,
    peselCiphertext: null,
    peselKeyVersion: null,
    policies,
  });
  if (!snapshotChecksum) snapshot.checksum = "0".repeat(64);

  const readRepository = {
    async resultSetRows() {
      return [
        {
          sourceRowId,
          rowNumber: 2,
          companyName: "=1+1",
          status: "completed",
          reasonCode: null,
          runId,
          runStatus: "completed",
          policyCount: policies.length,
        },
      ];
    },
    async resultSetSnapshots() {
      return [snapshot];
    },
    async countPausedSubmissions() {
      return 0;
    },
  };
  const service = new RunSubmissionService(
    {} as never,
    readRepository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const access = service as unknown as {
    assertResultSetAccess: (id: string, actor: unknown, role: unknown, requireDownload: boolean) => Promise<unknown>;
  };
  access.assertResultSetAccess = async (id: string, _actor: unknown, _role: unknown, requireDownload: boolean) => {
    assert.equal(id, resultSetId);
    assert.equal(requireDownload, true);
    return {
      resultSetId,
      sourceType: "run_submission",
      sourceId: resultSetId,
      batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      referenceDate: "2026-10-06",
      status: "running",
    };
  };
  return service;
}

test("result-set export is scoped to its snapshot, marks partial state, and emits formula-safe current policies", async () => {
  const service = makeService();
  const file = await service.exportResultSet(
    resultSetId,
    { tenantId, actorUserId: "55555555-5555-4555-8555-555555555555" },
    "operator",
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  assert.equal(file.fileName, `wyniki-oc-${resultSetId.slice(0, 8)}.xlsx`);
  assert.equal(file.rows, 1);
  assert.equal(file.policies, 1, "polisy bez ochrony na dzień odniesienia nie trafiają do arkusza");
  assert.equal(
    workbook.getWorksheet("Informacje")?.getCell("B3").value,
    "Tak",
    "trwający zestaw ma jawny częściowy eksport",
  );
  assert.equal(
    workbook.getWorksheet("Wyniki")?.getCell("B2").value,
    "'=1+1",
    "tekst zaczynający się od znaku formuły jest neutralizowany",
  );
  assert.equal(
    workbook.getWorksheet("Polisy OC")?.rowCount,
    2,
    "arkusz zawiera nagłówek i tylko polisę aktualną na datę odniesienia",
  );
  assert.equal(
    workbook.getWorksheet("Polisy OC")?.columnCount,
    14,
    "nagłówki, dane i szerokości obejmują wszystkie 14 kolumn",
  );
});

test("result-set export rejects a snapshot that fails its integrity checksum", async () => {
  const service = makeService(false);
  await assert.rejects(
    service.exportResultSet(resultSetId, { tenantId, actorUserId: "55555555-5555-4555-8555-555555555555" }, "operator"),
    (error: unknown) => error instanceof ConflictException && /integralności/.test(error.message),
  );
});

test("result-set export follows shared OC access while enforcing role and owner scope", async () => {
  configureDefaultDatabaseUrl("postgresql://synthetic:synthetic@127.0.0.1:1/synthetic");
  const originalQuery = sequelize.query;
  const originalToolFindByPk = Tool.findByPk;
  const originalGrantFindOne = ToolGrant.findOne;
  const grant = { canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: false };
  try {
    sequelize.query = (async () => [{ exists: false }]) as unknown as typeof sequelize.query;
    Tool.findByPk = (async (toolId: string) => ({ toolId, status: "available" })) as typeof Tool.findByPk;
    ToolGrant.findOne = (async () => grant) as typeof ToolGrant.findOne;
    const batch = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      toolId: "oc-policy-verification",
      tenantId,
      ownerUserId: "55555555-5555-4555-8555-555555555555",
    };
    const resultSet = { resultSetId, toolId: "oc-policy-verification", batchId: batch.id };
    const readRepository = {
      async findResultSetInTenant(id: string, scopedTenantId: string) {
        return id === resultSetId && scopedTenantId === tenantId ? resultSet : null;
      },
      async findBatch(id: string) {
        return id === batch.id ? batch : null;
      },
    };
    const service = new RunSubmissionService(
      {} as never,
      readRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const access = service as unknown as {
      assertResultSetAccess: (id: string, actor: unknown, role: string, requireDownload: boolean) => Promise<unknown>;
    };
    const actor = { tenantId, actorUserId: batch.ownerUserId };

    assert.equal(await access.assertResultSetAccess(resultSetId, actor, "operator", false), resultSet);
    await assert.rejects(access.assertResultSetAccess(resultSetId, actor, "operator", true), ForbiddenException);
    grant.canDownloadResults = true;
    assert.equal(await access.assertResultSetAccess(resultSetId, actor, "operator", true), resultSet);
    await assert.rejects(
      access.assertResultSetAccess(
        resultSetId,
        { ...actor, actorUserId: "22222222-2222-4222-8222-222222222222" },
        "operator",
        true,
      ),
      NotFoundException,
    );
    await assert.rejects(access.assertResultSetAccess(resultSetId, actor, "reviewer", true), ForbiddenException);
  } finally {
    sequelize.query = originalQuery;
    Tool.findByPk = originalToolFindByPk;
    ToolGrant.findOne = originalGrantFindOne;
  }
});

test("result-set rows and summary queries carry one result-set scope through filtering and deduplicated counts", async () => {
  configureDefaultDatabaseUrl("postgresql://synthetic:synthetic@127.0.0.1:1/synthetic");
  const originalQuery = sequelize.query;
  const calls: Array<{ sql: string; replacements: Record<string, unknown> }> = [];
  const expectedRow = {
    sourceRowId,
    rowNumber: 2,
    companyName: "Firma Alfa",
    status: "completed",
    reasonCode: null,
    runId,
    runStatus: "completed",
    policyCount: 3,
  };
  try {
    sequelize.query = (async (
      query: string | { query: string },
      options: { replacements?: Record<string, unknown> },
    ) => {
      const sql = typeof query === "string" ? query : query.query;
      calls.push({ sql, replacements: options.replacements ?? {} });
      if (sql.includes("WITH scoped_items")) return [expectedRow];
      if (sql.includes("GROUP BY status"))
        return [
          { status: "completed", count: 2, policyCount: 6 },
          { status: "queued", count: 1, policyCount: 0 },
        ];
      if (sql.includes("count(DISTINCT grp.group_id)")) return [{ count: 2 }];
      return [{ policyCount: 3 }];
    }) as unknown as typeof sequelize.query;

    const repository = new RunSubmissionReadRepository();
    const page = await repository.resultSetRows(resultSetId, { rowNumber: 1, sourceRowId }, 51, "alfa", "completed");
    const counts = await repository.resultSetStatusCounts(resultSetId);

    assert.deepEqual(page, [expectedRow]);
    assert.deepEqual(counts, { rows: 3, uniqueGroups: 2, policyCount: 3, byStatus: { completed: 2, queued: 1 } });
    assert.equal(calls.length, 4);
    assert(
      calls.every(
        ({ sql, replacements }) =>
          sql.includes("submission.result_set_id = :resultSetId") && replacements.resultSetId === resultSetId,
      ),
    );
    assert.deepEqual(calls[0].replacements, {
      resultSetId,
      cursorRowNumber: 1,
      cursorSourceRowId: sourceRowId,
      search: "alfa",
      status: "completed",
      limit: 51,
    });
    assert.match(calls[3].sql, /SELECT DISTINCT grp\.run_id/);
  } finally {
    sequelize.query = originalQuery;
    await sequelize.close();
  }
});
