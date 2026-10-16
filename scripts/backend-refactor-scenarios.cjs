"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const ts = require("typescript");
const { report: inventory } = require("./backend-refactor-inventory.cjs");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "docs/backend-refactor/test-scenarios.json");

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() && (/\.(?:http\.)?spec\.(?:ts|js)$/.test(entry.name) || /\.test\.cjs$/.test(entry.name)) ? [absolute] : [];
  });
}

function titleFor(node, sourceFile, constants) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { title: node.text, dynamic: false };
  }
  if (ts.isTemplateExpression(node)) {
    return {
      title: node.head.text + node.templateSpans.map((span) => `\0${span.literal.text}`).join("").replace(/\u0000/g, "${*}"),
      dynamic: true,
    };
  }
  if (ts.isIdentifier(node) && constants.has(node.text)) return { title: constants.get(node.text), dynamic: false };
  return { title: node.getText(sourceFile).replace(/\s+/g, " ").trim(), dynamic: true };
}

function skipConditionFor(call, sourceFile) {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return null;
  const skip = options.properties.find((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
    const name = property.name;
    return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "skip";
  });
  if (!skip) return null;
  if (ts.isPropertyAssignment(skip)) {
    if (skip.initializer.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (skip.initializer.kind === ts.SyntaxKind.FalseKeyword) return null;
    return skip.initializer.getText(sourceFile).replace(/\s+/g, " ").trim();
  }
  return skip.name.getText(sourceFile);
}

function callsIn(file, targetPath, owner, stage) {
  const text = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const constants = new Map();
  const testBindings = new Set();
  const testNamespaceBindings = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === "node:test") {
      if (statement.importClause?.name) testBindings.add(statement.importClause.name.text);
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === "test" || importedName === "it") testBindings.add(element.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        testNamespaceBindings.add(bindings.name.text);
      }
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer && ts.isCallExpression(declaration.initializer)
        && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === "require"
        && declaration.initializer.arguments[0] && ts.isStringLiteral(declaration.initializer.arguments[0])
        && declaration.initializer.arguments[0].text === "node:test") {
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const importedName = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text : element.name.text;
            if (importedName === "test" || importedName === "it") testBindings.add(element.name.text);
          }
        } else if (ts.isIdentifier(declaration.name)) {
          if (["test", "it"].includes(declaration.name.text)) testBindings.add(declaration.name.text);
          else testNamespaceBindings.add(declaration.name.text);
        }
      }
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (ts.isStringLiteralLike(declaration.initializer) || ts.isNoSubstitutionTemplateLiteral(declaration.initializer)) {
        constants.set(declaration.name.text, declaration.initializer.text);
      }
    }
  }

  const testContextBindings = new Set();
  const isImportedTestCall = (expression) => ts.isIdentifier(expression) && testBindings.has(expression.text);
  const collectTestContexts = (node) => {
    if (ts.isCallExpression(node) && isImportedTestCall(node.expression)) {
      const callback = node.arguments[1];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const firstParameter = callback.parameters[0]?.name;
        if (firstParameter && ts.isIdentifier(firstParameter)) testContextBindings.add(firstParameter.text);
      }
    }
    ts.forEachChild(node, collectTestContexts);
  };
  collectTestContexts(sourceFile);
  const isNodeTestCall = (expression) => {
    if (isImportedTestCall(expression)) return true;
    if (!ts.isPropertyAccessExpression(expression) || !["test", "it"].includes(expression.name.text)) return false;
    if (ts.isIdentifier(expression.expression)) {
      return testNamespaceBindings.has(expression.expression.text) || testContextBindings.has(expression.expression.text);
    }
    return ts.isCallExpression(expression.expression) && ts.isIdentifier(expression.expression.expression)
      && expression.expression.expression.text === "require"
      && expression.expression.arguments[0] && ts.isStringLiteral(expression.expression.arguments[0])
      && expression.expression.arguments[0].text === "node:test";
  };

  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (isNodeTestCall(node.expression) && node.arguments.length > 0) {
        const title = titleFor(node.arguments[0], sourceFile, constants);
        calls.push({
          owner,
          stage,
          sourcePath: path.relative(root, file).replace(/\\/g, "/"),
          targetPath,
          titlePattern: title.title,
          dynamicTitle: title.dynamic,
          skipCondition: skipConditionFor(node, sourceFile),
          testKind: /\.http\./.test(targetPath) ? "http"
            : /\.integration\./.test(targetPath) ? "integration"
              : /(?:^|[-.])contract\./.test(targetPath) ? "contract" : "unit",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function inventoryTestFiles() {
  const typed = inventory.files.filter((entry) => entry.kind === "test" && /\.(?:http\.)?(?:test|spec)\.ts$/.test(entry.path)).map((entry) => ({
    sourcePath: entry.path,
    targetPath: entry.proposedPath,
    owner: entry.owner,
    stage: entry.stage,
  }));
  const extras = ["scripts", "deploy/backup"].flatMap((directory) => walk(path.join(root, directory)))
    .map((absolute) => {
      const sourcePath = path.relative(root, absolute).replace(/\\/g, "/");
      return { sourcePath, targetPath: sourcePath, owner: sourcePath.startsWith("deploy/") ? "backup" : "test-tooling", stage: "P1" };
    });
  return [...typed, ...extras].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function scenarioReport() {
  const files = inventoryTestFiles();
  const cases = [];
  const filesWithoutCases = [];
  for (const file of files) {
    const found = callsIn(path.join(root, file.sourcePath), file.targetPath, file.owner, file.stage);
    if (!found.length) filesWithoutCases.push(file.sourcePath);
    const occurrences = new Map();
    for (const item of found) {
      const key = `${item.owner}\0${item.targetPath}\0${item.titlePattern}`;
      const ordinal = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, ordinal);
      const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
      cases.push({
        id: `TC-${digest}${ordinal > 1 ? `-${ordinal}` : ""}`,
        ...item,
      });
    }
  }
  cases.sort((a, b) => a.id.localeCompare(b.id));
  const duplicateIds = [...new Set(cases.map((item) => item.id))]
    .filter((id) => cases.filter((item) => item.id === id).length > 1);
  return {
    schemaVersion: 1,
    generator: "scripts/backend-refactor-scenarios.cjs",
    evidence: {
      testFiles: files.length,
      scenarioPatterns: cases.length,
      dynamicTitlePatterns: cases.filter((item) => item.dynamicTitle).length,
      scenariosWithSkipConditions: cases.filter((item) => item.skipCondition !== null).length,
      filesWithoutCases,
      duplicateIds,
    },
    cases,
  };
}

if (require.main === module) {
  const result = scenarioReport();
  if (result.evidence.filesWithoutCases.length || result.evidence.duplicateIds.length) {
    process.stderr.write(`BACKEND_REFACTOR_SCENARIOS_INVALID filesWithoutCases=${result.evidence.filesWithoutCases.length} duplicateIds=${result.evidence.duplicateIds.length}\n`);
    process.exitCode = 1;
  } else if (process.argv.includes("--write")) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`BACKEND_REFACTOR_SCENARIOS_WRITTEN testFiles=${result.evidence.testFiles} cases=${result.evidence.scenarioPatterns} path=${path.relative(root, output)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result.evidence, null, 2)}\n`);
  }
}

module.exports = { output, scenarioReport };
