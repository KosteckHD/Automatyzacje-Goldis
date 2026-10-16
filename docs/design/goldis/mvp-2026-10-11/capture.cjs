const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=__dirname,out=path.join(root,'public/screenshots');fs.mkdirSync(out,{recursive:true});
const screens=[
['01-logowanie','Logowanie','login','employee','Start'],
['02-dashboard-pracownik','Dashboard pracownika','dashboard','employee','Praca'],
['03-narzedzia','Narzędzia','tools','employee','Import i automatyzacja'],
['04-import','Wgranie pliku Excel','upload','employee','Import i automatyzacja'],
['05-przygotowanie','Kontrola danych i duplikaty','preparation','employee','Import i automatyzacja'],
['06-regon','Uzupełnienie REGON-ów','preparation','employee','Import i automatyzacja','enrich'],
['07-start','Potwierdzenie uruchomienia','launch','employee','Import i automatyzacja'],
['08-zadania','Lista zadań','runs','employee','Zadania'],
['09-w-toku','Zadanie w toku','run?id=OC-1055','employee','Zadania'],
['10-wymagane-dzialanie','Wymagane działanie','run?id=OC-1056','employee','Zadania'],
['11-wynik-gotowy','Zadanie zakończone','run?id=OC-1054','employee','Zadania'],
['12-wyniki','Wyniki według automatyzacji','results','employee','Wyniki i kontakt'],
['13-wspolna-pula','Wspólna pula — pracownik','leads','employee','Wyniki i kontakt'],
['14-moje-wyniki','Moje wyniki i statusy kontaktu','mine','employee','Wyniki i kontakt'],
['15-lead','Szczegóły firmy i wynik OC','lead?id=L-1081','employee','Wyniki i kontakt'],
['16-import-zrodlowy','Źródłowy import po uruchomieniu','preparation?readonly=1','employee','Wyniki i kontakt'],
['17-powiadomienia','Powiadomienia osoby uruchamiającej','notifications','employee','Praca'],
['18-moje-konto','Konto i sesje','account','employee','Praca'],
['19-dashboard-menedzer','Dashboard menedżera','dashboard','manager','Menedżer'],
['20-przydzielanie','Przydzielanie liczby leadów','leads','manager','Menedżer','assign'],
['21-moje-wyniki-menedzer','Własne leady menedżera','mine','manager','Menedżer'],
['22-pracownicy','Lista pracowników','users','manager','Menedżer'],
['23-konto-pracownika','Edycja konta pracownika','user','manager','Menedżer'],
['24-nowy-pracownik','Utworzenie pracownika','user?new=1','manager','Menedżer'],
['25-dostepy','Uprawnienia pracownika','access','manager','Menedżer'],
['26-raporty','Raport obsługi leadów','reports','manager','Menedżer'],
['27-uzytkownicy-admin','Konta i role — administrator','users','admin','Administrator'],
['28-ustawienia','Ustawienia automatyzacji','automation','admin','Administrator'],
['29-monitoring','Monitoring platformy','monitor','admin','Administrator'],
['30-audyt','Dziennik audytu','audit','admin','Administrator'],
['36-narzedzia-bez-dostepu','Narzędzie bez prawa uruchamiania','tools','employee','Uprawnienia','no-execute'],
['37-blokada-startu','Start bez uprawnienia','upload','employee','Uprawnienia','no-execute'],
['38-powtorzona-firma','Ta sama firma w nowym uruchomieniu','lead?id=L-1094','employee','Wyniki i kontakt'],
['31-mobile-dashboard','Dashboard na telefonie','dashboard','employee','Telefon','mobile'],
['32-mobile-moje-wyniki','Moje wyniki na telefonie','mine','employee','Telefon','mobile'],
['33-mobile-lead','Szczegóły firmy na telefonie','lead?id=L-1081','employee','Telefon','mobile'],
['34-mobile-menu','Sidebar na telefonie','mine','employee','Telefon','menu'],
['35-mobile-przydzielanie','Przydzielanie na telefonie','leads','manager','Telefon','mobile-assign'],
];
async function run(){
 const browser=await chromium.launch({headless:true}),errors=[],checks=[];
 for(const [id,title,route,role,group,state] of screens){
  const mobile=state?.includes('mobile')||state==='menu',page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},deviceScaleFactor:1,reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(id+': '+e.message));
  await page.goto('http://127.0.0.1:3446/?role='+role+(state==='no-execute'?'&execute=no':'')+'#'+route);await page.locator('h1').waitFor();await page.evaluate(()=>document.fonts.ready);
  if(state==='enrich'){await page.getByRole('button',{name:'Uzupełnij REGON-y',exact:true}).click();await page.locator('.toast').waitFor({state:'hidden'});}
  if(state==='assign'||state==='mobile-assign')await page.getByRole('button',{name:'Przydziel leady',exact:true}).click();
  if(state==='menu')await page.getByRole('button',{name:'Otwórz menu',exact:true}).click();
  if(state==='no-execute'&&route==='tools')assert(await page.getByRole('button',{name:'Uruchom narzędzie',exact:true}).isDisabled());if(state==='no-execute'&&route==='upload')await page.getByRole('heading',{name:'Uruchamianie wymaga uprawnienia'}).waitFor();
  await page.evaluate(()=>window.scrollTo(0,0));
  const metrics=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,width:innerWidth,title:document.querySelector('h1')?.textContent,body:document.body.textContent.length}));assert(metrics.body>200,id+' blank');if(metrics.overflow)errors.push(id+': page overflow');
  await page.addStyleTag({content:'.prototype-bar{display:none!important}'});
  await page.screenshot({path:path.join(out,id+'.png'),fullPage:state!=='menu'});
  checks.push({id,title,route,role,group,state:state||'default',viewport:mobile?'390 × 844':'1440 × 1000',...metrics});await page.close();
 }
 // The central flow is exercised in one session so allocation and contact state persist.
 fs.writeFileSync(path.join(root,'screens.json'),JSON.stringify(checks,null,2));
 const p=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});await p.goto('http://127.0.0.1:3446/?role=manager#leads');
 await p.getByRole('button',{name:'Przydziel leady',exact:true}).click();await p.getByLabel('Liczba leadów').fill('99');await p.getByRole('button',{name:'Przydziel 99 leady',exact:true}).click();assert(await p.getByRole('alert').isVisible());
 await p.getByLabel('Liczba leadów').fill('3');await p.getByRole('button',{name:'Przydziel 3 leady',exact:true}).click();assert.equal(await p.locator('.pool-summary').textContent(),'14 wszystkie leady7 nieprzypisanych7 przypisanychDostęp do wyników i plików dla całego zespołu');
 await p.getByLabel('Rola podglądu',{exact:true}).selectOption('employee');await p.getByLabel('Widok podglądu',{exact:true}).selectOption('mine');assert.equal(await p.locator('.contact-status').count(),6);
 await p.getByLabel('Status kontaktu: Transport Demo',{exact:true}).selectOption('Klient zgadza się na ofertę');assert.equal(await p.getByLabel('Status kontaktu: Transport Demo',{exact:true}).inputValue(),'Klient zgadza się na ofertę');
 await p.getByLabel('Widok podglądu',{exact:true}).selectOption('leads');assert.equal(await p.locator('.contact-status').count(),6);assert.equal(await p.getByRole('button',{name:'Przydziel leady',exact:true}).count(),0);
 await p.goto('http://127.0.0.1:3446/?role=employee#users');await p.getByRole('heading',{name:'Brak dostępu do tej sekcji'}).waitFor();
 await p.goto('http://127.0.0.1:3446/?role=employee#preparation?readonly=1');assert.equal(await p.getByRole('button',{name:'Popraw dane',exact:true}).count(),0);assert.equal(await p.getByRole('button',{name:'Przejdź do uruchomienia',exact:true}).count(),0);
 await p.goto('http://127.0.0.1:3446/?role=manager#user');assert(await p.locator('label.field').filter({hasText:'Rola'}).locator('select').isDisabled());
 await p.setViewportSize({width:390,height:844});await p.getByRole('button',{name:'Otwórz menu',exact:true}).click();await p.getByRole('dialog',{name:'Nawigacja'}).waitFor();await p.keyboard.press('Escape');await p.getByRole('dialog',{name:'Nawigacja'}).waitFor({state:'hidden'});assert.equal(await p.getByRole('button',{name:'Otwórz menu',exact:true}).evaluate(el=>el===document.activeElement),true);
 await p.goto('http://127.0.0.1:3446/?role=admin#user?name=Marta%20Nowak');assert.equal(await p.getByLabel('Imię i nazwisko',{exact:true}).inputValue(),'Marta Nowak');assert.equal(await p.getByLabel('Login',{exact:true}).inputValue(),'marta');
 await p.goto('http://127.0.0.1:3446/?role=employee#preparation');await p.getByRole('button',{name:'Popraw dane',exact:true}).click();await p.getByLabel('REGON wiersza 4',{exact:true}).fill('000000103');await p.getByRole('button',{name:'Zapisz i sprawdź duplikaty',exact:true}).click();assert.equal(await p.locator('.inspection-summary strong').nth(1).textContent(),'41');await p.getByRole('button',{name:'Przejdź do uruchomienia',exact:true}).click();await p.getByRole('button',{name:'Uruchom weryfikację',exact:true}).click();assert((await p.locator('.run-state').textContent()).includes('32 z 41'));await p.locator('.toast').waitFor({state:'hidden'});await p.addStyleTag({content:'.prototype-bar{display:none!important}'});fs.mkdirSync(path.join(root,'.impeccable/review'),{recursive:true});await p.screenshot({path:path.join(root,'.impeccable/review/new-run.png'),fullPage:true});
 await p.goto('http://127.0.0.1:3446/?role=manager#notifications');assert(!(await p.locator('.notification-list').textContent()).includes('Anna Kowalska'));assert((await p.locator('.notification-list').textContent()).includes('OC-1053'));
 await p.goto('http://127.0.0.1:3446/?role=manager#run?id=OC-1054');assert((await p.locator('.page-heading').textContent()).includes('Anna Kowalska'));
 await p.close();await browser.close();
 fs.writeFileSync(path.join(root,'screens.json'),JSON.stringify(checks,null,2));fs.writeFileSync(path.join(root,'CHECKS.json'),JSON.stringify({screens:screens.length,errors,tests:['Allocation bounded by unassigned pool; ownership persists across role switch','Employee edits only assigned leads; no allocation controls','Contact outcome stored in prototype state','Employee administration route denied','Source import immutable after start','Manager cannot change employee role','Mobile dialog closes with Escape and returns focus','Execution-denied tool and upload captures asserted','Administrator selected account data matches selected person','Pre-start correction persists and updates ready count','Personal notifications filtered by fixed launcher','Run launcher remains fixed across viewer roles','New run progress uses confirmed ready count41; screenshot .impeccable/review/new-run.png'],passed:errors.length===0},null,2));
 console.log(JSON.stringify({screens:screens.length,errors,tests:'passed'}));assert.equal(errors.length,0);
}
run().catch(e=>{console.error(e);process.exit(1)});
