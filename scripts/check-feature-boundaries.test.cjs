"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  checkFeatureBoundaries,
  scanLayerViolations,
  scanPublicEntryViolations,
  scanSourceDirectionViolations,
} = require("./check-feature-boundaries.cjs");

test("feature boundaries reject cross-feature private imports and cycles", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-feature-boundaries-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (relative, content) => {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("features/auth/auth.module.ts", 'import { UserRepository } from "../users/users.repository";\n');
  write("features/auth/auth.service.ts", "export class AuthService {}\n");
  write("features/users/users.repository.ts", 'import { AuthService } from "../auth/auth.service";\n');
  const result = checkFeatureBoundaries(directory);
  assert.equal(result.violations.length, 2);
  assert.equal(result.cycles.length, 1);
});

test("layer scan rejects database access from a feature service and records a bounded migration exception", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-layer-boundary-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const service = path.join(directory, "features", "reports", "history.service.ts");
  fs.mkdirSync(path.dirname(service), { recursive: true });
  fs.writeFileSync(service, 'import { sequelize } from "../../infrastructure/database/db";\nexport class HistoryService { run() { return sequelize.query("SELECT 1"); } }\n');
  const scan = (exceptions) => scanLayerViolations([service], directory, exceptions);
  const baseline = scan([]);
  assert.deepEqual(baseline.violations.map(({ rule }) => rule), [
    "service-controller-global-db-import", "service-controller-persistence-call",
    "service-controller-sql-text",
  ]);
  const exception = Object.entries(baseline.counts).map(([key, maximum]) => {
    const [file, rule] = key.split("|");
    return { file, rule, maximum };
  });
  assert.deepEqual(scan(exception).violations, []);
  fs.appendFileSync(service, '\nexport function anotherQuery() { return sequelize.query("SELECT 2"); }\n');
  assert.deepEqual(scan(exception).violations.map(({ rule }) => rule), [
    "service-controller-persistence-call", "service-controller-sql-text",
  ]);
});

test("feature boundaries accept public entries and same-feature imports", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-feature-boundaries-public-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (relative, content) => {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("features/auth/auth.service.ts", 'import { UserRepository } from "../users";\nimport { SessionStore } from "./session.store";\n');
  write("features/users/index.ts", 'export { UserRepository } from "./users.repository";\n');
  write("features/users/users.repository.ts", "export class UserRepository {}\n");
  write("features/auth/session.store.ts", "export class SessionStore {}\n");
  const result = checkFeatureBoundaries(directory);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.cycles, []);
});

test("public feature entries reject controller and model value exports but allow type contracts", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-public-entry-boundaries-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (relative, content) => {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("features/reports/public.ts", [
    'export { ReportsController } from "./reports.controller";',
    'export { ReportsModel } from "./reports.model";',
    'export { ReportsRepository } from "./reports.repository";',
    'export type { ReportsRow } from "./reports.model";',
    'export { ReportsService } from "./reports.service";',
  ].join("\n"));
  write("features/reports/reports.controller.ts", "export class ReportsController {}\n");
  write("features/reports/reports.model.ts", "export class ReportsModel {}\nexport type ReportsRow = {};\n");
  write("features/reports/reports.repository.ts", "export class ReportsRepository {}\n");
  write("features/reports/reports.service.ts", "export class ReportsService {}\n");

  const audit = scanPublicEntryViolations([
    path.join(directory, "features", "reports", "public.ts"),
  ], directory, []);
  assert.deepEqual(audit.violations, [
    { file: "features/reports/public.ts", import: "./reports.controller", rule: "public-entry-controller-export", symbol: "ReportsController" },
    { file: "features/reports/public.ts", import: "./reports.model", rule: "public-entry-model-export", symbol: "ReportsModel" },
    { file: "features/reports/public.ts", import: "./reports.repository", rule: "public-entry-private-reexport", symbol: "ReportsRepository" },
  ]);
  assert.deepEqual(audit.staleExceptions, []);
  const ratcheted = scanPublicEntryViolations([
    path.join(directory, "features", "reports", "public.ts"),
  ], directory, audit.violations.map((entry) => ({ ...entry, scheduledRemoval: "D5", reason: "fixture" })));
  assert.deepEqual(ratcheted.violations, []);
  assert.deepEqual(ratcheted.staleExceptions, []);
});

test("application layers reject infrastructure and cross-process source dependencies", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-source-direction-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (relative, content = "export {};\n") => {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("apps/api/src/infrastructure/database/db.ts", 'import "../../features/auth/auth.service";\n');
  write("apps/api/src/features/auth/auth.service.ts", 'import "../../composition/module";\n');
  write("apps/api/src/composition/module.ts");
  write("apps/worker/src/worker.ts", 'import "../../api/src/features/auth/auth.service";\n');
  write("packages/core/src/core.ts", 'import "../../../apps/api/src/features/auth/auth.service";\n');

  const audit = scanSourceDirectionViolations(directory);
  assert.deepEqual(new Set(audit.violations.map(({ rule }) => rule)), new Set([
    "infrastructure-imports-feature",
    "feature-imports-composition",
    "worker-imports-api-source",
    "core-imports-application-source",
  ]));
  assert.deepEqual(audit.staleExceptions, []);
});
