import type { Locator } from "playwright";
import type { BrowserSession } from "../../infrastructure/browser/browser";

export type ClientChoiceSelectors = Readonly<{ cards: string; selectButton: string }>;
const normalize = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");

/** Selects cards already shown after Communication starts; never opens a customer search. */
export class CompensaClientChoice {
  constructor(private readonly browser: BrowserSession,
    private readonly options: Readonly<{ selectors: ClientChoiceSelectors; beforeAction?: () => Promise<void> }>) {}

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
      const expectedType = pesel ? "Osoba fizyczna prowadząca działalność gospodarczą" : "Firma";
      if (normalize(field("Typ Klienta")) !== normalize(expectedType)) continue;
      if (field("REGON").replace(/\s/g, "") !== regon) continue;
      const shownPesel = field("PESEL").replace(/\s/g, "");
      if (shownPesel && shownPesel !== pesel) continue;
      const personName = field("Nazwa").replace(/\s+/g, " ");
      if (!personName || (pesel && (!/^[\p{L}][\p{L} .'-]+$/u.test(personName) || personName.split(/\s+/).length < 2))) continue;
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

}
