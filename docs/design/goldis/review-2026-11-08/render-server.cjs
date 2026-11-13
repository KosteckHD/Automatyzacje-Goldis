const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');
const out = __dirname;
const root = path.resolve(out, '../../../..');
const fixturePath = path.join(root,'docs/design/goldis/implemented-chat-2026-10-11/capture-review-2026-10-12.cjs');
const old = fs.readFileSync(fixturePath,'utf8');
const fixtures = new Function('require','__dirname', old.slice(0,old.indexOf('async function freePort'))+'\nreturn {responseFor,userFor,importId,runId,resultSetId,leads};')(require,path.dirname(fixturePath));
// Current API contract; these corrections affect synthetic data only.
for (const lead of fixtures.leads) Object.assign(lead, { resultStatus:'ready', assignmentVersion:1, canReleaseAssignment:true, sourceImportDeleted:false, snapshots:[{runId:fixtures.runId,referenceDate:'2026-10-10',policyCount:4}] });
const nextPort = 4177, port=4178;
const next = spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(nextPort)],{cwd:path.join(root,'apps/web'),windowsHide:true,stdio:['ignore',fs.openSync(path.join(out,'render-next.log'),'a'),fs.openSync(path.join(out,'render-next.log'),'a')]});
const commissionId='commission-demo-run';
const versions=[{dictionaryVersionId:'demo-v1',versionNumber:1,status:'published',isActive:true,revision:1,entryCount:2,createdAt:'2026-11-01T08:00:00Z'}];
const files=['CRM','ASF','WARTA'].map((type,i)=>({fileId:'demo-file-'+i,sourceType:type,fileName:type+'-listopad-demo.xlsx',sha256:'a'.repeat(64),sizeBytes:18000,validationState:'valid',uploadedAt:'2026-11-08T08:00:00Z'}));
const run={runId:commissionId,startDate:'2026-11-01',endDate:'2026-11-08',status:'completed_with_findings',progressStage:'completed',counters:{policies:85,missing_policies:3,wrong_rate_rows:2},errorCode:null,createdAt:'2026-11-08T08:00:00Z',dictionaryVersionId:'demo-v1'};
function json(res,status,body){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));}
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1:'+port);const cookie=Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')));
 const role=cookie.reviewRole==='none'?null:cookie.reviewRole||'manager';const state=cookie.reviewState||'normal';
 if(url.pathname==='/__review/setup'){res.writeHead(302,{'set-cookie':['reviewRole='+(url.searchParams.get('role')||'manager')+'; Path=/; SameSite=Lax','reviewState='+(url.searchParams.get('state')||'normal')+'; Path=/; SameSite=Lax'],'location':url.searchParams.get('path')||'/dashboard'});res.end();return;}
 if(url.pathname.startsWith('/api/')){
  fs.appendFileSync(path.join(out,'render-api.log'),req.method+' '+url.pathname+'\n');
  if(state==='error'&&!url.pathname.startsWith('/api/auth')&&!url.pathname.includes('interventions'))return json(res,503,{message:'Usługa jest chwilowo niedostępna. Spróbuj ponownie.'});
  if(url.pathname==='/api/auth/me'){const me=role?fixtures.userFor(role):null;if(me){me.tenantId='demo-tenant';me.tools.push({toolId:'commission-comparison',canDiscover:true,canExecute:true,canViewResults:true,canDownloadResults:true});}return json(res,role?200:401,me||{message:'Unauthenticated'});}
  if(url.pathname==='/api/tools'){const [s,b]=fixtures.responseFor(url.pathname,url,req.method,role,req);b.items.push({toolId:'commission-comparison',displayName:'Porównywarka prowizji',description:'Sprawdź kompletność rozliczeń ASF i Warty.',status:'available',access:{canExecute:true,canViewResults:true,canDownloadResults:true}});return json(res,s,b);}
  if(url.pathname.startsWith('/api/tools/commission-comparison')){
   const sub=url.pathname.replace('/api/tools/commission-comparison','');
   if(sub==='/files')return json(res,200,{items:state==='empty'?[]:files});
   if(sub==='/dictionary/versions')return json(res,200,{items:state==='empty'?[]:versions,canEdit:role==='manager'});
   if(sub==='/dictionary/versions/demo-v1')return json(res,200,{preset:{client_dictionary:{entries:['PZU','Warta'].map((tu,i)=>({id:'e'+i,tu,risk:'OC komunikacyjne',variant:'Nowy',notes:'',agents:{Ola:{status:'RATE',rate:12},Maciek:{status:'RATE',rate:10}}}))}}});
   if(sub==='/runs')return json(res,200,req.method==='POST'?{runId:commissionId}:{items:state==='empty'?[]:[run]});
   if(sub==='/runs/'+commissionId)return json(res,200,{run:{...run,start:run.startDate,end:run.endDate,progress:'completed'},result:{summary:{policies:85,matched_policies:80,missing_policies:3,wrong_rate_rows:2},issues:[{kind:'BLEDNY_PROCENT',insurer:'Warta',number:'DEMO/001',report_number:'DEMO/001',customer:'Firma demonstracyjna',issued:'2026-11-03',agent:'Ola',risk:'OC',actual_rate:8,expected_rate:12,file:'ASF-listopad-demo.xlsx',sheet:'Rozliczenie',row:3}],unresolved:[],policies:[],reverse_audit:{rows:[],note:''},warnings:[],assumptions:[]}});
  }
  if(url.pathname.endsWith('/rows/search')){const [_,rows]=fixtures.responseFor('/api/imports/'+fixtures.importId+'/rows',url,'GET',role,req);return json(res,200,{rows,total:3,counts:{matching:3,ready:1,review:2,all:3}});}
  const [status,body]=fixtures.responseFor(url.pathname,url,req.method,role,req);
  if(url.pathname==='/api/leads'){
   let items=body.items;
   if(url.searchParams.get('scope')==='mine')items=items.filter(item=>item.assignedToUserId===fixtures.userFor(role).userId);
   if(url.searchParams.get('scope')==='unassigned')items=items.filter(item=>!item.assignedToUserId);
   if(url.searchParams.get('search'))items=items.filter(item=>item.company.toLowerCase().includes(url.searchParams.get('search').toLowerCase()));
   if(url.searchParams.get('contactStatus'))items=items.filter(item=>item.contactStatus===url.searchParams.get('contactStatus'));
   if(state==='empty')items=[];
   body.items=items;body.previousCursor=null;body.summary={scopeTotal:items.length,matchingTotal:items.length,byContactStatus:{not_contacted:items.filter(x=>x.contactStatus==='not_contacted').length,offer_accepted:items.filter(x=>x.contactStatus==='offer_accepted').length,not_interested:items.filter(x=>x.contactStatus==='not_interested').length},checkedAt:'2026-11-08T12:00:00Z'};
  }
  if(state==='empty'&&body&&Array.isArray(body.items))body.items=[];
  return json(res,status,body);
 }
 const proxy=http.request({hostname:'127.0.0.1',port:nextPort,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});proxy.on('error',e=>{res.writeHead(503);res.end('Next starting: '+e.message)});req.pipe(proxy);
});
server.listen(port,'127.0.0.1',()=>{fs.writeFileSync(path.join(out,'render-server.json'),JSON.stringify({pid:process.pid,nextPid:next.pid,port,nextPort,url:'http://127.0.0.1:'+port,startedAt:new Date().toISOString(),stop:'Stop-Process -Id '+process.pid+','+next.pid},null,2));console.log('READY http://127.0.0.1:'+port+' pid='+process.pid+' nextPid='+next.pid);});
process.on('SIGTERM',()=>{next.kill();server.close();});

