// 20261029210000_flow_media_effects: the database accepts, reserves and
// finishes 'message_image' Outbox effects (Instagram image attachment; sending
// stays behind FLOW_MEDIA_SEND_ENABLED, default OFF, in the workers).
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) built from the repo fixture chain
// (incl. the 20261028227000/228000 staff/internal-actions bootstrap, like the
// sibling suites) and migrations 20261028220000 .. 20261029190000, then
// 20261029210000. Never connects to any remote host; inherited PG* variables
// are stripped. Billing is out of scope (no consume_* / credit function runs).
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const MIG="supabase/migrations/20261029210000_flow_media_effects.sql";
const RB="supabase/rollbacks/20261029210000_flow_media_effects.rollback.sql";
const M225="supabase/migrations/20261028225000_flow_runtime_advance.sql";
const M226="supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql";
const M190="supabase/migrations/20261029190000_flow_begin_durable_run_superseding.sql";
const CHAIN125_190=["supabase/migrations/20261029125000_flow_durable_button_run.sql",
 "supabase/migrations/20261029130000_flow_run_lifecycle.sql",
 "supabase/migrations/20261029140000_flow_outbox_ai_retry.sql",
 "supabase/migrations/20261029150000_flow_takeover_resume.sql",
 "supabase/migrations/20261029160000_flow_credits_pause.sql",
 "supabase/migrations/20261029170000_flow_canary_claim_durable.sql",
 "supabase/migrations/20261029180000_flow_durable_button_run_guards.sql",M190];
const OLDER_RB=["supabase/rollbacks/20261029190000_flow_begin_durable_run_superseding.rollback.sql",
 "supabase/rollbacks/20261029180000_flow_durable_button_run_guards.rollback.sql",
 "supabase/rollbacks/20261029170000_flow_canary_claim_durable.rollback.sql",
 "supabase/rollbacks/20261029160000_flow_credits_pause.rollback.sql",
 "supabase/rollbacks/20261029150000_flow_takeover_resume.rollback.sql",
 "supabase/rollbacks/20261029140000_flow_outbox_ai_retry.rollback.sql",
 "supabase/rollbacks/20261029130000_flow_run_lifecycle.rollback.sql",
 "supabase/rollbacks/20261029125000_flow_durable_button_run.rollback.sql",
 "supabase/rollbacks/20261028226000_flow_outbox_delivery_attempts.rollback.sql",
 "supabase/rollbacks/20261028225000_flow_runtime_advance.rollback.sql"];
const MARK="CREATED_BY_20261029210000_FLOW_MEDIA_EFFECTS";
const COMMIT_SIG="public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)";
const RESERVE_SIG="public.flow_reserve_outbox_delivery(uuid,uuid)";
const FINISH_SIG="public.flow_finish_outbox_delivery(uuid,uuid,text,text)";
const src=f=>readFileSync(f,"utf8");
const md5=x=>createHash("md5").update(x).digest("hex");
const norm=x=>x.replace(/[ \t\n\r\f\v]+/g," ").replace(/^ +| +$/g,"");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");
const body=(f,tag)=>{const s=src(f),o=`AS $${tag}$`,a=s.indexOf(o);assert.ok(a>=0,`${f} ${tag}`);
 return s.slice(a+o.length,s.indexOf(`$${tag}$`,a+o.length));};
const TAGS=[["advance",M225],["reserve",M226],["finish",M226]];

// ---------------------------------------------------------------- static
test("210000 follows the 125000..190000 chain; 200000 (storage) is independent; only 220000 (requires 210000) is newer",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 assert.equal(stamps.filter(s=>s==="20261029210000").length,1);
 // 20261029220000_flow_media_stale_sweep requires 210000 (tests/flow-media-stale-sweep.test.mjs).
 // 20261029230000_flow_multichannel_support requires 220000 (tests/flow-multichannel-support.test.mjs).
 for(const s of stamps)if(!["20261029210000","20261029220000","20261029230000","20261029240000","20261029250000","20261029260000","20261029270000","20261029280000","20261029290000","20261029300000"].includes(s))assert.ok(s<"20261029210000",s);
 for(const f of [...CHAIN125_190,M225,M226,RB,...OLDER_RB])assert.ok(existsSync(f),f);
});
test("migration and rollback: one bounded transaction, marker, service_role only, no billing, no row writes",()=>{
 for(const f of [MIG,RB]){
  const s=src(f),code=noComments(s);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
  assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1,f);assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.doesNotMatch(code,/SECURITY DEFINER|\bTO\s+(anon|authenticated|PUBLIC)\b|CREATE POLICY|\bTRUNCATE\b/i,f);
  // (CREDITS_PAUSE is only the 160000 ownership marker named in the preflight.)
  assert.doesNotMatch(code,/consume_|credits_remaining|wayl|topup|cron\.|vault\.|net\.http_/i,f);
  assert.ok(code.includes(`v_marker constant text := '${MARK}'`),f);
  // Row writes only inside the copied function bodies (never executed by the script itself).
  let outside=code;for(const [t] of TAGS)outside=outside.replace(new RegExp(`\\$${t}\\$[\\s\\S]*?\\$${t}\\$`,"g"),"");
  assert.doesNotMatch(outside,/\bINSERT\b|\bUPDATE\s+public\.|\bDELETE\s+FROM\b/i,f);
  assert.doesNotMatch(outside,/DROP\s+(TABLE|FUNCTION|COLUMN|INDEX|TRIGGER)/i,f);
 }
 const code=noComments(src(MIG));
 assert.doesNotMatch(code,/CREATE\s+FUNCTION/i,"CREATE OR REPLACE only");
 assert.equal((code.match(/CREATE OR REPLACE FUNCTION/g)??[]).length,3);
 // Headers identical to the originals (same arguments, defaults, attributes).
 for(const [tag,f] of TAGS){
  const head=s=>{const i=s.indexOf(`AS $${tag}$`);return s.slice(s.lastIndexOf("FUNCTION public.",i),i);};
  assert.equal(head(src(MIG)).replace("CREATE OR REPLACE ",""),head(src(f)).replace("CREATE ",""),tag);
 }
 assert.equal((code.match(/^GRANT EXECUTE ON FUNCTION [^\n]+ TO service_role;$/gm)??[]).length,3);
 assert.doesNotMatch(noComments(src(RB)),/^(REVOKE|GRANT)/m,"rollback never changes privileges");
});
test("bodies: only the effect-kind lists and the additive 'rejected' outcome change; rollback restores the exact previous bodies",()=>{
 const diff=(a,b)=>{const x=a.split("\n"),y=b.split("\n");return {gone:x.filter(l=>!y.includes(l)),added:y.filter(l=>!x.includes(l))};};
 let d=diff(body(M225,"advance"),body(MIG,"advance"));
 assert.deepEqual(d,{gone:["     kind NOT IN('message','question','delay','handoff','tag','untag','staff_notification') OR"],
  added:["     kind NOT IN('message','question','delay','handoff','tag','untag','staff_notification','message_image') OR"]});
 d=diff(body(M226,"reserve"),body(MIG,"reserve"));
 assert.deepEqual(d,{gone:["  AND o.delivery_status='pending' AND o.effect_kind IN('message','question')"],
  added:["  AND o.delivery_status='pending' AND o.effect_kind IN('message','question','message_image')"]});
 d=diff(body(M226,"finish"),body(MIG,"finish"));
 assert.deepEqual(d.gone,[
  " IF p_tenant IS NULL OR p_outbox IS NULL OR p_result NOT IN('confirmed','uncertain')",
  " OR (p_result='uncertain' AND p_provider_message_id IS NOT NULL)",
  " final_status:=CASE WHEN p_result='confirmed' THEN 'charge_pending' ELSE 'uncertain' END;"]);
 const fin=body(MIG,"finish");
 assert.ok(fin.includes("p_result NOT IN('confirmed','uncertain','rejected')"));
 assert.ok(fin.includes(" OR (p_result IN('uncertain','rejected') AND p_provider_message_id IS NOT NULL)"));
 assert.match(fin,/IF p_result='rejected' AND NOT EXISTS\(\n   SELECT 1 FROM public\.automation_flow_outbox\n   WHERE tenant_id=p_tenant AND id=p_outbox AND effect_kind='message_image'\)\n THEN RETURN false;END IF;/);
 assert.ok(fin.includes("WHEN p_result='rejected' THEN 'dead_letter' ELSE 'uncertain' END;"));
 assert.ok(fin.includes("WHERE tenant_id=p_tenant AND outbox_id=p_outbox AND status='attempting';"),"one-shot attempt unchanged");
 // Rollback bodies are byte-identical to 20261028225000 / 20261028226000.
 for(const [tag,f] of TAGS)assert.equal(md5(body(RB,tag)),md5(body(f,tag)),tag);
 // Embedded hashes = normalized bodies (previous, 210000) in the migration and the rollback.
 for(const [tag,f] of TAGS){
  const pair=`'${md5(norm(body(f,tag)))}','${md5(norm(body(MIG,tag)))}'`;
  assert.ok(src(MIG).includes(pair),`migration ${tag}`);assert.ok(src(RB).includes(pair),`rollback ${tag}`);
 }
});
const NEW_HASHES=TAGS.map(([tag])=>md5(norm(body(MIG,tag))));
test("every older rollback (190000 .. 125000, 226000, 225000) refuses while a 210000 body is installed",()=>{
 for(const f of OLDER_RB){
  const s=src(f),g=s.slice(s.indexOf("BEGIN;"),s.search(/\s\$(g|guard|rollback)\$;/));
  for(const h of NEW_HASHES)assert.ok(g.includes(`'${h}'`),`${f}: ${h}`);
  for(const sig of [COMMIT_SIG,RESERVE_SIG,FINISH_SIG])assert.ok(g.includes(`to_regprocedure('${sig}')`),`${f}: ${sig}`);
  assert.match(g,/RAISE EXCEPTION '[^']*roll back 20261029210000_flow_media_effects first'/,f);
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
// Schema (+ constraint comments) and optionally data fingerprint of schema public.
const FP=data=>`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||
  coalesce(p.proacl::text,'')||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||pg_get_function_result(p.oid)
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
// One durable start whose first commit stores [text seq0, image seq1] (as runtimeChain plans it).
const EFFECTS=n=>JSON.stringify([
 {kind:"message",idempotencyKey:`m.${n}`,payload:{kind:"message",text:"our product",seq:0}},
 {kind:"message_image",idempotencyKey:`i.${n}`,payload:{kind:"message_image",url:IMG,seq:1}}]);
function start(db,name,{tenant=A,acc=ACC,flow="img",effects=EFFECTS(name)}={}){
 ok(db,{sql:`SELECT t.ev('${name}','${tenant}','${acc}');`},`event ${name}`);
 const e=rows(db,`SELECT * FROM t.e WHERE name='${name}'`)[0];
 return psql(db,{role:SR,sql:`SELECT public.flow_begin_durable_run(${L(e.tenant)},${L(e.acc)},${L(e.conv)},${L(e.msg)},${L(e.mid)},`+
  `${L(flow)},1,'start','pic',2,'completed','{}'::jsonb,NULL,${L(effects)}::jsonb);`});
}
const runOf=(db,name)=>val(db,`SELECT r.id FROM public.automation_flow_runs r JOIN t.e ON e.mid=r.provider_event_id WHERE e.name='${name}'`);
const outbox=(db,run,kind)=>rows(db,`SELECT id,tenant_id,delivery_status,effect_kind FROM public.automation_flow_outbox
 WHERE run_id='${run}'${kind?` AND effect_kind='${kind}'`:""} ORDER BY effect_kind`);
const reserve=(db,tenant,id)=>val(db,`public.flow_reserve_outbox_delivery('${tenant}','${id}')`,SR);
const finish=(db,tenant,id,res,mid=null)=>val(db,`public.flow_finish_outbox_delivery('${tenant}','${id}','${res}',${mid===null?"NULL":L(mid)})`,SR);
const attempt=(db,id)=>rows(db,`SELECT status,provider_message_id,confirmed_at IS NOT NULL AS confirmed,uncertain_at IS NOT NULL AS uncertain,review_status
 FROM public.automation_flow_delivery_attempts WHERE outbox_id='${id}'`)[0];
const status=(db,id)=>val(db,`SELECT delivery_status FROM public.automation_flow_outbox WHERE id='${id}'`);

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-media-effects-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+211)%20000);
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
 ok("g210",{file:MIG},"210000");
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});
let clones=0;
function clone(prefix,template="g210"){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},`clone ${db}`);
 return db;
}

test("before 210000 the database refuses image effects (differential)",{skip},()=>{
 const db=clone("pre","c190");
 const r=start(db,"p1");
 assert.notEqual(r.status,0);assert.match(r.stderr,/First durable step rejected/,"flow_commit_run_step rejects the kind");
 const ins=psql(db,{sql:`INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
  SELECT tenant_id,id,'x','message_image','{}'::jsonb FROM public.automation_flow_runs LIMIT 1;`});
 assert.equal(ins.status,0,"no run yet: nothing inserted");
 assert.ok(start(db,"p0",{effects:JSON.stringify([{kind:"message",idempotencyKey:"m.p0",payload:{kind:"message",text:"x",seq:0}}])}).status===0);
 const ck=psql(db,{sql:`INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
  SELECT tenant_id,id,'x','message_image','{}'::jsonb FROM public.automation_flow_runs LIMIT 1;`});
 assert.notEqual(ck.status,0);assert.equal(sqlState(ck.stderr),"23514","outbox CHECK rejects message_image");
});

test("commit/begin store message_image effects; unknown kinds still rejected; CHECK is a strict superset",{skip},()=>{
 const db=clone("commit");
 const r=start(db,"c1");
 assert.equal(r.status,0,r.stderr);
 const run=runOf(db,"c1");
 assert.deepEqual(outbox(db,run).map(o=>[o.effect_kind,o.delivery_status]),[["message","pending"],["message_image","pending"]]);
 assert.deepEqual(val(db,`SELECT payload FROM public.automation_flow_outbox WHERE run_id='${run}' AND effect_kind='message_image'`),
  {kind:"message_image",url:IMG,seq:1});
 for(const kind of ["message_video","image","","MESSAGE_IMAGE"]){
  const x=start(db,`u_${kind||"empty"}`,{effects:JSON.stringify([{kind,idempotencyKey:`u.${kind}`,payload:{kind}}])});
  assert.notEqual(x.status,0,kind);assert.match(x.stderr,/First durable step rejected/,kind);
 }
 const bad=psql(db,{sql:`INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
  VALUES('${A}','${run}','z','message_video','{}'::jsonb);`});
 assert.equal(sqlState(bad.stderr),"23514","unknown kind refused by the CHECK");
 const defs=rows(db,`SELECT conrelid::regclass::text AS tbl,conname,pg_get_constraintdef(oid) AS def,convalidated,
  obj_description(oid,'pg_constraint') AS c FROM pg_constraint
  WHERE conrelid IN('public.automation_flow_outbox'::regclass,'public.automation_flow_delivery_attempts'::regclass)
   AND obj_description(oid,'pg_constraint') LIKE '${MARK}%' ORDER BY 1`);
 assert.deepEqual(defs.map(d=>[d.tbl,d.conname,d.convalidated,d.c]),[
  ["automation_flow_delivery_attempts","automation_flow_delivery_attempts_status_check",true,`${MARK} previous_comment=null`],
  ["automation_flow_outbox","automation_flow_outbox_effect_kind_check",true,`${MARK} previous_comment=null`]]);
 assert.match(defs[1].def,/'message'::text, 'question'::text, 'delay'::text, 'handoff'::text, 'tag'::text, 'untag'::text, 'staff_notification'::text, 'message_image'::text/);
 assert.match(defs[0].def,/'attempting'::text, 'confirmed'::text, 'uncertain'::text, 'rejected'::text/);
});

test("reserve: message_image reserved once like text; same gates; tenant-scoped",{skip},()=>{
 const db=clone("reserve");
 assert.equal(start(db,"r1").status,0);
 const [msg,img]=outbox(db,runOf(db,"r1"));
 assert.equal(reserve(db,B,img.id),false,"foreign tenant id never reserves A's effect");
 assert.equal(status(db,img.id),"pending");
 ok(db,{sql:"UPDATE public.automation_flow_global_switch SET enabled=false"},"off");
 assert.equal(reserve(db,A,img.id),false,"global switch off");
 ok(db,{sql:"UPDATE public.automation_flow_global_switch SET enabled=true"},"on");
 ok(db,{sql:"UPDATE public.automation_flow_activations SET is_active=false WHERE flow_key='img'"},"inactive");
 assert.equal(reserve(db,A,img.id),false,"inactive activation");
 ok(db,{sql:"UPDATE public.automation_flow_activations SET is_active=true WHERE flow_key='img'"},"active");
 assert.equal(reserve(db,A,img.id),true);
 assert.equal(reserve(db,A,img.id),false,"one shot");
 assert.equal(status(db,img.id),"leased");
 assert.deepEqual(attempt(db,img.id),{status:"attempting",provider_message_id:null,confirmed:false,uncertain:false,review_status:"none"});
 assert.equal(reserve(db,A,msg.id),true,"text unchanged");
 // Internal kinds are still never reserved.
 const tag=start(db,"r2",{effects:JSON.stringify([{kind:"tag",idempotencyKey:"t.r2",payload:{kind:"tag",tag:"vip",seq:0}}])});
 assert.equal(tag.status,0,tag.stderr);
 const [t2]=outbox(db,runOf(db,"r2"));
 assert.equal(t2.effect_kind,"tag");assert.equal(reserve(db,A,t2.id),false);
});

test("finish: 'rejected' ends an image as dead_letter; confirmed/uncertain unchanged; text can never be 'rejected'",{skip},()=>{
 const db=clone("finish");
 for(const n of ["f1","f2","f3"])assert.equal(start(db,n).status,0);
 const [m1,i1]=outbox(db,runOf(db,"f1")),[m2,i2]=outbox(db,runOf(db,"f2")),[,i3]=outbox(db,runOf(db,"f3"));
 for(const o of [m1,i1,m2,i2,i3])assert.equal(reserve(db,A,o.id),true);
 // Invalid combinations refused, nothing changed.
 const before=fp(db);
 assert.equal(finish(db,A,i1.id,"rejected","mid.x"),false,"rejected never carries a provider id");
 assert.equal(finish(db,A,m1.id,"rejected"),false,"text effects can never be rejected");
 assert.equal(finish(db,B,i1.id,"rejected"),false,"foreign tenant");
 assert.equal(finish(db,A,i1.id,"failed"),false,"unknown outcome");
 assert.equal(fp(db),before);
 // Permanent provider rejection of the image.
 assert.equal(finish(db,A,i1.id,"rejected"),true);
 assert.equal(status(db,i1.id),"dead_letter");
 assert.deepEqual(attempt(db,i1.id),{status:"rejected",provider_message_id:null,confirmed:false,uncertain:false,review_status:"none"});
 assert.equal(val(db,`SELECT lease_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND provider_message_id IS NULL
  FROM public.automation_flow_outbox WHERE id='${i1.id}'`),true);
 assert.equal(finish(db,A,i1.id,"rejected"),false,"once");
 assert.equal(finish(db,A,i1.id,"uncertain"),false,"terminal");
 assert.equal(reserve(db,A,i1.id),false,"never resent");
 // Unchanged outcomes, for text and image.
 assert.equal(finish(db,A,m1.id,"confirmed","mid.m1"),true);assert.equal(status(db,m1.id),"charge_pending");
 assert.equal(finish(db,A,i2.id,"confirmed","mid.i2"),true);assert.equal(status(db,i2.id),"charge_pending");
 assert.equal(finish(db,A,m2.id,"uncertain"),true);assert.equal(status(db,m2.id),"uncertain");
 assert.equal(finish(db,A,i3.id,"uncertain"),true);assert.equal(status(db,i3.id),"uncertain");
 assert.equal(finish(db,A,i3.id,"rejected"),false,"an uncertain image is never turned into dead_letter later");
 assert.deepEqual(attempt(db,m1.id),{status:"confirmed",provider_message_id:"mid.m1",confirmed:true,uncertain:false,review_status:"none"});
 // Human review queue: uncertain attempts only, never the rejected one.
 ok(db,{sql:"UPDATE public.automation_flow_delivery_attempts SET attempted_at=now()-interval '1 hour',uncertain_at=CASE WHEN uncertain_at IS NULL THEN NULL ELSE now()-interval '1 hour' END"},"age");
 assert.equal(val(db,"public.flow_queue_outbox_human_review(15,100)",SR),2);
 assert.equal(attempt(db,i1.id).review_status,"none");assert.equal(status(db,i1.id),"dead_letter");
 // The attempts CHECKs still hold: 'rejected' without a confirmed_at.
 const forged=psql(db,{sql:`UPDATE public.automation_flow_delivery_attempts SET confirmed_at=now() WHERE outbox_id='${i1.id}'`});
 assert.equal(sqlState(forged.stderr),"23514");
 const bogus=psql(db,{sql:`UPDATE public.automation_flow_delivery_attempts SET status='lost' WHERE outbox_id='${i1.id}'`});
 assert.equal(sqlState(bogus.stderr),"23514");
});

test("privileges and attributes unchanged: service_role only, SECURITY INVOKER, search_path pinned, 225000/226000 markers kept",{skip},()=>{
 const meta=db=>rows(db,`SELECT p.oid::regprocedure::text AS sig,p.prosecdef,p.proconfig,p.proacl::text AS acl,p.pronargdefaults,
  obj_description(p.oid,'pg_proc') AS marker FROM pg_proc p
  WHERE p.oid IN('${COMMIT_SIG}'::regprocedure,'${RESERVE_SIG}'::regprocedure,'${FINISH_SIG}'::regprocedure) ORDER BY 1`);
 assert.deepEqual(meta("g210"),meta("c190"),"only the bodies differ");
 for(const role of ["anon","authenticated","public"])
  for(const sig of [COMMIT_SIG,RESERVE_SIG,FINISH_SIG])
   assert.equal(val("g210",`SELECT has_function_privilege('${role}','${sig}','EXECUTE')`),false,`${role} ${sig}`);
 const db=clone("acl");
 assert.equal(start(db,"a1").status,0);
 const [,img]=outbox(db,runOf(db,"a1"));
 for(const role of ["anon","authenticated"]){
  const r=psql(db,{role,sql:`SELECT public.flow_reserve_outbox_delivery('${A}','${img.id}');`});
  assert.equal(sqlState(r.stderr),"42501",role);
 }
});

test("migration: idempotent re-apply; preflight refuses unexpected definitions and missing prerequisites",{skip},()=>{
 const db=clone("idem");
 const once=fp(db);
 ok(db,{file:MIG},"re-apply");
 assert.equal(fp(db),once,"re-apply changes nothing");
 refused(clone("no190","base"),MIG,/apply 20261029130000_flow_run_lifecycle first/,"chain missing");
 const d190=clone("only180","base");
 for(const f of CHAIN125_190.slice(0,-1))ok(d190,{file:f},f);
 refused(d190,MIG,/apply 20261029190000_flow_begin_durable_run_superseding first/,"190000 missing");
 const RESERVE_HEAD="CREATE OR REPLACE FUNCTION public.flow_reserve_outbox_delivery(p_tenant uuid,p_outbox uuid)\nRETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''\nAS ";
 for(const [label,sql,re,template] of [
  ["reserve body tampered",`${RESERVE_HEAD}$x$BEGIN RETURN true; END$x$;`,/differs from both the 20261028226000 and the 20261029210000 definition; refusing to overwrite/,"c190"],
  ["finish marker removed",`COMMENT ON FUNCTION ${FINISH_SIG} IS NULL;`,/apply 20261028226000_flow_outbox_delivery_attempts first/,"c190"],
  ["foreign overload","CREATE FUNCTION public.flow_finish_outbox_delivery(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';",/Unrecognized overload of public\.flow_finish_outbox_delivery/,"c190"],
  ["commit made security definer",`ALTER FUNCTION ${COMMIT_SIG} SECURITY DEFINER;`,/refusing to overwrite/,"c190"],
  ["unexpected effect_kind CHECK","ALTER TABLE public.automation_flow_outbox DROP CONSTRAINT automation_flow_outbox_effect_kind_check, ADD CONSTRAINT automation_flow_outbox_effect_kind_check CHECK (effect_kind IN ('message','question'));",
   /Unrecognized CHECK on public\.automation_flow_outbox\.effect_kind/,"c190"],
  ["second effect_kind CHECK","ALTER TABLE public.automation_flow_outbox ADD CONSTRAINT x_chk CHECK (effect_kind<>'handoff' OR payload IS NOT NULL);",
   /Another CHECK on public\.automation_flow_outbox\.effect_kind exists/,"c190"],
  ["no effect_kind CHECK","ALTER TABLE public.automation_flow_outbox DROP CONSTRAINT automation_flow_outbox_effect_kind_check;",
   /Unrecognized CHECK on public\.automation_flow_outbox\.effect_kind \(count=0/,"c190"],
  ["210000 CHECK without its marker",`COMMENT ON CONSTRAINT automation_flow_outbox_effect_kind_check ON public.automation_flow_outbox IS NULL;`,
   /has the 20261029210000 definition without its marker/,"g210"],
  ["attempts status CHECK changed","ALTER TABLE public.automation_flow_delivery_attempts DROP CONSTRAINT automation_flow_delivery_attempts_status_check;",
   /Unrecognized CHECK on public\.automation_flow_delivery_attempts\.status/,"c190"]]){
  const d=clone("pf",template);
  ok(d,{sql},label);
  refused(d,MIG,re,label);
 }
});

test("rollback: refused out of order, restores the exact 125000..190000 state, data guard, opt-in keeps widened CHECKs",{skip},()=>{
 const db=clone("rb");
 for(const f of OLDER_RB)refused(db,f,/roll back 20261029210000_flow_media_effects first/,f,
  {PGOPTIONS:"-c flow.rollback_170000=discard-canary-data"});
 ok(db,{file:RB},"210000 rollback");
 assert.equal(fp(db),fp("c190"),"schema, comments and data identical to the 125000..190000 state");
 refused(db,RB,/20261029210000_flow_media_effects not installed; nothing to roll back/,"rollback twice");
 // Re-apply reproduces the 210000 schema exactly; then the full reverse order succeeds.
 ok(db,{file:MIG},"re-apply");assert.equal(fp(db),fp("g210"));
 ok(db,{file:RB},"rollback again");
 for(const f of OLDER_RB.slice(0,-2))ok(db,{file:f,env:{PGOPTIONS:"-c flow.rollback_170000=discard-canary-data"}},f);
 assert.equal(val(db,`SELECT to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)') IS NULL`),true,"125000 rollback ran");

 // Data guard: open image effects refuse even with the opt-in; terminal ones need it.
 const d=clone("rbdata");
 assert.equal(start(d,"k1").status,0);assert.equal(start(d,"k2").status,0);
 const [,i1]=outbox(d,runOf(d,"k1")),[,i2]=outbox(d,runOf(d,"k2"));
 refused(d,RB,/2 message_image effect\(s\) still pending\/retry_wait\/leased/,"open images",{PGOPTIONS:"-c flow.rollback_210000=keep-media-checks"});
 assert.equal(reserve(d,A,i1.id),true);assert.equal(finish(d,A,i1.id,"rejected"),true);
 assert.equal(val(d,`public.flow_skip_outbox_effect('${A}','${i2.id}','manual')`,SR),true);
 refused(d,RB,/2 message_image effect\(s\) and 1 rejected attempt\(s\) violate the previous CHECKs/,"terminal rows without opt-in");
 const data=dfp(d);
 const r=ok(d,{file:RB,env:{PGOPTIONS:"-c flow.rollback_210000=keep-media-checks"}},"opt-in rollback");
 assert.match(r.err,/widened CHECKs kept, no row changed/);
 assert.equal(val(d,`SELECT md5(prosrc) FROM pg_proc WHERE oid='${RESERVE_SIG}'::regprocedure`),md5(body(M226,"reserve")),"functions restored");
 assert.equal(val(d,`SELECT md5(prosrc) FROM pg_proc WHERE oid='${FINISH_SIG}'::regprocedure`),md5(body(M226,"finish")));
 assert.equal(val(d,`SELECT md5(prosrc) FROM pg_proc WHERE oid='${COMMIT_SIG}'::regprocedure`),md5(body(M225,"advance")));
 assert.equal(val(d,`SELECT count(*) FROM pg_constraint WHERE obj_description(oid,'pg_constraint') LIKE '${MARK}%'`),2,"widened CHECKs kept");
 assert.equal(dfp(d),data,"no row changed");
 assert.equal(status(d,i1.id),"dead_letter");assert.equal(status(d,i2.id),"cancelled");
 assert.equal(attempt(d,i1.id).status,"rejected","no row changed");
 // Older rollbacks are allowed again (the 210000 bodies are gone).
 ok(d,{file:OLDER_RB[0]},"190000 rollback after the opt-in rollback");
 // Re-applying 210000 over the kept CHECKs is accepted (marked, 210000 definition).
 ok(d,{file:M190},"190000 again");ok(d,{file:MIG},"210000 over kept CHECKs");
 assert.equal(val(d,`SELECT md5(prosrc) FROM pg_proc WHERE oid='${RESERVE_SIG}'::regprocedure`),md5(body(MIG,"reserve")));

 // Ownership: an unmarked CHECK is refused, never replaced.
 const u=clone("rbu");
 ok(u,{sql:"COMMENT ON CONSTRAINT automation_flow_delivery_attempts_status_check ON public.automation_flow_delivery_attempts IS 'operator';"},"unmark");
 refused(u,RB,/partial state \(3 of 3 functions with the 210000 body, 1 of 2 marked CHECKs\)/,"unmarked CHECK");
 const t=clone("rbt");
 ok(t,{sql:`CREATE OR REPLACE FUNCTION public.flow_reserve_outbox_delivery(p_tenant uuid,p_outbox uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $x$BEGIN RETURN false; END$x$;`},"tamper");
 refused(t,RB,/has neither the 20261029210000 nor the previous body/,"tampered body");
});
