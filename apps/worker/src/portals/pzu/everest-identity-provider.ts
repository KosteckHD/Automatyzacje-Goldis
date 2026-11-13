import { isValidPesel, type IdentityMatchV1 } from "@goldis/core";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { BrowserSession } from "../../infrastructure/browser/browser";
import { PzuEverestSession, type PzuCredentials } from "./pzu-session";
import type { IdentityLookupResult, IdentityProvider, WorkerRunContext } from "../../features/execution/ports";
import { uniquePortalLocator } from "../shared/portal-locator";

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
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/ł/g, "l")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
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

/** The portal display contains the person's name followed by the business name. */
function personNameBeforeCompany(display: string, company: string): string | null {
  const words = display.trim().split(/\s+/);
  for (let index = 2; index < words.length; index++) {
    if (comparable(words.slice(index).join(" ")) === comparable(company)) {
      return words.slice(0, index).join(" ");
    }
  }
  return null;
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
    const expectedName = (context.source.expectedPersonName ?? context.source.decisionMakerName)?.trim() || null;
    if (!regon) return { kind: "identity_review", reason: "name_mismatch", candidateCount: 0 };
    const page = await this.browser.page("pzu");
    const selectors = this.options.selectors;
    await this.dismissKnownOverlay(page);
    const searchToken = `__goldisSearch_${randomUUID().replace(/-/g, "")}`;
    try {
      if (selectors.searchNavigation) {
        await this.options.beforeAction?.();
        await (await uniquePortalLocator(page, selectors.searchNavigation)).click();
      }
      const search = await uniquePortalLocator(page, selectors.searchInput);
      await search.waitFor({ state: "visible", timeout: this.options.resultTimeoutMs ?? 15_000 });
      await this.options.beforeAction?.();
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
    const candidates: Array<{ kind: "person" | "business" | "company" | "other"; name: string; identifier: string; pesel: string | null; invalidPesel: boolean }> = [];
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
        : comparable(rawKind) === comparable("Osoba fizyczna prowadząca działalność gospodarczą") ? "business"
          : comparable(rawKind) === "firma" ? "company" : "other";
      const pesel = peselValue(rawPesel);
      candidates.push({ kind, name, identifier: rawPesel.replace(/\s/g, ""), pesel, invalidPesel: Boolean(rawPesel.trim()) && pesel === null });
    }
    if (candidates.length === 0) return { kind: "not_found" };
    const sourceWords = [...new Set(comparable(context.source.companyName).split(" ").filter(word => word.length >= 4))];
    const matchesCompany = (name: string) => {
      const words = new Set(comparable(name).split(" "));
      return sourceWords.length > 0 && sourceWords.every(word => words.has(word));
    };
    const matchesContact = (name: string) => {
      if (!expectedName) return false;
      const expected = comparable(expectedName).split(" ");
      const words = new Set(comparable(name).split(" "));
      return expected.length >= 2 && expected.every(word => words.has(word));
    };
    let persons = candidates.filter(candidate => candidate.kind === "person");
    if (persons.length === 0) {
      const companies = candidates.filter(candidate => candidate.kind === "company" && candidate.identifier === regon && matchesCompany(candidate.name));
      if (companies.length) return { kind: "matched", identity: {
        schemaVersion: 1, sourceRowId: context.source.id, regon, companyName: context.source.companyName,
        firstName: "", lastName: "", pesel: "", matchMethod: "regon_company", adapterVersion: this.options.adapterVersion,
      } };
      persons = candidates.filter(candidate => candidate.kind === "business" || (candidate.kind === "company" && candidate.pesel));
    }
    if (persons.length === 0 && candidates.every(candidate => candidate.kind === "other" || candidate.kind === "company")) {
      return { kind: "identity_review", reason: "unsupported_entity_type", candidateCount: candidates.length };
    }
    if (persons.length === 0) return { kind: "identity_review", reason: "missing_expected_person", candidateCount: candidates.length };
    if (!persons.some(person => person.pesel)) return { kind: "identity_review", reason: persons.some(person => person.invalidPesel) ? "invalid_pesel" : "missing_pesel", candidateCount: candidates.length };
    const linkedBusiness = candidates.filter(candidate => candidate.kind === "business" && candidate.pesel);
    persons = persons.filter(person => person.pesel && (matchesCompany(person.name)
      || (matchesContact(person.name) && linkedBusiness.some(business => business.pesel === person.pesel))));
    if (persons.length === 0) {
      return { kind: "identity_review", reason: "name_mismatch", candidateCount: candidates.length };
    }
    // Several accounts with the same PESEL identify one person, not several candidates.
    let identifiers = [...new Set(persons.map(person => person.pesel!))];
    if (identifiers.length > 1 && expectedName) {
      const contactIds = [...new Set(persons.filter(person => matchesContact(person.name)).map(person => person.pesel!))];
      if (contactIds.length === 1) identifiers = contactIds;
    }
    if (identifiers.length > 1) return { kind: "ambiguous", candidateCount: identifiers.length };
    const person = persons.find(person => person.pesel === identifiers[0])!;
    if (context.source.expectedPersonName && !matchesContact(person.name)) return { kind: "identity_review", reason: "name_mismatch", candidateCount: candidates.length };
    if (linkedBusiness.some(business => business.pesel !== person.pesel && (matchesCompany(business.name) || matchesContact(business.name)))) {
      return { kind: "identity_review", reason: "name_mismatch", candidateCount: candidates.length };
    }
    const contactMatched = matchesContact(person.name);
    const usesContactName = contactMatched && (comparable(person.name) === comparable(expectedName!) || comparable(person.name).startsWith(comparable(expectedName!) + " "));
    const resolvedName = usesContactName ? expectedName : personNameBeforeCompany(person.name, context.source.companyName);
    const name = resolvedName ? splitPersonName(resolvedName) : null;
    const identity: IdentityMatchV1 = {
      schemaVersion: 1, sourceRowId: context.source.id, regon, companyName: context.source.companyName,
      firstName: name?.firstName ?? "", lastName: name?.lastName ?? "", pesel: person.pesel!,
      matchMethod: !name ? "regon_unique_pesel" : usesContactName ? "regon_company_name_decision_maker" : "unique_business_identity",
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
