"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { buildAcceptancePortalConfig } = require("./prepare-acceptance-portal-config.cjs");

test("observed company fields tolerate whitespace in labels without selecting another field", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<insured-section>
      <div class="row"><label>\n REGON \n</label><div><input value="012345678"></div></div>
      <div class="row"><label>\n Nazwa \n</label><div><input value="Synthetic Company"></div></div>
      <div class="row"><label>Nazwa dodatkowa</label><div><input value="Other"></div></div>
    </insured-section>`);
    const form = (await buildAcceptancePortalConfig()).compensa.form;
    assert.equal(await page.locator(form.regonInput).count(), 1);
    assert.equal(await page.locator(form.regonInput).inputValue(), "012345678");
    assert.equal(await page.locator(form.companyNameInput).count(), 1);
    assert.equal(await page.locator(form.companyNameInput).inputValue(), "Synthetic Company");
  } finally { await browser.close(); }
});

test("the payer prompt is scoped to its observed title and required fields", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<ux-dialog><ux-dialog-header><h4> Ubezpieczający </h4></ux-dialog-header>
      <div class="row"><label>Imię</label><input></div><div class="row"><label>Nazwisko</label><input></div>
      <div class="row"><label>PESEL</label><input value="90010100016"></div>
      <div class="row"><label>Kod pocztowy</label><input></div>
      <button>Anuluj</button><button>Akceptuj</button></ux-dialog>
      <ux-dialog><ux-dialog-header><h4>Inne okno</h4></ux-dialog-header><label>PESEL</label><input><button>Anuluj</button></ux-dialog>`);
    const form = (await buildAcceptancePortalConfig()).compensa.form;
    const dialog = page.locator(form.payerDataDialog);
    assert.equal(await dialog.count(), 1);
    assert.equal(await dialog.locator(form.payerIdentifierInput).inputValue(), "90010100016");
    assert.equal(await dialog.locator(form.payerCancel).count(), 1);
  } finally { await browser.close(); }
});
