// 20261029190000_flow_begin_durable_run_superseding (audit B4): supersede the
// conversation's active runs and start the new durable run in ONE transaction.
// If flow_begin_durable_run returns NULL (eligibility re-checks) or raises,
// every supersede is rolled back: older runs keep their status, wake_at,
// pending/retry_wait outbox rows and leases.
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) built from the repo fixture chain
// (incl. the 20261028227000/228000 staff/internal-actions bootstrap, like the
// lifecycle integration suite) and migrations 20261028220000 .. 20261029190000.
// Never connects to any remote host; inherited PG* variables are stripped.
// Billing is out of scope (no consume_* / credit function is exercised).
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const MIG="supabase/migrations/20261029190000_flow_begin_durable_run_superseding.sql";
const RB="supabase/rollbacks/20261029190000_flow_begin_durable_run_superseding.rollback.sql";
const M125="supabase/migrations/20261029125000_flow_durable_button_run.sql";
const M130="supabase/migrations/20261029130000_flow_run_lifecycle.sql";
const M180="supabase/migrations/20261029180000_flow_durable_button_run_guards.sql";
const CHAIN125_180=[M125,M130,"supabase/migrations/20261029140000_flow_outbox_ai_retry.sql",
 "supabase/migrations/20261029150000_flow_takeover_resume.sql",
 "supabase/migrations/20261029160000_flow_credits_pause.sql",
 "supabase/migrations/20261029170000_flow_canary_claim_durable.sql",M180];
const OLDER_RB=["supabase/rollbacks/20261029180000_flow_durable_button_run_guards.rollback.sql",
 "supabase/rollbacks/20261029170000_flow_canary_claim_durable.rollback.sql",
 "supabase/rollbacks/20261029160000_flow_credits_pause.rollback.sql",
 "supabase/rollbacks/20261029150000_flow_takeover_resume.rollback.sql",
 "supabase/rollbacks/20261029140000_flow_outbox_ai_retry.rollback.sql",
 "supabase/rollbacks/20261029130000_flow_run_lifecycle.rollback.sql",
 "supabase/rollbacks/20261029125000_flow_durable_button_run.rollback.sql"];
const INGRESS="supabase/functions/milan-api/flowDurableIngress.ts";
const MARK="CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING";
const ARGS="uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb";
const SIG=`public.flow_begin_durable_run_superseding(${ARGS})`;
const BEGIN_SIG=`public.flow_begin_durable_run(${ARGS})`;
const src=f=>readFileSync(f,"utf8");
const md5=x=>createHash("md5").update(x).digest("hex");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");
const between=(s,open,close)=>{const a=s.indexOf(open);assert.ok(a>=0,open);const b=a+open.length;return s.slice(b,s.indexOf(close,b));};
const norm=x=>x.replace(/[ \t\n\r\f\v]+/g," ").replace(/^ +| +$/g,"");

// ---------------------------------------------------------------- static
test("190000 is the newest migration and follows the whole 125000..180000 chain",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 assert.equal(stamps.filter(s=>s==="20261029190000").length,1);
 for(const s of stamps)if(s!=="20261029190000")assert.ok(s<"20261029190000",s);
 for(const f of [...CHAIN125_180,RB])assert.ok(existsSync(f),f);
});
test("migration and rollback: one bounded transaction, additive, service_role only, no data change",()=>{
 for(const f of [MIG,RB]){
  const s=src(f),code=noComments(s);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
  assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1,f);assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.doesNotMatch(code,/\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+public\.|\bINSERT\b|\bALTER\s+TABLE\b|CREATE\s+(UNIQUE\s+)?INDEX|CONCURRENTLY/i,f);
  assert.doesNotMatch(code,/SECURITY DEFINER|\bTO\s+(anon|authenticated|PUBLIC)\b|CREATE POLICY/i,f);
  assert.doesNotMatch(code,/consume_|credits|wayl|topup|cron\.|vault\.|net\.http_/i,f);
  assert.ok(code.includes(`v_marker constant text := '${MARK}'`),f);
 }
 const code=noComments(src(MIG));
 assert.doesNotMatch(code,/\bDROP\b/i,"migration never drops");
 assert.doesNotMatch(code,/CREATE\s+FUNCTION/i,"CREATE OR REPLACE only (idempotent)");
 assert.equal((code.match(/CREATE OR REPLACE FUNCTION/g)??[]).length,1);
 assert.match(code,new RegExp("CREATE OR REPLACE FUNCTION public\\.flow_begin_durable_run_superseding\\(\\n"+
  " p_tenant uuid,p_account uuid,p_conversation uuid,p_inbound uuid,\\n p_event text,p_flow text,p_revision bigint,p_start text,p_next text,\\n"+
  " p_next_step integer,p_status text,p_variables jsonb,p_wake timestamptz,\\n p_effects jsonb\\n"+
  "\\) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=''\\n"));
 // Same argument list / result / attributes as flow_begin_durable_run (125000 head).
 const head125=between(src(M125),"v_begin_head constant text := $head$","$head$;");
 assert.ok(code.includes(head125.replace("public.flow_begin_durable_run(","public.flow_begin_durable_run_superseding(")),
  "signature identical to flow_begin_durable_run");
 assert.match(code,new RegExp(`REVOKE ALL ON FUNCTION ${SIG.replace(/[().]/g,"\\$&")}\\n FROM PUBLIC,anon,authenticated;`));
 assert.match(code,new RegExp(`GRANT EXECUTE ON FUNCTION ${SIG.replace(/[().]/g,"\\$&")}\\n TO service_role;`));
 assert.equal((code.match(/^GRANT /gm)??[]).length,1);
 assert.match(code,new RegExp(`COMMENT ON FUNCTION ${SIG.replace(/[().]/g,"\\$&")}\\n IS '${MARK}';`));
 assert.doesNotMatch(noComments(src(RB)),/^(REVOKE|GRANT)/m,"rollback never changes privileges");
});
test("body: same advisory key as flow_guard_one_active_run, exact supersede semantics, private SQLSTATE rollback",()=>{
 const body=between(src(MIG),"AS $superseding$","$superseding$");
 const guard=between(src(M130),"AS $guard$","$guard$");
 const key="pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(";
 assert.ok(guard.includes(key+"\n  'flow_active_run:'||NEW.tenant_id::text||':'||NEW.conversation_id::text,0));"));
 assert.ok(body.includes(key+"\n  'flow_active_run:'||p_tenant::text||':'||p_conversation::text,0));"),"same lock key");
 assert.ok(body.indexOf(key)<body.indexOf("flow_cancel_run"),"lock before any cancel");
 assert.match(body,/WHERE run\.tenant_id=p_tenant AND run\.conversation_id=p_conversation\n    AND run\.run_status IN\('ready','awaiting_input','sleeping'\)/);
 assert.ok(body.includes("PERFORM public.flow_cancel_run(p_tenant,r.id,'superseded',r.run_status);"));
 assert.ok(body.includes("v_run := public.flow_begin_durable_run(\n   p_tenant,p_account,p_conversation,p_inbound,p_event,p_flow,p_revision,\n"+
  "   p_start,p_next,p_next_step,p_status,p_variables,p_wake,p_effects);"),"unchanged arguments");
 assert.ok(body.indexOf("flow_cancel_run")<body.indexOf("public.flow_begin_durable_run("),"supersede, then begin");
 assert.match(body,/IF v_run IS NULL THEN\n   RAISE EXCEPTION '[^']+'\n    USING ERRCODE='FB190';/);
 assert.equal((body.match(/EXCEPTION WHEN/g)??[]).length,1);
 assert.match(body,/EXCEPTION WHEN SQLSTATE 'FB190' THEN\n[^\n]*\n  RETURN NULL;\n END;/,"only the private SQLSTATE is caught");
 assert.doesNotMatch(body,/WHEN OTHERS/);
 // Preflight's hash = normalized 180000 begin body (same value as the pre-deploy checks).
 const b180=between(src(M180),"v_begin_180 constant text := $begin$","$begin$;");
 assert.ok(src(MIG).includes(`v_begin_180_md5 constant text := '${md5(norm(b180))}';`),"180000 begin hash");
});
test("every older rollback (180000 .. 125000) refuses while the 190000 function exists",()=>{
 for(const f of OLDER_RB){
  const s=src(f),g=s.slice(s.indexOf("BEGIN;"),s.search(/\s\$(g|guard|rollback)\$;/));
  assert.ok(g.includes(`IF to_regprocedure('${SIG}') IS NOT NULL`),f);
  assert.match(g,/RAISE EXCEPTION '[^']*roll back 20261029190000_flow_begin_durable_run_superseding first'/,f);
  assert.match(s,/20261029190000/,f);
 }
});
test("milan-api starts durable runs only through the superseding RPC",()=>{
 const ing=src(INGRESS);
 assert.equal((ing.match(/rpc\("flow_begin_durable_run_superseding"/g)??[]).length,1);
 assert.doesNotMatch(ing,/rpc\("flow_begin_durable_run"/);
 assert.doesNotMatch(ing,/supersedeActiveRuns|"superseded"/);
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
  const t0=Date.now();
  const p=spawn(join(BIN,"psql"),pargs(db),{env:clientEnv()});
  let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
  p.on("close",code=>res({code,out,err,end:Date.now(),ms:Date.now()-t0}));p.stdin.end(sql);
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
function refused(db,file,re,label,env){
 const before=fp(db);
 const r=psql(db,{file,env});
 assert.notEqual(r.status,0,`${label} must be refused`);
 assert.match(r.stderr,re,label);
 assert.equal(fp(db),before,`${label}: refused without any change`);
}

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111";  // tenant A instagram (fixture)
const ACC2="dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // tenant A, second instagram account
const ACCB="cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // tenant B instagram
const doc={version:3,name:"two choices",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"choose",image:"",contentBlocks:[],options:[
  {id:"prices",label:"prices"},{id:"support",label:"support"}]}},
 {id:"yes",data:{kind:"message",text:"prices text",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"support text",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},{source:"choose",target:"yes",sourceHandle:"prices"},
  {source:"choose",target:"no",sourceHandle:"support"}]};
const J=o=>`'${JSON.stringify(o).replace(/'/g,"''")}'::jsonb`;
// Production live-only columns (as in tests/flow-lifecycle-integration.test.ts).
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
// Same order as tests/flow-lifecycle-integration.test.ts (incl. 227000/228000).
const CHAIN=["tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
 "tests/sql/flow-exclusive-claim-bootstrap.sql","@LIVE",
 "supabase/migrations/20261028220000_webhook_exclusive_claim.sql",
 "supabase/migrations/20261028224000_delivery_attempts.sql",
 "supabase/migrations/20261028225000_flow_runtime_advance.sql",
 "supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql",
 "tests/sql/flow-staff-membership-bootstrap.sql",
 "supabase/migrations/20261028227000_tenant_staff_memberships.sql",
 "supabase/migrations/20261028228000_flow_internal_actions.sql"];
const SEED=`
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES
 ('${ACC2}','${A}','instagram','instagram'),('${ACCB}','${B}','instagram','instagram');
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by) VALUES
 ('${A}','buttons',1,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${A}','other',1,'${ACC2}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${B}','bflow',1,'${ACCB}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active) VALUES
 ('${A}','${ACC}','instagram','buttons',1,true),('${A}','${ACC2}','instagram','other',1,true),
 ('${B}','${ACCB}','instagram','bflow',1,true);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved)
VALUES('${A}',true,false,true),('${B}',true,false,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
CREATE SCHEMA t;
CREATE TABLE t.e(name text PRIMARY KEY,tenant uuid,acc uuid,conv uuid,msg uuid,mid text);
-- One inbound event = (new or given) conversation + inbound message + route='flow' claim.
CREATE FUNCTION t.ev(p_name text,p_tenant uuid,p_acc uuid,p_conv uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid:=p_conv; m uuid;
BEGIN
 IF c IS NULL THEN
  INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
  VALUES(gen_random_uuid(),p_tenant,p_acc,'instagram:'||gen_random_uuid()) RETURNING id INTO c;
 END IF;
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
 VALUES(p_tenant,c,'in','mid.'||p_name) RETURNING id INTO m;
 INSERT INTO public.automation_message_claims(tenant_id,channel_account_id,platform,provider_event_id,
  conversation_id,inbound_message_id,route)
 VALUES(p_tenant,p_acc,'instagram','mid.'||p_name,c,m,'flow');
 INSERT INTO t.e VALUES(p_name,p_tenant,p_acc,c,m,'mid.'||p_name);
END $f$;
ANALYZE;`;
const SR="service_role";
const Q_EFFECT=k=>`[{"kind":"question","idempotencyKey":"q.${k}","payload":{"kind":"question","text":"choose","inputMode":"buttons","choices":["prices","support"],"choiceIds":["prices","support"]}}]`;
const M_EFFECT=k=>`[{"kind":"message","idempotencyKey":"m.${k}","payload":{"kind":"message","text":"later"}}]`;
const L=v=>v===null?"NULL":`'${String(v).replace(/'/g,"''")}'`;
function callSql(fn,e,o={}){
 const a={tenant:e.tenant,acc:e.acc,conv:e.conv,msg:e.msg,mid:e.mid,flow:e.acc===ACCB?"bflow":"buttons",rev:1,start:"start",
  next:"choose",step:1,status:"awaiting_input",vars:"{}",wake:null,effects:Q_EFFECT(e.name),...o};
 return `SELECT public.${fn}(${L(a.tenant)},${L(a.acc)},${L(a.conv)},${L(a.msg)},${L(a.mid)},`+
  `${L(a.flow)},${a.rev===null?"NULL":a.rev},${L(a.start)},${L(a.next)},${a.step===null?"NULL":a.step},${L(a.status)},`+
  `${a.vars===null?"NULL":L(a.vars)+"::jsonb"},${a.wake===null?"NULL":L(a.wake)+"::timestamptz"},${a.effects===null?"NULL":L(a.effects)+"::jsonb"})`;
}
const superSql=(e,o)=>callSql("flow_begin_durable_run_superseding",e,o);
const mk=(db,name,tenant=A,acc=ACC,conv=null)=>{
 ok(db,{sql:`SELECT t.ev('${name}','${tenant}','${acc}',${conv?`'${conv}'`:"NULL"});`},`event ${name}`);
 return rows(db,`SELECT * FROM t.e WHERE name='${name}'`)[0];
};
const begin=(db,e,o)=>val(db,callSql("flow_begin_durable_run",e,o).replace(/^SELECT /,""),SR);
const supersede=(db,e,o)=>val(db,superSql(e,o).replace(/^SELECT /,""),SR);
const runRow=(db,run)=>rows(db,`SELECT run_status,ended_reason,wake_at IS NOT NULL AS has_wake,current_node_id,step_count
 FROM public.automation_flow_runs WHERE id='${run}'`)[0];
const outbox=(db,run)=>rows(db,`SELECT delivery_status,cancel_reason FROM public.automation_flow_outbox
 WHERE run_id='${run}' ORDER BY idempotency_key`);
const leases=(db,run)=>Number(val(db,`SELECT count(*) FROM public.automation_flow_run_leases WHERE run_id='${run}'`));
const active=(db,conv)=>rows(db,`SELECT id FROM public.automation_flow_runs WHERE conversation_id='${conv}'
 AND run_status IN('ready','awaiting_input','sleeping')`).map(r=>r.id);
const hasFn=(db,sig)=>val(db,`SELECT to_regprocedure('${sig}') IS NOT NULL`);
const UUID=/^[0-9a-f]{8}-[0-9a-f-]{27}$/;
// An older conversation state worth protecting: a sleeping run (wake_at, one
// pending and one retry_wait effect, a live lease). Returns its run id.
function sleepingRun(db,e){
 const run=begin(db,e,{next:"choose",status:"sleeping",wake:"2030-01-01T00:00:00Z",
  effects:`[${Q_EFFECT(e.name).slice(1,-1)},${M_EFFECT(e.name).slice(1,-1)}]`});
 assert.match(String(run),UUID,"older sleeping run started");
 ok(db,{sql:`UPDATE public.automation_flow_outbox SET delivery_status='retry_wait',retry_at=now()+interval '5 minutes'
   WHERE run_id='${run}' AND effect_kind='message';
  INSERT INTO public.automation_flow_run_leases(tenant_id,run_id,expires_at) VALUES('${e.tenant}','${run}',now()+interval '1 minute');`},"retry_wait + lease");
 assert.deepEqual(outbox(db,run).map(o=>o.delivery_status).sort(),["pending","retry_wait"]);
 assert.equal(leases(db,run),1);
 return run;
}

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-superseding-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+191)%20000);
 let r=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(r.status,0,r.stderr);
 r=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off`,"start"]);
 assert.equal(r.status,0,r.stderr+r.stdout);
 started=true;
 ok("postgres",{sql:"CREATE DATABASE base;"},"createdb");
 ok("base",{sql:src("tests/sql/fixtures/flow-live-shape-bootstrap.sql")},"live shape");
 for(const f of CHAIN)ok("base",f==="@LIVE"?{sql:LIVE}:{file:f},f);
 ok("base",{sql:SEED},"seed");
 // c180: the chain up to 180000; g190: plus this migration.
 ok("postgres",{sql:"CREATE DATABASE c180 TEMPLATE base;"},"c180");
 for(const f of CHAIN125_180)ok("c180",{file:f},f);
 ok("postgres",{sql:"CREATE DATABASE g190 TEMPLATE c180;"},"g190");
 ok("g190",{file:MIG},"190000");
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});
let clones=0;
function clone(prefix,template="g190"){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},`clone ${db}`);
 return db;
}

test("success: older active runs of the conversation are superseded and the new run starts, in one call",{skip},()=>{
 const db=clone("ok");
 const e1=mk(db,"s1");
 const old=sleepingRun(db,e1);
 const other=mk(db,"o1");const otherRun=begin(db,other);           // other conversation, same tenant
 const eb=mk(db,"b1",B,ACCB);const bRun=begin(db,eb);              // other tenant
 const e2=mk(db,"s2",A,ACC,e1.conv);
 const run=supersede(db,e2);
 assert.match(String(run),UUID);
 assert.deepEqual(runRow(db,old),{run_status:"blocked",ended_reason:"superseded",has_wake:false,current_node_id:"choose",step_count:1});
 assert.deepEqual(outbox(db,old).map(o=>[o.delivery_status,o.cancel_reason]),[["cancelled","superseded"],["cancelled","superseded"]]);
 assert.equal(leases(db,old),0,"lease of the superseded run deleted");
 assert.deepEqual(runRow(db,run),{run_status:"awaiting_input",ended_reason:null,has_wake:false,current_node_id:"choose",step_count:1});
 assert.deepEqual(outbox(db,run),[{delivery_status:"pending",cancel_reason:null}]);
 assert.deepEqual(active(db,e1.conv),[run],"exactly one active run");
 // Nothing outside this tenant conversation is touched.
 assert.equal(runRow(db,otherRun).run_status,"awaiting_input");
 assert.equal(runRow(db,bRun).run_status,"awaiting_input");
 // A 'ready' run is superseded too (statuses ready/awaiting_input/sleeping, tenant+conversation scope).
 const e3=mk(db,"s3",A,ACC,e1.conv);
 ok(db,{sql:`UPDATE public.automation_flow_runs SET run_status='ready' WHERE id='${run}'`},"ready");
 const run3=supersede(db,e3);
 assert.match(String(run3),UUID);
 assert.equal(runRow(db,run).ended_reason,"superseded");
 assert.deepEqual(active(db,e1.conv),[run3]);
 // No active run at all: behaves exactly like flow_begin_durable_run.
 const fresh=mk(db,"f1");
 assert.match(String(supersede(db,fresh)),UUID);
 // Same provider event again: refused (receipt), nothing superseded.
 const before=fp(db);
 assert.equal(supersede(db,e3),null,"replayed event never supersedes its own run");
 assert.equal(fp(db),before);
});

test("begin returns NULL: every supersede is rolled back (status, wake_at, outbox rows, leases intact)",{skip},()=>{
 const db=clone("null");
 const e1=mk(db,"n1");
 const old=sleepingRun(db,e1);
 const cases=[
  ["account auto_reply off",`UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}'`,`UPDATE public.channel_accounts SET auto_reply=true WHERE id='${ACC}'`],
  ["tenant inactive",`UPDATE public.tenants SET is_active=false WHERE id='${A}'`,`UPDATE public.tenants SET is_active=true WHERE id='${A}'`],
  ["global switch off","UPDATE public.automation_flow_global_switch SET enabled=false","UPDATE public.automation_flow_global_switch SET enabled=true"],
  ["tenant not approved",`UPDATE public.automation_flow_tenant_switches SET production_approved=false WHERE tenant_id='${A}'`,
   `UPDATE public.automation_flow_tenant_switches SET production_approved=true WHERE tenant_id='${A}'`],
  ["activation inactive","UPDATE public.automation_flow_activations SET is_active=false WHERE flow_key='buttons'",
   "UPDATE public.automation_flow_activations SET is_active=true WHERE flow_key='buttons'"]];
 for(const [label,off,on] of cases){
  const e=mk(db,`n_${label.replace(/\W/g,"")}`,A,ACC,e1.conv);
  ok(db,{sql:off},label);
  const before=fp(db);
  assert.equal(supersede(db,e),null,`${label}: refused`);
  assert.equal(fp(db),before,`${label}: no row changed (older run, its outbox rows, wake_at, lease)`);
  ok(db,{sql:on},label);
 }
 const e=mk(db,"n2",A,ACC,e1.conv);
 for(const [label,o] of [["unknown flow",{flow:"nope"}],["start not trigger",{start:"choose"}],["unpublished revision",{rev:2}],
   ["forged inbound",{msg:"99999999-9999-4999-8999-999999999999"}],["forged event",{mid:"mid.forged"}],
   ["foreign account",{acc:ACCB}],["NULL effects",{effects:null}],["step 0",{step:0}],["NULL tenant",{tenant:null}],["NULL conversation",{conv:null}]]){
  const before=fp(db);
  assert.equal(supersede(db,e,o),null,label);
  assert.equal(fp(db),before,`${label}: nothing superseded`);
 }
 assert.equal(runRow(db,old).run_status,"sleeping");assert.equal(runRow(db,old).has_wake,true);
 assert.deepEqual(outbox(db,old).map(o=>o.delivery_status).sort(),["pending","retry_wait"]);
 assert.equal(leases(db,old),1);
 // Differential: the old two-step client sequence (supersede committed, then a refused begin) lost the run.
 const d=clone("null_old");
 const de1=mk(d,"n1");const dold=sleepingRun(d,de1);const de2=mk(d,"n2",A,ACC,de1.conv);
 ok(d,{sql:`UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}'`},"off");
 assert.equal(val(d,`public.flow_cancel_run('${A}','${dold}','superseded','sleeping')`,SR),true);
 assert.equal(begin(d,de2),null);
 assert.equal(runRow(d,dold).run_status,"blocked","(previous behaviour: old run ended, no new run)");
 // Mutation check: without the private-SQLSTATE rollback (plain RETURN NULL) the
 // same refused call WOULD supersede, so the assertions above are meaningful.
 const m=clone("null_mut");
 const me1=mk(m,"n1");const mold=sleepingRun(m,me1);const me2=mk(m,"n2",A,ACC,me1.conv);
 const fnSrc=val(m,`SELECT pg_get_functiondef('${SIG}'::regprocedure)`);
 const mutated=fnSrc.replace(/RAISE EXCEPTION '[^']+'\s+USING ERRCODE='FB190';/,"RETURN NULL;");
 assert.notEqual(mutated,fnSrc);
 ok(m,{sql:mutated+";"},"mutated body");
 ok(m,{sql:`UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}'`},"off");
 assert.equal(supersede(m,me2),null);
 assert.equal(runRow(m,mold).ended_reason,"superseded","mutant loses the older run");
 // ... and the same eligible event later still supersedes atomically.
 const run=supersede(db,e);
 assert.match(String(run),UUID,"eligible again: superseded and started");
 assert.equal(runRow(db,old).ended_reason,"superseded");
});

test("begin raises: the error propagates and the supersede is rolled back with the statement",{skip},()=>{
 const db=clone("raise");
 const e1=mk(db,"r1");const old=sleepingRun(db,e1);
 for(const [label,o,re] of [["bad status",{status:"bogus"},/First durable step rejected/],
   ["effects not array",{effects:"{}"},/First durable step rejected/]]){
  const e=mk(db,`r_${label.replace(/\W/g,"")}`,A,ACC,e1.conv);
  const before=fp(db);
  const r=psql(db,{sql:superSql(e,o)+";",role:SR});
  assert.notEqual(r.status,0,`${label} must raise`);
  assert.match(r.stderr,re,label);
  assert.notEqual(sqlState(r.stderr),"FB190","the private SQLSTATE never escapes");
  assert.equal(fp(db),before,`${label}: no partial change`);
 }
 // Inside a caller transaction the whole transaction is aborted (nothing committed).
 const e=mk(db,"r_tx",A,ACC,e1.conv);const before=fp(db);
 const r=psql(db,{sql:`SET ROLE ${SR};\nBEGIN;\n${superSql(e,{effects:"{}"})};\nCOMMIT;\n`});
 assert.notEqual(r.status,0);assert.equal(fp(db),before);
 // A trigger conflict (another active run appears that the supersede did not see) also rolls back.
 const db2=clone("raise23505");
 const c1=mk(db2,"c1");const crun=sleepingRun(db2,c1);const c2=mk(db2,"c2",A,ACC,c1.conv);
 // Let flow_cancel_run report "already left that state" by making the run look terminal to it only:
 // simulate with a BEFORE UPDATE trigger that keeps the run active (operator-level fault injection).
 ok(db2,{sql:`CREATE FUNCTION t.keep() RETURNS trigger LANGUAGE plpgsql AS $k$
  BEGIN IF NEW.ended_reason='superseded' THEN RETURN NULL; END IF; RETURN NEW; END $k$;
  CREATE TRIGGER keep BEFORE UPDATE ON public.automation_flow_runs FOR EACH ROW EXECUTE FUNCTION t.keep();`},"fault");
 const b2=fp(db2);
 const r2=psql(db2,{sql:superSql(c2)+";",role:SR});
 assert.notEqual(r2.status,0);assert.equal(sqlState(r2.stderr),"23505");assert.match(r2.stderr,/flow_active_run_exists/);
 assert.equal(fp(db2),b2,"23505: outbox cancels of the same call rolled back too");
 assert.deepEqual(outbox(db2,crun).map(o=>o.delivery_status).sort(),["pending","retry_wait"]);
});

test("tenant isolation: foreign tenant/conversation ids never cancel anything",{skip},()=>{
 const db=clone("tenant");
 const ea=mk(db,"a1");const aRun=sleepingRun(db,ea);
 const eb=mk(db,"b1",B,ACCB);const bRun=sleepingRun(db,eb);
 const eb2=mk(db,"b2",B,ACCB,eb.conv);
 for(const [label,e,o] of [
  ["tenant B with tenant A's conversation",eb2,{conv:ea.conv}],
  ["tenant A with tenant B's event",eb2,{tenant:A}],
  ["tenant A ids, tenant B account",mk(db,"a2",A,ACC,ea.conv),{acc:ACCB}],
  ["tenant B with A's event ids",mk(db,"a3",A,ACC,ea.conv),{tenant:B}]]){
  const before=fp(db);
  assert.equal(supersede(db,e,o),null,label);
  assert.equal(fp(db),before,`${label}: nothing changed`);
 }
 // Legitimate B call supersedes only B's run.
 assert.match(String(supersede(db,eb2)),UUID);
 assert.equal(runRow(db,bRun).ended_reason,"superseded");
 assert.equal(runRow(db,aRun).run_status,"sleeping");assert.equal(leases(db,aRun),1);
});

test("concurrent superseding starts of one conversation serialize on the advisory lock",{skip},async()=>{
 const db=clone("conc");
 const e1=mk(db,"k1");const old=sleepingRun(db,e1);
 const e2=mk(db,"k2",A,ACC,e1.conv),e3=mk(db,"k3",A,ACC,e1.conv);
 const s1=psqlAsync(db,`SET ROLE ${SR};\nBEGIN;\n${superSql(e2)};\nSELECT pg_sleep(1.5);\nSELECT 'commit-at';\nCOMMIT;\n`);
 await new Promise(r=>setTimeout(r,400));
 const t2=Date.now();
 const s2=psqlAsync(db,`SET ROLE ${SR};\n${superSql(e3)};\n`);
 const [r1,r2]=await Promise.all([s1,s2]);
 assert.equal(r1.code,0,r1.err);assert.equal(r2.code,0,r2.err);
 const id1=(r1.out.match(/[0-9a-f-]{36}/)??[null])[0],id2=(r2.out.match(/[0-9a-f-]{36}/)??[null])[0];
 assert.ok(id1&&id2,`both started: ${JSON.stringify([r1.out,r2.out])}`);
 assert.ok(r2.end>=r1.end-150&&r2.end-t2>=800,`second call waited for the first to commit (${r2.end-t2} ms)`);
 assert.equal(runRow(db,old).ended_reason,"superseded");
 assert.equal(runRow(db,id1).ended_reason,"superseded","the later start supersedes the earlier one");
 assert.deepEqual(active(db,e1.conv),[id2],"exactly one active run, no 23505");
 // Different conversations never wait on each other.
 const f1=mk(db,"x1"),f2=mk(db,"x2");
 const h=psqlAsync(db,`SET ROLE ${SR};\nBEGIN;\n${superSql(f1)};\nSELECT pg_sleep(1.5);\nCOMMIT;\n`);
 await new Promise(r=>setTimeout(r,400));
 const q=await psqlAsync(db,`SET ROLE ${SR};\n${superSql(f2)};\n`);
 assert.equal(q.code,0,q.err);assert.ok(q.ms<1000,`other conversation not blocked (${q.ms} ms)`);
 assert.equal((await h).code,0);
});

test("privileges: service_role only, SECURITY INVOKER, search_path pinned, hostile search_path ignored",{skip},()=>{
 const db=clone("acl");
 for(const role of ["anon","authenticated","public"])
  assert.equal(val(db,`SELECT has_function_privilege('${role}','${SIG}','EXECUTE')`),false,role);
 assert.equal(val(db,`SELECT has_function_privilege('service_role','${SIG}','EXECUTE')`),true);
 const meta=rows(db,`SELECT p.prosecdef,p.proconfig,p.provolatile,p.proisstrict,p.pronargdefaults,
  pg_get_function_result(p.oid) AS res,(SELECT lanname FROM pg_language l WHERE l.oid=p.prolang) AS lang,
  obj_description(p.oid,'pg_proc') AS marker FROM pg_proc p WHERE p.oid='${SIG}'::regprocedure`)[0];
 assert.deepEqual(meta,{prosecdef:false,proconfig:['search_path=""'],provolatile:"v",proisstrict:false,
  pronargdefaults:0,res:"uuid",lang:"plpgsql",marker:MARK});
 assert.equal(val(db,`SELECT (SELECT proargnames FROM pg_proc WHERE oid='${SIG}'::regprocedure)
  =(SELECT proargnames FROM pg_proc WHERE oid='${BEGIN_SIG}'::regprocedure)`),true,"same argument names as flow_begin_durable_run");
 const e=mk(db,"p1");
 for(const role of ["anon","authenticated"]){
  const r=psql(db,{sql:superSql(e)+";",role});
  assert.notEqual(r.status,0);assert.equal(sqlState(r.stderr),"42501",role);
 }
 ok(db,{sql:`CREATE SCHEMA evil; GRANT USAGE ON SCHEMA evil TO service_role;
  CREATE TABLE evil.automation_flow_runs(id uuid,tenant_id uuid,conversation_id uuid,run_status text);
  GRANT ALL ON evil.automation_flow_runs TO service_role;
  CREATE FUNCTION evil.flow_cancel_run(uuid,uuid,text,text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
  GRANT EXECUTE ON FUNCTION evil.flow_cancel_run(uuid,uuid,text,text) TO service_role;`},"evil");
 const e1=mk(db,"p2");const old=sleepingRun(db,e1);const e2=mk(db,"p3",A,ACC,e1.conv);
 const r=psql(db,{sql:`SET search_path=evil,public;\n${superSql(e2)};`,role:SR});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout.trim(),UUID);
 assert.equal(runRow(db,old).ended_reason,"superseded","public objects used, never the hostile schema");
});

test("migration: idempotent re-apply; preflight refuses missing/unrecognized prerequisites and foreign functions",{skip},()=>{
 const db=clone("idem");
 const once=fp(db);
 ok(db,{file:MIG},"re-apply");
 assert.equal(fp(db),once,"re-apply changes nothing");
 // Without 180000 (only 125000..170000): refused.
 const no180=clone("no180","base");
 for(const f of CHAIN125_180.slice(0,-1))ok(no180,{file:f},f);
 refused(no180,MIG,/apply 20261029180000_flow_durable_button_run_guards first/,"180000 missing");
 const bare=clone("bare","base");
 refused(bare,MIG,/apply 20261029130000_flow_run_lifecycle first/,"chain missing");
 const H180=between(src(M125),"v_begin_head constant text := $head$","$head$;");
 for(const [label,sql,re] of [
  ["180000 begin body tampered (marker kept)",`${H180}$x$BEGIN RETURN NULL; END$x$;`,/does not have the 20261029180000 definition/],
  ["resume without 180000 marker",`COMMENT ON FUNCTION public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb) IS NULL;`,
   /apply 20261029180000_flow_durable_button_run_guards first/],
  ["cancel without 130000 marker","COMMENT ON FUNCTION public.flow_cancel_run(uuid,uuid,text,text) IS NULL;",/apply 20261029130000_flow_run_lifecycle first/],
  ["guard trigger disabled","ALTER TABLE public.automation_flow_runs DISABLE TRIGGER flow_one_active_run_guard;",/trigger flow_one_active_run_guard/],
  ["unmarked function of the same name",`COMMENT ON FUNCTION ${SIG} IS 'operator';`,/Unrecognized existing function public\.flow_begin_durable_run_superseding; refusing to overwrite/],
  ["foreign overload","CREATE FUNCTION public.flow_begin_durable_run_superseding(uuid) RETURNS uuid LANGUAGE sql AS 'SELECT $1';",
   /Unrecognized overload of public\.flow_begin_durable_run_superseding/]]){
  const d=clone("pf");
  ok(d,{sql},label);
  refused(d,MIG,re,label);
 }
});

test("rollback: refused out of order, drops only its own function, full reverse order 190 -> 125",{skip},()=>{
 const db=clone("rb");
 // In flight: runs started (and superseded) through the function are kept.
 const e1=mk(db,"k1");const r1=begin(db,e1);const e2=mk(db,"k2",A,ACC,e1.conv);const r2=supersede(db,e2);
 assert.match(String(r2),UUID);
 for(const f of OLDER_RB)refused(db,f,/roll back 20261029190000_flow_begin_durable_run_superseding first/,f,
  {PGOPTIONS:"-c flow.rollback_170000=discard-canary-data"});
 const data=rows(db,"SELECT id,run_status,ended_reason FROM public.automation_flow_runs ORDER BY id");
 ok(db,{file:RB},"190000 rollback");
 assert.equal(hasFn(db,SIG),false);
 assert.equal(fp(db,false),fp("c180",false),"schema identical to the 125000..180000 state");
 assert.deepEqual(rows(db,"SELECT id,run_status,ended_reason FROM public.automation_flow_runs ORDER BY id"),data,"no row touched");
 assert.equal(runRow(db,r1).ended_reason,"superseded");
 refused(db,RB,/20261029190000_flow_begin_durable_run_superseding not installed; nothing to roll back/,"rollback twice");
 // Re-apply reproduces the 190000 schema; then the full reverse order succeeds.
 ok(db,{file:MIG},"re-apply");assert.equal(fp(db,false),fp("g190",false));
 ok(db,{file:RB},"190000 rollback again");
 for(const f of OLDER_RB)ok(db,{file:f,env:{PGOPTIONS:"-c flow.rollback_170000=discard-canary-data"}},f);
 assert.equal(hasFn(db,BEGIN_SIG),false,"125000 rollback ran last");
 // Ownership: an unmarked function of that name is refused, never dropped.
 const u=clone("rbu");
 ok(u,{sql:`COMMENT ON FUNCTION ${SIG} IS 'operator note';`},"unmark");
 refused(u,RB,/Refusing to drop unrecognized function public\.flow_begin_durable_run_superseding \(marker=operator note\)/,"unmarked");
 assert.equal(hasFn(u,SIG),true);
});
