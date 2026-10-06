import { isValidPesel, type IdentityMatchV1 } from "@goldis/core";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { BrowserSession } from "./browser";
import { PzuEverestSession, type PzuCredentials } from "./pzu-session";
import type { IdentityLookupResult, IdentityProvider, WorkerRunContext } from "./ports";

export type EverestResultSelectors = Readonly<{
  searchInput: string;
  searchNavigation?: string;
  resultRows: string;
  noResults: string;
  searchLoading?: string;
  optionalOverlay?: Readonly<{ container: string; dismissButton: string }>;
  fields: Readonly<{ accountType: string; personName: string; pesel: string }>;
}>;

export type EverestIdentityProviderOptions = Readonly<{
  selectors: EverestResultSelectors;
  credentials?: () => PzuCredentials | undefined;
  adapterVersion: string;
  resultTimeoutMs?: number;
  beforeAction?: () => Promise<void>;
}>;

function comparable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("pl-PL")
    .replace(/[^a-ząćęłńóśźż0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function peselValue(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  return isValidPesel(digits) ? digits : null;
}

function splitPersonName(value: string): { firstName: string; lastName: string } | null {
  const [firstName, ...lastNameParts] = value.trim().split(/\s+/).filter(Boolean);
  if (!firstName || lastNameParts.length === 0) return null;
  return { firstName, lastName: lastNameParts.join(" ") };
}

function validateOptions(options: EverestIdentityProviderOptions): void {
  const selectors = [options.selectors.searchInput, options.selectors.resultRows,
    options.selectors.noResults, ...Object.values(options.selectors.fields)];
  const overlay = options.selectors.optionalOverlay;
  const timeout = options.resultTimeoutMs ?? 15_000;
  if (selectors.some((selector) => typeof selector !== "string" || !selector.trim())
    || (options.selectors.searchNavigation !== undefined && !options.selectors.searchNavigation.trim())
    || (overlay !== undefined && (!overlay.container?.trim() || !overlay.dismissButton?.trim()))
    || !/^[A-Za-z0-9._-]{1,64}$/.test(options.adapterVersion)
    || !Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new Error("EVEREST_ADAPTER_CONFIG_INVALID");
  }
}

/** Reads PESEL from the person row of the REGON search results, as shown in Everest. */
export class EverestIdentityProvider implements IdentityProvider {
  constructor(
    private readonly browser: BrowserSession,
    private readonly session: PzuEverestSession,
    private readonly options: EverestIdentityProviderOptions,
  ) { validateOptions(options); }

  async findIdentity(context: WorkerRunContext): Promise<IdentityLookupResult> {
    const sessionState = await this.session.signIn(this.options.credentials?.());
    if (sessionState === "waiting_for_sms") return { kind: "waiting_for_sms", portal: "pzu" };
    if (sessionState !== "authenticated") throw new Error(`EVEREST_SESSION_${sessionState.toUpperCase()}`);

    const regon = context.source.effectiveRegon;
    const expectedName = context.source.decisionMakerName;
    if (!regon) return { kind: "identity_review", reason: "name_mismatch", candidateCount: 0 };
    if (!expectedName?.trim()) return { kind: "identity_review", reason: "missing_expected_person", candidateCount: 0 };
    const page = await this.browser.page("pzu");
    const selectors = this.options.selectors;
    await this.dismissKnownOverlay(page);
    const searchToken = `__goldisSearch_${randomUUID().replace(/-/g, "")}`;
    try {
      if (selectors.searchNavigation) {
        await this.options.beforeAction?.();
        await page.locator(selectors.searchNavigation).first().click();
      }
      const search = page.locator(selectors.searchInput).first();
      await search.waitFor({ state: "visible", timeout: this.options.resultTimeoutMs ?? 15_000 });
      await search.fill(regon);
      // Arm before Enter; previously visible rows are not a fresh search result.
      await page.evaluate((token) => {
        const state = { rows: [] as Element[], empty: [] as Element[], changed: new Set<Node>(), lastChange: 0, observer: null as MutationObserver | null };
        state.observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            state.changed.add(mutation.target);
            for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) state.changed.add(node);
          }
          state.lastChange = Date.now();
        });
        state.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        (window as unknown as Record<string, unknown>)[token] = state;
      }, searchToken);
      // evaluateAll supports Playwright selectors such as :has-text, unlike querySelectorAll.
      await page.locator(selectors.resultRows).evaluateAll((elements, token) => {
        (window as unknown as Record<string, { rows: Element[] }>)[token].rows = elements;
      }, searchToken);
      await page.locator(selectors.noResults).evaluateAll((elements, token) => {
        (window as unknown as Record<string, { empty: Element[] }>)[token].empty = elements;
      }, searchToken);
      await this.options.beforeAction?.();
      await search.press("Enter");
      const timeout = this.options.resultTimeoutMs ?? 15_000;
      const freshRender = (elements: Element[], input: { token: string; kind: "rows" | "empty" }) => {
        const state = (window as unknown as Record<string, { rows: Element[]; empty: Element[]; changed: Set<Node>; lastChange: number }>)[input.token];
        if (!state || Date.now() - state.lastChange < 200) return false;
        return elements.some((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden"
          && (!state[input.kind].includes(element) || [...state.changed].some((node) => node === element || element.contains(node))));
      };
      const deadline = Date.now() + timeout;
      let completed = false;
      while (Date.now() < deadline) {
        const [newRows, newEmpty] = await Promise.all([
          page.locator(selectors.resultRows).evaluateAll(freshRender, { token: searchToken, kind: "rows" as const }),
          page.locator(selectors.noResults).evaluateAll(freshRender, { token: searchToken, kind: "empty" as const }),
        ]);
        const loading = selectors.searchLoading && await page.locator(selectors.searchLoading).first().isVisible();
        if ((newRows || newEmpty) && !loading) { completed = true; break; }
        await page.waitForTimeout(100);
      }
      if (!completed) throw new Error("EVEREST_SEARCH_RESULTS_UNAVAILABLE");
      await this.dismissKnownOverlay(page);
    } catch (error) {
      if (error instanceof Error && error.message === "EVEREST_OVERLAY_UNHANDLED") throw error;
      throw new Error("EVEREST_SEARCH_RESULTS_UNAVAILABLE");
    } finally {
      await page.evaluate((token) => {
        const state = (window as unknown as Record<string, { observer?: MutationObserver }>)[token];
        state?.observer?.disconnect();
        delete (window as unknown as Record<string, unknown>)[token];
      }, searchToken).catch(() => undefined);
    }

    if (await page.locator(selectors.noResults).first().isVisible().catch(() => false)) return { kind: "not_found" };
    const rows = await page.locator(selectors.resultRows).all();
    const candidates: Array<{ kind: "person" | "business" | "other"; name: string; pesel: string | null }> = [];
    for (const row of rows) {
      if (!await row.isVisible().catch(() => false)) continue;
      const readField = async (selector: string): Promise<string> => {
        try { return (await row.locator(selector).first().innerText()).trim(); }
        catch { return ""; }
      };
      const [rawKind, name, rawPesel] = await Promise.all([
        readField(selectors.fields.accountType), readField(selectors.fields.personName), readField(selectors.fields.pesel),
      ]);
      const kind = comparable(rawKind) === comparable("Osoba fizyczna") ? "person"
        : comparable(rawKind) === comparable("Osoba fizyczna prowadząca działalność gospodarczą") ? "business" : "other";
      candidates.push({ kind, name, pesel: peselValue(rawPesel) });
    }
    if (candidates.length === 0) return { kind: "not_found" };
    let persons = candidates.filter((candidate) => candidate.kind === "person");
    if (persons.length > 1) {
      const expected = comparable(expectedName);
      persons = persons.filter((candidate) => {
        const name = comparable(candidate.name);
        return name === expected || name.startsWith(`${expected} `);
      });
      if (persons.length === 0) return { kind: "identity_review", reason: "name_mismatch", candidateCount: candidates.length };
      if (persons.length > 1) return { kind: "ambiguous", candidateCount: persons.length };
    }
    if (persons.length === 0) return { kind: "identity_review", reason: "name_mismatch", candidateCount: candidates.length };
    const person = persons[0];
    const displayName = comparable(person.name);
    const normalizedExpectedName = comparable(expectedName);
    const sourceCompanyWords = comparable(context.source.companyName).split(" ").filter((word) => word.length >= 4);
    const displayWords = new Set(displayName.split(" "));
    if (!(displayName === normalizedExpectedName || displayName.startsWith(`${normalizedExpectedName} `))
      || sourceCompanyWords.length === 0 || !sourceCompanyWords.every((word) => displayWords.has(word))) {
      return { kind: "identity_review", reason: "name_mismatch", candidateCount: candidates.length };
    }
    if (!person.pesel) return { kind: "identity_review", reason: "missing_pesel", candidateCount: candidates.length };
    const business = candidates.filter((candidate) => candidate.kind === "business");
    if (business.some((candidate) => candidate.pesel && candidate.pesel !== person.pesel)) {
      return { kind: "identity_review", reason: "name_mismatch", candidateCount: candidates.length };
    }
    const name = splitPersonName(expectedName);
    if (!name) return { kind: "identity_review", reason: "name_mismatch", candidateCount: candidates.length };
    const identity: IdentityMatchV1 = {
      schemaVersion: 1, sourceRowId: context.source.id, regon, companyName: context.source.companyName,
      ...name, pesel: person.pesel, matchMethod: "regon_company_name_decision_maker",
      adapterVersion: this.options.adapterVersion,
    };
    return { kind: "matched", identity };
  }

  private async dismissKnownOverlay(page: Page): Promise<void> {
    const configured = this.options.selectors.optionalOverlay;
    if (!configured) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const overlays = page.locator(configured.container);
      if (!await overlays.first().isVisible().catch(() => false)) return;
      if (await overlays.count() !== 1) throw new Error("EVEREST_OVERLAY_UNHANDLED");
      const dismiss = overlays.locator(configured.dismissButton);
      if (await dismiss.count() !== 1 || !await dismiss.isVisible() || !await dismiss.isEnabled()) throw new Error("EVEREST_OVERLAY_UNHANDLED");
      await this.options.beforeAction?.();
      await dismiss.click();
      await overlays.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => { throw new Error("EVEREST_OVERLAY_UNHANDLED"); });
    }
    if (await page.locator(configured.container).first().isVisible().catch(() => false)) throw new Error("EVEREST_OVERLAY_UNHANDLED");
  }
}
