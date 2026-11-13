"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "docs/production-readiness/persistence-inventory.json");
const ROOTS = ["apps/api/src", "apps/worker/src", "packages/core/src"];
const MODEL_METHODS = new Set([
  "create", "bulkCreate", "update", "destroy", "findByPk", "findOne", "findAll",
  "findOrCreate", "findAndCountAll", "count", "increment", "decrement", "upsert", "save", "reload",
]);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") && !/\.(?:spec|test)\.ts$/.test(entry.name)
      ? [absolute] : [];
  }).sort();
}

function repoPath(file) { return path.relative(ROOT, file).split(path.sep).join("/"); }

function ownerFor(relative) {
  const match = relative.match(/^apps\/api\/src\/features\/([^/]+)/);
  if (match) return `api-feature:${match[1]}`;
  const process = relative.match(/^apps\/api\/src\/processes\/([^/]+)/);
  if (process) return `api-process:${process[1]}`;
  const apiInfra = relative.match(/^apps\/api\/src\/infrastructure\/([^/]+)/);
  if (apiInfra) return `api-infrastructure:${apiInfra[1]}`;
  if (relative.startsWith("apps/api/src/composition/")) return "api-composition";
  if (/^apps\/api\/src\/(?:main|migrate|apply-runtime-grants|enrichment-worker|import-parser-main|import-parser-child|commission-worker)\.ts$/.test(relative)) return "api-entrypoint";
  if (relative.startsWith("apps/api/src/contracts/")) return "api-contracts";
  const worker = relative.match(/^apps\/worker\/src\/([^/]+)(?:\/([^/]+))?/);
  if (worker) return `worker:${worker[1]}${worker[2] ? `/${worker[2]}` : ""}`;
  if (relative.startsWith("packages/core/src/")) return "packages-core";
  return "needs-review";
}

function sqlTables(text) {
  const tables = new Set();
  const pattern = /\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(["`]?)([a-z_][a-z0-9_.]*)(?:\1)/gi;
  for (const match of text.matchAll(pattern)) {
    const table = match[2].split(".").at(-1).replaceAll('"', "");
    if (!new Set(["select", "set", "values", "returning", "only", "unnest"]).has(table.toLowerCase())) tables.add(table);
  }
  return [...tables].sort();
}

function analyze(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const normalizedFile = file.replace(/\\/g, "/");
  const relative = normalizedFile.startsWith("apps/") || normalizedFile.startsWith("packages/")
    ? normalizedFile : repoPath(file);
  const calls = [];
  const imports = [];
  const modelNames = new Set();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      if (/database|sequelize|models/i.test(specifier)) {
        imports.push({ specifier, line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1 });
        if (statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
          for (const item of statement.importClause.namedBindings.elements) modelNames.add(item.name.text);
        }
      }
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(source);
      const method = node.expression.name.text;
      const sourceLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const receiverBase = receiver.split(".").at(-1);
      let operation = null;
      if (method === "query" && (/sequelize|database|pool|client|queryInterface/i.test(receiverBase) || /this\.database$/.test(receiver))) {
        operation = "sql-query";
      } else if (method === "transaction" && /sequelize|database/i.test(receiverBase)) {
        operation = "transaction";
      } else if (MODEL_METHODS.has(method) && (modelNames.has(receiverBase) || /^[A-Z][A-Za-z0-9_]*$/.test(receiverBase))) {
        operation = `orm-${method}`;
      }
      if (operation) {
        const literalText = node.arguments.map((arg) => {
          if (ts.isStringLiteralLike(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
          if (ts.isTemplateExpression(arg)) return arg.head.text + arg.templateSpans.map((span) => span.literal.text).join(" ");
          return "";
        }).join(" ");
        calls.push({ line: sourceLine, receiver, operation, tables: sqlTables(literalText) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const directDatabaseImports = imports.filter(({ specifier }) => /(?:^|\/)db(?:\.js)?$|infrastructure\/database|sequelize|models/i.test(specifier));
  if (!calls.length && !directDatabaseImports.length) return null;
  return {
    file: relative,
    owner: ownerFor(relative),
    persistenceImports: directDatabaseImports,
    callSites: calls,
    tables: [...new Set(calls.flatMap((call) => call.tables))].sort(),
    assessment: {
      tenantScope: "REVIEW_REQUIRED",
      transactionBoundary: "REVIEW_REQUIRED",
      locksAndCas: "REVIEW_REQUIRED",
      targetAdapter: "REVIEW_REQUIRED",
      behaviorTest: "REVIEW_REQUIRED",
    },
  };
}

function generateInventory({ now = new Date().toISOString(), files = null } = {}) {
  const candidates = (files ?? ROOTS.flatMap((entry) => walk(path.join(ROOT, entry))))
    .map((file) => analyze(file, fs.readFileSync(file, "utf8")))
    .filter(Boolean)
    .sort((a, b) => a.file.localeCompare(b.file));
  return {
    schemaVersion: 1,
    generatedAt: now,
    generator: "scripts/backend-persistence-inventory.cjs",
    scope: "Production TypeScript under API, worker and core source roots; static candidates require owner review.",
    summary: {
      scannedRoots: ROOTS,
      sourceFilesScanned: ROOTS.reduce((count, entry) => count + walk(path.join(ROOT, entry)).length, 0),
      candidateFiles: candidates.length,
      unresolvedOwners: candidates.filter((item) => item.owner === "needs-review").map((item) => item.file),
      unreviewedCandidates: candidates.length,
    },
    candidates,
  };
}

if (require.main === module) {
  const report = generateInventory();
  if (process.argv.includes("--write")) {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`PERSISTENCE_INVENTORY_WRITTEN scanned=${report.summary.sourceFilesScanned} candidates=${report.summary.candidateFiles} unresolvedOwners=${report.summary.unresolvedOwners.length} path=${path.relative(ROOT, OUTPUT)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  }
}

module.exports = { ROOTS, analyze, generateInventory, sqlTables };
