// Production-apply safety of the Flow V3/V4 migration chain
// 20261029130000_flow_run_lifecycle -> 20261029140000_flow_outbox_ai_retry ->
// 20261029150000_flow_takeover_resume and their rollbacks (150000 -> 140000 -> 130000).
//
//  (a) lock-timeout handling with the operator PGOPTIONS (130000/140000 set no
//      timeout themselves): a conflicting lock makes the apply fail fast with
//      lock_not_available, leaves no partial change and succeeds on retry.
//  (b) MEASURES (prints, never asserts tight timings) the heaviest steps on a
//      larger seeded fixture (~200k runs, ~500k outbox rows).
//  (c) rollback matrix: correct order, every wrong order, partial chains,
//      re-apply after rollback, in-flight rows.
//  (d) hazard: re-applying 130000 after 150000 silently restores the 130000
//      function bodies; the read-only pre-deploy checks report CONFLICT.
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only, listen_addresses='',
// removed afterwards) when PostgreSQL server binaries are present. Never
// connects to any remote host or connection string; inherited PG* variables
// are stripped from every client.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";

const LC="supabase/migrations/20261029130000_flow_run_lifecycle.sql";
const AI="supabase/migrations/20261029140000_flow_outbox_ai_retry.sql";
const TK="supabase/migrations/20261029150000_flow_takeover_resume.sql";
const LC_RB="supabase/rollbacks/20261029130000_flow_run_lifecycle.rollback.sql";
const AI_RB="supabase/rollbacks/20261029140000_flow_outbox_ai_retry.rollback.sql";
const TK_RB="supabase/rollbacks/20261029150000_flow_takeover_resume.rollback.sql";
const CP="supabase/migrations/20261029160000_flow_credits_pause.sql";
const CP_RB="supabase/rollbacks/20261029160000_flow_credits_pause.rollback.sql";
const CC="supabase/migrations/20261029170000_flow_canary_claim_durable.sql";
const CC_RB="supabase/rollbacks/20261029170000_flow_canary_claim_durable.rollback.sql";
const CHECKS="supabase/proposals/flow_v3_v4_predeploy_checks.review.sql";
// Durable button run (125000) and its guards (180000): the ends of the 125000..180000 chain.
const DB="supabase/migrations/20261029125000_flow_durable_button_run.sql";
const DB_RB="supabase/rollbacks/20261029125000_flow_durable_button_run.rollback.sql";
const GD="supabase/migrations/20261029180000_flow_durable_button_run_guards.sql";
const GD_RB="supabase/rollbacks/20261029180000_flow_durable_button_run_guards.rollback.sql";
// Operator rule: 130000/140000 must be applied with these session settings.
const PGOPTIONS="-c lock_timeout=3s -c statement_timeout=60s";
const OPTS={PGOPTIONS};
const HOLD=5; // seconds a conflicting session keeps its lock

const src=f=>readFileSync(f,"utf8");
const md5=x=>createHash("md5").update(x).digest("hex");
const body=(f,tag)=>{const s=src(f),o=`AS $${tag}$`,a=s.indexOf(o)+o.length;return s.slice(a,s.indexOf(`$${tag}$`,a));};

// ---------------------------------------------------------------- static
test("130000/140000 set no timeouts of their own (PGOPTIONS required); 125000, 150000..180000 and all rollbacks do",()=>{
 for(const f of [LC,AI])assert.doesNotMatch(src(f),/lock_timeout|statement_timeout/,f);
 for(const f of [DB,TK,CP,CC,GD,DB_RB,LC_RB,AI_RB,TK_RB,CP_RB,CC_RB,GD_RB])
  assert.match(src(f),/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
 // 20261029180000 (durable button run guards; requires the whole chain) is the
 // newest migration, then 20261029170000 (canary claim).
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 for(const s of stamps)if(s!=="20261029170000"&&s!=="20261029180000")assert.ok(s<"20261029170000",s);
 for(const f of [DB,LC,AI,TK,CP,CC,GD,DB_RB,LC_RB,AI_RB,TK_RB,CP_RB,CC_RB,GD_RB]){
  const s=src(f).split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");
  assert.equal((s.match(/^BEGIN;$/gm)??[]).length,1,`${f}: one transaction`);
  assert.equal((s.match(/^COMMIT;$/gm)??[]).length,1,`${f}: one commit`);
  assert.doesNotMatch(s,/CONCURRENTLY/,`${f}: no non-transactional DDL`);
 }
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
function args(db,{tab=false,stop=true,verbose=false,echo=false}={}){
 const a=["-X","-q","-t","-A"];
 if(tab)a.push("-F","\t");
 if(stop)a.push("-v","ON_ERROR_STOP=1");
 if(verbose)a.push("-v","VERBOSITY=verbose");
 if(echo)a.push("-e");
 return [...a,"-h",dir,"-p",String(port),"-U","postgres","-d",db];
}
function psql(db,{file,sql,env,...o}={}){
 const a=args(db,o);
 if(file)a.push("-f",file);
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input:sql??undefined,env:clientEnv(env),maxBuffer:1<<26});
}
function psqlAsync(db,{file,sql,env,...o}={}){
 return new Promise(res=>{
  const a=args(db,o);
  if(file)a.push("-f",file);
  const t0=Date.now();
  const p=spawn(join(BIN,"psql"),a,{env:clientEnv(env)});
  let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
  p.on("close",code=>res({code,out,err,ms:Date.now()-t0}));
  p.stdin.end(sql??"");
 });
}
function ok(db,s,label){
 const r=psql(db,s);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return r.stdout.trim();
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(...a)=>console.log("[migration-safety]",...a);

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC="11111111-1111-4111-8111-111111111111";
const ACC2="99999999-9999-4999-8999-999999999999";
// CI "Outbox send ledger" order, stopping BEFORE 20261029130000.
const CHAIN=["tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
 "tests/sql/flow-exclusive-claim-bootstrap.sql","supabase/migrations/20261028220000_webhook_exclusive_claim.sql",
 "supabase/migrations/20261028224000_delivery_attempts.sql","supabase/migrations/20261028225000_flow_runtime_advance.sql",
 "tests/sql/flow-phase4-runtime-bootstrap.sql","tests/sql/flow-outbox-delivery-bootstrap.sql",
 "supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql"];
// Production-shape optional columns + in-flight rows that exist BEFORE 130000
// (only pre-130000 columns are used).
const BASE_SEED=`
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,ADD COLUMN auto_reply boolean NOT NULL DEFAULT true;
ALTER TABLE public.conversations ADD COLUMN transferred boolean NOT NULL DEFAULT false,
 ADD COLUMN auto_paused_reason text,ADD COLUMN human_agent_expires_at timestamptz;
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES('${ACC2}','${A}','instagram','instagram');
GRANT SELECT,UPDATE ON public.tenants,public.channel_accounts,public.conversations TO service_role;
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
VALUES('${A}','live',1,'${ACC}','instagram','{"version":3,"nodes":[],"edges":[]}','88888888-8888-4888-8888-888888888888'),
      ('${A}','live2',1,'${ACC2}','instagram','{"version":3,"nodes":[],"edges":[]}','88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active)
VALUES('${A}','${ACC}','instagram','live',1,true),('${A}','${ACC2}','instagram','live2',1,true);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only) VALUES('${A}',true,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
CREATE SCHEMA ms;
CREATE TABLE ms.ids(name text PRIMARY KEY,id uuid NOT NULL);
CREATE FUNCTION ms.id(p text) RETURNS uuid LANGUAGE sql STABLE AS $f$SELECT id FROM ms.ids WHERE name=p$f$;
CREATE FUNCTION ms.run(p_name text,p_status text,p_wake interval,p_flow text DEFAULT 'live',
 p_acc uuid DEFAULT '${ACC}') RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE ev text:='ms-'||gen_random_uuid(); v uuid; c uuid;
BEGIN
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(gen_random_uuid(),'${A}',p_acc,'instagram:'||gen_random_uuid()) RETURNING id INTO c;
 INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
 VALUES('${A}',p_acc,'instagram',ev);
 INSERT INTO public.automation_flow_runs(tenant_id,flow_key,publication_revision,channel_account_id,
  platform,conversation_id,provider_event_id,current_node_id,run_status,wake_at)
 VALUES('${A}',p_flow,1,p_acc,'instagram',c,ev,'n1',p_status,
  CASE WHEN p_status='sleeping' THEN now()+p_wake END) RETURNING id INTO v;
 INSERT INTO ms.ids VALUES(p_name,v),(p_name||'_conv',c);
 RETURN v;
END $f$;
CREATE FUNCTION ms.fx(p_name text,p_run text,p_status text,p_source text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $f$
DECLARE v uuid;
BEGIN
 INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload,delivery_status,retry_at)
 VALUES('${A}',ms.id(p_run),'ms-'||p_name,'message',
  jsonb_strip_nulls(jsonb_build_object('kind','message','text','hello '||p_name,'source',p_source)),p_status,
  CASE WHEN p_status='retry_wait' THEN now()+interval '10 minutes' END) RETURNING id INTO v;
 INSERT INTO ms.ids VALUES(p_name,v);
 RETURN v;
END $f$;
-- Columns added by the migrations are read only through to_jsonb (they come and go).
CREATE FUNCTION ms.state() RETURNS jsonb LANGUAGE sql STABLE AS $f$
 SELECT jsonb_object_agg(k,v) FROM (
  SELECT n.name AS k,r.run_status||'/'||coalesce(to_jsonb(r)->>'ended_reason','-')||'/'||
   coalesce(r.wake_at::text,'-')||'/'||md5(r.variables::text) AS v
  FROM ms.ids n JOIN public.automation_flow_runs r ON r.id=n.id
  UNION ALL SELECT n.name,o.delivery_status||'/'||coalesce(to_jsonb(o)->>'cancel_reason','-')||'/'||
   md5(o.payload::text)||'/'||coalesce(o.retry_at::text,'-')
  FROM ms.ids n JOIN public.automation_flow_outbox o ON o.id=n.id
  UNION ALL SELECT 'count:runs',count(*)::text FROM public.automation_flow_runs
  UNION ALL SELECT 'count:outbox',count(*)::text FROM public.automation_flow_outbox
  UNION ALL SELECT 'count:leases',count(*)::text FROM public.automation_flow_run_leases) s $f$;
CREATE FUNCTION ms.answers() RETURNS jsonb LANGUAGE sql STABLE AS $f$
 SELECT jsonb_object_agg(n.name,coalesce(to_jsonb(o)->>'ai_answer_encrypted','-'))
 FROM ms.ids n JOIN public.automation_flow_outbox o ON o.id=n.id $f$;
-- In-flight rows: sleeping (not yet due) and awaiting runs, pending / retry_wait /
-- knowledge_ai effects (C_fx becomes charge_pending with a stored answer later).
SELECT ms.run('S','sleeping','1 hour'); SELECT ms.fx('S_fx','S','pending');
SELECT ms.run('W','awaiting_input',NULL); SELECT ms.fx('W_fx','W','retry_wait');
SELECT ms.run('K','sleeping','2 hours');
SELECT ms.fx('K1','K','pending','knowledge_ai'); SELECT ms.fx('K2','K','pending','knowledge_ai');
SELECT ms.run('C','completed',NULL); SELECT ms.fx('C_fx','C','pending','knowledge_ai');
ANALYZE;
`;
function buildBase(){
 ok("postgres",{sql:"CREATE DATABASE base;"},"createdb base");
 ok("base",{sql:src("tests/sql/fixtures/flow-live-shape-bootstrap.sql")},"live shape");
 for(const f of CHAIN)ok("base",{file:f},f);
 ok("base",{sql:BASE_SEED},"base seed");
}
before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-migsafety-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+29)%20000);
 let r=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(r.status,0,r.stderr);
 r=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off -c max_wal_size=2GB -c checkpoint_timeout=1h`,"start"]);
 assert.equal(r.status,0,r.stderr+r.stdout);
 started=true;
 buildBase();
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});

let clones=0;
function clone(prefix){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE base;`},`clone ${db}`);
 return db;
}
const apply=(db,f,label=f)=>ok(db,{file:f,env:OPTS},label);

// Schema fingerprint of public (functions incl. body/ACL/config/marker,
// relations incl. ACL/comment, index definitions, columns incl. defaults,
// constraints incl. validation state, triggers) and optionally all public data.
const FP=data=>`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||
  coalesce(p.proacl::text,'')||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||pg_get_function_result(p.oid)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'i:'||pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'c:'||a.attrelid::regclass::text||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||
  coalesce(pg_get_expr(d.adbin,d.adrelid),'')
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v') AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid)||':'||convalidated
  FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 't:'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text||':'||coalesce(obj_description(t.oid,'pg_trigger'),'')
  FROM pg_trigger t WHERE NOT t.tgisinternal
 ${data?`UNION ALL SELECT 'd:'||c.oid::regclass::text||':'||md5(query_to_xml(
   format('SELECT t::text AS v FROM %s t ORDER BY 1',c.oid::regclass),false,false,'')::text)
  FROM pg_class c WHERE c.relkind IN('r','p') AND c.relnamespace='public'::regnamespace`:""}
) s(x);`;
const fp=(db,data=true)=>ok(db,{sql:FP(data)},"fingerprint");
const state=db=>JSON.parse(ok(db,{sql:"SELECT ms.state();"},"state"));
const answers=db=>JSON.parse(ok(db,{sql:"SELECT ms.answers();"},"answers"));

// ================================================================= (a)
async function waitHolder(db){
 for(let i=0;i<200;i++){
  const n=ok(db,{sql:`SELECT count(*) FROM pg_stat_activity WHERE application_name='ms_holder'
   AND state='active' AND query LIKE 'SELECT pg_sleep%';`},"holder probe");
  if(n==="1")return;
  await sleep(50);
 }
 assert.fail("holder never acquired its lock");
}
// Session 2 holds `hold` for HOLD seconds while `file` is applied.
async function contended(db,hold,file,{env=OPTS,stop=true,reader=null,end="COMMIT"}={}){
 const before=fp(db);
 const holder=psqlAsync(db,{sql:`BEGIN;\n${hold}\nSELECT pg_sleep(${HOLD});\n${end};\n`,env:{PGAPPNAME:"ms_holder"}});
 await waitHolder(db);
 const run=psqlAsync(db,{file,env,stop,verbose:true});
 let rd=null;
 if(reader){await sleep(1000);rd=psqlAsync(db,{sql:reader});}
 const r=await run;
 const h=await holder;
 assert.equal(h.code,0,h.err);
 return {r,rd:rd&&await rd,before,after:fp(db)};
}
const AS=t=>`LOCK TABLE public.${t} IN ACCESS SHARE MODE;`;
const AX=t=>`LOCK TABLE public.${t} IN ACCESS EXCLUSIVE MODE;`;

test("(a) lock contention: fail fast with lock_not_available, no partial change, retry succeeds",{skip},async()=>{
 // Uncontended reference applies.
 const ref=clone("lk");
 const want={};
 apply(ref,LC);want[LC]=fp(ref);
 apply(ref,AI);want[AI]=fp(ref);
 apply(ref,TK);want[TK]=fp(ref);
 const cases=[
  {file:LC,pre:[],table:"automation_flow_runs"},
  {file:LC,pre:[],table:"automation_flow_outbox"},
  {file:LC,pre:[],table:"automation_flow_run_leases",reader:"SELECT count(*) FROM public.automation_flow_runs;"},
  {file:AI,pre:[LC],table:"automation_flow_outbox"},
 ];
 const rows=[];
 for(const c of cases){
  const db=clone("lk");
  for(const f of c.pre)apply(db,f);
  const {r,rd,before,after}=await contended(db,AS(c.table),c.file,{reader:c.reader});
  assert.notEqual(r.code,0,`${c.file} must fail under a lock on ${c.table}`);
  assert.match(r.err,/ERROR:\s+55P03: canceling statement due to lock timeout/,r.err);
  assert.ok(r.ms>=2500&&r.ms<6000,`${c.file}/${c.table}: failed after ${r.ms} ms`);
  assert.equal(after,before,`${c.file}/${c.table}: no partial change`);
  rows.push(`${c.file.split("/").pop().slice(0,14)} vs ACCESS SHARE on ${c.table}: lock_not_available after ${r.ms} ms`+
   (rd?`; an unrelated reader of automation_flow_runs queued ${rd.ms} ms behind it`:""));
  if(rd)assert.equal(rd.code,0,rd.err);
  apply(db,c.file,"retry after release");
  assert.equal(fp(db),want[c.file],`${c.file}: retry equals the uncontended apply`);
 }
 // 150000 contends only with concurrent DDL on the functions it replaces
 // (here: an open GRANT on flow_lease_due_runs updates the same pg_proc row).
 {
  const db=clone("lk");apply(db,LC);apply(db,AI);
  const {r,before,after}=await contended(db,
   "GRANT EXECUTE ON FUNCTION public.flow_lease_due_runs(integer) TO service_role;",TK,{env:{}});
  assert.notEqual(r.code,0);
  assert.match(r.err,/55P03: canceling statement due to lock timeout/,r.err);
  assert.ok(r.ms>=2500&&r.ms<6000,`150000 failed after ${r.ms} ms`);
  assert.equal(after,before,"150000: no partial change");
  rows.push(`20261029150000 (own SET LOCAL, no PGOPTIONS) vs open GRANT on flow_lease_due_runs: lock_not_available after ${r.ms} ms`);
  apply(db,TK,"150000 retry");
  assert.equal(fp(db),want[TK]);
 }
 // 150000 alters no table, but its preflight (catalog lookups on
 // automation_flow_runs) needs ACCESS SHARE there: an ACCESS EXCLUSIVE holder
 // (e.g. another migration) blocks it and its own SET LOCAL lock_timeout makes
 // it fail fast. Either outcome per table must be clean (fast failure with no
 // change, or an immediate complete apply); the observed one is reported.
 let blockedBy=0;
 for(const t of ["automation_flow_runs","automation_flow_outbox","automation_flow_run_leases"]){
  const db=clone("lk");apply(db,LC);apply(db,AI);
  const {r,before,after}=await contended(db,AX(t),TK,{env:{}});
  if(r.code!==0){
   blockedBy++;
   assert.match(r.err,/55P03: canceling statement due to lock timeout/,r.err);
   assert.ok(r.ms>=2500&&r.ms<6000,`150000 failed after ${r.ms} ms`);
   assert.equal(after,before,"150000: no partial change");
   rows.push(`20261029150000 (own SET LOCAL) vs ACCESS EXCLUSIVE on ${t}: lock_not_available after ${r.ms} ms`);
   apply(db,TK,"150000 retry");
  }else{
   assert.ok(r.ms<2500,`${t}: applied without waiting (${r.ms} ms)`);
   rows.push(`20261029150000 vs ACCESS EXCLUSIVE on ${t}: not blocked, applied in ${r.ms} ms`);
  }
  assert.equal(fp(db),want[TK]);
 }
 assert.ok(blockedBy>=1,"150000 waits on at least automation_flow_runs");
 // ... but ordinary worker traffic (ROW EXCLUSIVE writers on all three tables) does not block 150000.
 {
  const db=clone("lk");apply(db,LC);apply(db,AI);
  const {r,after}=await contended(db,
   ["automation_flow_runs","automation_flow_outbox","automation_flow_run_leases"]
    .map(t=>`LOCK TABLE public.${t} IN ROW EXCLUSIVE MODE;`).join("\n"),TK,{env:{}});
  assert.equal(r.code,0,r.err);
  assert.ok(r.ms<2500,`150000 not blocked by writers (${r.ms} ms)`);
  assert.equal(after,want[TK]);
  rows.push(`20261029150000 vs open ROW EXCLUSIVE writers on runs/outbox/leases: applied in ${r.ms} ms (not blocked)`);
 }
 // WITHOUT PGOPTIONS 130000 queues behind the lock (and everything queues behind it).
 {
  const db=clone("lk");
  const {r,after}=await contended(db,AS("automation_flow_runs"),LC,{env:{}});
  assert.equal(r.code,0,r.err);
  assert.ok(r.ms>=(HOLD-1)*1000,`waited ${r.ms} ms`);
  assert.equal(after,want[LC]);
  rows.push(`20261029130000 WITHOUT PGOPTIONS: waited ${r.ms} ms for the lock holder (unbounded queueing)`);
 }
 // WITHOUT ON_ERROR_STOP psql exits 0 although nothing was applied.
 {
  const db=clone("lk");
  const {r,before,after}=await contended(db,AS("automation_flow_outbox"),LC,{stop:false});
  assert.equal(r.code,0,"psql exit status is 0 without ON_ERROR_STOP");
  assert.match(r.err,/lock timeout/);
  assert.match(r.err,/current transaction is aborted/);
  assert.equal(after,before,"nothing applied (COMMIT became ROLLBACK)");
  rows.push("20261029130000 without ON_ERROR_STOP: psql exit 0 but NOTHING applied (COMMIT -> ROLLBACK): always use -v ON_ERROR_STOP=1");
 }
 for(const l of rows)log("(a)",l);
});

// ---------------------------------------------------------------- 125000 / 180000 helpers
const between=(s,open,close)=>{const a=s.indexOf(open);assert.ok(a>=0,open);const b=a+open.length;return s.slice(b,s.indexOf(close,b));};
const lit=(f,name,tag)=>between(src(f),`${name} constant text := $${tag}$`,`$${tag}$;`);
const BEGIN_SIG="public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)";
const RESUME_SIG="public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)";
// (the base already has the production_approved switch column that 170000/180000 require)
const upTo170=db=>{for(const f of [DB,LC,AI,TK,CP,CC])apply(db,f);};

test("(a) 125000 and 180000 fail fast on their own SET LOCAL lock_timeout, with and without PGOPTIONS; retry succeeds",{skip},async()=>{
 const ref180=clone("gl");upTo170(ref180);apply(ref180,GD);const want180=fp(ref180);
 const ref125=clone("gl");apply(ref125,DB);const want125=fp(ref125);
 const rows=[];
 for(const env of [{},OPTS]){
  const tag=env.PGOPTIONS?"with PGOPTIONS":"without PGOPTIONS";
  // 180000 replaces both bodies: an open GRANT on flow_resume_button_run (same pg_proc row) blocks it.
  {
   const db=clone("gl");upTo170(db);
   const {r,before,after}=await contended(db,`GRANT EXECUTE ON FUNCTION ${RESUME_SIG} TO service_role;`,GD,{env});
   assert.notEqual(r.code,0,`180000 ${tag} must fail under the open GRANT`);
   assert.match(r.err,/55P03: canceling statement due to lock timeout/,r.err);
   assert.ok(r.ms>=2500&&r.ms<6000,`180000 ${tag}: failed after ${r.ms} ms`);
   assert.equal(after,before,`180000 ${tag}: no partial change`);
   rows.push(`20261029180000 ${tag} vs open GRANT on flow_resume_button_run: lock_not_available after ${r.ms} ms`);
   apply(db,GD,"180000 retry");
   assert.equal(fp(db),want180,`180000 ${tag}: retry equals the uncontended apply`);
  }
  // 125000: a second operator's uncommitted creation of the same function blocks its CREATE (rolled back afterwards).
  {
   const db=clone("gl");
   const {r,before,after}=await contended(db,
    `${lit(DB,"v_begin_head","head")}$begin$${lit(DB,"v_begin_src","begin")}$begin$;`,DB,{env,end:"ROLLBACK"});
   assert.notEqual(r.code,0,`125000 ${tag} must fail behind the concurrent creation`);
   assert.match(r.err,/55P03: canceling statement due to lock timeout/,r.err);
   assert.ok(r.ms>=2500&&r.ms<6000,`125000 ${tag}: failed after ${r.ms} ms`);
   assert.equal(after,before,`125000 ${tag}: no partial change`);
   rows.push(`20261029125000 ${tag} vs concurrent uncommitted CREATE of flow_begin_durable_run: lock_not_available after ${r.ms} ms`);
   apply(db,DB,"125000 retry");
   assert.equal(fp(db),want125,`125000 ${tag}: retry equals the uncontended apply`);
  }
 }
 for(const l of rows)log("(a)",l);
});

// ================================================================= (b)
const BIG_SEED=`
SET synchronous_commit=off;
CREATE TABLE ms.bconv AS SELECT g,gen_random_uuid() AS id,
 (CASE WHEN g<=10000 THEN '${ACC2}' ELSE '${ACC}' END)::uuid AS acc FROM generate_series(1,40000) g;
CREATE TABLE ms.brun AS SELECT g,gen_random_uuid() AS id,
 CASE WHEN g<=15000 THEN g ELSE 15001+(g%25000) END AS cg FROM generate_series(1,200000) g;
INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 SELECT id,'${A}',acc,'instagram:big:'||g FROM ms.bconv;
INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
 SELECT '${A}',c.acc,'instagram','big-'||r.g FROM ms.brun r JOIN ms.bconv c ON c.g=r.cg;
-- 10k sleeping runs due 1h..3.8h ago on ACC2 (paused below), 5k awaiting_input,
-- 185k completed/blocked; active runs have distinct conversations.
INSERT INTO public.automation_flow_runs(tenant_id,id,flow_key,publication_revision,channel_account_id,platform,
 conversation_id,provider_event_id,current_node_id,run_status,wake_at,updated_at)
 SELECT '${A}',r.id,CASE WHEN r.g<=10000 THEN 'live2' ELSE 'live' END,1,c.acc,'instagram',c.id,'big-'||r.g,'n1',
  CASE WHEN r.g<=10000 THEN 'sleeping' WHEN r.g<=15000 THEN 'awaiting_input' WHEN r.g%10=0 THEN 'blocked' ELSE 'completed' END,
  CASE WHEN r.g<=10000 THEN now()-make_interval(secs=>3600+r.g) END,now()-make_interval(secs=>r.g)
 FROM ms.brun r JOIN ms.bconv c ON c.g=r.cg;
INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload,delivery_status,retry_at,created_at)
 SELECT '${A}',r.id,'big-'||s.g,'message',jsonb_build_object('kind','message','text','big message '||s.g),
  CASE WHEN s.g<=2000 THEN 'pending' WHEN s.g<=3000 THEN 'retry_wait' WHEN s.g<=4000 THEN 'charge_pending' ELSE 'settled' END,
  CASE WHEN s.g BETWEEN 2001 AND 3000 THEN now()+interval '10 minutes' END,now()-make_interval(secs=>s.g)
 FROM generate_series(1,500000) s(g) JOIN ms.brun r ON r.g=1+(s.g%200000);
ANALYZE;
CHECKPOINT;
`;
const COUNTS=`SELECT (SELECT string_agg(run_status||'='||n,',' ORDER BY run_status) FROM
 (SELECT run_status,count(*) n FROM public.automation_flow_runs GROUP BY 1) a)||' | '||
 (SELECT string_agg(delivery_status||'='||n,',' ORDER BY delivery_status) FROM
 (SELECT delivery_status,count(*) n FROM public.automation_flow_outbox GROUP BY 1) b);`;
// Applies a file with per-statement \\timing; returns wall time and the steps.
function timed(db,file,env=OPTS){
 const t0=Date.now();
 const r=spawnSync(join(BIN,"psql"),args(db,{echo:true}),
  {encoding:"utf8",input:`\\timing on\n\\i ${resolve(file)}\n`,env:clientEnv(env),maxBuffer:1<<26});
 const wall=Date.now()-t0;
 assert.equal(r.status,0,`${file}\n${r.stderr}`);
 const steps=[];let buf=[];
 for(const line of r.stdout.split("\n")){
  const m=line.match(/^Time: ([\d.]+) ms/);
  if(m){steps.push({label:(buf.find(l=>l.trim())??"?").trim().slice(0,60),ms:Number(m[1])});buf=[];}
  else buf.push(line);
 }
 const txn=steps.reduce((s,x)=>s+x.ms,0);
 return {wall,txn,steps};
}
function report(name,t){
 const top=[...t.steps].sort((a,b)=>b.ms-a.ms).slice(0,4).map(s=>`${s.label} = ${s.ms.toFixed(0)} ms`).join("; ");
 log("(b)",`${name}: wall ${t.wall} ms, sum of statements ${t.txn.toFixed(0)} ms (locks held until COMMIT); heaviest: ${top}`);
 return Math.max(...t.steps.map(s=>s.ms));
}
function timeQuery(db,sql,n=3){
 const out=[];
 for(let i=0;i<n;i++){
  const r=spawnSync(join(BIN,"psql"),args(db),{encoding:"utf8",input:`\\timing on\n${sql}\n`,env:clientEnv()});
  assert.equal(r.status,0,r.stderr);
  out.push(Number(r.stdout.match(/Time: ([\d.]+) ms/)[1]));
 }
 return out.map(x=>x.toFixed(1)).join("/");
}

test("(b) measured apply / rollback cost on ~200k runs and ~500k outbox rows",{skip},()=>{
 const db=clone("big");
 let t0=Date.now();
 ok(db,{sql:BIG_SEED},"big seed");
 const counts0=ok(db,{sql:COUNTS},"counts");
 const size=ok(db,{sql:`SELECT pg_size_pretty(pg_total_relation_size('public.automation_flow_runs'))||' runs, '||
  pg_size_pretty(pg_total_relation_size('public.automation_flow_outbox'))||' outbox'`},"size");
 log("(b)",`seeded in ${Date.now()-t0} ms: ${counts0} (${size})`);
 const worst=[];
 worst.push(report("apply 20261029130000 (PGOPTIONS)",timed(db,LC)));
 assert.equal(ok(db,{sql:"SELECT to_regclass('public.flow_one_active_run_per_conversation') IS NOT NULL;"},"uq"),"t",
  "unique index built (no duplicates in fixture)");
 worst.push(report("apply 20261029140000 (PGOPTIONS)",timed(db,AI)));
 worst.push(report("apply 20261029150000",timed(db,TK,{})));
 // Lease tick cost with 10k due runs on a temporarily paused account (150000).
 const sleepingQ="SELECT count(*) FROM public.automation_flow_runs WHERE run_status='sleeping';";
 const sleeping0=ok(db,{sql:sleepingQ},"sleeping");
 ok(db,{sql:`UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC2}';`},"pause");
 const paused=timeQuery(db,"SELECT count(*) FROM public.flow_lease_due_runs(20);");
 const stale=timeQuery(db,"SELECT public.flow_end_stale_paused_runs(1440,100);");
 assert.equal(ok(db,{sql:sleepingQ},"sleeping"),sleeping0,"paused runs untouched");
 ok(db,{sql:`UPDATE public.channel_accounts SET auto_reply=true WHERE id='${ACC2}';`},"unpause");
 const live20=timeQuery(db,"SELECT count(*) FROM public.flow_lease_due_runs(20);",1);
 log("(b)",`flow_lease_due_runs(20) with 10k due runs paused: ${paused} ms (0 leased); `+
  `flow_end_stale_paused_runs: ${stale} ms; unpaused tick leasing 20: ${live20} ms`);
 worst.push(report("rollback 20261029150000",timed(db,TK_RB,{})));
 worst.push(report("rollback 20261029140000",timed(db,AI_RB,{})));
 worst.push(report("rollback 20261029130000",timed(db,LC_RB,{})));
 assert.equal(ok(db,{sql:COUNTS},"counts"),counts0,"no row lost or re-statused by the full apply/rollback cycle");
 const max=Math.max(...worst);
 log("(b)",`largest single statement ${max.toFixed(0)} ms vs statement_timeout 60000 ms: `+
  `${max<6000?"adequate (>10x headroom at this size)":max<30000?"adequate (>2x headroom)":"INSUFFICIENT headroom"}`);
});

// ================================================================= (c)
const msg={
 tk:/roll back 20261029150000_flow_takeover_resume first/,
 ai:/roll back 20261029140000_flow_outbox_ai_retry first/,
 tkNone:/20261029150000_flow_takeover_resume not installed; nothing to roll back/,
 lcNone:/Lifecycle migration not installed or unrecognized/,
};
function refused(db,file,re,label){
 const before=fp(db);
 const r=psql(db,{file,env:OPTS});
 assert.notEqual(r.status,0,`${label} must be refused`);
 assert.match(r.stderr,re,label);
 assert.equal(fp(db),before,`${label}: refused without any change`);
}

test("(c) rollback matrix: order guards, partial chains, re-apply",{skip},()=>{
 // Full chain, every wrong order, correct order, re-apply, second cycle.
 const db=clone("rb");
 const pre=fp(db),preSchema=fp(db,false);
 refused(db,AI,/lifecycle 20261029130000 required/,"apply 140000 before 130000");
 refused(db,TK,/apply 20261029130000_flow_run_lifecycle first/,"apply 150000 before 130000");
 refused(db,LC_RB,msg.lcNone,"130000 rollback when nothing installed");
 apply(db,LC);
 refused(db,TK,/apply 20261029140000_flow_outbox_ai_retry first/,"apply 150000 before 140000");
 apply(db,AI);apply(db,TK);
 const full=fp(db,false);
 refused(db,LC_RB,msg.tk,"130000 rollback before 150000");
 refused(db,AI_RB,msg.tk,"140000 rollback before 150000");
 apply(db,TK_RB,"150000 rollback");
 refused(db,TK_RB,msg.tkNone,"150000 rollback twice");
 refused(db,LC_RB,msg.ai,"130000 rollback before 140000");
 apply(db,AI_RB,"140000 rollback");
 apply(db,LC_RB,"130000 rollback");
 assert.equal(fp(db),pre,"150000->140000->130000 returns to the pre-130000 schema+data fingerprint");
 refused(db,LC_RB,msg.lcNone,"130000 rollback twice");
 apply(db,LC,"re-apply 130000");apply(db,AI,"re-apply 140000");apply(db,TK,"re-apply 150000");
 assert.equal(fp(db,false),full,"re-apply after rollback reproduces the full-chain schema");
 apply(db,TK_RB);apply(db,AI_RB);apply(db,LC_RB);
 assert.equal(fp(db),pre,"second cycle also returns to pre-130000");
 log("(c)","full chain: 3 wrong rollback orders + 3 wrong apply orders refused unchanged; 150->140->130 == pre-130000 (schema+data), twice; re-apply == first apply");

 // Partial chains.
 const p1=clone("rb");
 apply(p1,LC);apply(p1,LC_RB);
 assert.equal(fp(p1),pre,"130000 only -> rollback");
 const p2=clone("rb");
 apply(p2,LC);apply(p2,AI);
 refused(p2,LC_RB,msg.ai,"partial 130+140: 130000 rollback first");
 refused(p2,TK_RB,msg.tkNone,"partial 130+140: 150000 rollback");
 apply(p2,AI_RB);apply(p2,LC_RB);
 assert.equal(fp(p2),pre,"130+140 -> 140 rollback -> 130 rollback");
 assert.equal(fp(p2,false),preSchema);
 log("(c)","partial chains 130 and 130+140 roll back to pre-130000 exactly");
});

test("(c) in-flight rows survive apply and every rollback step (documented data effects only)",{skip},()=>{
 const db=clone("fl");
 const s0=state(db);
 apply(db,LC);apply(db,AI);
 assert.deepEqual(state(db),s0,"130000+140000 change no row");
 apply(db,TK);
 assert.deepEqual(state(db),s0,"150000 changes no row");
 // Worker activity inside the window: answer stored (K1), transient AI failure
 // (K2 -> retry_wait), answer stored then sent and awaiting the charge (C_fx).
 ok(db,{sql:`DO $a$ DECLARE c record; BEGIN
  SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ms.id('K1'),5,120);
  IF c.outcome<>'claimed' OR NOT public.flow_store_outbox_ai_answer('${A}',ms.id('K1'),c.claim_token,'enc:v1:aa:bb:cc')
  THEN RAISE EXCEPTION 'K1'; END IF;
  SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ms.id('K2'),5,120);
  IF public.flow_finish_outbox_ai('${A}',ms.id('K2'),c.claim_token,'retry','ai_timeout',60,5)<>'retry_wait'
  THEN RAISE EXCEPTION 'K2'; END IF;
  SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ms.id('C_fx'),5,120);
  IF NOT public.flow_store_outbox_ai_answer('${A}',ms.id('C_fx'),c.claim_token,'enc:v1:dd:ee:ff')
  THEN RAISE EXCEPTION 'C_fx'; END IF;
  UPDATE public.automation_flow_outbox SET delivery_status='charge_pending' WHERE id=ms.id('C_fx');
 END $a$;`},"activity");
 const s1=state(db),a1=answers(db);
 assert.match(s1.K2,/^retry_wait\//);assert.match(s1.C_fx,/^charge_pending\//);
 assert.equal(a1.K1,"enc:v1:aa:bb:cc");assert.equal(a1.C_fx,"enc:v1:dd:ee:ff");
 apply(db,TK,"150000 re-applied");
 assert.deepEqual(state(db),s1);assert.deepEqual(answers(db),a1,"150000 re-apply keeps stored answers");
 apply(db,TK_RB,"150000 rollback");
 assert.deepEqual(state(db),s1,"150000 rollback changes no row");
 assert.deepEqual(answers(db),a1,"150000 rollback keeps stored answers");
 apply(db,AI_RB,"140000 rollback");
 const s2=state(db);
 // Documented: AI retry_wait -> pending (retry_at cleared); non-AI retry_wait kept;
 // everything else unchanged; the ai_* columns (incl. stored answers) are dropped.
 assert.deepEqual(s2,{...s0,C_fx:s1.C_fx},"only K2 (AI backoff) returns to pending; no row lost");
 assert.equal(s2.W_fx,s0.W_fx,"pre-existing retry_wait untouched");
 const a2=answers(db);
 assert.ok(Object.values(a2).every(v=>v==="-"),"140000 rollback DROPS stored answers (incl. charge_pending C_fx)");
 apply(db,LC_RB,"130000 rollback");
 assert.deepEqual(state(db),s2,"130000 rollback changes no row");
 log("(c)","in-flight: sleeping/awaiting runs and pending/retry_wait/charge_pending effects intact through 150/140/130 rollbacks; "+
  "stored AI answers kept by 150000 rollback, DROPPED by 140000 rollback (incl. the charge_pending row's sent answer)");
});

const ACC3="abababab-abab-4bab-8bab-abababababab";
const BTN_DOC={version:3,name:"two choices",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"choose",image:"",contentBlocks:[],options:[
  {id:"prices",label:"prices"},{id:"support",label:"support"}]}},
 {id:"yes",data:{kind:"message",text:"prices text",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"support text",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},{source:"choose",target:"yes",sourceHandle:"prices"},
  {source:"choose",target:"no",sourceHandle:"support"}]};
// One production-approved durable button run started through the installed
// flow_begin_durable_run (awaiting_input + pending question effect), tracked as D / D_fx.
const DURABLE_SEED=`
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES('${ACC3}','${A}','instagram','instagram');
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
VALUES('${A}','btn',1,'${ACC3}','instagram','${JSON.stringify(BTN_DOC)}'::jsonb,'88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active)
VALUES('${A}','${ACC3}','instagram','btn',1,true);
UPDATE public.automation_flow_tenant_switches SET production_approved=true WHERE tenant_id='${A}';
DO $d$ DECLARE c uuid; m uuid; BEGIN
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(gen_random_uuid(),'${A}','${ACC3}','instagram:durable') RETURNING id INTO c;
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
 VALUES('${A}',c,'in','mid.durable') RETURNING id INTO m;
 INSERT INTO public.automation_message_claims(tenant_id,channel_account_id,platform,provider_event_id,
  conversation_id,inbound_message_id,route) VALUES('${A}','${ACC3}','instagram','mid.durable',c,m,'flow');
 INSERT INTO ms.ids VALUES('D_conv',c),('D_msg',m);
END $d$;`;
const DURABLE_BEGIN=(conv,msg)=>`SET ROLE service_role;
SELECT public.flow_begin_durable_run('${A}','${ACC3}','${conv}','${msg}','mid.durable','btn',1,'start','choose',1,
 'awaiting_input','{}'::jsonb,NULL,'[{"kind":"question","idempotencyKey":"q.durable","payload":{"kind":"question","text":"choose","inputMode":"buttons","choices":["prices","support"],"choiceIds":["prices","support"]}}]'::jsonb);`;

test("(c) full chain 125000 -> 180000 on one database: wrong apply orders refused, in-flight rows kept, reverse 180 -> 125 with every wrong order refused",{skip},()=>{
 const db=clone("fc");
 const preSchema=fp(db,false),s0=state(db);
 // Forward: every out-of-order apply is refused without change.
 refused(db,CC,/Durable ingress functions missing/,"170000 before 125000");
 refused(db,GD,/apply 2026102\d+_\w+ first/,"180000 before 125000");
 apply(db,DB,"125000");
 refused(db,GD,/apply 20261029130000_flow_run_lifecycle first/,"180000 before 130000");
 refused(db,CC,/apply 20261029130000_flow_run_lifecycle first/,"170000 before 130000");
 apply(db,LC);apply(db,AI);apply(db,TK);
 refused(db,CC,/apply 20261029160000_flow_credits_pause first/,"170000 before 160000");
 apply(db,CP);
 refused(db,GD,/apply 20261029170000_flow_canary_claim_durable first/,"180000 before 170000");
 apply(db,CC);apply(db,GD,"180000");
 const full=fp(db,false);
 assert.deepEqual(state(db),s0,"125000..180000 change no existing row");
 for(const sig of [BEGIN_SIG,RESUME_SIG])
  assert.match(ok(db,{sql:`SELECT obj_description('${sig}'::regprocedure,'pg_proc');`},sig),
   /^CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS previous_comment=/);
 // In flight: a durable button run started through the 180000 body.
 ok(db,{sql:DURABLE_SEED},"durable seed");
 const run=ok(db,{sql:DURABLE_BEGIN(ok(db,{sql:"SELECT ms.id('D_conv');"},"conv"),ok(db,{sql:"SELECT ms.id('D_msg');"},"msg"))},
  "begin through 180000 as service_role");
 assert.match(run,/^[0-9a-f-]{36}$/,"durable run started");
 ok(db,{sql:`INSERT INTO ms.ids SELECT 'D',id FROM public.automation_flow_runs WHERE id='${run}';
  INSERT INTO ms.ids SELECT 'D_fx',id FROM public.automation_flow_outbox WHERE run_id='${run}';`},"track D");
 const s1=state(db);
 assert.match(s1.D,/^awaiting_input\//);assert.match(s1.D_fx,/^pending\//);
 // Reverse: at every step each older rollback (and 125000's) refuses without change.
 const R=m=>new RegExp(`roll back ${m} first`),DEP=/Dependent migrations still installed/;
 const steps=[
  [GD_RB,"20261029180000_flow_durable_button_run_guards",[CC_RB,CP_RB,TK_RB,AI_RB,LC_RB,DB_RB]],
  [CC_RB,"20261029170000_flow_canary_claim_durable",[CP_RB,TK_RB,AI_RB,LC_RB]],
  [CP_RB,"20261029160000_flow_credits_pause",[TK_RB,AI_RB,LC_RB]],
  [TK_RB,"20261029150000_flow_takeover_resume",[AI_RB,LC_RB]],
  [AI_RB,"20261029140000_flow_outbox_ai_retry",[LC_RB]],
  [LC_RB,null,[]]];
 let wrong=0;
 for(const [rb,name,older] of steps){
  for(const f of older){refused(db,f,R(name),`${f} before ${rb}`);wrong++;}
  if(!older.includes(DB_RB)){refused(db,DB_RB,DEP,`125000 rollback before ${rb}`);wrong++;}
  apply(db,rb,rb);
  assert.deepEqual(state(db),s1,`${rb}: in-flight runs/effects unchanged`);
 }
 apply(db,DB_RB,"125000 rollback last");
 assert.deepEqual(state(db),s1,"125000 rollback keeps the durable run and its effect");
 assert.equal(ok(db,{sql:`SELECT to_regprocedure('${BEGIN_SIG}') IS NULL AND to_regprocedure('${RESUME_SIG}') IS NULL;`},"gone"),"t");
 assert.equal(fp(db,false),preSchema,"180 -> ... -> 125 returns to the pre-125000 schema");
 // Second cycle: re-applying the whole chain reproduces the first full-chain schema.
 for(const f of [DB,LC,AI,TK,CP,CC,GD])apply(db,f,`re-apply ${f}`);
 assert.equal(fp(db,false),full,"re-apply 125000..180000 == first apply");
 log("(c)",`full chain 125000..180000: 6 wrong apply orders and ${wrong} wrong rollback orders refused unchanged; `+
  "in-flight sleeping/awaiting/retry_wait/knowledge_ai rows and a durable button run kept through 180 -> 170 -> 160 -> 150 -> 140 -> 130 -> 125; re-apply reproduces the schema");
});

// ================================================================= (d)
function checks(db){
 const r=psql(db,{file:CHECKS,tab:true});
 assert.equal(r.status,0,r.stderr);
 return r.stdout.split("\n").map(l=>l.split("\t")).filter(c=>c.length===7)
  .map(([section,item,status,,,,detail])=>({section,item,status,detail}));
}
const FNS=["flow_lease_due_runs(integer)","flow_conversation_human_takeover(uuid,uuid)"];
const bodies=db=>Object.fromEntries(FNS.map(f=>[f,ok(db,{sql:`SELECT md5(prosrc) FROM pg_proc WHERE oid='public.${f}'::regprocedure;`},f)]));

test("(d) hazard: 130000 re-applied after 150000 silently undoes 150000; pre-deploy checks report CONFLICT",{skip},()=>{
 const db=clone("hz");
 apply(db,LC);apply(db,AI);apply(db,TK);
 const want150=Object.fromEntries(FNS.map((f,i)=>[f,md5(body(TK,["lease","takeover"][i]))]));
 const want130=Object.fromEntries(FNS.map((f,i)=>[f,md5(body(LC,["lease","takeover"][i]))]));
 assert.deepEqual(bodies(db),want150);
 assert.ok(!checks(db).some(r=>r.status.startsWith("CONFLICT")),"clean after 150000");
 // 140000 re-applied after 150000 is harmless.
 apply(db,AI,"140000 re-applied after 150000");
 assert.deepEqual(bodies(db),want150,"140000 re-apply leaves 150000 bodies");
 // A due run on a temporarily paused account stays sleeping under 150000.
 ok(db,{sql:`SELECT ms.run('P','sleeping','-5 minutes','live2','${ACC2}'); SELECT ms.fx('P_fx','P','pending');
  UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC2}';
  SELECT count(*) FROM public.flow_lease_due_runs(20);`},"paused run");
 assert.match(state(db).P,/^sleeping\/-\//);
 const r=psql(db,{file:LC,env:OPTS});
 assert.equal(r.status,0,"130000 re-apply after 150000 succeeds (passes its own preflight)");
 assert.doesNotMatch(r.stderr,/ERROR|WARNING/,"... silently");
 assert.deepEqual(bodies(db),want130,"150000 bodies replaced by the 130000 bodies");
 assert.equal(ok(db,{sql:"SELECT to_regprocedure('public.flow_end_stale_paused_runs(integer,integer)') IS NOT NULL;"},"h"),"t",
  "150000 helper functions still present: the database still looks 150000-installed");
 const rows=checks(db);
 for(const f of FNS){
  const v=rows.find(x=>x.section==="d_prerequisites"&&x.item===`function_version:public.${f}`);
  assert.equal(v?.status,`CONFLICT: public.${f} body`,f);
 }
 log("(d)","130000 after 150000: exit 0, no warning, 2/2 bodies reverted; predeploy (d) => "+
  FNS.map(f=>rows.find(x=>x.item===`function_version:public.${f}`).status).join("; "));
 // Behavioural consequence: the paused run is now ENDED instead of resuming.
 ok(db,{sql:"SELECT count(*) FROM public.flow_lease_due_runs(20);"},"tick");
 assert.match(state(db).P,/^blocked\/ineligible\//,"130000 behaviour back: paused run ended");
 assert.match(state(db).P_fx,/^cancelled\/ineligible\//);
 // Recovery: re-apply 150000.
 apply(db,TK,"150000 re-applied");
 assert.deepEqual(bodies(db),want150);
 assert.ok(!checks(db).some(x=>x.status.startsWith("CONFLICT")),"recovered");
 log("(d)","the reverted lease function ended a paused run (blocked/ineligible, effect cancelled) on the next tick; re-applying 150000 recovers the bodies (ended run stays ended)");
});
