"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Module = require("node:module");
const ROOT = path.resolve(__dirname, "../..");
const { isolatedEnvironment, MODULES } = require(path.join(ROOT, "scripts/test-module.cjs"));

async function capture(page) {
  const data = await page.evaluate(() => {
    const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
    const controls = [...document.querySelectorAll("button,a[href],input:not([type=hidden]),select,textarea")].filter(visible);
    return {
      pathname: location.pathname, width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1,
      headings: [...document.querySelectorAll("h1,h2,h3")].filter(visible).map(e => ({ level: e.tagName, text: e.textContent.trim().slice(0,100) })),
      unnamed: controls.filter(e => !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby") && !e.textContent.trim() && !e.labels?.length && !e.getAttribute("title")).map(e => ({ tag:e.tagName,id:e.id,type:e.type,html:e.outerHTML.slice(0,240) })),
      smallTargets: controls.filter(e => { const r=e.getBoundingClientRect();return r.width<24 || r.height<24; }).map(e => ({ tag:e.tagName,text:(e.textContent||e.getAttribute("aria-label")||e.id).trim().slice(0,80),width:Math.round(e.getBoundingClientRect().width),height:Math.round(e.getBoundingClientRect().height) })),
      textStyles: [...document.querySelectorAll("p,small,label,td,th,button,a,h2,h3,span")].filter(visible).slice(0,600).map(e => {
        let parent=e,bg="",bgClass="";
        while(parent){const c=getComputedStyle(parent).backgroundColor;if(c!=="rgba(0, 0, 0, 0)"&&c!=="transparent"){bg=c;bgClass=parent.className;break;}parent=parent.parentElement;}
        return {text:e.textContent.trim().slice(0,90),className:e.className,color:getComputedStyle(e).color,background:bg,backgroundClass:bgClass,fontSize:getComputedStyle(e).fontSize};
      }),
    };
  });
  fs.writeFileSync(path.join(__dirname, `ui-${data.pathname.replace(/[^a-z0-9]/gi,"_") || "home"}-${data.width}.json`),JSON.stringify(data,null,2));
}
module.exports = { capture };

if (process.argv[2] === "ui") {
  const file = path.resolve(ROOT, "apps/web/scripts", process.argv[3]);
  let code = fs.readFileSync(file,"utf8").replaceAll("../../../docs/design/goldis/implemented", "../../../docs/audit-platform-2026-10-08/screenshots");
  code = `const { capture: auditCapture } = require(${JSON.stringify(__filename)});\n` + code.replaceAll("await page.screenshot(", "await (await auditCapture(page), page).screenshot(");
  const compiled = new Module(file, module);
  compiled.filename = file;
  compiled.paths = Module._nodeModulePaths(path.dirname(file));
  compiled._compile(code,file);
} else if (require.main === module) {
  const results = process.argv[2] === "remaining" ? JSON.parse(fs.readFileSync(path.join(__dirname,"test-results.json"),"utf8")) : [];
  function run(name, args, cwd=ROOT, env=isolatedEnvironment(process.env,"security")) {
    const start = Date.now();
    const result = spawnSync(process.execPath,args,{cwd,env:{...env,API_INTERNAL_URL:"http://127.0.0.1:1"},encoding:"utf8",windowsHide:true,timeout:180000,maxBuffer:16*1024*1024});
    const output = (result.stdout||"")+(result.stderr||"");
    fs.writeFileSync(path.join(__dirname,`${name}.log`),output);
    const counts = Object.fromEntries([...output.matchAll(/^(?:# |ℹ )(tests|pass|fail|skipped) (\d+)/gm)].map(m=>[m[1],Number(m[2])]));
    const summary = {name,status:result.status===0?"PASS":"FAIL",exitCode:result.status,durationMs:Date.now()-start,...counts,error:result.error?.code||null};
    results.push(summary);
    fs.writeFileSync(path.join(__dirname,"test-results.json"),JSON.stringify(results,null,2));
    console.log(JSON.stringify(summary));
    if(result.status!==0) console.log(output.slice(-1600));
  }
  if(process.argv[2] !== "remaining") {
  for (const [name,folder] of [["core","packages/core/dist"],["api","apps/api/dist"],["worker","apps/worker/dist"]]) {
    const files=fs.readdirSync(path.join(ROOT,folder)).filter(f=>f.endsWith(".test.js")).map(f=>path.join(ROOT,folder,f));
    run(name,["--test",...files]);
  }
  run("preflight",["--test","scripts/preflight-contract.test.cjs"]);
  const npmCli = [process.env.npm_execpath,path.join(path.dirname(process.execPath),"node_modules/npm/bin/npm-cli.js")].find(p=>p&&fs.existsSync(p));
  if (npmCli) run("module-runner",["--test","scripts/test-module.test.cjs"],ROOT,{...isolatedEnvironment(process.env,"security"),npm_execpath:npmCli});
  else console.log("module-runner: invoke npm run test:module:runner separately (npm CLI unavailable to this harness)");
  }
  for(const name of ["everest-browser","compensa-browser","ufg-browser"]) {
    const plan=MODULES[name];
    run(name,["--test",...plan.files.map(f=>path.resolve(ROOT,f))],path.resolve(ROOT,plan.testCwd),isolatedEnvironment(process.env,name));
  }
  for(const name of ["security-browser","tool-grants-ui","admin-ui","history-ui","review-ui","audit-ui","run-submission-ui","w3-sms-ui","w4-enrichment-ui"]) {
    run(name,[__filename,"ui",`${name}-smoke.cjs`]);
  }
  process.exitCode=results.some(r=>r.status!=="PASS")?1:0;
}
