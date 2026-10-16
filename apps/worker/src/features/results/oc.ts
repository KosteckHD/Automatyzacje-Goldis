import { parsePolishDate, policyMatchesDate, validateOcSnapshotV1, type OcPolicy, type OcSnapshotV1 } from "@goldis/core";
import type { Page } from "playwright";

export type OcTableRow = string[];

function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

export function parseOcRows(rows: OcTableRow[], expectedCount: number): OcPolicy[] {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) throw new Error("UFG_COUNT_INVALID");
  if (rows.length !== expectedCount) throw new Error("UFG_INCOMPLETE");
  const ordinals = new Set<number>();
  return rows.map((cells) => {
    if (cells.length !== 13) throw new Error("UFG_SCHEMA_CHANGED");
    const ordinal = Number(cells[0]);
    if (!/^\d+$/.test(cells[0]) || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinals.has(ordinal)) throw new Error("UFG_ORDINAL_INVALID");
    ordinals.add(ordinal);
    const coverageFrom = optional(cells[10]);
    const coverageTo = optional(cells[11]);
    if (!coverageTo || !parsePolishDate(coverageTo)) throw new Error("COVERAGE_TO_INVALID");
    if (coverageFrom && !parsePolishDate(coverageFrom)) throw new Error("COVERAGE_FROM_INVALID");
    const claims = optional(cells[4]);
    if (claims && (!/^\d+$/.test(claims) || !Number.isSafeInteger(Number(claims)))) throw new Error("UFG_CLAIMS_INVALID");
    const policyTypeAndNumber = optional(cells[2]);
    if (!policyTypeAndNumber) throw new Error("UFG_POLICY_NUMBER_MISSING");
    return {
      sourceOrdinal: ordinal,
      insuredName: optional(cells[1]),
      policyTypeAndNumber,
      contractType: optional(cells[3]),
      insuredClaimCount: claims === null ? null : Number(claims),
      vehicleRegistration: optional(cells[5]),
      vehicleGroup: optional(cells[6]),
      vehicleMake: optional(cells[7]),
      vehicleModel: optional(cells[8]),
      insurer: optional(cells[9]),
      coverageFrom,
      coverageTo,
    };
  });
}

/** Reads the OC count from the UFG summary, without relying on column position. */
export async function readOcSummaryCount(page: Page, summarySelector?: string): Promise<number> {
  const summary = summarySelector ? page.locator(summarySelector) : page.locator("table").filter({ hasText: "Liczba polis", visible: true });
  await summary.first().waitFor({ state: "visible" });
  if (await summary.count() !== 1) throw new Error("UFG_SUMMARY_AMBIGUOUS");
  const rows = await summary.locator("tr").evaluateAll((elements) => elements.map((element) =>
    Array.from(element.querySelectorAll("th,td"), (cell) => (cell.textContent ?? "").trim().replace(/\s+/g, " ")),
  ));
  const headers = rows.filter((row) => row.includes("OC"));
  const countRows = rows.filter((row) => row[0] === "Liczba polis");
  if (headers.length !== 1 || countRows.length !== 1 || headers[0].filter(cell => cell === "OC").length !== 1) throw new Error("UFG_COUNT_INVALID");
  const header = headers[0];
  const countRow = countRows[0];
  const ocColumn = header?.indexOf("OC") ?? -1;
  const value = ocColumn >= 0 ? countRow?.[ocColumn] : undefined;
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("UFG_COUNT_INVALID");
  return Number(value);
}

type RawOcTableSnapshot = Readonly<{
  headings: string[];
  rows: OcTableRow[];
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  canScroll: boolean;
}>;

async function readRawOcTable(page: Page): Promise<RawOcTableSnapshot> {
  const table = page.locator("table").filter({ hasText: "Okres ub. do", visible: true });
  await table.first().waitFor({ state: "visible" });
  if (await table.count() !== 1) throw new Error("UFG_TABLE_AMBIGUOUS");
  return table.evaluate((element) => {
    const heading = element.querySelector("thead");
    if (!heading) throw new Error("UFG_SCHEMA_CHANGED");
    const rows = Array.from(element.querySelectorAll("tbody tr"), (row) =>
      Array.from(row.querySelectorAll("td"), (cell) => (cell.textContent ?? "").trim().replace(/\s+/g, " ")),
    );
    let scroller: HTMLElement | null = element.parentElement;
    while (scroller && scroller !== document.body) {
      const style = getComputedStyle(scroller);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && scroller.scrollHeight > scroller.clientHeight + 1) break;
      scroller = scroller.parentElement;
    }
    const target = scroller && scroller !== document.body
      ? scroller
      : document.scrollingElement as HTMLElement | null;
    const canScroll = Boolean(target && target.scrollHeight > target.clientHeight + 1);
    return {
      headings: Array.from(heading.querySelectorAll("th"), (cell) => (cell.textContent ?? "").trim().replace(/\s+/g, " ")),
      rows,
      scrollTop: target?.scrollTop ?? 0,
      clientHeight: target?.clientHeight ?? 0,
      scrollHeight: target?.scrollHeight ?? 0,
      canScroll,
    };
  });
}

type OcColumn = "ordinal" | "insuredName" | "policyTypeAndNumber" | "contractType" | "insuredClaimCount"
  | "vehicleRegistration" | "vehicleGroup" | "vehicleMake" | "vehicleModel" | "insurer" | "coverageFrom" | "coverageTo" | "actions";

const ocHeaderAliases: Readonly<Record<string, OcColumn>> = {
  "l.p.": "ordinal", "lp.": "ordinal", "l.p": "ordinal", "lp": "ordinal",
  "ubezpieczony": "insuredName",
  "typ i nr polisy": "policyTypeAndNumber",
  "rodzaj umowy": "contractType",
  "liczba szkód ubezpieczonego": "insuredClaimCount",
  "nr rejestracyjny": "vehicleRegistration",
  "grupa pojazdu": "vehicleGroup",
  "marka": "vehicleMake",
  "model": "vehicleModel",
  "zu": "insurer",
  "okres ub. od": "coverageFrom",
  "okres ub. do": "coverageTo",
  "akcje": "actions",
};

const ocCanonicalColumns: readonly OcColumn[] = [
  "ordinal", "insuredName", "policyTypeAndNumber", "contractType", "insuredClaimCount", "vehicleRegistration",
  "vehicleGroup", "vehicleMake", "vehicleModel", "insurer", "coverageFrom", "coverageTo", "actions",
];

function resolveOcColumnIndexes(headings: readonly string[]): Readonly<Record<OcColumn, number>> {
  if (headings.length !== ocCanonicalColumns.length) throw new Error("UFG_SCHEMA_CHANGED");
  const indexes: Partial<Record<OcColumn, number>> = {};
  for (const [index, heading] of headings.entries()) {
    const key = heading.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");
    const column = ocHeaderAliases[key];
    if (!column || indexes[column] !== undefined) throw new Error("UFG_SCHEMA_CHANGED");
    indexes[column] = index;
  }
  if (ocCanonicalColumns.some((column) => indexes[column] === undefined)) throw new Error("UFG_SCHEMA_CHANGED");
  return indexes as Record<OcColumn, number>;
}

function canonicalizeOcRows(rows: readonly OcTableRow[], indexes: Readonly<Record<OcColumn, number>>): OcTableRow[] {
  return rows.map((row) => {
    if (row.length !== ocCanonicalColumns.length) throw new Error("UFG_SCHEMA_CHANGED");
    return ocCanonicalColumns.map((column) => row[indexes[column]]);
  });
}

/** Reads every rendered or virtualized OC row; a mismatch against the UFG count is a hard failure. */
export async function readOcRows(page: Page, expectedCount: number): Promise<OcPolicy[]> {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) throw new Error("UFG_COUNT_INVALID");
  let first = await readRawOcTable(page);
  if (first.scrollTop > 0 && first.canScroll) {
    await page.locator("table").filter({ hasText: "Okres ub. do", visible: true }).evaluate(element => {
      let target: HTMLElement | null = element.parentElement;
      while (target && target !== document.body) {
        const style = getComputedStyle(target);
        if ((style.overflowY === "auto" || style.overflowY === "scroll") && target.scrollHeight > target.clientHeight + 1) break;
        target = target.parentElement;
      }
      if (!target || target === document.body) target = document.scrollingElement as HTMLElement | null;
      if (target) target.scrollTop = 0;
    });
    await page.waitForTimeout(120);
    first = await readRawOcTable(page);
  }
  const indexes = resolveOcColumnIndexes(first.headings);
  const rowsByOrdinal = new Map<number, OcTableRow>();
  const addRows = (rows: readonly OcTableRow[]) => {
    const renderedOrdinals = new Set<number>();
    for (const row of canonicalizeOcRows(rows, indexes)) {
      if (row.length === 0 || !/^\d+$/.test(row[0] ?? "")) throw new Error("UFG_ORDINAL_INVALID");
      const ordinal = Number(row[0]);
      if (!Number.isSafeInteger(ordinal) || ordinal < 1 || renderedOrdinals.has(ordinal)) throw new Error("UFG_ORDINAL_INVALID");
      renderedOrdinals.add(ordinal);
      const previous = rowsByOrdinal.get(ordinal);
      if (previous && previous.join("\u0000") !== row.join("\u0000")) throw new Error("UFG_ORDINAL_CONFLICT");
      rowsByOrdinal.set(ordinal, row);
    }
  };
  addRows(first.rows);
  if (rowsByOrdinal.size > expectedCount) throw new Error("UFG_COUNT_MISMATCH");

  // Static tables finish in one pass. Virtual lists replace tbody rows while the inner modal scrolls.
  let snapshot = first;
  let stagnantBottomPasses = 0;
  const maxScrollPasses = Math.min(2_000, Math.max(20, expectedCount * 2 + 5));
  for (let pass = 0; rowsByOrdinal.size < expectedCount && snapshot.canScroll && pass < maxScrollPasses; pass += 1) {
    const moved = await page.locator("table").filter({ hasText: "Okres ub. do", visible: true }).evaluate((element) => {
      let scroller: HTMLElement | null = element.parentElement;
      while (scroller && scroller !== document.body) {
        const style = getComputedStyle(scroller);
        if ((style.overflowY === "auto" || style.overflowY === "scroll") && scroller.scrollHeight > scroller.clientHeight + 1) break;
        scroller = scroller.parentElement;
      }
      const target = scroller && scroller !== document.body
        ? scroller
        : document.scrollingElement as HTMLElement | null;
      if (!target || target.scrollHeight <= target.clientHeight + 1) return false;
      const before = target.scrollTop;
      const stride = Math.max(1, Math.floor(target.clientHeight * 0.7));
      target.scrollTop = Math.min(target.scrollHeight, before + stride);
      return target.scrollTop > before;
    });
    if (!moved) {
      const previousCount = rowsByOrdinal.size;
      await page.waitForTimeout(120);
      snapshot = await readRawOcTable(page);
      if (snapshot.headings.length !== first.headings.length || snapshot.headings.some((heading, index) => heading !== first.headings[index])) throw new Error("UFG_SCHEMA_CHANGED");
      addRows(snapshot.rows);
      if (rowsByOrdinal.size > expectedCount) throw new Error("UFG_COUNT_MISMATCH");
      const atBottom = snapshot.scrollTop + snapshot.clientHeight >= snapshot.scrollHeight - 1;
      if (!atBottom || rowsByOrdinal.size === previousCount) stagnantBottomPasses += 1;
      else stagnantBottomPasses = 0;
      if (stagnantBottomPasses >= 2) break;
      continue;
    }
    const previousCount = rowsByOrdinal.size;
    await page.waitForTimeout(80);
    snapshot = await readRawOcTable(page);
    if (snapshot.headings.length !== first.headings.length || snapshot.headings.some((heading, index) => heading !== first.headings[index])) throw new Error("UFG_SCHEMA_CHANGED");
    addRows(snapshot.rows);
    if (rowsByOrdinal.size > expectedCount) throw new Error("UFG_COUNT_MISMATCH");
    const atBottom = snapshot.scrollTop + snapshot.clientHeight >= snapshot.scrollHeight - 1;
    if (atBottom && rowsByOrdinal.size === previousCount) stagnantBottomPasses += 1;
    else stagnantBottomPasses = 0;
    if (atBottom && stagnantBottomPasses >= 2) break;
  }

  const rows = [...rowsByOrdinal.entries()].sort(([left], [right]) => left - right).map(([, row]) => row);
  return parseOcRows(rows, expectedCount);
}

export function selectCurrentPolicies(policies: readonly OcPolicy[], referenceDate: string): OcPolicy[] {
  if (!parsePolishDate(referenceDate)) throw new Error("REFERENCE_DATE_INVALID");
  return policies.filter((policy) => policyMatchesDate(policy, referenceDate));
}

export async function collectCurrentOc(page: Page, referenceDate: string): Promise<{ totalCount: number; policies: OcPolicy[] }> {
  const totalCount = await readOcSummaryCount(page);
  const table = page.locator("table").filter({ hasText: "Okres ub. do", visible: true });
  if (await table.count() === 0) {
    if (totalCount === 0) return { totalCount, policies: selectCurrentPolicies([], referenceDate) };
    await page.getByText("Szczegóły polis OC", { exact: true }).filter({ visible: true }).click();
  }
  const allPolicies = await readOcRows(page, totalCount);
  return { totalCount, policies: selectCurrentPolicies(allPolicies, referenceDate) };
}

/** Reads the full OC snapshot for W2; date filtering remains a later, separate pipeline step. */
export async function readOcSnapshot(page: Page, capturedAt: string, parserVersion: string, summarySelector?: string): Promise<OcSnapshotV1> {
  const totalCount = await readOcSummaryCount(page, summarySelector);
  const table = page.locator("table").filter({ hasText: "Okres ub. do", visible: true });
  if (await table.count() === 0) {
    if (totalCount === 0) return validateOcSnapshotV1({ schemaVersion: 1, totalCount, policies: [], capturedAt, parserVersion });
    await page.getByText("Szczegóły polis OC", { exact: true }).filter({ visible: true }).click();
  }
  const policies = await readOcRows(page, totalCount);
  return validateOcSnapshotV1({ schemaVersion: 1, totalCount, policies, capturedAt, parserVersion });
}
