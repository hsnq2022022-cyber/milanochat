// 20261029340000_flow_inbound_routing_retry and
// 20261029350000_flow_durable_keyword_start, against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) built exactly like
// tests/flow-claim-begin-durable-run.test.mjs: repo fixture chain, migrations
// 20261028220000 .. 20261029300000, the PRODUCTION flow_claim_inbound body and
// 20261029330000. Never connects to any remote host; inherited PG* variables
// are stripped. Static checks always run.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const M="supabase/migrations/";
const R="supabase/rollbacks/";
const RETRY=M+"20261029340000_flow_inbound_routing_retry.sql";
const RETRY_RB=R+"20261029340000_flow_inbound_routing_retry.rollback.sql";
const KW=M+"20261029350000_flow_durable_keyword_start.sql";
const KW_RB=R+"20261029350000_flow_durable_keyword_start.rollback.sql";
const MIG330=M+"20261029330000_flow_claim_begin_durable_run.sql";
const PROD_CLAIM="tests/sql/fixtures/production-flow-claim-inbound.sql";
const ARGS="boolean,uuid,uuid,text,text,uuid,uuid,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb";
const SIG=`public.flow_claim_begin_durable_run(${ARGS})`;
const BEGIN_SIG="public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)";
const FAILED_SIG="public.flow_inbound_routing_failed(uuid,uuid,text,text,uuid,uuid,integer)";
const RESOLVED_SIG="public.flow_inbound_routing_resolved(uuid,uuid,text,text)";
const BEGIN_230_MD5="d0fea89cd85053ee62276bccf4156d43";
const CHAIN125_300=["20261029125000_flow_durable_button_run","20261029130000_flow_run_lifecycle",
 "20261029140000_flow_outbox_ai_retry","20261029150000_flow_takeover_resume","20261029160000_flow_credits_pause",
 "20261029170000_flow_canary_claim_durable","20261029180000_flow_durable_button_run_guards",
 "20261029190000_flow_begin_durable_run_superseding","20261029210000_flow_media_effects",
 "20261029220000_flow_media_stale_sweep","20261029230000_flow_multichannel_support",
 "20261029300000_comment_replies"].map(n=>M+n+".sql");
const src=f=>readFileSync(f,"utf8");
const md5=x=>createHash("md5").update(x).digest("hex");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");
const between=(s,open,close)=>{const a=s.indexOf(open);assert.ok(a>=0,open);const b=a+open.length;return s.slice(b,s.indexOf(close,b));};
const norm=x=>x.replace(/[ \t\n\r\f\v]+/g," ").replace(/^ +| +$/g,"");

// ---------------------------------------------------------------- static
test("static: both migrations and rollbacks are bounded transactions with markers, pins and no data deletion",()=>{
 for(const f of [RETRY,RETRY_RB,KW,KW_RB]){
  const s=src(f);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
  assert.match(s,/\nCOMMIT;\n$/,f);
  assert.doesNotMatch(noComments(s),/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bUPDATE public\.(?!automation_inbound_routing_retries)/,f);
 }
 const r=src(RETRY);
 assert.match(r,/CREATED_BY_20261029340000_FLOW_INBOUND_ROUTING_RETRY/);
 assert.equal(md5(norm(between(r,"AS $failed$","$failed$"))),between(r,"v_failed_md5 constant text := '","'"));
 assert.equal(md5(norm(between(r,"AS $resolved$","$resolved$"))),between(r,"v_resolved_md5 constant text := '","'"));
 assert.doesNotMatch(noComments(r),/flow_claim_inbound\(|flow_begin_durable_run|flow_claim_begin_durable_run/,"retry migration never replaces claim/begin functions");
 const k=src(KW),kb=src(KW_RB);
 const newBody=between(k,"AS $begin$","$begin$"),oldBody=between(kb,"AS $begin$","$begin$");
 assert.equal(md5(norm(oldBody)),BEGIN_230_MD5,"rollback restores the 230000 body verbatim");
 assert.equal(md5(norm(newBody)),between(k,"v_self_md5 constant text := '","'"));
 assert.equal(md5(norm(newBody)),between(kb,"v_self_md5 constant text := '","'"));
 // the 230000 body as written in that migration
 const m230=src(M+"20261029230000_flow_multichannel_support.sql");
 const i=m230.indexOf("CREATE OR REPLACE FUNCTION public.flow_begin_durable_run(");
 assert.equal(between(m230.slice(i),"AS $begin$","$begin$"),oldBody);
 // Only the start-node predicate differs.
 const d=newBody.split("\n").filter(l=>!oldBody.split("\n").includes(l));
 assert.ok(d.length>0&&d.every(l=>/triggerMode|keywords|btrim|--|^\s*AND \(n#>>|^\s*\(n#>>/.test(l)),JSON.stringify(d));
 assert.match(newBody,/n#>>'\{data,triggerMode\}'='message' OR/);
 assert.doesNotMatch(newBody,/'comment'/);
 for(const f of [RETRY_RB,KW_RB])assert.match(src(f),/Refusing/);
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
// Schema (+ optionally data) fingerprint of schema public. exclude: function name left out.
const FP=(data,exclude)=>`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||
  coalesce(p.proacl::text,'')||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||pg_get_function_result(p.oid)||':'||
  p.prosecdef||':'||pg_get_function_arguments(p.oid)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ${exclude?`AND p.proname<>'${exclude}'`:""}
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')||':'||c.relrowsecurity
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'i:'||pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'c:'||a.attrelid::regclass::text||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v') AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid)||':'||convalidated
  FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 't:'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text FROM pg_trigger t WHERE NOT t.tgisinternal
  AND t.tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
 ${data?`UNION ALL SELECT 'd:'||c.oid::regclass::text||':'||md5(query_to_xml(
   format('SELECT t::text AS v FROM %s t ORDER BY 1',c.oid::regclass),false,false,'')::text)
  FROM pg_class c WHERE c.relkind IN('r','p') AND c.relnamespace='public'::regnamespace`:""}
) s(x);`;
const fp=(db,data=true,exclude)=>ok(db,{sql:FP(data,exclude)},"fingerprint").out;
function refused(db,file,re,label,env){
 const before=fp(db);
 const r=psql(db,{file,env});
 assert.notEqual(r.status,0,`${label} must be refused`);
 assert.match(r.stderr,re,label);
 assert.equal(fp(db),before,`${label}: refused without any change`);
}

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111";
const ACCB="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const buttons=trigger=>({version:3,name:"kw",nodes:[
 {id:"start",data:trigger},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"choose",image:"",contentBlocks:[],options:[
  {id:"prices",label:"prices"},{id:"support",label:"support"}]}},
 {id:"yes",data:{kind:"message",text:"p",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"s",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},{source:"choose",target:"yes",sourceHandle:"prices"},
  {source:"choose",target:"no",sourceHandle:"support"}]});
const T0={kind:"trigger",platform:"instagram"};
const J=o=>`'${JSON.stringify(o).replace(/'/g,"''")}'::jsonb`;
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
const CHAIN=["tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
 "tests/sql/flow-exclusive-claim-bootstrap.sql","@LIVE",
 M+"20261028220000_webhook_exclusive_claim.sql",M+"20261028224000_delivery_attempts.sql",
 M+"20261028225000_flow_runtime_advance.sql",M+"20261028226000_flow_outbox_delivery_attempts.sql",
 "tests/sql/flow-staff-membership-bootstrap.sql",M+"20261028227000_tenant_staff_memberships.sql",
 M+"20261028228000_flow_internal_actions.sql",...CHAIN125_300];
// One publication per trigger variant (all active: several flows per account).
const FLOWS={kmsg:{...T0,triggerMode:"message"},kkw:{...T0,triggerMode:"keyword",keywords:"menu, price list"},
 kblank:{...T0,triggerMode:"keyword",keywords:" ، , "},kcomment:{...T0,triggerMode:"comment",keywords:"x"},
 kexact:{...T0,triggerMode:"keyword",keywords:"menu",operator:"exact"}};
const SEED=`
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES ('${ACCB}','${B}','instagram','instagram');
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by) VALUES
${Object.entries(FLOWS).map(([k,t])=>` ('${A}','${k}',1,'${ACC}','instagram',${J(buttons(t))},'88888888-8888-4888-8888-888888888888')`).join(",\n")};
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active) VALUES
${Object.keys(FLOWS).map(k=>` ('${A}','${ACC}','instagram','${k}',1,true)`).join(",\n")};
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved)
VALUES('${A}',true,false,true),('${B}',true,false,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by) VALUES
 ('${A}','${ACC}','instagram','op');
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO service_role;
CREATE TABLE t.e(name text PRIMARY KEY,tenant uuid,acc uuid,conv uuid,msg uuid,mid text);
CREATE FUNCTION t.ev(p_name text,p_tenant uuid,p_acc uuid) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; m uuid;
BEGIN
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(gen_random_uuid(),p_tenant,p_acc,'instagram:'||gen_random_uuid()) RETURNING id INTO c;
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
 VALUES(p_tenant,c,'in','mid.'||p_name) RETURNING id INTO m;
 INSERT INTO t.e VALUES(p_name,p_tenant,p_acc,c,m,'mid.'||p_name);
END $f$;
ANALYZE;`;
const SR="service_role";
const L=v=>v===null||v===undefined?"NULL":`'${String(v).replace(/'/g,"''")}'`;
const Q_EFFECT=k=>`[{"kind":"question","idempotencyKey":"q.${k}","payload":{"kind":"question","text":"choose","inputMode":"buttons","choices":["prices","support"],"choiceIds":["prices","support"]}}]`;
const startSql=(e,flow)=>`SELECT acquired,run_id FROM public.flow_claim_begin_durable_run(true,${L(e.tenant)},${L(e.acc)},'instagram',${L(e.mid)},${L(e.conv)},${L(e.msg)},${L(flow)},1,'start','choose',1,'awaiting_input','{}'::jsonb,NULL,${L(Q_EFFECT(e.name))}::jsonb)`;
const mk=(db,name,tenant=A,acc=ACC)=>{
 ok(db,{sql:`SELECT t.ev('${name}','${tenant}','${acc}');`},`event ${name}`);
 return rows(db,`SELECT * FROM t.e WHERE name='${name}'`)[0];
};
const claimsOf=(db,e)=>val(db,`SELECT count(*)::int FROM public.automation_message_claims WHERE provider_event_id='${e.mid}'`);
const runsOf=(db,e)=>val(db,`SELECT count(*)::int FROM public.automation_flow_runs WHERE provider_event_id='${e.mid}'`);
const failSql=(e,max=3,o={})=>`SELECT public.flow_inbound_routing_failed(${L(o.tenant??e.tenant)},${L(o.acc??e.acc)},${L(o.platform??"instagram")},${L(o.mid??e.mid)},${L(o.conv??e.conv)},${L(o.msg??e.msg)},${max}) AS s`;
const failed=(db,e,max,o)=>val(db,failSql(e,max,o).replace(/ AS s$/,""),SR);
const resolvedSql=e=>`public.flow_inbound_routing_resolved(${L(e.tenant)},${L(e.acc)},'instagram',${L(e.mid)})`;
const retryRow=(db,e)=>rows(db,`SELECT status,attempts,(resolved_at IS NOT NULL) AS has_resolved FROM public.automation_inbound_routing_retries WHERE provider_event_id='${e.mid}'`)[0];

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-retry-kw-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+340)%20000);
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
 ok("base",{file:PROD_CLAIM},"production flow_claim_inbound");
 ok("base",{file:MIG330},"330000");
 ok("postgres",{sql:"CREATE DATABASE g340 TEMPLATE base;"},"g340");
 ok("g340",{file:RETRY},"340000");
 ok("postgres",{sql:"CREATE DATABASE g350 TEMPLATE base;"},"g350");
 ok("g350",{file:KW},"350000");
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
const bodyMd5=(db,sig)=>val(db,`SELECT md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))) FROM pg_proc WHERE oid='${sig}'::regprocedure`);

// ----------------------------------------------------------- 340000 live
test("340000: pinned body md5s match the installed functions; service_role only; RLS on",{skip},()=>{
 const r=src(RETRY);
 assert.equal(bodyMd5("g340",FAILED_SIG),between(r,"v_failed_md5 constant text := '","'"));
 assert.equal(bodyMd5("g340",RESOLVED_SIG),between(r,"v_resolved_md5 constant text := '","'"));
 for(const role of ["anon","authenticated","public"]){
  assert.equal(val("g340",`SELECT has_function_privilege('${role}','${FAILED_SIG}','EXECUTE')`),false,role);
  assert.equal(val("g340",`SELECT has_function_privilege('${role}','${RESOLVED_SIG}','EXECUTE')`),false,role);
 }
 for(const role of ["anon","authenticated"])
  assert.equal(val("g340",`SELECT has_table_privilege('${role}','public.automation_inbound_routing_retries','SELECT')`),false,role);
 assert.equal(val("g340",`SELECT relrowsecurity FROM pg_class WHERE oid='public.automation_inbound_routing_retries'::regclass`),true);
 // the claim/begin chain is untouched
 assert.equal(bodyMd5("g340",BEGIN_SIG),BEGIN_230_MD5);
 assert.equal(bodyMd5("g340","public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)"),"cced049e635e02b5a0be1353704b5020");
});
test("340000: retrying -> exhausted at max (bounded, terminal, never reopened); resolved is terminal; claimed events untouched",{skip},()=>{
 const db=clone("r",  "g340");
 const e=mk(db,"r1");
 assert.equal(failed(db,e,3),"retrying");
 assert.deepEqual(retryRow(db,e),{status:"retrying",attempts:1,has_resolved:false});
 assert.equal(failed(db,e,3),"retrying");
 assert.equal(failed(db,e,3),"exhausted");
 assert.deepEqual(retryRow(db,e),{status:"exhausted",attempts:3,has_resolved:false});
 assert.equal(failed(db,e,3),"exhausted","terminal: no more attempts counted");
 assert.equal(retryRow(db,e).attempts,3);
 assert.equal(val(db,resolvedSql(e),SR),false,"exhausted is never turned into a success");
 assert.equal(retryRow(db,e).status,"exhausted");
 // resolved
 const f=mk(db,"r2");
 assert.equal(failed(db,f,5),"retrying");
 assert.equal(val(db,resolvedSql(f),SR),true);
 assert.deepEqual(retryRow(db,f),{status:"resolved",attempts:1,has_resolved:true});
 assert.equal(failed(db,f,5),"resolved","a resolved row is never reopened");
 // claimed: nothing written
 const g=mk(db,"r3");
 assert.deepEqual(rows(db,`SELECT acquired,route FROM public.flow_claim_inbound('${A}','${ACC}','instagram','${g.mid}','${g.conv}','${g.msg}',false)`,SR),
  [{acquired:true,route:"legacy_ai"}]);
 assert.equal(failed(db,g,5),"claimed");
 assert.equal(retryRow(db,g),undefined);
});
test("340000: ownership and argument validation (tenant/account/conversation/message/event) write nothing",{skip},()=>{
 const db=clone("v","g340");
 const e=mk(db,"v1"),b=mk(db,"v2",B,ACCB);
 for(const [label,o,max] of [["other tenant",{tenant:B}],["other account",{acc:ACCB}],["other conversation",{conv:b.conv}],
   ["other message",{msg:b.msg}],["other event",{mid:"mid.nope"}],["bad platform",{platform:"sms"}],
   ["platform mismatch",{platform:"facebook"}],["max 0",{},0],["max 21",{},21]]){
  assert.equal(failed(db,e,max??3,o),null,label);
 }
 assert.equal(val(db,"SELECT count(*)::int FROM public.automation_inbound_routing_retries"),0);
 // anon cannot call it at all
 const r=psql(db,{sql:failSql(e)+";",role:"anon"});
 assert.notEqual(r.status,0);assert.match(r.stderr,/permission denied/);
});
test("340000: re-apply idempotent; foreign body / unmarked table / overload refused; rollback guards",{skip},()=>{
 const db=clone("ra","g340");
 ok(db,{file:RETRY},"re-apply");
 const e=mk(db,"ra1");
 assert.equal(failed(db,e,5),"retrying");
 // rollback refuses while a row is retrying, unless acknowledged
 const r1=psql(db,{file:RETRY_RB});
 assert.notEqual(r1.status,0);assert.match(r1.stderr,/retrying inbound events exist/);
 assert.equal(val(db,"SELECT to_regclass('public.automation_inbound_routing_retries') IS NOT NULL"),true);
 ok(db,{sql:"SET flow.inbound_retry_rollback_ack='drop_retrying_rows';\n"+src(RETRY_RB)},"ack rollback");
 assert.equal(val(db,"SELECT to_regclass('public.automation_inbound_routing_retries') IS NULL"),true);
 assert.equal(val(db,`SELECT to_regprocedure('${FAILED_SIG}') IS NULL AND to_regprocedure('${RESOLVED_SIG}') IS NULL`),true);
 // migration again after rollback
 ok(db,{file:RETRY},"apply after rollback");
 // foreign body under the marker: migration and rollback refuse
 const f=clone("rf","g340");
 const def=val(f,`SELECT pg_get_functiondef('${RESOLVED_SIG}'::regprocedure)`);
 ok(f,{sql:def.replace("RETURN FOUND;","RETURN true;")+";"},"foreign body");
 const m=psql(f,{file:RETRY});assert.notEqual(m.status,0);assert.match(m.stderr,/carries the marker but not this migration's body/);
 const rb=psql(f,{file:RETRY_RB});assert.notEqual(rb.status,0);assert.match(rb.stderr,/not the 20261029340000 definition/);
 // unmarked table refused
 const u=clone("ru","base");
 ok(u,{sql:"CREATE TABLE public.automation_inbound_routing_retries(x int);"},"foreign table");
 const mu=psql(u,{file:RETRY});assert.notEqual(mu.status,0);assert.match(mu.stderr,/exists without marker/);
 const ru=psql("base",{file:RETRY_RB});assert.notEqual(ru.status,0);assert.match(ru.stderr,/not installed/);
});

// ----------------------------------------------------------- 350000 live
test("350000: without it a durable KEYWORD start is refused and rolled back (fail safe: V2 acquires)",{skip},()=>{
 const db=clone("pre","base");
 const e=mk(db,"p1");
 assert.equal(bodyMd5(db,BEGIN_SIG),BEGIN_230_MD5);
 assert.deepEqual(rows(db,startSql(e,"kkw"),SR),[]);
 assert.equal(claimsOf(db,e),0);assert.equal(runsOf(db,e),0);
 assert.deepEqual(rows(db,`SELECT acquired,route FROM public.flow_claim_inbound('${A}','${ACC}','instagram','${e.mid}','${e.conv}','${e.msg}',false)`,SR),
  [{acquired:true,route:"legacy_ai"}],"V2/AI acquires the same event: no lost message");
});
test("350000: keyword (incl. exact) and message triggers start; blank keywords and comment triggers still refused",{skip},()=>{
 const db=clone("kw","g350");
 for(const flow of ["kmsg","kkw","kexact"]){
  const e=mk(db,"s_"+flow);
  const r=rows(db,startSql(e,flow),SR);
  assert.equal(r.length,1,flow);assert.equal(r[0].acquired,true,flow);
  assert.equal(claimsOf(db,e),1);assert.equal(runsOf(db,e),1);
  // replay: one run only
  assert.deepEqual(rows(db,startSql(e,flow),SR),[{acquired:false,run_id:null}]);
  assert.equal(runsOf(db,e),1);
 }
 for(const flow of ["kblank","kcomment"]){
  const e=mk(db,"x_"+flow);
  assert.deepEqual(rows(db,startSql(e,flow),SR),[],flow);
  assert.equal(claimsOf(db,e),0,flow);assert.equal(runsOf(db,e),0,flow);
 }
 // tenant isolation: tenant B's account can never start tenant A's flow
 const b=mk(db,"iso",B,ACCB);
 assert.deepEqual(rows(db,startSql(b,"kkw"),SR),[]);
 assert.equal(claimsOf(db,b),0);
});
test("350000: preflight pins; idempotent re-apply; foreign body refused; rollback restores the 230000 body exactly",{skip},()=>{
 const k=src(KW);
 const self=between(k,"v_self_md5 constant text := '","'");
 assert.equal(bodyMd5("g350",BEGIN_SIG),self);
 assert.equal(val("g350",`SELECT split_part(obj_description('${BEGIN_SIG}'::regprocedure,'pg_proc'),' ',1)`),
  "CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS","marker kept");
 for(const role of ["anon","authenticated","public"])
  assert.equal(val("g350",`SELECT has_function_privilege('${role}','${BEGIN_SIG}','EXECUTE')`),false,role);
 assert.equal(val("g350",`SELECT has_function_privilege('service_role','${BEGIN_SIG}','EXECUTE')`),true);
 const db=clone("kr","g350");
 ok(db,{file:KW},"re-apply");
 ok(db,{file:KW_RB},"rollback");
 assert.equal(bodyMd5(db,BEGIN_SIG),BEGIN_230_MD5);
 const rb2=psql(db,{file:KW_RB});assert.notEqual(rb2.status,0);assert.match(rb2.stderr,/not the 20261029350000 definition/);
 // foreign body: migration refuses
 const f=clone("kf","base");
 const def=val(f,`SELECT pg_get_functiondef('${BEGIN_SIG}'::regprocedure)`);
 ok(f,{sql:def.replace("RETURN v_run;","RETURN v_run; -- operator edit")+";"},"foreign begin body");
 const m=psql(f,{file:KW});assert.notEqual(m.status,0);assert.match(m.stderr,/neither the 20261029230000 nor this migration/);
 // 330000 re-apply is refused after 350000 (documented order)
 const r330=psql(clone("k330","g350"),{file:MIG330});
 assert.notEqual(r330.status,0);assert.match(r330.stderr,/does not have the expected definition/);
});
