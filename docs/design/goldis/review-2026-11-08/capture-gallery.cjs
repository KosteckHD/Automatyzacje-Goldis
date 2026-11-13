const { chromium } = require('playwright');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1100},locale:'pl-PL'});
    await page.goto(pathToFileURL(path.join(__dirname,'GALERIA_EKRANOW.html')).href,{waitUntil:'load'});
    const result = await page.evaluate(async () => {
      const images = [...document.querySelectorAll('article img')];
      const decoded = await Promise.all(images.map(async img => { img.loading='eager'; try { await img.decode(); return true; } catch { return false; } }));
      return {cards:document.querySelectorAll('article').length,images:images.length,failed:decoded.filter(ok=>!ok).length};
    });
    await page.screenshot({path:path.join(__dirname,'GALERIA_PODGLAD.png')});
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
