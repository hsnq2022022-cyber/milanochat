// 20261029170000_flow_canary_claim_durable: a SEPARATE claim function for the
// durable Flow V3/V4 Instagram path (production canary), verified against an
// operator-owned canary registration. flow_claim_inbound (V2) is unchanged.
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) built from the repo fixture chain
// and migrations 20261028220000 .. 20261029170000. Never connects to any
// remote host; inherited PG* variables are stripped from every client.
// Billing is out of scope (no consume_* function is called).
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const MIG="supabase/migrations/20261029170000_flow_canary_claim_durable.sql";
const RB="supabase/rollbacks/20261029170000_flow_canary_claim_durable.rollback.sql";
const CLAIM="supabase/migrations/20261028220000_webhook_exclusive_claim.sql";
const LC="supabase/migrations/20261029130000_flow_run_lifecycle.sql";
const AI="supabase/migrations/20261029140000_flow_outbox_ai_retry.sql";
const TK="supabase/migrations/20261029150000_flow_takeover_resume.sql";
const CP="supabase/migrations/20261029160000_flow_credits_pause.sql";
const OLDER_RB=["supabase/rollbacks/20261029160000_flow_credits_pause.rollback.sql",
 "supabase/rollbacks/20261029150000_flow_takeover_resume.rollback.sql",
 "supabase/rollbacks/20261029140000_flow_outbox_ai_retry.rollback.sql",
 "supabase/rollbacks/20261029130000_flow_run_lifecycle.rollback.sql"];
const CHECKS="supabase/proposals/flow_v3_v4_predeploy_checks.review.sql";
const INGRESS="supabase/functions/milan-api/flowDurableIngress.ts";
const MARK="CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE";
const SIG="public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)";
const OLD_SIG="public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)";
const OPT_IN="-c flow.rollback_170000=discard-canary-data";
const src=f=>readFileSync(f,"utf8");
const md5=x=>createHash("md5").update(x).digest("hex");
const body=(f,tag)=>{const s=src(f),o=`AS $${tag}$`,a=s.indexOf(o)+o.length;return s.slice(a,s.indexOf(`$${tag}$`,a));};
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");

// ---------------------------------------------------------------- static
test("170000 is the newest migration and follows 130000/140000/150000/160000",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql"))
  .map(f=>f.split("_")[0].padEnd(14,"0"));
 // Only 20261029180000_flow_durable_button_run_guards (requires 170000) and
 // 20261029190000_flow_begin_durable_run_superseding (requires 180000) and
 // 20261029200000_flow_media_storage (independent storage bucket) and
 // 20261029210000_flow_media_effects (requires 190000) are newer.
 for(const s of stamps)if(!["20261029170000","20261029180000","20261029190000","20261029200000","20261029210000"].includes(s))assert.ok(s<"20261029170000",s);
 for(const f of [CLAIM,LC,AI,TK,CP])assert.ok(existsSync(f),f);
});
test("migration: bounded, additive, service_role only, never touches flow_claim_inbound or billing",()=>{
 const m=src(MIG),code=noComments(m);
 assert.match(m,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m);
 assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1);assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1);
 assert.doesNotMatch(code,/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+public\./i);
 assert.doesNotMatch(code,/ALTER\s+TABLE(?![^;]*ENABLE ROW LEVEL SECURITY;)/i,"only ENABLE ROW LEVEL SECURITY");
 assert.doesNotMatch(code,/INSERT\s+INTO\s+public\.automation_flow_canary_accounts/i,"never registers a canary");
 assert.doesNotMatch(code,/SECURITY DEFINER|\bTO\s+(anon|authenticated|PUBLIC)\b|CREATE POLICY/i);
 assert.doesNotMatch(code,/cron\.|vault\.|net\.http_|sb_secret_|eyJ[A-Za-z0-9_-]{30,}|credits_remaining|consume_|wayl|topup/i);
 assert.doesNotMatch(code,/FUNCTION public\.flow_claim_inbound\(/,"V2 function never (re)defined");
 assert.doesNotMatch(code,/CREATE\s+FUNCTION/i,"CREATE OR REPLACE only (idempotent)");
 assert.equal((code.match(/CREATE OR REPLACE FUNCTION/g)??[]).length,1);
 assert.match(code,/CREATE OR REPLACE FUNCTION public\.flow_claim_inbound_durable\(\n p_tenant_id uuid,\n p_account_id uuid,\n p_platform text,\n p_provider_event_id text,\n p_conversation_id uuid,\n p_inbound_message_id uuid\n\) RETURNS TABLE\(acquired boolean,route text,claim_id uuid,outgoing_message_id uuid\)\nLANGUAGE plpgsql SECURITY INVOKER SET search_path=''/);
 assert.match(code,/REVOKE ALL ON FUNCTION public\.flow_claim_inbound_durable\(uuid,uuid,text,text,uuid,uuid\)\n FROM PUBLIC,anon,authenticated;/);
 assert.match(code,/REVOKE ALL ON TABLE public\.automation_flow_canary_accounts,public\.automation_flow_canary_claims\n FROM PUBLIC,anon,authenticated,service_role;/);
 assert.match(code,/GRANT SELECT ON public\.automation_flow_canary_accounts TO service_role;/);
 for(const p of ["apply 20261029130000_flow_run_lifecycle first","apply 20261029140000_flow_outbox_ai_retry first",
  "apply 20261029150000_flow_takeover_resume first","apply 20261029160000_flow_credits_pause first",
  "apply 20261028220000_webhook_exclusive_claim first"])assert.ok(m.includes(p),p);
 // The operator INSERT is documented in the header comment only.
 assert.match(m,/^-- +INSERT INTO public\.automation_flow_canary_accounts$/m);
});
test("rollback: bounded, opt-in data guard; every older rollback refuses while 170000 exists",()=>{
 const r=src(RB);
 assert.match(r,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m);
 assert.match(r,/current_setting\('flow\.rollback_170000',true\) IS DISTINCT FROM 'discard-canary-data'/);
 assert.doesNotMatch(noComments(r),/flow_claim_inbound\(|automation_message_claims/,"V2 objects and claims untouched");
 for(const f of OLDER_RB){
  const s=src(f);
  const guard=s.slice(s.indexOf("BEGIN;"),s.indexOf("$g$;")>0?s.indexOf("$g$;"):s.indexOf("$guard$;"));
  assert.match(guard,/roll back 20261029170000_flow_canary_claim_durable first/,f);
  assert.ok(guard.includes("flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)"),f);
 }
});
test("TypeScript: only the durable ingress calls the new function; V2 call site and 220000 are untouched",()=>{
 const ing=src(INGRESS);
 assert.equal((ing.match(/rpc\("flow_claim_inbound_durable"/g)??[]).length,1);
 assert.doesNotMatch(src("supabase/functions/milan-api/index.ts"),/flow_claim_inbound_durable/);
 const g=spawnSync("git",["diff","--quiet","HEAD","--",CLAIM]);
 if(g.status!==null&&g.error===undefined&&existsSync(".git")){
  assert.equal(g.status,0,"20261028220000 has no diff against HEAD");
  // milan-api/index.ts may differ from HEAD ONLY by the explicitly authorized
  // provider-id provenance flag (derivation, its pass-through parameter and
  // the attemptDurableInstagram argument) plus the inbound text passed to
  // attemptDurableInstagram for typed-answer questions. Undoing exactly these hunks must
  // reproduce HEAD byte for byte, so every V2 section stays unchanged.
  const IDX="supabase/functions/milan-api/index.ts";
  const head=spawnSync("git",["show","HEAD:"+IDX],{encoding:"utf8",maxBuffer:64<<20});
  assert.equal(head.status,0);
  const allowed=[
   ["  selectedChoiceId?: string | null,\n  providerEventIdGenuine?: boolean\n) {","  selectedChoiceId?: string | null\n) {"],
   // + the typed-answer text (durable text/email/phone questions only).
   ["      text:customerText,\n      selectedChoiceId,providerEventIdGenuine:providerEventIdGenuine===true\n    });","      selectedChoiceId\n    });"],
   ["              msg.mid || `ig_${Date.now()}`;\n"+
    "            // Provenance, never inferred from the id's shape: true only when\n"+
    "            // Meta itself supplied a non-empty mid (msgId is then that mid).\n"+
    "            const providerEventIdGenuine =\n"+
    "              typeof msg.mid === \"string\" && msg.mid.length > 0;\n",
    "              msg.mid || `ig_${Date.now()}`;\n"],
   ["              msg.choiceId,\n              providerEventIdGenuine\n            );","              msg.choiceId\n            );"]
  ];
  let cur=src(IDX);
  if(cur!==head.stdout)for(const [now,was] of allowed){
   assert.equal(cur.split(now).length,2,"allowed hunk present exactly once: "+was.trim().slice(0,40));
   cur=cur.replace(now,()=>was);
  }
  assert.equal(cur,head.stdout,"milan-api/index.ts differs from HEAD only by the authorized provenance-flag hunks");
 }
 assert.match(src(CHECKS),new RegExp(`cf\\.h IS DISTINCT FROM '${md5(body(MIG,"claim"))}'`),"170000 body hash embedded in checks");
 assert.match(src(CHECKS),new RegExp(`v2\\.h='${md5(body(CLAIM,"claim"))}'`),"220000 body hash embedded in checks");
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
const pargs=(db,tab)=>["-X","-q","-t","-A",...(tab?["-F","\t"]:[]),"-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose",
 "-h",dir,"-p",String(port),"-U","postgres","-d",db];
function psql(db,{file,sql,env,role,tab}={}){
 const a=pargs(db,tab);
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
 return r.stdout.trim();
}
function rows(db,query,role){
 const r=psql(db,{sql:`SELECT '@@'||coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)::text FROM (${query}) x;`,role});
 assert.equal(r.status,0,`${query}\n${r.stderr}`);
 return JSON.parse(r.stdout.split("\n").find(l=>l.startsWith("@@")).slice(2));
}
const val=(db,query,role)=>rows(db,`SELECT (${query}) AS v`,role)[0]?.v;
const sqlState=err=>(err.match(/ERROR:\s+([0-9A-Z]{5}):/)??[])[1];
function fails(db,sql,code,label,role){
 const r=psql(db,{sql,role});
 assert.notEqual(r.status,0,`${label} must fail`);
 assert.equal(sqlState(r.stderr),code,`${label}: ${r.stderr}`);
}
function refused(db,file,re,label,env){
 const before=fp(db);
 const r=psql(db,{file,env});
 assert.notEqual(r.status,0,`${label} must be refused`);
 assert.match(r.stderr,re,label);
 assert.equal(fp(db),before,`${label}: refused without any change`);
}

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111";  // tenant A instagram: the canary
const ACC2="dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // tenant A instagram: NOT the canary
const ACCB="cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // tenant B instagram
const FBB="22222222-2222-4222-8222-222222222222";  // tenant B facebook (fixture)
const WAA="33333333-3333-4333-8333-333333333333";  // tenant A whatsapp (fixture)
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
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,ADD COLUMN auto_reply boolean NOT NULL DEFAULT true;
ALTER TABLE public.conversations ADD COLUMN transferred boolean NOT NULL DEFAULT false,
 ADD COLUMN auto_paused_reason text,ADD COLUMN human_agent_expires_at timestamptz;
ALTER TABLE public.automation_flow_tenant_switches
 ADD COLUMN production_approved boolean NOT NULL DEFAULT false;`;
const CHAIN=["tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
 "tests/sql/flow-exclusive-claim-bootstrap.sql","@LIVE",CLAIM,
 "supabase/migrations/20261028224000_delivery_attempts.sql","supabase/migrations/20261028225000_flow_runtime_advance.sql",
 "supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql",
 // Durable start/button RPCs (bodies identical to the former proposal step).
 "supabase/migrations/20261029125000_flow_durable_button_run.sql",LC,AI,TK,CP];
const SEED=`
-- cc.dc references the 170000 function, which is created later per database.
SET check_function_bodies=off;
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES
 ('${ACC2}','${A}','instagram','instagram'),('${ACCB}','${B}','instagram','instagram');
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by) VALUES
 ('${A}','buttons',1,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${A}','delay',1,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${A}','other',1,'${ACC2}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${B}','bflow',1,'${ACCB}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${B}','bfb',1,'${FBB}','facebook',${J(doc)},'88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active) VALUES
 ('${A}','${ACC}','instagram','buttons',1,true),('${A}','${ACC}','instagram','delay',1,true),
 ('${A}','${ACC2}','instagram','other',1,true),('${B}','${ACCB}','instagram','bflow',1,true),
 ('${B}','${FBB}','facebook','bfb',1,true);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved)
VALUES('${A}',true,false,true),('${B}',true,false,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
CREATE SCHEMA cc;
GRANT USAGE ON SCHEMA cc TO service_role;
CREATE FUNCTION cc.conv(p_tenant uuid,p_acc uuid) RETURNS uuid LANGUAGE sql AS $f$
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(gen_random_uuid(),p_tenant,p_acc,'instagram:'||gen_random_uuid()) RETURNING id$f$;
CREATE FUNCTION cc.inbound(p_tenant uuid,p_conv uuid,p_mid text) RETURNS uuid LANGUAGE sql AS $f$
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
 VALUES(p_tenant,p_conv,'in',p_mid) RETURNING id$f$;
-- One event = conversation + persisted inbound (what milan-api writes first).
CREATE TABLE cc.ev(name text PRIMARY KEY,tenant uuid,acc uuid,conv uuid,msg uuid,mid text);
GRANT SELECT,INSERT ON cc.ev TO service_role;
CREATE FUNCTION cc.mk(p_name text,p_tenant uuid,p_acc uuid) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid:=cc.conv(p_tenant,p_acc);
BEGIN INSERT INTO cc.ev VALUES(p_name,p_tenant,p_acc,c,cc.inbound(p_tenant,c,'mid.'||p_name),'mid.'||p_name); END $f$;
-- Durable canary claim for a named event, optionally overriding any argument.
CREATE FUNCTION cc.dc(p_name text,p_tenant uuid DEFAULT NULL,p_acc uuid DEFAULT NULL,p_platform text DEFAULT 'instagram',
 p_conv uuid DEFAULT NULL,p_msg uuid DEFAULT NULL)
RETURNS TABLE(acquired boolean,route text,claim_id uuid,outgoing_message_id uuid) LANGUAGE sql AS $f$
 SELECT d.* FROM cc.ev e,public.flow_claim_inbound_durable(coalesce(p_tenant,e.tenant),coalesce(p_acc,e.acc),
  p_platform,e.mid,coalesce(p_conv,e.conv),coalesce(p_msg,e.msg)) d WHERE e.name=p_name$f$;
CREATE FUNCTION cc.v2(p_name text,p_ready boolean DEFAULT false)
RETURNS TABLE(acquired boolean,route text,claim_id uuid,outgoing_message_id uuid) LANGUAGE sql AS $f$
 SELECT d.* FROM cc.ev e,public.flow_claim_inbound(e.tenant,e.acc,'instagram',e.mid,e.conv,e.msg,p_ready) d
 WHERE e.name=p_name$f$;
CREATE FUNCTION cc.claims(p_name text) RETURNS text LANGUAGE sql STABLE AS $f$
 SELECT count(*)::text||':'||coalesce(string_agg(c.route,',' ORDER BY c.route),'-')
 FROM public.automation_message_claims c JOIN cc.ev e ON e.mid=c.provider_event_id WHERE e.name=p_name$f$;
-- V2 behaviour over the whole switch matrix: (switches, engine_ready) -> first/second claim result.
CREATE FUNCTION cc.matrix(p_tag text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE g boolean; en boolean; t boolean; pa boolean; ready boolean; n text; r1 record; r2 record; out jsonb:='[]';
BEGIN
 FOREACH g IN ARRAY ARRAY[true,false] LOOP FOREACH en IN ARRAY ARRAY[true,false] LOOP
 FOREACH t IN ARRAY ARRAY[true,false] LOOP FOREACH pa IN ARRAY ARRAY[true,false] LOOP
 FOREACH ready IN ARRAY ARRAY[true,false] LOOP
  UPDATE public.automation_flow_global_switch SET enabled=g;
  UPDATE public.automation_flow_tenant_switches SET enabled=en,test_only=t,production_approved=pa WHERE tenant_id='${A}';
  n:=p_tag||'.'||g||en||t||pa||ready;
  PERFORM cc.mk(n,'${A}','${ACC}');
  SELECT * INTO r1 FROM cc.v2(n,ready); SELECT * INTO r2 FROM cc.v2(n,ready);
  out:=out||jsonb_build_object('k',g::text||en||t||pa||ready,'first',r1.acquired::text||'/'||r1.route,
   'second',r2.acquired::text||'/'||r2.route,'same_claim',r1.claim_id=r2.claim_id,'rows',cc.claims(n));
 END LOOP; END LOOP; END LOOP; END LOOP; END LOOP;
 UPDATE public.automation_flow_global_switch SET enabled=true;
 UPDATE public.automation_flow_tenant_switches SET enabled=true,test_only=false,production_approved=true WHERE tenant_id='${A}';
 RETURN out;
END $f$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cc TO service_role;
ANALYZE;`;
function buildBase(){
 ok("postgres",{sql:"CREATE DATABASE base;"},"createdb");
 ok("base",{sql:src("tests/sql/fixtures/flow-live-shape-bootstrap.sql")},"live shape");
 for(const f of CHAIN)ok("base",f==="@LIVE"?{sql:LIVE}:{file:f},f);
 ok("base",{sql:SEED},"seed");
}
before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-canary-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+41)%20000);
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
function clone(prefix,template="base"){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},`clone ${db}`);
 return db;
}
const FP=data=>`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||
  coalesce(p.proacl::text,'')||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||pg_get_function_result(p.oid)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')||':'||c.relrowsecurity
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'i:'||pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'c:'||a.attrelid::regclass::text||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||
  coalesce(pg_get_expr(d.adbin,d.adrelid),'')
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v') AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid)||':'||convalidated
  FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 'p:'||polrelid::regclass::text||':'||polname FROM pg_policy
 UNION ALL SELECT 't:'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text FROM pg_trigger t WHERE NOT t.tgisinternal
 ${data?`UNION ALL SELECT 'd:'||c.oid::regclass::text||':'||md5(query_to_xml(
   format('SELECT t::text AS v FROM %s t ORDER BY 1',c.oid::regclass),false,false,'')::text)
  FROM pg_class c WHERE c.relkind IN('r','p') AND c.relnamespace='public'::regnamespace`:""}
) s(x);`;
const fp=(db,data=true)=>ok(db,{sql:FP(data)},"fingerprint");
const OLD_FN=`SELECT md5(pg_get_functiondef('${OLD_SIG}'::regprocedure))||':'||
 coalesce(obj_description('${OLD_SIG}'::regprocedure,'pg_proc'),'')||':'||
 (SELECT coalesce(proacl::text,'') FROM pg_proc WHERE oid='${OLD_SIG}'::regprocedure)`;
const REGISTER=(t=A,a=ACC)=>`INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by)
 VALUES('${t}','${a}','instagram','test-operator');`;
const SR="service_role";
const dc=(db,name,over="")=>rows(db,`SELECT acquired,route FROM cc.dc('${name}'${over})`,SR);
const claims=(db,name)=>val(db,`SELECT cc.claims('${name}')`);
const audit=db=>Number(val(db,"SELECT count(*) FROM public.automation_flow_canary_claims"));
const mk=(db,name,t=A,a=ACC)=>ok(db,{sql:`SELECT cc.mk('${name}','${t}','${a}');`},`event ${name}`);
// Installed + registered canary database.
function canaryDb(prefix){
 const db=clone(prefix);
 ok(db,{file:MIG},"170000");
 ok(db,{sql:REGISTER()},"operator registers the canary");
 return db;
}

test("(a) flow_claim_inbound (V2) is byte-for-byte unchanged by 170000, and behaves identically over the switch matrix",{skip},()=>{
 const pre=clone("v2pre"),post=clone("v2post");
 const before=ok(post,{sql:OLD_FN},"old fn before");
 assert.equal(before,ok(pre,{sql:OLD_FN},"old fn pre"));
 ok(post,{file:MIG},"170000");
 assert.equal(ok(post,{sql:OLD_FN},"old fn after"),before,"md5(pg_get_functiondef), marker and ACL identical");
 assert.equal(ok(post,{sql:`SELECT md5(prosrc) FROM pg_proc WHERE oid='${OLD_SIG}'::regprocedure`},"src"),
  md5(body(CLAIM,"claim")),"installed body is exactly the 20261028220000 file body");
 ok(post,{sql:REGISTER()},"register (must not influence V2)");
 const m1=JSON.parse(ok(pre,{sql:"SET ROLE service_role; SELECT cc.matrix('mx');"},"matrix pre"));
 const m2=JSON.parse(ok(post,{sql:"SET ROLE service_role; SELECT cc.matrix('mx');"},"matrix post"));
 assert.equal(m1.length,32);
 assert.deepEqual(m2,m1,"identical V2 output and side effects for all 32 switch/engine combinations");
 // Spot checks of the (unchanged) V2 rule: 'flow' only for test_only + engine ready + switches on.
 const by=Object.fromEntries(m1.map(r=>[r.k,r]));
 assert.equal(by.truetruetruetruetrue.first,"true/flow");
 assert.equal(by.truetruefalsetruetrue.first,"true/legacy_ai","production_approved without test_only stays legacy in V2");
 for(const r of m1){assert.match(r.second,/^false\//);assert.equal(r.same_claim,true);assert.match(r.rows,/^1:/);}
 assert.equal(audit(post),0,"V2 claims never write canary audit rows");
});

test("(b) approved, registered canary routes to the durable engine with exactly one claim",{skip},()=>{
 const db=canaryDb("ok");
 mk(db,"b1");
 assert.deepEqual(dc(db,"b1"),[{acquired:true,route:"flow"}]);
 assert.equal(claims(db,"b1"),"1:flow");assert.equal(audit(db),1);
 const run=val(db,`SELECT public.flow_begin_durable_run('${A}','${ACC}',e.conv,e.msg,e.mid,'buttons',1,'start','choose',1,
  'awaiting_input','{}'::jsonb,NULL,'[{"kind":"question","idempotencyKey":"q.b1","payload":{"kind":"question","text":"choose"}}]'::jsonb)
  FROM cc.ev e WHERE e.name='b1'`,SR);
 assert.match(String(run),/^[0-9a-f-]{36}$/,"durable run begins on the canary claim");
 assert.deepEqual(rows(db,`SELECT run_status,current_node_id FROM public.automation_flow_runs WHERE id='${run}'`),
  [{run_status:"awaiting_input",current_node_id:"choose"}]);
 // Tap on the same run: claimed through the canary function, resumes the branch.
 ok(db,{sql:`INSERT INTO cc.ev SELECT 'b1tap',tenant,acc,conv,cc.inbound(tenant,conv,'mid.b1tap'),'mid.b1tap' FROM cc.ev WHERE name='b1';`},"tap");
 assert.deepEqual(dc(db,"b1tap"),[{acquired:true,route:"flow"}]);
 assert.equal(val(db,`SELECT public.flow_resume_button_run('${A}','${run}',e.mid,e.msg,1,'choose','yes',2,'completed','{}'::jsonb,NULL,
  '[{"kind":"message","idempotencyKey":"m.b1","payload":{"kind":"message","text":"prices text"}}]'::jsonb) FROM cc.ev e WHERE e.name='b1tap'`,SR),true);
 assert.equal(val(db,`SELECT run_status FROM public.automation_flow_runs WHERE id='${run}'`),"completed");
 assert.equal(audit(db),2);
});

test("(c)(d) not approved, switched off or test_only tenants: no row, no claim; V2 then claims normally",{skip},()=>{
 const db=canaryDb("na");
 const cases=[
  ["c_unapproved",`UPDATE public.automation_flow_tenant_switches SET production_approved=false WHERE tenant_id='${A}';`],
  ["c_tenant_off",`UPDATE public.automation_flow_tenant_switches SET enabled=false WHERE tenant_id='${A}';`],
  ["c_global_off",`UPDATE public.automation_flow_global_switch SET enabled=false;`],
  ["c_no_switch_row",`DELETE FROM public.automation_flow_tenant_switches WHERE tenant_id='${A}';`],
  ["d_test_only",`UPDATE public.automation_flow_tenant_switches SET test_only=true WHERE tenant_id='${A}';`],
  ["c_inactive_activation",`UPDATE public.automation_flow_activations SET is_active=false WHERE tenant_id='${A}' AND channel_account_id='${ACC}';`],
  ["c_account_paused",`UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}';`],
  ["c_tenant_inactive",`UPDATE public.tenants SET is_active=false WHERE id='${A}';`],
  ["c_not_registered",`DELETE FROM public.automation_flow_canary_accounts;`],
 ];
 const RESET=`UPDATE public.automation_flow_global_switch SET enabled=true;
  INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved) VALUES('${A}',true,false,true)
  ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
  UPDATE public.automation_flow_activations SET is_active=true WHERE tenant_id='${A}';
  UPDATE public.channel_accounts SET auto_reply=true WHERE id='${ACC}'; UPDATE public.tenants SET is_active=true WHERE id='${A}';
  INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by)
  VALUES('${A}','${ACC}','instagram','test-operator') ON CONFLICT DO NOTHING;`;
 for(const [name,change] of cases){
  mk(db,name);
  ok(db,{sql:change},name);
  assert.deepEqual(dc(db,name),[],`${name}: not eligible -> no row`);
  assert.equal(claims(db,name),"0:-",`${name}: no claim row`);
  if(name==="d_test_only")
   assert.deepEqual(rows(db,`SELECT acquired,route FROM cc.v2('${name}',true)`,SR),[{acquired:true,route:"flow"}],
    "test_only keeps the unchanged V2/test path");
  else assert.deepEqual(rows(db,`SELECT acquired,route FROM cc.v2('${name}')`,SR),[{acquired:true,route:"legacy_ai"}],
   `${name}: V2 claims the event normally`);
  assert.equal(claims(db,name).split(":")[0],"1");
  ok(db,{sql:RESET},"reset");
 }
 assert.equal(audit(db),0);
 // Control: after every reset the canary is eligible again.
 mk(db,"c_control");assert.deepEqual(dc(db,"c_control"),[{acquired:true,route:"flow"}]);
});

test("(e) account that is not the registered canary, wrong platform, wrong conversation: refused",{skip},()=>{
 const db=canaryDb("acct");
 // Same approved tenant, active activation, but not the registered account.
 mk(db,"e_other",A,ACC2);
 assert.deepEqual(dc(db,"e_other"),[]);assert.equal(claims(db,"e_other"),"0:-");
 assert.deepEqual(rows(db,"SELECT acquired,route FROM cc.v2('e_other')",SR),[{acquired:true,route:"legacy_ai"}]);
 // Registered account, but a different platform argument / non-instagram account.
 mk(db,"e_plat");
 for(const p of ["facebook","whatsapp","Instagram","instagram ",null])
  assert.deepEqual(dc(db,"e_plat",`,p_platform=>${p===null?"NULL":`'${p}'`}`),[],String(p));
 assert.deepEqual(dc(db,"e_plat",`,p_acc=>'${WAA}'`),[],"tenant A whatsapp account");
 assert.equal(claims(db,"e_plat"),"0:-");
 // A registration for another platform cannot even exist.
 fails(db,`INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by)
  VALUES('${B}','${FBB}','facebook','x');`,"23514","facebook registration");
 // Conversation not bound to the canary account / message of another conversation.
 mk(db,"e_conv2");
 ok(db,{sql:`UPDATE public.conversations SET account_id=NULL WHERE id=(SELECT conv FROM cc.ev WHERE name='e_conv2');`},"unbound conv");
 assert.deepEqual(dc(db,"e_conv2"),[],"conversation without account binding");
 mk(db,"e_msg");mk(db,"e_msg2");
 assert.deepEqual(dc(db,"e_msg",`,p_msg=>(SELECT msg FROM cc.ev WHERE name='e_msg2')`),[],"inbound of another conversation");
 assert.deepEqual(dc(db,"e_msg",`,p_conv=>(SELECT conv FROM cc.ev WHERE name='e_msg2')`),[],"conversation of another inbound");
 for(const n of ["e_conv2","e_msg","e_msg2"])assert.equal(claims(db,n),"0:-",n);
 assert.equal(audit(db),0);
 // Bad arguments never error and never claim.
 assert.deepEqual(rows(db,`SELECT * FROM public.flow_claim_inbound_durable(NULL,NULL,NULL,NULL,NULL,NULL)`,SR),[]);
 assert.deepEqual(rows(db,`SELECT * FROM public.flow_claim_inbound_durable('${A}','${ACC}','instagram',repeat('x',257),
  (SELECT conv FROM cc.ev WHERE name='e_msg'),(SELECT msg FROM cc.ev WHERE name='e_msg'))`,SR),[]);
});

test("(f) duplicate webhook: concurrent and sequential redelivery -> exactly one claim, acquired=false, no 23505",{skip},async()=>{
 const db=canaryDb("dup");
 mk(db,"f_seq");
 const first=rows(db,"SELECT * FROM cc.dc('f_seq')",SR),second=rows(db,"SELECT * FROM cc.dc('f_seq')",SR);
 assert.equal(first[0].acquired,true);assert.equal(second[0].acquired,false);
 assert.equal(second[0].route,"flow");assert.equal(second[0].claim_id,first[0].claim_id);
 assert.equal(second[0].outgoing_message_id,first[0].outgoing_message_id,"winner's claim returned to the loser");
 assert.equal(claims(db,"f_seq"),"1:flow");assert.equal(audit(db),1,"only the winner writes the audit row");
 // V2 after the durable winner: duplicate, V2 stays silent.
 assert.deepEqual(rows(db,"SELECT acquired,route FROM cc.v2('f_seq',true)",SR),[{acquired:false,route:"flow"}]);
 // V2 won first (legacy_ai): the durable function never steals it.
 mk(db,"f_v2first");
 assert.deepEqual(rows(db,"SELECT acquired,route FROM cc.v2('f_v2first')",SR),[{acquired:true,route:"legacy_ai"}]);
 assert.deepEqual(dc(db,"f_v2first"),[{acquired:false,route:"legacy_ai"}]);
 assert.equal(claims(db,"f_v2first"),"1:legacy_ai");assert.equal(audit(db),1);
 // Concurrent: the winner holds its transaction open; the loser blocks on the
 // unique index, then returns the winner's claim (acquired=false), no error.
 for(let i=0;i<3;i++){
  const n=`f_conc${i}`;mk(db,n);
  const call=`SET ROLE service_role; SELECT CASE WHEN acquired THEN 'won' ELSE 'lost' END FROM cc.dc('${n}');`;
  const w=psqlAsync(db,`BEGIN; ${call} SELECT pg_sleep(1.5); COMMIT;`);
  await new Promise(r=>setTimeout(r,400));
  const l=psqlAsync(db,call);
  const [rw,rl]=await Promise.all([w,l]);
  assert.equal(rw.code,0,rw.err);assert.equal(rl.code,0,rl.err);
  assert.doesNotMatch(rw.err+rl.err,/23505|duplicate key/);
  assert.deepEqual([rw.out.trim(),rl.out.trim()],["won","lost"]);
  assert.equal(claims(db,n),"1:flow");
 }
 // Fully parallel burst on one event.
 mk(db,"f_burst");
 const burst=await Promise.all(Array.from({length:6},()=>psqlAsync(db,
  "SET ROLE service_role; SELECT CASE WHEN acquired THEN 'won' ELSE 'lost' END FROM cc.dc('f_burst');")));
 for(const r of burst){assert.equal(r.code,0,r.err);assert.doesNotMatch(r.err,/23505/);}
 assert.equal(burst.filter(r=>r.out.trim()==="won").length,1);
 assert.equal(burst.filter(r=>r.out.trim()==="lost").length,5);
 assert.equal(claims(db,"f_burst"),"1:flow");
 assert.equal(audit(db),5,"f_seq + 3 concurrent + burst: one audit row per event");
});

test("(g) tenant isolation: A's registration never matches B; forged tenant/account pairs refused (composite FK); no cross-tenant read/write",{skip},()=>{
 const db=canaryDb("iso");
 mk(db,"gA");mk(db,"gB",B,ACCB);
 // Tenant B is approved with an active activation, but has no registration.
 assert.deepEqual(dc(db,"gB"),[],"B event, B account: not registered");
 // Forged combinations.
 const forged=[
  [`,p_tenant=>'${B}'`,"B tenant with A canary account/conv/msg"],
  [`,p_acc=>'${ACCB}'`,"A tenant with B account"],
  [`,p_tenant=>'${A}',p_acc=>'${ACC}'`,"A tenant + A account but B conversation/inbound"],
 ];
 assert.deepEqual(dc(db,"gA",forged[0][0]),[],forged[0][1]);
 assert.deepEqual(dc(db,"gA",forged[1][0]),[],forged[1][1]);
 assert.deepEqual(dc(db,"gB",forged[2][0]),[],forged[2][1]);
 assert.deepEqual(dc(db,"gA",`,p_conv=>(SELECT conv FROM cc.ev WHERE name='gB'),p_msg=>(SELECT msg FROM cc.ev WHERE name='gB')`),[],
  "A ids with B conversation/inbound");
 assert.equal(claims(db,"gA"),"0:-");assert.equal(claims(db,"gB"),"0:-");assert.equal(audit(db),0);
 // B's own claim (via V2) is never returned to a tenant-A caller.
 assert.deepEqual(rows(db,"SELECT acquired,route FROM cc.v2('gB')",SR),[{acquired:true,route:"legacy_ai"}]);
 assert.deepEqual(rows(db,`SELECT * FROM public.flow_claim_inbound_durable('${A}','${ACC}','instagram','mid.gB',
  (SELECT conv FROM cc.ev WHERE name='gB'),(SELECT msg FROM cc.ev WHERE name='gB'))`,SR),[]);
 // Registration integrity: forged tenant/account pairs cannot be stored.
 // (inside a rolled-back transaction without A's own registration, so only the FK can refuse it)
 fails(db,`BEGIN; DELETE FROM public.automation_flow_canary_accounts WHERE tenant_id='${A}';\n${REGISTER(A,ACCB)}`,"23503",
  "A tenant + B account (composite FK)");
 fails(db,`BEGIN; DELETE FROM public.automation_flow_canary_accounts WHERE tenant_id='${A}';\n${REGISTER(A,FBB)}`,"23503",
  "A tenant + B facebook account (composite FK)");
 fails(db,REGISTER(B,ACC),"23505","B tenant + A account: the account is already the A canary");
 fails(db,`BEGIN; DELETE FROM public.automation_flow_canary_accounts WHERE tenant_id='${A}';\n${REGISTER(B,ACC)}`,"23503",
  "B tenant + A account (composite FK)");
 fails(db,REGISTER(A,ACC2),"23505","second canary for the same tenant/platform");
 fails(db,REGISTER(B,"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),"23503","unknown account");
 fails(db,`UPDATE public.channel_accounts SET tenant_id='${B}' WHERE id='${ACC}';`,"23503","moving the canary account to another tenant");
 // Privileges: only an operator session can register; clients see nothing.
 fails(db,REGISTER(B,ACCB),"42501","service_role cannot register a canary",SR);
 fails(db,`UPDATE public.automation_flow_canary_accounts SET channel_account_id='${ACC2}';`,"42501","service_role cannot re-point",SR);
 fails(db,`DELETE FROM public.automation_flow_canary_accounts;`,"42501","service_role cannot delete",SR);
 fails(db,`UPDATE public.automation_flow_canary_claims SET tenant_id='${B}';`,"42501","audit is append-only for service_role",SR);
 for(const role of ["anon","authenticated"]){
  fails(db,"SELECT * FROM public.automation_flow_canary_accounts;","42501",`${role} read registration`,role);
  fails(db,"SELECT * FROM public.automation_flow_canary_claims;","42501",`${role} read audit`,role);
  fails(db,`SELECT * FROM public.flow_claim_inbound_durable('${A}','${ACC}','instagram','x','${A}','${A}');`,"42501",`${role} execute`,role);
 }
 assert.deepEqual(rows(db,`SELECT relrowsecurity AS rls,(SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid)::int AS policies
  FROM pg_class c WHERE c.oid IN('public.automation_flow_canary_accounts'::regclass,'public.automation_flow_canary_claims'::regclass)`),
  [{rls:true,policies:0},{rls:true,policies:0}]);
 assert.deepEqual(rows(db,`SELECT prosecdef,proconfig FROM pg_proc WHERE oid='${SIG}'::regprocedure`),
  [{prosecdef:false,proconfig:['search_path=""']}]);
 // The legitimate canary still works after all forged attempts.
 assert.deepEqual(dc(db,"gA"),[{acquired:true,route:"flow"}]);
 assert.deepEqual(rows(db,"SELECT tenant_id,channel_account_id FROM public.automation_flow_canary_claims"),
  [{tenant_id:A,channel_account_id:ACC}]);
 assert.equal(Number(val(db,`SELECT count(*) FROM public.automation_message_claims WHERE tenant_id='${B}' AND route='flow'`)),0);
});

test("(h) production canary retry and lease expiry: failed begin + redelivery idempotent; crashed lease re-leased; one commit, one send",{skip},()=>{
 const db=canaryDb("lease");
 mk(db,"h1");
 assert.deepEqual(dc(db,"h1"),[{acquired:true,route:"flow"}]);
 const begin=(next_step)=>val(db,`SELECT public.flow_begin_durable_run('${A}','${ACC}',e.conv,e.msg,e.mid,'delay',1,'start','sleep',${next_step},
  'sleeping','{}'::jsonb,now()+interval '30 seconds','[{"kind":"delay","idempotencyKey":"d.h1","payload":{"kind":"delay"}}]'::jsonb)
  FROM cc.ev e WHERE e.name='h1'`,SR);
 // Begin fails (rejected arguments): nothing persisted, claim kept.
 assert.equal(begin(0),null);
 assert.equal(Number(val(db,"SELECT count(*) FROM public.automation_flow_runs WHERE provider_event_id='mid.h1'")),0);
 // Redelivery of the same webhook: claim is not re-acquired -> caller stops ("handled").
 assert.deepEqual(dc(db,"h1"),[{acquired:false,route:"flow"}]);
 assert.equal(claims(db,"h1"),"1:flow");assert.equal(audit(db),1);
 // The (single) successful begin; a repeated begin for the same event is inert.
 const run=begin(1);
 assert.match(String(run),/^[0-9a-f-]{36}$/);
 assert.equal(begin(1),null,"receipt makes begin idempotent per event");
 assert.equal(Number(val(db,"SELECT count(*) FROM public.automation_flow_runs WHERE provider_event_id='mid.h1'")),1);
 // Due; worker 1 leases and crashes.
 ok(db,{sql:`UPDATE public.automation_flow_runs SET wake_at=now()-interval '1 second' WHERE id='${run}';`},"due");
 const l1=rows(db,"SELECT run_id,lease_token FROM public.flow_lease_due_runs(20)",SR);
 assert.deepEqual(l1.map(r=>r.run_id),[run]);
 assert.deepEqual(rows(db,"SELECT run_id FROM public.flow_lease_due_runs(20)",SR),[],"held lease not re-leased");
 ok(db,{sql:`UPDATE public.automation_flow_run_leases SET expires_at=now()-interval '1 second' WHERE run_id='${run}';`},"expire");
 const l2=rows(db,"SELECT run_id,lease_token FROM public.flow_lease_due_runs(20)",SR);
 assert.deepEqual(l2.map(r=>r.run_id),[run],"expired lease re-leased");
 assert.notEqual(l2[0].lease_token,l1[0].lease_token);
 const commit=tok=>val(db,`SELECT public.flow_commit_run_step('${A}','${run}',1,'sleeping','yes',2,'completed','{}'::jsonb,NULL,
  '[{"kind":"message","idempotencyKey":"m.h1","payload":{"kind":"message","text":"later"}}]'::jsonb,'completed','${tok}')`,SR);
 assert.equal(commit(l1[0].lease_token),false,"crashed worker's stale token rejected");
 assert.equal(commit(l2[0].lease_token),true,"step commits once");
 assert.equal(commit(l2[0].lease_token),false,"never twice");
 const fx=rows(db,`SELECT id,effect_kind FROM public.automation_flow_outbox WHERE run_id='${run}' ORDER BY created_at,effect_kind`);
 assert.deepEqual(fx.map(f=>f.effect_kind).sort(),["delay","message"]);
 const msg=fx.find(f=>f.effect_kind==="message").id;
 // Single send: the outbox reservation (send lock) succeeds exactly once.
 assert.equal(val(db,`SELECT public.flow_reserve_outbox_delivery('${A}','${msg}')`,SR),true);
 assert.equal(val(db,`SELECT public.flow_reserve_outbox_delivery('${A}','${msg}')`,SR),false);
 assert.equal(Number(val(db,`SELECT count(*) FROM public.automation_flow_delivery_attempts WHERE outbox_id='${msg}'`)),1);
});

test("(i) migration: preflight refusal, idempotent re-apply, rollback guard + opt-in, exact pre-170000 fingerprints",{skip},()=>{
 // Preflight: refused on a chain without 160000 / with a foreign object.
 const pre160=clone("pf");
 ok(pre160,{file:OLDER_RB[0]},"160000 rollback");
 refused(pre160,MIG,/apply 20261029160000_flow_credits_pause first/,"170000 without 160000");
 const foreign=clone("pf");
 ok(foreign,{sql:"CREATE TABLE public.automation_flow_canary_accounts(x int);"},"foreign table");
 refused(foreign,MIG,/Unrecognized existing table public\.automation_flow_canary_accounts/,"foreign table");
 const foreignFn=clone("pf");
 ok(foreignFn,{sql:`CREATE FUNCTION public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)
  RETURNS TABLE(acquired boolean,route text,claim_id uuid,outgoing_message_id uuid) LANGUAGE sql AS 'SELECT true,''flow'',NULL::uuid,NULL::uuid';`},"foreign fn");
 refused(foreignFn,MIG,/Unrecognized existing function public\.flow_claim_inbound_durable/,"foreign function");
 const noCol=clone("pf");
 ok(noCol,{sql:"ALTER TABLE public.automation_flow_tenant_switches RENAME COLUMN production_approved TO pa;"},"no column");
 refused(noCol,MIG,/boolean column public\.automation_flow_tenant_switches\.production_approved/,"no production_approved");
 // Apply / re-apply / rollback.
 const db=clone("mig");
 const pre=fp(db),preSchema=fp(db,false),oldFn=ok(db,{sql:OLD_FN},"old");
 refused(db,RB,/20261029170000_flow_canary_claim_durable not installed; nothing to roll back/,"rollback before apply");
 ok(db,{file:MIG},"170000");
 const once=fp(db,false);
 ok(db,{file:MIG},"170000 re-applied");
 assert.equal(fp(db,false),once,"re-apply is a no-op");
 for(const f of OLDER_RB)refused(db,f,/roll back 20261029170000_flow_canary_claim_durable first/,f);
 // Without data the rollback restores the exact pre-170000 schema + data.
 ok(db,{file:RB},"170000 rollback (empty)");
 assert.equal(fp(db),pre,"pre-170000 schema+data fingerprint restored");
 assert.equal(ok(db,{sql:OLD_FN},"old"),oldFn);
 refused(db,RB,/nothing to roll back/,"rollback twice");
 // With a registration and canary claims: refused unless the operator opts in.
 ok(db,{file:MIG},"170000 again");
 assert.equal(fp(db,false),once,"re-apply after rollback reproduces the schema");
 ok(db,{sql:REGISTER()},"register");mk(db,"i1");
 assert.deepEqual(dc(db,"i1"),[{acquired:true,route:"flow"}]);
 refused(db,RB,/1 canary registration\(s\) and 1 canary claim audit row\(s\) would be lost/,"rollback with data");
 refused(db,RB,/would be lost/,"wrong opt-in value",{PGOPTIONS:"-c flow.rollback_170000=yes"});
 ok(db,{file:RB,env:{PGOPTIONS:OPT_IN}},"170000 rollback (explicit opt-in)");
 assert.equal(fp(db,false),preSchema,"pre-170000 schema fingerprint restored");
 assert.equal(ok(db,{sql:OLD_FN},"old"),oldFn,"V2 function still identical");
 assert.equal(claims(db,"i1"),"1:flow","claims themselves are kept by the rollback");
 // Correct order continues: 160000 rollback is accepted now.
 ok(db,{file:OLDER_RB[0]},"160000 rollback after 170000 rollback");
});

test("(i) predeploy checks report the 170000 objects and verify the intended canary registration (read only)",{skip},()=>{
 const db=clone("pdc");
 const run=(opts="")=>{
  const r=psql(db,{file:CHECKS,tab:true,env:opts?{PGOPTIONS:opts}:{}});
  assert.equal(r.status,0,r.stderr);
  return r.stdout.split("\n").map(l=>l.split("\t")).filter(c=>c.length===7)
   .map(([section,item,status,tenant_id,n,ids,detail])=>({section,item,status,tenant_id,n,ids,detail}));
 };
 const get=(rs,item)=>{const m=rs.filter(r=>r.item===item);assert.equal(m.length,1,item);return m[0];};
 const want=(t,a)=>`-c flow.canary_tenant=${t} -c flow.canary_account=${a}`;
 let rs=run();
 assert.equal(get(rs,"canary_registration").status,"ABSENT");
 assert.equal(get(rs,"canary_claim_function").status,"ABSENT");
 assert.equal(get(rs,`claim_v2_unchanged:${OLD_SIG}`).status,"OK");
 assert.equal(get(rs,`function:${SIG}`).status,"ABSENT");
 ok(db,{file:MIG},"170000");
 rs=run();
 for(const i of ["canary_claim_function","canary_table:public.automation_flow_canary_accounts",
  "canary_table:public.automation_flow_canary_claims",`function:${SIG}`,`claim_v2_unchanged:${OLD_SIG}`])
  assert.equal(get(rs,i).status,"OK",`${i}: ${get(rs,i).detail}`);
 assert.equal(get(rs,"canary_registration").status,"INFO");
 assert.equal(get(rs,"canary_registration").n,"0");
 assert.ok(!rs.some(r=>r.status.startsWith("CONFLICT")),JSON.stringify(rs.filter(r=>r.status.startsWith("CONFLICT"))));
 assert.equal(get(run(want(A,ACC)),"canary_registration").status,"MISSING: canary registration");
 ok(db,{sql:REGISTER()},"register");
 let r=get(run(want(A,ACC)),"canary_registration");
 assert.equal(r.status,"OK",r.detail);assert.equal(r.tenant_id,A);assert.equal(r.ids,ACC);
 assert.equal(get(run(want(A,ACC2)),"canary_registration").status,"CONFLICT: canary registration","registered account differs");
 assert.equal(get(run(want(A,ACCB)),"canary_registration").status,"CONFLICT: canary registration","account of another tenant");
 assert.equal(get(run(want(B,ACCB)),"canary_registration").status,"MISSING: canary registration");
 assert.equal(get(run(want("nope",ACC)),"canary_registration").status,"WARN");
 ok(db,{sql:`UPDATE public.automation_flow_tenant_switches SET test_only=true WHERE tenant_id='${A}';`},"test_only");
 r=get(run(want(A,ACC)),"canary_registration");
 assert.equal(r.status,"WARN");assert.match(r.detail,/not eligible yet: tenant test_only off/);
 // Tampering is detected.
 ok(db,{sql:"GRANT INSERT ON public.automation_flow_canary_accounts TO service_role;"},"tamper grant");
 assert.equal(get(run(),"canary_table:public.automation_flow_canary_accounts").status,
  "CONFLICT: public.automation_flow_canary_accounts privileges");
 ok(db,{sql:"GRANT EXECUTE ON FUNCTION public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid) TO anon;"},"tamper fn");
 assert.match(get(run(),"canary_claim_function").status,/privileges$/);
});
