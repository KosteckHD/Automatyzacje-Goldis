"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const outputPath = path.join(root, "docs/backend-refactor/import-side-effect-candidates.json");
const reviewPath = path.join(root, "docs/backend-refactor/import-side-effect-review.json");
const write = process.argv.includes("--write");
const effectfulConstructors = /^(?:Sequelize|Pool|Redis|Queue|Worker|PrismaClient|Browser|BrowserContext|NestFactory|WebSocketServer)$/;
const effectfulCalls = /(?:^|\.)(?:setInterval|setTimeout|setImmediate|spawn|fork|exec|createServer|listen|connect|authenticate|sync|exit)$/;

function repoPath(file) { return path.relative(root, file).replace(/\\/g, "/"); }
function nodeName(node, source) {
  if (!node) return "";
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${nodeName(node.expression, source)}.${node.name.text}`;
  if (ts.isElementAccessExpression(node)) return `${nodeName(node.expression, source)}[${node.argumentExpression?.getText(source) ?? ""}]`;
  return node.getText(source);
}
function isFunctionBoundary(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isClassDeclaration(node) || ts.isClassExpression(node);
}

function scanFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = new Map();
  const add = (kind, expression, node, entrypointGuarded) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    const key = `${kind}|${expression}|${line + 1}|${entrypointGuarded}`;
    findings.set(key, { kind, expression, line: line + 1, entrypointGuarded, excerpt: node.getText(source).slice(0, 180) });
  };
  const visit = (node, entrypointGuarded = false) => {
    if (node !== source && isFunctionBoundary(node)) return;
    if (ts.isIfStatement(node)) {
      const condition = node.expression.getText(source).replace(/\s+/g, "");
      const isEntrypointGuard = condition === "require.main===module" || condition === "module===require.main";
      visit(node.expression, entrypointGuarded);
      visit(node.thenStatement, entrypointGuarded || isEntrypointGuard);
      if (node.elseStatement) visit(node.elseStatement, entrypointGuarded);
      return;
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === "process" && node.name.text === "env") {
      add("top-level-environment-read", node.getText(source), node, entrypointGuarded);
    }
    if (ts.isNewExpression(node)) {
      const name = nodeName(node.expression, source).split(".").at(-1) ?? "";
      if (effectfulConstructors.test(name)) add("top-level-client-construction", nodeName(node.expression, source), node, entrypointGuarded);
    }
    if (ts.isCallExpression(node)) {
      const name = nodeName(node.expression, source);
      if (effectfulCalls.test(name)) add("top-level-runtime-effect", name, node, entrypointGuarded);
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add("top-level-dynamic-require", name, node, entrypointGuarded);
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add("top-level-dynamic-import", "import()", node, entrypointGuarded);
    }
    ts.forEachChild(node, (child) => visit(child, entrypointGuarded));
  };
  for (const statement of source.statements) visit(statement);
  return [...findings.values()].sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

const inventory = require("./backend-refactor-inventory.cjs").report;
const files = inventory.files.filter((file) => file.kind === "source").map((file) => path.join(root, file.path));
const candidates = files.flatMap((file) => {
  const findings = scanFile(file);
  return findings.length ? [{ file: repoPath(file), findings }] : [];
});
const manualReview = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
const reviewByFile = new Map(manualReview.candidateFiles.map((entry) => [entry.file, entry]));
const reviewedCandidates = candidates.map((candidate) => ({
  ...candidate,
  review: reviewByFile.get(candidate.file) ?? null,
}));
const unreviewedCandidateFiles = candidates.map((entry) => entry.file)
  .filter((file) => !reviewByFile.has(file));
const staleReviewFiles = [...reviewByFile.keys()].filter((file) => !candidates.some((entry) => entry.file === file));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scanner: "scripts/backend-refactor-import-effects.cjs",
  scope: "Static top-level scan only; findings require source review. Function bodies and class bodies are excluded because they execute after import, except module-level calls that invoke them.",
  evidence: { runtimeSourceFilesScanned: files.length, filesWithCandidates: candidates.length,
    candidateCount: candidates.reduce((total, entry) => total + entry.findings.length, 0),
    unguardedCandidateCount: candidates.reduce((total, entry) => total + entry.findings.filter((finding) => !finding.entrypointGuarded).length, 0),
    unreviewedCandidateFiles, staleReviewFiles },
  candidates: reviewedCandidates,
};

if (require.main === module) {
  if (write) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`IMPORT_EFFECT_SCAN_WRITTEN files=${files.length} candidateFiles=${candidates.length} candidates=${report.evidence.candidateCount} path=${path.relative(root, outputPath)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ ...report.evidence, candidates }, null, 2)}\n`);
  }
}

module.exports = { report, scanFile };
