"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const allowedExceptionsPath = path.join(__dirname, "feature-boundary-exceptions.json");
const layerExceptionsPath = path.join(__dirname, "backend-layer-exceptions.json");
const publicExportExceptionsPath = path.join(__dirname, "backend-public-export-exceptions.json");
const sourceDirectionExceptionsPath = path.join(__dirname, "backend-source-direction-exceptions.json");
const databaseMethods = new Set([
  "query", "create", "bulkCreate", "update", "destroy", "findByPk", "findOne", "findAll", "findOrCreate",
  "findAndCountAll", "count", "increment", "decrement", "upsert", "save", "reload", "transaction",
]);

function walkTs(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkTs(file);
    return entry.isFile() && entry.name.endsWith(".ts") ? [file] : [];
  });
}

function featureName(file, sourceRoot) {
  const relative = path.relative(path.join(sourceRoot, "features"), file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep)[0] || null;
}

function resolveTsImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function readSpecifiers(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require"
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...new Set(specifiers)];
}

function scanPublicEntryViolations(files, sourceRoot, exceptions = []) {
  const allowed = new Set(exceptions.map((entry) => `${entry.file}|${entry.import}|${entry.rule}|${entry.symbol}`));
  const observed = new Set();
  const violations = [];
  for (const file of files) {
    const relative = path.relative(sourceRoot, file).replace(/\\/g, "/");
    if (!relative.startsWith("features/") || !["index.ts", "public.ts"].includes(path.basename(relative))) continue;
    const source = ts.createSourceFile(relative, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.moduleSpecifier
        || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const target = resolveTsImport(file, specifier);
      if (!target) continue;
      const targetRelative = path.relative(sourceRoot, target).replace(/\\/g, "/");
      const exported = statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text)
        : ["*"];
      const rules = [];
      if (/\.controller\.ts$/.test(targetRelative) || exported.some((name) => /Controller$/.test(name))) {
        rules.push("public-entry-controller-export");
      }
      if (/\.model\.ts$/.test(targetRelative) && exported.some((name) => name === "*" || /Model$/.test(name))) {
        rules.push("public-entry-model-export");
      }
      if (/(?:\.repository|\.internal|\.private)\.ts$/.test(targetRelative)) {
        rules.push("public-entry-private-reexport");
      }
      for (const rule of rules) {
        for (const symbol of exported.filter((name) => rule === "public-entry-controller-export"
          ? name === "*" || /Controller$/.test(name) || /\.controller\.ts$/.test(targetRelative)
          : rule === "public-entry-model-export"
            ? name === "*" || /Model$/.test(name)
            : true)) {
          const entry = { file: relative, import: specifier, rule, symbol };
          const key = `${relative}|${specifier}|${rule}|${symbol}`;
          observed.add(key);
          if (!allowed.has(key)) violations.push(entry);
        }
      }
    }
  }
  const staleExceptions = [...allowed].filter((key) => !observed.has(key));
  return { violations, staleExceptions };
}

function scanSourceDirectionViolations(repositoryRoot, exceptions = []) {
  const allowed = new Set(exceptions.map((entry) => `${entry.file}|${entry.import}|${entry.rule}`));
  const observed = new Set();
  const roots = {
    api: path.join(repositoryRoot, "apps/api/src"),
    worker: path.join(repositoryRoot, "apps/worker/src"),
    core: path.join(repositoryRoot, "packages/core/src"),
  };
  const violations = [];
  const inside = (file, directory) => {
    const relative = path.relative(directory, file);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  for (const [owner, sourceRoot] of Object.entries(roots)) {
    for (const file of walkTs(sourceRoot)) {
      const relative = path.relative(sourceRoot, file).replace(/\\/g, "/");
      if (/\.(?:http\.)?spec\.ts$/.test(relative) || /(?:^|\/)migrations\//.test(relative)) continue;
      for (const specifier of readSpecifiers(file)) {
        const target = resolveTsImport(file, specifier);
        const targetApi = target && inside(target, roots.api);
        const targetWorker = target && inside(target, roots.worker);
        const targetCore = target && inside(target, roots.core);
        let rule = null;
        if (owner === "api" && (targetWorker || specifier.startsWith("@goldis/worker"))) rule = "api-imports-worker-source";
        if (owner === "worker" && (targetApi || specifier.startsWith("@goldis/api"))) rule = "worker-imports-api-source";
        if (owner === "core" && (targetApi || targetWorker || specifier.startsWith("@goldis/api") || specifier.startsWith("@goldis/worker"))) {
          rule = "core-imports-application-source";
        }
        if (owner === "api" && relative.startsWith("infrastructure/") && targetApi) {
          const targetRelative = path.relative(roots.api, target).replace(/\\/g, "/");
          if (targetRelative.startsWith("features/")) rule = "infrastructure-imports-feature";
          if (targetRelative.startsWith("composition/")) rule = "infrastructure-imports-composition";
        }
        if (owner === "api" && relative.startsWith("features/") && targetApi) {
          const targetRelative = path.relative(roots.api, target).replace(/\\/g, "/");
          if (targetRelative.startsWith("composition/")) rule = "feature-imports-composition";
        }
        if (rule) {
          const entry = { file: `${owner}/${relative}`, import: specifier, rule };
          const key = `${entry.file}|${entry.import}|${entry.rule}`;
          observed.add(key);
          if (!allowed.has(key)) violations.push(entry);
        }
      }
    }
  }
  return { violations, staleExceptions: [...allowed].filter((key) => !observed.has(key)) };
}

function scanLayerViolations(files, sourceRoot, exceptions) {
  const allowed = new Map(exceptions.map((entry) => [`${entry.file}|${entry.rule}`, entry.maximum]));
  const counts = new Map();
  const details = [];
  for (const file of files) {
    const relative = path.relative(sourceRoot, file).replace(/\\/g, "/");
    if (!relative.startsWith("features/")) continue;
    const isTest = /\.(?:http\.)?spec\.ts$/.test(relative);
    if (isTest) continue;
    const source = ts.createSourceFile(relative, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const add = (rule, node) => {
      const key = `${relative}|${rule}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      details.push({ file: relative, rule, count, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    };
    const serviceOrController = /\.(?:service|controller)\.ts$/.test(relative);
    function visit(node) {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        && /(?:^|\/)infrastructure\/database\/db$/.test(node.moduleSpecifier.text)) {
        const clause = node.importClause;
        const typeOnly = Boolean(clause?.isTypeOnly)
          || Boolean(clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
            && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((item) => item.isTypeOnly));
        if (!typeOnly && serviceOrController) add("service-controller-global-db-import", node);
      }
      if (serviceOrController && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        const modelCall = /^[A-Z][A-Za-z0-9_]*$/.test(receiver.getText(source)) && databaseMethods.has(method);
        const connectionCall = ["query", "transaction"].includes(method)
          && /(?:sequelize|database|this\.database)/.test(receiver.getText(source));
        if (modelCall || connectionCall) add("service-controller-persistence-call", node);
      }
      if (serviceOrController && (ts.isStringLiteralLike(node)
        || ts.isNoSubstitutionTemplateLiteral(node)) && /^\s*(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|WITH\s+)/i.test(node.text)) {
        add("service-controller-sql-text", node);
      }
      if (serviceOrController && ts.isCallExpression(node)
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
        && /(?:^|\/)infrastructure\/database\/db(?:\.[cm]?[jt]s)?$/.test(node.arguments[0].text)) {
        add("service-controller-global-db-import", node);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (/\.service\.ts$/.test(relative)) {
      let hasController = false;
      function scanDecorators(node) {
        if ((ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) && node.modifiers?.some((modifier) =>
          modifier.kind === ts.SyntaxKind.Decorator && /@Controller\b/.test(modifier.getText(source)))) hasController = true;
        ts.forEachChild(node, scanDecorators);
      }
      scanDecorators(source);
      if (hasController) add("service-also-declares-controller", source);
    }
  }
  const violations = [];
  for (const [key, count] of counts) {
    const [file, rule] = key.split("|");
    const maximum = allowed.get(key) ?? 0;
    if (count > maximum) violations.push({ file, rule, count, maximum });
  }
  const staleExceptions = [...allowed].filter(([key]) => !counts.has(key)).map(([key]) => key);
  return { counts: Object.fromEntries(counts), violations, staleExceptions, details };
}

function exceptionSet(exceptions) {
  return new Set(exceptions.map((item) => `${item.from}|${item.import}|${item.reason}`));
}

function findCycles(edges) {
  const cycles = [];
  const state = new Map();
  const stack = [];
  const seen = new Set();
  function visit(node) {
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === 1) {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const key = cycle.join(" -> ");
        if (!seen.has(key)) { cycles.push(cycle); seen.add(key); }
      } else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  }
  for (const node of edges.keys()) if (!state.has(node)) visit(node);
  return cycles;
}

function checkFeatureBoundaries(apiSourceRoot, exceptions = [], layerExceptions = [], publicExportExceptions = [], sourceDirectionExceptions = []) {
  const sourceRoot = path.resolve(apiSourceRoot);
  const files = walkTs(path.join(sourceRoot, "features"))
    .filter((file) => !/\.(?:http\.)?spec\.ts$/.test(file));
  const allowed = exceptionSet(exceptions);
  const violations = [];
  const edges = new Map();
  for (const file of files) {
    const from = featureName(file, sourceRoot);
    if (!from) continue;
    edges.set(from, edges.get(from) ?? new Set());
    for (const specifier of readSpecifiers(file)) {
      const targetFile = resolveTsImport(file, specifier);
      if (!targetFile) continue;
      const to = featureName(targetFile, sourceRoot);
      if (!to || to === from) continue;
      const relativeTarget = path.relative(path.join(sourceRoot, "features", to), targetFile).replace(/\\/g, "/");
      const publicEntry = ["index.ts", "public.ts"].includes(relativeTarget);
      const forbiddenController = /(?:^|\/)[^/]*\.controller(?:\.spec)?\.ts$/.test(relativeTarget);
      const exceptionKey = `${path.relative(sourceRoot, file).replace(/\\/g, "/")}|${specifier}|`;
      const exempt = [...allowed].some((value) => value.startsWith(exceptionKey));
      if ((!publicEntry || forbiddenController) && !exempt) {
        violations.push({ from, to, file: path.relative(sourceRoot, file).replace(/\\/g, "/"), import: specifier, target: relativeTarget });
      }
      edges.get(from).add(to);
    }
  }
  const cycles = findCycles(edges);
  const layerAudit = scanLayerViolations(walkTs(sourceRoot), sourceRoot, layerExceptions);
  const publicExportAudit = scanPublicEntryViolations(files, sourceRoot, publicExportExceptions);
  const sourceDirectionAudit = scanSourceDirectionViolations(path.resolve(sourceRoot, "..", "..", ".."), sourceDirectionExceptions);
  return { featureFileCount: files.length, violations, cycles, layerAudit, publicExportAudit, sourceDirectionAudit };
}

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const apiSourceRoot = path.join(root, "apps/api/src");
  const exceptions = JSON.parse(fs.readFileSync(allowedExceptionsPath, "utf8"));
  const layerExceptions = JSON.parse(fs.readFileSync(layerExceptionsPath, "utf8"));
  const publicExportExceptions = JSON.parse(fs.readFileSync(publicExportExceptionsPath, "utf8"));
  const sourceDirectionExceptions = JSON.parse(fs.readFileSync(sourceDirectionExceptionsPath, "utf8"));
  const result = checkFeatureBoundaries(apiSourceRoot, exceptions, layerExceptions, publicExportExceptions, sourceDirectionExceptions);
  if (result.violations.length || result.cycles.length || result.layerAudit.violations.length || result.layerAudit.staleExceptions.length
    || result.publicExportAudit.violations.length || result.publicExportAudit.staleExceptions.length
    || result.sourceDirectionAudit.violations.length || result.sourceDirectionAudit.staleExceptions.length) {
    process.stderr.write(`FEATURE_BOUNDARY_CHECK_FAILED ${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`FEATURE_BOUNDARY_CHECK_PASS files=${result.featureFileCount} exceptions=${exceptions.length} layer_exceptions=${layerExceptions.length} layer_findings=${result.layerAudit.details.length} public_export_exceptions=${publicExportExceptions.length} source_direction_exceptions=${sourceDirectionExceptions.length}\n`);
}

module.exports = { checkFeatureBoundaries, scanLayerViolations, scanPublicEntryViolations, scanSourceDirectionViolations };
