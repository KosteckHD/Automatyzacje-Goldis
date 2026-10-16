"use strict";
// Fixed human-authorized scope: physical Excel rows 18000 through 18100.
// One API admission at a time. No status repair, portal bypass, or silent retry.
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const ExcelJS = require("exceljs");
const { Pool } = require("pg");
const { ROW_NUMBERS, TERMINAL, explain, shouldStop, writeReport } = require("./supervised-live-report.cjs");
const { buildAcceptancePortalConfig } = require("./prepare-acceptance-portal-config.cjs");
const root = path.resolve(__dirname, "..");
const directory = path.join(root, "exports/supervised-18000-18100-20261015");
const pausePath = path.join(directory, "PAUSE");
const parseEnv = t => Object.fromEntries(t.split(/\r?\n/).map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim().replace(/^['"]|['"]$/g, "")]));
const delay = ms => new Promise(r=>setTimeout(r,ms));
const safeCode = e => /^[A-Z][A-Z0-9_]{1,100}$/.test(e?.message || "") ? e.message : "SUPERVISED_TEST_ERROR";
const hashFile = async file => createHash("sha256").update(await fs.readFile(file)).digest("hex");
const equalCells = (a,b) => { if (JSON.stringify(a)!==JSON.stringify(b)) throw new Error("ARTIFACT_CELL_MISMATCH"); };

async function main() {
  await fs.mkdir(directory,{recursive:true});
  let lock;
  try { lock=await fs.open(path.join(directory,"runner.lock"),"wx"); }
  catch { throw new Error("SUPERVISED_RUNNER_ALREADY_LOCKED"); }
  const children=[];
  let runtime,pool,api,report;
  let stopping=false;
  const requestStop=()=>{stopping=true;};
  process.once("SIGINT",requestStop); process.once("SIGTERM",requestStop);
  try {
    const env={...process.env,...parseEnv(await fs.readFile(path.join(root,".env.acceptance.local"),"utf8")),APP_ENV:"development",NODE_ENV:"development"};
    if(env.COMPOSE_PROJECT_NAME!=="goldis-acceptance-20261015")throw new Error("ISOLATED_ACCEPTANCE_PROJECT_REQUIRED");
    for(const key of ["DATABASE_URL","MIGRATOR_DATABASE_URL","WORKER_DATABASE_URL"]) {
      const url=new URL(env[key]);
      if(url.hostname!=="127.0.0.1" || url.port!=="52257")throw new Error("ACCEPTANCE_DATABASE_SCOPE_MISMATCH");
    }
    env.GOLDIS_DELETION_JOURNAL_DIR=path.join(root,"exports/live-acceptance/isolated-runtime/deletion-journal");
    const cfgPath=path.join(directory,"portals.json");
    await fs.writeFile(cfgPath,JSON.stringify(await buildAcceptancePortalConfig(),null,2));
    const fingerprint={};
    for(const file of ["apps/worker/dist/portals/compensa/compensa-form.js","apps/worker/dist/features/execution/live-run.js","apps/worker/dist/portals/pzu/everest-identity-provider.js","apps/api/dist/features/results/export.js"])
      fingerprint[file]=await hashFile(path.join(root,file));
    fingerprint.portalConfig=await hashFile(cfgPath);
    try { report=JSON.parse(await fs.readFile(path.join(directory,"report.json"),"utf8")); }
    catch(e){if(e.code!=="ENOENT")throw e;}
    if(report && JSON.stringify(report.fingerprint)!==JSON.stringify(fingerprint))throw new Error("CAMPAIGN_BUILD_CHANGED_NEW_REVISION_REQUIRED");
    if(!report)report={scope:{from:18000,to:18100,count:101},startedAt:new Date().toISOString(),fingerprint,state:"preparing",rows:ROW_NUMBERS.map(rowNumber=>({rowNumber,status:"not_started"}))};
    if(report.stopReason && !process.argv.includes("--after-review"))throw new Error("CAMPAIGN_REVIEW_REQUIRED");
    if(report.stopReason){(report.reviewHistory??=[]).push({at:new Date().toISOString(),stopReason:report.stopReason});delete report.stopReason;}
    await writeReport(directory,report);
    const child=(file,label,overrides={})=>{
      const fd=syncFs.openSync(path.join(directory,label+".log"),"a");
      const p=spawn(process.execPath,[path.join(root,file)],{cwd:root,env:{...env,...overrides},windowsHide:true,stdio:["ignore",fd,fd]});
      syncFs.closeSync(fd);children.push(p);return p;
    };
    const once=async(file,label,overrides)=>{
      const p=child(file,label,overrides);
      await new Promise((resolve,reject)=>{p.once("error",()=>reject(new Error("STARTUP_CHILD_FAILED")));p.once("exit",c=>c===0?resolve():reject(new Error("STARTUP_"+label.toUpperCase()+"_FAILED")));});
      console.log(JSON.stringify({startup:label,ok:true}));
    };
    pool=new Pool({connectionString:env.DATABASE_URL,connectionTimeoutMillis:5000});
    const busy=await pool.query("SELECT count(*)::int AS n FROM automation_runs WHERE status IN ('queued','validating','awaiting_portal_adapter','pzu_login','everest_search','compensa_login','compensa_form','ufg_verification','reading_oc','export_ready','waiting_for_sms')");
    if(busy.rows[0].n)throw new Error("EXISTING_ACTIVE_RUN_REQUIRES_REVIEW");
    await once("apps/api/dist/infrastructure/database/migrate.js","migrations",{DATABASE_URL:env.MIGRATOR_DATABASE_URL});
    await once("apps/api/dist/infrastructure/database/apply-runtime-grants.js","grants",{DATABASE_URL:env.MIGRATOR_DATABASE_URL});
    child("apps/api/dist/import-parser-main.js","parser");
    await delay(800);
    const apiChild=child("scripts/acceptance-api-diagnostics.cjs","api",{GOLDIS_ADMIN_PASSWORD:"",GOLDIS_ADMIN_USER:""});
    let ready=false;
    for(let i=0;i<30&&apiChild.exitCode===null;i++){
      try{ready=(await fetch("http://127.0.0.1:3001/api/health/ready",{signal:AbortSignal.timeout(1500)})).ok;}catch{}
      if(ready)break;await delay(1500);
    }
    if(!ready)throw new Error("ACCEPTANCE_API_NOT_READY");
    let cookie="",csrf="";
    api=async(route,body,method="POST",binary=false)=>{
      const multipart=body instanceof FormData;
      const response=await fetch("http://127.0.0.1:3001/api"+route,{method,headers:{origin:env.PUBLIC_APP_ORIGIN,cookie,"x-csrf-token":csrf,
        ...(body!==undefined&&!multipart?{"content-type":"application/json"}:{})},...(body===undefined?{}:{body:multipart?body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
      if(!response.ok){const e=new Error("ACCEPTANCE_HTTP_"+response.status);e.httpStatus=response.status;throw e;}
      if(response.headers.getSetCookie().length)cookie=response.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ");
      if(binary)return Buffer.from(await response.arrayBuffer());
      const result=await response.json();if(result?.csrfToken)csrf=result.csrfToken;return result;
    };
    const auth=await api("/auth/login",{username:env.GOLDIS_ADMIN_USER,password:env.GOLDIS_ADMIN_PASSWORD});
    if(auth.mustChangePassword)throw new Error("ACCEPTANCE_PASSWORD_CHANGE_REQUIRED");
    if(!report.batchId){
      const original=new ExcelJS.Workbook();await original.xlsx.readFile(path.join(root,"docs/BAZA TRANSPORTOWA.xlsx"));
      const sheet=original.getWorksheet("Realizacja");const input=new ExcelJS.Workbook();const target=input.addWorksheet("Realizacja");
      for(const n of [1,...ROW_NUMBERS])sheet.getRow(n).eachCell((cell,c)=>{target.getRow(n).getCell(c).value=structuredClone(cell.value);});
      const bytes=Buffer.from(await input.xlsx.writeBuffer());
      const parsed=await require("../apps/api/dist/features/imports/workbook.js").parseTransportWorkbook(bytes);
      equalCells(parsed.map(r=>r.rowNumber),ROW_NUMBERS);
      const form=new FormData();form.append("file",new Blob([bytes]),"supervised-18000-18100.xlsx");
      const imported=await api("/imports",form);if(imported.totalRows!==101)throw new Error("IMPORT_SCOPE_COUNT_MISMATCH");
      report.batchId=imported.id;report.inputSha256=imported.sha256;
      await writeReport(directory,report);
    }
    if(!report.preparationId){const p=await api(`/imports/${report.batchId}/preparations`,{idempotencyKey:"supervised-18000-18100-"+report.batchId});report.preparationId=p.preparationId;await writeReport(directory,report);}
    let prepared;
    for(let i=0;i<120;i++){
      prepared=await api(`/imports/${report.batchId}/preparations/${report.preparationId}`,undefined,"GET");
      if(["completed","completed_with_attention","failed","cancelled"].includes(prepared.status))break;
      await delay(1500);
    }
    if(!["completed","completed_with_attention"].includes(prepared.status))throw new Error("PREPARATION_NOT_READY");
    const preparedRows=(await pool.query("SELECT row_number,status,reason_code,representative_row_number FROM import_prepared_rows WHERE preparation_id=$1 ORDER BY row_number",[report.preparationId])).rows;
    if(preparedRows.length!==101)throw new Error("PREPARATION_ROW_COUNT_MISMATCH");
    for(const p of preparedRows){const row=report.rows.find(r=>r.rowNumber===p.row_number);if(row.status!=="not_started")continue;
      row.preparationStatus=p.status;
      if(p.status!=="ready")Object.assign(row,{status:p.status==="duplicate"?"duplicate":"input_review",errorCode:p.reason_code,reason:p.status==="duplicate"?`Duplikat wiersza ${p.representative_row_number}; bez ponownego zapytania do portali.`:explain(p.reason_code)});
    }
    report.state="prepared";await writeReport(directory,report);
    console.log(JSON.stringify({prepared:true,rows:101,summary:report.summary}));
    if(process.argv.includes("--prepare-only"))return;
    // The observed portal notice announced maintenance from 20:00 Warsaw today.
    // Stop admissions 15 minutes earlier; finish only the current bounded run.
    const cutoff=Date.parse("2026-10-15T17:45:00Z");
    if(Date.now()>=cutoff)throw new Error("PORTAL_MAINTENANCE_ADMISSION_CUTOFF");
    await fs.mkdir(env.WORKER_STAGING_DIR,{recursive:true});
    Object.assign(process.env,env,{DATABASE_URL:env.WORKER_DATABASE_URL,REDIS_URL:env.WORKER_REDIS_URL,WORKER_LIVE_PORTALS:"1",WORKER_PORTAL_CONFIG_PATH:cfgPath,WORKER_STAGING_DIR:await fs.realpath(env.WORKER_STAGING_DIR)});
    // Private diagnostics preserve only codes/counts, never credentials or form values.
    const attach=(moduleName,klass,method,describe)=>{
      const type=require(`../apps/worker/dist/${moduleName}.js`)[klass];const original=type.prototype[method];
      type.prototype[method]=async function(...args){try{const result=await original.apply(this,args);const row=report.rows.find(r=>r.runId===args[0]?.run?.runId||r.runId===args[0]);
        if(row){(row.diagnostics??=[]).push({stage:moduleName,...describe(result),at:new Date().toISOString()});await writeReport(directory,report);}return result;
      }catch(e){const row=report.rows.find(r=>r.runId===args[0]?.run?.runId||r.runId===args[0]);if(row){(row.diagnostics??=[]).push({stage:moduleName,errorCode:safeCode(e),at:new Date().toISOString()});await writeReport(directory,report);}throw e;}};
    };
    attach("everest-identity-provider","EverestIdentityProvider","findIdentity",r=>({kind:r.kind,reason:r.reason}));
    attach("compensa-form","CompensaFormAssistant","prepareInsuredForm",r=>({kind:r.kind,fieldCode:r.fieldCode,errorCode:r.errorCode}));
    attach("compensa-offer-saver","CompensaOfferSaver","saveInsuredData",r=>({kind:r.kind,fieldCode:r.fieldCode,errorCode:r.errorCode}));
    attach("compensa-ufg","CompensaUfgReader","readSnapshot",r=>({kind:r.kind,fieldCode:r.fieldCode,errorCode:r.errorCode}));
    runtime=await require("../apps/worker/dist/run-worker.js").startRunWorker({startPaused:true});
    const context=await runtime.browser.open();
    context.on("response",response=>{if(response.status()!==429)return;const hostname=new URL(response.url()).hostname;
      if(![...runtime.liveConfig.pzu.allowedOrigins,...runtime.liveConfig.compensa.allowedOrigins].some(o=>new URL(o).hostname===hostname))return;
      report.stopReason="PORTAL_HTTP_429";stopping=true;void runtime.worker.pause(true);});
    const maxArg=process.argv.find(a=>/^--max-new=\d+$/.test(a));const maxNew=maxArg?Number(maxArg.split("=")[1]):10;
    if(!Number.isInteger(maxNew)||maxNew<1||maxNew>101)throw new Error("BATCH_SIZE_INVALID");
    await runtime.worker.resume();report.state="running";let processed=0;
    for(const row of report.rows){
      if(row.status!=="not_started")continue;
      if(stopping||syncFs.existsSync(pausePath)||Date.now()>=cutoff||processed>=maxNew)break;
      row.startedAt=new Date().toISOString();
      const run=await api("/runs",{batchId:report.batchId,rowNumber:row.rowNumber});
      Object.assign(row,{runId:run.id,status:run.status,currentStep:run.status,reason:"Zadanie przyjęte przez API."});await writeReport(directory,report);
      console.log(JSON.stringify({rowNumber:row.rowNumber,runId:run.id,event:"started"}));
      const deadline=Date.now()+6*60000;let previous="";
      while(Date.now()<deadline){
        const current=await api(`/runs/${run.id}`,undefined,"GET");Object.assign(row,{status:current.status,currentStep:current.currentStep,errorCode:current.errorCode});
        const stage=JSON.stringify([row.status,row.errorCode]);if(stage!==previous){previous=stage;console.log(JSON.stringify({rowNumber:row.rowNumber,status:row.status,errorCode:row.errorCode}));await writeReport(directory,report);}
        if(TERMINAL.has(row.status))break;
        if(report.stopReason)break;
        await delay(5000);
      }
      await runtime.worker.pause();
      const events=(await pool.query("SELECT status,step,error_code,created_at FROM run_events WHERE run_id=$1 ORDER BY created_at,id",[run.id])).rows;
      row.events=events;row.lastPortalStage=events.filter(e=>["pzu_login","everest_search","compensa_login","compensa_form","ufg_verification","reading_oc","export_ready"].includes(e.step)).at(-1)?.step;
      const diagnosis=row.diagnostics?.filter(d=>d.fieldCode||d.reason||d.errorCode).at(-1);
      row.reason=row.status==="no_matching_policies"?"Odczyt zakończony; żadna polisa nie spełnia filtra daty.":explain(diagnosis?.fieldCode||diagnosis?.errorCode||row.errorCode);
      if(diagnosis?.reason)row.reason+=` Szczegół dopasowania: ${diagnosis.reason}.`;
      if(row.status==="completed"){
        try{
          const frozen=(await pool.query("SELECT input_snapshot,reference_date::text AS reference_date FROM automation_runs WHERE id=$1",[run.id])).rows[0];
          const identity=(await pool.query("SELECT source_row_id,pesel_ciphertext,pesel_key_version FROM run_identities WHERE run_id=$1",[run.id])).rows[0];
          const core=require("@goldis/core");const pesel=core.decryptPesel({ciphertext:identity.pesel_ciphertext,keyVersion:identity.pesel_key_version},{runId:run.id,sourceRowId:identity.source_row_id});
          const all=(await pool.query("SELECT *,coverage_from::text AS coverage_from,coverage_to::text AS coverage_to FROM oc_policies WHERE run_id=$1 ORDER BY source_ordinal",[run.id])).rows;
          const snapshot=(await pool.query("SELECT total_count FROM oc_snapshots WHERE run_id=$1",[run.id])).rows[0];
          if(!snapshot||snapshot.total_count!==all.length)throw new Error("SNAPSHOT_COUNT_MISMATCH");
          const selected=all.filter(p=>p.coverage_to>=frozen.reference_date);const bytes=await api(`/runs/${run.id}/artifact`,undefined,"GET",true);
          const w=new ExcelJS.Workbook();await w.xlsx.load(bytes);const sheet=w.getWorksheet("Wynik OC");
          if(!sheet||sheet.rowCount!==selected.length+5)throw new Error("ARTIFACT_ROW_COUNT_MISMATCH");
          const literal=v=>/^[=+\-@]/.test(v||"")?"'"+v:v??"";const s=frozen.input_snapshot;
          equalCells(sheet.getRow(2).values.slice(1),[s.companyName,s.effectiveRegon,s.decisionMakerName,s.mobile,s.phone,s.email,pesel].map(literal));
          selected.forEach((p,i)=>equalCells(sheet.getRow(i+6).values.slice(1),[i+1,literal(p.insured_name),literal(p.policy_type_and_number),literal(p.contract_type),p.insured_claim_count,literal(p.vehicle_registration),literal(p.vehicle_group),literal(p.vehicle_make),literal(p.vehicle_model),literal(p.insurer),p.coverage_from||"",p.coverage_to]));
          for(const step of ["compensa_start_intent","compensa_offer_draft_open","compensa_insured_data_saved","ufg_verification_intent"])
            if(events.filter(e=>e.step===step).length!==1)throw new Error("PORTAL_ACTION_COUNT_MISMATCH");
          const filename=`wynik-${row.rowNumber}.xlsx`;await fs.writeFile(path.join(directory,filename),bytes);
          Object.assign(row,{artifactFile:filename,artifactVerified:true,totalOcCount:all.length,exportedPolicyCount:selected.length,reason:"Pełny przebieg automatu i pobrany Excel zgodny z bazą; sprawdzono wszystkie komórki.",referenceDate:frozen.reference_date});
        }catch(e){row.status="verification_failed";row.errorCode=safeCode(e);row.reason="Wynik zapisany, lecz weryfikacja eksportu nie przeszła: "+row.errorCode;}
      }
      row.finishedAt=new Date().toISOString();row.durationSeconds=Math.round((Date.parse(row.finishedAt)-Date.parse(row.startedAt))/1000);processed++;
      if(!TERMINAL.has(row.status)&&row.status!=="verification_failed")report.stopReason="ROW_TIMEOUT_OR_NONTERMINAL_STATE";
      if(shouldStop(row))report.stopReason="REVIEW_ROW_"+row.rowNumber+"_"+(row.errorCode||row.status);
      if(row.status!=="completed"&&row.status!=="no_matching_policies"&&runtime.browser){
        for(const portal of ["pzu","compensa"]){const p=await runtime.browser.page(portal);await p.screenshot({path:path.join(directory,`${row.rowNumber}-${portal}.png`)}).catch(()=>{});}
      }
      await writeReport(directory,report);console.log(JSON.stringify({rowNumber:row.rowNumber,event:"finished",status:row.status,errorCode:row.errorCode,exportedPolicyCount:row.exportedPolicyCount,stopReason:report.stopReason}));
      if(report.stopReason||stopping)break;
      await delay(3000);await runtime.worker.resume();
    }
    report.state=report.stopReason?"paused_for_review":report.rows.some(r=>r.status==="not_started")?"batch_complete":"finished";
  }catch(e){if(report){report.stopReason=safeCode(e);report.state="paused_for_review";}console.error(safeCode(e));process.exitCode=1;
  }finally{
    if(runtime)await runtime.shutdown();
    if(api)await api("/auth/logout",{}).catch(()=>{});
    for(const p of children)if(p.exitCode===null)p.kill();
    if(pool)await pool.end();
    if(report){await writeReport(directory,report);console.log(JSON.stringify({reportSaved:true,state:report.state,summary:report.summary,stopReason:report.stopReason}));}
    await lock.close();await fs.unlink(path.join(directory,"runner.lock"));
  }
}
if(require.main===module)main().catch(e=>{console.error(safeCode(e));process.exitCode=1;});
