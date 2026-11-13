const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const out = __dirname;
const base = 'http://127.0.0.1:4178';
const importId = '44444444-4444-4444-8444-444444444444';
const all = { generatedAt: new Date().toISOString(), source: 'Actual Next render; synthetic API only; separate B browser/context', pages: [], errors: [], fixtureSupplements: ['Current /api/leads summary and tenantId supplied in browser context; existing October fixture lacks the current contract.'], cleanup: {} };
async function metrics(page) {
 return page.evaluate(() => ({url:location.href,title:document.title,viewport:{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth},headings:[...document.querySelectorAll('h1,h2,h3')].map(e=>({tag:e.tagName,text:e.textContent})),signals:[...document.querySelectorAll('[role="status"],[role="alert"],[aria-live]')].map(e=>({role:e.getAttribute('role'),live:e.getAttribute('aria-live'),text:e.textContent})),controls:[...document.querySelectorAll('a,button,input,select,textarea,summary')].filter(e=>e.getClientRects().length).map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {tag:e.tagName,type:e.getAttribute('type'),text:e.textContent?.trim().slice(0,100),ariaLabel:e.getAttribute('aria-label'),labels:e.labels?[...e.labels].map(l=>l.textContent):[],role:e.getAttribute('role'),current:e.getAttribute('aria-current'),selected:e.getAttribute('aria-selected'),disabled:e.disabled,box:{x:r.x,y:r.y,w:r.width,h:r.height},color:s.color,background:s.backgroundColor,font:s.fontSize,outline:s.outline};}),focus:document.activeElement?{tag:document.activeElement.tagName,id:document.activeElement.id,text:document.activeElement.textContent?.slice(0,100),outline:getComputedStyle(document.activeElement).outline}:null}));
}
async function main(){
 const response = await fetch(base); if(!response.ok) throw new Error('SERVER_NOT_READY '+response.status);
 const browser=await chromium.launch({headless:true});
 try {
  const context=await browser.newContext({viewport:{width:1440,height:1040},locale:'pl-PL',timezoneId:'Europe/Warsaw'});
  await context.route('**/api/auth/me', async route=>{const r=await route.fetch();const b=await r.json();if(r.ok())b.tenantId='synthetic-tenant';await route.fulfill({response:r,json:b});});
  await context.route('**/api/leads?*', async route=>{const r=await route.fetch();const b=await r.json();if(r.ok()&&Array.isArray(b.items))b.summary={scopeTotal:b.items.length,matchingTotal:b.items.length,byContactStatus:{not_contacted:2,offer_accepted:1,not_interested:1},checkedAt:'2026-11-08T21:00:00Z'};await route.fulfill({response:r,json:b});});
  const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>all.errors.push({url:page.url(),error:e.message}));
  async function capture(name,route,role='operator',state='normal',width=1440){
   await page.setViewportSize({width,height:width===390?844:1040});
   await page.goto(base+'/__review/setup?'+new URLSearchParams({role,state,path:route}),{waitUntil:'networkidle'});
   await page.evaluate(()=>document.fonts.ready);
   await page.screenshot({path:path.join(out,name+'.png'),fullPage:true,animations:'disabled'});
   const ax=await page.locator('body').ariaSnapshot();fs.writeFileSync(path.join(out,name+'.txt'),ax);
   all.pages.push({name,role,state,metrics:await metrics(page)});
   console.log('CAPTURED '+name);
  }
  await capture('b01-dashboard-desktop','/dashboard','manager');
  await capture('b02-notifications-desktop','/notifications');
  await capture('b03-my-results-desktop','/my-results');
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
  all.skipLinkAfterEnterAndTab=await metrics(page);await page.screenshot({path:path.join(out,'b04-skip-focus.png'),fullPage:false});
  await capture('b05-commission-desktop','/tools/commission-comparison','manager');
  await page.getByRole('button',{name:'Słownik prowizji',exact:true}).click();
  await page.screenshot({path:path.join(out,'b06-commission-dictionary-desktop.png'),fullPage:true});all.dictionary=await metrics(page);
  await capture('b07-oc-selection-desktop','/tools/oc-policy-verification?import='+importId+'&step=selection');
  await capture('b08-my-results-mobile','/my-results','operator','normal',390);
  await page.getByRole('button',{name:'Otwórz menu nawigacji'}).click();all.mobileDrawerOpen=await metrics(page);await page.screenshot({path:path.join(out,'b09-mobile-drawer-focus.png'),fullPage:false});
  await page.keyboard.press('Escape');all.mobileDrawerAfterEscape=await metrics(page);
  await capture('b10-commission-mobile','/tools/commission-comparison','manager','normal',390);
  await capture('b11-dashboard-error','/dashboard','manager','error');
  all.mutablePreflight=await page.evaluate(()=>{const old=document.title;document.title='B mutable preflight';const s=document.createElement('script');s.textContent='window.__bMutablePreflight = true';document.body.append(s);const result={titleChanged:document.title==='B mutable preflight',scriptExecuted:window.__bMutablePreflight===true};s.remove();document.title=old;delete window.__bMutablePreflight;return result;});
  await context.close();all.cleanup.contextClosed=true;
 }finally{await browser.close();all.cleanup.browserClosed=true;fs.writeFileSync(path.join(out,'browser-b.json'),JSON.stringify(all,null,2));}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
