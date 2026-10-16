"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const write = process.argv.includes("--write");
const outputPath = path.join(root, "docs/backend-refactor/inventory.json");

const apiFeatureRules = [
  [/^(health|http-bootstrap|public-output|request-metadata|request-protection)/, "infrastructure/http", "P2"],
  [/^(db|migrate|migration-path|apply-runtime-grants)/, "infrastructure/database", "P3"],
  [/^(account-recovery-tokens|auth-mail-|auth-recovery|recovery-email|resend-mail-provider)/, "account-recovery", "P6"],
  [/^(session|password-|login-rate-limiter|bootstrap-admin|offline-admin-password-reset|user-serialization)/, "auth", "P5"],
  [/^(authorization-|resource-scope|tool-access)/, "authorization", "P5"],
  [/^admin-reports/, "reports", "P6/P11"],
  [/^(admin|manager-revocation)/, "admin", "P6"],
  [/^(team)/, "teams", "P6"],
  [/^(audit|privileged-actions)/, "audit", "P6"],
  [/^deletion-step-up/, "deletions", "P12"],
  [/^(imports|workbook|import-parser(?:-|$))/, "imports", "P7"],
  [/^(import-preparations|preparation-)/, "preparations", "P7"],
  [/^entity-grouping/, "grouping", "P7"],
  [/^(review|portal-review-contract)/, "review", "P7"],
  [/^(enrichment-|registry-|mf-vat|gus-bir)/, "enrichment", "P8"],
  [/^run-export/, "results", "P11"],
  [/^(runs|run-|worker-execution)/, "runs", "P9"],
  [/^(prepared-set-executions)/, "submissions", "P9"],
  [/^(auth-challenges|interventions|manual-data|sms-retry-policy)/, "interventions", "P10"],
  [/^(artifact-|private-artifact-store|pesel-crypto|canonical-json|oc-snapshot-store|export|worker-results|lead-result-snapshots)/, "results", "P11"],
  [/^(business-leads|lead-import-deletion)/, "leads", "P11"],
  [/^notifications/, "notifications", "P11"],
  [/^(dashboard|contact-reports|history)/, "reports", "P11"],
  [/^(deletion|deletions)/, "deletions", "P12"],
  [/^(main|module)/, "composition", "P2"],
  [/^warsaw-time$|^list-query$/, "shared", "P2"],
];

const workerFeatureRules = [
  [/^(run-worker|index|api-readiness)/, "application", "P13"],
  [/^test-support\//, "testing", "P13"],
  [/^(execution-lease|live-run|pipeline|ports|memory-run-repository)/, "features/execution", "P13"],
  [/^(auth-challenges|code-inbox)/, "features/authentication", "P13"],
  [/^(identity)/, "features/identity", "P13"],
  [/^(oc|result-forwarder|result-staging)/, "features/results", "P13"],
  [/^(pg-run-repository|browser)$/, "infrastructure", "P13"],
  [/^(portal-action|portal-locator|portal-navigation|portal-runtime-config|portal-session)/, "portals/shared", "P13"],
  [/^(pzu-session|everest-identity-provider)/, "portals/pzu", "P13"],
  [/^compensa-/, "portals/compensa", "P13"],
];
const existingApiFeatureOwners = new Map([
  ["health", ["health", "P2"]],
  ["auth", ["auth", "P5"]],
  ["identity", ["identity", "P5"]],
  ["authorization", ["authorization", "P5"]],
  ["teams", ["teams", "P6"]],
  ["notifications", ["notifications", "P11"]],
  ["results", ["results", "P11"]],
  ["deletions", ["deletions", "P6"]],
  ["account-recovery", ["account-recovery", "P6"]],
  ["admin", ["admin", "P6"]],
  ["audit", ["audit", "P6"]],
  ["imports", ["imports", "P7"]],
  ["reports", ["reports", "P6/P11"]],
  ["leads", ["leads", "P11"]],
  ["grouping", ["grouping", "P7"]],
  ["runs", ["runs", "P9"]],
  ["submissions", ["submissions", "P9"]],
  ["preparations", ["preparations", "P7"]],
  ["review", ["review", "P7"]],
  ["enrichment", ["enrichment", "P8"]],
  ["tools", ["tools", "P6"]],
]);
const compatibilityFeatureBarrels = new Set([
  "audit", "auth-recovery", "authorization-guard", "authorization-policy", "login-rate-limiter",
  "password-change", "password-hash", "password-policy", "resource-scope", "session", "team",
  "import-preparations", "preparation-analysis", "preparation-export", "preparation-workflows",
  "enrichment-jobs", "enrichment-worker", "gus-bir-provider", "mf-vat-provider", "registry-cache",
  "registry-enrichment", "registry-lookup", "registry-provider", "registry-provider-factory",
  "registry-request-budget", "registry-request-pacer",
  "deletion-jobs", "deletions",
  "artifact-crypto", "private-artifact-store",
]);

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  }).sort();
}

function toRepoPath(file) { return path.relative(root, file).replace(/\\/g, "/"); }
function readAst(file) {
  const text = fs.readFileSync(file, "utf8");
  return { text, ast: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
}
function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.getText();
}
function decoratorName(decorator) {
  const expression = decorator.expression;
  const target = ts.isCallExpression(expression) ? expression.expression : expression;
  return ts.isIdentifier(target) ? target.text : target.getText();
}
function decoratorArgs(decorator) {
  const expression = decorator.expression;
  return ts.isCallExpression(expression) ? expression.arguments.map(literalText) : [];
}
function decoratorsOf(node) {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}
function namesFromDecorators(node, wanted) {
  return decoratorsOf(node).filter((item) => wanted.has(decoratorName(item))).map((item) => ({
    name: decoratorName(item), args: decoratorArgs(item),
  }));
}
function exportsOf(ast) {
  const names = [];
  for (const statement of ast.statements) {
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (statement.name) names.push(statement.name.text);
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
    if (ts.isExportDeclaration(statement)) names.push(`re-export:${statement.moduleSpecifier?.text ?? "*"}`);
  }
  return [...new Set(names)].sort();
}
function importsOf(ast) {
  const imports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require"
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return imports;
}
function ownerFor(area, basename, sourceText = "") {
  const feature = basename.replace(/\.(?:http\.)?spec\.ts$/, "")
    .replace(/\.contract\.ts$/, "").replace(/\.ts$/, "");
  if (area === "apps/api") {
    if (["main.ts", "migrate.ts", "apply-runtime-grants.ts", "bootstrap-admin-main.ts", "import-parser-main.ts", "import-parser-child.ts", "enrichment-worker.ts"].includes(basename)) {
      return { owner: "process-entrypoint", stage: "P14" };
    }
    const currentFeature = feature.match(/^features\/([^/]+)/)?.[1];
    if (currentFeature) {
      const [owner, stage] = existingApiFeatureOwners.get(currentFeature) ?? [currentFeature, "P0"];
      return { owner, stage };
    }
    if (feature === "contracts/deletion-barrier") return { owner: "contracts/deletions", stage: "P12" };
    if (feature.startsWith("contracts/")) return { owner: "contracts", stage: "P14" };
    if (feature.startsWith("infrastructure/artifacts/")) {
      return { owner: "infrastructure/artifacts", stage: "P11" };
    }
    if (compatibilityFeatureBarrels.has(feature) && /from\s+["']\.\/features\//.test(sourceText)) {
      return { owner: "compatibility/features", stage: "P14" };
    }
    if (compatibilityFeatureBarrels.has(feature) && /from\s+["']\.\/processes\//.test(sourceText)) {
      return { owner: "compatibility/processes", stage: "P14" };
    }
    if (["http-bootstrap", "public-output", "request-metadata", "request-protection"].includes(feature)) {
      return { owner: "compatibility/http", stage: "P14" };
    }
    if (["runtime-manifest", "runtime-startup-config"].includes(feature)) {
      return { owner: "compatibility/config", stage: "P14" };
    }
    if (["authorization-policy", "authorization-guard", "resource-scope"].includes(feature)) {
      return { owner: "compatibility/authorization", stage: "P14" };
    }
    if (feature.startsWith("migrations/")) return { owner: "infrastructure/database/migrations", stage: "P0" };
    if (feature.startsWith("features/health/")) return { owner: "health", stage: "P2" };
    if (feature.startsWith("features/auth/")) return { owner: "auth", stage: "P5" };
    if (feature.startsWith("features/teams/")) return { owner: "teams", stage: "P6" };
    if (feature.startsWith("features/identity/")) return { owner: "identity", stage: "P5" };
    if (feature.startsWith("features/authorization/")) return { owner: "authorization", stage: "P5" };
    if (feature.startsWith("features/notifications/")) return { owner: "notifications", stage: "P11" };
    if (feature.startsWith("processes/enrichment/")) return { owner: "processes/enrichment", stage: "P8" };
    if (feature.startsWith("processes/bootstrap-admin/")) return { owner: "processes/bootstrap-admin", stage: "P14" };
    if (feature.startsWith("processes/import-parser/")) return { owner: "processes/import-parser", stage: "P14" };
    if (feature.startsWith("shared/")) return { owner: "shared", stage: "P2" };
    if (feature.startsWith("composition/")) return { owner: "composition", stage: "P3" };
    if (feature.startsWith("infrastructure/database/")) return { owner: "infrastructure/database", stage: "P3" };
    if (feature.startsWith("infrastructure/http/")) return { owner: "infrastructure/http", stage: "P2" };
    if (feature.startsWith("infrastructure/config/")) return { owner: "infrastructure/config", stage: "P2" };
    for (const [pattern, owner, stage] of apiFeatureRules) if (pattern.test(feature)) return { owner, stage };
    return { owner: "needs-review", stage: "P0" };
  }
  if (area === "apps/worker") {
    if (basename === "run-worker.ts") return { owner: "process-entrypoint", stage: "P13" };
    const workerStructure = [
      ["application/", "application"],
      ["features/authentication/", "features/authentication"],
      ["features/execution/", "features/execution"],
      ["features/identity/", "features/identity"],
      ["features/results/", "features/results"],
      ["infrastructure/browser/", "infrastructure/browser"],
      ["infrastructure/staging/", "infrastructure/staging"],
      ["portals/compensa/", "portals/compensa"],
      ["portals/pzu/", "portals/pzu"],
      ["portals/shared/", "portals/shared"],
      ["testing/fixtures/", "testing/fixtures"],
      ["testing/support/", "testing/support"],
    ].find(([prefix]) => feature.startsWith(prefix));
    if (workerStructure) return { owner: workerStructure[1], stage: "P13" };
    if (feature === "worker-runtime-config") {
      return { owner: "infrastructure/config", stage: "P2" };
    }
    if (feature.startsWith("infrastructure/database/")) {
      return { owner: "infrastructure/database", stage: "P13" };
    }
    for (const [pattern, owner, stage] of workerFeatureRules) if (pattern.test(feature)) return { owner, stage };
    return { owner: "needs-review", stage: "P0" };
  }
  return { owner: "packages/core", stage: "P13" };
}
function targetFor(area, file, owner, isTest) {
  const filename = path.basename(file);
  const sourceName = filename;
  const destinationRoot = area === "apps/api" ? "apps/api/src" : area === "apps/worker" ? "apps/worker/src" : "packages/core/src";
  if (owner === "process-entrypoint") return `${destinationRoot}/${file}`;
  if (area === "apps/worker" && /^(application|features|infrastructure|portals|testing)\//.test(file)) {
    return `${destinationRoot}/${path.posix.dirname(file)}/${sourceName}`;
  }
  if (area === "apps/worker" && filename === "run-worker.ts") return `${destinationRoot}/${filename}`;
  if (area === "apps/worker" && owner === "application") {
    return `${destinationRoot}/application/${sourceName}`;
  }
  if (area === "apps/api" && owner.startsWith("contracts/")) return `${destinationRoot}/${file}`;
  if (owner.startsWith("compatibility/")) return `${destinationRoot}/${file.replace(/\\/g, "/")}`;
  const currentFeature = file.match(/(?:^|\/)(features\/.+)$/)?.[1];
  if (area === "apps/api" && currentFeature) {
    return `${destinationRoot}/${path.posix.dirname(file)}/${sourceName}`;
  }
  if (owner === "compatibility/http") return `${destinationRoot}/${file.replace(/\\/g, "/")}`;
  if (owner === "compatibility/config") return `${destinationRoot}/${file.replace(/\\/g, "/")}`;
  if (owner === "compatibility/authorization") return `${destinationRoot}/${file.replace(/\\/g, "/")}`;
  if (owner.startsWith("processes/")) return `${destinationRoot}/${owner}/${sourceName}`;
  if (area === "apps/api" && file.includes("/migrations/")) return `${destinationRoot}/${file.slice(file.indexOf("migrations/")).replace(/\\/g, "/")}`;
  if (area === "packages/core" && file.startsWith("contracts/")) {
    return `${destinationRoot}/${path.posix.dirname(file)}/${sourceName}`;
  }
  if (owner.startsWith("needs-review")) return `${destinationRoot}/<assign-feature>/${sourceName}`;
  if (owner === "composition" || owner === "shared" || owner === "infrastructure" || owner.startsWith("infrastructure/")) {
    return `${destinationRoot}/${owner}/${sourceName}`;
  }
  if (area === "apps/api" && ["main", "module", "migrate", "apply-runtime-grants"].includes(filename.replace(/\.ts$/, ""))) {
    return `${destinationRoot}/${filename}`;
  }
  if (area === "apps/worker" && ["index.ts", "run-worker.ts"].includes(filename)) return `${destinationRoot}/${filename}`;
  return `${destinationRoot}/${area === "apps/api" || area === "apps/worker" ? `features/${owner}` : ""}/${sourceName}`.replace(/\/+/g, "/");
}
function inventoryFiles(area) {
  const absoluteRoot = path.join(root, area, "src");
  const files = walk(absoluteRoot);
  const nodes = files.map((file) => {
    const relative = toRepoPath(file);
    const basename = path.relative(absoluteRoot, file).replace(/\\/g, "/");
    const { ast, text } = readAst(file);
    const isTest = /\.(?:http\.)?spec\.ts$/.test(basename) || /\.contract\.ts$/.test(basename);
    const { owner, stage } = ownerFor(area, basename, text);
    const imports = importsOf(ast);
    return {
      area, path: relative, kind: basename.includes("migrations/") ? "migration" : isTest ? "test" : "source",
      owner, stage, proposedPath: targetFor(area, basename, owner, isTest), exports: exportsOf(ast), imports,
      inventoryConfidence: owner === "needs-review" ? "unresolved" : "filename-rule; verify before moving",
    };
  });
  const byPath = new Map(nodes.map((entry) => [entry.path, entry]));
  const sourceFiles = new Set(nodes.map((entry) => entry.path));
  for (const entry of nodes) {
    entry.internalImporters = [];
    entry.resolvedInternalImports = [];
    entry.unresolvedRelativeImports = [];
  }
  for (const entry of nodes) {
    for (const specifier of entry.imports) {
      if (!specifier.startsWith(".")) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), specifier));
    const candidates = [
      path.posix.normalize(base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : `${base}.ts`),
      path.posix.normalize(`${base}/index.ts`),
    ];
      const resolved = candidates.find((candidate) => sourceFiles.has(candidate));
      if (resolved && byPath.has(resolved)) {
        entry.resolvedInternalImports.push({ specifier, target: resolved });
        byPath.get(resolved).internalImporters.push(entry.path);
      } else {
        entry.unresolvedRelativeImports.push(specifier);
      }
    }
  }
  for (const entry of nodes) entry.internalImporters.sort();
  const sourceNodes = nodes.filter((entry) => entry.kind === "source");
  const testNodes = nodes.filter((entry) => entry.kind === "test");
  const sourceStem = (filePath) => path.posix.basename(filePath).replace(/\.ts$/, "");
  const testStem = (filePath) => path.posix.basename(filePath)
    .replace(/\.http\.(?:test|spec)\.ts$/, "")
    .replace(/\.(?:test|spec)\.ts$/, "")
    .replace(/\.contract\.ts$/, "");
  for (const test of testNodes) {
    const stem = testStem(test.path);
    test.covers = sourceNodes.filter((source) => source.area === test.area
      && (sourceStem(source.path) === stem || source.internalImporters.includes(test.path)))
      .map((source) => source.path).sort();
    test.coverageConfidence = test.covers.length ? "same-basename-or-direct-import; verify scenarios" : "feature-suite-manual-review-required";
  }
  for (const source of sourceNodes) {
    source.relatedTests = testNodes.filter((test) => test.area === source.area
      && (test.covers.includes(source.path) || sourceStem(source.path) === testStem(test.path)))
      .map((test) => test.path).sort();
  }
  return nodes;
}
function routeInventory(apiFiles) {
  const routes = [];
  const controllerDecorator = new Set(["Controller"]);
  const guardDecorators = new Set(["UseGuards"]);
  const httpMethods = new Set(["Get", "Post", "Put", "Patch", "Delete", "Options", "Head", "All"]);
  const requestDecorators = new Set(["Req", "Request", "Body", "Param", "Query", "Headers", "Header", "Res", "Response", "UploadedFile", "UploadedFiles", "Ip"]);
  const explicitStatusDecorators = new Set(["HttpCode"]);
  const files = apiFiles.filter((entry) => entry.kind === "source");
  for (const item of files) {
    const absolute = path.join(root, item.path);
    const { ast } = readAst(absolute);
    const visit = (node) => {
      if (!ts.isClassDeclaration(node) || !node.name) return ts.forEachChild(node, visit);
      const controller = decoratorsOf(node).find((decorator) => controllerDecorator.has(decoratorName(decorator)));
      if (!controller) return;
      const controllerPath = decoratorArgs(controller)[0] ?? "";
      const controllerGuards = namesFromDecorators(node, guardDecorators);
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        const routeDecorator = decoratorsOf(member).find((decorator) => httpMethods.has(decoratorName(decorator)));
        if (!routeDecorator) continue;
        const method = decoratorName(routeDecorator).toUpperCase();
        const segment = decoratorArgs(routeDecorator)[0] ?? "";
        const methodGuards = namesFromDecorators(member, guardDecorators);
        const explicitStatus = namesFromDecorators(member, explicitStatusDecorators);
        const requests = [];
        for (const parameter of member.parameters) {
          const parameterDecorators = decoratorsOf(parameter).filter((decorator) => requestDecorators.has(decoratorName(decorator)));
          for (const decorator of parameterDecorators) requests.push({
            name: decoratorName(decorator), args: decoratorArgs(decorator),
            parameter: parameter.name.getText(ast), type: parameter.type?.getText(ast) ?? "inferred/unknown",
          });
        }
        const name = member.name.getText(ast);
        const defaultStatus = method === "POST" ? 201 : 200;
        const authorizationDecorators = [...decoratorsOf(node), ...decoratorsOf(member)]
          .filter((decorator) => decoratorName(decorator) === "RequirePermission");
        const permissionRequirements = authorizationDecorators.map((decorator) => {
          const args = decoratorArgs(decorator);
          return { action: args[0] ?? null, resource: args[1] ?? null };
        });
        const handlerBody = member.body?.getText(ast) ?? "";
        const allGuards = [...controllerGuards, ...methodGuards].flatMap((entry) => entry.args);
        const routeDecoratorRecords = decoratorsOf(member).map((decorator) => ({
          name: decoratorName(decorator), args: decoratorArgs(decorator),
        }));
        routes.push({
          method, path: `/${[controllerPath, segment].filter(Boolean).join("/")}`.replace(/\/+/g, "/"),
          controller: node.name.text, handler: name, source: item.path, featureOwner: item.owner,
          globalGuardCandidates: ["RequestProtectionGuard"],
          controllerGuards: controllerGuards.flatMap((entry) => entry.args),
          methodGuards: methodGuards.flatMap((entry) => entry.args),
          permissionMetadata: namesFromDecorators(node, new Set(["RequirePermission", "RequirePermissions", "Permissions", "Permission"]))
            .concat(namesFromDecorators(member, new Set(["RequirePermission", "RequirePermissions", "Permissions", "Permission"])))
            .flatMap((entry) => entry.args),
          permissionRequirements,
          routeDecorators: routeDecoratorRecords,
          requestInputs: requests,
          transportContractCandidates: {
            responseMode: requests.some((input) => ["Res", "Response"].includes(input.name)) ? "manual response object" : "Nest return value",
            sessionCookieRead: allGuards.includes("SessionGuard") || /readSessionClaims|goldis_session|goldis_csrf/.test(handlerBody),
            responseCookieWrite: /\.(?:cookie|clearCookie)\s*\(/.test(handlerBody),
            requestHeaderRead: requests.some((input) => ["Headers", "Header"].includes(input.name)) || /\.(?:headers|getHeader)\b/.test(handlerBody),
            responseHeaderWrite: routeDecoratorRecords.some((record) => record.name === "Header") || /\.(?:setHeader|header)\s*\(/.test(handlerBody),
            manualStatusWrite: /\.status\s*\(/.test(handlerBody),
            originOnlyDecorator: routeDecoratorRecords.some((record) => record.name === "OriginOnly"),
          },
          explicitStatus: explicitStatus.length ? explicitStatus.map((entry) => entry.args[0]) : null,
          frameworkDefaultStatusCandidate: explicitStatus.length ? null : defaultStatus,
          cookieAndHeaderContract: "manual verification required",
          effectiveAuthorizationScope: "manual verification required",
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

const api = inventoryFiles("apps/api");
const worker = inventoryFiles("apps/worker");
const core = inventoryFiles("packages/core");
const routes = routeInventory(api);
const processes = [
  { id: "api", entrypoint: "apps/api/src/main.ts", composeService: "api", startCommands: ["apps/api/package.json#start", "compose.yaml#services.api"],
    databaseRole: "goldis_api", redisRole: "goldis_api", lifetime: "long-running HTTP Nest application", imports: ["apps/api/src/composition/module.ts#AppModule"],
    references: ["apps/api/src/main.ts", "apps/api/src/composition/module.ts"], verification: "source-reviewed; deployed profile/current_user not verified" },
  { id: "migrator", entrypoint: "apps/api/src/migrate.ts", composeService: "migrate", startCommands: ["apps/api/package.json#migrate", "compose.yaml#services.migrate"],
    databaseRole: "goldis_migrator", lifetime: "one-shot; runs Umzug migrations", references: ["apps/api/src/migrate.ts", "apps/api/src/infrastructure/database/migrate.ts", "apps/api/src/infrastructure/database/migration-path.ts"],
    verification: "source-reviewed; disposable role smoke passed" },
  { id: "runtime-grants", entrypoint: "apps/api/src/apply-runtime-grants.ts", composeService: "migrate", startCommands: ["compose.yaml#services.migrate.command"],
    databaseRole: "goldis_migrator", lifetime: "one-shot after migrations; applies docker/postgres/apply-runtime-grants.sql",
    references: ["apps/api/src/apply-runtime-grants.ts", "docker/postgres/apply-runtime-grants.sql"], verification: "source-reviewed; disposable role smoke passed" },
  { id: "bootstrap-admin", entrypoint: "apps/api/src/bootstrap-admin-main.ts", composeService: "bootstrap-admin", startCommands: ["compose.yaml#services.bootstrap-admin"],
    databaseRole: "goldis_migrator", lifetime: "one-shot; provisions the first administrator", references: ["apps/api/src/bootstrap-admin-main.ts", "apps/api/src/processes/bootstrap-admin/main.ts", "apps/api/src/features/auth/bootstrap-admin.ts"],
    verification: "source-reviewed; active installation not exercised" },
  { id: "import-parser", entrypoint: "apps/api/src/import-parser-main.ts", composeService: "import-parser", startCommands: ["scripts/Start-GoldisLocal.ps1", "compose.yaml#services.import-parser"],
    databaseRole: null, lifetime: "long-running internal HTTP server; accepts one parse at a time; child timeout 60s, input 16 MiB, output 64 MiB",
    references: ["apps/api/src/import-parser-main.ts", "apps/api/src/processes/import-parser/main.ts", "apps/api/src/features/imports/import-parser-client.ts", "apps/api/src/import-parser-child.ts", "apps/api/src/processes/import-parser/child.ts"],
    verification: "source-reviewed; fixture contract tested; deployed parser not independently observed" },
  { id: "import-parser-child", entrypoint: "apps/api/src/import-parser-child.ts", composeService: null, startCommands: ["spawned by import-parser per request"],
    databaseRole: null, lifetime: "per-request child; reads XLSX bytes from stdin and writes bounded JSON to stdout", parentProcess: "import-parser",
    references: ["apps/api/src/import-parser-main.ts#createImportParserServer", "apps/api/src/import-parser-child.ts"], verification: "source-reviewed; fixture contract tested" },
  { id: "enrichment-worker", entrypoint: "apps/api/src/enrichment-worker.ts", composeService: "enrichment-worker", startCommands: ["apps/api/package.json#start:enrichment-worker", "compose.yaml#services.enrichment-worker"],
    databaseRole: "goldis_enrichment", lifetime: "long-running DB poller; 500ms idle delay, 1s error delay, runtime heartbeat every 10s",
    references: ["apps/api/src/enrichment-worker.ts", "apps/api/src/processes/enrichment/enrichment-worker.ts", "apps/api/src/features/enrichment/enrichment-jobs.service.ts", "apps/api/src/features/enrichment/registry-provider.factory.ts"],
    verification: "source-reviewed; disposable role and registry-jobs process smoke passed; deployed process not observed" },
  { id: "portal-worker", entrypoint: "apps/worker/src/run-worker.ts", composeService: "worker", startCommands: ["apps/worker/package.json#start", "compose.yaml#services.worker"],
    databaseRole: "goldis_worker", redisRole: "goldis_worker", lifetime: "long-running BullMQ consumer; concurrency 1; internal HTTP code/result receiver; lease heartbeat every 10s; staging reconcile every 30s",
    references: ["apps/worker/src/run-worker.ts", "apps/worker/src/features/execution/execution-lease.ts", "apps/worker/src/features/results/result-staging-checkpoint.ts"],
    verification: "source-reviewed; disposable role smoke passed; portal-live operation not run" },
];
const backgroundJobs = [
  { id: "run-dispatch-and-recovery", kind: "durable-outbox-poller", process: "api", owner: "RunService", intervalMs: 5000,
    source: "apps/api/src/features/runs/runs.service.ts#onModuleInit/reconcile", durableState: "run_dispatch_outbox",
    references: ["apps/api/src/features/runs/runs.service.ts", "apps/api/src/features/runs/run-queue.ts", "apps/worker/src/run-worker.ts", "apps/worker/src/features/execution/execution-lease.ts"],
    queue: { name: "oc-verification", jobName: "verify-row", payload: { runId: "string" }, payloadVersion: "unversioned",
      jobId: "dispatch-<dispatchId>", attempts: 1, retention: "last 1000 completed and failed jobs",
      workerConcurrency: 1, maxStalledCount: 1 },
    retry: "outbox publish delay 5s/15s/60s (60s thereafter); recover published dispatch older than 60s if BullMQ job is missing/stalled; worker DB execution lease 60s and heartbeat 10s",
    verification: "source-reviewed; PostgreSQL/Redis dispatch smoke passed; payload has no explicit version" },
  { id: "submission-dispatch", kind: "durable-db-poller", process: "api", owner: "RunSubmissionService", intervalMs: 2000,
    source: "apps/api/src/features/submissions/run-submission-admission.service.ts#onModuleInit/dispatchPendingOnce", durableState: "run_submissions and run admission/outbox state",
    references: ["apps/api/src/features/submissions/run-submission-admission.service.ts", "apps/api/src/features/runs/runs.service.ts", "apps/api/src/features/runs/canonical-run-service.ts"],
    downstream: "RunService admission, then run-dispatch-and-recovery; not a separate Redis queue",
    leaseMs: 30000, retry: "waiting-window 5m; capacity/paused 1m; transient process error 2s/4s/8s/16s/30s capped; blocked authorization/state waits for an external state change",
    verification: "source-reviewed; run/submission DB smoke passed" },
  { id: "import-preparation", kind: "durable-db-poller", process: "api", owner: "ImportPreparationService", intervalMs: 1500,
    source: "apps/api/src/features/preparations/preparations.service.ts#onModuleInit/processOne", durableState: "import preparation jobs and prepared rows",
    references: ["apps/api/src/features/preparations/preparations.service.ts", "apps/api/src/features/preparations/preparation-analysis.ts"],
    leaseMs: 600000, retry: "terminal failure on caught processing error; an expired processing lease can be reclaimed after 10m; no separate attempt-count backoff",
    verification: "source-reviewed; preparation/grouping DB suites passed" },
  { id: "preparation-workflow", kind: "durable-db-poller", process: "api", owner: "ImportPreparationWorkflowService", intervalMs: 2000,
    source: "apps/api/src/features/preparations/preparation-workflows.service.ts#onModuleInit/processOne", durableState: "import_preparation_workflows and workflow job state",
    references: ["apps/api/src/features/preparations/preparation-workflows.service.ts", "apps/api/src/features/preparations/preparations.service.ts", "apps/api/src/features/enrichment/enrichment-jobs.service.ts"],
    leaseMs: 120000, retry: "transient errors retry after 2s; HTTP 4xx/state/auth errors become terminal failed; registry/reanalysis waiting states are rechecked on persisted nextAttemptAt",
    verification: "source-reviewed; workflow DB tests passed" },
  { id: "prepared-set-execution", kind: "durable-db-poller", process: "api", owner: "PreparedSetExecutionService", intervalMs: 2000,
    source: "apps/api/src/features/submissions/prepared-set-executions.service.ts#onModuleInit/processOne", durableState: "prepared_set_executions and prepared_set_chunks",
    references: ["apps/api/src/features/submissions/prepared-set-executions.service.ts", "apps/api/src/features/submissions/run-submissions.service.ts"],
    leaseMs: 45000, chunkSize: 500, retry: "transient exception 5s; recover incomplete source chunk 2s; child still running 5s; attention/cancel 30s; actor inactive 60s; new child check 1s",
    verification: "source-reviewed; prepared-set DB smoke passed" },
  { id: "deletion-jobs", kind: "durable-db-poller", process: "api", owner: "DeletionJobRunner", intervalMs: 1500,
    source: "apps/api/src/features/deletions/deletion-jobs.ts#onModuleInit/processOne", durableState: "deletion_jobs and deletion journal",
    references: ["apps/api/src/features/deletions/deletion-jobs.ts", "apps/api/src/features/deletions/deletion-journal.ts", "apps/api/src/contracts/deletion-barrier.ts"],
    leaseMs: 60000, maxAttempts: 5, disableEnvironment: "GOLDIS_DELETION_WORKER=0",
    retry: "5 attempts; retries wait 10s/20s/40s/80s; fifth failure becomes manual_required",
    verification: "source-reviewed; deletion/replay disposable DB suites passed" },
  { id: "enrichment-jobs", kind: "durable-db-poller", process: "enrichment-worker", owner: "RegistryEnrichmentJobRunner", idleDelayMs: 500,
    source: "apps/api/src/processes/enrichment/enrichment-worker.ts#startEnrichmentWorker and apps/api/src/features/enrichment/enrichment-jobs.service.ts#RegistryEnrichmentJobRunner.processOne",
    references: ["apps/api/src/enrichment-worker.ts", "apps/api/src/processes/enrichment/enrichment-worker.ts", "apps/api/src/features/enrichment/enrichment-jobs.service.ts", "apps/api/src/features/enrichment/registry-provider.factory.ts"],
    durableState: "enrichment_jobs and enrichment_job_items", heartbeatMs: 10000, itemLeaseMs: 60000, maxItems: 500, maxAttempts: 3,
    retry: "retryable errors use exponential 1s/2s capped at 30s and respect provider Retry-After; RATE_LIMITED remains retryable; error-loop delay 1s",
    verification: "source-reviewed; disposable runtime-role and registry-jobs process smoke passed" },
  { id: "auth-mail-outbox", kind: "durable-db-poller", process: "api", owner: "AuthMailDispatcher", enabledWhen: "readAuthMailConfig().enabled",
    source: "apps/api/src/auth-mail-dispatcher.ts#onModuleInit/runLoop/dispatchOne", durableState: "auth_mail_outbox",
    references: ["apps/api/src/features/account-recovery/auth-mail-dispatcher.ts", "apps/api/src/features/account-recovery/auth-mail-config.ts", "apps/api/src/features/account-recovery/auth-mail-provider.ts"],
    idleDelayMs: 1000, errorDelayMs: 2000, leaseMs: 30000, maxAttempts: 8, cleanupIntervalMs: 3600000,
    retry: "15s exponential default capped at 5m with 0.8–1.2 jitter; provider Retry-After clamped to 1s–15m; send budget releases lease without consuming attempt",
    verification: "source-reviewed; provider contract tests passed; real email provider not called" },
  { id: "portal-worker-heartbeats", kind: "runtime-heartbeat-and-reconcile", process: "portal-worker", owner: "run-worker main",
    source: "apps/worker/src/run-worker.ts#main", heartbeatMs: 10000, stagingReconcileMs: 30000,
    references: ["apps/worker/src/run-worker.ts", "apps/worker/src/features/execution/execution-lease.ts", "apps/worker/src/features/results/result-staging-checkpoint.ts"],
    verification: "source-reviewed; deployed worker process not independently observed" },
];
const componentFor = (file) => {
  const apiFeature = file.path.match(/^apps\/api\/src\/features\/([^/]+)\//);
  if (apiFeature) return `api-feature:${apiFeature[1]}`;
  const workerFeature = file.path.match(/^apps\/worker\/src\/([^/]+)\//);
  if (workerFeature && ["application", "features", "infrastructure", "portals", "testing"].includes(workerFeature[1])) {
    const workerSubfeature = file.path.match(/^apps\/worker\/src\/([^/]+\/[^/]+)\//);
    return `worker-${workerSubfeature?.[1] ?? workerFeature[1]}`;
  }
  if (file.path.startsWith("apps/api/src/infrastructure/")) {
    const area = file.path.match(/^apps\/api\/src\/infrastructure\/([^/]+)\//)?.[1] ?? "root";
    return `api-infrastructure:${area}`;
  }
  if (file.path.startsWith("apps/api/src/composition/")) return "api-composition";
  if (file.path.startsWith("apps/api/src/")) return `api-legacy:${file.owner}`;
  if (file.path.startsWith("apps/worker/src/")) return `worker-root:${file.owner}`;
  return "packages-core";
};
const dependencyEdges = new Map();
for (const file of [...api, ...worker, ...core]) {
  const fromComponent = componentFor(file);
  for (const resolved of file.resolvedInternalImports) {
    const targetFile = [...api, ...worker, ...core].find((candidate) => candidate.path === resolved.target);
    if (!targetFile) continue;
    const toComponent = componentFor(targetFile);
    if (fromComponent === toComponent) continue;
    const key = `${fromComponent}|${toComponent}`;
    const edge = dependencyEdges.get(key) ?? { from: fromComponent, to: toComponent, imports: [] };
    edge.imports.push({ from: file.path, to: resolved.target, specifier: resolved.specifier });
    dependencyEdges.set(key, edge);
  }
}
const dependencyGraph = {
  nodes: [...new Set([...api, ...worker, ...core].map(componentFor))].sort(),
  edges: [...dependencyEdges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .map((edge) => ({ ...edge, imports: edge.imports.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)) })),
};
const targetGroups = new Map();
for (const file of [...api, ...worker, ...core]) {
  const sources = targetGroups.get(file.proposedPath) ?? [];
  sources.push(file.path);
  targetGroups.set(file.proposedPath, sources);
}
const duplicateProposedPaths = [...targetGroups].filter(([, sources]) => sources.length > 1)
  .map(([proposedPath, sources]) => ({ proposedPath, sources }));
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  generator: "scripts/backend-refactor-inventory.cjs",
  evidence: { apiTypeScriptFiles: api.length, workerTypeScriptFiles: worker.length,
    coreTypeScriptFiles: core.length, apiRoutes: routes.length,
    resolvedInternalImportEdges: [...api, ...worker, ...core].reduce((total, file) => total + file.resolvedInternalImports.length, 0),
    unresolvedRelativeImports: [...api, ...worker, ...core].flatMap((file) => file.unresolvedRelativeImports
      .map((specifier) => ({ file: file.path, specifier }))),
    missingProcessEvidenceFiles: [...new Set(processes.flatMap((process) => process.references)
      .map((reference) => reference.split("#", 1)[0])
      .filter((file) => !fs.existsSync(path.join(root, file))))],
    missingBackgroundEvidenceFiles: [...new Set(backgroundJobs.flatMap((job) => job.references)
      .filter((file) => !fs.existsSync(path.join(root, file))))],
    unresolvedOwners: [...api, ...worker, ...core].filter((item) => item.owner === "needs-review").map((item) => item.path),
    duplicateProposedPaths },
  routes,
  dependencyGraph,
  processes,
  backgroundJobs,
  files: [...api, ...worker, ...core],
  externalContractsToVerify: [
    "compose/service commands and healthchecks", "PowerShell startup/build/migration scripts", "package scripts and test-module manifest",
    "BullMQ queue names, job names, payload versions, leases and retry policies", "internal parser HTTP contract and child process lifecycle",
    "enrichment worker polling/heartbeat/shutdown", "worker API routes and secret contract", "API-worker contracts in packages/core",
    "database role grants and each runtime connection identity", "fixture/live Playwright entry points and opt-in conditions",
  ],
};

if (require.main === module) {
  if (write) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`BACKEND_REFACTOR_INVENTORY_WRITTEN files=${report.files.length} apiRoutes=${report.routes.length} unresolvedOwners=${report.evidence.unresolvedOwners.length} duplicateTargets=${report.evidence.duplicateProposedPaths.length} path=${path.relative(root, outputPath)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ ...report.evidence, routeSample: report.routes.slice(0, 12), unresolvedOwners: report.evidence.unresolvedOwners }, null, 2)}\n`);
  }
}

module.exports = { report, ownerFor, targetFor, inventoryFiles, routeInventory };
