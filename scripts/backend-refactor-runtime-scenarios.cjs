"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");
const { scenarioReport } = require("./backend-refactor-scenarios.cjs");
const { isolatedEnvironment } = require("./test-module.cjs");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "docs/backend-refactor/runtime-test-scenarios.json");
const happyFlowSource = "scripts/compensa-happy-flow.test.cjs";

function tapTestFile(sourcePath) {
  if (sourcePath.startsWith("apps/api/src/")) {
    return path.join(root, sourcePath.replace("apps/api/src/", "apps/api/dist/").replace(/\.ts$/, ".js"));
  }
  if (sourcePath.startsWith("apps/worker/src/")) {
    return path.join(root, sourcePath.replace("apps/worker/src/", "apps/worker/dist/").replace(/\.ts$/, ".js"));
  }
  return path.join(root, sourcePath);
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function patternMatcher(pattern) {
  return new RegExp(`^${pattern.split("${*}").map(escapeRegExp).join(".*")}$`);
}

function staticOptInVariants(filePatterns) {
  const sourcePath = happyFlowSource;
  const absolute = path.join(root, sourcePath);
  const text = fs.readFileSync(absolute, "utf8");
  const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const variants = new Set();
  const loops = new Map();
  const calls = [];
  const visit = (node, activeLoops = []) => {
    if (ts.isForOfStatement(node)) {
      const declaration = ts.isVariableDeclarationList(node.initializer) ? node.initializer.declarations[0] : null;
      const names = declaration && ts.isIdentifier(declaration.name) ? [declaration.name.text] : [];
      const values = ts.isArrayLiteralExpression(node.expression) ? node.expression.elements
        .filter((item) => ts.isStringLiteralLike(item)).map((item) => item.text) : [];
      if (names.length && values.length) loops.set(names[0], values);
      ts.forEachChild(node, (child) => visit(child, [...activeLoops, { names, values }]));
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test"
      && node.arguments[0] && ts.isTemplateExpression(node.arguments[0])) calls.push(node.arguments[0]);
    ts.forEachChild(node, (child) => visit(child, activeLoops));
  };
  visit(source);
  for (const template of calls) {
    const referenced = template.templateSpans.map((span) => ts.isIdentifier(span.expression) ? span.expression.text : null);
    const values = referenced.map((name) => name ? loops.get(name) : null);
    if (values.some((items) => !items?.length)) continue;
    for (let index = 0; index < values[0].length; index += 1) {
      let title = template.head.text;
      template.templateSpans.forEach((span, spanIndex) => {
        title += String(values[spanIndex][index]) + span.literal.text;
      });
      if (filePatterns.some((item) => patternMatcher(item.titlePattern).test(title))) variants.add(title);
    }
  }
  return [...variants].sort();
}

function tapTitles(sourcePath, cases, tempDir) {
  const testFile = tapTestFile(sourcePath);
  if (!fs.existsSync(testFile)) throw new Error(`RUNTIME_SCENARIO_DIST_MISSING_${sourcePath}`);
  const env = isolatedEnvironment(process.env, "scenario-variants", tempDir);
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", testFile], {
    cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code ?? result.error?.name ?? `exit_${result.status}`;
    throw new Error(`RUNTIME_SCENARIO_RUN_FAILED_${sourcePath}_${reason}`);
  }
  const lines = result.stdout.split(/\r?\n/);
  const titles = lines.flatMap((line) => {
    const match = line.match(/^\s*# Subtest: (.*)$/);
    return match ? [match[1]] : [];
  });
  if (!titles.length) throw new Error("RUNTIME_SCENARIO_TAP_HAS_NO_TITLES_" + sourcePath + "_stdout_" + JSON.stringify(result.stdout.slice(0, 160)) + "_stderr_" + JSON.stringify(result.stderr.slice(0, 160)) + "_file_" + testFile);
  return cases.flatMap((scenario) => {
    const matcher = patternMatcher(scenario.titlePattern);
    return titles.filter((title) => matcher.test(title)).map((title) => {
      const resultLine = lines.find((line) => {
        const match = line.match(/^\s*(?:ok|not ok)\s+\d+\s+-\s+(.*)$/);
        return match && match[1].replace(/\s+#\s+(?:SKIP|TODO).*$/, "") === title;
      });
      return { scenario, title, skip: resultLine?.includes("# SKIP") ?? false };
    });
  });
}

function runtimeScenarioReport() {
  const declarations = scenarioReport().cases.filter((item) => item.dynamicTitle);
  const byFile = new Map();
  for (const declaration of declarations) {
    if (!byFile.has(declaration.sourcePath)) byFile.set(declaration.sourcePath, []);
    byFile.get(declaration.sourcePath).push(declaration);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-runtime-scenarios-"));
  try {
    const expanded = [];
    for (const [sourcePath, patterns] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
      if (sourcePath === happyFlowSource) {
        for (const [index, title] of staticOptInVariants(patterns).entries()) {
          expanded.push({ scenario: patterns[0], title, skip: true, optInOnly: true, variantOrdinal: index + 1 });
        }
        continue;
      }
      const matched = tapTitles(sourcePath, patterns, tempDir);
      for (const pattern of patterns) {
        if (!matched.some((item) => item.scenario.id === pattern.id)) {
          const titles = matched.map((item) => item.title).slice(0, 8).join("|");
          throw new Error(`RUNTIME_SCENARIO_PATTERN_UNMATCHED_${sourcePath}_${pattern.id}_${pattern.titlePattern}_titles_${titles}`);
        }
      }
      expanded.push(...matched);
    }

    const occurrences = new Map();
    const cases = expanded.map(({ scenario, title, skip, optInOnly = false }) => {
      const key = `${scenario.id}\0${title}`;
      const ordinal = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, ordinal);
      const id = createHash("sha256").update(key).digest("hex").slice(0, 12);
      return {
        id: `TV-${id}${ordinal > 1 ? `-${ordinal}` : ""}`,
        declarationId: scenario.id,
        owner: scenario.owner,
        stage: scenario.stage,
        sourcePath: scenario.sourcePath,
        targetPath: scenario.targetPath,
        title,
        skipCondition: optInOnly ? "test:compensa-happy-flow (browser fixture is opt-in)" : scenario.skipCondition,
        runtimeStatus: optInOnly ? "opt-in-not-executed" : skip ? "skipped-by-guard" : "passed-during-inventory",
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const families = new Set(cases.map((item) => item.declarationId));
    if (families.size !== declarations.length) throw new Error("RUNTIME_SCENARIO_FAMILY_COVERAGE_MISMATCH");
    return {
      schemaVersion: 1,
      generator: "scripts/backend-refactor-runtime-scenarios.cjs",
      evidence: {
        declarationFamilies: declarations.length,
        runtimeVariants: cases.length,
        fixtureVariantsNotExecuted: cases.filter((item) => item.runtimeStatus === "opt-in-not-executed").length,
        variantsSkippedByGuard: cases.filter((item) => item.runtimeStatus === "skipped-by-guard").length,
        missingFamilies: [],
      },
      cases,
    };
  } finally {
    const resolvedTemp = path.resolve(tempDir);
    if (path.dirname(resolvedTemp) !== path.resolve(os.tmpdir()) || !path.basename(resolvedTemp).startsWith("goldis-runtime-scenarios-")) {
      throw new Error("RUNTIME_SCENARIO_TEMP_PATH_OWNERSHIP_INVALID");
    }
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const result = runtimeScenarioReport();
  if (process.argv.includes("--write")) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`BACKEND_RUNTIME_SCENARIOS_WRITTEN families=${result.evidence.declarationFamilies} variants=${result.evidence.runtimeVariants} path=${path.relative(root, output)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result.evidence, null, 2)}\n`);
  }
}

module.exports = { output, patternMatcher, runtimeScenarioReport };
