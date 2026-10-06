const {chromium}=require('playwright');
const path=require('node:path');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const errors=[];
  const page=await browser.newPage({viewport:{width:1440,height:980},deviceScaleFactor:1});
  await page.emulateMedia({reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));
  const out=path.join(__dirname,'mockups');fs.mkdirSync(out,{recursive:true});
  for(const screen of ['tools','results','operations','access','reports','account','login']){
   await page.goto(`http://127.0.0.1:3445/?capture=1&screen=${screen}`);
   await page.evaluate(async()=>{await Promise.all(['Newsreader','Hanken Grotesk','IBM Plex Mono'].map(f=>document.fonts.load(`400 16px "${f}"`,'Zażółć gęślą jaźń')));await document.fonts.ready;});
   const fonts=await page.evaluate(()=>['Newsreader','Hanken Grotesk','IBM Plex Mono'].every(f=>document.fonts.check(`400 16px "${f}"`,'Zażółć gęślą jaźń')));
   if(!fonts)throw new Error('FONTS_NOT_LOADED');
   await page.screenshot({path:path.join(out,`${screen}-desktop.png`),fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});
  for(const screen of ['tools','login','access']){
   await page.goto(`http://127.0.0.1:3445/?capture=1&screen=${screen}`);await page.evaluate(()=>document.fonts.ready);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
   if(overflow)throw new Error(`MOBILE_OVERFLOW_${screen}`);
   await page.screenshot({path:path.join(out,`${screen}-mobile.png`),fullPage:true});
  }
  await page.setViewportSize({width:320,height:844});
  for(const screen of ['tools','results','operations','access','reports','account','login']){
   await page.goto(`http://127.0.0.1:3445/?capture=1&screen=${screen}`);
   if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth))throw new Error(`SMALL_MOBILE_OVERFLOW_${screen}`);
  }
  if(errors.length)throw new Error(errors.join('\n'));
  const luminance=hex=>{
   const rgb=hex.replace('#','').match(/.{2}/g).map(v=>parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
   return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
  };
  const contrastPairs=[['text','#f2eee5','#19191f',4.5],['muted','#a6a39a','#19191f',4.5],['primaryButton','#191509','#d9b65f',4.5],['fieldBorder','#77717b','#19191f',3]];
  const contrasts=contrastPairs.map(([name,foreground,background,minimum])=>{
   const a=luminance(foreground),b=luminance(background),ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
   if(ratio<minimum)throw new Error(`CONTRAST_FAILED_${name}`);
   return {name,foreground,background,ratio:Number(ratio.toFixed(2)),minimum};
  });
  fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify({verifiedAt:new Date().toISOString(),desktop:{width:1440,height:980,screens:7},mobile:{width:390,screenshots:3},overflowAt320:'none for all 7 screens',fonts:'3 local families loaded',javascriptErrors:errors,contrasts},null,2)+'\n');
  console.log('MOCKUP_RENDER_PASS desktop=7 mobile=3 fonts=loaded overflow320=none javascriptErrors=none');
 }finally{await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
