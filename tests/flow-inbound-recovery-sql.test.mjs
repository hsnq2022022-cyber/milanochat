// 20261029360000_flow_inbound_recovery (B-3/B-4) against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards), built like
// tests/flow-inbound-retry-keyword-start-sql.test.mjs: repo fixture chain,
// migrations 20261028220000 .. 20261029300000, the production
// flow_claim_inbound body, 330000, 340000, then 360000. Never connects to any
// remote host; inherited PG* variables are stripped. Static checks always run.
// Run: node --test tests/flow-inbound-recovery-sql.test.mjs
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const M="supabase/migrations/";
const R="supabase/rollbacks/";
const REC=M+"20261029360000_flow_inbound_recovery.sql";
const REC_RB=R+"20261029360000_flow_inbound_recovery.rollback.sql";
const RETRY=M+"20261029340000_flow_inbound_routing_retry.sql";
const MIG330=M+"20261029330000_flow_claim_begin_durable_run.sql";
const PROD_CLAIM="tests/sql/fixtures/production-flow-claim-inbound.sql";
const LEASE_SIG="public.flow_inbound_recovery_lease(integer,integer,integer,integer,integer,uuid)";
const FINISH_SIG="public.flow_inbound_recovery_finish(uuid,uuid,uuid,text,text,integer)";
const MARK="CREATED_BY_20261029360000_FLOW_INBOUND_RECOVERY";
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
test("static: bounded transactions, marker, pinned body md5s in migration AND rollback, additive only",()=>{
 for(const f of [REC,REC_RB]){
  const s=src(f);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
  assert.match(s,/\nCOMMIT;\n$/,f);
  assert.ok(s.includes(MARK),f);
 }
 const m=src(REC),rb=src(REC_RB);
 const L=md5(norm(between(m,"AS $lease$","$lease$"))),F=md5(norm(between(m,"AS $finish$","$finish$")));
 assert.equal(between(m,"v_lease_md5 constant text := '","'"),L);
 assert.equal(between(m,"v_finish_md5 constant text := '","'"),F);
 assert.ok(rb.includes(`'${L}'`)&&rb.includes(`'${F}'`),"rollback pins the same bodies");
 const code=noComments(m);
 // Never touches existing objects: no DROP/ALTER of existing tables, no DELETE/TRUNCATE,
 // UPDATE only of its own table; no billing / claim function replaced.
 assert.doesNotMatch(code,/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\b|\bALTER TABLE public\.(?!automation_inbound_recovery)/);
 assert.doesNotMatch(code,/\bUPDATE public\.(?!automation_inbound_recovery\b)/);
 assert.doesNotMatch(code,/flow_claim_inbound|flow_begin_durable_run|consume_|credits_remaining/);
 // RLS on, service_role only, no text payload columns.
 assert.match(code,/automation_inbound_recovery_tenants ENABLE ROW LEVEL SECURITY/);
 assert.match(code,/automation_inbound_recovery ENABLE ROW LEVEL SECURITY/);
 assert.match(code,/GRANT SELECT ON TABLE public\.automation_inbound_recovery_tenants TO service_role/);
 // grantees only (case-sensitive: the schema name "public." is not the PUBLIC role)
 assert.doesNotMatch(code,/GRANT[^;]*\bTO\s+[^;]*\b(anon|authenticated|PUBLIC)\b[^;]*;/);
 assert.match(code,/least\(p_max_age_hours,48\)/,"48 hour hard cap in SQL");
 assert.match(code,/FOR UPDATE OF x SKIP LOCKED/);
 assert.match(code,/enabled boolean NOT NULL DEFAULT false/,"opt-in default OFF");
 assert.match(rb,/flow\.inbound_recovery_rollback_ack/);
});

// ---------------------------------------------------------- live cluster
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
const FP=(data)=>`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||
  coalesce(p.proacl::text,'')||':'||coalesce(array_to_string(p.proconfig,','),'')
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')||':'||c.relrowsecurity
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace='public'::regnamespace
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
const ACC="11111111-1111-4111-8111-111111111111",ACCB="22222222-2222-4222-8222-222222222222";
const LIVE=`
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN business_name text NOT NULL DEFAULT 'Test Store';
ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,ADD COLUMN auto_reply boolean NOT NULL DEFAULT true,
 ADD COLUMN external_id text,ADD COLUMN access_token_encrypted text;
ALTER TABLE public.conversations ADD COLUMN transferred boolean NOT NULL DEFAULT false,
 ADD COLUMN auto_paused_reason text,ADD COLUMN human_agent_expires_at timestamptz;
ALTER TABLE public.messages ADD COLUMN body_encrypted text,ADD COLUMN external_message_id text,
 ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.automation_flow_tenant_switches
 ADD COLUMN production_approved boolean NOT NULL DEFAULT false;`;
const CHAIN=["tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
 "tests/sql/flow-exclusive-claim-bootstrap.sql","@LIVE",
 M+"20261028220000_webhook_exclusive_claim.sql",M+"20261028224000_delivery_attempts.sql",
 M+"20261028225000_flow_runtime_advance.sql",M+"20261028226000_flow_outbox_delivery_attempts.sql",
 "tests/sql/flow-staff-membership-bootstrap.sql",M+"20261028227000_tenant_staff_memberships.sql",
 M+"20261028228000_flow_internal_actions.sql",...CHAIN125_300];
// Test helpers live in schema t (owner only). ev(): a persisted inbound event
// `age` old (no text: body is an opaque test marker, never customer data).
const SEED=`
CREATE SCHEMA t;
CREATE FUNCTION t.ev(p_tenant uuid,p_acc uuid,p_mid text,p_age interval) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE c uuid; m uuid;
BEGIN
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(gen_random_uuid(),p_tenant,p_acc,'instagram:'||gen_random_uuid()) RETURNING id INTO c;
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id,body_encrypted,created_at)
 VALUES(p_tenant,c,'in',p_mid,'enc:v1:test',now()-p_age) RETURNING id INTO m;
 RETURN m;
END $f$;
CREATE FUNCTION t.optin(p_tenant uuid,p_enabled boolean,p_since interval) RETURNS void LANGUAGE sql AS $f$
 INSERT INTO public.automation_inbound_recovery_tenants(tenant_id,enabled,enabled_at,approved_by)
 VALUES(p_tenant,p_enabled,CASE WHEN p_enabled THEN now()-p_since END,'test')
 ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,enabled_at=EXCLUDED.enabled_at;
$f$;`;
const SR="service_role";
const lease=(db,{limit=5,age=48,attempts=5,grace=60,tenant=null}={})=>
 rows(db,`SELECT tenant_id,inbound_message_id,lease_token,attempts FROM public.flow_inbound_recovery_lease(${limit},120,${age},${attempts},${grace},${tenant?`'${tenant}'`:"NULL"})`,SR);
const finish=(db,l,result,reason="t",max=5)=>
 val(db,`public.flow_inbound_recovery_finish('${l.tenant_id}','${l.inbound_message_id}','${l.lease_token}','${result}','${reason}',${max})`,SR);
const rec=(db,id)=>rows(db,`SELECT status,reason,attempts,round(extract(epoch FROM next_attempt_at-now()))::int AS wait_s,
 lease_token IS NOT NULL AS leased FROM public.automation_inbound_recovery WHERE inbound_message_id='${id}'`)[0];
const ev=(db,tenant,acc,mid,age="10 minutes")=>val(db,`t.ev('${tenant}','${acc}','${mid}','${age}')`);
const optin=(db,tenant,on=true,since="1 day")=>ok(db,{sql:`SELECT t.optin('${tenant}',${on},'${since}');`},"optin");

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-recovery-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+360)%20000);
 let r=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(r.status,0,r.stderr);
 r=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off`,"start"]);
 assert.equal(r.status,0,r.stderr+r.stdout);
 started=true;
 ok("postgres",{sql:"CREATE DATABASE base;"},"createdb");
 ok("base",{sql:src("tests/sql/fixtures/flow-live-shape-bootstrap.sql")},"live shape");
 for(const f of CHAIN)ok("base",f==="@LIVE"?{sql:LIVE}:{file:f},f);
 ok("base",{file:PROD_CLAIM},"production flow_claim_inbound");
 ok("base",{file:MIG330},"330000");
 ok("base",{file:RETRY},"340000");
 ok("postgres",{sql:"CREATE DATABASE g360 TEMPLATE base;"},"g360");
 ok("g360",{file:REC},"360000");
 ok("g360",{sql:SEED},"seed");
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});
let clones=0;
function clone(prefix,template="g360"){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},`clone ${db}`);
 return db;
}
const bodyMd5=(db,sig)=>val(db,`SELECT md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))) FROM pg_proc WHERE oid='${sig}'::regprocedure`);

test("360000 installed: pinned bodies match; RLS on; anon/authenticated have no access; service_role cannot write opt-ins",{skip},()=>{
 const m=src(REC);
 assert.equal(bodyMd5("g360",LEASE_SIG),between(m,"v_lease_md5 constant text := '","'"));
 assert.equal(bodyMd5("g360",FINISH_SIG),between(m,"v_finish_md5 constant text := '","'"));
 for(const t of ["automation_inbound_recovery","automation_inbound_recovery_tenants"])
  assert.equal(val("g360",`SELECT relrowsecurity FROM pg_class WHERE oid='public.${t}'::regclass`),true,t);
 for(const role of ["anon","authenticated"]){
  for(const sig of [LEASE_SIG,FINISH_SIG])
   assert.equal(val("g360",`has_function_privilege('${role}','${sig}','EXECUTE')`),false,role+sig);
  for(const t of ["automation_inbound_recovery","automation_inbound_recovery_tenants","automation_inbound_recovery_status"])
   assert.equal(val("g360",`has_table_privilege('${role}','public.${t}','SELECT')`),false,role+t);
 }
 assert.equal(val("g360",`has_table_privilege('service_role','public.automation_inbound_recovery_tenants','INSERT')`),false);
 // no text payload: columns are ids, counters, times and a reason code only
 const cols=rows("g360",`SELECT attname,format_type(atttypid,atttypmod) AS t FROM pg_attribute
  WHERE attrelid='public.automation_inbound_recovery'::regclass AND attnum>0 AND NOT attisdropped`);
 assert.deepEqual(cols.filter(c=>c.t==="text").map(c=>c.attname).sort(),["reason","status"]);
});

test("opt-in is DEFAULT OFF: no row / enabled=false -> nothing discovered or leased; history before opt-in never replayed",{skip},()=>{
 const db=clone("optin");
 const m1=ev(db,A,ACC,"mid.o1");
 assert.deepEqual(lease(db),[],"no opt-in row");
 optin(db,A,false);
 assert.deepEqual(lease(db),[],"enabled=false");
 assert.equal(val(db,"SELECT count(*)::int FROM public.automation_inbound_recovery"),0,"nothing even recorded");
 optin(db,A,true,"5 minutes");   // opted in AFTER m1 (10 minutes old)
 assert.deepEqual(lease(db),[],"messages before the opt-in time are never recovered");
 optin(db,A,true,"1 day");
 const l=lease(db);
 assert.deepEqual(l.map(x=>x.inbound_message_id),[m1]);
 assert.equal(l[0].attempts,1);
});

test("discovery: claimed events, grace window, resolved/exhausted routing retries and outbound rows are excluded",{skip},()=>{
 const db=clone("disc");
 optin(db,A,true);
 const claimed=ev(db,A,ACC,"mid.c1");
 ok(db,{sql:`INSERT INTO public.automation_message_claims(tenant_id,channel_account_id,platform,provider_event_id,conversation_id,inbound_message_id,route,outgoing_message_id)
  SELECT tenant_id,'${ACC}','instagram',wa_message_id,conversation_id,id,'legacy_ai',gen_random_uuid() FROM public.messages WHERE id='${claimed}';`},"claim");
 const young=ev(db,A,ACC,"mid.y1","5 seconds");
 const old=ev(db,A,ACC,"mid.old","49 hours");
 const free=ev(db,A,ACC,"mid.f1");
 ok(db,{sql:`INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id,created_at)
  SELECT tenant_id,conversation_id,'out','mid.out1',now()-interval '10 minutes' FROM public.messages WHERE id='${free}';`},"outbound");
 const got=lease(db).map(x=>x.inbound_message_id);
 assert.deepEqual(got,[free]);
 for(const x of [claimed,young,old])assert.ok(!got.includes(x));
 // caller asking for 1000 hours is clamped to 48
 assert.deepEqual(lease(db,{age:1000}),[],"49h old event never discovered");
});

test("lease race: two concurrent sweepers never receive the same row (FOR UPDATE SKIP LOCKED)",{skip},async()=>{
 const db=clone("race");
 optin(db,A,true);
 const ids=[];for(let i=0;i<6;i++)ids.push(ev(db,A,ACC,"mid.r"+i));
 const q=`BEGIN; SET ROLE service_role;
  SELECT '@@'||inbound_message_id FROM public.flow_inbound_recovery_lease(3,120,48,5,60,NULL);
  SELECT pg_sleep(0.6); COMMIT;`;
 const [a,b]=await Promise.all([psqlAsync(db,q),psqlAsync(db,q)]);
 assert.equal(a.code,0,a.err);assert.equal(b.code,0,b.err);
 const pick=r=>r.out.split("\n").filter(l=>l.startsWith("@@")).map(l=>l.slice(2));
 const all=[...pick(a),...pick(b)];
 assert.equal(new Set(all).size,all.length,"no row leased twice: "+all.join(","));
 assert.ok(all.length>=3&&all.length<=6);
 assert.ok(all.every(x=>ids.includes(x)));
 // an unexpired lease is never handed out again
 const again=lease(db,{limit:10}).map(x=>x.inbound_message_id);
 assert.ok(again.every(x=>!all.includes(x)),"leased rows not re-leased before expiry");
});

test("bounded attempts + backoff 1m/5m/15m/60m; then exhausted (attempts); lease token checked",{skip},()=>{
 const db=clone("backoff");
 optin(db,A,true);
 const id=ev(db,A,ACC,"mid.b1");
 const waits=[];
 for(let n=1;n<=5;n++){
  ok(db,{sql:`UPDATE public.automation_inbound_recovery SET next_attempt_at=now() WHERE inbound_message_id='${id}';`},"due");
  const l=lease(db,{attempts:5});
  assert.equal(l.length,1,"attempt "+n);
  assert.equal(l[0].attempts,n);
  // a wrong token never finishes it
  assert.equal(finish(db,{...l[0],lease_token:"99999999-9999-4999-8999-999999999999"},"retry"),null);
  const st=finish(db,l[0],"retry","routing_unknown",5);
  if(n<5){assert.equal(st,"waiting");waits.push(rec(db,id).wait_s);}
  else assert.equal(st,"exhausted");
 }
 assert.deepEqual(waits.map(w=>Math.round(w/60)),[1,5,15,60]);
 const r=rec(db,id);
 assert.equal(r.status,"exhausted");assert.equal(r.reason,"attempts");
 ok(db,{sql:`UPDATE public.automation_inbound_recovery SET next_attempt_at=now() WHERE inbound_message_id='${id}';`},"due");
 assert.deepEqual(lease(db),[],"exhausted is terminal");
 // invalid finish arguments write nothing
 assert.equal(val(db,`public.flow_inbound_recovery_finish('${A}','${id}',gen_random_uuid(),'bogus','x',5)`,SR),null);
 assert.equal(val(db,`public.flow_inbound_recovery_finish('${A}','${id}',gen_random_uuid(),'retry','Bad Reason',5)`,SR),null);
});

test("48 hour cap: an aged waiting row is exhausted (expired) at lease time and at finish time",{skip},()=>{
 const db=clone("cap");
 optin(db,A,true,"3 days");
 const id=ev(db,A,ACC,"mid.cap","47 hours");
 const l=lease(db);
 assert.equal(l.length,1,"47h old: still recoverable");
 // the message ages past 48h while leased -> a retry finish exhausts it
 ok(db,{sql:`UPDATE public.automation_inbound_recovery SET message_created_at=now()-interval '49 hours' WHERE inbound_message_id='${id}';`},"age");
 assert.equal(finish(db,l[0],"retry"),"exhausted");
 assert.equal(rec(db,id).reason,"expired");
 // a waiting row that ages past the cap is exhausted at lease time, never returned
 const id2=ev(db,A,ACC,"mid.cap2","47 hours");
 const l2=lease(db);assert.equal(l2.length,1);
 assert.equal(finish(db,l2[0],"retry"),"waiting");
 ok(db,{sql:`UPDATE public.automation_inbound_recovery SET message_created_at=now()-interval '49 hours',next_attempt_at=now() WHERE inbound_message_id='${id2}';`},"age2");
 assert.deepEqual(lease(db,{age:1000}),[],"cap is clamped in SQL even when the caller asks for more");
 assert.equal(rec(db,id2).status,"exhausted");assert.equal(rec(db,id2).reason,"expired");
});

test("claim appearing after discovery (live webhook won) -> resolved 'claimed', never leased",{skip},()=>{
 const db=clone("claimed");
 optin(db,A,true);
 const id=ev(db,A,ACC,"mid.w1");
 const l=lease(db);assert.equal(l.length,1);
 assert.equal(finish(db,l[0],"retry"),"waiting");
 ok(db,{sql:`INSERT INTO public.automation_message_claims(tenant_id,channel_account_id,platform,provider_event_id,conversation_id,inbound_message_id,route,outgoing_message_id)
  SELECT tenant_id,'${ACC}','instagram',wa_message_id,conversation_id,id,'legacy_ai',gen_random_uuid() FROM public.messages WHERE id='${id}';
  UPDATE public.automation_inbound_recovery SET next_attempt_at=now() WHERE inbound_message_id='${id}';`},"webhook claim");
 assert.deepEqual(lease(db),[]);
 assert.deepEqual([rec(db,id).status,rec(db,id).reason],["resolved","claimed"]);
});

test("tenant isolation: a tenant-scoped sweep never touches another tenant; B not opted in is never swept",{skip},()=>{
 const db=clone("iso");
 optin(db,A,true);
 const a1=ev(db,A,ACC,"mid.ia1");
 const b1=ev(db,B,ACCB,"mid.ib1");
 assert.deepEqual(lease(db,{tenant:B}),[],"B not opted in");
 optin(db,B,true);
 const onlyA=lease(db,{tenant:A});
 assert.deepEqual(onlyA.map(x=>[x.tenant_id,x.inbound_message_id]),[[A,a1]]);
 assert.equal(rec(db,b1)?.leased??false,false,"B's event not leased by A's sweep");
 // finishing with the wrong tenant does nothing
 assert.equal(val(db,`public.flow_inbound_recovery_finish('${B}','${a1}','${onlyA[0].lease_token}','resolved','x',5)`,SR),null);
 assert.equal(rec(db,a1).leased,true);
 const onlyB=lease(db,{tenant:B});
 assert.deepEqual(onlyB.map(x=>[x.tenant_id,x.inbound_message_id]),[[B,b1]]);
 // owner status view: metadata only
 const v=rows(db,"SELECT * FROM public.automation_inbound_recovery_status ORDER BY tenant_id",SR);
 assert.deepEqual(Object.keys(v[0]).sort(),["events","last_updated_at","max_attempts","oldest_message_at","reason","status","tenant_id"]);
});

test("re-apply idempotent; foreign body / unmarked table refused; rollback guards (in-flight ack) and exact restore",{skip},()=>{
 const db=clone("rb");
 const before=fp(db);
 ok(db,{file:REC},"re-apply");
 assert.equal(fp(db),before,"re-apply changes nothing");
 // foreign body under the marker
 const f=clone("foreign");
 ok(f,{sql:`CREATE OR REPLACE FUNCTION public.flow_inbound_recovery_finish(p_tenant uuid,p_inbound uuid,p_token uuid,p_result text,p_reason text,p_max_attempts integer)
  RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $x$ BEGIN RETURN 'resolved'; END $x$;`},"foreign body");
 refused(f,REC,/carries the marker but not this migration's body/,"migration over a foreign body");
 refused(f,REC_RB,/marked but its body is not the 20261029360000 definition/,"rollback over a foreign body");
 // unmarked table of the same name
 const u=clone("unmarked","base");
 ok(u,{sql:"CREATE TABLE public.automation_inbound_recovery(x int);"},"squat");
 refused(u,REC,/exists without marker/,"migration over an unmarked table");
 // in-flight lease: refused without the explicit ack
 optin(db,A,true);
 ev(db,A,ACC,"mid.rb1");
 assert.equal(lease(db).length,1);
 refused(db,REC_RB,/in-flight recovery leases exist/,"rollback with an in-flight lease");
 ok(db,{file:REC_RB,env:{PGOPTIONS:"-c flow.inbound_recovery_rollback_ack=drop_inflight_leases"}},"rollback with ack");
 for(const t of ["automation_inbound_recovery","automation_inbound_recovery_tenants","automation_inbound_recovery_status"])
  assert.equal(val(db,`to_regclass('public.${t}') IS NULL`),true,t);
 for(const sig of [LEASE_SIG,FINISH_SIG])assert.equal(val(db,`to_regprocedure('${sig}') IS NULL`),true,sig);
 // schema public equals the pre-360000 template exactly (fingerprint covers schema public only)
 assert.equal(fp(db,false),fp("base",false),"rollback restores the exact pre-360000 schema");
 // rollback twice: refused (nothing to roll back), no change
 refused(db,REC_RB,/not installed; nothing to roll back/,"second rollback");
 // re-apply after rollback works
 ok(db,{file:REC},"re-apply after rollback");
});
