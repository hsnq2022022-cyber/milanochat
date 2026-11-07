// 20261029180000_flow_durable_button_run_guards: flow_resume_button_run
// re-checks the account/tenant live flags (same predicate as
// flow_begin_durable_run), and both durable RPCs require the claim's inbound
// message to belong to the claim's / run's conversation.
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) built from the repo fixture chain
// and migrations 20261028220000 .. 20261029180000. Never connects to any
// remote host; inherited PG* variables are stripped from every client.
// Billing is out of scope (no consume_* / credit function is exercised).
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const MIG="supabase/migrations/20261029180000_flow_durable_button_run_guards.sql";
const RB="supabase/rollbacks/20261029180000_flow_durable_button_run_guards.rollback.sql";
const M125="supabase/migrations/20261029125000_flow_durable_button_run.sql";
const PROPOSAL="supabase/proposals/flow_durable_button_ingress.review.sql";
const LATER=["supabase/migrations/20261029130000_flow_run_lifecycle.sql",
 "supabase/migrations/20261029140000_flow_outbox_ai_retry.sql",
 "supabase/migrations/20261029150000_flow_takeover_resume.sql",
 "supabase/migrations/20261029160000_flow_credits_pause.sql",
 "supabase/migrations/20261029170000_flow_canary_claim_durable.sql"];
const OLDER_RB=["supabase/rollbacks/20261029170000_flow_canary_claim_durable.rollback.sql",
 "supabase/rollbacks/20261029160000_flow_credits_pause.rollback.sql",
 "supabase/rollbacks/20261029150000_flow_takeover_resume.rollback.sql",
 "supabase/rollbacks/20261029140000_flow_outbox_ai_retry.rollback.sql",
 "supabase/rollbacks/20261029130000_flow_run_lifecycle.rollback.sql",
 "supabase/rollbacks/20261029125000_flow_durable_button_run.rollback.sql"];
const MARK="CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS";
const MARK125="CREATED_BY_20261029125000_FLOW_DURABLE_BUTTON_RUN";
const BEGIN_SIG="public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)";
const RESUME_SIG="public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)";
const src=f=>readFileSync(f,"utf8");
const md5=x=>createHash("md5").update(x).digest("hex");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");
const between=(s,open,close)=>{const a=s.indexOf(open);assert.ok(a>=0,open);const b=a+open.length;return s.slice(b,s.indexOf(close,b));};
const lit=(f,name,tag)=>between(src(f),`${name} constant text := $${tag}$`,`$${tag}$;`);
const B125=lit(M125,"v_begin_src","begin"),R125=lit(M125,"v_resume_src","resume");
const B180=lit(MIG,"v_begin_180","begin"),R180=lit(MIG,"v_resume_180","resume");

// ---------------------------------------------------------------- static
test("180000 follows the whole 125000..170000 chain; only 190000 (requires 180000) is newer",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 assert.equal(stamps.filter(s=>s==="20261029180000").length,1);
 // 20261029190000_flow_begin_durable_run_superseding (tests/flow-begin-durable-run-superseding.test.mjs).
 // 20261029200000_flow_media_storage is an independent storage bucket (no flow object).
 // 20261029210000_flow_media_effects requires 190000 (tests/flow-media-effects.test.mjs).
 // 20261029220000_flow_media_stale_sweep requires 210000 (tests/flow-media-stale-sweep.test.mjs).
 // 20261029230000_flow_multichannel_support requires 220000 (tests/flow-multichannel-support.test.mjs).
 for(const s of stamps)if(!["20261029180000","20261029190000","20261029200000","20261029210000","20261029220000","20261029230000","20261029240000","20261029250000"].includes(s))assert.ok(s<"20261029180000",s);
 for(const f of [M125,...LATER])assert.ok(existsSync(f),f);
});
test("bodies: 125000 copies are byte-identical (migration, rollback, proposal); 180000 adds exactly the guards",()=>{
 assert.equal(lit(MIG,"v_begin_125","begin"),B125);assert.equal(lit(MIG,"v_resume_125","resume"),R125);
 assert.equal(lit(RB,"v_begin_125","begin"),B125,"rollback restores the exact 125000 begin text");
 assert.equal(lit(RB,"v_resume_125","resume"),R125,"rollback restores the exact 125000 resume text");
 assert.equal(B125,between(src(PROPOSAL),"AS $begin$","$begin$"));
 assert.equal(R125,between(src(PROPOSAL),"AS $resume$","$resume$"));
 assert.equal(lit(RB,"v_begin_180","begin"),B180);assert.equal(lit(RB,"v_resume_180","resume"),R180);
 for(const h of ["v_begin_head","v_resume_head"])for(const f of [MIG,RB])
  assert.equal(lit(f,h,"head"),lit(M125,h,"head"),`${f} ${h}: signature, names, result, SECURITY INVOKER, search_path`);
 // Exact differences (nothing else changes).
 assert.equal(B180,B125.replace("   AND m.direction='in' AND m.wa_message_id=p_event\n",
  "   AND m.direction='in' AND m.wa_message_id=p_event\n   AND m.conversation_id=cl.conversation_id\n"));
 assert.equal(R180,R125.replace("     AND revision=old_run.publication_revision AND is_active)\n",
  "     AND revision=old_run.publication_revision AND is_active)\n OR NOT EXISTS(\n"+
  "  SELECT 1 FROM public.channel_accounts a\n  JOIN public.tenants t ON t.id=a.tenant_id\n"+
  "  WHERE a.tenant_id=p_tenant AND a.id=old_run.channel_account_id\n"+
  "   AND a.platform='instagram' AND a.is_active\n   AND a.agent_enabled AND a.auto_reply AND t.is_active)\n")
  .replace("   AND m.wa_message_id=p_event\n )","   AND m.wa_message_id=p_event AND m.conversation_id=old_run.conversation_id\n )"));
 // Begin's flag predicate is the one resume now repeats.
 assert.ok(B125.includes("AND a.platform='instagram' AND a.is_active\n   AND a.agent_enabled AND a.auto_reply AND t.is_active;"));
 const grants=f=>(src(f).match(/^(REVOKE|GRANT)[^;]*;/gm)??[]).join("\n");
 assert.equal(grants(MIG),grants(M125),"same REVOKE/GRANT as 125000");
});
test("migration and rollback: bounded, one transaction, no data/table change, service_role only",()=>{
 for(const f of [MIG,RB]){
  const s=src(f),code=noComments(s);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
  assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1,f);assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.doesNotMatch(code,/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+public\.|\bALTER\s+TABLE\b|CREATE\s+(UNIQUE\s+)?INDEX|CONCURRENTLY/i,f);
  const outside=code.replace(/\$begin\$[\s\S]*?\$begin\$/g,"").replace(/\$resume\$[\s\S]*?\$resume\$/g,"");
  assert.doesNotMatch(outside,/\bINSERT\b/i,f);
  assert.doesNotMatch(code,/SECURITY DEFINER|\bTO\s+(anon|authenticated|PUBLIC)\b|CREATE POLICY/i,f);
  // (the 160000 chain marker FLOW_CREDITS_PAUSE is the only "credits" text: a preflight marker check)
  assert.doesNotMatch(code.replace(/CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE|20261029160000_flow_credits_pause/g,""),
   /consume_|credits|wayl|topup|cron\.|vault\.|net\.http_/i,f);
  assert.doesNotMatch(code,/FUNCTION public\.flow_claim_inbound|flow_publish_revision|flow_activate_revision|flow_deactivate_revision/,f);
  assert.ok(code.includes(`v_marker constant text := '${MARK}'`),f);
 }
 assert.match(src(MIG),/refusing to overwrite/);
 assert.doesNotMatch(noComments(src(RB)),/^(REVOKE|GRANT)/m,"rollback never changes privileges");
});
test("every older rollback refuses while a 180000-marked function exists",()=>{
 for(const f of OLDER_RB){
  const s=src(f),g=s.slice(s.indexOf("BEGIN;"));
  assert.ok(g.includes(`'${MARK}'`),f);
  assert.match(g,/RAISE EXCEPTION '[^']*roll back 20261029180000_flow_durable_button_run_guards first'/,f);
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
// Production live-only columns (as in tests/flow-durable-button-run.test.mjs).
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
CREATE TABLE t.e(name text PRIMARY KEY,tenant uuid,acc uuid,platform text,conv uuid,msg uuid,mid text);
-- One inbound event = conversation + persisted inbound message + route='flow' claim.
-- p_msg_conv: the message is stored in ANOTHER conversation than the claim names
-- (only possible with a directly inserted claim row; both claim functions refuse it).
CREATE FUNCTION t.ev(p_name text,p_tenant uuid,p_acc uuid,p_conv uuid DEFAULT NULL,p_platform text DEFAULT 'instagram',
 p_msg_conv uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid:=p_conv; m uuid;
BEGIN
 IF c IS NULL THEN
  INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
  VALUES(gen_random_uuid(),p_tenant,p_acc,p_platform||':'||gen_random_uuid()) RETURNING id INTO c;
 END IF;
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
 VALUES(p_tenant,coalesce(p_msg_conv,c),'in','mid.'||p_name) RETURNING id INTO m;
 INSERT INTO public.automation_message_claims(tenant_id,channel_account_id,platform,provider_event_id,
  conversation_id,inbound_message_id,route)
 VALUES(p_tenant,p_acc,p_platform,'mid.'||p_name,c,m,'flow');
 INSERT INTO t.e VALUES(p_name,p_tenant,p_acc,p_platform,c,m,'mid.'||p_name);
END $f$;
ANALYZE;`;
const SR="service_role";
const Q_EFFECT=k=>`[{"kind":"question","idempotencyKey":"q.${k}","payload":{"kind":"question","text":"choose","inputMode":"buttons","choices":["prices","support"],"choiceIds":["prices","support"]}}]`;
const M_EFFECT=(k,text)=>`[{"kind":"message","idempotencyKey":"m.${k}","payload":{"kind":"message","text":"${text}"}}]`;
const L=v=>v===null?"NULL":`'${String(v).replace(/'/g,"''")}'`;
function beginSql(e,o={}){
 const a={tenant:e.tenant,acc:e.acc,conv:e.conv,msg:e.msg,mid:e.mid,flow:"buttons",rev:1,start:"start",next:"choose",
  step:1,status:"awaiting_input",vars:"{}",wake:null,effects:Q_EFFECT(e.name),...o};
 return `SELECT public.flow_begin_durable_run(${L(a.tenant)},${L(a.acc)},${L(a.conv)},${L(a.msg)},${L(a.mid)},`+
  `${L(a.flow)},${a.rev===null?"NULL":a.rev},${L(a.start)},${L(a.next)},${a.step===null?"NULL":a.step},${L(a.status)},`+
  `${a.vars===null?"NULL":L(a.vars)+"::jsonb"},${a.wake===null?"NULL":L(a.wake)+"::timestamptz"},${a.effects===null?"NULL":L(a.effects)+"::jsonb"})`;
}
function resumeSql(run,e,o={}){
 const a={tenant:e.tenant,run,mid:e.mid,msg:e.msg,expStep:1,expNode:"choose",next:"yes",step:2,status:"completed",
  vars:"{}",wake:null,effects:M_EFFECT(e.name,"prices text"),...o};
 return `SELECT public.flow_resume_button_run(${L(a.tenant)},${L(a.run)},${L(a.mid)},${L(a.msg)},`+
  `${a.expStep===null?"NULL":a.expStep},${L(a.expNode)},${L(a.next)},${a.step},${L(a.status)},`+
  `${a.vars===null?"NULL":L(a.vars)+"::jsonb"},${a.wake===null?"NULL":L(a.wake)+"::timestamptz"},${a.effects===null?"NULL":L(a.effects)+"::jsonb"})`;
}
const mk=(db,name,tenant=A,acc=ACC,conv=null,platform="instagram",msgConv=null)=>{
 ok(db,{sql:`SELECT t.ev('${name}','${tenant}','${acc}',${conv?`'${conv}'`:"NULL"},'${platform}',${msgConv?`'${msgConv}'`:"NULL"});`},`event ${name}`);
 return rows(db,`SELECT * FROM t.e WHERE name='${name}'`)[0];
};
const begin=(db,e,o)=>val(db,beginSql(e,o).replace(/^SELECT /,""),SR);
const resume=(db,run,e,o)=>val(db,resumeSql(run,e,o).replace(/^SELECT /,""),SR);
const count=(db,tbl,where="true")=>Number(val(db,`SELECT count(*) FROM public.${tbl} WHERE ${where}`));
const runRow=(db,run)=>rows(db,`SELECT run_status,current_node_id,step_count,variables,conversation_id,channel_account_id,provider_event_id
 FROM public.automation_flow_runs WHERE id='${run}'`)[0];
const hasFn=(db,sig)=>val(db,`SELECT to_regprocedure('${sig}') IS NOT NULL`);
const comment=(db,sig)=>val(db,`SELECT obj_description(to_regprocedure('${sig}'),'pg_proc')`);
const prosrc=(db,sig)=>val(db,`SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('${sig}')`);

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-button-guards-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+181)%20000);
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
 // c170: the chain up to 170000 with the 125000 bodies; g180: plus this migration.
 ok("postgres",{sql:"CREATE DATABASE c170 TEMPLATE base;"},"c170");
 ok("c170",{file:M125},"125000");
 for(const f of LATER)ok("c170",{file:f},f);
 // Proposal-installed variant of the same chain (production case).
 ok("postgres",{sql:"CREATE DATABASE p170 TEMPLATE base;"},"p170");
 ok("p170",{file:PROPOSAL},"proposal");
 for(const f of LATER)ok("p170",{file:f},f);
 ok("postgres",{sql:"CREATE DATABASE g180 TEMPLATE c170;"},"g180");
 ok("g180",{file:MIG},"180000");
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});
let clones=0;
function clone(prefix,template="g180"){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},`clone ${db}`);
 return db;
}

const FLAGS=[
 ["account is_active",`UPDATE public.channel_accounts SET is_active=%v WHERE id='${ACC}'`],
 ["account agent_enabled",`UPDATE public.channel_accounts SET agent_enabled=%v WHERE id='${ACC}'`],
 ["account auto_reply",`UPDATE public.channel_accounts SET auto_reply=%v WHERE id='${ACC}'`],
 ["tenant is_active",`UPDATE public.tenants SET is_active=%v WHERE id='${A}'`]];
const setFlag=(db,sql,v,label)=>ok(db,{sql:sql.replace("%v",v)},`${label}=${v}`);

test("(A) each live flag off at resume: false, nothing written, run still waiting; resumes after reactivation",{skip},()=>{
 for(const [label,sql] of FLAGS){
  const db=clone("flag");
  const e=mk(db,"f1");
  const run=begin(db,e);
  assert.match(String(run),/^[0-9a-f-]{36}$/,label);
  const waiting=runRow(db,run);
  const tap=mk(db,"f1tap",A,ACC,e.conv);
  setFlag(db,sql,"false",label);
  const before=fp(db);
  assert.equal(resume(db,run,tap),false,`${label} off: refused`);
  assert.equal(fp(db),before,`${label} off: schema and every row (runs, outbox, receipts, metrics, claims) unchanged`);
  assert.deepEqual(runRow(db,run),waiting,`${label}: run still awaiting_input at the same step/node/variables`);
  assert.equal(count(db,"automation_flow_event_receipts",`provider_event_id='${tap.mid}'`),0,`${label}: no receipt`);
  assert.equal(count(db,"automation_flow_outbox",`run_id='${run}'`),1,`${label}: no reply effect`);
  // A second tap while still off is refused the same way.
  const tap2=mk(db,"f1tap2",A,ACC,e.conv);const b2=fp(db);
  assert.equal(resume(db,run,tap2,{next:"no",effects:M_EFFECT("f1tap2","support text")}),false,label);
  assert.equal(fp(db),b2,label);
  // begin is refused by the same predicate (unchanged 125000 behaviour).
  const e2=mk(db,"f1new");const b3=fp(db);
  assert.equal(begin(db,e2),null,`${label} off: begin refused`);assert.equal(fp(db),b3,label);
  // Reactivation: the SAME run resumes with a new valid tap.
  setFlag(db,sql,"true",label);
  const tap3=mk(db,"f1tap3",A,ACC,e.conv);
  assert.equal(resume(db,run,tap3,{next:"no",effects:M_EFFECT("f1tap3","support text")}),true,`${label}: resumes after reactivation`);
  assert.deepEqual([runRow(db,run).run_status,runRow(db,run).current_node_id,runRow(db,run).step_count],["completed","no",2],label);
  assert.equal(count(db,"automation_flow_outbox",`run_id='${run}' AND effect_kind='message'`),1,label);
  assert.equal(count(db,"automation_flow_metrics",`run_id='${run}' AND event_key='button'`),1,label);
  // The earlier taps (refused, no receipt) remain usable only as stale taps: refused now.
  assert.equal(resume(db,run,tap),false,`${label}: stale tap on the completed run`);
 }
 // Differential: with the 125000 bodies the same off-flag resume succeeded.
 const old=clone("flag125","c170");
 const e=mk(old,"o1"),run=begin(old,e),tap=mk(old,"o1tap",A,ACC,e.conv);
 setFlag(old,FLAGS[2][1],"false","auto_reply");
 assert.equal(resume(old,run,tap),true,"125000 resumes with auto_reply off (the gap 180000 closes)");
});

test("(A) NULL flags: refused by resume exactly as by begin (NULL is not true); other tenant's flags are irrelevant",{skip},()=>{
 for(const [label,sql] of FLAGS){
  const db=clone("nullflag");
  const e=mk(db,"n1"),run=begin(db,e),tap=mk(db,"n1tap",A,ACC,e.conv),e2=mk(db,"n2");
  const [tbl,col]=label.startsWith("tenant")?["tenants","is_active"]:["channel_accounts",label.split(" ")[1]];
  ok(db,{sql:`ALTER TABLE public.${tbl} ALTER COLUMN ${col} DROP NOT NULL;`},"nullable");
  setFlag(db,sql,"NULL",label);
  const before=fp(db);
  assert.equal(begin(db,e2),null,`${label} NULL: begin refused`);
  assert.equal(resume(db,run,tap),false,`${label} NULL: resume refused`);
  assert.equal(fp(db),before,`${label} NULL: nothing written`);
  setFlag(db,sql,"true",label);
  assert.equal(resume(db,run,tap),true,`${label}: the same tap resumes once the flag is true`);
 }
 // Flags of another tenant/account never block this run.
 const db=clone("otherflags");
 const e=mk(db,"x1"),run=begin(db,e),tap=mk(db,"x1tap",A,ACC,e.conv);
 ok(db,{sql:`UPDATE public.tenants SET is_active=false WHERE id='${B}';
  UPDATE public.channel_accounts SET is_active=false,agent_enabled=false,auto_reply=false WHERE id IN('${ACC2}','${ACCB}');`},"others off");
 assert.equal(resume(db,run,tap),true);
});

test("(B) claim whose inbound message belongs to another conversation: begin and resume refused, no writes",{skip},()=>{
 for(const [tmpl,v] of [["g180","180000"],["c170","125000"]]){
  const db=clone(`conv${v}`,tmpl);
  const other=mk(db,"host");                      // a conversation of the same tenant/account
  const e=mk(db,"x",A,ACC,null,"instagram",other.conv); // claim names a new conversation, message stored in `other`
  let before=fp(db);
  const r=begin(db,e);
  if(v==="180000"){assert.equal(r,null,"begin refused");assert.equal(fp(db),before,"begin: nothing written");}
  else assert.match(String(r),/^[0-9a-f-]{36}$/,"125000 accepted the inconsistent claim (the gap 180000 closes)");
  // Resume: legitimate waiting run, tap claim names the run's conversation, message lives elsewhere.
  const s=mk(db,"s");const run=begin(db,s);
  assert.match(String(run),/^[0-9a-f-]{36}$/);
  const bad=mk(db,"stap",A,ACC,s.conv,"instagram",other.conv);
  before=fp(db);
  const rr=resume(db,run,bad);
  if(v==="180000"){
   assert.equal(rr,false,"resume refused");assert.equal(fp(db),before,"resume: nothing written");
   assert.equal(runRow(db,run).run_status,"awaiting_input");
   // Still resumable by a consistent tap.
   assert.equal(resume(db,run,mk(db,"stap2",A,ACC,s.conv)),true);
  } else assert.equal(rr,true,"125000 accepted the inconsistent tap");
 }
});

// Deterministic, uuid-free view of everything the two functions write.
const STATE=`SELECT jsonb_build_object(
 'runs',(SELECT jsonb_agg(jsonb_build_array(r.provider_event_id,r.tenant_id,r.channel_account_id,r.flow_key,r.publication_revision,
   r.platform,r.current_node_id,r.run_status,r.step_count,r.variables,r.wake_at IS NULL) ORDER BY r.provider_event_id)
  FROM public.automation_flow_runs r),
 'outbox',(SELECT jsonb_agg(jsonb_build_array(r.provider_event_id,o.tenant_id,o.idempotency_key,o.effect_kind,o.delivery_status,o.payload)
   ORDER BY r.provider_event_id,o.idempotency_key) FROM public.automation_flow_outbox o JOIN public.automation_flow_runs r ON r.id=o.run_id),
 'receipts',(SELECT jsonb_agg(jsonb_build_array(x.tenant_id,x.channel_account_id,x.platform,x.provider_event_id) ORDER BY x.provider_event_id)
  FROM public.automation_flow_event_receipts x),
 'metrics',(SELECT jsonb_agg(jsonb_build_array(r.provider_event_id,m.event_key) ORDER BY r.provider_event_id,m.event_key)
  FROM public.automation_flow_metrics m JOIN public.automation_flow_runs r ON r.id=m.run_id),
 'claims',(SELECT count(*) FROM public.automation_message_claims))`;
function scenarios(db){
 const out=[];const R=(label,v)=>out.push([label,v===null?null:typeof v==="string"&&/^[0-9a-f-]{36}$/.test(v)?"uuid":v]);
 const forged="99999999-9999-4999-8999-999999999999";
 // Happy paths: both branches, question -> question chain.
 for(const [n,branch,text] of [["y","yes","prices text"],["n","no","support text"]]){
  const e=mk(db,`h${n}`);const run=begin(db,e);R(`begin ${n}`,run);
  const tap=mk(db,`h${n}tap`,A,ACC,e.conv);
  R(`resume ${n}`,resume(db,run,tap,{next:branch,effects:M_EFFECT(tap.name,text)}));
  R(`replay ${n}`,resume(db,run,tap,{next:branch,effects:M_EFFECT(tap.name,text)}));
  R(`begin dup ${n}`,begin(db,e));
 }
 const c=mk(db,"chain");const crun=begin(db,c,{vars:'{"a":1}'});R("chain begin",crun);
 R("chain q",resume(db,crun,mk(db,"chaint1",A,ACC,c.conv),{next:"choose",step:2,status:"awaiting_input",vars:'{"a":2}',effects:Q_EFFECT("chain2")}));
 R("chain end",resume(db,crun,mk(db,"chaint2",A,ACC,c.conv),{expStep:2,next:"no",step:3,effects:M_EFFECT("chaint2","support text")}));
 R("sleeping",begin(db,mk(db,"sl"),{status:"sleeping",wake:"2030-01-01T00:00:00Z"}));
 // Refusals common to both versions.
 const e=mk(db,"i1"),eb=mk(db,"ib",B,ACCB),e2=mk(db,"i2",A,ACC2),efb=mk(db,"ifb",B,FBB,null,"facebook");
 for(const [label,o,ev] of [["cross-tenant",{tenant:B}],["foreign account",{acc:ACCB}],["other account",{acc:ACC2,flow:"other"}],
  ["foreign conversation",{conv:eb.conv}],["other conversation",{conv:e2.conv}],["forged inbound",{msg:forged}],
  ["inbound of another event",{msg:e2.msg}],["forged event",{mid:"mid.forged"}],["facebook claim",{flow:"bfb"},efb],
  ["flow of another account",{flow:"other"}],["unpublished revision",{rev:2}],["start not trigger",{start:"choose"}],
  ["NULL effects",{effects:null}],["step 0",{step:0}],["empty event",{mid:""}]])R(`begin ${label}`,begin(db,ev??e,o));
 const run=begin(db,e);R("begin i1",run);
 const tap=mk(db,"i1tap",A,ACC,e.conv),tapOther=mk(db,"i1other",A,ACC),tapB=mk(db,"ibtap",B,ACCB,eb.conv);
 for(const [label,r,t,o] of [["B resume",run,tapB,{tenant:B}],["B tenant A tap",run,tap,{tenant:B}],["unknown run",forged,tap],
  ["other conversation tap",run,tapOther],["other account tap",run,e2],["forged tap inbound",run,tap,{msg:forged}],
  ["tap inbound of another event",run,tap,{msg:tapOther.msg}],["unclaimed tap",run,tap,{mid:"mid.unclaimed"}],
  ["wrong step",run,tap,{expStep:0}],["wrong node",run,tap,{expNode:"yes"}],["NULL step",run,tap,{expStep:null}],
  ["NULL next",run,tap,{next:null}]])R(`resume ${label}`,resume(db,r,t,o));
 // Atomic rejections raise the same errors.
 for(const [label,o] of [["bad status",{status:"bogus"}],["effects not array",{effects:"{}"}]]){
  const r=psql(db,{sql:resumeSql(run,tap,o)+";",role:SR});R(`resume error ${label}`,[r.status,sqlState(r.stderr),/Button transition rejected/.test(r.stderr)]);
  const b=psql(db,{sql:beginSql(mk(db,`err${label.replace(/ /g,"")}`),o)+";",role:SR});
  R(`begin error ${label}`,[b.status,sqlState(b.stderr),/First durable step rejected/.test(b.stderr)]);
 }
 R("resume i1",resume(db,run,tap));
 R("stale",resume(db,run,mk(db,"i1stale",A,ACC,e.conv)));
 // Switch/activation refusals (unchanged).
 const w=mk(db,"w"),wrun=begin(db,w),wtap=mk(db,"wtap",A,ACC,w.conv);
 ok(db,{sql:"UPDATE public.automation_flow_global_switch SET enabled=false"},"off");R("global off",resume(db,wrun,wtap));
 ok(db,{sql:"UPDATE public.automation_flow_global_switch SET enabled=true"},"on");
 ok(db,{sql:`UPDATE public.automation_flow_tenant_switches SET production_approved=false WHERE tenant_id='${A}'`},"unapproved");
 R("unapproved",resume(db,wrun,wtap));
 ok(db,{sql:`UPDATE public.automation_flow_tenant_switches SET production_approved=true WHERE tenant_id='${A}'`},"approved");
 ok(db,{sql:`UPDATE public.automation_flow_activations SET is_active=false WHERE flow_key='buttons'`},"inactive");
 R("inactive",resume(db,wrun,wtap));
 ok(db,{sql:`UPDATE public.automation_flow_activations SET is_active=true WHERE flow_key='buttons'`},"active");
 R("w resume",resume(db,wrun,wtap));
 return {out,state:val(db,STATE)};
}

test("differential: legitimate and refused calls give identical results and side effects with 125000 and 180000 bodies",{skip},()=>{
 const a=scenarios(clone("d125","c170")),b=scenarios(clone("d180","g180")),p=scenarios(clone("dprop","p170"));
 assert.ok(a.out.length>45&&a.state.runs.length===6,`scenario coverage ${a.out.length} ${a.state.runs.length}`);
 assert.deepEqual(b.out,a.out,"same results");
 assert.deepEqual(b.state,a.state,"same runs, outbox effects, receipts, metrics, claims");
 assert.deepEqual(p.out,a.out,"proposal-installed bodies behave the same");
 assert.deepEqual(p.state,a.state);
});

test("duplicates, stale taps and concurrency still hold with the 180000 bodies",{skip},async()=>{
 const db=clone("dup");
 const e=mk(db,"d1");const run=begin(db,e);
 assert.equal(begin(db,e),null,"same provider event never starts twice");
 const tap=mk(db,"d1tap",A,ACC,e.conv);
 assert.equal(resume(db,run,tap),true);assert.equal(resume(db,run,tap),false,"replayed tap");
 const stale=mk(db,"d1stale",A,ACC,e.conv);const before=fp(db);
 assert.equal(resume(db,run,stale),false);assert.equal(resume(db,run,stale,{expStep:2,expNode:"yes"}),false);
 assert.equal(fp(db),before,"stale taps write nothing");
 const c=mk(db,"c1");
 const s1=psqlAsync(db,`SET ROLE ${SR};\nBEGIN;\n${beginSql(c)};\nSELECT pg_sleep(1.5);\nCOMMIT;\n`);
 await new Promise(r=>setTimeout(r,400));
 const s2=psqlAsync(db,`SET ROLE ${SR};\n${beginSql(c)};\n`);
 const [r1,r2]=await Promise.all([s1,s2]);
 assert.equal(r1.code,0,r1.err);assert.equal(r2.code,0,r2.err);
 const ids=[r1.out,r2.out].map(o=>(o.match(/[0-9a-f-]{36}/)??[null])[0]);
 assert.ok(ids[0]&&!ids[1],`exactly one winner: ${JSON.stringify([r1.out,r2.out])}`);
 const crun=ids[0];
 const t1=mk(db,"c1t1",A,ACC,c.conv),t2=mk(db,"c1t2",A,ACC,c.conv);
 const q1=psqlAsync(db,`SET ROLE ${SR};\nBEGIN;\n${resumeSql(crun,t1)};\nSELECT pg_sleep(1.5);\nCOMMIT;\n`);
 await new Promise(r=>setTimeout(r,400));
 const q2=psqlAsync(db,`SET ROLE ${SR};\n${resumeSql(crun,t2,{next:"no",effects:M_EFFECT("c1t2","support text")})};\n`);
 const [w1,w2]=await Promise.all([q1,q2]);
 assert.equal(w1.code,0,w1.err);assert.equal(w2.code,0,w2.err);
 assert.deepEqual([w1.out.split("\n")[0],w2.out.split("\n")[0]],["t","f"],"lock holder wins; the waiter re-checks and refuses");
 assert.equal(count(db,"automation_flow_outbox",`run_id='${crun}' AND effect_kind='message'`),1);
 assert.equal(count(db,"automation_flow_event_receipts",`provider_event_id='${t2.mid}'`),0,"loser leaves no receipt");
 // A flag switched off while a tap waits on the run lock: the waiter re-checks and refuses.
 const f=mk(db,"f1"),frun=begin(db,f),ft1=mk(db,"f1t1",A,ACC,f.conv);
 const h=psqlAsync(db,`BEGIN;\nSELECT 1 FROM public.automation_flow_runs WHERE id='${frun}' FOR UPDATE;\n`+
  `UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}';\nSELECT pg_sleep(1.5);\nCOMMIT;\n`);
 await new Promise(r=>setTimeout(r,400));
 const fb=fp(db,false);
 const wq=await psqlAsync(db,`SET ROLE ${SR};\n${resumeSql(frun,ft1)};\n`);
 assert.equal((await h).code,0);
 assert.equal(wq.code,0,wq.err);assert.equal(wq.out.split("\n")[0],"f","flag committed while waiting: refused");
 assert.equal(fp(db,false),fb);assert.equal(runRow(db,frun).run_status,"awaiting_input");
 assert.equal(count(db,"automation_flow_event_receipts",`provider_event_id='${ft1.mid}'`),0);
});

test("privileges and attributes unchanged: service_role only, SECURITY INVOKER, search_path pinned",{skip},()=>{
 const meta=db=>rows(db,`SELECT p.proname,p.prosecdef,p.proconfig,p.proacl::text AS acl,p.proargnames,p.provolatile,p.proisstrict,
  pg_get_function_identity_arguments(p.oid) AS args,pg_get_function_result(p.oid) AS res,
  (SELECT lanname FROM pg_language l WHERE l.oid=p.prolang) AS lang
  FROM pg_proc p WHERE p.oid IN('${BEGIN_SIG}'::regprocedure,'${RESUME_SIG}'::regprocedure) ORDER BY 1`);
 assert.deepEqual(meta("g180"),meta("c170"),"same ACL, signature, result, security, search_path, volatility");
 const db=clone("acl");
 for(const sig of [BEGIN_SIG,RESUME_SIG]){
  for(const role of ["anon","authenticated","public"])
   assert.equal(val(db,`SELECT has_function_privilege('${role}','${sig}','EXECUTE')`),false,`${role} ${sig}`);
  assert.equal(val(db,`SELECT has_function_privilege('service_role','${sig}','EXECUTE')`),true,sig);
  assert.equal(val(db,`SELECT prosecdef FROM pg_proc WHERE oid='${sig}'::regprocedure`),false);
  assert.deepEqual(val(db,`SELECT proconfig FROM pg_proc WHERE oid='${sig}'::regprocedure`),['search_path=""']);
 }
 const e=mk(db,"p1");
 for(const role of ["anon","authenticated"]){
  fails(db,beginSql(e)+";","42501",`${role} begin`,role);
  fails(db,resumeSql("99999999-9999-4999-8999-999999999999",e)+";","42501",`${role} resume`,role);
 }
 ok(db,{sql:`CREATE SCHEMA evil; GRANT USAGE ON SCHEMA evil TO service_role;
  CREATE TABLE evil.channel_accounts(id uuid); GRANT ALL ON evil.channel_accounts TO service_role;`},"evil");
 const run=begin(db,e);
 const r=psql(db,{sql:`SET search_path=evil,public;\n${resumeSql(run,mk(db,"p1tap",A,ACC,e.conv))};`,role:SR});
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim().split("\n")[0],"t","hostile schema in search_path is never used");
});

test("migration: idempotent, proposal-installed bodies, preflight refusals, never overwrites a differing body",{skip},()=>{
 // Markers recorded for the rollback.
 for(const sig of [BEGIN_SIG,RESUME_SIG]){
  assert.equal(comment("g180",sig),`${MARK} previous_comment=${JSON.stringify(MARK125)}`,sig);
  assert.equal(prosrc("g180",sig),sig===BEGIN_SIG?B180:R180,`${sig}: exact 180000 body`);
 }
 const db=clone("idem");
 const once=fp(db);
 const r=ok(db,{file:MIG},"re-apply");
 assert.equal((r.err.match(/already has the 20261029180000 definition \(marker=CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS\); left unchanged/g)??[]).length,2);
 assert.equal(fp(db),once,"re-apply changes nothing");
 // Over the proposal-installed functions (no marker).
 const p=clone("prop","p170");
 const pre=fp(p);
 ok(p,{file:MIG},"180000 over the proposal");
 for(const sig of [BEGIN_SIG,RESUME_SIG])assert.equal(comment(p,sig),`${MARK} previous_comment=null`,sig);
 ok(p,{file:MIG},"re-apply over the proposal");
 ok(p,{file:RB},"rollback over the proposal");
 assert.equal(fp(p),pre,"exact pre-180000 state: proposal bodies byte for byte, no comment, ACLs, index, data");
 // Whitespace-only variant of the 125000 body is the same normalized definition.
 const ws=clone("ws","c170");
 ok(ws,{sql:`${lit(M125,"v_begin_head","head")}$begin$${B125.replace(/\n /g,"\n\t ")}$begin$;`},"reindented");
 ok(ws,{file:MIG},"180000 accepts the reindented 125000 body");
 assert.equal(prosrc(ws,BEGIN_SIG),B180);
 // Refusals: nothing changes.
 const P=(sig,body)=>`${lit(M125,sig===BEGIN_SIG?"v_begin_head":"v_resume_head","head")}$x$${body}$x$;`;
 for(const [label,sql,re] of [
  ["different resume body",P(RESUME_SIG,"BEGIN RETURN true; END"),/Existing public\.flow_resume_button_run\(.*\) differs from both .*refusing to overwrite/],
  ["one-character change",P(BEGIN_SIG,B125.replace("NOT BETWEEN 1 AND 256","NOT BETWEEN 1 AND 255")),/flow_begin_durable_run.* differs from both/],
  ["SECURITY DEFINER",`ALTER FUNCTION ${RESUME_SIG} SECURITY DEFINER;`,/differs from both/],
  ["other search_path",`ALTER FUNCTION ${BEGIN_SIG} SET search_path=public;`,/differs from both/],
  ["foreign overload","CREATE FUNCTION public.flow_resume_button_run(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';",/Unrecognized overload of public\.flow_resume_button_run/],
  ["function missing",`DROP FUNCTION ${RESUME_SIG};`,/is missing; apply 20261029125000_flow_durable_button_run first/],
  ["marker on the 125000 body",`COMMENT ON FUNCTION ${BEGIN_SIG} IS '${MARK} previous_comment=null';`,/carries the 20261029180000 marker but not its body/],
  ["170000 missing",`COMMENT ON FUNCTION public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid) IS NULL;`,/apply 20261029170000_flow_canary_claim_durable first/],
  ["170000 table marker",`COMMENT ON TABLE public.automation_flow_canary_claims IS NULL;`,/apply 20261029170000_flow_canary_claim_durable first/],
  ["160000 missing",`COMMENT ON FUNCTION public.flow_channel_temporarily_paused(uuid,uuid) IS 'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME';`,/apply 20261029160000_flow_credits_pause first/],
  ["150000 missing",`COMMENT ON FUNCTION public.flow_end_stale_paused_runs(integer,integer) IS NULL;`,/apply 20261029150000_flow_takeover_resume first/],
  ["140000 missing",`COMMENT ON FUNCTION public.flow_claim_outbox_ai(uuid,uuid,integer,integer) IS NULL;`,/apply 20261029140000_flow_outbox_ai_retry first/],
  ["130000 missing",`COMMENT ON FUNCTION public.flow_cancel_run(uuid,uuid,text,text) IS NULL;`,/apply 20261029130000_flow_run_lifecycle first/],
  ["225000 missing",`COMMENT ON FUNCTION public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid) IS NULL;`,/apply 20261028225000_flow_runtime_advance first/]]){
  const d=clone("pf","c170");
  ok(d,{sql},label);
  refused(d,MIG,re,label);
 }
 // Without 170000 at all (only 125000): refused.
 const only=clone("only125","base");ok(only,{file:M125},"125000");
 refused(only,MIG,/apply 20261029130000_flow_run_lifecycle first/,"chain missing");
});

test("rollback: exact 125000 bodies and markers restored, ownership, order 180 -> 170 -> ... -> 125",{skip},()=>{
 const db=clone("rb");
 // Wrong order: every older rollback refuses while the 180000 functions exist.
 for(const f of OLDER_RB)refused(db,f,/roll back 20261029180000_flow_durable_button_run_guards first/,f);
 // Data written through the 180000 bodies is kept by the rollback.
 const e=mk(db,"k1");const run=begin(db,e);
 const pre=fp("c170",false);
 const data=val(db,"SELECT count(*) FROM public.automation_flow_runs");
 const r=ok(db,{file:RB},"180000 rollback");
 assert.equal((r.err.match(/restored to the 20261029125000 body \(marker=CREATED_BY_20261029125000_FLOW_DURABLE_BUTTON_RUN\)/g)??[]).length,2);
 assert.equal(fp(db,false),pre,"schema identical to the 125000..170000 state (bodies, comments, ACLs)");
 for(const sig of [BEGIN_SIG,RESUME_SIG]){
  assert.equal(prosrc(db,sig),sig===BEGIN_SIG?B125:R125,`${sig}: 125000 body byte for byte`);
  assert.equal(comment(db,sig),MARK125);
 }
 assert.equal(val(db,"SELECT count(*) FROM public.automation_flow_runs"),data,"no row touched");
 assert.equal(runRow(db,run).run_status,"awaiting_input");
 // Second rollback: not installed.
 refused(db,RB,/20261029180000_flow_durable_button_run_guards not installed; nothing to roll back/,"rollback twice");
 // Re-apply after rollback reproduces the 180000 schema.
 ok(db,{file:MIG},"re-apply");assert.equal(fp(db,false),fp("g180",false));
 // Full order: 180 -> 170 -> 160 -> 150 -> 140 -> 130 -> 125.
 ok(db,{file:RB},"180000 rollback again");
 for(const f of OLDER_RB)ok(db,{file:f,env:{PGOPTIONS:"-c flow.rollback_170000=discard-canary-data"}},f);
 assert.equal(hasFn(db,BEGIN_SIG)||hasFn(db,RESUME_SIG),false,"125000 rollback dropped its functions last");
 // Ownership: a tampered marked function is refused; an unmarked one is left alone.
 const t=clone("rbt");
 ok(t,{sql:`${lit(M125,"v_resume_head","head")}$x$BEGIN RETURN true; END$x$;`},"tamper");
 refused(t,RB,/carries the marker but not the 20261029180000 body/,"tampered marked function");
 const u=clone("rbu");
 ok(u,{sql:`COMMENT ON FUNCTION ${BEGIN_SIG} IS 'operator note';`},"unmark begin");
 const ub=prosrc(u,BEGIN_SIG);
 const ur=ok(u,{file:RB},"rollback with one owned function");
 assert.match(ur.err,/flow_begin_durable_run.* does not carry the 20261029180000 marker \(marker=operator note\); left in place/);
 assert.equal(prosrc(u,BEGIN_SIG),ub,"unowned function untouched");assert.equal(comment(u,BEGIN_SIG),"operator note");
 assert.equal(prosrc(u,RESUME_SIG),R125);assert.equal(comment(u,RESUME_SIG),MARK125);
});
