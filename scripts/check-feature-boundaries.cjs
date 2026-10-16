"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const allowedExceptionsPath = path.join(__dirname, "feature-boundary-exceptions.json");

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

function checkFeatureBoundaries(apiSourceRoot, exceptions = []) {
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
  return { featureFileCount: files.length, violations, cycles };
}

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const apiSourceRoot = path.join(root, "apps/api/src");
  const exceptions = JSON.parse(fs.readFileSync(allowedExceptionsPath, "utf8"));
  const result = checkFeatureBoundaries(apiSourceRoot, exceptions);
  if (result.violations.length || result.cycles.length) {
    process.stderr.write(`FEATURE_BOUNDARY_CHECK_FAILED ${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`FEATURE_BOUNDARY_CHECK_PASS files=${result.featureFileCount} exceptions=${exceptions.length}\n`);
}

module.exports = { checkFeatureBoundaries };
