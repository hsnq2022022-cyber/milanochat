// Flow V3/V4 READ-ONLY pre-deployment checks
// (supabase/proposals/flow_v3_v4_predeploy_checks.review.sql): static checks
// always run; behavioural checks run against a THROWAWAY local PostgreSQL
// cluster (temporary data dir, unix socket only, listen_addresses='',
// autovacuum off, removed after) when PostgreSQL server binaries are present.
// Never connects to any remote host or connection string.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync,writeFileSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const CHECKS="supabase/proposals/flow_v3_v4_predeploy_checks.review.sql";
const LIFECYCLE="supabase/migrations/20261029130000_flow_run_lifecycle.sql";
const AI_RETRY="supabase/migrations/20261029140000_flow_outbox_ai_retry.sql";
const TAKEOVER="supabase/migrations/20261029150000_flow_takeover_resume.sql";
const TAKEOVER_RB="supabase/rollbacks/20261029150000_flow_takeover_resume.rollback.sql";
const CREDITS="supabase/migrations/20261029160000_flow_credits_pause.sql";
const CREDITS_RB="supabase/rollbacks/20261029160000_flow_credits_pause.rollback.sql";
const DURABLE="supabase/migrations/20261029125000_flow_durable_button_run.sql";
const DURABLE_PROPOSAL="supabase/proposals/flow_durable_button_ingress.review.sql";
const GUARDS="supabase/migrations/20261029180000_flow_durable_button_run_guards.sql";
const BEGIN_SIG="flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)";
const RESUME_SIG="flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)";
const script=readFileSync(CHECKS,"utf8");

// Comments removed (the file has only "--" comments, none inside literals).
const noComments=script.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");
// ... and string literals removed: what remains is executable SQL/psql syntax.
const bare=noComments.replace(/'(?:[^']|'')*'/g,"''");

// ---------------------------------------------------------------- static
test("checks file is one READ ONLY transaction ended by ROLLBACK with bounded timeouts",()=>{
 const stmts=noComments.split("\n").map(l=>l.trim()).filter(Boolean);
 assert.equal(stmts[0],"BEGIN READ ONLY;","first statement");
 assert.equal(stmts.at(-1),"ROLLBACK;","last statement");
 assert.match(noComments,/^BEGIN READ ONLY;\nSET LOCAL statement_timeout = '15s';\nSET LOCAL lock_timeout = '2s';\n/m);
 assert.equal((bare.match(/\bBEGIN\b/gi)??[]).length,1);
 assert.equal((bare.match(/\bROLLBACK\b/gi)??[]).length,1);
});
test("checks file contains no write, DDL, privilege, COPY or dynamic-SQL keyword outside comments",()=>{
 // Checked on the comment-free text INCLUDING literals, so not even a string mentions them.
 const forbidden=["INSERT","UPDATE","DELETE","MERGE","UPSERT","TRUNCATE","COPY","CREATE","DROP","ALTER",
  "GRANT","REVOKE","COMMENT","SECURITY","EXECUTE","PREPARE","DEALLOCATE","CALL","DO","VACUUM",
  "ANALYZE","REINDEX","CLUSTER","REFRESH","NOTIFY","LISTEN","IMPORT","COMMIT","SAVEPOINT","RELEASE",
  "DISCARD","RESET","CHECKPOINT","REASSIGN","OWNER"];
 for(const w of forbidden)assert.doesNotMatch(noComments,new RegExp(`\\b${w}\\b`,"i"),w);
 // "lock" appears in output labels; as a statement it is forbidden.
 assert.doesNotMatch(bare,/(^|;)\s*LOCK\b/im,"LOCK statement");
 for(const f of ["nextval","setval","set_config","pg_advisory","pg_terminate_backend","pg_cancel_backend",
  "pg_reload_conf","pg_rotate","lo_","dblink","query_to_xml","pg_read_file","pg_ls_dir","pg_stat_reset",
  "txid_current","pg_current_xact_id","FOR SHARE","FOR KEY","NOWAIT","SKIP LOCKED","SELECT INTO","INTO "])
  assert.ok(!noComments.toLowerCase().includes(f.toLowerCase()),f);
 // Every SET is SET LOCAL of a timeout.
 const sets=bare.match(/^SET\b[^;]*;/gim)??[];
 assert.equal(sets.length,3);
 for(const s of sets)assert.match(s,/^SET LOCAL (statement_timeout|lock_timeout|idle_in_transaction_session_timeout) = '';$/);
 // Only these psql meta-commands (no \o, \!, \copy, \g file, \i, \connect ...).
 const metas=[...noComments.matchAll(/\\([a-z]+)/gi)].map(m=>m[1]);
 for(const m of metas)assert.ok(["set","gset","if","else","endif","echo"].includes(m),`meta \\${m}`);
 assert.match(noComments,/^\\set ON_ERROR_STOP on$/m);
 assert.equal((noComments.match(/^\\set /gm)??[]).length,1);
});
test("checks never name a column the migrations add (read only via to_jsonb / catalogs)",()=>{
 const added=["ended_reason","ended_at","cancel_reason","cancelled_at","attempts","ai_attempts",
  "ai_last_error_code","ai_lease_token","ai_lease_expires_at","ai_answer_encrypted"];
 for(const c of added)assert.doesNotMatch(bare,new RegExp(`\\b${c}\\b`),c);
 // Optional live-only columns are also catalog/literal only.
 for(const c of ["human_agent_expires_at","human_agent_until","transferred","is_active","agent_enabled","auto_reply","production_approved"])
  assert.doesNotMatch(bare,new RegExp(`\\b${c}\\b`),c);
 // Customer/message content columns are never selected.
 for(const c of ["text","wa_chat_id","customer_phone_encrypted","customer_name","document","variables","query"])
  assert.doesNotMatch(bare,new RegExp(`\\.${c}\\b`),c);
 assert.doesNotMatch(bare,/\bo\.payload\b(?!->>'')/,"payload only via ->>'source'");
});
test("function_version hashes equal md5 of the exact 130000 / 150000 bodies (and the 150000 rollback)",()=>{
 const body=(f,tag)=>{const s=readFileSync(f,"utf8");const o=`AS $${tag}$`;const a=s.indexOf(o)+o.length;
  return s.slice(a,s.indexOf(`$${tag}$`,a));};
 const md5=x=>createHash("md5").update(x).digest("hex");
 const want=[["flow_lease_due_runs(integer)","lease"],["flow_conversation_human_takeover(uuid,uuid)","takeover"]];
 for(const [sig,tag] of want){
  const h130=md5(body(LIFECYCLE,tag)),h150=md5(body(TAKEOVER,tag));
  assert.notEqual(h130,h150,sig);
  assert.equal(md5(body(TAKEOVER_RB,tag)),h130,`${sig}: 150000 rollback restores the 130000 body`);
  assert.ok(script.includes(`('${sig}','${h130}','${h150}')`),`${sig} hashes embedded in checks`);
 }
 assert.match(script,/OPERATOR RULE[\s\S]*Never re-apply 20261029130000_flow_run_lifecycle after\n-- +20261029150000_flow_takeover_resume/);
 // 20261029160000 pause probe: exact body hash embedded; its rollback restores the 150000 body.
 const h160=md5(body(CREDITS,"paused"));
 assert.notEqual(h160,md5(body(TAKEOVER,"paused")));
 assert.equal(md5(body(CREDITS_RB,"paused")),md5(body(TAKEOVER,"paused")),"160000 rollback restores the 150000 body");
 assert.ok(script.includes(`WHEN cpm.h IS DISTINCT FROM '${h160}'`),"160000 hash embedded in checks");
 // 20261029125000: normalized durable start/resume bodies (identical in the migration and the proposal).
 const norm=x=>x.replace(/[ \t\n\r\f\v]+/g," ").replace(/^ +| +$/g,"");
 const lit=(f,tag)=>{const s=readFileSync(f,"utf8");const o=`:= $${tag}$`;const a=s.indexOf(o)+o.length;
  return s.slice(a,s.indexOf(`$${tag}$`,a));};
 for(const [sig,tag] of [[BEGIN_SIG,"begin"],[RESUME_SIG,"resume"]]){
  assert.equal(lit(DURABLE,tag),body(DURABLE_PROPOSAL,tag),`${sig}: migration body byte-identical to the proposal`);
  assert.ok(script.includes(`('${sig}',\n   '${md5(norm(body(DURABLE_PROPOSAL,tag)))}')`),`${sig} normalized hash embedded in checks`);
  // 20261029180000 guards body: also accepted (body_version=20261029180000).
  const g=readFileSync(GUARDS,"utf8"),o=`v_${tag}_180 constant text := $${tag}$`,a=g.indexOf(o)+o.length;
  assert.ok(script.includes(`('${sig}',\n  '${md5(norm(g.slice(a,g.indexOf(`$${tag}$`,a))))}')`),`${sig} 180000 normalized hash embedded in checks`);
 }
});
test("every section is labeled and has a MISSING fallback",()=>{
 for(const s of ["(a)","(b)","(c)","(d)","(e)","(f)"])assert.ok(noComments.includes(`\\echo '== ${s}`),s);
 assert.equal((noComments.match(/^\\if :pdc_(outbox|runs)_ok$/gm)??[]).length,3);
 // (d) canary_registration (20261029170000) has its own gated block.
 assert.equal((noComments.match(/^\\if :pdc_canary_ok$/gm)??[]).length,1);
 // (f) inbound dedupe index (audit B1) has its own gated block.
 assert.equal((noComments.match(/^\\if :pdc_messages_ok$/gm)??[]).length,1);
 assert.equal((noComments.match(/^\\else$/gm)??[]).length,5);
 assert.equal((noComments.match(/^\\endif$/gm)??[]).length,5);
 assert.ok((script.match(/'MISSING: /g)??[]).length>=10);
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
function psqlArgs(db,user="postgres",tuples=true){
 return ["-X","-q",...(tuples?["-t","-A","-F","\t"]:[]),"-v","ON_ERROR_STOP=1",
  "-h",dir,"-p",String(port),"-U",user,"-d",db];
}
// Environment for every client: only the throwaway socket, never inherited PG* settings.
function clientEnv(extra={}){
 const env={};
 for(const [k,v] of Object.entries(process.env))if(!k.startsWith("PG"))env[k]=v;
 return {...env,...extra};
}
function psql(db,{file,sql,user,tuples,env}={}){
 const args=psqlArgs(db,user,tuples);
 if(file)args.push("-f",file);
 return spawnSync(join(BIN,"psql"),args,{encoding:"utf8",input:sql??undefined,env:clientEnv(env)});
}
function ok(db,src,label){
 const r=psql(db,src);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return r;
}
function psqlAsync(db,sql){
 return new Promise(res=>{
  const p=spawn(join(BIN,"psql"),psqlArgs(db),{env:clientEnv()});
  let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
  p.on("close",code=>res({code,out,err}));
  p.stdin.end(sql);
 });
}

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-predeploy-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+13)%20000);
 let r=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(r.status,0,r.stderr);
 r=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off`,"start"]);
 assert.equal(r.status,0,r.stderr+r.stdout);
 started=true;
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111",ACCB="22222222-2222-4222-8222-222222222222";
const SECRET_TEXT="PDC-SECRET-MESSAGE-TEXT",SECRET_CUSTOMER="PDC-CUSTOMER-HANDLE";

// Same order as the CI "Outbox send ledger" job (see flow-outbox-ai-retry.test.mjs),
// stopping BEFORE 20261029130000 / 20261029140000.
const CHAIN=["tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
 "tests/sql/flow-exclusive-claim-bootstrap.sql","supabase/migrations/20261028220000_webhook_exclusive_claim.sql",
 "supabase/migrations/20261028224000_delivery_attempts.sql","supabase/migrations/20261028225000_flow_runtime_advance.sql",
 "tests/sql/flow-phase4-runtime-bootstrap.sql","tests/sql/flow-outbox-delivery-bootstrap.sql",
 "supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql"];

// Seed uses only pre-migration columns.
const SEED=`
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
VALUES('${A}','pdc',1,'${ACC}','instagram','{"version":3,"nodes":[],"edges":[]}','88888888-8888-4888-8888-888888888888'),
      ('${B}','pdc',1,'${ACCB}','facebook','{"version":3,"nodes":[],"edges":[]}','88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active)
VALUES('${A}','${ACC}','instagram','pdc',1,true),('${B}','${ACCB}','facebook','pdc',1,true);
CREATE SCHEMA pdc;
CREATE TABLE pdc.ids(name text PRIMARY KEY,id uuid NOT NULL);
CREATE FUNCTION pdc.id(p text) RETURNS uuid LANGUAGE sql STABLE AS $f$SELECT id FROM pdc.ids WHERE name=p$f$;
CREATE FUNCTION pdc.conv(p_tenant uuid,p_acc uuid) RETURNS uuid LANGUAGE sql AS $f$
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(gen_random_uuid(),p_tenant,p_acc,'ig:${SECRET_CUSTOMER}:'||gen_random_uuid()) RETURNING id$f$;
CREATE FUNCTION pdc.run(p_tenant uuid,p_conv uuid,p_status text,p_age interval DEFAULT '0'::interval) RETURNS uuid
LANGUAGE plpgsql AS $f$
DECLARE ev text:='pdc-'||gen_random_uuid(); v uuid;
 acc uuid:=CASE WHEN p_tenant='${A}' THEN '${ACC}'::uuid ELSE '${ACCB}'::uuid END;
 pf text:=CASE WHEN p_tenant='${A}' THEN 'instagram' ELSE 'facebook' END;
BEGIN
 INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
 VALUES(p_tenant,acc,pf,ev);
 INSERT INTO public.automation_flow_runs(tenant_id,flow_key,publication_revision,channel_account_id,
  platform,conversation_id,provider_event_id,current_node_id,run_status,wake_at,updated_at)
 VALUES(p_tenant,'pdc',1,acc,pf,p_conv,ev,'n1',p_status,
  CASE WHEN p_status='sleeping' THEN now()+interval '1 hour' END,now()-p_age) RETURNING id INTO v;
 RETURN v;
END $f$;
CREATE FUNCTION pdc.fx(p_tenant uuid,p_run uuid,p_status text,p_kind text,p_source text,p_age interval) RETURNS uuid
LANGUAGE sql AS $f$
 INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload,delivery_status,created_at)
 VALUES(p_tenant,p_run,'pdc-'||gen_random_uuid(),p_kind,
  jsonb_strip_nulls(jsonb_build_object('kind',p_kind,'text','${SECRET_TEXT}','source',p_source)),p_status,now()-p_age)
 RETURNING id$f$;
DO $s$
DECLARE ra uuid; rb uuid; c uuid; i int;
BEGIN
 -- outbox rows hang off completed (inactive) runs so they do not affect (b)
 ra:=pdc.run('${A}',pdc.conv('${A}','${ACC}'),'completed');
 rb:=pdc.run('${B}',pdc.conv('${B}','${ACCB}'),'completed');
 INSERT INTO pdc.ids VALUES('ra',ra),('rb',rb);
 -- (a) 55 legacy charge_pending knowledge_ai rows for A, 2 for B; decoys excluded
 FOR i IN 1..55 LOOP
  INSERT INTO pdc.ids VALUES('cpA'||i,pdc.fx('${A}',ra,'charge_pending','message','knowledge_ai',make_interval(mins=>200-i)));
 END LOOP;
 INSERT INTO pdc.ids VALUES('cpB1',pdc.fx('${B}',rb,'charge_pending','message','knowledge_ai','3 hours')),
  ('cpB2',pdc.fx('${B}',rb,'charge_pending','question','knowledge_ai','2 hours')),
  ('cp_static',pdc.fx('${A}',ra,'charge_pending','message',NULL,'3 hours')),
  ('ai_pending',pdc.fx('${A}',ra,'pending','message','knowledge_ai','0'));
 -- (b) duplicate active runs: A conv d1 (2), A conv d2 (3), B conv (2); singles excluded
 c:=pdc.conv('${A}','${ACC}'); INSERT INTO pdc.ids VALUES('d1',c);
 INSERT INTO pdc.ids VALUES('d1_old',pdc.run('${A}',c,'awaiting_input','2 hours')),('d1_new',pdc.run('${A}',c,'sleeping','1 minute'));
 c:=pdc.conv('${A}','${ACC}'); INSERT INTO pdc.ids VALUES('d2',c);
 INSERT INTO pdc.ids VALUES('d2_a',pdc.run('${A}',c,'ready','3 hours')),('d2_b',pdc.run('${A}',c,'sleeping','2 hours')),
  ('d2_c',pdc.run('${A}',c,'awaiting_input','5 minutes'));
 c:=pdc.conv('${B}','${ACCB}'); INSERT INTO pdc.ids VALUES('d3',c);
 INSERT INTO pdc.ids VALUES('d3_old',pdc.run('${B}',c,'sleeping','1 day')),('d3_new',pdc.run('${B}',c,'ready','1 hour'));
 c:=pdc.conv('${A}','${ACC}');
 PERFORM pdc.run('${A}',c,'awaiting_input','1 hour'); PERFORM pdc.run('${A}',c,'completed'); PERFORM pdc.run('${A}',c,'blocked');
 -- (c) old and fresh customer-visible effects; decoys excluded
 INSERT INTO pdc.ids VALUES('old_b1',pdc.fx('${A}',ra,'pending','message',NULL,'2 hours')),
  ('old_b2',pdc.fx('${A}',ra,'pending','question',NULL,'10 hours')),
  ('old_b3',pdc.fx('${A}',ra,'retry_wait','message',NULL,'3 days')),
  ('old_b4',pdc.fx('${B}',rb,'pending','message',NULL,'10 days')),
  ('fresh',pdc.fx('${A}',ra,'pending','message',NULL,'10 minutes')),
  ('old_tag',pdc.fx('${A}',ra,'pending','tag',NULL,'5 hours')),
  ('old_cancelled',pdc.fx('${A}',ra,'cancelled','message',NULL,'5 hours')),
  ('old_settled',pdc.fx('${A}',ra,'settled','message',NULL,'5 hours'));
END $s$;
ANALYZE;
`;
// Read-only login role: SELECT only (+ BYPASSRLS, as documented in the file),
// sessions default to read only. pdc_rls has the same grants but is subject
// to row-level security.
const RO_ROLE=`
CREATE ROLE pdc_ro LOGIN BYPASSRLS;
CREATE ROLE pdc_rls LOGIN;
GRANT USAGE ON SCHEMA public TO pdc_ro,pdc_rls;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pdc_ro,pdc_rls;
ALTER ROLE pdc_ro SET default_transaction_read_only=on;
ALTER ROLE pdc_rls SET default_transaction_read_only=on;
`;

function prepare(db,{roles}){
 ok("postgres",{sql:`CREATE DATABASE ${db};`},"createdb");
 let shape=readFileSync("tests/sql/fixtures/flow-live-shape-bootstrap.sql","utf8");
 if(!roles)shape=shape.split("\n").filter(l=>!l.startsWith("CREATE ROLE ")).join("\n");
 ok(db,{sql:shape},"live shape");
 for(const f of CHAIN)ok(db,{file:f},f);
 ok(db,{sql:SEED},"seed");
}

function parse(out){
 return out.split("\n").filter(l=>l.split("\t").length===7).map(l=>{
  const [section,item,status,tenant_id,n,ids,detail]=l.split("\t");
  return {section,item,status,tenant_id:tenant_id||null,n:n===""?null:Number(n),
   ids:ids===""?[]:ids.split(","),detail};
 });
}
function runChecks(db,opts={}){
 const r=psql(db,{file:CHECKS,...opts});
 assert.equal(r.status,0,`checks failed\n${r.stderr}`);
 assert.doesNotMatch(r.stderr,/ERROR|WARNING/,r.stderr);
 return {raw:r.stdout,rows:parse(r.stdout)};
}
function one(rows,section,item,tenant=null){
 const m=rows.filter(r=>r.section===section&&r.item===item&&(tenant===null||r.tenant_id===tenant));
 assert.equal(m.length,1,`${section}/${item}/${tenant}: ${JSON.stringify(m)}`);
 return m[0];
}
function ids(db,names){
 return names.map(n=>ok(db,{sql:`SELECT pdc.id('${n}');`},n).stdout.trim());
}

// Full schema + data + role fingerprint (all non-system schemas), and the next
// transaction id: a script that writes nothing never consumes an xid.
const SNAP=`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||coalesce(p.proacl::text,'')
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN('pg_catalog','information_schema')
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN('pg_catalog','information_schema','pg_toast')
 UNION ALL SELECT 'c:'||a.attrelid::regclass::text||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT IN('pg_catalog','information_schema','pg_toast') AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid)||':'||convalidated FROM pg_constraint
  WHERE connamespace NOT IN('pg_catalog'::regnamespace,'information_schema'::regnamespace)
 UNION ALL SELECT 't:'||tgrelid::regclass::text||':'||tgname||':'||tgenabled::text FROM pg_trigger WHERE NOT tgisinternal
 UNION ALL SELECT 'n:'||nspname||':'||coalesce(nspacl::text,'') FROM pg_namespace
 UNION ALL SELECT 'u:'||rolname||':'||rolsuper||rolcanlogin||rolbypassrls FROM pg_roles
 UNION ALL SELECT 's:'||setrole::regrole::text||':'||array_to_string(setconfig,',') FROM pg_db_role_setting
 UNION ALL SELECT 'd:'||c.oid::regclass::text||':'||md5(query_to_xml(
   format('SELECT t::text AS v FROM %s t ORDER BY 1',c.oid::regclass),false,false,'')::text)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN('r','p') AND n.nspname NOT IN('pg_catalog','information_schema','pg_toast')
) s(x);
SELECT pg_snapshot_xmax(pg_current_snapshot());`;

function assertReadOnlyRun(db,opts={}){
 const before=ok(db,{sql:SNAP},"snapshot before").stdout;
 const res=runChecks(db,opts);
 const after=ok(db,{sql:SNAP},"snapshot after").stdout;
 assert.equal(after,before,"schema/data/roles fingerprint and next xid unchanged");
 assert.ok(!res.raw.includes(SECRET_TEXT),"no message text in output");
 assert.ok(!res.raw.includes(SECRET_CUSTOMER),"no customer handle in output");
 assert.ok(!res.raw.includes("enc:v1:aa:bb:cc"),"no stored answer in output");
 return res;
}

test("live PG: before 20261029130000/140000, sections (a)-(e) report the seeded problems and change nothing",{skip},()=>{
 prepare("pdc_before",{roles:true});
 ok("pdc_before",{sql:RO_ROLE},"read-only role");
 const {rows}=assertReadOnlyRun("pdc_before");

 // (a)
 let s=one(rows,"a_legacy_charge_pending","summary");
 assert.equal(s.status,"FOUND");assert.equal(s.n,57);
 assert.match(s.detail,/without a stored answer=57 tenants=2; with stored answer \(recoverable\)=0/);
 const ta=one(rows,"a_legacy_charge_pending","tenant",A);
 assert.equal(ta.n,55);assert.equal(ta.ids.length,50,"max 50 ids per tenant");
 const cpA=ids("pdc_before",Array.from({length:55},(_,i)=>`cpA${i+1}`));
 assert.deepEqual(ta.ids,cpA.slice(0,50),"oldest first");
 assert.match(ta.detail,/oldest_age_minutes=199/);
 const tb=one(rows,"a_legacy_charge_pending","tenant",B);
 assert.equal(tb.n,2);assert.deepEqual([...tb.ids].sort(),ids("pdc_before",["cpB1","cpB2"]).sort());
 const [cpStatic,aiPending]=ids("pdc_before",["cp_static","ai_pending"]);
 for(const r of rows)assert.ok(!r.ids.includes(cpStatic)&&!r.ids.includes(aiPending),"decoys excluded");

 // (b)
 s=one(rows,"b_duplicate_active_runs","summary");
 assert.equal(s.status,"FOUND");assert.equal(s.n,3);
 assert.match(s.detail,/duplicate groups=3 surplus runs=4; unique index flow_one_active_run_per_conversation absent/);
 const groups=rows.filter(r=>r.section==="b_duplicate_active_runs"&&r.item==="group");
 assert.equal(groups.length,3);
 const [d1,d2,d3]=ids("pdc_before",["d1","d2","d3"]);
 const g=c=>groups.find(r=>r.detail.startsWith(`conversation_id=${c} `));
 assert.deepEqual(g(d1).ids,ids("pdc_before",["d1_new","d1_old"]));
 assert.match(g(d1).detail,/statuses=sleeping,awaiting_input/);
 assert.deepEqual(g(d2).ids,ids("pdc_before",["d2_c","d2_b","d2_a"]));assert.equal(g(d2).n,3);
 assert.equal(g(d3).tenant_id,B);assert.deepEqual(g(d3).ids,ids("pdc_before",["d3_new","d3_old"]));

 // (c)
 s=one(rows,"c_stale_messages","summary");
 assert.equal(s.status,"FOUND");assert.equal(s.n,4);
 // fresh: 3 fixture rows + 'fresh' + 'ai_pending'
 assert.match(s.detail,/older_than_60m=4 \(pending=3 retry_wait=1\) tenants=2; fresh_within_60m=5/);
 assert.equal(one(rows,"c_stale_messages","tenant_status:pending",A).detail,"age 60m-6h=1 6h-24h=1 1d-7d=0 over_7d=0");
 assert.equal(one(rows,"c_stale_messages","tenant_status:retry_wait",A).detail,"age 60m-6h=0 6h-24h=0 1d-7d=1 over_7d=0");
 assert.equal(one(rows,"c_stale_messages","tenant_status:pending",B).detail,"age 60m-6h=0 6h-24h=0 1d-7d=0 over_7d=1");
 for(const r of rows.filter(r=>r.section==="c_stale_messages"))assert.deepEqual(r.ids,[],"counts only");

 // (d)
 const d=item=>one(rows,"d_prerequisites",item);
 assert.equal(d("environment").status,"OK");
 assert.match(d("environment").detail,/transaction_read_only=on/);
 for(const t of ["automation_flow_runs","automation_flow_outbox","automation_flow_run_leases","automation_flow_activations",
  "automation_flow_global_switch","automation_flow_tenant_switches","tenants","channel_accounts","conversations"])
  assert.equal(d(`table:public.${t}`).status,"OK",t);
 for(const c of ["automation_flow_runs.publication_revision","automation_flow_outbox.payload",
  "automation_flow_outbox.retry_at","automation_flow_tenant_switches.production_approved","conversations.account_id"])
  assert.equal(d(`column:public.${c}`).status,"OK",c);
 for(const c of ["automation_flow_outbox.cancel_reason","automation_flow_runs.ended_reason",
  "automation_flow_run_leases.attempts","automation_flow_outbox.ai_answer_encrypted"])
  assert.equal(d(`column:public.${c}`).status,"ABSENT",c);
 for(const c of ["conversations.transferred","conversations.human_agent_expires_at","conversations.auto_paused_reason",
  "tenants.is_active","channel_accounts.auto_reply","channel_accounts.external_id"])
  assert.equal(d(`column:public.${c}`).status,`MISSING: public.${c}`,c);
 // human_agent_until must NOT exist: absent is OK.
 assert.equal(d("column:public.conversations.human_agent_until").status,"OK");
 assert.match(d("column:public.conversations.human_agent_until").detail,/^not present \(expected\)/);
 assert.equal(d("takeover_coverage").status,"MISSING: canonical takeover columns on public.conversations");
 // 150000 objects and preflight before anything is applied
 for(const f of ["flow_channel_temporarily_paused(uuid,uuid)","flow_end_stale_paused_runs(integer,integer)"])
  assert.equal(d(`function:public.${f}`).status,"ABSENT",f);
 const lv=d("function_version:public.flow_lease_due_runs(integer)");
 assert.equal(lv.status,"OK");assert.match(lv.detail,/installed_version=20261028225000/);
 assert.equal(d("function_version:public.flow_conversation_human_takeover(uuid,uuid)").status,"ABSENT");
 const pf=d("preflight:20261029150000");
 assert.equal(pf.status,"INFO");assert.equal(pf.n,12);assert.match(pf.detail,/^unmet \(normal until/);
 assert.equal(d("constraint:automation_flow_run_leases_pkey").status,"OK");
 const sc=rows.filter(r=>r.item.startsWith("status_check:"));
 assert.equal(sc.length,2);
 for(const r of sc){assert.equal(r.status,"OK",r.item);assert.match(r.detail,/definition \(not replaced by the migrations\): CHECK/);}
 assert.equal(d("named_check:automation_flow_outbox_cancel_reason_chk").status,"ABSENT");
 const lease=d("function:public.flow_lease_due_runs(integer)");
 assert.equal(lease.status,"OK");assert.match(lease.detail,/CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE/);
 assert.equal(d("function:public.flow_reserve_outbox_delivery(uuid,uuid)").status,"OK");
 assert.equal(d("function:public.flow_cancel_run(uuid,uuid,text,text)").status,"ABSENT");
 assert.equal(d("function:public.flow_claim_outbox_ai(uuid,uuid,integer,integer)").status,"ABSENT");
 assert.equal(d("index:public.flow_one_active_run_per_conversation").status,"ABSENT");
 assert.equal(d("trigger:flow_one_active_run_guard").status,"ABSENT");
 assert.ok(!rows.some(r=>r.status.startsWith("CONFLICT")),"no conflicts");

 // (e)
 const runsT=one(rows,"e_lock_impact","table:public.automation_flow_runs");
 const outT=one(rows,"e_lock_impact","table:public.automation_flow_outbox");
 assert.equal(runsT.status,"INFO");
 const realRuns=Number(ok("pdc_before",{sql:"SELECT count(*) FROM public.automation_flow_runs;"},"count").stdout);
 const realOut=Number(ok("pdc_before",{sql:"SELECT count(*) FROM public.automation_flow_outbox;"},"count").stdout);
 assert.equal(runsT.n,realRuns,"reltuples after ANALYZE");assert.equal(outT.n,realOut);
 assert.match(outT.detail,/total_size=.* \(\d+ bytes\)/);
 for(const t of ["automation_flow_runs","automation_flow_outbox","automation_flow_run_leases"])
  assert.equal(one(rows,"e_lock_impact",`locks:public.${t}`).status,"OK",t);
 const lt=one(rows,"e_lock_impact","long_transactions");
 assert.equal(lt.status,"OK");assert.equal(lt.n,0);

 // Same results as a SELECT-only login role whose sessions default to read only.
 const ro=assertReadOnlyRun("pdc_before",{user:"pdc_ro"});
 const strip=rs=>rs.filter(r=>!["environment"].includes(r.item)&&r.section!=="e_lock_impact");
 assert.deepEqual(strip(ro.rows),strip(rows));
 assert.match(one(ro.rows,"d_prerequisites","environment").detail,/current_user=pdc_ro transaction_read_only=on/);
 const w=psql("pdc_before",{user:"pdc_ro",sql:"DELETE FROM public.automation_flow_outbox;"});
 assert.notEqual(w.status,0,"harness: read-only role cannot write");
 // A role filtered by row-level security gets explicit MISSING rows, never false zero counts.
 const rls=assertReadOnlyRun("pdc_before",{user:"pdc_rls"}).rows;
 for(const [sec,t] of [["a_legacy_charge_pending","outbox"],["b_duplicate_active_runs","runs"],["c_stale_messages","outbox"]])
  assert.deepEqual(rls.filter(r=>r.section===sec).map(r=>r.status),
   [`MISSING: RLS bypass on public.automation_flow_${t}`],sec);

 // The file's own transaction mode refuses writes even for the superuser.
 const injected=join(dir,"injected.sql");
 writeFileSync(injected,script.replace(/ROLLBACK;\s*$/,
  "SELECT 1 FROM public.automation_flow_outbox LIMIT 0;\nDELETE FROM public.automation_flow_outbox;\nROLLBACK;\n"));
 const before=ok("pdc_before",{sql:SNAP},"snapshot").stdout;
 const inj=psql("pdc_before",{file:injected});
 assert.notEqual(inj.status,0);
 assert.match(inj.stderr,/cannot execute DELETE in a read-only transaction/);
 assert.equal(ok("pdc_before",{sql:SNAP},"snapshot").stdout,before);

 // Operators' default aligned output also runs cleanly.
 const aligned=psql("pdc_before",{file:CHECKS,tuples:false});
 assert.equal(aligned.status,0,aligned.stderr);
 assert.match(aligned.stdout,/a_legacy_charge_pending/);
});

test("live PG: after 20261029130000+140000 the checks still run, reflect the new objects and match the cleanup functions",{skip},()=>{
 prepare("pdc_after",{roles:false});
 const pre=runChecks("pdc_after").rows;
 const mig=ok("pdc_after",{file:LIFECYCLE},"130000 with duplicates present");
 assert.match(mig.stderr,/unique index deferred/);
 ok("pdc_after",{file:AI_RETRY},"140000");
 ok("pdc_after",{sql:"ANALYZE;"},"analyze");
 let {rows}=assertReadOnlyRun("pdc_after");
 const d=item=>one(rows,"d_prerequisites",item);
 for(const c of ["automation_flow_outbox.cancel_reason","automation_flow_runs.ended_reason",
  "automation_flow_run_leases.attempts","automation_flow_outbox.ai_answer_encrypted","automation_flow_outbox.ai_attempts"])
  assert.equal(d(`column:public.${c}`).status,"OK",c);
 for(const f of ["flow_cancel_run(uuid,uuid,text,text)","flow_resolve_duplicate_active_runs(integer)",
  "flow_skip_blocked_outbox(integer,integer)","flow_claim_outbox_ai(uuid,uuid,integer,integer)",
  "flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer)"])
  assert.equal(d(`function:public.${f}`).status,"OK",f);
 assert.match(d("function:public.flow_lease_due_runs(integer)").detail,/CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE/);
 assert.equal(d("index:public.automation_flow_runs_waiting_idx").status,"OK");
 assert.equal(d("index:public.flow_one_active_run_per_conversation").status,"ABSENT","deferred while duplicates exist");
 assert.equal(d("trigger:flow_one_active_run_guard").status,"OK");
 const cr=d("named_check:automation_flow_outbox_cancel_reason_chk");
 assert.equal(cr.status,"OK");assert.match(cr.detail,/ai_retries_exhausted/);
 assert.equal(d("named_check:automation_flow_outbox_ai_state_chk").status,"OK");
 assert.ok(!rows.some(r=>r.status.startsWith("CONFLICT")||r.status.startsWith("MISSING: public.automation")));
 // 130000+140000 installed: 150000 preflight satisfied, bodies are the 130000 version.
 assert.equal(d("preflight:20261029150000").status,"OK");
 for(const f of ["flow_lease_due_runs(integer)","flow_conversation_human_takeover(uuid,uuid)"]){
  const v=d(`function_version:public.${f}`);
  assert.equal(v.status,"OK",f);assert.match(v.detail,/installed_version=20261029130000 .*present=0\/2/,f);
 }
 // data sections unchanged by the migrations themselves
 for(const sec of ["a_legacy_charge_pending","b_duplicate_active_runs","c_stale_messages"])
  assert.deepEqual(rows.filter(r=>r.section===sec),pre.filter(r=>r.section===sec),sec);

 // (a) a row WITH a stored answer is recoverable and no longer listed
 const [cp1]=ids("pdc_after",["cpA1"]);
 ok("pdc_after",{sql:`UPDATE public.automation_flow_outbox SET ai_answer_encrypted='enc:v1:aa:bb:cc' WHERE id='${cp1}';`},"store");
 // (b) the first id of each group is the one flow_resolve_duplicate_active_runs keeps
 const kept=rows.filter(r=>r.item==="group").map(r=>r.ids[0]).sort();
 const ended=rows.filter(r=>r.item==="group").flatMap(r=>r.ids.slice(1)).sort();
 ok("pdc_after",{sql:`SET ROLE service_role; DO $t$ BEGIN
  IF public.flow_resolve_duplicate_active_runs(100)<>4 THEN RAISE EXCEPTION 'resolve count'; END IF; END $t$;`},"resolve");
 // (c) the stale sweep cancels exactly the rows section (c) counted
 const swept=ok("pdc_after",{sql:"SET ROLE service_role; SELECT public.flow_skip_blocked_outbox(60,200);"},"sweep").stdout.trim();
 assert.equal(Number(swept),4);

 ({rows}=assertReadOnlyRun("pdc_after"));
 let s=one(rows,"a_legacy_charge_pending","summary");
 assert.match(s.detail,/without a stored answer=56 tenants=2; with stored answer \(recoverable\)=1/);
 assert.ok(!one(rows,"a_legacy_charge_pending","tenant",A).ids.includes(cp1));
 s=one(rows,"b_duplicate_active_runs","summary");
 assert.equal(s.status,"OK");assert.equal(s.n,0);
 const st=ok("pdc_after",{sql:`SELECT string_agg(id::text||'='||run_status||'/'||coalesce(ended_reason,'-'),',' ORDER BY id)
  FROM public.automation_flow_runs WHERE id IN('${[...kept,...ended].join("','")}');`},"states").stdout.trim().split(",");
 for(const e of st){const [id,v]=e.split("=");
  assert.equal(v,kept.includes(id)?v.replace(/\/.*/,"")+"/-":"blocked/duplicate_active",id);
  if(kept.includes(id))assert.match(v,/^(ready|awaiting_input|sleeping)\/-$/);}
 s=one(rows,"c_stale_messages","summary");
 assert.equal(s.status,"OK");assert.match(s.detail,/older_than_60m=0 .*fresh_within_60m=5/);
});

test("live PG: missing objects and privileges degrade to MISSING/CONFLICT rows instead of errors",{skip},()=>{
 ok("postgres",{sql:"CREATE DATABASE pdc_empty;"},"createdb");
 let {rows}=assertReadOnlyRun("pdc_empty");
 for(const sec of ["a_legacy_charge_pending","b_duplicate_active_runs","c_stale_messages"]){
  const p=rows.filter(r=>r.section===sec);
  assert.equal(p.length,1,sec);assert.equal(p[0].item,"prerequisite");
  assert.match(p[0].status,/^MISSING: public\.automation_flow_(outbox|runs)$/);
 }
 assert.equal(one(rows,"d_prerequisites","table:public.conversations").status,"MISSING: public.conversations");
 assert.equal(one(rows,"d_prerequisites","function:public.flow_lease_due_runs(integer)").status,
  "MISSING: public.flow_lease_due_runs(integer)");
 assert.equal(one(rows,"d_prerequisites","constraint:automation_flow_run_leases_pkey").status,
  "MISSING: constraint automation_flow_run_leases_pkey");
 assert.equal(one(rows,"e_lock_impact","table:public.automation_flow_outbox").status,"MISSING: public.automation_flow_outbox");

 // Partial shape: outbox without payload/created_at, runs present but unreadable,
 // a same-named function without the ownership marker.
 ok("pdc_empty",{sql:`CREATE TABLE public.automation_flow_outbox(tenant_id uuid,id uuid,effect_kind text,delivery_status text);
  CREATE TABLE public.automation_flow_runs(tenant_id uuid,id uuid,conversation_id uuid,run_status text,updated_at timestamptz);
  CREATE FUNCTION public.flow_cancel_run(uuid,uuid,text,text) RETURNS boolean LANGUAGE sql AS 'SELECT false';
  CREATE ROLE pdc_nobody LOGIN; GRANT SELECT ON public.automation_flow_outbox TO pdc_nobody;`},"partial");
 ({rows}=assertReadOnlyRun("pdc_empty",{user:"pdc_nobody"}));
 const a=rows.filter(r=>r.section==="a_legacy_charge_pending").map(r=>r.status).sort();
 assert.deepEqual(a,["MISSING: public.automation_flow_outbox.created_at","MISSING: public.automation_flow_outbox.payload"]);
 assert.deepEqual(rows.filter(r=>r.section==="b_duplicate_active_runs").map(r=>r.status),
  ["MISSING: read privilege on public.automation_flow_runs"]);
 assert.equal(one(rows,"d_prerequisites","function:public.flow_cancel_run(uuid,uuid,text,text)").status,
  "CONFLICT: public.flow_cancel_run(uuid,uuid,text,text)");
 assert.equal(one(rows,"d_prerequisites","status_check:automation_flow_outbox").status,
  "MISSING: automation_flow_outbox status check");
});

test("live PG: 150000 coverage, canonical takeover columns, 130000-after-150000 hazard detector",{skip},()=>{
 const hasRoles=ok("postgres",{sql:"SELECT count(*) FROM pg_roles WHERE rolname='anon';"},"roles").stdout.trim()==="1";
 prepare("pdc_150",{roles:!hasRoles});
 ok("pdc_150",{file:LIFECYCLE},"130000");ok("pdc_150",{file:AI_RETRY},"140000");
 ok("pdc_150",{sql:`ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN business_name text;
  ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,ADD COLUMN auto_reply boolean NOT NULL DEFAULT true,
  ADD COLUMN external_id text,ADD COLUMN access_token_encrypted text;
  ALTER TABLE public.conversations ADD COLUMN transferred boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_paused_reason text,ADD COLUMN human_agent_expires_at timestamptz;`},"production-shape columns");
 let {rows}=assertReadOnlyRun("pdc_150");
 const d=(rs,item)=>one(rs,"d_prerequisites",item);
 assert.equal(d(rows,"takeover_coverage").status,"WARN","130000 helper ignores the expiry");
 assert.equal(d(rows,"preflight:20261029150000").status,"OK");
 ok("pdc_150",{file:TAKEOVER},"150000");
 ({rows}=assertReadOnlyRun("pdc_150"));
 for(const r of rows.filter(r=>r.section==="d_prerequisites"))
  assert.ok(r.status==="OK"||r.status==="ABSENT"&&
   ["index:public.flow_one_active_run_per_conversation","credits_pause","canary_claim_function","canary_registration",
    "canary_table:public.automation_flow_canary_accounts","canary_table:public.automation_flow_canary_claims",
    "function:public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)",
    `durable_button_run:public.${BEGIN_SIG}`,`durable_button_run:public.${RESUME_SIG}`,
    "durable_ingress_for_20261029170000","durable_button_run_guards"].includes(r.item)||
   r.status==="INFO"&&r.item==="preflight:20261029180000",
   `${r.item}: ${r.status} ${r.detail}`);
 assert.equal(d(rows,"credits_pause").status,"ABSENT");
 assert.match(d(rows,"credits_pause").detail,/20261029160000 not applied/);
 assert.equal(d(rows,"takeover_coverage").status,"OK");
 for(const f of ["flow_lease_due_runs(integer)","flow_conversation_human_takeover(uuid,uuid)"])
  assert.match(d(rows,`function_version:public.${f}`).detail,/installed_version=20261029150000 .*present=2\/2$/,f);
 for(const f of ["flow_channel_temporarily_paused(uuid,uuid)","flow_end_stale_paused_runs(integer,integer)"])
  assert.match(d(rows,`function:public.${f}`).detail,/CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME/);

 // 20261029160000 installed: credits_pause OK, 150000 preflight superseded (INFO), no CONFLICT.
 ok("pdc_150",{file:CREDITS},"160000");
 ({rows}=assertReadOnlyRun("pdc_150"));
 assert.equal(d(rows,"credits_pause").status,"OK",d(rows,"credits_pause").detail);
 assert.equal(d(rows,"function:public.flow_channel_temporarily_paused(uuid,uuid)").status,"OK");
 assert.equal(d(rows,"preflight:20261029150000").status,"INFO");
 assert.match(d(rows,"preflight:20261029150000").detail,/^superseded: 20261029160000 is installed/);
 assert.ok(!rows.some(r=>r.status.startsWith("CONFLICT")||r.status.startsWith("MISSING")),"clean after 160000");
 const re150=psql("pdc_150",{file:TAKEOVER});
 assert.notEqual(re150.status,0,"150000 re-apply refused while 160000 is installed");
 assert.match(re150.stderr,/Unrecognized existing function public\.flow_channel_temporarily_paused/);
 ok("pdc_150",{file:CREDITS_RB},"160000 rollback");
 ({rows}=assertReadOnlyRun("pdc_150"));
 assert.equal(d(rows,"credits_pause").status,"ABSENT");
 assert.equal(d(rows,"preflight:20261029150000").status,"OK");

 // HAZARD: 130000 re-applied after 150000 succeeds silently and restores the 130000 bodies.
 ok("pdc_150",{file:LIFECYCLE},"130000 re-applied after 150000 (passes its preflight)");
 ({rows}=assertReadOnlyRun("pdc_150"));
 for(const f of ["flow_lease_due_runs(integer)","flow_conversation_human_takeover(uuid,uuid)"]){
  const v=d(rows,`function_version:public.${f}`);
  assert.equal(v.status,`CONFLICT: public.${f} body`,f);
  assert.match(v.detail,/installed_version=20261029130000 .*never re-apply 20261029130000 after 20261029150000/,f);
 }
 assert.equal(d(rows,"takeover_coverage").status,"WARN");
 // Recovery: re-apply 150000 (idempotent).
 ok("pdc_150",{file:TAKEOVER},"150000 re-applied");
 ({rows}=assertReadOnlyRun("pdc_150"));
 assert.ok(!rows.some(r=>r.status.startsWith("CONFLICT")),"recovered");
 // Partial state: 150000 body without its helper functions.
 ok("pdc_150",{sql:"DROP FUNCTION public.flow_end_stale_paused_runs(integer,integer); DROP FUNCTION public.flow_channel_temporarily_paused(uuid,uuid);"},"drop helpers");
 ({rows}=assertReadOnlyRun("pdc_150"));
 assert.equal(d(rows,"function_version:public.flow_lease_due_runs(integer)").status,"CONFLICT: public.flow_lease_due_runs(integer) body");
 assert.match(d(rows,"function_version:public.flow_lease_due_runs(integer)").detail,/partial rollback/);
 ok("pdc_150",{file:TAKEOVER},"150000 re-applied");
 // Schema drift: human_agent_until present -> WARN.
 ok("pdc_150",{sql:"ALTER TABLE public.conversations ADD COLUMN human_agent_until timestamptz;"},"drift");
 ({rows}=assertReadOnlyRun("pdc_150"));
 assert.equal(d(rows,"column:public.conversations.human_agent_until").status,"WARN");
 // Canonical column missing -> MISSING (worker PostgREST selects would fail).
 ok("pdc_150",{sql:"ALTER TABLE public.conversations DROP COLUMN human_agent_until, DROP COLUMN auto_paused_reason;"},"drop col");
 ({rows}=assertReadOnlyRun("pdc_150"));
 assert.equal(d(rows,"column:public.conversations.auto_paused_reason").status,"MISSING: public.conversations.auto_paused_reason");
 assert.equal(d(rows,"takeover_coverage").status,"MISSING: canonical takeover columns on public.conversations");
});

test("live PG: 20261029125000 durable button run rows: absent, migration, pre-installed proposal, tampering",{skip},()=>{
 const hasRoles=ok("postgres",{sql:"SELECT count(*) FROM pg_roles WHERE rolname='anon';"},"roles").stdout.trim()==="1";
 const d=(rs,item)=>one(rs,"d_prerequisites",item);
 const fnRows=rs=>[BEGIN_SIG,RESUME_SIG].map(s=>d(rs,`durable_button_run:public.${s}`));
 // Before: neither the migration nor the proposal; hard prerequisites present.
 prepare("pdc_125",{roles:!hasRoles});
 let {rows}=assertReadOnlyRun("pdc_125");
 for(const r of fnRows(rows)){assert.equal(r.status,"ABSENT",r.item);assert.match(r.detail,/20261029170000 preflight refuses/);}
 assert.equal(d(rows,"durable_ingress_for_20261029170000").status,"ABSENT");
 assert.match(d(rows,"durable_ingress_for_20261029170000").detail,/apply 20261029125000_flow_durable_button_run before 20261029170000/);
 assert.equal(d(rows,"preflight:20261029125000").status,"OK",d(rows,"preflight:20261029125000").detail);
 // Installed by the migration.
 ok("pdc_125",{file:DURABLE},"125000");
 ({rows}=assertReadOnlyRun("pdc_125"));
 for(const r of fnRows(rows)){assert.equal(r.status,"OK",`${r.item}: ${r.detail}`);
  assert.match(r.detail,/^installed_by=20261029125000 marker=CREATED_BY_20261029125000_FLOW_DURABLE_BUTTON_RUN .*security_definer=f config=search_path="" public_or_client_privilege=f other_overloads=0$/);}
 assert.equal(d(rows,"durable_ingress_for_20261029170000").status,"OK");
 assert.match(d(rows,"durable_ingress_for_20261029170000").detail,/met by 20261029125000 or the pre-installed proposal functions/);
 assert.ok(!rows.some(r=>r.status.startsWith("CONFLICT")),"no conflicts");
 // Tampering: client privilege, then a different body (the migration refuses to overwrite it).
 ok("pdc_125",{sql:`GRANT EXECUTE ON FUNCTION public.${RESUME_SIG} TO anon;`},"tamper grant");
 ({rows}=assertReadOnlyRun("pdc_125"));
 assert.equal(fnRows(rows)[1].status,`CONFLICT: public.${RESUME_SIG} privileges`);
 ok("pdc_125",{file:DURABLE},"125000 re-applied restores privileges");
 ({rows}=assertReadOnlyRun("pdc_125"));
 assert.equal(fnRows(rows)[1].status,"OK");
 ok("pdc_125",{sql:`CREATE OR REPLACE FUNCTION public.flow_resume_button_run(
  p_tenant uuid,p_run uuid,p_event text,p_inbound uuid,p_expect_step integer,
  p_expect_node text,p_next text,p_next_step integer,p_status text,
  p_variables jsonb,p_wake timestamptz,p_effects jsonb
 ) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $x$BEGIN RETURN true; END$x$;`},"tamper body");
 ({rows}=assertReadOnlyRun("pdc_125"));
 assert.equal(fnRows(rows)[1].status,`CONFLICT: public.${RESUME_SIG} body`);
 assert.match(fnRows(rows)[1].detail,/20261029125000 refuses to overwrite it/);
 assert.notEqual(psql("pdc_125",{file:DURABLE}).status,0,"migration refuses the differing body");
 // Another overload with the same name.
 ok("pdc_125",{sql:"CREATE FUNCTION public.flow_begin_durable_run(uuid) RETURNS uuid LANGUAGE sql AS 'SELECT $1';"},"overload");
 ({rows}=assertReadOnlyRun("pdc_125"));
 assert.equal(fnRows(rows)[0].status,"CONFLICT: public.flow_begin_durable_run overload");

 // Production case: functions installed earlier from the proposal; the migration is a no-op.
 prepare("pdc_125p",{roles:false});
 ok("pdc_125p",{file:DURABLE_PROPOSAL},"proposal");
 ({rows}=assertReadOnlyRun("pdc_125p"));
 for(const r of fnRows(rows)){assert.equal(r.status,"OK",`${r.item}: ${r.detail}`);
  assert.match(r.detail,/^installed_by=proposal flow_durable_button_ingress\.review\.sql \(pre-existing;.* marker=- /);}
 assert.equal(d(rows,"durable_ingress_for_20261029170000").status,"OK");
 ok("pdc_125p",{file:DURABLE},"125000 over the proposal");
 const again=assertReadOnlyRun("pdc_125p").rows;
 assert.deepEqual(fnRows(again),fnRows(rows),"migration over the proposal changes nothing");
 assert.ok(!again.some(r=>r.status.startsWith("CONFLICT")),"no conflicts");
});

test("live PG: 20261029180000 guards rows: preflight, body_version 125000 -> 180000, rollback, partial state",{skip},()=>{
 const d=(rs,item)=>one(rs,"d_prerequisites",item);
 const fnRows=rs=>[BEGIN_SIG,RESUME_SIG].map(s=>d(rs,`durable_button_run:public.${s}`));
 prepare("pdc_180",{roles:false});
 let {rows}=assertReadOnlyRun("pdc_180");
 assert.equal(d(rows,"durable_button_run_guards").status,"ABSENT");
 assert.equal(d(rows,"preflight:20261029180000").status,"INFO");
 assert.match(d(rows,"preflight:20261029180000").detail,/^unmet \(normal until 20261029125000\.\.170000 are applied\)/);
 ok("pdc_180",{file:DURABLE},"125000");ok("pdc_180",{file:LIFECYCLE},"130000");ok("pdc_180",{file:AI_RETRY},"140000");
 ok("pdc_180",{sql:`ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true;
  ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,ADD COLUMN auto_reply boolean NOT NULL DEFAULT true;
  ALTER TABLE public.conversations ADD COLUMN transferred boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_paused_reason text,ADD COLUMN human_agent_expires_at timestamptz;
  ALTER TABLE public.automation_flow_tenant_switches ADD COLUMN IF NOT EXISTS production_approved boolean NOT NULL DEFAULT false;`},"production-shape columns");
 for(const f of [TAKEOVER,CREDITS,"supabase/migrations/20261029170000_flow_canary_claim_durable.sql"])ok("pdc_180",{file:f},f);
 ({rows}=assertReadOnlyRun("pdc_180"));
 assert.equal(d(rows,"preflight:20261029180000").status,"OK",d(rows,"preflight:20261029180000").detail);
 assert.equal(d(rows,"durable_button_run_guards").status,"ABSENT");
 assert.match(d(rows,"durable_button_run_guards").detail,/20261029180000 not applied/);
 for(const r of fnRows(rows)){assert.equal(r.status,"OK");assert.match(r.detail,/ body_version=20261029125000 /);}
 assert.equal(d(rows,"durable_ingress_for_20261029170000").status,"OK");
 // Applied.
 ok("pdc_180",{file:GUARDS},"180000");
 ({rows}=assertReadOnlyRun("pdc_180"));
 assert.equal(d(rows,"durable_button_run_guards").status,"OK",d(rows,"durable_button_run_guards").detail);
 assert.equal(d(rows,"preflight:20261029180000").status,"OK");
 for(const r of fnRows(rows)){assert.equal(r.status,"OK",`${r.item}: ${r.detail}`);
  assert.match(r.detail,/^installed_by=20261029180000 .*marker=CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS previous_comment="CREATED_BY_20261029125000_FLOW_DURABLE_BUTTON_RUN" .* body_version=20261029180000 security_definer=f config=search_path="" public_or_client_privilege=f other_overloads=0$/);}
 assert.equal(d(rows,"durable_ingress_for_20261029170000").status,"OK");
 assert.match(d(rows,"durable_ingress_for_20261029170000").detail,/stays met after 20261029180000 \(not blocking\)/);
 assert.ok(!rows.some(r=>r.status.startsWith("CONFLICT")),"no conflicts after 180000");
 // Partial state: one function loses the marker -> CONFLICT.
 ok("pdc_180",{sql:`COMMENT ON FUNCTION public.${BEGIN_SIG} IS 'operator note';`},"unmark");
 ({rows}=assertReadOnlyRun("pdc_180"));
 assert.equal(d(rows,"durable_button_run_guards").status,"CONFLICT: 20261029180000 objects");
 assert.match(d(rows,"durable_button_run_guards").detail,/1 of 2 functions carry its marker, 2 of 2 have its body/);
 ok("pdc_180",{sql:`COMMENT ON FUNCTION public.${BEGIN_SIG} IS 'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS previous_comment="CREATED_BY_20261029125000_FLOW_DURABLE_BUTTON_RUN"';`},"re-mark");
 // Rollback: back to the 125000 bodies.
 ok("pdc_180",{file:"supabase/rollbacks/20261029180000_flow_durable_button_run_guards.rollback.sql"},"180000 rollback");
 ({rows}=assertReadOnlyRun("pdc_180"));
 assert.equal(d(rows,"durable_button_run_guards").status,"ABSENT");
 for(const r of fnRows(rows)){assert.equal(r.status,"OK");assert.match(r.detail,/^installed_by=20261029125000 .* body_version=20261029125000 /);}
 // A 180000 marker on the 125000 body is a CONFLICT.
 ok("pdc_180",{sql:`COMMENT ON FUNCTION public.${RESUME_SIG} IS 'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS previous_comment=null';`},"marker on 125000 body");
 ({rows}=assertReadOnlyRun("pdc_180"));
 assert.equal(fnRows(rows)[1].status,`CONFLICT: public.${RESUME_SIG} body`);
 assert.match(fnRows(rows)[1].detail,/carries the 20261029180000 marker without its body/);
 assert.equal(d(rows,"durable_button_run_guards").status,"CONFLICT: 20261029180000 objects");
});

test("live PG: (f) inbound dedupe index: global/tenant scope, missing index with duplicate counts, failed concurrent build, counts only",{skip},()=>{
 const f=(rs,item)=>one(rs,"f_inbound_dedupe",item);
 const CA="44444444-4444-4444-8444-444444444444",CB="55555555-5555-4555-8555-555555555555";
 prepare("pdc_f",{roles:false});
 let {rows,raw}=assertReadOnlyRun("pdc_f");
 assert.equal(f(rows,"unique_index").status,"OK");
 assert.equal(f(rows,"unique_index").detail,"suitable: idx_messages_wa_message_id scope=global");
 for(const i of ["duplicates_global","duplicates_tenant"]){
  assert.equal(f(rows,i).status,"OK",i);assert.match(f(rows,i).detail,/^not scanned/,i);
 }
 // Index absent (as nothing in the repo guarantees it) and duplicates stored.
 ok("pdc_f",{sql:`DROP INDEX public.idx_messages_wa_message_id;
  INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id) VALUES
  ('${A}','${CA}','in','PDC-DUP-1'),('${A}','${CA}','in','PDC-DUP-1'),('${A}','${CA}','in','PDC-DUP-1'),
  ('${B}','${CB}','in','PDC-DUP-1'),('${A}','${CA}','in','PDC-X-2'),('${B}','${CB}','in','PDC-X-2'),
  ('${A}','${CA}','in',NULL),('${A}','${CA}','in',NULL);`},"duplicates");
 ({rows,raw}=assertReadOnlyRun("pdc_f"));
 assert.equal(f(rows,"unique_index").status,"MISSING: unique index on public.messages(wa_message_id)");
 assert.match(f(rows,"unique_index").detail,/^BLOCKING before FLOW_DURABLE_INGRESS_ENABLED=true/);
 assert.deepEqual([f(rows,"duplicates_global").status,f(rows,"duplicates_global").n],["FOUND",2]);
 assert.match(f(rows,"duplicates_global").detail,/groups=2 surplus rows=4/);
 assert.deepEqual([f(rows,"duplicates_tenant").status,f(rows,"duplicates_tenant").n],["FOUND",1]);
 assert.match(f(rows,"duplicates_tenant").detail,/groups=1 surplus rows=2/);
 assert.ok(!raw.includes("PDC-DUP-1")&&!raw.includes("PDC-X-2"),"no provider ids in output");
 // A concurrent build over duplicates fails and leaves an INVALID index: still MISSING.
 const failed=psql("pdc_f",{sql:`CREATE UNIQUE INDEX CONCURRENTLY pdc_msg_tenant_mid
  ON public.messages(tenant_id,wa_message_id) WHERE wa_message_id IS NOT NULL;`});
 assert.notEqual(failed.status,0);assert.match(failed.stderr,/could not create unique index/);
 ok("pdc_f",{sql:`CREATE UNIQUE INDEX pdc_msg_id_mid ON public.messages(id,wa_message_id);`},"unsuitable");
 ({rows}=assertReadOnlyRun("pdc_f"));
 assert.equal(f(rows,"unique_index").status,"MISSING: unique index on public.messages(wa_message_id)");
 assert.match(f(rows,"unique_index").detail,
  /unsuitable or invalid: pdc_msg_id_mid cols=id,wa_message_id valid=true predicate=none; pdc_msg_tenant_mid cols=tenant_id,wa_message_id valid=false predicate=\(wa_message_id IS NOT NULL\)$/);
 // Resolve the per-tenant duplicates, rebuild tenant-scoped: OK, global duplicates still reported.
 ok("pdc_f",{sql:`DROP INDEX public.pdc_msg_tenant_mid; DROP INDEX public.pdc_msg_id_mid;
  DELETE FROM public.messages WHERE wa_message_id='PDC-DUP-1' AND tenant_id='${A}'
   AND id<>(SELECT min(id::text)::uuid FROM public.messages WHERE wa_message_id='PDC-DUP-1' AND tenant_id='${A}');`},"resolve");
 ok("pdc_f",{sql:`CREATE UNIQUE INDEX CONCURRENTLY pdc_msg_tenant_mid
  ON public.messages(tenant_id,wa_message_id) WHERE wa_message_id IS NOT NULL;`},"tenant index");
 ({rows}=assertReadOnlyRun("pdc_f"));
 assert.equal(f(rows,"unique_index").status,"OK");
 assert.equal(f(rows,"unique_index").detail,"suitable: pdc_msg_tenant_mid scope=tenant");
 assert.deepEqual([f(rows,"duplicates_global").status,f(rows,"duplicates_global").n],["FOUND",2]);
 assert.match(f(rows,"duplicates_global").detail,/groups=2 surplus rows=2 \(blocks a global index\)/);
 assert.equal(f(rows,"duplicates_tenant").status,"OK");
 // Without read access the section degrades to a MISSING row instead of an error.
 ok("pdc_f",{sql:`CREATE ROLE pdc_f_nobody LOGIN;`},"role");
 ({rows}=assertReadOnlyRun("pdc_f",{user:"pdc_f_nobody"}));
 assert.deepEqual(rows.filter(r=>r.section==="f_inbound_dedupe").map(r=>[r.item,r.status]),
  [["prerequisite","MISSING: read privilege on public.messages"]]);
});
test("live PG: other sessions' locks are reported, and a blocking lock makes the checks fail fast instead of queueing",{skip},async()=>{
 prepare("pdc_locks",{roles:false});
 const holder=psqlAsync("pdc_locks",`BEGIN; LOCK TABLE public.automation_flow_outbox IN SHARE MODE; SELECT pg_sleep(4); COMMIT;`);
 await new Promise(r=>setTimeout(r,800));
 const {rows}=runChecks("pdc_locks");
 const l=one(rows,"e_lock_impact","locks:public.automation_flow_outbox");
 assert.equal(l.status,"WARN");assert.equal(l.ids.length,1);assert.match(l.detail,/granted=1 waiting=0 modes=ShareLock/);
 assert.equal(one(rows,"e_lock_impact","locks:public.automation_flow_runs").status,"OK");
 assert.equal((await holder).code,0);

 const blocker=psqlAsync("pdc_locks",`BEGIN; LOCK TABLE public.automation_flow_outbox IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(6); COMMIT;`);
 await new Promise(r=>setTimeout(r,800));
 const t0=Date.now();
 const r=psql("pdc_locks",{file:CHECKS});
 const took=Date.now()-t0;
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/lock timeout/);
 assert.ok(took<4500,`gave up after ${took}ms (lock_timeout 2s)`);
 assert.equal((await blocker).code,0);
});
