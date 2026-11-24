// Activation generations (20261123100000): static checks always run;
// behavioural checks run against a THROWAWAY local PostgreSQL cluster
// (temporary data dir, unix socket only, listen_addresses='', removed after)
// when PostgreSQL server binaries are present. Never connects to any remote
// host or connection string.
//
// Each hazard scenario runs twice: on "pre" (the chain WITHOUT the migration:
// production behaviour today, the bug) and on "gen" (with the migration).
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const M="supabase/migrations/";
const MIG=M+"20261123100000_flow_activation_generation.sql";
const RB="supabase/rollbacks/20261123100000_flow_activation_generation.rollback.sql";
const src=f=>readFileSync(f,"utf8");
const md5=x=>createHash("md5").update(x).digest("hex");

// Original (production-verified) and patched md5(prosrc) of the nine patched functions.
const PATCHED={
 "flow_activate_revision(uuid,uuid,text,text,bigint,uuid)":["365673115a22b53c61535152c37c78f8","79c77d2c234ac7587368bd531624d814"],
 "flow_apply_internal_effect(uuid,uuid)":["fa8c86694f1c74dd10b1679b7ac0a237","1cdecb73a8a58653148f3e6e9b10d558"],
 "flow_claim_comment_reply(uuid,uuid,integer)":["dd1eca86c5daab73e142d9e07ab7fc61","46254136151d521bd9d09cd8d806cf7c"],
 "flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamp with time zone,jsonb,text,uuid)":["aa304ad2f783a1c202a06693ac250e0e","1f4d180ae46a04109fafc9b79d816761"],
 "flow_expire_waiting_runs(integer,integer)":["4397b9588093462f6833b87ac217edce","10b694c49d36b8e1bf37c780c8c0515a"],
 "flow_lease_due_runs(integer)":["130bba5dd3c48c1e16398d921e53c6af","e17a10af729565b8f74118bbedd3b47f"],
 "flow_reserve_outbox_delivery(uuid,uuid)":["0ca73aa826e2088dffd8879964c6ee47","3cb82569c3a58f13cfa757bda9fa69df"],
 "flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamp with time zone,jsonb)":["971af0ec215a68a2281ac8791194edf4","d43909cbd21acae85df7649158f71255"],
 "flow_skip_blocked_outbox(integer,integer)":["b19044e4c14f6d7b03c03d4b021a81f2","ef5a3251738c0636512a41e4f3932f98"]
};

// ---------------------------------------------------------------- static
test("migration/rollback exist, are review-only and additive",()=>{
 const mig=src(MIG),rb=src(RB);
 assert.match(mig,/^-- REVIEW ONLY:/);
 assert.match(rb,/^-- REVIEW ONLY rollback/);
 assert.doesNotMatch(mig,/\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION|TRIGGER)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
 assert.doesNotMatch(mig,/cron\.schedule|vault\.|net\.http_|SECURITY DEFINER|TO\s+(anon|authenticated)\b/i);
 assert.match(mig,/^BEGIN;\nSET LOCAL lock_timeout='3s';/m);
 assert.match(rb,/^BEGIN;\nSET LOCAL lock_timeout='3s';/m);
 for(const [sig,[orig,patched]] of Object.entries(PATCHED)){
  assert.ok(mig.includes(`'${orig}'`),`${sig}: original hash in migration`);
  assert.ok(mig.includes(`'${patched}'`),`${sig}: patched hash in migration`);
  assert.ok(rb.includes(`'${orig}'`)&&rb.includes(`'${patched}'`),`${sig}: both hashes in rollback`);
 }
});
test("run creators are NOT redefined (production bodies differ from the repository)",()=>{
 const mig=src(MIG);
 assert.doesNotMatch(mig,/CREATE OR REPLACE FUNCTION public\.flow_(begin|claim)_/);
 assert.doesNotMatch(mig,/flow_begin_durable_run\(|flow_begin_comment_run\(/);
});

// ---------------------------------------------------------------- runbook and guards (static)
const DOC="docs/ACTIVATION_GENERATION_DEPLOYMENT.md";
const walk=(d,out=[])=>{
 let ents=[];try{ents=readdirSync(d,{withFileTypes:true});}catch{return out;}
 for(const e of ents){
  if(e.name==="node_modules"||e.name===".git")continue;
  const f=join(d,e.name);
  if(e.isDirectory())walk(f,out);else if(/\.(sql|ts|tsx|js|mjs|md|ya?ml|sh)$/.test(e.name))out.push(f);
 }
 return out;
};
test("runbook: migration first and last, verified between steps, reverse order for rollback; production source + change, never HEAD; hashes equal the migration's",async()=>{
 const doc=src(DOC),mig=src(MIG),rb=src(RB);
 const at=(h,from=0)=>{const i=doc.indexOf(h,from);assert.ok(i>=0,h);return i;};
 const steps=["## 0. Preconditions","## 1. Apply the migration","## 2. Verify (read only) before any TypeScript is deployed","## 3. Deploy the TypeScript","## 4. Smoke tests and runtime verification","## Rollback (reverse order) and recovery"];
 const idx=steps.map(h=>at(h));
 assert.deepEqual(idx,[...idx].sort((a,b)=>a-b),"sections are in order: preconditions, migration, verify, TypeScript, smoke, rollback");
 const rbSec=doc.slice(idx[5]);
 const r1=rbSec.indexOf("1. Redeploy the **saved production bundles**"),r2=rbSec.indexOf("2. Confirm in the function logs"),r3=rbSec.indexOf("3. `psql"),r4=rbSec.indexOf("4. `supabase migration repair --status reverted");
 assert.ok(r1>=0&&r1<r2&&r2<r3&&r3<r4,"rollback: previous TypeScript -> verify no reader -> rollback SQL -> ledger + verify");
 assert.match(doc,/\*\*The database moves first and last\.\*\*/);
 assert.match(doc,/\*\*Deploy the production source plus this change, never this repository's HEAD\.\*\*/);
 // The consumers named in the runbook are exactly the functions that import the shared predicate, in the script too.
 const importers=new Set(walk("supabase/functions").filter(f=>!f.endsWith(".test.ts")&&src(f).includes("_shared/activationGeneration.ts"))
  .map(f=>f.split("/")[2]));
 assert.deepEqual([...importers].sort(),["flow-internal-worker","flow-outbox-worker","flow-runtime-worker","milan-api"]);
 const {FUNCTIONS}=await import("../scripts/activation-generation-consumers.mjs");
 assert.deepEqual(Object.keys(FUNCTIONS).sort(),[...importers].sort(),"the apply script covers exactly the importing functions");
 const table=doc.slice(at("| Order | Function |"),idx[4]);
 const order=[...table.matchAll(/^\| (\d) \| `([a-z-]+)` \|/gm)].map(x=>[Number(x[1]),x[2]]);
 assert.deepEqual(order.map(x=>x[0]),[1,2,3,4]);
 assert.deepEqual(order.map(x=>x[1]).sort(),[...importers].sort(),"step 3 deploys exactly the importing functions");
 assert.equal(order.at(-1)[1],"milan-api","the ingress goes last");
 const verify=src("scripts/deploy-functions.js");
 for(const f of importers)assert.match(verify,new RegExp(`"${f}": false`),`${f} is verify_jwt=false in the live map`);
 assert.match(doc.slice(idx[3],idx[4]),/`verify_jwt: false`/);
 assert.ok(doc.includes("scripts/activation-generation-consumers.mjs apply --function <slug>"));
 // The ledger has gaps: db push must be forbidden, not instructed.
 assert.match(doc,/\*\*Never run `supabase db push`\*\*/);
 assert.doesNotMatch(doc.replace(/\*\*Never run `supabase db push`\*\*/,""),/^\s*(supabase db push|`supabase db push)/m);
 // Every pinned hash of the migration (original and patched) is in the runbook's queries, and only those.
 const hashes=[...mig.matchAll(/'([0-9a-f]{32})'/g)].map(x=>x[1]);
 assert.equal(new Set(hashes).size,18);
 for(const h of new Set(hashes))assert.ok(doc.includes(`'${h}'`),`runbook has ${h}`);
 const inDoc=new Set([...doc.matchAll(/'([0-9a-f]{32})'/g)].map(x=>x[1]));
 assert.deepEqual([...inDoc].sort(),[...new Set(hashes)].sort());
 // Headers point to the runbook and state the same order.
 for(const [name,t] of [["migration",mig],["rollback",rb]]){
  assert.ok(t.includes(DOC),`${name} header names the runbook`);
  for(const f of importers)assert.ok(t.includes(f),`${name} header names ${f}`);
  assert.match(t,/NOWAIT/,`${name} takes its locks without queueing`);
 }
 assert.match(mig,/APPLY = this migration ->\n-- verify -> the four TypeScript consumers/);
 assert.match(mig,/ROLLBACK = the previous\n-- TypeScript first -> verify -> the rollback SQL/);
 assert.match(rb,/redeploy the previous TypeScript\n-- \(flow-runtime-worker, flow-outbox-worker, flow-internal-worker, milan-api\) FIRST/);
});
test("no code, migration, script, workflow or doc deletes or truncates automation_flow_activations rows (generation reuse guard)",()=>{
 // The generation counter lives on the activation row: a deleted and re-created row would restart at 1.
 const files=["supabase","src","server","scripts",".github","docs"].flatMap(d=>walk(d));
 assert.ok(files.length>200);
 const offenders=[];
 for(const f of files){
  const t=src(f);
  if(/delete\s+from\s+(only\s+)?(public\.)?"?automation_flow_activations\b/i.test(t)
   ||/truncate\s+(table\s+)?(only\s+)?(public\.)?"?automation_flow_activations\b/i.test(t)
   ||/from\(\s*["'`]automation_flow_activations["'`]\s*\)[\s\S]{0,300}?\.delete\s*\(/.test(t))offenders.push(f);
 }
 assert.deepEqual(offenders,[],"deactivate (UPDATE is_active=false) is the only supported way to turn a flow off");
});

// ---------------------------------------------------------------- live PG
function findPgBin(){
 const cands=[];
 if(process.env.PG_BIN)cands.push(process.env.PG_BIN);
 try{for(const v of readdirSync("/usr/lib/postgresql").sort().reverse())
  cands.push(`/usr/lib/postgresql/${v}/bin`);}catch{}
 return cands.find(d=>["initdb","pg_ctl","postgres","psql"].every(b=>existsSync(join(d,b))))??null;
}
const BIN=findPgBin();
const isRoot=typeof process.getuid==="function"&&process.getuid()===0;
const canRunAsPostgres=!isRoot||spawnSync("id",["-u","postgres"]).status===0;
const live=BIN&&canRunAsPostgres;
const skip=live?false:"PostgreSQL server binaries unavailable; static checks only";
let dir,port,started=false;
function asServer(cmd,args){
 return isRoot?spawnSync("runuser",["-u","postgres","--",join(BIN,cmd),...args],{encoding:"utf8"})
  :spawnSync(join(BIN,cmd),args,{encoding:"utf8"});
}
function clientEnv(extra={}){
 const env={};
 for(const [k,v] of Object.entries(process.env))if(!k.startsWith("PG"))env[k]=v;
 return {...env,...extra};
}
const pargs=db=>["-X","-q","-t","-A","-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose",
 "-h",dir,"-p",String(port),"-U","postgres","-d",db];
function psql(db,{file,sql,role}={}){
 const a=pargs(db);
 if(file)a.push("-f",file);
 const input=sql===undefined?undefined:(role?`SET ROLE ${role};\n`:"")+sql;
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input,env:clientEnv(),maxBuffer:1<<26});
}
function psqlAsync(db,sql){
 return new Promise(res=>{
  const t0=Date.now();
  const p=spawn(join(BIN,"psql"),pargs(db),{env:clientEnv()});
  let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
  p.on("close",code=>res({code,out,err,start:t0,end:Date.now()}));p.stdin.end(sql);
 });
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function ok(db,s,label){
 const r=psql(db,s);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return {out:r.stdout.trim(),err:r.stderr};
}
function rows(db,query,role){
 const r=psql(db,{sql:`SELECT '@@'||coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)::text FROM (${query}) x;`,role});
 assert.equal(r.status,0,`${query}\n${r.stderr}`);
 return JSON.parse(r.stdout.split("\n").find(l=>l.startsWith("@@")).slice(2));
}
const val=(db,query,role)=>rows(db,`SELECT (${query}) AS v`,role)[0]?.v;
const sqlState=err=>(err.match(/ERROR:\s+([0-9A-Z]{5}):/)??[])[1];

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC="11111111-1111-4111-8111-111111111111";
const OWNER="99999999-9999-4999-8999-999999999999";
const SR="service_role";
const doc={version:3,name:"two choices",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"choose",image:"",contentBlocks:[],options:[
  {id:"prices",label:"prices"},{id:"support",label:"support"}]}},
 {id:"yes",data:{kind:"message",text:"prices text",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"support text",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},{source:"choose",target:"yes",sourceHandle:"prices"},
  {source:"choose",target:"no",sourceHandle:"support"}]};
const J=o=>`'${JSON.stringify(o).replace(/'/g,"''")}'::jsonb`;
const L=v=>v===null||v===undefined?"NULL":`'${String(v).replace(/'/g,"''")}'`;
const LIVE=`
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN business_name text NOT NULL DEFAULT 'Test Store';
ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,ADD COLUMN auto_reply boolean NOT NULL DEFAULT true,
 ADD COLUMN external_id text,ADD COLUMN access_token_encrypted text;
ALTER TABLE public.conversations ADD COLUMN transferred boolean NOT NULL DEFAULT false,
 ADD COLUMN auto_paused_reason text,ADD COLUMN human_agent_expires_at timestamptz;
ALTER TABLE public.messages ADD COLUMN body_encrypted text,ADD COLUMN external_message_id text;
ALTER TABLE public.automation_flow_tenant_switches
 ADD COLUMN production_approved boolean NOT NULL DEFAULT false;`;
const CHAIN125_300=["20261029125000_flow_durable_button_run","20261029130000_flow_run_lifecycle",
 "20261029140000_flow_outbox_ai_retry","20261029150000_flow_takeover_resume","20261029160000_flow_credits_pause",
 "20261029170000_flow_canary_claim_durable","20261029180000_flow_durable_button_run_guards",
 "20261029190000_flow_begin_durable_run_superseding","20261029210000_flow_media_effects",
 "20261029220000_flow_media_stale_sweep","20261029230000_flow_multichannel_support",
 "20261029300000_comment_replies"].map(n=>M+n+".sql");
// Production-like chain: the production flow_claim_inbound body, the production
// activate/deactivate bodies, and no migration after 20261029330000 (production state).
const CHAIN=["tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
 "tests/sql/flow-exclusive-claim-bootstrap.sql","@LIVE",
 M+"20261028220000_webhook_exclusive_claim.sql",M+"20261028224000_delivery_attempts.sql",
 M+"20261028225000_flow_runtime_advance.sql",M+"20261028226000_flow_outbox_delivery_attempts.sql",
 "tests/sql/flow-staff-membership-bootstrap.sql",M+"20261028227000_tenant_staff_memberships.sql",
 M+"20261028228000_flow_internal_actions.sql",...CHAIN125_300,
 "tests/sql/fixtures/production-flow-claim-inbound.sql",M+"20261029330000_flow_claim_begin_durable_run.sql",
 "tests/sql/fixtures/installed-flow-activation-functions.sql"];
const SEED=`
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by) VALUES
 ('${A}','buttons',1,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${A}','buttons',2,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${A}','other',1,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active) VALUES
 ('${A}','${ACC}','instagram','buttons',1,true);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved)
VALUES('${A}',true,false,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by) VALUES
 ('${A}','${ACC}','instagram','op');
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO service_role;
CREATE TABLE t.e(name text PRIMARY KEY,tenant uuid,acc uuid,conv uuid,msg uuid,mid text);
CREATE FUNCTION t.ev(p_name text,p_conv uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid:=p_conv; m uuid;
BEGIN
 IF c IS NULL THEN
  INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
  VALUES(gen_random_uuid(),'${A}','${ACC}','instagram:'||gen_random_uuid()) RETURNING id INTO c;
 END IF;
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
 VALUES('${A}',c,'in','mid.'||p_name) RETURNING id INTO m;
 INSERT INTO t.e VALUES(p_name,'${A}','${ACC}',c,m,'mid.'||p_name);
END $f$;
-- Fault injection (test databases only): hold a run insert so concurrent writers overlap.
CREATE FUNCTION t.slow() RETURNS trigger LANGUAGE plpgsql AS $s$
BEGIN
 IF current_setting('t.sleep',true)='on' THEN PERFORM pg_catalog.pg_sleep(1.5); END IF;
 RETURN NEW;
END $s$;
CREATE TRIGGER zz_t_slow BEFORE INSERT ON public.automation_flow_runs FOR EACH ROW EXECUTE FUNCTION t.slow();
GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA public TO service_role;
ANALYZE;`;

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-actgen-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+7)%20000);
 let r=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(r.status,0,r.stderr);
 r=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off -c deadlock_timeout=200ms`,"start"]);
 assert.equal(r.status,0,r.stderr+r.stdout);
 started=true;
 ok("postgres",{sql:"CREATE DATABASE base;"},"createdb");
 ok("base",{sql:src("tests/sql/fixtures/flow-live-shape-bootstrap.sql")},"live shape");
 for(const f of CHAIN)ok("base",f==="@LIVE"?{sql:LIVE}:{file:f},f);
 ok("base",{sql:SEED},"seed");
 ok("postgres",{sql:"CREATE DATABASE pre TEMPLATE base;"},"pre");
 ok("postgres",{sql:"CREATE DATABASE gen TEMPLATE base;"},"gen");
 ok("gen",{file:MIG},"migration");
 // Mutation check knobs (never set in CI): revert patched functions to the production body,
 // or apply arbitrary SQL, in the migrated template. The suite must then FAIL.
 for(const sig of (process.env.GEN_MUTANT_FN??"").split(";").filter(Boolean))
  ok("gen",{sql:val("pre",`pg_get_functiondef('public.${sig}'::regprocedure)`)},"mutant "+sig);
 if(process.env.GEN_MUTANT_SQL)ok("gen",{sql:process.env.GEN_MUTANT_SQL},"mutant sql");
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});
let clones=0;
function clone(prefix,template){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},`clone ${db}`);
 return db;
}

// ---- scenario helpers (all DML through service_role, like the workers)
const PAST="2020-01-01T00:00:00Z";
const Q_EFFECT=k=>`[{"kind":"question","idempotencyKey":"q.${k}","payload":{"kind":"question","text":"choose","inputMode":"buttons","choices":["prices","support"],"choiceIds":["prices","support"]}}]`;
const MSG_EFFECT=k=>`[{"kind":"message","idempotencyKey":"m.${k}","payload":{"kind":"message","text":"hello","seq":0}}]`;
const TAG_EFFECT=k=>`[{"kind":"tag","idempotencyKey":"t.${k}","payload":{"kind":"tag","tag":"vip"}}]`;
const DELAY_EFFECT=k=>`[{"kind":"delay","idempotencyKey":"d.${k}","payload":{"kind":"delay","delayMs":1000}}]`;
function mk(db,name,conv=null){
 ok(db,{sql:`SELECT t.ev('${name}',${L(conv)});`},`event ${name}`);
 return rows(db,`SELECT * FROM t.e WHERE name='${name}'`)[0];
}
// Real durable start path (claim + supersede + begin), as milan-api calls it.
function start(db,e,o={}){
 const a={flow:"buttons",rev:1,next:"choose",step:1,status:"awaiting_input",wake:null,effects:Q_EFFECT(e.name),...o};
 return rows(db,`SELECT acquired,run_id FROM public.flow_claim_begin_durable_run(true,${L(e.tenant)},${L(e.acc)},'instagram',`+
  `${L(e.mid)},${L(e.conv)},${L(e.msg)},${L(a.flow)},${a.rev},'start',${L(a.next)},${a.step},${L(a.status)},'{}'::jsonb,`+
  `${a.wake===null?"NULL":L(a.wake)+"::timestamptz"},${L(a.effects)}::jsonb)`,SR);
}
function begin(db,name,o){
 const e=mk(db,name);
 const r=start(db,e,o);
 assert.equal(r.length,1,JSON.stringify(r));
 assert.equal(r[0].acquired,true,JSON.stringify(r));
 return {...e,run:r[0].run_id};
}
const act=(db,rev=1,flow="buttons")=>val(db,`public.flow_activate_revision('${A}','${ACC}','instagram','${flow}',${rev},'${OWNER}')`,SR);
const deact=(db,flow="buttons")=>val(db,`public.flow_deactivate_revision('${A}','${ACC}','instagram','${flow}','${OWNER}')`,SR);
const flip=db=>{assert.equal(deact(db),true);assert.equal(act(db,1),true);};
const actRow=(db,flow="buttons")=>rows(db,`SELECT revision,is_active,activated_at,updated_at,xmin::text AS xmin,
 ${live&&db!=="pre"&&!db.startsWith("pre_")?"activation_generation":"NULL::bigint AS activation_generation"} FROM public.automation_flow_activations
 WHERE tenant_id='${A}' AND flow_key='${flow}'`)[0];
const run=(db,id)=>rows(db,`SELECT run_status,ended_reason,${db.startsWith("pre")?"NULL::bigint AS activation_generation":"activation_generation"} FROM public.automation_flow_runs WHERE id='${id}'`)[0];
const lease=db=>rows(db,`SELECT * FROM public.flow_lease_due_runs(20)`,SR);
const outbox=(db,runId)=>rows(db,`SELECT id,effect_kind,delivery_status,cancel_reason FROM public.automation_flow_outbox WHERE run_id='${runId}' ORDER BY created_at,id`);
const gen=db=>Number(actRow(db).activation_generation);

// -------------------------------------------------------------- scenarios
test("sleeping run: same-revision off/on revives it WITHOUT the migration, never WITH it",{skip},()=>{
 // pre = production today: the hazard is real.
 const p=clone("pre","pre");
 const rp=begin(p,"s1",{status:"sleeping",wake:PAST,effects:DELAY_EFFECT("s1")});
 flip(p);
 const lp=lease(p);
 assert.equal(lp.length,1,"pre: the old sleeping run IS leased after off/on (the bug)");
 assert.equal(lp[0].run_id,rp.run);
 // gen = fixed.
 const g=clone("gen","gen");
 const r=begin(g,"s1",{status:"sleeping",wake:PAST,effects:DELAY_EFFECT("s1")});
 const g0=gen(g);
 assert.equal(run(g,r.run).activation_generation,g0,"stamped with the validated generation");
 flip(g);
 assert.equal(gen(g),g0+1,"genuine inactive->active is a NEW generation");
 assert.deepEqual(lease(g),[],"old-generation sleeping run is not leased");
 const after=run(g,r.run);
 assert.equal(after.run_status,"blocked");
 assert.equal(after.ended_reason,"revision_inactive");
 // control: no flip -> leased.
 const c=clone("gen","gen");
 const rc=begin(c,"s1",{status:"sleeping",wake:PAST,effects:DELAY_EFFECT("s1")});
 const lc=lease(c);
 assert.equal(lc.length,1);assert.equal(lc[0].run_id,rc.run);
});

test("A -> B -> A invalidates work created under the first A generation",{skip},()=>{
 const g=clone("gen","gen");
 const r=begin(g,"a1",{status:"sleeping",wake:PAST,effects:DELAY_EFFECT("a1")});
 const g1=gen(g);
 assert.equal(act(g,2),true);                 // B (revision 2): active -> active with another revision
 assert.equal(gen(g),g1+1);
 assert.equal(act(g,1),true);                 // back to A (revision 1)
 assert.equal(gen(g),g1+2);
 assert.equal(actRow(g).revision,1);
 assert.deepEqual(lease(g),[],"the first-A run (stamp "+g1+") is dead although revision and is_active match");
 assert.equal(run(g,r.run).ended_reason,"revision_inactive");
 // work created under the SECOND A generation is fine.
 const n=begin(g,"a2",{status:"sleeping",wake:PAST,effects:DELAY_EFFECT("a2")});
 assert.equal(run(g,n.run).activation_generation,g1+2);
 assert.equal(lease(g).length,1);
});

test("activation is idempotent: a repeat on an active revision is a true no-op",{skip},()=>{
 const g=clone("gen","gen");
 assert.equal(act(g,1),true);
 const first=actRow(g);
 for(let i=0;i<3;i++)assert.equal(act(g,1),true,"still reports success");
 const again=actRow(g);
 assert.deepEqual(again,first,"generation, activated_at, updated_at and the row version are unchanged");
 // A direct write of the same state cannot move activated_at or the generation either.
 ok(g,{sql:`UPDATE public.automation_flow_activations SET is_active=true,activated_at=now()+interval '1 day',
  activation_generation=99 WHERE tenant_id='${A}' AND flow_key='buttons';`},"direct no-op write");
 const direct=actRow(g);
 assert.equal(direct.activation_generation,first.activation_generation);
 assert.equal(direct.activated_at,first.activated_at);
 // Deactivate is not a new generation; reactivate is exactly one.
 const g0=Number(first.activation_generation);
 assert.equal(deact(g),true);assert.equal(deact(g),true);
 assert.equal(gen(g),g0);
 assert.equal(act(g,1),true);assert.equal(act(g,1),true);
 assert.equal(gen(g),g0+1);
 // A caller can never set the generation.
 ok(g,{sql:`UPDATE public.automation_flow_activations SET activation_generation=1 WHERE flow_key='buttons';`},"tamper");
 assert.equal(gen(g),g0+1);
 // Inactive row inserted then activated: generations are distinct and monotonic.
 assert.equal(act(g,1,"other"),true);
 assert.equal(Number(actRow(g,"other").activation_generation),1);
});

test("awaiting run: off/on ends it and refuses a button tap; legacy behaviour without the migration",{skip},()=>{
 const tap=(db,e,r,name)=>{
  const t=mk(db,name,e.conv);
  const c=rows(db,`SELECT acquired FROM public.flow_claim_inbound_durable('${A}','${ACC}','instagram',${L(t.mid)},${L(t.conv)},${L(t.msg)})`,SR);
  assert.equal(c[0].acquired,true);
  return val(db,`public.flow_resume_button_run('${A}','${r}',${L(t.mid)},${L(t.msg)},1,'choose','yes',2,'completed','{}'::jsonb,NULL,${L(MSG_EFFECT(name))}::jsonb)`,SR);
 };
 const p=clone("pre","pre");
 const ep=begin(p,"w1");
 flip(p);
 assert.equal(tap(p,ep,ep.run,"tap1"),true,"pre: the stale awaiting run IS resumed (the bug)");
 const g=clone("gen","gen");
 const e=begin(g,"w1");
 flip(g);
 assert.equal(tap(g,e,e.run,"tap1"),false,"gen: refused");
 assert.equal(run(g,e.run).run_status,"awaiting_input","a refused tap does not change the run");
 assert.deepEqual(outbox(g,e.run).map(o=>o.effect_kind),["question"],"no new effect was created");
 assert.equal(val(g,`public.flow_expire_waiting_runs(5,100)`,SR),1);
 assert.equal(run(g,e.run).ended_reason,"revision_inactive");
 const cancelled=outbox(g,e.run)[0];
 assert.equal(cancelled.delivery_status,"cancelled");assert.equal(cancelled.cancel_reason,"revision_inactive");
 // control: no flip -> the tap resumes.
 const c=clone("gen","gen");
 const ec=begin(c,"w1");
 assert.equal(tap(c,ec,ec.run,"tap1"),true);
});

test("leased sleeping run cannot commit after its generation went stale",{skip},()=>{
 const g=clone("gen","gen");
 const r=begin(g,"l1",{status:"sleeping",wake:PAST,effects:DELAY_EFFECT("l1")});
 const l=lease(g);
 assert.equal(l.length,1);
 flip(g);
 const commit=()=>val(g,`public.flow_commit_run_step('${A}','${r.run}',1,'sleeping','yes',2,'completed','{}'::jsonb,NULL,${L(MSG_EFFECT("l1b"))}::jsonb,'transition','${l[0].lease_token}')`,SR);
 assert.equal(commit(),false,"the stale leased run is refused");
 assert.equal(run(g,r.run).run_status,"sleeping");
 assert.equal(outbox(g,r.run).filter(o=>o.effect_kind==="message").length,0);
 // control: same generation commits.
 const c=clone("gen","gen");
 const rc=begin(c,"l1",{status:"sleeping",wake:PAST,effects:DELAY_EFFECT("l1")});
 const lc=lease(c);
 assert.equal(val(c,`public.flow_commit_run_step('${A}','${rc.run}',1,'sleeping','yes',2,'completed','{}'::jsonb,NULL,${L(MSG_EFFECT("l1b"))}::jsonb,'transition','${lc[0].lease_token}')`,SR),true);
});

test("pending outbox effects of a completed run: not delivered after off/on, swept as revision_inactive",{skip},()=>{
 const reserve=(db,o)=>val(db,`public.flow_reserve_outbox_delivery('${A}','${o}')`,SR);
 const p=clone("pre","pre");
 const rp=begin(p,"o1",{status:"completed",next:"yes",step:2,effects:MSG_EFFECT("o1")});
 flip(p);
 assert.equal(reserve(p,outbox(p,rp.run)[0].id),true,"pre: the old effect IS delivered (the bug)");
 const g=clone("gen","gen");
 const r=begin(g,"o1",{status:"completed",next:"yes",step:2,effects:MSG_EFFECT("o1")});
 const o=outbox(g,r.run)[0];
 assert.equal(o.delivery_status,"pending");
 flip(g);
 assert.equal(reserve(g,o.id),false,"old-generation effect is not reserved");
 assert.equal(outbox(g,r.run)[0].delivery_status,"pending");
 assert.equal(val(g,`public.flow_skip_blocked_outbox(5,100)`,SR),1);
 const s=outbox(g,r.run)[0];
 assert.equal(s.delivery_status,"cancelled");assert.equal(s.cancel_reason,"revision_inactive");
 // an effect created under the NEW generation is delivered.
 const n=begin(g,"o2",{status:"completed",next:"yes",step:2,effects:MSG_EFFECT("o2")});
 assert.equal(reserve(g,outbox(g,n.run)[0].id),true);
 // control without a flip.
 const c=clone("gen","gen");
 const rc=begin(c,"o1",{status:"completed",next:"yes",step:2,effects:MSG_EFFECT("o1")});
 assert.equal(reserve(c,outbox(c,rc.run)[0].id),true);
});

test("leased and uncertain effects keep the existing delivery-review behaviour across off/on",{skip},()=>{
 const g=clone("gen","gen");
 const r1=begin(g,"d1",{status:"completed",next:"yes",step:2,effects:MSG_EFFECT("d1")});
 const r2=begin(g,"d2",{status:"completed",next:"yes",step:2,effects:MSG_EFFECT("d2")});
 const o1=outbox(g,r1.run)[0].id,o2=outbox(g,r2.run)[0].id;
 assert.equal(val(g,`public.flow_reserve_outbox_delivery('${A}','${o1}')`,SR),true);   // leased (in flight)
 assert.equal(val(g,`public.flow_reserve_outbox_delivery('${A}','${o2}')`,SR),true);
 assert.equal(val(g,`public.flow_finish_outbox_delivery('${A}','${o2}','uncertain',NULL)`,SR),true); // uncertain
 flip(g);
 assert.equal(val(g,`public.flow_skip_blocked_outbox(5,100)`,SR),0,"nothing leased/uncertain is cancelled");
 assert.equal(val(g,`public.flow_expire_waiting_runs(5,100)`,SR),0);
 assert.equal(outbox(g,r1.run)[0].delivery_status,"leased");
 assert.equal(outbox(g,r2.run)[0].delivery_status,"uncertain");
 // the in-flight send can still be settled exactly as before (delivery review path unchanged).
 assert.equal(val(g,`public.flow_finish_outbox_delivery('${A}','${o1}','uncertain',NULL)`,SR),true);
 assert.equal(outbox(g,r1.run)[0].delivery_status,"uncertain");
 const review=val(g,`public.flow_queue_outbox_human_review(1,100)`,SR);
 assert.ok(review===0||review>=0);
 assert.equal(outbox(g,r2.run)[0].delivery_status,"uncertain");
});

test("internal effects (tag): not applied after off/on, applied without it",{skip},()=>{
 const mkTag=(db,name)=>{
  const r=begin(db,name,{status:"completed",next:"yes",step:2,effects:TAG_EFFECT(name)});
  ok(db,{sql:`UPDATE public.automation_flow_tenant_switches SET test_only=true WHERE tenant_id='${A}';`},"test_only for apply");
  return {r,o:outbox(db,r.run)[0].id};
 };
 const apply=(db,o)=>val(db,`public.flow_apply_internal_effect('${A}','${o}')`,SR);
 const p=clone("pre","pre");
 const tp=mkTag(p,"i1");flip(p);
 assert.equal(apply(p,tp.o),true,"pre: the stale internal effect IS applied (the bug)");
 const g=clone("gen","gen");
 const t=mkTag(g,"i1");flip(g);
 assert.equal(apply(g,t.o),false);
 assert.equal(outbox(g,t.r.run)[0].delivery_status,"pending");
 assert.equal(val(g,`(SELECT count(*) FROM public.flow_conversation_tags WHERE conversation_id='${t.r.conv}')::int`),0);
 const c=clone("gen","gen");
 const tc=mkTag(c,"i1");
 assert.equal(apply(c,tc.o),true);
});

test("comment replies: a stale-generation reply is not claimable; current generation is",{skip},()=>{
 const build=db=>{
  const e=mk(db,"c1");
  ok(db,{sql:`INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
   VALUES('${A}','${ACC}','instagram','comment:123');
   INSERT INTO public.automation_flow_runs(tenant_id,flow_key,publication_revision,channel_account_id,platform,conversation_id,provider_event_id,current_node_id,run_status,step_count)
   VALUES('${A}','buttons',1,'${ACC}','instagram','${e.conv}','comment:123','start','completed',1);`},"comment run");
  const runId=val(db,`(SELECT id FROM public.automation_flow_runs WHERE provider_event_id='comment:123')`);
  ok(db,{sql:`INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
   VALUES('${A}','${runId}','rc.1','reply_comment','{"kind":"reply_comment","commentId":"123","text":"thanks","seq":0}');
   INSERT INTO public.automation_comment_replies(tenant_id,channel_account_id,platform,comment_id,post_id,from_id,comment_text_encrypted,public_reply_text,flow_key,publication_revision,run_id)
   VALUES('${A}','${ACC}','instagram','123','456','789','enc:v1:x','thanks','buttons',1,'${runId}');`},"comment reply");
  return {runId,o:val(db,`(SELECT id FROM public.automation_flow_outbox WHERE run_id='${runId}')`)};
 };
 const claim=(db,o)=>rows(db,`SELECT outcome FROM public.flow_claim_comment_reply('${A}','${o}',60)`,SR)[0]?.outcome;
 const p=clone("pre","pre");const bp=build(p);flip(p);
 assert.equal(claim(p,bp.o),"claimed","pre: the stale comment reply IS claimed (the bug)");
 const g=clone("gen","gen");const b=build(g);
 assert.equal(Number(val(g,`(SELECT activation_generation FROM public.automation_flow_runs WHERE id='${b.runId}')`)),gen(g));
 flip(g);
 assert.equal(claim(g,b.o),"not_claimable");
 assert.equal(val(g,`public.flow_skip_blocked_outbox(5,100)`,SR),1);
 assert.equal(rows(g,`SELECT delivery_status,cancel_reason FROM public.automation_flow_outbox WHERE id='${b.o}'`)[0].cancel_reason,"revision_inactive");
 const c=clone("gen","gen");const bc=build(c);
 assert.equal(claim(c,bc.o),"claimed");
});

test("a new start after reactivation works and supersedes the stale run on the same conversation",{skip},()=>{
 const g=clone("gen","gen");
 const old=begin(g,"n1");
 flip(g);
 const e2=mk(g,"n2",old.conv);
 const r=start(g,e2);
 assert.equal(r[0].acquired,true,JSON.stringify(r));
 assert.equal(run(g,old.run).ended_reason,"superseded");
 assert.equal(run(g,r[0].run_id).activation_generation,gen(g));
 assert.equal(run(g,r[0].run_id).run_status,"awaiting_input");
 // and a second conversation behaves normally.
 const n=begin(g,"n3",{status:"sleeping",wake:PAST,effects:DELAY_EFFECT("n3")});
 const l=lease(g);
 assert.equal(l.length,1);assert.equal(l[0].run_id,n.run);
});

test("no run is created without a valid generation; a stamp is server-assigned and immutable",{skip},()=>{
 const g=clone("gen","gen");
 const e=mk(g,"z1");
 ok(g,{sql:`INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
  VALUES('${A}','${ACC}','instagram','x.1'),('${A}','${ACC}','instagram','x.2'),('${A}','${ACC}','instagram','x.3');`},"receipts");
 const ins=(ev,rev,extra="")=>psql(g,{sql:`INSERT INTO public.automation_flow_runs(tenant_id,flow_key,publication_revision,channel_account_id,platform,conversation_id,provider_event_id,current_node_id,run_status,step_count${extra?",activation_generation":""})
  VALUES('${A}','buttons',${rev},'${ACC}','instagram','${e.conv}','${ev}','start','completed',1${extra?","+extra:""});`});
 // supplied NULL / forged value is overridden with the real generation.
 let r=ins("x.1",1,"NULL");assert.equal(r.status,0,r.stderr);
 r=ins("x.2",1,"12345");assert.equal(r.status,0,r.stderr);
 assert.deepEqual(rows(g,`SELECT activation_generation::int AS g FROM public.automation_flow_runs WHERE provider_event_id IN('x.1','x.2')`).map(x=>x.g),[gen(g),gen(g)]);
 assert.equal(val(g,`(SELECT count(*) FROM public.automation_flow_runs WHERE activation_generation IS NULL)::int`),0);
 // wrong revision (not the active one) or inactive activation: refused (FB191).
 r=ins("x.3",2);assert.notEqual(r.status,0);assert.equal(sqlState(r.stderr),"FB191");
 assert.equal(deact(g),true);
 r=ins("x.3",1);assert.notEqual(r.status,0);assert.equal(sqlState(r.stderr),"FB191");
 // a stamp cannot be changed afterwards.
 r=psql(g,{sql:`UPDATE public.automation_flow_runs SET activation_generation=activation_generation+1 WHERE provider_event_id='x.1';`});
 assert.notEqual(r.status,0);assert.equal(sqlState(r.stderr),"FB191");
 r=psql(g,{sql:`UPDATE public.automation_flow_runs SET activation_generation=NULL WHERE provider_event_id='x.1';`});
 assert.notEqual(r.status,0);assert.equal(sqlState(r.stderr),"FB191");
 // unrelated updates (what every worker does) still work on stamped runs.
 r=psql(g,{sql:`UPDATE public.automation_flow_runs SET updated_at=now() WHERE provider_event_id='x.1';`});
 assert.equal(r.status,0,r.stderr);
});

test("begin vs activation: a run is stamped with the generation current at its insert, never another",{skip},async()=>{
 // (1) begin holds the activation row FOR SHARE until it commits; the flip waits and wins AFTER:
 //     the run keeps the OLD generation and is therefore dead.
 let g=clone("gen","gen");
 let e=mk(g,"k1");const g0=gen(g);
 const beginSql=`SET ROLE ${SR};SET t.sleep='on';BEGIN;SELECT acquired FROM public.flow_claim_begin_durable_run(true,${L(e.tenant)},${L(e.acc)},'instagram',${L(e.mid)},${L(e.conv)},${L(e.msg)},'buttons',1,'start','choose',1,'awaiting_input','{}'::jsonb,NULL,${L(Q_EFFECT("k1"))}::jsonb);SET t.sleep='off';COMMIT;`;
 const flipSql=`SET ROLE ${SR};BEGIN;SELECT public.flow_deactivate_revision('${A}','${ACC}','instagram','buttons','${OWNER}');SELECT public.flow_activate_revision('${A}','${ACC}','instagram','buttons',1,'${OWNER}');COMMIT;`;
 const pb=psqlAsync(g,beginSql);
 await wait(400);
 const pf=psqlAsync(g,flipSql);
 const [rb,rf]=await Promise.all([pb,pf]);
 assert.equal(rb.code,0,rb.err);assert.equal(rf.code,0,rf.err);
 assert.ok(rf.end>=rb.end-50,"the flip was serialized behind the creating transaction");
 const stamped=rows(g,`SELECT activation_generation::int AS g,run_status FROM public.automation_flow_runs WHERE provider_event_id=${L(e.mid)}`);
 assert.equal(stamped.length,1);
 assert.equal(stamped[0].g,g0,"stamped with the generation it was created under");
 assert.equal(gen(g),g0+1);
 assert.notEqual(stamped[0].g,gen(g),"so it is stale after the flip");

 // (2) the flip commits first as deactivate+activate: begin waits, then stamps the NEW generation.
 g=clone("gen","gen");
 e=mk(g,"k2");const h0=gen(g);
 const flip2=`SET ROLE ${SR};BEGIN;SELECT public.flow_deactivate_revision('${A}','${ACC}','instagram','buttons','${OWNER}');SELECT public.flow_activate_revision('${A}','${ACC}','instagram','buttons',1,'${OWNER}');SELECT pg_sleep(1.2);COMMIT;`;
 const begin2=`SET ROLE ${SR};SELECT acquired FROM public.flow_claim_begin_durable_run(true,${L(e.tenant)},${L(e.acc)},'instagram',${L(e.mid)},${L(e.conv)},${L(e.msg)},'buttons',1,'start','choose',1,'awaiting_input','{}'::jsonb,NULL,${L(Q_EFFECT("k2"))}::jsonb);`;
 const pf2=psqlAsync(g,flip2);
 await wait(300);
 const pb2=psqlAsync(g,begin2);
 const [rf2,rb2]=await Promise.all([pf2,pb2]);
 assert.equal(rf2.code,0,rf2.err);assert.equal(rb2.code,0,rb2.err);
 const s2=rows(g,`SELECT activation_generation::int AS g FROM public.automation_flow_runs WHERE provider_event_id=${L(e.mid)}`);
 assert.equal(s2.length,1);
 assert.equal(s2[0].g,h0+1,"begin that waited for the flip is stamped with the NEW generation");
 assert.equal(s2[0].g,gen(g));

 // (3) the flip leaves the flow INACTIVE: the waiting begin fails closed; nothing is created.
 g=clone("gen","gen");
 e=mk(g,"k3");
 const off=`SET ROLE ${SR};BEGIN;SELECT public.flow_deactivate_revision('${A}','${ACC}','instagram','buttons','${OWNER}');SELECT pg_sleep(1.2);COMMIT;`;
 const begin3=`SET ROLE ${SR};SELECT acquired FROM public.flow_claim_begin_durable_run(true,${L(e.tenant)},${L(e.acc)},'instagram',${L(e.mid)},${L(e.conv)},${L(e.msg)},'buttons',1,'start','choose',1,'awaiting_input','{}'::jsonb,NULL,${L(Q_EFFECT("k3"))}::jsonb);`;
 const po=psqlAsync(g,off);
 await wait(300);
 const pb3=psqlAsync(g,begin3);
 const [ro,rb3]=await Promise.all([po,pb3]);
 assert.equal(ro.code,0,ro.err);
 assert.notEqual(rb3.code,0,"the begin that raced a deactivation is refused");
 assert.equal(sqlState(rb3.err),"FB191");
 assert.equal(rows(g,`SELECT 1 FROM public.automation_flow_runs WHERE provider_event_id=${L(e.mid)}`).length,0);
 assert.equal(rows(g,`SELECT 1 FROM public.automation_message_claims WHERE provider_event_id=${L(e.mid)}`).length,0,"atomic: no orphaned claim");
});

test("legacy rows: backfill stamps live work with the current generation or 0; NULL stays only where harmless",{skip},()=>{
 // Build the legacy population on a pre-migration database, then apply the migration.
 const p=clone("leg","pre");
 const s1=begin(p,"g1",{status:"sleeping",wake:PAST,effects:DELAY_EFFECT("g1")});       // live, active activation
 const w1=begin(p,"g2");                                                                 // awaiting, active activation
 const c1=begin(p,"g3",{status:"completed",next:"yes",step:2,effects:MSG_EFFECT("g3")}); // completed + pending effect
 // a run on an INACTIVE activation: the 'other' flow is activated only to create it.
 assert.equal(act(p,1,"other"),true);
 const e4=mk(p,"g4");
 const dead=start(p,e4,{flow:"other",status:"sleeping",wake:PAST,effects:DELAY_EFFECT("g4")})[0].run_id;
 assert.equal(deact(p,"other"),true);
 // terminal runs with nothing left to do.
 const t1=begin(p,"g5",{status:"completed",next:"yes",step:2,effects:MSG_EFFECT("g5")});
 ok(p,{sql:`UPDATE public.automation_flow_outbox SET delivery_status='settled' WHERE run_id='${t1.run}';`},"settle");
 ok(p,{sql:`UPDATE public.automation_flow_runs SET run_status='completed' WHERE id='${dead}' AND false;`},"noop");
 ok(p,{file:MIG},"apply migration to the legacy population");
 const gnow=gen(p);
 assert.equal(run(p,s1.run).activation_generation,gnow);
 assert.equal(run(p,w1.run).activation_generation,gnow);
 assert.equal(run(p,c1.run).activation_generation,gnow);
 assert.equal(run(p,dead).activation_generation,0,"inactive at migration time -> dead (0)");
 assert.equal(run(p,t1.run).activation_generation,null,"terminal run with only settled effects stays NULL");
 // live legacy work behaves exactly as before while nothing flips ...
 // ... and is dead after a genuine reactivation.
 const dup=clone("leg2",p);
 assert.equal(lease(dup).filter(l=>l.run_id===s1.run).length,1,"stamped legacy work still wakes while its activation is untouched");
 flip(p);
 assert.deepEqual(lease(p).filter(l=>l.run_id===s1.run),[]);
 assert.equal(run(p,s1.run).ended_reason,"revision_inactive");
 assert.equal(val(p,`public.flow_expire_waiting_runs(5,100)`,SR),1);
 assert.equal(run(p,w1.run).ended_reason,"revision_inactive");
 // the dead (0) run can never be revived by activating its flow.
 assert.equal(act(p,1,"other"),true);
 assert.deepEqual(lease(p).filter(l=>l.run_id===dead),[],"a 0 stamp matches no generation");
 // explicit NULL handling: a NULL stamp is legacy-permissive (previous behaviour), never "dead".
 const n=clone("nul","gen");
 const rn=begin(n,"nl",{status:"sleeping",wake:PAST,effects:DELAY_EFFECT("nl")});
 ok(n,{sql:`ALTER TABLE public.automation_flow_runs DISABLE TRIGGER automation_flow_runs_generation_trg;
  UPDATE public.automation_flow_runs SET activation_generation=NULL WHERE id='${rn.run}';
  ALTER TABLE public.automation_flow_runs ENABLE TRIGGER automation_flow_runs_generation_trg;`},"force a legacy NULL");
 assert.equal(run(n,rn.run).activation_generation,null);
 assert.equal(lease(n).length,1,"NULL = legacy-permissive: wakes while its revision is active");
});

test("only the nine documented functions change; two trigger functions, two triggers, two columns are added",{skip},()=>{
 const fp=db=>rows(db,`SELECT p.oid::regprocedure::text AS sig,md5(p.prosrc) AS h,coalesce(p.proacl::text,'') AS acl,
  coalesce(array_to_string(p.proconfig,','),'') AS cfg,coalesce(obj_description(p.oid,'pg_proc'),'') AS cmt FROM pg_proc p
  WHERE p.pronamespace='public'::regnamespace ORDER BY 1`);
 const a=new Map(fp("pre").map(x=>[x.sig,x])),b=new Map(fp("gen").map(x=>[x.sig,x]));
 const changed=[...b.keys()].filter(k=>a.has(k)&&a.get(k).h!==b.get(k).h).sort();
 const added=[...b.keys()].filter(k=>!a.has(k)).sort();
 assert.deepEqual([...a.keys()].filter(k=>!b.has(k)),[],"nothing removed");
 assert.deepEqual(changed,Object.keys(PATCHED).sort());
 assert.deepEqual(added,["flow_activation_generation_guard()","flow_run_generation_guard()"]);
 for(const [sig,[orig,patched]] of Object.entries(PATCHED)){
  assert.equal(a.get(sig).h,orig,`${sig}: pre body is the production body`);
  assert.equal(b.get(sig).h,patched,`${sig}: patched body is pinned`);
  assert.equal(b.get(sig).acl,a.get(sig).acl,`${sig}: privileges unchanged`);
  assert.equal(b.get(sig).cfg,a.get(sig).cfg,`${sig}: search_path unchanged`);
  assert.equal(b.get(sig).cmt,a.get(sig).cmt,`${sig}: marker comment unchanged`);
 }
});

test("migration also applies on the repository-head chain (20261029340000/350000 present)",{skip},()=>{
 const h=clone("head","base");
 for(const f of [M+"20261029340000_flow_inbound_routing_retry.sql",M+"20261029350000_flow_durable_keyword_start.sql"])ok(h,{file:f},f);
 ok(h,{file:MIG},"migration on head chain");
 const r=begin(h,"hd",{status:"sleeping",wake:PAST,effects:DELAY_EFFECT("hd")});
 assert.equal(run(h,r.run).activation_generation,gen(h),"the (different) head begin function is stamped by the trigger");
 flip(h);
 assert.deepEqual(lease(h),[]);
});

test("refused (nothing changed) when a patched function drifted, on re-apply, and for the rollback of a non-installed state",{skip},()=>{
 const d=clone("drift","base");
 // drift one patched function
 const def=val(d,`pg_get_functiondef('public.flow_lease_due_runs(integer)'::regprocedure)`);
 ok(d,{sql:def.replace("v_leased integer := 0;","v_leased integer := 0; v_drift integer := 0;")},"drift");
 const before=rows(d,`SELECT md5(string_agg(md5(prosrc),',' ORDER BY oid::text)) AS h FROM pg_proc WHERE pronamespace='public'::regnamespace`)[0].h;
 let r=psql(d,{file:MIG});
 assert.notEqual(r.status,0);assert.match(r.stderr,/flow_lease_due_runs\(integer\) changed \(manual review required\)/);
 assert.equal(rows(d,`SELECT md5(string_agg(md5(prosrc),',' ORDER BY oid::text)) AS h FROM pg_proc WHERE pronamespace='public'::regnamespace`)[0].h,before);
 assert.equal(rows(d,`SELECT 1 FROM information_schema.columns WHERE column_name='activation_generation'`).length,0,"no column was added");
 // re-apply on an installed DB, and rollback on a clean one
 r=psql("gen",{file:MIG});
 assert.notEqual(r.status,0);assert.match(r.stderr,/already installed/);
 r=psql("base",{file:RB});
 assert.notEqual(r.status,0);assert.match(r.stderr,/not installed/);
});

test("rollback restores the production bodies exactly, drops every added object, and the migration re-applies",{skip},()=>{
 const g=clone("rb","gen");
 const r=begin(g,"rb1",{status:"sleeping",wake:PAST,effects:DELAY_EFFECT("rb1")});
 ok(g,{file:RB},"rollback");
 for(const [sig,[orig]] of Object.entries(PATCHED))
  assert.equal(val(g,`(SELECT md5(prosrc) FROM pg_proc WHERE oid='public.${sig}'::regprocedure)`),orig,sig);
 assert.equal(rows(g,`SELECT 1 FROM information_schema.columns WHERE column_name='activation_generation'`).length,0);
 assert.equal(rows(g,`SELECT 1 FROM pg_trigger WHERE tgname LIKE '%generation_trg'`).length,0);
 assert.equal(rows(g,`SELECT 1 FROM pg_proc WHERE proname LIKE 'flow_%generation_guard'`).length,0);
 assert.equal(val(g,`(SELECT run_status FROM public.automation_flow_runs WHERE id='${r.run}')`),"sleeping","data untouched");
 const again=psql(g,{file:RB});
 assert.notEqual(again.status,0);
 ok(g,{file:MIG},"re-apply after rollback");
 assert.equal(run(g,r.run).activation_generation,gen(g),"re-apply backfills the surviving live run");
});

// ---- PostgreSQL version (set PG_EXPECT_VERSION=17.6 to pin the server this ran on)
test("server version is reported (and pinned when PG_EXPECT_VERSION is set)",{skip},t=>{
 const v=val("gen","current_setting('server_version')");
 t.diagnostic("server_version="+v);
 if(process.env.PG_EXPECT_VERSION)assert.ok(String(v).startsWith(process.env.PG_EXPECT_VERSION),`expected ${process.env.PG_EXPECT_VERSION}, got ${v}`);
});

// ---- abandoned reply_comment effects (finding: stale generation left 'leased' / 'attempting')
// A completed comment run: reply_comment effect + its DM effect + the comment-reply row.
function buildCommentReply(db,name,commentId){
 const e=mk(db,name);
 const ev=`comment:${commentId}`;
 ok(db,{sql:`INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
  VALUES('${A}','${ACC}','instagram','${ev}');
  INSERT INTO public.automation_flow_runs(tenant_id,flow_key,publication_revision,channel_account_id,platform,conversation_id,provider_event_id,current_node_id,run_status,step_count)
  VALUES('${A}','buttons',1,'${ACC}','instagram','${e.conv}','${ev}','start','completed',1);`},"comment run "+name);
 const runId=val(db,`(SELECT id FROM public.automation_flow_runs WHERE provider_event_id='${ev}')`);
 ok(db,{sql:`INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload) VALUES
   ('${A}','${runId}','rc.${name}','reply_comment','{"kind":"reply_comment","commentId":"${commentId}","text":"thanks","seq":0}'),
   ('${A}','${runId}','dm.${name}','message','{"kind":"message","text":"hello","seq":1}');
  INSERT INTO public.automation_comment_replies(tenant_id,channel_account_id,platform,comment_id,post_id,from_id,comment_text_encrypted,public_reply_text,flow_key,publication_revision,run_id)
  VALUES('${A}','${ACC}','instagram','${commentId}','456','789','enc:v1:x','thanks','buttons',1,'${runId}');`},"comment effects "+name);
 const eff=kind=>val(db,`(SELECT id FROM public.automation_flow_outbox WHERE run_id='${runId}' AND effect_kind='${kind}')`);
 return {runId,reply:eff("reply_comment"),dm:eff("message")};
}
const claimReply=(db,o)=>rows(db,`SELECT outcome FROM public.flow_claim_comment_reply('${A}','${o}',30)`,SR)[0]?.outcome;
const expireLease=(db,o)=>ok(db,{sql:`UPDATE public.automation_flow_outbox SET lease_expires_at=now()-interval '5 seconds' WHERE id='${o}';`},"expire lease");
const replyState=(db,b)=>rows(db,`SELECT o.delivery_status AS outbox,(o.lease_token IS NULL) AS no_token,(o.lease_expires_at IS NULL) AS no_expiry,
  cr.reply_status,cr.reply_error_code,cr.dm_status,
  (SELECT d.delivery_status||':'||coalesce(d.cancel_reason,'') FROM public.automation_flow_outbox d WHERE d.id='${b.dm}') AS dm_effect
  FROM public.automation_flow_outbox o JOIN public.automation_comment_replies cr ON cr.run_id=o.run_id WHERE o.id='${b.reply}'`)[0];

test("abandoned reply_comment of a stale generation ends 'uncertain': never resent, DM skipped, not re-listed; live ones stay claimable",{skip},()=>{
 // Live run (control): an expired lease is still re-claimable and the sweep leaves it alone.
 const c=clone("rc","gen");
 const bc=buildCommentReply(c,"rc1","1001");
 assert.equal(claimReply(c,bc.reply),"claimed");
 expireLease(c,bc.reply);
 assert.equal(val(c,`public.flow_skip_blocked_outbox(5,100)`,SR),0);
 let st=replyState(c,bc);
 assert.deepEqual([st.outbox,st.reply_status,st.dm_effect],["leased","attempting","pending:"],"live: untouched");
 assert.equal(claimReply(c,bc.reply),"claimed","live: re-claimable exactly as before");

 // Stale generation (off/on of the same revision).
 const g=clone("rc","gen");
 const b=buildCommentReply(g,"rc1","1001");
 assert.equal(claimReply(g,b.reply),"claimed");
 assert.deepEqual([replyState(g,b).outbox,replyState(g,b).reply_status],["leased","attempting"]);
 // Lease still valid: never touched, even when stale.
 flip(g);
 assert.equal(claimReply(g,b.reply),"not_claimable","stale: not claimable");
 assert.equal(val(g,`public.flow_skip_blocked_outbox(5,100)`,SR),1,"only the pending DM is cancelled; the live lease is left");
 st=replyState(g,b);
 assert.deepEqual([st.outbox,st.reply_status],["leased","attempting"],"a lease that has not expired is not touched");
 // Lease expired: terminal review state.
 expireLease(g,b.reply);
 assert.equal(val(g,`public.flow_skip_blocked_outbox(5,100)`,SR),0);
 st=replyState(g,b);
 assert.deepEqual([st.outbox,st.no_token,st.no_expiry],["uncertain",true,true]);
 assert.deepEqual([st.reply_status,st.reply_error_code,st.dm_status],["uncertain","abandoned_revision_inactive","skipped"]);
 assert.equal(st.dm_effect,"cancelled:revision_inactive","the DM of the run was cancelled");
 // Never sendable again, idempotent.
 assert.equal(claimReply(g,b.reply),"not_claimable");
 assert.equal(val(g,`public.flow_reserve_outbox_delivery('${A}','${b.dm}')`,SR),false);
 const before=JSON.stringify(replyState(g,b));
 assert.equal(val(g,`public.flow_skip_blocked_outbox(5,100)`,SR),0);
 assert.equal(JSON.stringify(replyState(g,b)),before,"second sweep changes nothing");
 // Visible to delivery review: outbox row in a FAILED_OUTBOX_STATUSES state.
 assert.equal(rows(g,`SELECT 1 FROM public.automation_flow_outbox WHERE id='${b.reply}' AND delivery_status IN('uncertain','dead_letter','billing_blocked')`).length,1);
 // The bound limit is honoured.
 const g2=clone("rc","gen");
 const x1=buildCommentReply(g2,"rc1","2001"),x2=buildCommentReply(g2,"rc2","2002");
 for(const x of [x1,x2]){assert.equal(claimReply(g2,x.reply),"claimed");expireLease(g2,x.reply);}
 flip(g2);
 val(g2,`public.flow_skip_blocked_outbox(5,1)`,SR);
 const done=[x1,x2].filter(x=>replyState(g2,x).outbox==="uncertain").length;
 assert.equal(done,1,"p_limit bounds the abandoned-reply pass");
 val(g2,`public.flow_skip_blocked_outbox(5,100)`,SR);
 assert.deepEqual([x1,x2].map(x=>replyState(g2,x).outbox),["uncertain","uncertain"]);

 // A merely DEACTIVATED revision leaves the identical stuck state today (pre-migration database);
 // the same predicate now resolves it.
 const p=clone("rc","pre");
 const bp=buildCommentReply(p,"rc1","3001");
 assert.equal(claimReply(p,bp.reply),"claimed");expireLease(p,bp.reply);
 assert.equal(deact(p),true);
 assert.equal(claimReply(p,bp.reply),"not_claimable");
 val(p,`public.flow_skip_blocked_outbox(5,100)`,SR);
 assert.equal(replyState(p,bp).outbox,"leased","pre-migration: stuck 'leased' forever");
 const d=clone("rc","gen");
 const bd=buildCommentReply(d,"rc1","3001");
 assert.equal(claimReply(d,bd.reply),"claimed");expireLease(d,bd.reply);
 assert.equal(deact(d),true);
 val(d,`public.flow_skip_blocked_outbox(5,100)`,SR);
 assert.equal(replyState(d,bd).outbox,"uncertain","with the migration: surfaced for review");
});

// ---- the repo's predeploy checks recognize the exact post-migration definitions
const CHECKS="supabase/proposals/flow_v3_v4_predeploy_checks.review.sql";
function predeploy(db){
 const r=spawnSync(join(BIN,"psql"),[...pargs(db),"-F","\t","-f",CHECKS],{encoding:"utf8",env:clientEnv(),maxBuffer:1<<26});
 assert.equal(r.status,0,`checks failed\n${r.stderr}`);
 assert.doesNotMatch(r.stderr,/ERROR|WARNING/,r.stderr);
 const out=new Map();
 for(const l of r.stdout.split("\n")){
  const f=l.split("\t");
  if(f.length===7)out.set(f[0]+"|"+f[1],{status:f[2],detail:f[6]});
 }
 assert.ok(out.size>100,"parsed the check rows");
 return out;
}
const bodyFn={
 lease:"flow_lease_due_runs(integer)",
 resume:"flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamp with time zone,jsonb)",
 commit:"flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamp with time zone,jsonb,text,uuid)",
 reserve:"flow_reserve_outbox_delivery(uuid,uuid)",
 skip:"flow_skip_blocked_outbox(integer,integer)",
 apply:"flow_apply_internal_effect(uuid,uuid)"
};
test("predeploy checks: every row for the patched functions is OK on the migrated database; nothing that was OK regresses",{skip},()=>{
 const pre=predeploy("pre"),gen=predeploy("gen");
 const GEN="20261123100000";
 const ok_=(k,re)=>{const r=gen.get(k);assert.ok(r,k);assert.equal(r.status,"OK",`${k}: ${r.status} ${r.detail}`);if(re)assert.match(r.detail,re,k);};
 ok_("d_prerequisites|function_version:public.flow_lease_due_runs(integer)",new RegExp(`^installed_version=${GEN} `));
 ok_("d_prerequisites|durable_button_run:public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)",new RegExp(` body_version=${GEN} `));
 ok_("d_prerequisites|durable_button_run_guards",/1 of 2 have the 230000 body, 1 its 20261123100000 successor/);
 ok_("d_prerequisites|superseding_begin:public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)");
 for(const f of ["flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)","flow_reserve_outbox_delivery(uuid,uuid)"])
  ok_(`d_prerequisites|media_effects:public.${f}`,new RegExp(` body_version=${GEN} `));
 ok_("d_prerequisites|media_sweep:public.flow_skip_blocked_outbox(integer,integer)",new RegExp(` body_version=${GEN} `));
 ok_("d_prerequisites|media_stale_sweep");
 ok_("d_prerequisites|multichannel_support",/flow_commit_run_step=20261123100000 flow_end_stale_paused_runs=20261029230000 flow_lease_due_runs=20261123100000 flow_reserve_outbox_delivery=20261123100000 flow_resume_button_run=20261123100000/);
 ok_("d_prerequisites|preflight:20261029230000");
 ok_("g_staff_internal_actions|function:public.flow_apply_internal_effect(uuid,uuid)");
 // No regression: whatever was OK before the migration is OK after it.
 for(const [k,v] of pre)if(v.status==="OK")assert.equal(gen.get(k)?.status,"OK",`regressed: ${k}\n${gen.get(k)?.detail}`);
 // Every conflict left after the migration already exists without it (pre-existing, unrelated: 20261029300000
 // widened the effect_kind CHECK, which these proposal checks do not know).
 const bad=k=>/^(CONFLICT|MISSING)/.test(gen.get(k).status);
 for(const k of gen.keys())if(bad(k))assert.ok(/^(CONFLICT|MISSING)/.test(pre.get(k)?.status??""),`new conflict after the migration: ${k}: ${gen.get(k).status}`);
});

test("predeploy checks still reject any other body of a patched function (exact hashes, nothing loosened)",{skip},()=>{
 const base=predeploy("gen");
 const tamper=(db,sig)=>{
  const def=val(db,`pg_get_functiondef('public.${sig}'::regprocedure)`);
  assert.match(def,/\nBEGIN\n/);
  ok(db,{sql:def.replace("\nBEGIN\n","\nBEGIN\n -- tampered\n")},"tamper "+sig);
 };
 const expect={
  lease:["d_prerequisites|function_version:public.flow_lease_due_runs(integer)",/^CONFLICT/],
  resume:["d_prerequisites|durable_button_run:public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)",/^CONFLICT/],
  commit:["d_prerequisites|media_effects:public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)",/^CONFLICT/],
  reserve:["d_prerequisites|media_effects:public.flow_reserve_outbox_delivery(uuid,uuid)",/^CONFLICT/],
  skip:["d_prerequisites|media_sweep:public.flow_skip_blocked_outbox(integer,integer)",/^CONFLICT/],
  apply:["g_staff_internal_actions|function:public.flow_apply_internal_effect(uuid,uuid)",/^CONFLICT/]
 };
 for(const [name,[key,re]] of Object.entries(expect)){
  assert.equal(base.get(key).status,"OK",`${name}: OK before tampering`);
  const d=clone("pdt","gen");
  tamper(d,bodyFn[name]);
  const rs=predeploy(d);
  assert.match(rs.get(key).status,re,`${name}: tampered body must be a CONFLICT (${rs.get(key).detail})`);
 }
 // The aggregate also flags it (multichannel_support covers lease/resume/commit/reserve).
 const d=clone("pdt","gen");tamper(d,bodyFn.lease);
 assert.match(predeploy(d).get("d_prerequisites|multichannel_support").status,/^CONFLICT/);
 // The pre-migration database is still judged exactly as before (the production bodies are not "recognized as generation").
 const pre=predeploy("pre");
 assert.match(pre.get("d_prerequisites|function_version:public.flow_lease_due_runs(integer)").detail,/^installed_version=20261029230000 /);
});

test("activation rows have no supported deletion path: FK facts; the raw-privilege limit is documented, not hidden",{skip},()=>{
 const fk=rows("gen",`SELECT confrelid::regclass::text AS ref,confdeltype::text AS del FROM pg_constraint
  WHERE conrelid='public.automation_flow_activations'::regclass AND contype='f' ORDER BY 1`);
 const by=Object.fromEntries(fk.map(x=>[x.ref,x.del]));
 assert.equal(by["tenants"],"c","tenant deletion cascades the activation ...");
 assert.equal(rows("gen",`SELECT confdeltype::text AS del FROM pg_constraint WHERE conrelid='public.automation_flow_runs'::regclass
  AND contype='f' AND confrelid='public.tenants'::regclass`)[0].del,"c","... and the runs with it (no stale run survives)");
 assert.equal(by["channel_accounts"],"a","a channel account cannot be deleted while an activation references it");
 assert.equal(by["automation_flow_publications"],"a");
 const g=clone("fk","gen");
 const r=psql(g,{sql:`DELETE FROM public.channel_accounts WHERE id='${ACC}';`});
 assert.notEqual(r.status,0);assert.equal(sqlState(r.stderr),"23503");
 // KNOWN LIMIT (documented in docs/ACTIVATION_GENERATION_DEPLOYMENT.md): only raw privileged SQL (service_role /
 // postgres hold DELETE) could delete the row; the counter would then restart at 1. No supported path does.
 ok(g,{sql:`DELETE FROM public.automation_flow_activations WHERE flow_key='buttons';
  INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active)
  VALUES('${A}','${ACC}','instagram','buttons',1,true);`},"raw delete + insert");
 assert.equal(gen(g),1,"documented limit: generation restarts after a raw delete");
});

// ---- locking behaviour of the migration under concurrent traffic
test("locking: never queues other traffic, waits for a busy table, cannot deadlock with a worker, aborts cleanly when busy",{skip},async()=>{
 const mkPre=()=>{const d=clone("lk","pre");begin(d,"lk1");return d;};
 const holder=`BEGIN;SELECT count(*) FROM public.automation_flow_runs;SELECT pg_sleep(2.5);COMMIT;`;
 const probe=`SELECT count(*) FROM public.automation_flow_runs;`;
 const migText=src(MIG);
 const hasCols=d=>rows(d,`SELECT 1 FROM information_schema.columns WHERE column_name='activation_generation'`).length;

 // (0) CONTROL: a plain waiting ACCESS EXCLUSIVE request stalls every later reader behind it (the failure mode avoided).
 let d=mkPre();
 let h=psqlAsync(d,holder);await wait(300);
 const naive=psqlAsync(d,`BEGIN;SET LOCAL lock_timeout='5s';LOCK TABLE public.automation_flow_runs IN ACCESS EXCLUSIVE MODE;COMMIT;`);await wait(300);
 let pr=await psqlAsync(d,probe);
 await Promise.all([h,naive]);
 assert.ok(pr.end-pr.start>1200,`control: a plain waiting lock stalls readers (${pr.end-pr.start} ms)`);

 // (1) The migration waits for the busy table WITHOUT queueing anybody, then applies.
 d=mkPre();
 h=psqlAsync(d,holder);await wait(300);
 const mig=psqlAsync(d,migText);await wait(300);
 pr=await psqlAsync(d,probe);
 assert.ok(pr.end-pr.start<900,`readers are not stalled while the migration waits (${pr.end-pr.start} ms)`);
 const [hr,mr]=await Promise.all([h,mig]);
 assert.equal(mr.code,0,mr.err);
 assert.ok(mr.end>=hr.end-100,"the migration waited for the holder");
 assert.equal(hasCols(d),2);

 // (2) A worker-style transaction (row locks on runs, THEN a read of activations) cannot deadlock with it.
 d=mkPre();
 const worker=`BEGIN;SELECT id FROM public.automation_flow_runs ORDER BY id LIMIT 1 FOR UPDATE;SELECT pg_sleep(1.2);SELECT count(*) FROM public.automation_flow_activations;COMMIT;`;
 const w=psqlAsync(d,worker);await wait(300);
 const m2=psqlAsync(d,migText);
 const [wr,m2r]=await Promise.all([w,m2]);
 assert.equal(wr.code,0,wr.err);assert.equal(m2r.code,0,m2r.err);
 assert.doesNotMatch(wr.err+m2r.err,/deadlock/i);
 assert.equal(hasCols(d),2);

 // (3) Busy for the whole retry window: abort with a clear message and change NOTHING; a later run works.
 d=mkPre();
 const before=rows(d,`SELECT md5(string_agg(md5(prosrc),',' ORDER BY oid::text)) AS h FROM pg_proc WHERE pronamespace='public'::regnamespace`)[0].h;
 const quick=migText.replace("FOR v_try IN 1..60 LOOP","FOR v_try IN 1..3 LOOP").replace("IF v_try=60 THEN","IF v_try=3 THEN");
 assert.notEqual(quick,migText);
 h=psqlAsync(d,`BEGIN;SELECT count(*) FROM public.automation_flow_runs;SELECT pg_sleep(4);COMMIT;`);await wait(300);
 const busy=await psqlAsync(d,quick);
 await h;
 assert.notEqual(busy.code,0);
 assert.match(busy.err,/stayed busy for 30 s; nothing was changed, retry in a quiet moment/);
 assert.equal(hasCols(d),0,"no column");
 assert.equal(rows(d,`SELECT 1 FROM pg_trigger WHERE tgname LIKE '%generation_trg'`).length,0,"no trigger");
 assert.equal(rows(d,`SELECT md5(string_agg(md5(prosrc),',' ORDER BY oid::text)) AS h FROM pg_proc WHERE pronamespace='public'::regnamespace`)[0].h,before,"no function changed");
 const again=await psqlAsync(d,migText);
 assert.equal(again.code,0,again.err);assert.equal(hasCols(d),2);

 // (4) The rollback takes the same non-queueing locks, runs behind a busy table too, and is atomic.
 h=psqlAsync(d,holder);await wait(300);
 const rbRun=psqlAsync(d,src(RB));await wait(300);
 pr=await psqlAsync(d,probe);
 assert.ok(pr.end-pr.start<900,`rollback does not stall readers either (${pr.end-pr.start} ms)`);
 const [,rr]=await Promise.all([h,rbRun]);
 assert.equal(rr.code,0,rr.err);assert.equal(hasCols(d),0);
});
