"use strict";
const { test }=require("node:test");
const assert=require("node:assert/strict");
const { ROW_NUMBERS,classify,shouldStop,summary }=require("./supervised-live-report.cjs");
const { buildAcceptancePortalConfig }=require("./prepare-acceptance-portal-config.cjs");

test("the authorized range accounts for every physical row including both endpoints",()=>{
  assert.equal(ROW_NUMBERS.length,101);assert.equal(ROW_NUMBERS[0],18000);assert.equal(ROW_NUMBERS.at(-1),18100);
  assert.equal(new Set(ROW_NUMBERS).size,101);
});
test("a completed status alone cannot certify an export; untouched rows stay untested",()=>{
  assert.equal(classify({status:"completed"}),"WERYFIKACJA_EKSPORTU");
  assert.equal(classify({status:"completed",artifactVerified:true}),"EKSPORT_ZWERYFIKOWANY");
  assert.deepEqual(summary([{status:"not_started"},{status:"failed",errorCode:"IDENTITY_NOT_FOUND"}]),{
    NIEURUCHOMIONY:1,BRAK_DOPASOWANIA_DO_KONTROLI:1,
  });
});
test("uncertain portal outcomes halt admissions while a reported absent person does not trigger a retry",()=>{
  for(const row of [{status:"failed",errorCode:"OFFER_SAVE_UNCONFIRMED"},{status:"failed",errorCode:"PORTAL_SCHEMA_CHANGED"},{status:"waiting_for_manual_data"},{status:"verification_failed"}])assert.equal(shouldStop(row),true);
  assert.equal(shouldStop({status:"failed",errorCode:"IDENTITY_NOT_FOUND"}),false);
});
test("the observed PESEL/Pesel labels find the exact person field without matching other identifiers",async()=>{
  const { chromium }=require("playwright");const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();const config=await buildAcceptancePortalConfig();
    for(const label of ["PESEL","Pesel"]){
      await page.setContent(`<insured-section><div class="row"><label>${label}</label><input value="90010100016"></div><div class="row"><label>PESEL współmałżonka</label><input value="other"></div></insured-section>`);
      const input=page.locator(config.compensa.form.peselInput);assert.equal(await input.count(),1);assert.equal(await input.inputValue(),"90010100016");
    }
    await page.setContent('<insured-section><div class="row"><label>PESEL współmałżonka</label><input></div></insured-section>');
    assert.equal(await page.locator(config.compensa.form.peselInput).count(),0);
  }finally{await browser.close();}
});
