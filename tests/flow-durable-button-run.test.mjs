// 20261029125000_flow_durable_button_run: the V3 durable Instagram start
// (flow_begin_durable_run) and button continuation (flow_resume_button_run)
// RPCs, moved from supabase/proposals/flow_durable_button_ingress.review.sql
// into the executable migration chain with byte-identical bodies.
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) built from the repo fixture chain
// and migrations 20261028220000 .. 20261028226000 (+ 130000..170000 for the
// rollback-order checks). Never connects to any remote host; inherited PG*
// variables are stripped from every client. Billing is out of scope: the two
// functions call no consume_* / credit function and none is exercised here.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const MIG="supabase/migrations/20261029125000_flow_durable_button_run.sql";
const RB="supabase/rollbacks/20261029125000_flow_durable_button_run.rollback.sql";
const PROPOSAL="supabase/proposals/flow_durable_button_ingress.review.sql";
const CC="supabase/migrations/20261029170000_flow_canary_claim_durable.sql";
const LATER=["supabase/migrations/20261029130000_flow_run_lifecycle.sql",
 "supabase/migrations/20261029140000_flow_outbox_ai_retry.sql",
 "supabase/migrations/20261029150000_flow_takeover_resume.sql",
 "supabase/migrations/20261029160000_flow_credits_pause.sql",CC];
const LATER_RB=["supabase/rollbacks/20261029170000_flow_canary_claim_durable.rollback.sql",
 "supabase/rollbacks/20261029160000_flow_credits_pause.rollback.sql",
 "supabase/rollbacks/20261029150000_flow_takeover_resume.rollback.sql",
 "supabase/rollbacks/20261029140000_flow_outbox_ai_retry.rollback.sql",
 "supabase/rollbacks/20261029130000_flow_run_lifecycle.rollback.sql"];
const MARK="CREATED_BY_20261029125000_FLOW_DURABLE_BUTTON_RUN";
const BEGIN_SIG="public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)";
const RESUME_SIG="public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)";
const src=f=>readFileSync(f,"utf8");
const md5=x=>createHash("md5").update(x).digest("hex");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");
// Proposal body: text between "AS $tag$" and "$tag$"; migration body: ":= $tag$".
const between=(s,open,close)=>{const a=s.indexOf(open);assert.ok(a>=0,open);const b=a+open.length;return s.slice(b,s.indexOf(close,b));};
const propBody=tag=>between(src(PROPOSAL),`AS $${tag}$`,`$${tag}$`);
const migBody=tag=>between(src(MIG),`:= $${tag}$`,`$${tag}$`);

// ---------------------------------------------------------------- static
test("version sorts after every dependency and before every migration that requires the functions",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 assert.equal(stamps.filter(s=>s==="20261029125000").length,1);
 for(const dep of ["20261028220000","20261028225000","20261028226000","20261029122000"])
  assert.ok(stamps.includes(dep)&&dep<"20261029125000",dep);
 // 20261029180000_flow_durable_button_run_guards replaces these bodies (tests/flow-durable-button-run-guards.test.mjs);
 // 20261029190000_flow_begin_durable_run_superseding only calls begin (tests/flow-begin-durable-run-superseding.test.mjs).
 // 20261029200000_flow_media_storage is an independent storage bucket (no flow object).
 // 20261029210000_flow_media_effects requires the 130000..190000 chain (tests/flow-media-effects.test.mjs).
 // 20261029220000_flow_media_stale_sweep requires 210000 (tests/flow-media-stale-sweep.test.mjs).
 for(const s of stamps)if(s>"20261029125000")assert.ok(["20261029130000","20261029140000","20261029150000",
  "20261029160000","20261029170000","20261029180000","20261029190000","20261029200000","20261029210000",
  "20261029220000"].includes(s),
  `only the unapplied 130000..220000 follow: ${s}`);
 // 170000 still names the proposal in its message; the requirement itself is existence of both functions.
 const cc=src(CC);
 assert.ok(cc.includes(`to_regprocedure('${BEGIN_SIG}') IS NULL`)&&cc.includes(`to_regprocedure('${RESUME_SIG}') IS NULL`));
});
test("bodies and headers are byte-identical to the proposal (no semantic change)",()=>{
 for(const tag of ["begin","resume"])assert.equal(migBody(tag),propBody(tag),tag);
 for(const [name,tag] of [["flow_begin_durable_run","begin"],["flow_resume_button_run","resume"]]){
  const p=between(src(PROPOSAL),`CREATE FUNCTION public.${name}(`,`\nAS $${tag}$`);
  const m=between(src(MIG),`$head$CREATE OR REPLACE FUNCTION public.${name}(`,`\nAS $head$`);
  assert.equal(m,p,`${name}: signature, argument names, result, SECURITY INVOKER, search_path`);
  assert.match(m,/LANGUAGE plpgsql SECURITY INVOKER SET search_path=''$/);
 }
 // Same REVOKE/GRANT statements as the proposal.
 const grants=f=>(src(f).match(/^(REVOKE|GRANT)[^;]*;/gm)??[]).join("\n");
 assert.equal(grants(MIG),grants(PROPOSAL));
});
test("migration: bounded, one transaction, no data change, service_role only, no billing/V2/publication objects",()=>{
 const m=src(MIG),code=noComments(m);
 assert.match(m,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m);
 assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1);assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1);
 assert.doesNotMatch(code,/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+public\.|\bALTER\s+TABLE\b|CREATE\s+(UNIQUE\s+)?INDEX/i);
 // The only INSERTs are inside the function bodies (identical to the proposal).
 const outside=code.replace(/\$begin\$[\s\S]*?\$begin\$/,"").replace(/\$resume\$[\s\S]*?\$resume\$/,"");
 assert.doesNotMatch(outside,/\bINSERT\b/i);
 assert.doesNotMatch(code,/SECURITY DEFINER|\bTO\s+(anon|authenticated|PUBLIC)\b|CREATE POLICY|CONCURRENTLY/i);
 assert.doesNotMatch(code,/consume_|credits|wayl|topup|cron\.|vault\.|net\.http_/i);
 assert.doesNotMatch(code,/flow_claim_inbound|flow_publish_revision|flow_activate_revision|flow_deactivate_revision/);
 assert.match(code,/v_marker constant text := 'CREATED_BY_20261029125000_FLOW_DURABLE_BUTTON_RUN'/);
 assert.match(code,/refusing to overwrite/);
});
test("rollback: bounded, guarded by the 130000..170000 markers, drops only marker-owned functions",()=>{
 const r=src(RB),code=noComments(r);
 assert.match(r,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m);
 for(const m of ["130000_FLOW_RUN_LIFECYCLE","140000_FLOW_OUTBOX_AI_RETRY","150000_FLOW_TAKEOVER_RESUME",
  "160000_FLOW_CREDITS_PAUSE","170000_FLOW_CANARY_CLAIM_DURABLE"])assert.ok(code.includes(`'CREATED_BY_20261029${m}'`),m);
 assert.match(code,/obj_description\(v_fn,'pg_proc'\) IS DISTINCT FROM v_marker/);
 assert.equal((code.match(/DROP FUNCTION/g)??[]).length,1);
 assert.doesNotMatch(code,/DROP INDEX|DELETE|UPDATE|TRUNCATE|flow_one_awaiting_input_per_conversation/);
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
function psql(db,{file,sql,env,role}={}){
 const a=pargs(db);
 if(file)a.push("-f",file);
 const input=sql===undefined?undefined:(role?`SET ROLE ${role};\n`:"")+sql;
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input,env:clientEnv(env),maxBuffer:1<<26});
}
function psqlAsync(db,sql){
 return new Promise(res=>{
  const p=spawn(join(BIN,"psql"),pargs(db),{env:clientEnv()});
  let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
  p.on("close",code=>res({code,out,err}));p.stdin.end(sql);
 });
}
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
function fails(db,sql,code,label,role,re){
 const r=psql(db,{sql,role});
 assert.notEqual(r.status,0,`${label} must fail`);
 assert.equal(sqlState(r.stderr),code,`${label}: ${r.stderr}`);
 if(re)assert.match(r.stderr,re,label);
}
const FP=data=>`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||
  coalesce(p.proacl::text,'')||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||pg_get_function_result(p.oid)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')||':'||c.relrowsecurity
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'i:'||pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'c:'||a.attrelid::regclass::text||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v') AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 't:'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text FROM pg_trigger t WHERE NOT t.tgisinternal
 ${data?`UNION ALL SELECT 'd:'||c.oid::regclass::text||':'||md5(query_to_xml(
   format('SELECT t::text AS v FROM %s t ORDER BY 1',c.oid::regclass),false,false,'')::text)
  FROM pg_class c WHERE c.relkind IN('r','p') AND c.relnamespace='public'::regnamespace`:""}
) s(x);`;
const fp=(db,data=true)=>ok(db,{sql:FP(data)},"fingerprint").out;
function refused(db,file,re,label){
 const before=fp(db);
 const r=psql(db,{file});
 assert.notEqual(r.status,0,`${label} must be refused`);
 assert.match(r.stderr,re,label);
 assert.equal(fp(db),before,`${label}: refused without any change`);
}

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111";  // tenant A instagram (fixture)
const ACC2="dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // tenant A, second instagram account
const ACCB="cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // tenant B instagram
const FBB="22222222-2222-4222-8222-222222222222";  // tenant B facebook (fixture)
const doc={version:3,name:"two choices",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"choose",image:"",contentBlocks:[],options:[
  {id:"prices",label:"prices"},{id:"support",label:"support"}]}},
 {id:"yes",data:{kind:"message",text:"prices text",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"support text",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},{source:"choose",target:"yes",sourceHandle:"prices"},
  {source:"choose",target:"no",sourceHandle:"support"}]};
const J=o=>`'${JSON.stringify(o).replace(/'/g,"''")}'::jsonb`;
// Production live-only columns (as in tests/flow-canary-claim-durable.test.mjs).
const LIVE=`
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,ADD COLUMN auto_reply boolean NOT NULL DEFAULT true;
ALTER TABLE public.conversations ADD COLUMN transferred boolean NOT NULL DEFAULT false,
 ADD COLUMN auto_paused_reason text,ADD COLUMN human_agent_expires_at timestamptz;
ALTER TABLE public.automation_flow_tenant_switches
 ADD COLUMN production_approved boolean NOT NULL DEFAULT false;`;
const CHAIN=["tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
 "tests/sql/flow-exclusive-claim-bootstrap.sql","@LIVE","supabase/migrations/20261028220000_webhook_exclusive_claim.sql",
 "supabase/migrations/20261028224000_delivery_attempts.sql","supabase/migrations/20261028225000_flow_runtime_advance.sql",
 "supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql"];
const SEED=`
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES
 ('${ACC2}','${A}','instagram','instagram'),('${ACCB}','${B}','instagram','instagram');
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by) VALUES
 ('${A}','buttons',1,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${A}','other',1,'${ACC2}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${B}','bflow',1,'${ACCB}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${B}','bfb',1,'${FBB}','facebook',${J(doc)},'88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active) VALUES
 ('${A}','${ACC}','instagram','buttons',1,true),('${A}','${ACC2}','instagram','other',1,true),
 ('${B}','${ACCB}','instagram','bflow',1,true),('${B}','${FBB}','facebook','bfb',1,true);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved)
VALUES('${A}',true,false,true),('${B}',true,false,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
CREATE SCHEMA t;
-- One inbound event = conversation + persisted inbound message + route='flow' claim
-- (what milan-api and the claim function write before the durable RPCs run).
CREATE TABLE t.e(name text PRIMARY KEY,tenant uuid,acc uuid,platform text,conv uuid,msg uuid,mid text);
CREATE FUNCTION t.ev(p_name text,p_tenant uuid,p_acc uuid,p_conv uuid DEFAULT NULL,p_platform text DEFAULT 'instagram')
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid:=p_conv; m uuid;
BEGIN
 IF c IS NULL THEN
  INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
  VALUES(gen_random_uuid(),p_tenant,p_acc,p_platform||':'||gen_random_uuid()) RETURNING id INTO c;
 END IF;
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
 VALUES(p_tenant,c,'in','mid.'||p_name) RETURNING id INTO m;
 INSERT INTO public.automation_message_claims(tenant_id,channel_account_id,platform,provider_event_id,
  conversation_id,inbound_message_id,route)
 VALUES(p_tenant,p_acc,p_platform,'mid.'||p_name,c,m,'flow');
 INSERT INTO t.e VALUES(p_name,p_tenant,p_acc,p_platform,c,m,'mid.'||p_name);
END $f$;
ANALYZE;`;
const SR="service_role";
const Q_EFFECT=k=>`[{"kind":"question","idempotencyKey":"q.${k}","payload":{"kind":"question","text":"choose","inputMode":"buttons","choices":["prices","support"],"choiceIds":["prices","support"]}}]`;
const M_EFFECT=(k,text)=>`[{"kind":"message","idempotencyKey":"m.${k}","payload":{"kind":"message","text":"${text}"}}]`;
const lit=v=>v===null?"NULL":`'${String(v).replace(/'/g,"''")}'`;
// SQL text of a begin call for event e, any argument overridable.
function beginSql(e,o={}){
 const a={tenant:e.tenant,acc:e.acc,conv:e.conv,msg:e.msg,mid:e.mid,flow:"buttons",rev:1,start:"start",next:"choose",
  step:1,status:"awaiting_input",vars:"{}",wake:null,effects:Q_EFFECT(e.name),...o};
 return `SELECT public.flow_begin_durable_run(${lit(a.tenant)},${lit(a.acc)},${lit(a.conv)},${lit(a.msg)},${lit(a.mid)},`+
  `${lit(a.flow)},${a.rev===null?"NULL":a.rev},${lit(a.start)},${lit(a.next)},${a.step===null?"NULL":a.step},${lit(a.status)},`+
  `${a.vars===null?"NULL":lit(a.vars)+"::jsonb"},${a.wake===null?"NULL":lit(a.wake)+"::timestamptz"},${a.effects===null?"NULL":lit(a.effects)+"::jsonb"})`;
}
function resumeSql(run,e,o={}){
 const a={tenant:e.tenant,run,mid:e.mid,msg:e.msg,expStep:1,expNode:"choose",next:"yes",step:2,status:"completed",
  vars:"{}",wake:null,effects:M_EFFECT(e.name,"prices text"),...o};
 return `SELECT public.flow_resume_button_run(${lit(a.tenant)},${lit(a.run)},${lit(a.mid)},${lit(a.msg)},`+
  `${a.expStep===null?"NULL":a.expStep},${lit(a.expNode)},${lit(a.next)},${a.step},${lit(a.status)},`+
  `${a.vars===null?"NULL":lit(a.vars)+"::jsonb"},${a.wake===null?"NULL":lit(a.wake)+"::timestamptz"},${a.effects===null?"NULL":lit(a.effects)+"::jsonb"})`;
}
const mk=(db,name,tenant=A,acc=ACC,conv=null,platform="instagram")=>{
 ok(db,{sql:`SELECT t.ev('${name}','${tenant}','${acc}',${conv?`'${conv}'`:"NULL"},'${platform}');`},`event ${name}`);
 return rows(db,`SELECT * FROM t.e WHERE name='${name}'`)[0];
};
const begin=(db,e,o)=>val(db,beginSql(e,o).replace(/^SELECT /,""),SR);
const resume=(db,run,e,o)=>val(db,resumeSql(run,e,o).replace(/^SELECT /,""),SR);
const count=(db,tbl,where="true")=>Number(val(db,`SELECT count(*) FROM public.${tbl} WHERE ${where}`));
const runRow=(db,run)=>rows(db,`SELECT run_status,current_node_id,step_count,conversation_id,channel_account_id,provider_event_id
 FROM public.automation_flow_runs WHERE id='${run}'`)[0];

function buildBase(){
 ok("postgres",{sql:"CREATE DATABASE base;"},"createdb");
 ok("base",{sql:src("tests/sql/fixtures/flow-live-shape-bootstrap.sql")},"live shape");
 for(const f of CHAIN)ok("base",f==="@LIVE"?{sql:LIVE}:{file:f},f);
 ok("base",{sql:SEED},"seed");
 ok("postgres",{sql:"CREATE DATABASE inst TEMPLATE base;"},"inst");
 ok("inst",{file:MIG},"125000");
}
before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-button-run-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+67)%20000);
 let r=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(r.status,0,r.stderr);
 r=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off`,"start"]);
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
function clone(prefix,template="inst"){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},`clone ${db}`);
 return db;
}

test("(1) durable run creation: receipt, run awaiting_input at the question, one question effect, one metric",{skip},()=>{
 const db=clone("begin");
 const e=mk(db,"b1");
 const run=begin(db,e);
 assert.match(String(run),/^[0-9a-f-]{36}$/);
 assert.deepEqual(runRow(db,run),{run_status:"awaiting_input",current_node_id:"choose",step_count:1,
  conversation_id:e.conv,channel_account_id:ACC,provider_event_id:e.mid});
 assert.deepEqual(rows(db,`SELECT tenant_id,channel_account_id,platform FROM public.automation_flow_event_receipts WHERE provider_event_id='${e.mid}'`),
  [{tenant_id:A,channel_account_id:ACC,platform:"instagram"}]);
 assert.deepEqual(rows(db,`SELECT tenant_id,effect_kind,idempotency_key,delivery_status,payload->'choiceIds' AS ids
  FROM public.automation_flow_outbox WHERE run_id='${run}'`),
  [{tenant_id:A,effect_kind:"question",idempotency_key:"q.b1",delivery_status:"pending",ids:["prices","support"]}]);
 assert.deepEqual(rows(db,`SELECT event_key FROM public.automation_flow_metrics WHERE run_id='${run}'`),[{event_key:"started"}]);
});

test("(2) valid button resumption moves the run to the chosen branch with its effect, once",{skip},()=>{
 const db=clone("resume");
 for(const [name,branch,text] of [["y","yes","prices text"],["n","no","support text"]]){
  const e=mk(db,`r${name}`);
  const run=begin(db,e);
  const tap=mk(db,`r${name}tap`,A,ACC,e.conv);
  assert.equal(resume(db,run,tap,{next:branch,effects:M_EFFECT(tap.name,text)}),true,branch);
  assert.deepEqual(runRow(db,run),{run_status:"completed",current_node_id:branch,step_count:2,
   conversation_id:e.conv,channel_account_id:ACC,provider_event_id:e.mid});
  assert.deepEqual(rows(db,`SELECT effect_kind,payload->>'text' AS text FROM public.automation_flow_outbox
   WHERE run_id='${run}' ORDER BY effect_kind`),[{effect_kind:"message",text},{effect_kind:"question",text:"choose"}]);
  assert.equal(count(db,"automation_flow_event_receipts",`provider_event_id='${tap.mid}'`),1);
  assert.deepEqual(rows(db,`SELECT event_key FROM public.automation_flow_metrics WHERE run_id='${run}' ORDER BY event_key`),
   [{event_key:"button"},{event_key:"started"}]);
 }
 // A question can lead to another question (still awaiting_input) on the same run.
 const e=mk(db,"chain");const run=begin(db,e);const tap=mk(db,"chaintap",A,ACC,e.conv);
 assert.equal(resume(db,run,tap,{next:"choose",step:2,status:"awaiting_input",effects:Q_EFFECT("chain2")}),true);
 assert.deepEqual([runRow(db,run).run_status,runRow(db,run).step_count],["awaiting_input",2]);
});

test("(3) cross-tenant, wrong account/platform/conversation, unknown run and forged ids: refused, no side effects",{skip},()=>{
 const db=clone("iso");
 const e=mk(db,"i1");                         // tenant A, ACC
 const eb=mk(db,"ib",B,ACCB);                 // tenant B, instagram
 const efb=mk(db,"ifb",B,FBB,null,"facebook"); // tenant B, facebook claim
 const e2=mk(db,"i2",A,ACC2);                 // tenant A, second account
 const forgedUuid="99999999-9999-4999-8999-999999999999";
 const noChange=(label,fn,expect)=>{
  const before=fp(db);
  assert.equal(fn(),expect,label);
  assert.equal(fp(db),before,`${label}: no row written`);
 };
 // begin refusals (NULL)
 noChange("cross-tenant (B claims A's event)",()=>begin(db,e,{tenant:B}),null);
 noChange("cross-tenant account (A with B's account)",()=>begin(db,e,{acc:ACCB}),null);
 noChange("wrong account of the same tenant",()=>begin(db,e,{acc:ACC2,flow:"other"}),null);
 noChange("wrong conversation (B's conversation)",()=>begin(db,e,{conv:eb.conv}),null);
 noChange("wrong conversation (A's other conversation)",()=>begin(db,e,{conv:e2.conv}),null);
 noChange("forged inbound id",()=>begin(db,e,{msg:forgedUuid}),null);
 noChange("inbound of another event",()=>begin(db,e,{msg:e2.msg}),null);
 noChange("forged provider event id",()=>begin(db,e,{mid:"mid.forged"}),null);
 noChange("wrong platform (facebook claim)",()=>begin(db,efb,{flow:"bfb"}),null);
 noChange("flow of another account",()=>begin(db,e,{flow:"other"}),null);
 noChange("flow of another tenant",()=>begin(db,e,{flow:"bflow"}),null);
 noChange("unpublished revision",()=>begin(db,e,{rev:2}),null);
 noChange("start node is not the trigger",()=>begin(db,e,{start:"choose"}),null);
 for(const [label,sql] of [
  ["global switch off","UPDATE public.automation_flow_global_switch SET enabled=false"],
  ["tenant not production_approved",`UPDATE public.automation_flow_tenant_switches SET production_approved=false WHERE tenant_id='${A}'`],
  ["activation inactive",`UPDATE public.automation_flow_activations SET is_active=false WHERE tenant_id='${A}' AND flow_key='buttons'`],
  ["account agent disabled",`UPDATE public.channel_accounts SET agent_enabled=false WHERE id='${ACC}'`],
  ["account auto_reply off",`UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}'`],
  ["tenant inactive",`UPDATE public.tenants SET is_active=false WHERE id='${A}'`]]){
  const d=clone("isoflag",db);
  ok(d,{sql},label);
  const before=fp(d);
  assert.equal(begin(d,e),null,label);
  assert.equal(fp(d),before,`${label}: no row written`);
 }
 // A legitimate run, then resume refusals (false)
 const run=begin(db,e);
 assert.match(String(run),/^[0-9a-f-]{36}$/);
 const tap=mk(db,"i1tap",A,ACC,e.conv);
 const tapOther=mk(db,"i1other",A,ACC);       // same tenant/account, other conversation
 const tapB=mk(db,"ibtap",B,ACCB,eb.conv);
 noChange("cross-tenant resume of A's run by B",()=>resume(db,run,tapB,{tenant:B}),false);
 noChange("B's tenant with A's tap",()=>resume(db,run,tap,{tenant:B}),false);
 noChange("unknown run",()=>resume(db,forgedUuid,tap),false);
 noChange("tap from another conversation",()=>resume(db,run,tapOther),false);
 noChange("tap claimed on another account (A/ACC2)",()=>resume(db,run,e2),false);
 noChange("forged tap inbound id",()=>resume(db,run,tap,{msg:forgedUuid}),false);
 noChange("tap inbound of another event",()=>resume(db,run,tap,{msg:tapOther.msg}),false);
 noChange("unclaimed tap event id",()=>resume(db,run,tap,{mid:"mid.unclaimed"}),false);
 noChange("wrong expected step",()=>resume(db,run,tap,{expStep:0}),false);
 noChange("wrong expected node",()=>resume(db,run,tap,{expNode:"yes"}),false);
 const off=clone("isooff",db);
 ok(off,{sql:"UPDATE public.automation_flow_global_switch SET enabled=false"},"off");
 let before=fp(off);assert.equal(resume(off,run,tap),false,"global off");assert.equal(fp(off),before);
 const inact=clone("isoinact",db);
 ok(inact,{sql:`UPDATE public.automation_flow_activations SET is_active=false WHERE tenant_id='${A}' AND flow_key='buttons'`},"inactive");
 before=fp(inact);assert.equal(resume(inact,run,tap),false,"revision inactive");assert.equal(fp(inact),before);
 // Still resumable by the legitimate tap.
 assert.equal(resume(db,run,tap),true);
});

test("(4) duplicates: same begin twice, same resume twice, concurrent begin/resume, stale button",{skip},async()=>{
 const db=clone("dup");
 const e=mk(db,"d1");
 const run=begin(db,e);
 assert.equal(begin(db,e),null,"same provider event never starts twice");
 assert.equal(begin(db,e,{effects:Q_EFFECT("other-key")}),null,"even with other effect keys");
 assert.equal(count(db,"automation_flow_runs",`provider_event_id='${e.mid}'`),1);
 assert.equal(count(db,"automation_flow_outbox",`run_id='${run}'`),1);
 const tap=mk(db,"d1tap",A,ACC,e.conv);
 assert.equal(resume(db,run,tap),true);
 assert.equal(resume(db,run,tap),false,"replayed tap");
 // Stale button: a second (claimed) tap planned against the old step/node.
 const stale=mk(db,"d1stale",A,ACC,e.conv);
 const before=fp(db);
 assert.equal(resume(db,run,stale),false,"stale button on a completed run");
 assert.equal(resume(db,run,stale,{expStep:2,expNode:"yes"}),false,"completed run never re-opens");
 assert.equal(fp(db),before,"stale taps write nothing");
 assert.equal(count(db,"automation_flow_outbox",`run_id='${run}'`),2);
 assert.equal(count(db,"automation_flow_metrics",`run_id='${run}' AND event_key='button'`),1);

 // Concurrent begin of the same event: exactly one run, one effect, one receipt.
 const c=mk(db,"c1");
 const s1=psqlAsync(db,`SET ROLE ${SR};\nBEGIN;\n${beginSql(c)};\nSELECT pg_sleep(1.5);\nCOMMIT;\n`);
 await new Promise(r=>setTimeout(r,400));
 const s2=psqlAsync(db,`SET ROLE ${SR};\n${beginSql(c)};\n`);
 const [r1,r2]=await Promise.all([s1,s2]);
 assert.equal(r1.code,0,r1.err);assert.equal(r2.code,0,r2.err);
 const ids=[r1.out,r2.out].map(o=>(o.match(/[0-9a-f-]{36}/)??[null])[0]);
 assert.equal(ids.filter(Boolean).length,1,`exactly one winner: ${JSON.stringify([r1.out,r2.out])}`);
 assert.ok(ids[0],"the first session (holding the receipt) wins; the waiter gets NULL");
 assert.equal(count(db,"automation_flow_runs",`provider_event_id='${c.mid}'`),1);
 assert.equal(count(db,"automation_flow_event_receipts",`provider_event_id='${c.mid}'`),1);
 assert.equal(count(db,"automation_flow_outbox",`run_id='${ids[0]}'`),1);

 // Concurrent resume of the same run by two different claimed taps: one transition.
 const crun=ids[0];
 const t1=mk(db,"c1t1",A,ACC,c.conv),t2=mk(db,"c1t2",A,ACC,c.conv);
 const q1=psqlAsync(db,`SET ROLE ${SR};\nBEGIN;\n${resumeSql(crun,t1)};\nSELECT pg_sleep(1.5);\nCOMMIT;\n`);
 await new Promise(r=>setTimeout(r,400));
 const q2=psqlAsync(db,`SET ROLE ${SR};\n${resumeSql(crun,t2,{next:"no",effects:M_EFFECT("c1t2","support text")})};\n`);
 const [w1,w2]=await Promise.all([q1,q2]);
 assert.equal(w1.code,0,w1.err);assert.equal(w2.code,0,w2.err);
 assert.deepEqual([w1.out.split("\n")[0],w2.out.split("\n")[0]],["t","f"],"lock holder wins; the waiter re-checks and refuses");
 assert.deepEqual([runRow(db,crun).current_node_id,runRow(db,crun).step_count],["yes",2]);
 assert.equal(count(db,"automation_flow_outbox",`run_id='${crun}' AND effect_kind='message'`),1);
 assert.equal(count(db,"automation_flow_event_receipts",`provider_event_id='${t2.mid}'`),0,"loser leaves no receipt");
 assert.equal(count(db,"automation_flow_metrics",`run_id='${crun}' AND event_key='button'`),1);
});

test("(5) failing step / invalid payload: clean refusal or full rollback, never partial rows",{skip},()=>{
 const db=clone("atomic");
 const e=mk(db,"a1");
 const noRows=label=>{
  assert.equal(count(db,"automation_flow_event_receipts",`provider_event_id='${e.mid}'`),0,`${label}: receipt rolled back`);
  assert.equal(count(db,"automation_flow_runs",`provider_event_id='${e.mid}'`),0,`${label}: run rolled back`);
  assert.equal(count(db,"automation_flow_outbox","true"),0,`${label}: no effect`);
  assert.equal(count(db,"automation_flow_metrics","true"),0,`${label}: no metric`);
 };
 const before=fp(db);
 // Argument validation: refused before any write (NULL).
 for(const [label,o] of [["NULL effects",{effects:null}],["step 0",{step:0}],["empty event id",{mid:""}],
  ["NULL revision",{rev:null}],["NULL next node",{next:null}]]){
  assert.equal(begin(db,e,o),null,label);noRows(label);
 }
 // The first step is rejected by flow_commit_run_step after receipt+run were written:
 // the function raises and the whole transaction (receipt, run, effects) rolls back.
 const second=JSON.stringify([JSON.parse(Q_EFFECT("ok"))[0],{kind:"bogus",idempotencyKey:"x",payload:{}}]);
 const six=JSON.stringify(Array.from({length:6},(_,i)=>({kind:"message",idempotencyKey:`k${i}`,payload:{kind:"message",text:"x"}})));
 for(const [label,o] of [["unknown effect kind after a valid effect",{effects:second}],["effects not an array",{effects:"{}"}],
  ["more than 5 effects",{effects:six}],["invalid status",{status:"bogus"}],["NULL variables",{vars:null}],
  ["sleeping without wake time",{status:"sleeping"}],["variables not an object",{vars:"[]"}]]){
  fails(db,beginSql(e,o)+";","P0001",label,SR,/First durable step rejected; atomic rollback required/);
  noRows(label);
 }
 assert.equal(fp(db),before,"database unchanged by every rejected begin");
 // Then the same event still starts normally (the receipt was rolled back).
 const run=begin(db,e);
 assert.match(String(run),/^[0-9a-f-]{36}$/);
 // Resume: rejected transition rolls back the tap receipt; the run keeps waiting.
 const tap=mk(db,"a1tap",A,ACC,e.conv);
 const mid=fp(db);
 for(const [label,o] of [["unknown effect kind",{effects:'[{"kind":"bogus","idempotencyKey":"z","payload":{}}]'}],
  ["step not increasing",{step:1}],["invalid status",{status:"bogus"}],["effects not an array",{effects:"{}"}]]){
  fails(db,resumeSql(run,tap,o)+";","P0001",label,SR,/Button transition rejected; rollback receipt/);
  assert.equal(fp(db),mid,`${label}: no partial row`);
 }
 for(const [label,o] of [["NULL expected step",{expStep:null}],["NULL next",{next:null}],["empty event",{mid:""}]]){
  assert.equal(resume(db,run,tap,o),false,label);assert.equal(fp(db),mid,label);
 }
 assert.equal(runRow(db,run).run_status,"awaiting_input");
 assert.equal(resume(db,run,tap),true,"the same tap succeeds after the failed attempts");
 // Live-only column missing: the call errors (fails closed) and writes nothing.
 const nocol=clone("nocol","base");
 ok(nocol,{sql:"ALTER TABLE public.channel_accounts DROP COLUMN agent_enabled;"},"drop live column");
 const w=ok(nocol,{file:MIG},"125000 with a live-only column absent");
 assert.match(w.err,/WARNING: .*live-only column\(s\) absent: public\.channel_accounts\.agent_enabled/);
 const en=mk(nocol,"nc");const nb=fp(nocol);
 fails(nocol,beginSql(en)+";","42703","missing live column",SR);
 assert.equal(fp(nocol),nb,"nothing written");
});

test("(6) privileges: only service_role may execute; SECURITY INVOKER; search_path pinned",{skip},()=>{
 const db=clone("acl");
 for(const sig of [BEGIN_SIG,RESUME_SIG]){
  for(const role of ["anon","authenticated","public"])
   assert.equal(val(db,`SELECT has_function_privilege('${role}','${sig}','EXECUTE')`),false,`${role} ${sig}`);
  assert.equal(val(db,`SELECT has_function_privilege('service_role','${sig}','EXECUTE')`),true,sig);
  assert.deepEqual(rows(db,`SELECT prosecdef,proconfig,obj_description(oid,'pg_proc') AS marker,
   (SELECT lanname FROM pg_language l WHERE l.oid=prolang) AS lang FROM pg_proc WHERE oid='${sig}'::regprocedure`),
   [{prosecdef:false,proconfig:['search_path=""'],marker:MARK,lang:"plpgsql"}]);
  assert.doesNotMatch(val(db,`SELECT coalesce(proacl::text,'') FROM pg_proc WHERE oid='${sig}'::regprocedure`),/(^|[{,])(=|anon=|authenticated=)/);
 }
 const e=mk(db,"p1");
 for(const role of ["anon","authenticated"]){
  fails(db,beginSql(e)+";","42501",`${role} begin`,role);
  fails(db,resumeSql("99999999-9999-4999-8999-999999999999",e)+";","42501",`${role} resume`,role);
 }
 assert.equal(count(db,"automation_flow_runs","true"),0);
 // search_path='' : a hostile schema earlier in the caller's search_path is never used.
 ok(db,{sql:`CREATE SCHEMA evil; GRANT USAGE ON SCHEMA evil TO service_role;
  CREATE TABLE evil.automation_flow_runs(id uuid); GRANT ALL ON evil.automation_flow_runs TO service_role;`},"evil");
 const r=psql(db,{sql:`SET search_path=evil,public;\n${beginSql(e)};`,role:SR});
 assert.equal(r.status,0,r.stderr);
 const run=(r.stdout.match(/[0-9a-f-]{36}/)??[null])[0];
 assert.match(String(run),/^[0-9a-f-]{36}$/);
 assert.equal(count(db,"automation_flow_runs",`id='${run}'`),1);
 assert.equal(Number(val(db,"SELECT count(*) FROM evil.automation_flow_runs")),0);
});

// Proposal CREATE statement of one function (optionally edited) without the marker.
const proposalCreate=(name,tag,edit=s=>s)=>{
 const s=src(PROPOSAL),a=s.indexOf(`CREATE FUNCTION public.${name}(`);
 const open=`AS $${tag}$`,close=`$${tag}$;`;
 const end=s.indexOf(close,s.indexOf(open,a)+open.length)+close.length;
 return edit(s.slice(a,end));
};
const hasFn=(db,sig)=>val(db,`SELECT to_regprocedure('${sig}') IS NOT NULL`);
const marker=(db,sig)=>val(db,`SELECT obj_description(to_regprocedure('${sig}'),'pg_proc')`);

test("(7) migration: idempotent, preflight refusals, refuses a differing body, rollback ownership, re-apply",{skip},()=>{
 const db=clone("mig","base");
 const pre=fp(db);
 let r=ok(db,{file:RB},"rollback before apply");
 assert.match(r.err,/0 owned function\(s\) dropped/);assert.equal(fp(db),pre,"rollback with nothing owned is a no-op");
 ok(db,{file:MIG},"apply");
 const once=fp(db,false);
 r=ok(db,{file:MIG},"re-apply");
 assert.match(r.err,new RegExp(`already installed with the identical definition \\(marker=${MARK}\\); left unchanged`));
 assert.equal(fp(db,false),once,"re-apply is a no-op");
 ok(db,{file:RB},"rollback");
 assert.equal(fp(db),pre,"rollback restores the exact pre-125000 schema and data");
 ok(db,{file:MIG},"re-apply after rollback");
 assert.equal(fp(db,false),once,"re-apply after rollback reproduces the schema");

 // Preflight refusals: nothing is created.
 const COMMIT_SIG="public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)";
 for(const [label,sql,re] of [
  ["flow_commit_run_step missing",`DROP FUNCTION ${COMMIT_SIG};`,/apply 20261028225000_flow_runtime_advance first/],
  ["flow_commit_run_step without the 225000 marker",`COMMENT ON FUNCTION ${COMMIT_SIG} IS NULL;`,/apply 20261028225000_flow_runtime_advance first/],
  ["claims table without the 220000 marker","COMMENT ON TABLE public.automation_message_claims IS NULL;",/apply 20261028220000_webhook_exclusive_claim first/],
  ["receipts table missing","ALTER TABLE public.automation_flow_event_receipts RENAME TO receipts_x;",/prerequisite missing: table public\.automation_flow_event_receipts/],
  ["column missing","ALTER TABLE public.messages RENAME COLUMN wa_message_id TO w;",/prerequisite missing: column public\.messages\.wa_message_id/],
  ["receipt idempotency key missing","ALTER TABLE public.automation_flow_event_receipts DROP CONSTRAINT automation_flow_event_receipts_pkey CASCADE;",
   /no unique \(tenant_id,channel_account_id,platform,provider_event_id\) key/]]){
  const d=clone("pf","base");
  ok(d,{sql},label);
  refused(d,MIG,re,label);
  assert.equal(hasFn(d,BEGIN_SIG)||hasFn(d,RESUME_SIG),false,label);
 }
 // Existing definitions that differ are never overwritten.
 const P=(name,tag,edit)=>proposalCreate(name,tag,edit);
 for(const [label,sql,re] of [
  ["different body",`CREATE FUNCTION public.flow_resume_button_run(p_tenant uuid,p_run uuid,p_event text,p_inbound uuid,
   p_expect_step integer,p_expect_node text,p_next text,p_next_step integer,p_status text,p_variables jsonb,
   p_wake timestamptz,p_effects jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
   AS $x$BEGIN RETURN true; END$x$;`,/Existing public\.flow_resume_button_run\(.*\) differs .*refusing to overwrite/],
  ["identical body but SECURITY DEFINER",P("flow_resume_button_run","resume",s=>s.replace("SECURITY INVOKER","SECURITY DEFINER")),/differs .*refusing to overwrite/],
  ["identical body but another search_path",P("flow_begin_durable_run","begin",s=>s.replace("SET search_path=''","SET search_path=public")),/differs .*refusing to overwrite/],
  ["identical body, renamed argument",P("flow_begin_durable_run","begin",s=>s.replace("p_effects jsonb\n)","p_fx jsonb\n)").replace(/OR p_effects IS NULL/,"OR p_fx IS NULL")),/differs/],
  ["one-character body change",P("flow_resume_button_run","resume",s=>s.replace("length(p_event) NOT BETWEEN 1 AND 256","length(p_event) NOT BETWEEN 1 AND 255")),/differs .*refusing to overwrite/],
  ["foreign overload","CREATE FUNCTION public.flow_begin_durable_run(uuid) RETURNS uuid LANGUAGE sql AS 'SELECT $1';",/Unrecognized overload of public\.flow_begin_durable_run/]]){
  const d=clone("diff","base");
  ok(d,{sql},label);
  refused(d,MIG,re,label);
 }
 // Pre-installed from the proposal (production case): left unchanged, never dropped by the rollback.
 const p=clone("preinst","base");
 ok(p,{file:PROPOSAL},"proposal");
 const fpP=fp(p);
 r=ok(p,{file:MIG},"125000 over the proposal");
 assert.equal((r.err.match(/already installed with the identical definition \(marker=-\); left unchanged/g)??[]).length,2);
 assert.equal(fp(p),fpP,"no change at all (bodies, markers, ACLs, index, data)");
 r=ok(p,{file:RB},"rollback over the proposal");
 assert.equal((r.err.match(/was not created by 20261029125000 \(marker=-\); left in place/g)??[]).length,2);
 assert.equal(fp(p),fpP,"proposal functions and index kept");
 // Whitespace-only differences are the same normalized definition.
 const ws=clone("ws","base");
 ok(ws,{sql:P("flow_begin_durable_run","begin",s=>s.replace(/\n /g,"\n\t  ").replace("BEGIN\n","BEGIN   \n\n"))},"reindented begin");
 ok(ws,{file:MIG},"125000 accepts the reindented identical body");
 assert.equal(marker(ws,BEGIN_SIG),null,"pre-existing begin untouched");
 assert.equal(marker(ws,RESUME_SIG),MARK,"missing resume created");
 // Rollback drops only what this migration owns.
 ok(ws,{file:RB},"rollback mixed ownership");
 assert.equal(hasFn(ws,BEGIN_SIG),true,"foreign begin kept");
 assert.equal(hasFn(ws,RESUME_SIG),false,"owned resume dropped");
 // An owned function can still be recognized after re-apply.
 ok(ws,{file:MIG},"re-apply");
 assert.equal(marker(ws,RESUME_SIG),MARK);
});

test("(7) rollback refuses while 130000..170000 objects exist; correct order 170->130 then 125000",{skip},()=>{
 const db=clone("order");
 for(const f of LATER)ok(db,{file:f},f);
 const msg=/roll back 20261029170000, 160000, 150000, 140000 and 130000 first/;
 refused(db,RB,msg,"125000 rollback with 130000..170000 installed");
 for(const [i,f] of LATER_RB.entries()){
  ok(db,{file:f},f);
  if(i<LATER_RB.length-1)refused(db,RB,msg,`125000 rollback after only ${i+1} later rollback(s)`);
 }
 const r=ok(db,{file:RB},"125000 rollback last");
 assert.match(r.err,/2 owned function\(s\) dropped/);
 assert.equal(hasFn(db,BEGIN_SIG)||hasFn(db,RESUME_SIG),false);
 // 170000 refuses without the functions; re-applying 125000 satisfies it again.
 for(const f of LATER.slice(0,4))ok(db,{file:f},f);
 refused(db,CC,/Durable ingress functions missing/,"170000 without 125000");
 ok(db,{file:MIG},"125000 re-applied");
 ok(db,{file:CC},"170000 accepted after 125000");
});

test("(8) equivalence: installed definitions equal the proposal's; same behaviour on both installs",{skip},()=>{
 const p=clone("eqp","base");ok(p,{file:PROPOSAL},"proposal");
 const m=clone("eqm","base");ok(m,{file:MIG},"125000");
 const defs=db=>rows(db,`SELECT p.proname,md5(p.prosrc) AS src,
  regexp_replace(pg_get_functiondef(p.oid),'[[:space:]]+',' ','g') AS def,p.proacl::text AS acl,
  pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
   AND p.proname IN('flow_begin_durable_run','flow_resume_button_run') ORDER BY 1`);
 const dp=defs(p),dm=defs(m);
 assert.equal(dm.length,2);
 assert.deepEqual(dm,dp,"normalized pg_get_functiondef, exact prosrc and ACL identical");
 assert.deepEqual(dm.map(d=>d.src),[md5(propBody("begin")),md5(propBody("resume"))]);
 // Only documented difference: the proposal's optional index is not part of 125000.
 assert.equal(val(p,"SELECT to_regclass('public.flow_one_awaiting_input_per_conversation') IS NOT NULL"),true);
 assert.equal(val(m,"SELECT to_regclass('public.flow_one_awaiting_input_per_conversation') IS NOT NULL"),false);
 // Same observable results for the same scenario.
 const scenario=db=>{
  const e=mk(db,"eq1"),run=begin(db,e),dup=begin(db,e);
  const tap=mk(db,"eq1tap",A,ACC,e.conv);
  const out=[run!==null,dup,resume(db,run,tap,{tenant:B}),resume(db,run,tap),resume(db,run,tap)];
  const st=rows(db,`SELECT r.run_status,r.current_node_id,r.step_count,
   (SELECT string_agg(o.effect_kind||':'||o.idempotency_key,',' ORDER BY o.idempotency_key) FROM public.automation_flow_outbox o WHERE o.run_id=r.id) AS fx,
   (SELECT count(*) FROM public.automation_flow_event_receipts) AS receipts
   FROM public.automation_flow_runs r WHERE r.id='${run}'`);
  let err;try{fails(db,beginSql(mk(db,"eq2"),{status:"bogus"})+";","P0001","bad",SR);err="P0001";}catch(x){err=String(x);}
  return {out,st,err};
 };
 assert.deepEqual(scenario(m),scenario(p));
});
