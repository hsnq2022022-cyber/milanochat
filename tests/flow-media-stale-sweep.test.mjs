// 20261029220000_flow_media_stale_sweep: public.flow_skip_blocked_outbox also
// sweeps 'message_image' Outbox effects exactly like text effects (stale,
// human takeover, ended run e.g. 'ineligible', inactive revision).
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) built like
// tests/flow-media-effects.test.mjs: repo fixture chain, migrations
// 20261028220000 .. 20261029190000, then 20261029210000, then 20261029220000.
// Never connects to any remote host; inherited PG* variables are stripped.
// Billing is out of scope (no consume_* / credit function runs).
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const MIG="supabase/migrations/20261029220000_flow_media_stale_sweep.sql";
const RB="supabase/rollbacks/20261029220000_flow_media_stale_sweep.rollback.sql";
const M130="supabase/migrations/20261029130000_flow_run_lifecycle.sql";
const M210="supabase/migrations/20261029210000_flow_media_effects.sql";
const RB210="supabase/rollbacks/20261029210000_flow_media_effects.rollback.sql";
const CHAIN125_190=["supabase/migrations/20261029125000_flow_durable_button_run.sql",M130,
 "supabase/migrations/20261029140000_flow_outbox_ai_retry.sql",
 "supabase/migrations/20261029150000_flow_takeover_resume.sql",
 "supabase/migrations/20261029160000_flow_credits_pause.sql",
 "supabase/migrations/20261029170000_flow_canary_claim_durable.sql",
 "supabase/migrations/20261029180000_flow_durable_button_run_guards.sql",
 "supabase/migrations/20261029190000_flow_begin_durable_run_superseding.sql"];
const OLDER_RB=[RB210,
 "supabase/rollbacks/20261029190000_flow_begin_durable_run_superseding.rollback.sql",
 "supabase/rollbacks/20261029180000_flow_durable_button_run_guards.rollback.sql",
 "supabase/rollbacks/20261029170000_flow_canary_claim_durable.rollback.sql",
 "supabase/rollbacks/20261029160000_flow_credits_pause.rollback.sql",
 "supabase/rollbacks/20261029150000_flow_takeover_resume.rollback.sql",
 "supabase/rollbacks/20261029140000_flow_outbox_ai_retry.rollback.sql",
 "supabase/rollbacks/20261029130000_flow_run_lifecycle.rollback.sql",
 "supabase/rollbacks/20261029125000_flow_durable_button_run.rollback.sql"];
const MARK="CREATED_BY_20261029220000_FLOW_MEDIA_STALE_SWEEP";
const LC="CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE";
const SIG="public.flow_skip_blocked_outbox(integer,integer)";
const src=f=>readFileSync(f,"utf8");
const md5=x=>createHash("md5").update(x).digest("hex");
const norm=x=>x.replace(/[ \t\n\r\f\v]+/g," ").replace(/^ +| +$/g,"");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");
const body=(f,tag="skip_many")=>{const s=src(f),o=`AS $${tag}$`,a=s.indexOf(o);assert.ok(a>=0,`${f} ${tag}`);
 return s.slice(a+o.length,s.indexOf(`$${tag}$`,a+o.length));};
const H_OLD=md5(norm(body(M130))),H_NEW=md5(norm(body(MIG)));

// ---------------------------------------------------------------- static
test("220000 follows 125000..210000; 200000 (storage) is independent; only 230000 (requires 220000) is newer",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 assert.equal(stamps.filter(s=>s==="20261029220000").length,1);
 // 20261029230000_flow_multichannel_support requires 220000 (tests/flow-multichannel-support.test.mjs).
 for(const s of stamps)if(!["20261029220000","20261029230000","20261029240000","20261029250000","20261029260000","20261029270000","20261029280000","20261029290000","20261029300000"].includes(s))assert.ok(s<"20261029220000",s);
 for(const f of [...CHAIN125_190,M210,RB,...OLDER_RB])assert.ok(existsSync(f),f);
 // No later migration than 130000 (other than this one and 300000) redefines the sweep.
 for(const f of readdirSync("supabase/migrations")){
  const code=noComments(src(`supabase/migrations/${f}`));
  if(/FUNCTION\s+public\.flow_skip_blocked_outbox\s*\(/.test(code))
   // 20261029300000_comment_replies replaces it only from the exact 220000 body (hash-pinned preflight).
   assert.ok(["20261029130000_flow_run_lifecycle.sql","20261029220000_flow_media_stale_sweep.sql",
    "20261029300000_comment_replies.sql"].includes(f),f);
 }
});
test("migration and rollback: one bounded transaction, service_role only, no billing, no row writes",()=>{
 for(const f of [MIG,RB]){
  const s=src(f),code=noComments(s);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
  assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1,f);assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.doesNotMatch(code,/SECURITY DEFINER|\bTO\s+(anon|authenticated|PUBLIC)\b|CREATE POLICY|\bTRUNCATE\b|ALTER TABLE/i,f);
  assert.doesNotMatch(code,/consume_|credits_remaining|wayl|topup|cron\.|vault\.|net\.http_/i,f);
  assert.ok(code.includes(`v_marker constant text := '${MARK}'`),f);
  const outside=code.replace(/\$skip_many\$[\s\S]*?\$skip_many\$/g,"");
  assert.doesNotMatch(outside,/\bINSERT\b|\bUPDATE\s+public\.|\bDELETE\s+FROM\b|COMMENT ON/i,f);
  assert.doesNotMatch(outside,/DROP\s+(TABLE|FUNCTION|COLUMN|INDEX|TRIGGER|CONSTRAINT)/i,f);
  assert.equal((code.match(/CREATE OR REPLACE FUNCTION/g)??[]).length,1,f);
  assert.doesNotMatch(code,/CREATE\s+FUNCTION/i,f);
 }
 // Same header (arguments, defaults, attributes) as 20261029130000.
 const head=s=>{const i=s.indexOf("AS $skip_many$");return s.slice(s.lastIndexOf("FUNCTION public.",i),i);};
 assert.equal(head(src(MIG)),head(src(M130)));assert.equal(head(src(RB)),head(src(M130)));
 const code=noComments(src(MIG));
 assert.equal((code.match(/^GRANT EXECUTE ON FUNCTION [^\n]+ TO service_role;$/gm)??[]).length,1);
 assert.ok(code.includes(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC,anon,authenticated;`));
 assert.doesNotMatch(noComments(src(RB)),/^(REVOKE|GRANT)/m,"rollback never changes privileges");
});
test("body: exactly the effect-kind list changes; rollback restores the exact 130000 body; hashes embedded",()=>{
 const a=body(M130).split("\n"),b=body(MIG).split("\n");
 assert.deepEqual({gone:a.filter(l=>!b.includes(l)),added:b.filter(l=>!a.includes(l))},
  {gone:["    AND o.effect_kind IN('message','question')"],added:["    AND o.effect_kind IN('message','question','message_image')"]});
 assert.equal(a.length,b.length);
 assert.equal(body(RB),body(M130),"rollback body byte-identical to 20261029130000");
 for(const f of [MIG,RB]){
  assert.ok(src(f).includes(`v_h_old constant text := '${H_OLD}';`),f);
  assert.ok(src(f).includes(`v_h_new constant text := '${H_NEW}';`),f);
 }
});
test("every older rollback (210000 .. 125000) refuses first while the 220000 body is installed",()=>{
 for(const f of OLDER_RB){
  const s=src(f),i=s.indexOf(`md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g')))='${H_NEW}'`);
  assert.ok(i>0,f);
  assert.ok(s.slice(i-200,i).includes(`to_regprocedure('${SIG}')`),f);
  assert.match(s.slice(i),/^[^\n]*\n THEN RAISE EXCEPTION 'Refusing [^']*: 20261029220000 objects still exist; roll back 20261029220000_flow_media_stale_sweep first'; END IF;/,f);
  // Before the 210000 guard (or, in the 210000 rollback, before any change).
  const g210=s.indexOf("roll back 20261029210000_flow_media_effects first");
  const first=f===RB210?s.indexOf("CREATE OR REPLACE FUNCTION"):g210;
  assert.ok(first>i,f);
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
const pargs=db=>["-X","-q","-t","-A","-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose",
 "-h",dir,"-p",String(port),"-U","postgres","-d",db];
function psql(db,{file,sql,env,role}={}){
 const a=pargs(db);
 if(file)a.push("-f",file);
 const input=sql===undefined?undefined:(role?`SET ROLE ${role};\n`:"")+sql;
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input,env:clientEnv(env),maxBuffer:1<<26});
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
  coalesce(p.proacl::text,'')||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||pg_get_function_result(p.oid)||':'||
  p.prosecdef||':'||pg_get_function_arguments(p.oid)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')||':'||c.relrowsecurity
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'c:'||a.attrelid::regclass::text||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v') AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid)||':'||convalidated||':'||
  coalesce(obj_description(oid,'pg_constraint'),'')
  FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 't:'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text FROM pg_trigger t WHERE NOT t.tgisinternal
 ${data?`UNION ALL SELECT 'd:'||c.oid::regclass::text||':'||md5(query_to_xml(
   format('SELECT t::text AS v FROM %s t ORDER BY 1',c.oid::regclass),false,false,'')::text)
  FROM pg_class c WHERE c.relkind IN('r','p') AND c.relnamespace='public'::regnamespace`:""}
) s(x);`;
const fp=(db,data=true)=>ok(db,{sql:FP(data)},"fingerprint").out;
const dfp=db=>ok(db,{sql:`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'd:'||c.oid::regclass::text||':'||md5(query_to_xml(
   format('SELECT t::text AS v FROM %s t ORDER BY 1',c.oid::regclass),false,false,'')::text)
  FROM pg_class c WHERE c.relkind IN('r','p') AND c.relnamespace='public'::regnamespace) s(x);`},"data fingerprint").out;
function refused(db,file,re,label,env){
 const before=fp(db);
 const r=psql(db,{file,env});
 assert.notEqual(r.status,0,`${label} must be refused`);
 assert.match(r.stderr,re,label);
 assert.equal(fp(db),before,`${label}: refused without any change`);
}

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111";  // tenant A instagram (fixture)
const ACCB="cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // tenant B instagram
const IMG="https://abcd1234.supabase.co/storage/v1/object/public/flow-media/u1/0f8c2b1e-1111-4222-8333-444455556666.webp";
const doc={version:3,name:"image",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"pic",data:{kind:"message",text:"our product",image:"",options:[],
  contentBlocks:[{id:"b1",type:"image",url:IMG}]}}],
 edges:[{source:"start",target:"pic",sourceHandle:"next"}]};
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
 "supabase/migrations/20261028220000_webhook_exclusive_claim.sql",
 "supabase/migrations/20261028224000_delivery_attempts.sql",
 "supabase/migrations/20261028225000_flow_runtime_advance.sql",
 "supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql",
 "tests/sql/flow-staff-membership-bootstrap.sql",
 "supabase/migrations/20261028227000_tenant_staff_memberships.sql",
 "supabase/migrations/20261028228000_flow_internal_actions.sql"];
const SEED=`
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES('${ACCB}','${B}','instagram','instagram');
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by) VALUES
 ('${A}','img',1,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${B}','bimg',1,'${ACCB}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active) VALUES
 ('${A}','${ACC}','instagram','img',1,true),('${B}','${ACCB}','instagram','bimg',1,true);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved)
VALUES('${A}',true,false,true),('${B}',true,false,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
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
END $f$;
ANALYZE;`;
const SR="service_role";
const L=v=>v===null?"NULL":`'${String(v).replace(/'/g,"''")}'`;
// One durable start whose first commit stores [text seq0, image seq1, tag seq2] (as runtimeChain plans it).
const EFFECTS=n=>JSON.stringify([
 {kind:"message",idempotencyKey:`m.${n}`,payload:{kind:"message",text:"our product",seq:0}},
 {kind:"message_image",idempotencyKey:`i.${n}`,payload:{kind:"message_image",url:IMG,nodeId:"pic",seq:1}},
 {kind:"tag",idempotencyKey:`t.${n}`,payload:{kind:"tag",tag:"vip",seq:2}}]);
function start(db,name,{tenant=A,acc=ACC,flow="img",effects=EFFECTS(name)}={}){
 ok(db,{sql:`SELECT t.ev('${name}','${tenant}','${acc}');`},`event ${name}`);
 const e=rows(db,`SELECT * FROM t.e WHERE name='${name}'`)[0];
 const r=psql(db,{role:SR,sql:`SELECT public.flow_begin_durable_run(${L(e.tenant)},${L(e.acc)},${L(e.conv)},${L(e.msg)},${L(e.mid)},`+
  `${L(flow)},1,'start','pic',2,'completed','{}'::jsonb,NULL,${L(effects)}::jsonb);`});
 assert.equal(r.status,0,`start ${name}\n${r.stderr}`);
 return val(db,`SELECT r.id FROM public.automation_flow_runs r WHERE r.provider_event_id='mid.${name}'`);
}
const B_=name=>({tenant:B,acc:ACCB,flow:"bimg",effects:EFFECTS(name)});
const sweep=db=>val(db,"public.flow_skip_blocked_outbox(60,200)",SR);
const age=(db,run,iv="2 hours")=>ok(db,{sql:`UPDATE public.automation_flow_outbox SET created_at=now()-interval '${iv}' WHERE run_id='${run}'`},"age");
// [kind, status/reason] per effect of a run, in a stable order.
const st=(db,run)=>rows(db,`SELECT effect_kind AS k,delivery_status||'/'||coalesce(cancel_reason,'-') AS s,tenant_id::text AS t
 FROM public.automation_flow_outbox WHERE run_id='${run}' ORDER BY effect_kind`).map(r=>[r.k,r.s]);
const idOf=(db,run,kind)=>val(db,`SELECT id FROM public.automation_flow_outbox WHERE run_id='${run}' AND effect_kind='${kind}'`);

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-media-sweep-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+221)%20000);
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
 ok("postgres",{sql:"CREATE DATABASE c190 TEMPLATE base;"},"c190");
 for(const f of CHAIN125_190)ok("c190",{file:f},f);
 ok("postgres",{sql:"CREATE DATABASE g210 TEMPLATE c190;"},"g210");
 ok("g210",{file:M210},"210000");
 ok("postgres",{sql:"CREATE DATABASE g220 TEMPLATE g210;"},"g220");
 ok("g220",{file:MIG},"220000");
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});
let clones=0;
function clone(prefix,template="g220"){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},`clone ${db}`);
 return db;
}

test("live hashes: installed bodies match the embedded 130000 / 220000 hashes",{skip},()=>{
 const h=db=>val(db,`SELECT md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))) FROM pg_proc WHERE oid='${SIG}'::regprocedure`);
 assert.equal(h("g210"),H_OLD);assert.equal(h("g220"),H_NEW);
 assert.equal(val("g220",`SELECT obj_description('${SIG}'::regprocedure,'pg_proc')`),LC,"130000 marker kept");
});

// Same scenario on 210000-only and on 220000: text identical, images swept only by 220000.
function scenario(db){
 const r={};
 r.stale=start(db,"stale");age(db,r.stale);
 r.fresh=start(db,"fresh");
 r.take=start(db,"take");
 ok(db,{sql:`UPDATE public.conversations SET transferred=true,auto_paused_reason='manual_takeover',
  human_agent_expires_at=now()+interval '1 hour' WHERE id=(SELECT conv FROM t.e WHERE name='take')`},"takeover");
 r.inel=start(db,"inel");
 ok(db,{sql:`UPDATE public.automation_flow_runs SET ended_reason='ineligible',ended_at=now() WHERE id='${r.inel}'`},"ineligible");
 r.bstale=start(db,"bstale",B_("bstale"));age(db,r.bstale);
 r.bfresh=start(db,"bfresh",B_("bfresh"));
 r.n=sweep(db);
 return r;
}
test("image effects are swept on stale / takeover / ineligible exactly like text; tags, fresh rows and other tenants untouched",{skip},()=>{
 const db=clone("sw"),r=scenario(db);
 assert.deepEqual(st(db,r.stale),[["message","cancelled/stale"],["message_image","cancelled/stale"],["tag","pending/-"]]);
 assert.deepEqual(st(db,r.take),[["message","cancelled/human_takeover"],["message_image","cancelled/human_takeover"],["tag","pending/-"]]);
 assert.deepEqual(st(db,r.inel),[["message","cancelled/ineligible"],["message_image","cancelled/ineligible"],["tag","pending/-"]]);
 assert.deepEqual(st(db,r.fresh),[["message","pending/-"],["message_image","pending/-"],["tag","pending/-"]]);
 assert.deepEqual(st(db,r.bstale),[["message","cancelled/stale"],["message_image","cancelled/stale"],["tag","pending/-"]],"tenant B's own stale rows");
 assert.deepEqual(st(db,r.bfresh),[["message","pending/-"],["message_image","pending/-"],["tag","pending/-"]],"tenant B untouched by A's conditions");
 assert.equal(r.n,8);
 // Each cancelled row keeps its own tenant (the per-row cancel is keyed by tenant_id and id).
 assert.equal(val(db,`SELECT count(*) FROM public.automation_flow_outbox o JOIN public.automation_flow_runs r ON r.id=o.run_id
  WHERE o.tenant_id<>r.tenant_id`),0);
 assert.equal(val(db,`SELECT count(*) FROM public.automation_flow_outbox WHERE delivery_status='cancelled' AND cancelled_at IS NULL`),0);
 // Idempotent: nothing left to sweep.
 const data=fp(db);
 assert.equal(sweep(db),0);
 assert.equal(fp(db),data,"second sweep changes nothing");
});
test("text behaviour unchanged: the same scenario on 210000 sweeps the same text rows; images stay pending there (differential)",{skip},()=>{
 const a=clone("old","g210"),b=clone("new"),ra=scenario(a),rb=scenario(b);
 for(const k of ["stale","take","inel","fresh","bstale","bfresh"]){
  const text=(db,run)=>st(db,run).filter(([kind])=>kind!=="message_image");
  assert.deepEqual(text(a,ra[k]),text(b,rb[k]),k);
 }
 assert.equal(ra.n,4,"210000 sweeps text only");assert.equal(rb.n,8);
 for(const k of ["stale","take","inel","bstale"])
  assert.deepEqual(st(a,ra[k]).find(([kind])=>kind==="message_image"),["message_image","pending/-"],`${k}: not swept before 220000`);
});
test("revision_inactive: only the deactivated tenant's text and image rows; retry_wait swept; leased / terminal images untouched",{skip},()=>{
 const db=clone("rev");
 const a1=start(db,"a1"),b1=start(db,"b1",B_("b1"));
 ok(db,{sql:`UPDATE public.automation_flow_activations SET is_active=false WHERE tenant_id='${A}' AND flow_key='img'`},"deactivate");
 assert.equal(sweep(db),2);
 assert.deepEqual(st(db,a1),[["message","cancelled/revision_inactive"],["message_image","cancelled/revision_inactive"],["tag","pending/-"]]);
 assert.deepEqual(st(db,b1),[["message","pending/-"],["message_image","pending/-"],["tag","pending/-"]]);
 // Delivery states: retry_wait is swept like text; leased / dead_letter / charge_pending never.
 const d=clone("states");
 const runs={};
 for(const n of ["rw","ls","dl","cp"]){runs[n]=start(d,n);}
 const reserve=(id)=>val(d,`public.flow_reserve_outbox_delivery('${A}','${id}')`,SR);
 const finish=(id,res,mid=null)=>val(d,`public.flow_finish_outbox_delivery('${A}','${id}','${res}',${mid===null?"NULL":L(mid)})`,SR);
 ok(d,{sql:`UPDATE public.automation_flow_outbox SET delivery_status='retry_wait' WHERE id='${idOf(d,runs.rw,"message_image")}'`},"retry_wait");
 assert.equal(reserve(idOf(d,runs.ls,"message_image")),true);
 assert.equal(reserve(idOf(d,runs.dl,"message_image")),true);assert.equal(finish(idOf(d,runs.dl,"message_image"),"rejected"),true);
 assert.equal(reserve(idOf(d,runs.cp,"message_image")),true);assert.equal(finish(idOf(d,runs.cp,"message_image"),"confirmed","mid.cp"),true);
 for(const n of ["rw","ls","dl","cp"])age(d,runs[n]);
 sweep(d);
 const img=n=>st(d,runs[n]).find(([k])=>k==="message_image")[1];
 assert.equal(img("rw"),"cancelled/stale");
 assert.equal(img("ls"),"leased/-");assert.equal(img("dl"),"dead_letter/-");assert.equal(img("cp"),"charge_pending/-");
});
test("privileges and attributes unchanged: service_role only, SECURITY INVOKER, search_path pinned, 130000 marker kept",{skip},()=>{
 const meta=db=>rows(db,`SELECT p.oid::regprocedure::text AS sig,p.prosecdef,p.proconfig,p.proacl::text AS acl,p.pronargdefaults,
  p.proargnames,p.provolatile,pg_get_function_arguments(p.oid) AS args,pg_get_function_result(p.oid) AS res,
  obj_description(p.oid,'pg_proc') AS marker FROM pg_proc p WHERE p.oid='${SIG}'::regprocedure`);
 assert.deepEqual(meta("g220"),meta("g210"),"only the body differs");
 assert.equal(fp("g220",false).length,32);
 for(const role of ["anon","authenticated","public"])
  assert.equal(val("g220",`SELECT has_function_privilege('${role}','${SIG}','EXECUTE')`),false,role);
 for(const role of ["anon","authenticated"]){
  const r=psql("g220",{role,sql:"SELECT public.flow_skip_blocked_outbox(60,200);"});
  assert.equal(sqlState(r.stderr),"42501",role);
 }
 const bounds=psql("g220",{role:SR,sql:"SELECT public.flow_skip_blocked_outbox(4,200);"});
 assert.match(bounds.stderr,/invalid outbox skip bounds/);
});
test("migration: idempotent re-apply; preflight refuses unexpected definitions and missing prerequisites",{skip},()=>{
 const db=clone("idem");
 const once=fp(db);
 const r=ok(db,{file:MIG},"re-apply");
 assert.match(r.err,/already has the 20261029220000 definition/);
 assert.equal(fp(db),once,"re-apply changes nothing");
 refused(clone("no210","c190"),MIG,/apply 20261029210000_flow_media_effects first/,"210000 missing");
 refused(clone("nochain","base"),MIG,/apply 20261029130000_flow_run_lifecycle first/,"chain missing");
 const HEAD="CREATE OR REPLACE FUNCTION public.flow_skip_blocked_outbox(\n p_max_age_minutes integer DEFAULT 60,p_limit integer DEFAULT 200)\nRETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=''\nAS ";
 for(const [label,sql,re,template] of [
  ["sweep body tampered",`${HEAD}$x$BEGIN RETURN 0; END$x$;`,/differs from both the 20261029130000 and the 20261029220000 definition; refusing to overwrite/,"g210"],
  ["sweep body tampered after 220000",`${HEAD}$x$BEGIN RETURN 0; END$x$;`,/refusing to overwrite/,"g220"],
  ["sweep marker removed",`COMMENT ON FUNCTION ${SIG} IS NULL;`,/apply 20261029130000_flow_run_lifecycle first/,"g210"],
  ["foreign overload","CREATE FUNCTION public.flow_skip_blocked_outbox(integer) RETURNS integer LANGUAGE sql AS 'SELECT 0';",
   /Unrecognized overload of public\.flow_skip_blocked_outbox/,"g210"],
  ["made security definer",`ALTER FUNCTION ${SIG} SECURITY DEFINER;`,/refusing to overwrite/,"g210"],
  ["search_path changed",`ALTER FUNCTION ${SIG} SET search_path=public;`,/refusing to overwrite/,"g210"],
  ["210000 CHECK unmarked","COMMENT ON CONSTRAINT automation_flow_outbox_effect_kind_check ON public.automation_flow_outbox IS NULL;",
   /Marked effect_kind CHECK allowing message_image missing/,"g210"],
  ["210000 reserve body missing","CREATE OR REPLACE FUNCTION public.flow_reserve_outbox_delivery(p_tenant uuid,p_outbox uuid)\nRETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $x$BEGIN RETURN false; END$x$;",
   /flow_reserve_outbox_delivery\(uuid,uuid\) does not have the 20261029210000 definition/,"g210"]]){
  const d=clone("pf",template);
  ok(d,{sql},label);
  refused(d,MIG,re,label);
 }
});
test("rollback: refused out of order, data guard for open image effects, restores the exact 210000 state",{skip},()=>{
 const db=clone("rb");
 for(const f of OLDER_RB)refused(db,f,/roll back 20261029220000_flow_media_stale_sweep first/,f,
  {PGOPTIONS:"-c flow.rollback_170000=discard-canary-data -c flow.rollback_210000=keep-media-checks"});
 ok(db,{file:RB},"220000 rollback");
 assert.equal(fp(db),fp("g210"),"schema, comments, privileges and data identical to the 210000 state");
 refused(db,RB,/20261029220000_flow_media_stale_sweep not installed; nothing to roll back/,"rollback twice");
 ok(db,{file:MIG},"re-apply");assert.equal(fp(db),fp("g220"));
 ok(db,{file:RB},"rollback again");
 // Full reverse order now succeeds: 210000, then 190000 .. 125000.
 for(const f of OLDER_RB)ok(db,{file:f,env:{PGOPTIONS:"-c flow.rollback_170000=discard-canary-data"}},f);
 assert.equal(val(db,`SELECT to_regprocedure('${SIG}') IS NULL`),true,"130000 rollback ran");

 // Data guard: open (pending / retry_wait / leased) image effects depend on the sweep.
 const d=clone("rbdata");
 const k1=start(d,"k1"),k2=start(d,"k2");
 refused(d,RB,/2 message_image effect\(s\) still pending\/retry_wait\/leased depend on this sweep/,"open images");
 const i1=idOf(d,k1,"message_image"),i2=idOf(d,k2,"message_image");
 assert.equal(val(d,`public.flow_reserve_outbox_delivery('${A}','${i1}')`,SR),true);
 assert.equal(val(d,`public.flow_skip_outbox_effect('${A}','${i2}','manual')`,SR),true);
 refused(d,RB,/1 message_image effect\(s\) still pending\/retry_wait\/leased/,"leased image");
 assert.equal(val(d,`public.flow_finish_outbox_delivery('${A}','${i1}','rejected',NULL)`,SR),true);
 const data=dfp(d);
 ok(d,{file:RB},"rollback with terminal image rows only");
 assert.equal(val(d,`SELECT md5(prosrc) FROM pg_proc WHERE oid='${SIG}'::regprocedure`),md5(body(M130)),"130000 body restored");
 assert.equal(dfp(d),data,"no row changed by the rollback");
 assert.deepEqual(st(d,k1).map(x=>x[1]),["pending/-","dead_letter/-","pending/-"],"no row changed");
 assert.deepEqual(st(d,k2).map(x=>x[1]),["pending/-","cancelled/manual","pending/-"]);

 // Ownership: a foreign body is refused, never replaced.
 const t=clone("rbt");
 ok(t,{sql:`CREATE OR REPLACE FUNCTION public.flow_skip_blocked_outbox(
 p_max_age_minutes integer DEFAULT 60,p_limit integer DEFAULT 200)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $x$BEGIN RETURN 0; END$x$;`},"tamper");
 refused(t,RB,/has neither the 20261029220000 .* nor the previous body/,"tampered body");
 const u=clone("rbu");
 ok(u,{sql:`COMMENT ON FUNCTION ${SIG} IS 'operator';`},"unmark");
 refused(u,RB,/missing or unrecognized/,"unmarked function");
});
