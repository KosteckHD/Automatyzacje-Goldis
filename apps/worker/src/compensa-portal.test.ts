import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { BrowserSession } from "./browser";

test("syntetyczny CPortal otwiera Compensa Komunikacja i pokazuje Dane ubezpieczonych", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-fixture-"));
  assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const html = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
    const page = await browser.page("compensa");
    await page.setContent(html);
    assert.equal(await page.getByText("Zalogowany użytkownik syntetyczny").isVisible(), true);
    await page.getByRole("button", { name: "Compensa Komunikacja", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Compensa Komunikacja" });
    assert.equal(await dialog.isVisible(), true);
    await dialog.locator('input[name="insuredIdentifier"]').fill("90010100016");
    await dialog.locator('input[name="vehicleRegistration"]').fill("SYN0001");
    await dialog.getByRole("button", { name: "Compensa Komunikacja", exact: true }).click();
    assert.equal(await page.getByRole("heading", { name: "Dane ubezpieczonych" }).isVisible(), true);
    assert.equal(await page.locator('input[name="pesel"]').inputValue(), "90010100016");
    assert.equal(await page.locator('input[name="maidenName"]').inputValue(), "");
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
