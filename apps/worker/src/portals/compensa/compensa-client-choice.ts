import type { Locator } from "playwright";
import type { BrowserSession } from "../../infrastructure/browser/browser";
import type { CompensaCredentials, CompensaPortalSession } from "./compensa-session";

export type ClientChoiceSelectors = Readonly<{ cards: string; selectButton: string }>;
const normalize = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");

/** Client cards are scoped to the REGON and the PESEL used in the current lookup. */
export class CompensaClientChoice {
  constructor(private readonly browser: BrowserSession, private readonly session: CompensaPortalSession,
    private readonly options: Readonly<{ selectors: ClientChoiceSelectors; beforeAction?: () => Promise<void>; credentials?: () => CompensaCredentials | undefined }>) {}

  private async businessCard(regon: string, pesel: string): Promise<{ card: Locator; personName: string } | null> {
    const page = await this.browser.page("compensa");
    const cards = page.locator(this.options.selectors.cards).filter({ visible: true });
    const matches: Array<{ card: Locator; personName: string }> = [];
    for (const card of await cards.all()) {
      const fields = await card.locator(":scope > div").allInnerTexts();
      const field = (label: string) => {
        const pattern = new RegExp(`^\\s*${label}\\s*:\\s*`, "i");
        const values = fields.filter(text => pattern.test(text));
        return values.length === 1 ? values[0].replace(pattern, "").trim() : "";
      };
      if (normalize(field("Typ Klienta")) !== normalize("Osoba fizyczna prowadząca działalność gospodarczą")) continue;
      if (field("REGON").replace(/\s/g, "") !== regon) continue;
      const shownPesel = field("PESEL").replace(/\s/g, "");
      if (shownPesel && shownPesel !== pesel) continue;
      const personName = field("Nazwa").replace(/\s+/g, " ");
      if (!/^[\p{L}][\p{L} .'-]+$/u.test(personName) || personName.split(/\s+/).length < 2) continue;
      matches.push({ card, personName });
    }
    return matches.length === 1 ? matches[0] : null;
  }

  async selectIfVisible(regon: string, pesel: string): Promise<"absent" | "selected" | "mismatch"> {
    const page = await this.browser.page("compensa");
    if (!await page.locator(this.options.selectors.cards).filter({ visible: true }).count()) return "absent";
    const selected = await this.businessCard(regon, pesel);
    if (!selected) return "mismatch";
    const button = selected.card.locator(this.options.selectors.selectButton).filter({ visible: true });
    if (await button.count() !== 1 || !await button.isEnabled()) return "mismatch";
    await this.options.beforeAction?.();
    await button.click();
    await selected.card.waitFor({ state: "hidden", timeout: 10000 });
    return "selected";
  }

  /** Read a structured business/person name instead of guessing it from the legal company name. */
  async resolvePersonName(regon: string, pesel: string): Promise<string | null> {
    if (await this.session.openApplicationEntry() === "navigation_error") return null;
    if (await this.session.signIn(this.options.credentials?.()) !== "authenticated") return null;
    const page = await this.browser.page("compensa");
    const input = page.getByPlaceholder(/^PESEL\s*\/\s*REGON$/i);
    const submit = page.getByText("Przejdź do Klient 360", { exact: true });
    if (await input.count() !== 1 || await submit.count() !== 1) return null;
    await this.options.beforeAction?.();
    await input.fill(pesel);
    await this.options.beforeAction?.();
    await submit.click();
    await page.locator(this.options.selectors.cards).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 15000 });
    return (await this.businessCard(regon, pesel))?.personName ?? null;
  }
}
