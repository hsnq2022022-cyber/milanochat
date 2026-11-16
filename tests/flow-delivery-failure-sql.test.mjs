// T6-S4: 20261115150000_flow_delivery_failure_info (provider failure metadata
// on automation_flow_delivery_attempts + public.flow_fail_outbox_delivery).
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) built from the fixture chain and
// the real migrations 20261028220000 .. 20261029230000 + 20261029300000 (the
// newest bodies of flow_reserve_outbox_delivery / effect_kind CHECK), as
// tests/flow-comment-replies-sql.test.mjs. Database "base" = everything
// BEFORE 20261115150000 (= the previous behaviour); "g150" = base + rows that
// existed before + 20261115150000. Never connects to any remote host;
// inherited PG* variables are stripped. No billing function runs.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const M="supabase/migrations/",R="supabase/rollbacks/";
const MIG=M+"20261115150000_flow_delivery_failure_info.sql",RB=R+"20261115150000_flow_delivery_failure_info.rollback.sql";
const MARK="CREATED_BY_20261115150000_FLOW_DELIVERY_FAILURE_INFO";
const FINISH_MD5="1c6ec477519f8c91c24fc2ab82d4b9c4";
const FAIL_SIG="public.flow_fail_outbox_delivery(uuid,uuid,text,text,integer,integer,integer,text)";
const FINISH_SIG="public.flow_finish_outbox_delivery(uuid,uuid,text,text)";
const CHAIN125_190=["20261029125000_flow_durable_button_run","20261029130000_flow_run_lifecycle",
 "20261029140000_flow_outbox_ai_retry","20261029150000_flow_takeover_resume","20261029160000_flow_credits_pause",
 "20261029170000_flow_canary_claim_durable","20261029180000_flow_durable_button_run_guards",
 "20261029190000_flow_begin_durable_run_superseding"].map(f=>M+f+".sql");
const src=f=>readFileSync(f,"utf8");
const norm=s=>s.replace(/[ \t\n\r\v\f]+/g," ").trim();
const md5=s=>createHash("md5").update(s).digest("hex");
const failBody=()=>{const s=src(MIG);return s.slice(s.indexOf("AS $fail$")+9,s.indexOf("END $fail$")+4);};

// ---------------------------------------------------------------- static
test("static: additive migration; flow_finish_outbox_delivery never redefined; self md5 pinned in migration and rollback",()=>{
 const s=src(MIG),rb=src(RB);
 const h=md5(norm(failBody()));
 assert.ok(s.includes(`v_self_md5 constant text := '${h}';`),"migration pins its own body");
 assert.ok(rb.includes(`v_self_md5 constant text := '${h}';`),"rollback pins the same body");
 // No overload / replacement of the four-argument finish.
 assert.doesNotMatch(s,/FUNCTION\s+public\.flow_finish_outbox_delivery\s*\(/i);
 assert.doesNotMatch(s,/DROP\s+FUNCTION/i);
 assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\nSET LOCAL search_path = '';/m);
 assert.match(s,/\nCOMMIT;\n$/);
 assert.match(s,/RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''/);
 assert.doesNotMatch(s,/SECURITY DEFINER\s+SET/);
 assert.match(s,/REVOKE ALL ON FUNCTION public\.flow_fail_outbox_delivery\(uuid,uuid,text,text,integer,integer,integer,text\)\n FROM PUBLIC,anon,authenticated;/);
 assert.match(s,/GRANT EXECUTE ON FUNCTION public\.flow_fail_outbox_delivery\(uuid,uuid,text,text,integer,integer,integer,text\)\n TO service_role;/);
 assert.doesNotMatch(s,/GRANT [^;]* TO [^;]*\b(anon|authenticated|PUBLIC)\b/i);
 // No data rewrite: the only UPDATE statements are inside the function body.
 const outside=s.replace(failBody(),"");
 assert.doesNotMatch(outside,/\bUPDATE\s+public\./i);
 assert.doesNotMatch(outside,/\bDELETE\s+FROM/i);
 const code=s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");
 assert.doesNotMatch(code,/consume_|credits|wayl|charge_pending|settled|cron\.|vault\./i,"no billing reference");
 // Body: every statement keyed by p_tenant.
 for(const m of failBody().matchAll(/WHERE[^;]*;/g))assert.match(m[0],/tenant_id=p_tenant/,m[0]);
 // Stamp: later than 20261115130000, not the reserved 20261115140000.
 const stamps=readdirSync(M).filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0]);
 assert.ok(!stamps.includes("20261115140000"));
 assert.ok(stamps.includes("20261115150000"));
});

// ---------------------------------------------------------------- live PG
function findPgBin(){
 const cands=[];
 if(process.env.PG_BIN)cands.push(process.env.PG_BIN);
 try{for(const v of readdirSync("/usr/lib/postgresql").sort().reverse())cands.push(`/usr/lib/postgresql/${v}/bin`);}catch{}
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
function clientEnv(extra={}){const env={};for(const [k,v] of Object.entries(process.env))if(!k.startsWith("PG"))env[k]=v;return {...env,...extra};}
const pargs=db=>["-X","-q","-t","-A","-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose",
 "-h",dir,"-p",String(port),"-U","postgres","-d",db];
function psql(db,{file,sql,role,env}={}){
 const a=pargs(db);if(file)a.push("-f",file);
 const input=sql===undefined?undefined:(role?`SET ROLE ${role};\n`:"")+sql;
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input,env:clientEnv(env),maxBuffer:1<<26});
}
function psqlAsync(db,sql){
 return new Promise(resolve=>{
  const p=spawn(join(BIN,"psql"),pargs(db),{env:clientEnv()});
  let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
  p.on("close",status=>resolve({status,stdout:out,stderr:err}));
  p.stdin.end(sql);
 });
}
function ok(db,s,label){const r=psql(db,s);assert.equal(r.status,0,`${label}\n${r.stderr}`);return r.stdout.trim();}
function refused(db,s,re,label){const r=psql(db,s);assert.notEqual(r.status,0,`${label}: expected failure`);assert.match(r.stderr,re,label);return r.stderr;}
function rows(db,query,role){
 const r=psql(db,{sql:`SELECT '@@'||coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)::text FROM (${query}) x;`,role});
 assert.equal(r.status,0,`${query}\n${r.stderr}`);
 return JSON.parse(r.stdout.split("\n").find(l=>l.startsWith("@@")).slice(2));
}
const val=(db,query,role)=>rows(db,`SELECT (${query}) AS v`,role)[0]?.v;
const SCHEMA_FP=`SELECT (string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||
  coalesce(p.proacl::text,'')||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||pg_get_function_result(p.oid)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')||':'||c.relrowsecurity
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'c:'||a.attrelid::regclass::text||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid)||':'||convalidated||':'||
  coalesce(obj_description(oid,'pg_constraint'),'')
  FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 'p:'||schemaname||'.'||tablename||':'||policyname FROM pg_policies
) s(x);`;
const fp=db=>ok(db,{sql:SCHEMA_FP},"fingerprint");

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111",ACCB="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const IMG="https://abcd1234.supabase.co/storage/v1/object/public/flow-media/u1/0f8c2b1e-1111-4222-8333-444455556666.webp";
const doc={version:3,name:"fail",nodes:[{id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"m",data:{kind:"message",text:"hi",image:"",options:[],contentBlocks:[]}}],edges:[{source:"start",target:"m",sourceHandle:"next"}]};
const J=o=>`'${JSON.stringify(o).replace(/'/g,"''")}'::jsonb`;
const L=v=>v===null||v===undefined?"NULL":typeof v==="number"?String(v):`'${String(v).replace(/'/g,"''")}'`;
const LIVE=`
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN business_name text NOT NULL DEFAULT 'Test Store';
GRANT USAGE ON SCHEMA public TO anon, authenticated;
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
 M+"20261028228000_flow_internal_actions.sql",...CHAIN125_190,
 M+"20261029210000_flow_media_effects.sql",M+"20261029220000_flow_media_stale_sweep.sql",
 M+"20261029230000_flow_multichannel_support.sql",M+"20261029300000_comment_replies.sql"];
const SEED=`
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES('${ACCB}','${B}','instagram','instagram');
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by) VALUES
 ('${A}','fa',1,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${B}','fb',1,'${ACCB}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active) VALUES
 ('${A}','${ACC}','instagram','fa',1,true),('${B}','${ACCB}','instagram','fb',1,true);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved)
VALUES('${A}',true,false,true),('${B}',true,false,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by) VALUES
 ('${A}','${ACC}','instagram','op'),('${B}','${ACCB}','instagram','op');
CREATE SCHEMA t;
CREATE TABLE t.e(name text PRIMARY KEY,tenant uuid,acc uuid,conv uuid,msg uuid,mid text);
CREATE FUNCTION t.ev(p_name text,p_tenant uuid,p_acc uuid) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; m uuid;
BEGIN
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(gen_random_uuid(),p_tenant,p_acc,'instagram:'||gen_random_uuid()) RETURNING id INTO c;
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
 VALUES(p_tenant,c,'in','mid.'||p_name) RETURNING id INTO m;
 INSERT INTO public.automation_message_claims(tenant_id,channel_account_id,platform,provider_event_id,
  conversation_id,inbound_message_id,route)
 VALUES(p_tenant,p_acc,'instagram','mid.'||p_name,c,m,'flow');
 INSERT INTO t.e VALUES(p_name,p_tenant,p_acc,c,m,'mid.'||p_name);
END $f$;`;
const SR="service_role";
// One durable start whose first commit stores [message seq0, question seq1, image seq2].
function start(db,name,{tenant=A,acc=ACC,flow="fa"}={}){
 const effects=JSON.stringify([
  {kind:"message",idempotencyKey:`m.${name}`,payload:{kind:"message",text:"hello",seq:0}},
  {kind:"question",idempotencyKey:`q.${name}`,payload:{kind:"question",text:"email?",inputMode:"text",seq:1}},
  {kind:"message_image",idempotencyKey:`i.${name}`,payload:{kind:"message_image",url:IMG,seq:2}}]);
 ok(db,{sql:`SELECT t.ev('${name}','${tenant}','${acc}');`},`event ${name}`);
 const e=rows(db,`SELECT * FROM t.e WHERE name='${name}'`)[0];
 const r=psql(db,{role:SR,sql:`SELECT public.flow_begin_durable_run(${L(e.tenant)},${L(e.acc)},${L(e.conv)},${L(e.msg)},${L(e.mid)},`+
  `${L(flow)},1,'start','m',2,'completed','{}'::jsonb,NULL,${L(effects)}::jsonb);`});
 assert.equal(r.status,0,r.stderr);
 const run=val(db,`SELECT r.id FROM public.automation_flow_runs r JOIN t.e ON e.mid=r.provider_event_id WHERE e.name='${name}'`);
 assert.ok(run,`run ${name}`);
 const out=rows(db,`SELECT id,tenant_id,effect_kind FROM public.automation_flow_outbox WHERE run_id='${run}'`);
 const m=Object.fromEntries(out.map(o=>[o.effect_kind,o.id]));
 return {msg:m.message,q:m.question,img:m.message_image};
}
const reserve=(db,tenant,id)=>val(db,`public.flow_reserve_outbox_delivery('${tenant}','${id}')`,SR);
const finishSql=(tenant,id,res,mid=null)=>`public.flow_finish_outbox_delivery('${tenant}','${id}','${res}',${L(mid)})`;
const finish=(db,tenant,id,res,mid=null)=>val(db,finishSql(tenant,id,res,mid),SR);
const I=(cls,st=null,code=null,sub=null,type=null)=>({cls,st,code,sub,type});
const failSql=(tenant,id,res,i)=>`public.flow_fail_outbox_delivery('${tenant}','${id}',${L(res)},${L(i.cls)},${L(i.st)},${L(i.code)},${L(i.sub)},${L(i.type)})`;
const fail=(db,tenant,id,res,i)=>val(db,failSql(tenant,id,res,i),SR);
const STATE_CORE=`o.delivery_status AS s,o.lease_token IS NULL AS no_token,o.lease_expires_at IS NULL AS no_lease,
 o.provider_message_id AS o_mid,o.delivered_at IS NOT NULL AS delivered,o.attempts AS n,a.status AS a,a.provider_message_id AS a_mid,
 a.uncertain_at IS NOT NULL AS unc_at,a.confirmed_at IS NOT NULL AS conf_at,a.review_status AS rv`;
const JOIN=`FROM public.automation_flow_outbox o LEFT JOIN public.automation_flow_delivery_attempts a
  ON a.tenant_id=o.tenant_id AND a.outbox_id=o.id`;
const core=(db,id)=>rows(db,`SELECT ${STATE_CORE} ${JOIN} WHERE o.id='${id}'`)[0];
const info=(db,id)=>rows(db,`SELECT a.failure_class AS cls,a.provider_http_status AS st,a.provider_error_code AS code,
 a.provider_error_subcode AS sub,a.provider_error_type AS type FROM public.automation_flow_delivery_attempts a WHERE a.outbox_id='${id}'`)[0];
const full=(db,id)=>({...core(db,id),...info(db,id)});
const NOINFO={cls:null,st:null,code:null,sub:null,type:null};
const UNC={s:"uncertain",no_token:true,no_lease:true,o_mid:null,delivered:false,n:1,a:"uncertain",a_mid:null,unc_at:true,conf_at:false,rv:"none"};
const DEAD={s:"dead_letter",no_token:true,no_lease:true,o_mid:null,delivered:false,n:1,a:"rejected",a_mid:null,unc_at:false,conf_at:false,rv:"none"};
const LEASED={s:"leased",no_token:false,no_lease:false,o_mid:null,delivered:false,n:1,a:"attempting",a_mid:null,unc_at:false,conf_at:false,rv:"none"};
let PRE={};   // rows created in "base" before 20261115150000 was applied

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-delivery-failure-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+1515)%20000);
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
 // Pre-existing delivery history in every attempt state, then the migration.
 ok("postgres",{sql:"CREATE DATABASE pre TEMPLATE base;"},"pre");
 const e=start("pre","old");
 for(const id of [e.msg,e.q,e.img])assert.equal(reserve("pre",A,id),true);
 assert.equal(finish("pre",A,e.msg,"confirmed","mid.old"),true);
 assert.equal(finish("pre",A,e.q,"uncertain"),true);
 assert.equal(finish("pre",A,e.img,"rejected"),true);
 const f=start("pre","old2");assert.equal(reserve("pre",A,f.msg),true);   // still attempting/leased
 PRE={e,f,before:[e.msg,e.q,e.img,f.msg].map(id=>core("pre",id))};
 ok("postgres",{sql:"CREATE DATABASE g150 TEMPLATE pre;"},"g150");
 ok("g150",{file:MIG},"20261115150000");
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});
let clones=0;
const clone=(p,template="g150")=>{const db=`${p}_${++clones}`;ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},db);return db;};

test("apply: existing rows keep their state and get NULL failure info; postconditions; finish untouched",{skip},()=>{
 const db=clone("apply");
 assert.deepEqual([PRE.e.msg,PRE.e.q,PRE.e.img,PRE.f.msg].map(id=>core(db,id)),PRE.before);
 for(const id of [PRE.e.msg,PRE.e.q,PRE.e.img,PRE.f.msg])assert.deepEqual(info(db,id),NOINFO);
 assert.equal(val(db,`SELECT md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))) FROM pg_proc WHERE oid='${FINISH_SIG}'::regprocedure`),FINISH_MD5);
 assert.equal(val(db,`SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='flow_finish_outbox_delivery'`),1);
 assert.equal(val(db,`SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='flow_fail_outbox_delivery'`),1);
 assert.equal(val(db,`SELECT md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))) FROM pg_proc WHERE oid='${FAIL_SIG}'::regprocedure`),md5(norm(failBody())));
 assert.equal(val(db,`SELECT obj_description('${FAIL_SIG}'::regprocedure,'pg_proc')`),MARK);
 assert.equal(val(db,`SELECT prosecdef FROM pg_proc WHERE oid='${FAIL_SIG}'::regprocedure`),false);
 assert.deepEqual(val(db,`SELECT proconfig FROM pg_proc WHERE oid='${FAIL_SIG}'::regprocedure`),['search_path=""']);
 for(const role of ["anon","authenticated","public"]){
  assert.equal(val(db,`SELECT has_function_privilege('${role}','${FAIL_SIG}','EXECUTE')`),false,role);
  assert.equal(val(db,`SELECT has_function_privilege('${role}','${FINISH_SIG}','EXECUTE')`),false,role);
 }
 assert.equal(val(db,`SELECT has_function_privilege('service_role','${FAIL_SIG}','EXECUTE')`),true);
 assert.equal(val(db,`SELECT has_function_privilege('service_role','${FINISH_SIG}','EXECUTE')`),true);
 for(const role of ["anon","authenticated"])
  assert.equal(val(db,`SELECT has_table_privilege('${role}','public.automation_flow_delivery_attempts','SELECT')`),false,role);
 assert.equal(val(db,`SELECT convalidated FROM pg_constraint WHERE conname='automation_flow_delivery_attempts_failure_info_chk'`),true);
 // The attempt status CHECK (single column) is unchanged: still exactly the 210000 list.
 assert.deepEqual(rows(db,`SELECT pg_get_constraintdef(c.oid) AS d FROM pg_constraint c WHERE c.conrelid='public.automation_flow_delivery_attempts'::regclass
  AND c.contype='c' AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='status')]::int2[]`).map(r=>r.d),
  ["CHECK ((status = ANY (ARRAY['attempting'::text, 'confirmed'::text, 'uncertain'::text, 'rejected'::text])))"]);
 // Callers by anon/authenticated are denied at runtime too.
 const e=start(db,"priv");assert.equal(reserve(db,A,e.msg),true);
 for(const role of ["anon","authenticated"]){
  const r=psql(db,{role,sql:`SELECT ${failSql(A,e.msg,"uncertain",I("ambiguous",500))};`});
  assert.notEqual(r.status,0,role);assert.match(r.stderr,/permission denied/,role);
 }
 assert.deepEqual(core(db,e.msg),LEASED);
 // A delivery reserved BEFORE the migration is finished with info by the new function.
 assert.equal(fail(db,A,PRE.f.msg,"uncertain",I("ambiguous",502)),true);
 assert.deepEqual(full(db,PRE.f.msg),{...UNC,...I("ambiguous",502)});
});

test("re-apply is a no-op; rollback restores the previous schema exactly; apply again works",{skip},()=>{
 const db=clone("cycle");
 const f0=fp(db);
 ok(db,{file:MIG},"re-apply");
 assert.equal(fp(db),f0,"re-apply changes nothing");
 const pre=clone("prefp","pre");
 ok(db,{file:RB},"rollback");
 assert.equal(fp(db),fp(pre),"rollback = schema before 20261115150000");
 assert.deepEqual([PRE.e.msg,PRE.e.q,PRE.e.img,PRE.f.msg].map(id=>core(db,id)),PRE.before,"rows unchanged");
 refused(db,{file:RB},/not installed; nothing to roll back/,"second rollback");
 assert.equal(fp(db),fp(pre));
 ok(db,{file:MIG},"apply again");
 assert.equal(fp(db),f0);
});

test("preflight refuses foreign or partial state, never overwrites",{skip},()=>{
 const cases=[
  ["foreign function","CREATE FUNCTION public.flow_fail_outbox_delivery(p_tenant uuid,p_outbox uuid,p_result text,p_failure_class text,p_http_status integer,p_error_code integer,p_error_subcode integer,p_error_type text) RETURNS boolean LANGUAGE sql AS 'SELECT true';",/Unrecognized existing function/],
  ["foreign overload","CREATE FUNCTION public.flow_fail_outbox_delivery(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';",/Unrecognized overload of public\.flow_fail_outbox_delivery/],
  ["finish overload","CREATE FUNCTION public.flow_finish_outbox_delivery(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';",/Unrecognized overload of public\.flow_finish_outbox_delivery/],
  ["partial columns","ALTER TABLE public.automation_flow_delivery_attempts ADD COLUMN failure_class text;",/Unrecognized failure-info columns/],
  ["finish body changed",`CREATE OR REPLACE FUNCTION ${FINISH_SIG.replace("(uuid,uuid,text,text)","(p_tenant uuid,p_outbox uuid,p_result text,p_provider_message_id text DEFAULT NULL)")} RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $x$BEGIN RETURN false;END$x$;`,/not the 20261029210000 definition/],
 ];
 for(const [label,sql,re] of cases){
  const db=clone("pf","pre");
  ok(db,{sql},label);
  const f0=fp(db);
  refused(db,{file:MIG},re,label);
  assert.equal(fp(db),f0,`${label}: nothing changed`);
 }
 // Marked function with a different body is refused too.
 const db=clone("pf2");
 ok(db,{sql:`CREATE OR REPLACE FUNCTION ${FAIL_SIG.replace("(uuid,uuid,text,text,integer,integer,integer,text)","(p_tenant uuid,p_outbox uuid,p_result text,p_failure_class text,p_http_status integer,p_error_code integer,p_error_subcode integer,p_error_type text)")} RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $f$BEGIN RETURN true;END$f$;`},"tamper");
 refused(db,{file:MIG},/carries the marker but not this migration's body/,"tampered body");
 refused(db,{file:RB},/marked but its body is not the 20261115150000 definition/,"rollback refuses tampered body");
});

test("CHECK: garbage can never be stored (direct writes as the table owner)",{skip},()=>{
 const db=clone("chk");
 const e=start(db,"c");for(const id of [e.msg,e.q])assert.equal(reserve(db,A,id),true);
 assert.equal(finish(db,A,e.msg,"uncertain"),true);
 const upd=(set,id=e.msg)=>psql(db,{sql:`UPDATE public.automation_flow_delivery_attempts SET ${set} WHERE outbox_id='${id}';`});
 const bad=[
  "failure_class='ambiguous',provider_http_status=99","failure_class='ambiguous',provider_http_status=600",
  "failure_class='unknown_class',provider_http_status=400","failure_class='ambiguous',provider_error_code=1000000000",
  "failure_class='ambiguous',provider_error_code=-1","failure_class='ambiguous',provider_error_subcode=1000000000",
  "failure_class='ambiguous',provider_error_type='OAuth Exception'","failure_class='ambiguous',provider_error_type='https://evil.example/x?token=EAAB'",
  "failure_class='ambiguous',provider_error_type=repeat('A',65)","failure_class='ambiguous',provider_error_type='1abc'",
  "provider_http_status=400","provider_error_code=100","provider_error_type='OAuthException'",
  "failure_class='rejected_invalid',provider_http_status=400","failure_class='rejected_invalid',provider_http_status=400,provider_error_code=131047",
  "failure_class='rejected_invalid',provider_http_status=500,provider_error_code=100","failure_class='rejected_invalid',provider_http_status=408,provider_error_code=100",
  "failure_class='outside_window',provider_http_status=400,provider_error_code=10","failure_class='auth',provider_http_status=400",
  "failure_class='throttled',provider_http_status=400,provider_error_code=100","failure_class='permanent_other',provider_http_status=400,provider_error_code=10,provider_error_subcode=2018278",
  "failure_class='media_rejected',provider_http_status=401","failure_class='media_rejected',provider_http_status=400,provider_error_code=190",
  "failure_class='media_rejected',provider_http_status=503","failure_class='media_rejected'",
 ];
 for(const set of bad){
  const r=upd(set);assert.notEqual(r.status,0,set);
  assert.match(r.stderr,/23514|automation_flow_delivery_attempts_failure_info_chk/,set);
 }
 // Info only on finished failures: never on an attempting (or confirmed) attempt.
 const r=upd("failure_class='ambiguous',provider_http_status=500",e.q);assert.notEqual(r.status,0);
 assert.match(r.stderr,/automation_flow_delivery_attempts_failure_info_chk/);
 assert.deepEqual(info(db,e.msg),NOINFO);
 // Valid shapes are storable (the same the function writes).
 for(const set of ["failure_class='ambiguous'","failure_class='ambiguous',provider_http_status=503",
  "failure_class='outside_window',provider_http_status=400,provider_error_code=10,provider_error_subcode=2018278,provider_error_type='OAuthException'",
  "failure_class='auth',provider_http_status=401","failure_class='throttled',provider_http_status=429,provider_error_code=613"])
  {ok(db,{sql:`UPDATE public.automation_flow_delivery_attempts SET failure_class=NULL,provider_http_status=NULL,provider_error_code=NULL,provider_error_subcode=NULL,provider_error_type=NULL WHERE outbox_id='${e.msg}'; UPDATE public.automation_flow_delivery_attempts SET ${set} WHERE outbox_id='${e.msg}';`},set);}
});

test("uncertain WITH info: same end state as finish('uncertain',NULL) plus exactly the validated fields",{skip},()=>{
 const db=clone("unc");
 const e=start(db,"u1"),g=start(db,"u2");
 for(const id of [e.msg,e.q,e.img,g.msg])assert.equal(reserve(db,A,id),true);
 const cases=[[e.msg,I("outside_window",400,10,2018278,"OAuthException")],[e.q,I("ambiguous",503)],[e.img,I("auth",401)]];
 for(const [id,i] of cases){
  assert.equal(fail(db,A,id,"uncertain",i),true);
  assert.deepEqual(core(db,id),UNC,id);
  assert.deepEqual(info(db,id),i,id);
 }
 assert.equal(finish(db,A,g.msg,"uncertain"),true);
 assert.deepEqual(core(db,g.msg),core(db,e.msg),"state identical to the plain uncertain finish");
 assert.deepEqual(info(db,g.msg),NOINFO,"plain finish (S2 / no evidence): no info");
 // Still never re-reservable (never resent) and queued for human review exactly like before.
 for(const id of [e.msg,e.q,e.img])assert.equal(reserve(db,A,id),false);
 ok(db,{sql:`UPDATE public.automation_flow_delivery_attempts SET uncertain_at=now()-interval '1 hour' WHERE tenant_id='${A}'`},"age");
 assert.ok(val(db,`public.flow_queue_outbox_human_review(15,100)`,SR)>=4);
 for(const id of [e.msg,e.q,e.img,g.msg])assert.deepEqual(core(db,id),{...UNC,rv:"queued"},id);
 assert.deepEqual(info(db,e.msg),cases[0][1],"review queue keeps the info");
});

test("'rejected' text: ONLY rejected_invalid + 4xx (not 408/429) + code 100 -> dead_letter; everything else false and unchanged",{skip},()=>{
 const db=clone("rej");
 const e=start(db,"r1");
 for(const id of [e.msg,e.q])assert.equal(reserve(db,A,id),true);
 const refusedCases=[I("ambiguous",400,100),I("ambiguous",500),I("throttled",429,613),I("auth",401),I("auth",400,190),
  I("outside_window",400,131047),I("outside_window",400,10,2018278),I("permanent_other",403,10),
  I("rejected_invalid",429,100),I("rejected_invalid",408,100),I("rejected_invalid",500,100),I("rejected_invalid",400,99),
  I("rejected_invalid",400,null),I("rejected_invalid",null,100),I("media_rejected",400,100),I("rejected_invalid",400,100,null,"bad type!")];
 for(const i of refusedCases){
  assert.equal(fail(db,A,e.msg,"rejected",i),false,JSON.stringify(i));
  assert.deepEqual(full(db,e.msg),{...LEASED,...NOINFO},JSON.stringify(i));
 }
 // Invalid metadata is refused with false (never stored, never an exception), for 'uncertain' too.
 for(const i of [I("unknown_class",400),I(null,500),I("ambiguous",99),I("ambiguous",600),I("ambiguous",500,1000000000),
  I("ambiguous",500,-1),I("ambiguous",500,null,1000000000),I("ambiguous",500,null,null,"OAuth Exception"),
  I("ambiguous",500,null,null,"https://evil.example/?access_token=EAAB"),I("ambiguous",500,null,null,"A".repeat(65)),
  I("rejected_invalid",400,131047),I("outside_window",400,10),I("auth",400),I("throttled",400,100),
  I("permanent_other",400,10,2018278),I("media_rejected",401)])
  for(const res of ["uncertain","rejected"]){
   assert.equal(fail(db,A,e.msg,res,i),false,res+JSON.stringify(i));
   assert.deepEqual(full(db,e.msg),{...LEASED,...NOINFO},res+JSON.stringify(i));
  }
 for(const res of [null,"confirmed","dead_letter",""])
  assert.equal(fail(db,A,e.msg,res,I("rejected_invalid",400,100)),false,String(res));
 assert.deepEqual(full(db,e.msg),{...LEASED,...NOINFO});
 const ri=I("rejected_invalid",400,100,2018001,"OAuthException");
 assert.equal(fail(db,A,e.msg,"rejected",ri),true);
 assert.deepEqual(core(db,e.msg),DEAD);assert.deepEqual(info(db,e.msg),ri);
 assert.equal(fail(db,A,e.q,"rejected",I("rejected_invalid",404,100)),true,"question effects too");
 assert.deepEqual(core(db,e.q),DEAD);
 // Never re-reservable, never queued for human review, never billed (no charge_pending).
 assert.equal(reserve(db,A,e.msg),false);
 ok(db,{sql:`UPDATE public.automation_flow_delivery_attempts SET attempted_at=now()-interval '1 day' WHERE tenant_id='${A}'`},"age");
 val(db,`public.flow_queue_outbox_human_review(15,100)`,SR);
 assert.deepEqual(core(db,e.msg),DEAD,"not queued for human review");assert.deepEqual(core(db,e.q),DEAD);
});

test("image: 'rejected' with media_rejected = the unchanged 210000 image outcome; old finish 'rejected' still image-only",{skip},()=>{
 const db=clone("img");
 const e=start(db,"i1"),g=start(db,"i2");
 for(const id of [e.img,g.img,e.msg])assert.equal(reserve(db,A,id),true);
 assert.equal(fail(db,A,e.img,"rejected",I("rejected_invalid",400,100)),false,"image needs media_rejected");
 assert.equal(fail(db,A,e.img,"rejected",I("media_rejected",401)),false,"auth is never media_rejected");
 assert.equal(fail(db,A,e.img,"rejected",I("media_rejected",429)),false);
 assert.deepEqual(full(db,e.img),{...LEASED,...NOINFO});
 const mr=I("media_rejected",400,100);
 assert.equal(fail(db,A,e.img,"rejected",mr),true);
 assert.equal(finish(db,A,g.img,"rejected"),true);
 assert.deepEqual(core(db,e.img),core(db,g.img));assert.deepEqual(core(db,e.img),DEAD);
 assert.deepEqual(info(db,e.img),mr);assert.deepEqual(info(db,g.img),NOINFO);
 // The four-argument finish still refuses 'rejected' for text (unchanged body).
 assert.equal(finish(db,A,e.msg,"rejected"),false);
 assert.deepEqual(core(db,e.msg),LEASED);
 // media_rejected on a text effect cannot dead-letter it.
 assert.equal(fail(db,A,e.msg,"rejected",I("media_rejected",400,100)),false);
 assert.deepEqual(core(db,e.msg),LEASED);
});

test("finish WITHOUT info behaves exactly as before the migration (all four call shapes incl. S2's named args)",{skip},()=>{
 const run=db=>{
  const e=start(db,"w1"),g=start(db,"w2");
  for(const id of [e.msg,e.q,e.img,g.msg,g.q])assert.equal(reserve(db,A,id),true);
  const out=[];
  out.push(finish(db,A,e.msg,"confirmed","mid.ok"));                                  // positional 4 args
  out.push(val(db,`public.flow_finish_outbox_delivery('${A}','${e.q}','uncertain')`,SR)); // 3 args (default)
  out.push(finish(db,A,e.img,"rejected"));                                              // image rejected
  out.push(val(db,`public.flow_finish_outbox_delivery(p_tenant=>'${A}',p_outbox=>'${g.msg}',p_result=>'uncertain',p_provider_message_id=>NULL)`,SR)); // S2 named
  out.push(finish(db,A,g.q,"confirmed",null));                                          // invalid -> false
  out.push(finish(db,A,e.msg,"confirmed","mid.ok"));                                    // duplicate -> false
  out.push(finish(db,B,g.q,"uncertain"));                                               // foreign tenant -> false
  return {out,states:[e.msg,e.q,e.img,g.msg,g.q].map(id=>core(db,id))};
 };
 const before=run(clone("old","base")),after_=run(clone("new"));
 assert.deepEqual(after_,before);
 assert.deepEqual(before.out,[true,true,true,true,false,false,false]);
});

test("duplicate / late events: second call false, stored info never overwritten; advanced rows untouched",{skip},()=>{
 const db=clone("dup");
 const e=start(db,"d1"),g=start(db,"d2");
 for(const id of [e.msg,e.q,e.img,g.msg,g.q])assert.equal(reserve(db,A,id),true);
 const first=I("ambiguous",500);
 assert.equal(fail(db,A,e.msg,"uncertain",first),true);
 for(const [res,i] of [["uncertain",I("throttled",429,4)],["rejected",I("rejected_invalid",400,100)],["uncertain",first]])
  assert.equal(fail(db,A,e.msg,res,i),false);
 assert.equal(finish(db,A,e.msg,"confirmed","mid.late"),false,"late confirm refused");
 assert.equal(finish(db,A,e.msg,"uncertain"),false);
 assert.deepEqual(full(db,e.msg),{...UNC,...first});
 // Text dead_letter: late events change nothing.
 const ri=I("rejected_invalid",400,100);
 assert.equal(fail(db,A,e.q,"rejected",ri),true);
 assert.equal(fail(db,A,e.q,"uncertain",I("ambiguous",500)),false);
 assert.equal(finish(db,A,e.q,"confirmed","mid.late"),false);
 assert.deepEqual(full(db,e.q),{...DEAD,...ri});
 // Rows that moved on (charge_pending, settled, S2 uncertain without info, pending) are a no-op.
 assert.equal(finish(db,A,e.img,"confirmed","mid.img"),true);
 assert.equal(finish(db,A,g.msg,"confirmed","mid.g"),true);
 ok(db,{sql:`UPDATE public.automation_flow_outbox SET delivery_status='settled' WHERE id='${g.msg}'`},"settle");
 assert.equal(finish(db,A,g.q,"uncertain"),true);           // S2-style recovery: no info
 const pend=start(db,"d3").msg;
 const snap=[e.img,g.msg,g.q,pend].map(id=>full(db,id));
 for(const id of [e.img,g.msg,g.q,pend])for(const res of ["uncertain","rejected"])
  assert.equal(fail(db,A,id,res,res==="rejected"?(id===e.img?I("media_rejected",400):ri):I("ambiguous",500)),false,id+res);
 assert.deepEqual([e.img,g.msg,g.q,pend].map(id=>full(db,id)),snap);
 assert.equal(snap[0].s,"charge_pending");assert.equal(snap[0].a_mid,"mid.img");
 assert.equal(snap[1].s,"settled");assert.deepEqual(info(db,g.q),NOINFO);
 assert.equal(snap[3].s,"pending");assert.equal(snap[3].a,null);
});

test("inconsistent pair (attempting but outbox no longer leased): raises and rolls back, nothing stored",{skip},()=>{
 const db=clone("inc");
 const e=start(db,"x");
 for(const id of [e.msg,e.q])assert.equal(reserve(db,A,id),true);
 ok(db,{sql:`UPDATE public.automation_flow_outbox SET delivery_status='cancelled' WHERE id IN('${e.msg}','${e.q}')`},"force");
 for(const [id,res,i] of [[e.msg,"uncertain",I("ambiguous",500)],[e.q,"rejected",I("rejected_invalid",400,100)]]){
  refused(db,{role:SR,sql:`SELECT ${failSql(A,id,res,i)};`},/Outbox status changed after delivery/,res);
  assert.equal(core(db,id).a,"attempting");assert.deepEqual(info(db,id),NOINFO);
 }
});

test("tenant isolation: tenant B's call never finishes or annotates tenant A's attempt",{skip},()=>{
 const db=clone("ten");
 const a=start(db,"ta"),b=start(db,"tb",{tenant:B,acc:ACCB,flow:"fb"});
 for(const [t,id] of [[A,a.msg],[A,a.q],[B,b.msg]])assert.equal(reserve(db,t,id),true);
 assert.equal(fail(db,B,a.msg,"uncertain",I("ambiguous",500)),false);
 assert.equal(fail(db,B,a.q,"rejected",I("rejected_invalid",400,100)),false);
 assert.deepEqual(full(db,a.msg),{...LEASED,...NOINFO});assert.deepEqual(full(db,a.q),{...LEASED,...NOINFO});
 assert.equal(fail(db,B,b.msg,"uncertain",I("auth",401)),true);
 assert.deepEqual(info(db,b.msg),I("auth",401));
 assert.deepEqual(full(db,a.msg),{...LEASED,...NOINFO},"A untouched by B's own finish");
 assert.equal(fail(db,A,a.msg,"uncertain",I("ambiguous",502)),true);
 assert.deepEqual(info(db,b.msg),I("auth",401),"B untouched by A");
});

async function race(db,first,second){
 const s1=psqlAsync(db,`SET ROLE ${SR};\nBEGIN;\nSELECT ${first};\nSELECT pg_sleep(1.5);\nCOMMIT;\n`);
 let held=false;
 for(let i=0;i<200&&!held;i++){
  held=val(db,`SELECT count(*)>0 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT pg_sleep(1.5)%' AND state='active'`);
  if(!held)await new Promise(r=>setTimeout(r,25));
 }
 assert.ok(held,"session 1 holds its transaction");
 const t0=Date.now();const second_=val(db,second,SR);const waited=Date.now()-t0;
 const r1=await s1;assert.equal(r1.status,0,r1.stderr);
 return {second:second_,waited};
}
test("concurrency: two sessions finish the same attempt -> exactly one wins, the winner's info is kept",{skip},async()=>{
 const db=clone("race");
 const e=start(db,"r");for(const id of [e.msg,e.q,e.img])assert.equal(reserve(db,A,id),true);
 const w=I("ambiguous",503);
 let r=await race(db,failSql(A,e.msg,"uncertain",w),failSql(A,e.msg,"rejected",I("rejected_invalid",400,100)));
 assert.equal(r.second,false);assert.ok(r.waited>=500,`blocked on the row lock (${r.waited} ms)`);
 assert.deepEqual(full(db,e.msg),{...UNC,...w});
 const ri=I("rejected_invalid",400,100);
 r=await race(db,failSql(A,e.q,"rejected",ri),finishSql(A,e.q,"confirmed","mid.late"));
 assert.equal(r.second,false);assert.deepEqual(full(db,e.q),{...DEAD,...ri});
 // A live confirm that commits first wins; the late failure record is refused and nothing is stored.
 r=await race(db,finishSql(A,e.img,"confirmed","mid.img"),failSql(A,e.img,"rejected",I("media_rejected",400,100)));
 assert.equal(r.second,false);
 assert.deepEqual(full(db,e.img),{s:"charge_pending",no_token:true,no_lease:true,o_mid:"mid.img",delivered:true,n:1,
  a:"confirmed",a_mid:"mid.img",unc_at:false,conf_at:true,rv:"none",...NOINFO});
});

test("rollback data guard: refuses while failure info exists; explicit opt-in discards it; delivery state kept",{skip},()=>{
 const db=clone("rbdata");
 const e=start(db,"g");for(const id of [e.msg,e.q])assert.equal(reserve(db,A,id),true);
 assert.equal(fail(db,A,e.msg,"rejected",I("rejected_invalid",400,100)),true);
 assert.equal(fail(db,A,e.q,"uncertain",I("ambiguous",500)),true);
 const f0=fp(db);
 refused(db,{file:RB},/2 attempt row\(s\) hold provider failure info/,"guard");
 refused(db,{file:RB,env:{PGOPTIONS:"-c flow.rollback_20261115150000=yes"}},/hold provider failure info/,"wrong opt-in value");
 assert.equal(fp(db),f0);assert.deepEqual(info(db,e.msg),I("rejected_invalid",400,100));
 ok(db,{file:RB,env:{PGOPTIONS:"-c flow.rollback_20261115150000=discard-failure-info"}},"opt-in rollback");
 assert.deepEqual(core(db,e.msg),DEAD,"terminal text dead_letter kept (never resent/billed)");
 assert.deepEqual(core(db,e.q),UNC);
 assert.equal(val(db,`SELECT to_regprocedure('${FAIL_SIG}') IS NULL`),true);
 assert.equal(val(db,`SELECT md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))) FROM pg_proc WHERE oid='${FINISH_SIG}'::regprocedure`),FINISH_MD5);
 ok(db,{file:MIG},"re-apply after rollback with existing rejected text rows");
 assert.deepEqual(info(db,e.msg),NOINFO);
});
