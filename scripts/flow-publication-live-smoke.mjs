import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

// Run only from a protected GitHub Environment, never in a public client.
const REF='nmhefwvhoholcjrbbila';
const PIN='f37a8be7800e1c47d7e3c0db4ab69e612e3f4cc9';
const ORIGIN='https://hsnq2022022-cyber.github.io';
const FN='flow-publication';
const BASE='https://'+REF+'.supabase.co';
const MGMT='https://api.supabase.com/v1/projects/'+REF+'/functions/';
const FILE=resolve('.flowtest-run-state.json');
const mode=process.argv[2]||'run';
const source=resolve('pinned-source');
const cfg=process.env;
const requireOk=(v,m)=>{if(!v)throw Error(m)};
for(const k of ['SUPABASE_ACCESS_TOKEN','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_ANON_KEY','SUPABASE_JWT_SECRET'])
 requireOk(cfg[k],'Missing protected secret: '+k);
requireOk(cfg.GITHUB_ACTIONS==='true'&&cfg.GITHUB_REPOSITORY==='hsnq2022022-cyber/milanochat'&&
 cfg.GITHUB_REF==='refs/heads/review/flow-publication-security-gates','Wrong GitHub Actions repo or branch');
const state=existsSync(FILE)?JSON.parse(readFileSync(FILE,'utf8')):
 {allowDelete:false,success:false,users:[],tenants:[],accounts:[]};
function save(){writeFileSync(FILE,JSON.stringify(state),{mode:0o600})}
async function request(url,options={}){
 const res=await fetch(url,{method:options.method||'GET',headers:options.headers||{},
  body:options.body===undefined?undefined:JSON.stringify(options.body),signal:AbortSignal.timeout(12000)});
 const body=await res.text();let data;
 try{data=JSON.parse(body)}catch{data=null}
 return {status:res.status,data,headers:res.headers};
}
const auth=(p,method,body,admin=true)=>{
 const k=admin?cfg.SUPABASE_SERVICE_ROLE_KEY:cfg.SUPABASE_ANON_KEY;
 return request(BASE+'/auth/v1/'+p,{method,body,headers:{apikey:k,authorization:'Bearer '+k,
  'content-type':'application/json'}});
};
const rest=(table,method='GET',query='',body)=>{
 const k=cfg.SUPABASE_SERVICE_ROLE_KEY;
 return request(BASE+'/rest/v1/'+table+query,{method,body,headers:{apikey:k,
  authorization:'Bearer '+k,'content-type':'application/json',prefer:'return=representation'}});
};
const functionInfo=async(slug)=>{
 const r=await request(MGMT+slug,{headers:{authorization:'Bearer '+cfg.SUPABASE_ACCESS_TOKEN}});
 if(r.status===404)return null;
 requireOk(r.status===200,'Cannot inspect function '+slug+': HTTP '+r.status);
 return r.data;
};
const invoke=(token,body)=>request(BASE+'/functions/v1/'+FN,{method:'POST',body,
 headers:{origin:ORIGIN,apikey:cfg.SUPABASE_ANON_KEY,'content-type':'application/json',
  ...(token?{authorization:'Bearer '+token}:{})}});
async function flags(){
 const [global,tenant,active,outbox,milan]=await Promise.all([
 rest('automation_flow_global_switch','GET','?select=enabled&singleton=eq.true'),
 rest('automation_flow_tenant_switches','GET','?select=tenant_id&enabled=eq.true'),
 rest('automation_flow_activations','GET','?select=tenant_id&is_active=eq.true'),
 rest('automation_flow_outbox','GET','?select=id&limit=1'),functionInfo('milan-api')
 ]);
 requireOk([global,tenant,active,outbox].every(x=>x.status===200&&Array.isArray(x.data)),
  'Cannot verify kill switches');
 requireOk(global.data.length===1&&global.data[0].enabled===false&&
  tenant.data.length===0&&active.data.length===0&&outbox.data.length===0,'Safety gates not OFF');
 requireOk(milan?.status==='ACTIVE'&&milan.version===101,'milan-api is not ACTIVE v101');
 console.log('PASS: global OFF; enabled tenants=0; active flows=0; outbox=0; milan-api=101');
}
function checkSigning(){
 const parts=cfg.SUPABASE_ANON_KEY.split('.');
 requireOk(parts.length===3,'Legacy anon JWT required');
 const mac=createHmac('sha256',cfg.SUPABASE_JWT_SECRET).update(parts[0]+'.'+parts[1]).digest();
 const signature=Buffer.from(parts[2],'base64url');
 requireOk(mac.length===signature.length&&timingSafeEqual(mac,signature),
  'JWT secret does not match legacy anon signing key');
 console.log('PASS: JWT signing secret matches legacy anon token (values hidden)');
}
function expiredJwt(user){
 const now=Math.floor(Date.now()/1000);
 const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
 const payload=Buffer.from(JSON.stringify({sub:user,role:'authenticated',
  aud:'authenticated',iss:BASE+'/auth/v1',iat:now-600,exp:now-60})).toString('base64url');
 const input=header+'.'+payload;
 return input+'.'+createHmac('sha256',cfg.SUPABASE_JWT_SECRET).update(input).digest('base64url');
}
function pinned(){
 const git=spawnSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'});
 requireOk(git.status===0&&git.stdout.trim()===PIN,'Pinned source SHA mismatch');
 const code=readFileSync(resolve(source,'supabase/functions/flow-publication/index.ts'),'utf8');
 const toml=readFileSync(resolve(source,'supabase/config.toml'),'utf8');
 requireOk(code.includes('APPROVED_ORIGIN="'+ORIGIN+'"')&&
  code.includes('"flow_publication_rate_allow"')&&
  code.includes('env("SUPABASE_SERVICE_ROLE_KEY")')&&
  code.includes('testCanaryArmed(env("FLOW_PUBLICATION_CANARY_READY")')&&
  /\[functions\.flow-publication\]\s*verify_jwt\s*=\s*true/.test(toml),
  'Approved source security guard mismatch');
 console.log('PASS: pinned source + exact Origin + verify_jwt=true + canary guard');
}
async function deployed(){
 const f=await functionInfo(FN);
 requireOk(f?.status==='ACTIVE'&&f?.verify_jwt===true,
  'Deployed flow-publication must be ACTIVE and verify_jwt=true');
 console.log('PASS: deployed '+FN+' version='+f.version+' verify_jwt=true');
}
async function make(label,id){
 const email='flowtest-'+label+'-'+id+'@example.com';
 const password=randomBytes(32).toString('base64url');
 const u=await auth('admin/users','POST',{email,password,email_confirm:true,
  app_metadata:{flow_test_run:id,flow_test_label:label}});
 requireOk([200,201].includes(u.status),'Admin create user '+label+': HTTP '+u.status);
 const uid=u.data?.id||u.data?.user?.id;
 requireOk(typeof uid==='string','Admin response missing user ID');
 state.users.push(uid);save();
 const login=await auth('token?grant_type=password','POST',{email,password},false);
 requireOk(login.status===200&&typeof login.data?.access_token==='string',
  'Login '+label+': HTTP '+login.status);
 const t=await rest('tenants','POST','',{user_id:uid,
  business_name:'flowtest-'+label+'-'+id,source_type:'manual',
  credits_remaining:0,is_active:true});
 requireOk([200,201].includes(t.status)&&t.data?.[0]?.id,'Tenant create '+label+': HTTP '+t.status);
 const tid=t.data[0].id;state.tenants.push(tid);save();
 const platform=label==='a'?'instagram':'facebook';
 const a=await rest('channel_accounts','POST','',{tenant_id:tid,platform,
  channel:platform,account_name:'flowtest-'+label+'-'+id,
  platform_account_id:'flowtest-'+label+'-'+id,is_active:true,agent_enabled:true,auto_reply:true});
 requireOk([200,201].includes(a.status)&&a.data?.[0]?.id,
  'Channel account create '+label+': HTTP '+a.status);
 state.accounts.push(a.data[0].id);save();
 console.log('CREATE flowtest-'+label+': 1 user, 1 tenant, 1 channel account (no Meta token)');
 return {uid,tid,account:a.data[0].id,token:login.data.access_token};
}
function expect(r,status,description){
 requireOk(r.status===status,description+' expected '+status+' got '+r.status);
 console.log('PASS: '+description+' => HTTP '+status);
}
async function smoke(a,b){
 expect(await invoke(null,{action:'accounts'}),401,'missing JWT');
 expect(await invoke(expiredJwt(a.uid),{action:'accounts'}),401,'signed expired JWT');
 const ownB=await invoke(b.token,{action:'accounts'});
 expect(ownB,200,'B authenticated');
 requireOk(ownB.data?.ok===true&&ownB.data.accounts?.some(x=>x.id===b.account),'B account not visible');
 for(const action of ['publish','activate','deactivate']){
  expect(await invoke(a.token,{action,tenantId:b.tid,accountId:b.account,
   flowKey:'flowtest_b',revision:1,document:{version:3,nodes:[],edges:[]}}),
   403,'A forbidden '+action+' on B');
 }
 expect(await invoke(b.token,{action:'activate',accountId:b.account,
  flowKey:'flowtest_b',revision:1}),423,'Canary OFF');
 let rateLimit=false;
 for(let i=0;i<33;i++){
  const r=await invoke(a.token,{action:'accounts'});
  if(r.status===429){
   requireOk(i===27,'429 must occur on A request #31 (after 3 denied + 27 accepted)');
   requireOk(r.headers.has('retry-after'),'429 missing Retry-After');
   rateLimit=true;break;}
  requireOk(r.status===200,'A request before rate limit: HTTP '+r.status);
 }
 requireOk(rateLimit,'A never received HTTP 429');
 const counter=await rest('flow_publication_rate_windows','GET',
  '?select=request_count&tenant_id=eq.'+a.tid);
 requireOk(counter.status===200&&counter.data?.length===1&&counter.data[0].request_count===30,
  'A atomic rate counter must be exactly 30');
 console.log('PASS: A request #31 => HTTP 429; atomic counter=30');
 expect(await invoke(b.token,{action:'accounts'}),200,'B unaffected by A limit');
 const pub=await rest('automation_flow_publications','GET','?select=revision&tenant_id=eq.'+b.tid);
 requireOk(pub.status===200&&pub.data.length===0,'Unexpected B publications');
 console.log('PASS: no test publication, no activation, no real messages');
}
async function deleteFunction(){
 if(!state.allowDelete)return;
 const f=await functionInfo(FN);
 if(!f)return;
 console.error('EMERGENCY STOP: deleting newly deployed '+FN);
 const r=await request(MGMT+FN,{method:'DELETE',
  headers:{authorization:'Bearer '+cfg.SUPABASE_ACCESS_TOKEN}});
 if([200,204,404].includes(r.status)){console.log('EMERGENCY STOP: management delete accepted');return;}
 const fallback=spawnSync('supabase',['functions','delete',FN,'--project-ref',REF],
  {cwd:source,env:cfg,stdio:'inherit'});
 requireOk(fallback.status===0,'EMERGENCY STOP FAILED: manual function deletion required');
 console.log('EMERGENCY STOP: CLI delete accepted');
}
async function remove(table,ids){
 if(!ids.length)return;
 const r=await rest(table,'DELETE','?id=in.('+ids.join(',')+')');
 requireOk(r.status===200&&Array.isArray(r.data),'Cleanup '+table+': HTTP '+r.status);
 console.log('CLEANUP '+table+': '+r.data.length+' deleted');
}
async function reconcileFixtureIds(){
 if(!state.runId)return;
 // Recover committed rows even if a create request timed out before its ID
 // reached the runner. Exact run-scoped names prevent deleting customer rows.
 for(const label of ['a','b']){
  const name='flowtest-'+label+'-'+state.runId;
  for(const [table,column,field] of [
   ['tenants','business_name','tenants'],
   ['channel_accounts','account_name','accounts']
  ]){
   const res=await rest(table,'GET','?select=id&'+column+'=eq.'+encodeURIComponent(name));
   requireOk(res.status===200&&Array.isArray(res.data),'Cannot reconcile '+table);
   for(const row of res.data)if(!state[field].includes(row.id)){state[field].push(row.id);save();}
  }
 }
 let page=1;
 for(;page<=50;page++){
  const res=await auth('admin/users?page='+page+'&per_page=100','GET');
  requireOk(res.status===200&&Array.isArray(res.data?.users),'Cannot enumerate test Auth users for cleanup');
  for(const user of res.data.users){
   if(user.app_metadata?.flow_test_run===state.runId &&
      ['a','b'].includes(user.app_metadata.flow_test_label) &&
      !state.users.includes(user.id)){state.users.push(user.id);save();}
  }
  if(res.data.users.length<100)break;
 }
 requireOk(page<=50,'Could not exhaust Auth user pages during cleanup');
}
async function cleanup(){
 const errors=[];
 try{await reconcileFixtureIds();}catch(e){errors.push('reconciliation: '+e.message);}

 for(const [name,run] of [
  ['accounts',()=>remove('channel_accounts',state.accounts)],
  ['rate windows',async()=>{
   for(const id of state.tenants){
    const r=await rest('flow_publication_rate_windows','DELETE','?tenant_id=eq.'+id);
    requireOk(r.status===200&&Array.isArray(r.data),'Rate rows DELETE HTTP '+r.status);
    console.log('CLEANUP rate windows: '+r.data.length+' deleted');
   }
  }],
  ['tenants',()=>remove('tenants',state.tenants)],
  ['users',async()=>{
   for(const uid of state.users){
    const r=await auth('admin/users/'+uid,'DELETE',undefined);
    requireOk([200,204,404].includes(r.status),'Auth DELETE HTTP '+r.status);
    console.log('CLEANUP Auth user: deleted');
   }
  }],
  ['verification',async()=>{
   for(const id of state.tenants){
    const r=await rest('tenants','GET','?select=id&id=eq.'+id);
    requireOk(r.status===200&&r.data.length===0,'Fixture tenant remains');
   }
   for(const id of state.accounts){
    const r=await rest('channel_accounts','GET','?select=id&id=eq.'+id);
    requireOk(r.status===200&&r.data.length===0,'Fixture account remains');
   }
   for(const id of state.users){
    const r=await auth('admin/users/'+id,'GET');
    requireOk(r.status===404,'Fixture Auth user remains');
   }
  }]
 ])try{await run()}catch(e){errors.push(name+': '+e.message);console.error('CLEANUP FAILED '+name+': '+e.message);}
 if(errors.length)throw Error('Incomplete cleanup: '+errors.join('; '));
 state.accounts=[];state.tenants=[];state.users=[];save();
 console.log('PASS: all recorded fixtures removed');
}
async function recover(){
 const failures=[];
 if(!state.success)try{await deleteFunction()}catch(e){failures.push('stop: '+e.message);}
 try{await cleanup()}catch(e){failures.push(e.message);}
 try{await flags()}catch(e){
  failures.push('final state: '+e.message);
  try{await deleteFunction()}catch(stop){failures.push('emergency stop: '+stop.message);}
 }
 if(!failures.length&&existsSync(FILE))unlinkSync(FILE);
 requireOk(!failures.length,failures.join(' | '));
 console.log('PASS: emergency recovery/cleanup check');
}
async function main(){
 if(mode==='recover'){await recover();return;}
 requireOk(mode==='run','Unknown command');
 requireOk(!existsSync(FILE),'Stale test state exists: refuse new run');
 let fault=null;
 try{
  checkSigning();pinned();await flags();
  requireOk(await functionInfo(FN)===null,'Function already exists; overwrite forbidden');
  const check=await rest('rpc/flow_publication_rate_allow','POST','',
   {p_tenant_id:'00000000-0000-4000-8000-000000000000'});
  requireOk(check.status===200&&check.data===false,'Rate limiter RPC failed preflight');
  state.allowDelete=true;save();
  const d=spawnSync('supabase',['functions','deploy',FN,'--project-ref',REF,'--use-api'],
   {cwd:source,env:cfg,stdio:'inherit'});
  requireOk(d.status===0,'One-function deployment failed');
  await deployed();await flags();
  const id=(cfg.GITHUB_RUN_ID||'run')+'-'+Date.now().toString(36)+'-'+randomBytes(3).toString('hex');
  state.runId=id;save();
  const a=await make('a',id),b=await make('b',id);
  await smoke(a,b);
  await cleanup();await flags();
  state.success=true;save();
  console.log('SUCCESS: flow-publication ACTIVE; real Auth A/B verified; no fixtures');
 }catch(e){
  fault=e;console.error('FAILED: '+e.message);
  try{await deleteFunction()}catch(x){fault=new Error(fault.message+'; stop: '+x.message);}
  try{await cleanup()}catch(x){fault=new Error(fault.message+'; cleanup: '+x.message);}
  try{await flags()}catch(x){fault=new Error(fault.message+'; flags: '+x.message);}
 }
 if(fault)throw fault;
 // Keep the success marker until the separate always() recovery step
 // checks postflight. If that check fails, it must still be able to stop
 // the function installed by this run.
}
try{await main()}catch(e){console.error('FINAL FAILED: '+e.message);process.exitCode=1;}
