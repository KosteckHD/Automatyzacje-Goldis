"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const databaseMethods = new Set([
  "create", "bulkCreate", "update", "destroy", "findByPk", "findOne", "findAll", "findOrCreate",
  "findAndCountAll", "count", "increment", "decrement", "upsert", "save", "reload",
]);

function hasTransactionOption(call) {
  return call.arguments.some((argument) => ts.isObjectLiteralExpression(argument)
    && argument.properties.some((property) => ts.isShorthandPropertyAssignment(property)
      ? property.name.text === "transaction"
      : ts.isPropertyAssignment(property)
        && property.name.getText(call.getSourceFile()).replace(/["']/g, "") === "transaction"));
}

function walkProductionTypeScript(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "migrations") return [];
      return walkProductionTypeScript(file);
    }
    return entry.isFile() && entry.name.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(entry.name) ? [file] : [];
  });
}

function analyzeSource(sourceText, fileName = "transaction-audit-fixture.ts") {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];
  const transactions = [];
  function visit(node, transactionDepth) {
    let childDepth = transactionDepth;
    const transactionCall = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "transaction"
      ? node
      : null;
    const transactionReceiver = transactionCall?.expression.expression.getText(source);
    if (transactionCall
      && ["sequelize", "database", "this.database", "this.repository"].includes(transactionReceiver)) {
      if (transactionDepth > 0) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({ file: fileName, line: line + 1, kind: "nested-sequelize-transaction" });
      }
      const callback = transactionCall.arguments.at(-1);
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        if (transactionReceiver !== "this.database") transactions.push(node);
        childDepth += 1;
      }
    }
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node) || ts.isArrowFunction(node))
      && node.parameters.some((parameter) => ts.isIdentifier(parameter.name)
        && parameter.name.text === "transaction" && !parameter.questionToken && !parameter.initializer)) {
      childDepth += 1;
    }
    if (transactionDepth > 0 && ts.isCallExpression(node)) {
      const expression = node.expression;
      const methodName = ts.isIdentifier(expression) ? expression.text
        : ts.isPropertyAccessExpression(expression) ? expression.name.text : "";
      const receiver = ts.isPropertyAccessExpression(expression) ? expression.expression.getText(source) : "";
      const isAuditWrite = methodName === "recordAuditEvent"
        || (methodName === "record" && /audit/i.test(receiver));
      if (isAuditWrite && node.arguments.length < 2) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({ file: fileName, line: line + 1, kind: "audit-write-missing-transaction" });
      }
      const isSequelizeQuery = methodName === "query" && receiver === "sequelize";
      const isModelMethod = databaseMethods.has(methodName) && /^[A-Z][A-Za-z0-9_]*$/.test(receiver);
      const isInstanceWrite = ["save", "destroy"].includes(methodName)
        && ts.isIdentifier(expression.expression) && /^[a-z][A-Za-z0-9_]*$/.test(receiver);
      if ((isSequelizeQuery || isModelMethod || isInstanceWrite) && !hasTransactionOption(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({ file: fileName, line: line + 1, kind: "database-call-missing-transaction" });
      }
    }
    ts.forEachChild(node, (child) => visit(child, childDepth));
  }
  visit(source, 0);
  const parseErrors = source.parseDiagnostics.map((diagnostic) => ({
    file: fileName,
    kind: "typescript-parse-error",
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  }));
  return { transactions: transactions.length, violations: [...parseErrors, ...violations] };
}

function scanTransactionBoundaries(apiSourceRoot) {
  const root = path.resolve(apiSourceRoot);
  const files = walkProductionTypeScript(root);
  const violations = [];
  let transactionCount = 0;
  for (const file of files) {
    const result = analyzeSource(fs.readFileSync(file, "utf8"), path.relative(root, file).split(path.sep).join("/"));
    transactionCount += result.transactions;
    violations.push(...result.violations);
  }
  return { files, transactionCount, violations };
}

if (require.main === module) {
  const result = scanTransactionBoundaries(path.join(__dirname, "../apps/api/src"));
  if (result.violations.length > 0) {
    for (const violation of result.violations) console.error(`TRANSACTION_SCOPE_VIOLATION ${violation.file}:${violation.line ?? 0} ${violation.kind}`);
    process.exitCode = 1;
  } else {
    console.log(`TRANSACTION_SCOPE_AUDIT_PASS files=${result.files.length} transaction_boundaries=${result.transactionCount} nested_transactions=0 database_calls_missing_transaction=0 audit_calls_missing_transaction=0`);
  }
}

module.exports = { analyzeSource, scanTransactionBoundaries };
