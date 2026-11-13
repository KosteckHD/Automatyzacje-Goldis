"use strict";

// Generuje wyłącznie dokumentację/rejestry. Nie uruchamia aplikacji, testów ani sieci.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../../..");
const sources = ["release-cases.json", "functional-cases.json", "security-cases.json", "infrastructure-cases.json"];
const allowedPhases = new Set(["A", "B", "LIVE", "UAT"]);
const allowedApplicability = new Set(["common", "oc", "commission", "oc_live", "recovery_mail", "mf_vat", "legacy_migration"]);
const allowedGates = new Set(Array.from({ length: 9 }, (_, i) => `G${i}`));
const categoryOrder = ["release", "functional", "commission", "integration", "security", "infrastructure", "recovery", "performance", "live", "external", "operations"];
const categoryTitles = {
  release: "Wersja, środowisko i testy bazowe", functional: "Proces OC i praca zespołu",
  commission: "Porównywarka prowizji", integration: "Pełne połączenia komponentów",
  security: "Cyberbezpieczeństwo aplikacji", infrastructure: "Runtime i infrastruktura",
  recovery: "Kopie, odtworzenie i rollback", performance: "Obciążenie i granice",
  live: "Nadzorowany odbiór portali", external: "Mail i MF VAT", operations: "Monitoring i przekazanie",
};
const ownerFor = (category) => category === "release" ? "programista i prowadzący odbiór"
  : category === "live" || category === "external" ? "operator i uprawniony odbiorca"
    : category === "operations" ? "operator i właściciel produktu" : "QA i programista";
const legacyResultColumns = ["run_id", "case_id", "phase", "status", "applicability", "release_sha", "manifest_id", "environment", "executor", "started_at", "finished_at", "expected_reference", "actual", "exit_code", "evidence_paths", "finding_ids", "retest_of", "notes"];
const resultColumns = ["run_id", "case_id", "phase", "phase_gate", "status", "applicability", "release_sha", "manifest_id", "environment", "executor", "started_at", "finished_at", "expected_reference", "actual", "exit_code", "evidence_paths", "finding_ids", "retest_of", "notes"];
function serializeCsv(rows) {
  return "\ufeff" + rows.map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n") + "\r\n";
}
function plannedResultRows(items, columns) {
  return [columns, ...items.flatMap((item) => item.phases.map((phase) => {
    const values = { case_id: item.id, phase, phase_gate: item.phaseGates?.[phase] ?? "", status: "NOT_RUN", applicability: item.applicability, expected_reference: "przypadki.json#" + item.id };
    return columns.map((name) => values[name] ?? "");
  }))];
}
function phaseGate(item, phase) {
  if (item.id === "OPS02") return "G8";
  if (item.id === "REL07" && phase === "A") return "G5";
  if (phase === "B") return "G6";
  if (phase === "LIVE" || phase === "UAT") return "G7";
  return item.gate;
}

const cases = sources.flatMap((file) => {
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
  if (!Array.isArray(items)) throw new Error(`SOURCE_NOT_ARRAY:${file}`);
  return items.map((item) => ({
    owner: ownerFor(item.category),
    priority: ["release", "integration"].includes(item.category) ? "P0" : "P1",
    prerequisites: item.id === "REL01" ? [] : item.id === "REL02" ? ["REL01"] : ["REL01", "REL02"],
    status: "NOT_RUN", executions: [], ...item,
    definitionSource: file,
  }));
});

const errors = [];
const ids = new Set();
for (const item of cases) {
  item.phaseGates = Object.fromEntries(item.phases.map((phase) => [phase, phaseGate(item, phase)]));
  if (!/^(REL|FUN|COM|E2E|SEC|INF|DR|OPS|LIVE|MAIL|REG|LOAD)\d{2}$/.test(item.id || "")) errors.push(`ID_INVALID:${item.id}`);
  if (ids.has(item.id)) errors.push(`ID_DUPLICATE:${item.id}`);
  ids.add(item.id);
  for (const field of ["title", "category", "gate", "applicability", "owner", "priority"]) {
    if (typeof item[field] !== "string" || !item[field].trim()) errors.push(`FIELD_REQUIRED:${item.id}:${field}`);
  }
  for (const field of ["phases", "steps", "passCriteria", "evidence", "entryPoints", "references"]) {
    if (!Array.isArray(item[field]) || !item[field].length || item[field].some((v) => typeof v !== "string" || !v.trim())) {
      errors.push(`ARRAY_REQUIRED:${item.id}:${field}`);
    }
  }
  if (!categoryOrder.includes(item.category)) errors.push(`CATEGORY_INVALID:${item.id}:${item.category}`);
  if (!allowedGates.has(item.gate)) errors.push(`GATE_INVALID:${item.id}:${item.gate}`);
  if (!allowedApplicability.has(item.applicability)) errors.push(`APPLICABILITY_INVALID:${item.id}:${item.applicability}`);
  if (item.phases?.some((p) => !allowedPhases.has(p))) errors.push(`PHASE_INVALID:${item.id}`);
  if (Object.values(item.phaseGates).some((gate) => !allowedGates.has(gate))) errors.push(`PHASE_GATE_INVALID:${item.id}`);
  if (item.status !== "NOT_RUN" || item.executions?.length !== 0) errors.push(`SOURCE_MUST_BE_UNEXECUTED:${item.id}`);
  if (!Array.isArray(item.prerequisites)) errors.push(`PREREQUISITES_REQUIRED:${item.id}`);
}
for (const item of cases) {
  for (const dependency of item.prerequisites || []) {
    if (!ids.has(dependency) || dependency === item.id) errors.push(`DEPENDENCY_INVALID:${item.id}:${dependency}`);
  }
}
const byId = new Map(cases.map((item) => [item.id, item]));
function visit(id, stack = []) {
  if (stack.includes(id)) { errors.push(`DEPENDENCY_CYCLE:${[...stack, id].join("->")}`); return; }
  for (const dependency of byId.get(id)?.prerequisites || []) if (byId.has(dependency)) visit(dependency, [...stack, id]);
}
for (const item of cases) visit(item.id);
if (errors.length) throw new Error(errors.join("\n"));

cases.sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) || a.id.localeCompare(b.id));

const canonicalPath = path.join(__dirname, "przypadki.json");
const resultsPath = path.join(__dirname, "wyniki.csv");
const defectsPath = path.join(__dirname, "usterki.csv");
let previous = null;
if (fs.existsSync(canonicalPath)) {
  previous = JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
  if (previous.cases?.some((item) => item.status !== "NOT_RUN" || item.executions?.length)) {
    throw new Error("EXISTING_EXECUTION_RECORDS_PRESERVED: scal zmiany definicji ręcznie; nie nadpisano wyników");
  }
}
// Regeneracja pustego szablonu jest dozwolona; choćby jeden zapis wykonania blokuje nadpisanie.
if (fs.existsSync(resultsPath)) {
  const expectedEmpty = previous ? serializeCsv(plannedResultRows(previous.cases, previous.resultsColumns || legacyResultColumns)) : null;
  if (expectedEmpty === null || fs.readFileSync(resultsPath, "utf8") !== expectedEmpty) {
    throw new Error("EXISTING_RESULT_CSV_PRESERVED: rejestr zmieniono lub rozpoczęto odbiór; scal definicje ręcznie");
  }
}
const canonical = {
  schemaVersion: 1,
  planDate: "2026-11-05",
  planStatus: "PREPARED_NOT_EXECUTED",
  masterPlan: "../../PLAN_PELNEGO_ODBIORU_PLATFORMY_2026-11-05.md",
  scope: { organizations: 1, employees: "2-5", toolsInCurrentTree: ["oc-policy-verification", "commission-comparison"], migrationHeadToVerify: "066", imagesToVerify: 6, servicesToVerify: 12 },
  phaseLegend: { A: "izolowany Linux/HTTPS i syntetyczne dane", B: "końcowa konfiguracja VPS/domeny", LIVE: "uprawniony, nadzorowany odbiór portali", UAT: "odbiór pracowników i menedżera" },
  statusLegend: ["NOT_RUN", "RUNNING", "PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "N/A"],
  applicabilityLegend: { common: "wspólna platforma i skutki całego release", oc: "zakres OC", commission: "zakres funkcjonalny prowizji", oc_live: "zadeklarowana czynna automatyzacja portali", recovery_mail: "aktywny mail recovery", mf_vat: "aktywny provider MF VAT", legacy_migration: "przenoszenie istniejących danych" },
  executionNote: "Definicje i status początkowy. Bieżące wyniki prowadzić w wybranym rejestrze i wskazać go w manifeście. N/A wymaga uzasadnienia; A nie zalicza automatycznie B. Brak uruchomienia testów podczas generowania.",
  caseCount: cases.length,
  phaseRows: cases.reduce((sum, item) => sum + item.phases.length, 0),
  resultsColumns: resultColumns,
  cases,
};
fs.writeFileSync(canonicalPath, `${JSON.stringify(canonical, null, 2)}\n`);

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
const md = [
  "# Checklista pełnego odbioru Goldis", "",
  "**Plan przygotowany; wszystkie przypadki NOT_RUN.** To lista definicji, nie raport zaliczonych testów.", "",
  "[Plan główny](../../PLAN_PELNEGO_ODBIORU_PLATFORMY_2026-11-05.md) · [JSON](przypadki.json) · [wyniki CSV](wyniki.csv) · [protokół](PROTOKOL_ODBIORU.md)", "",
  `Liczba grup przypadków: **${cases.length}**. Wymagane wykonania zależą od zakresu i faz. Bazowy szablon ma **${canonical.phaseRows} wierszy faz**; warianty endpoint/rola/zasób rozwija się dodatkowo.`, "",
  "A = izolowany Linux; B = konfiguracja VPS/domeny; LIVE = uprawniony nadzorowany odbiór; UAT = pracownicy. P0/P1 opisuje priorytet odbioru, nie automatyczny poziom znalezionej podatności.", "",
  "Każdy przypadek wymaga kontroli dodatniej i adekwatnego dowodu skutków. Istniejące suite to częściowa baza. NOWY HARNESS oznacza pracę do przygotowania. Wymagania zależne od wyłączonego modułu mają N/A dopiero po udokumentowaniu zakresu i technicznego wyłączenia.", "",
  "Bieżące wyniki wpisywać do wyniki.csv albo wybranego strukturalnego rejestru executions; wybrane źródło wskazać w manifeście. Nie traktować poniższego statusu początkowego jako aktualizowanego automatycznie dashboardu.", "",
];
for (const category of categoryOrder) {
  const items = cases.filter((item) => item.category === category);
  if (!items.length) continue;
  md.push(`## ${categoryTitles[category]}`, "", "| ID / faza / bramka | Przypadek i kroki | Warunek PASS | Dowód | Baza wykonania / zależności |", "| --- | --- | --- | --- | --- |");
  for (const item of items) {
    md.push(`| **${item.id}** · ${item.phases.map((phase) => `${phase}:${item.phaseGates[phase]}`).join(" / ")}<br>${cell(item.priority)} · ${cell(item.applicability)}<br>NOT_RUN | **${cell(item.title)}**<br>${item.steps.map((step, i) => `${i + 1}. ${cell(step)}`).join("<br>")} | ${item.passCriteria.map(cell).join("<br>")} | ${item.evidence.map(cell).join("<br>")} | ${item.entryPoints.map(cell).join("<br>")}<br>Właściciel: ${cell(item.owner)}<br>Zależności: ${item.prerequisites.join(", ") || "brak"}<br>${item.references.map(cell).join("<br>")} |`);
  }
  md.push("");
}
fs.writeFileSync(path.join(__dirname, "CHECKLISTA.md"), `${md.join("\n")}\n`);

fs.writeFileSync(resultsPath, serializeCsv(plannedResultRows(cases, resultColumns)));
if (!fs.existsSync(defectsPath)) fs.writeFileSync(defectsPath, serializeCsv([["finding_id", "case_ids", "run_id", "source_sha", "status", "severity", "confirmed_impact", "reproduction_evidence", "owner", "fix_sha", "retest_run", "retest_result", "accepted_risk_reason", "risk_owner", "follow_up_date"]]));
console.log(JSON.stringify({ documentationOnly: true, cases: cases.length, phaseRows: canonical.phaseRows, counts: Object.fromEntries(categoryOrder.map((category) => [category, cases.filter((item) => item.category === category).length])), statuses: { NOT_RUN: cases.length }, generated: ["przypadki.json", "CHECKLISTA.md"], resultCsvPreservedIfExisting: true }));
