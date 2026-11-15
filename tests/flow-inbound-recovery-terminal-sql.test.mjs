// 20261029360000 flow_inbound_recovery_live_resolved (LIVE deliberate no-reply
// exits -> terminal 'resolved' recovery row) against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards), built exactly like
// tests/flow-inbound-recovery-sql.test.mjs. Never connects to any remote host;
// inherited PG* variables are stripped. Static checks always run.
// Run: node --test tests/flow-inbound-recovery-terminal-sql.test.mjs
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const M="supabase/migrations/";
const REC=M+"20261029360000_flow_inbound_recovery.sql";
const REC_RB="supabase/rollbacks/20261029360000_flow_inbound_recovery.rollback.sql";
const LIVE_SIG="public.flow_inbound_recovery_live_resolved(uuid,uuid,text,text,uuid,uuid,text)";
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

test("static: live_resolved body pinned in migration AND rollback; insert-only; service_role only; rollback drops it",()=>{
 const m=src(REC),rb=src(REC_RB);
 const body=between(m,"AS $live$","$live$");
 const L=md5(norm(body));
 assert.equal(between(m,"v_live_md5 constant text := '","'"),L);
 assert.ok(rb.includes(`'${L}'`),"rollback pins the same body");
 assert.match(rb,/DROP FUNCTION public\.flow_inbound_recovery_live_resolved\(uuid,uuid,text,text,uuid,uuid,text\);/);
 const code=noComments(body);
 assert.doesNotMatch(code,/\bUPDATE\b|\bDELETE\b/,"never changes an existing row");
 assert.match(code,/ON CONFLICT ON CONSTRAINT automation_inbound_recovery_pkey DO NOTHING/);
 assert.match(code,/'resolved'/);
 assert.doesNotMatch(code,/credits_remaining|consume_|flow_claim_inbound/);
 const all=noComments(m);
 assert.match(all,/REVOKE ALL ON FUNCTION public\.flow_inbound_recovery_live_resolved\(uuid,uuid,text,text,uuid,uuid,text\)\n FROM PUBLIC,anon,authenticated;/);
 assert.match(all,/GRANT EXECUTE ON FUNCTION public\.flow_inbound_recovery_live_resolved\(uuid,uuid,text,text,uuid,uuid,text\)\n TO service_role;/);
 assert.ok(m.includes(MARK));
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
function psql(db,{file,sql,role}={}){
 const a=pargs(db);
 if(file)a.push("-f",file);
 const input=sql===undefined?undefined:(role?`SET ROLE ${role};\n`:"")+sql;
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input,env:clientEnv(),maxBuffer:1<<26});
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
// t.ev(): a persisted inbound event `age` old (opaque test body, never customer data).
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
const lease=(db,{grace=60}={})=>
 rows(db,`SELECT tenant_id,inbound_message_id FROM public.flow_inbound_recovery_lease(10,120,48,5,${grace},NULL)`,SR);
const rec=(db,id)=>rows(db,`SELECT status,reason,attempts,lease_token IS NOT NULL AS leased,finished_at IS NOT NULL AS finished,
 message_created_at=(SELECT created_at FROM public.messages WHERE id='${id}') AS created_ok
 FROM public.automation_inbound_recovery WHERE inbound_message_id='${id}'`)[0];
const ev=(db,tenant,acc,mid,age="0 seconds")=>val(db,`t.ev('${tenant}','${acc}','${mid}','${age}')`);
const optin=(db,tenant,on=true,since="1 day")=>ok(db,{sql:`SELECT t.optin('${tenant}',${on},'${since}');`},"optin");
const ctx=(db,id)=>rows(db,`SELECT m.tenant_id,c.account_id,m.wa_message_id,m.conversation_id FROM public.messages m
 JOIN public.conversations c ON c.id=m.conversation_id WHERE m.id='${id}'`)[0];
/** The live exit: same argument shape as inboundRecovery.ts markLiveNoReply. */
const mark=(db,id,reason,over={})=>{
 const c={...ctx(db,id),platform:"instagram",inbound:id,...over};
 return val(db,`public.flow_inbound_recovery_live_resolved('${c.tenant_id}','${c.account_id}','${c.platform}',
  '${c.wa_message_id}','${c.conversation_id}','${c.inbound}','${reason}')`,SR);
};
/** The live webhook ran long ago: move the message past the discovery grace. */
const age=(db,id,a="10 minutes")=>ok(db,{sql:`UPDATE public.messages SET created_at=now()-interval '${a}' WHERE id='${id}';`},"age");

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-recovery-term-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+361)%20000);
 let r=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(r.status,0,r.stderr);
 r=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off`,"start"]);
 assert.equal(r.status,0,r.stderr+r.stdout);
 started=true;
 ok("postgres",{sql:"CREATE DATABASE base;"},"createdb");
 ok("base",{sql:src("tests/sql/fixtures/flow-live-shape-bootstrap.sql")},"live shape");
 for(const f of CHAIN)ok("base",f==="@LIVE"?{sql:LIVE}:{file:f},f);
 ok("base",{file:"tests/sql/fixtures/production-flow-claim-inbound.sql"},"production flow_claim_inbound");
 ok("base",{file:M+"20261029330000_flow_claim_begin_durable_run.sql"},"330000");
 ok("base",{file:M+"20261029340000_flow_inbound_routing_retry.sql"},"340000");
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
function clone(prefix){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE g360;`},`clone ${db}`);
 return db;
}

test("installed: pinned body matches; anon/authenticated cannot execute; service_role can",{skip},()=>{
 const m=src(REC);
 assert.equal(val("g360",`SELECT md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))) FROM pg_proc WHERE oid='${LIVE_SIG}'::regprocedure`),
  between(m,"v_live_md5 constant text := '","'"));
 assert.equal(val("g360",`obj_description('${LIVE_SIG}'::regprocedure,'pg_proc')`),MARK);
 for(const role of ["anon","authenticated"])
  assert.equal(val("g360",`has_function_privilege('${role}','${LIVE_SIG}','EXECUTE')`),false,role);
 assert.equal(val("g360",`has_function_privilege('service_role','${LIVE_SIG}','EXECUTE')`),true);
});

for(const [label,reason,clear] of [
 ["(a) auto reply disabled","live_auto_reply_off",`UPDATE public.channel_accounts SET auto_reply=true,agent_enabled=true;`],
 ["(b) credits exhausted","live_no_credits",`UPDATE public.tenants SET credits_remaining=100; UPDATE public.conversations SET auto_paused_reason=NULL;`],
 ["(b') credits paused","live_credits_paused",`UPDATE public.conversations SET auto_paused_reason=NULL;`],
 ["human takeover","live_human_takeover",`UPDATE public.conversations SET transferred=false;`],
]){
 test(`${label}: the live marker makes discovery/lease skip the event permanently, even after the condition clears`,{skip},()=>{
  const db=clone("live");
  optin(db,A,true);
  const id=ev(db,A,ACC,"mid.live."+reason);   // just persisted by the live webhook
  assert.equal(mark(db,id,reason),true,"marker written");
  assert.deepEqual(rec(db,id),{status:"resolved",reason,attempts:0,leased:false,finished:true,created_ok:true});
  ok(db,{sql:clear},"condition clears");
  age(db,id);
  assert.deepEqual(lease(db),[],"nothing discovered or leased");
  age(db,id,"47 hours");
  assert.deepEqual(lease(db),[],"still nothing inside the 48h window");
  assert.equal(rec(db,id).status,"resolved");
  assert.equal(mark(db,id,reason),false,"idempotent: second call writes nothing");
 });
}

test("(c) tenant inactive: the live exit persists nothing, so discovery has nothing to lease after reactivation",{skip},()=>{
 const db=clone("inactive");
 optin(db,A,true);
 ok(db,{sql:`UPDATE public.tenants SET is_active=false WHERE id='${A}';`},"inactive");
 // milan-api returns before the inbound insert: no messages row exists.
 ok(db,{sql:`UPDATE public.tenants SET is_active=true WHERE id='${A}';`},"reactivated");
 assert.deepEqual(lease(db),[]);
 assert.equal(val(db,"SELECT count(*)::int FROM public.automation_inbound_recovery"),0);
});

test("negative control: an unmarked event and a stale 'retrying' (routing unknown) event are still discovered and leased",{skip},()=>{
 const db=clone("control");
 optin(db,A,true);
 const plain=ev(db,A,ACC,"mid.ctl.plain","10 minutes");
 const retrying=ev(db,A,ACC,"mid.ctl.retry","10 minutes");
 const c=ctx(db,retrying);
 assert.equal(val(db,`public.flow_inbound_routing_failed('${A}','${ACC}','instagram','mid.ctl.retry','${c.conversation_id}','${retrying}',5)`,SR),"retrying");
 ok(db,{sql:`UPDATE public.automation_inbound_routing_retries SET last_failed_at=now()-interval '10 minutes';`},"stale");
 const marked=ev(db,A,ACC,"mid.ctl.marked");
 assert.equal(mark(db,marked,"live_auto_reply_off"),true);
 age(db,marked);
 assert.deepEqual(lease(db).map(x=>x.inbound_message_id).sort(),[plain,retrying].sort());
});

test("scoping: wrong tenant/account/platform/event/conversation, invalid reason, outbound row or no opt-in row -> nothing written",{skip},()=>{
 const db=clone("scope");
 optin(db,A,true);
 const id=ev(db,A,ACC,"mid.s1");
 const other=ev(db,A,ACC,"mid.s2");
 const bid=ev(db,B,ACCB,"mid.sb");
 const bad=[
  {tenant_id:B},{account_id:ACCB},{platform:"whatsapp"},{platform:"telegram"},{wa_message_id:"mid.s2"},
  {conversation_id:ctx(db,other).conversation_id},{inbound:other},
 ];
 for(const o of bad)assert.equal(mark(db,id,"live_no_credits",o),false,JSON.stringify(o));
 for(const r of ["auto_reply_off","live_other","Bad"])assert.equal(mark(db,id,r),false,r);
 // tenant B has no opt-in row: never swept, nothing recorded
 assert.equal(mark(db,bid,"live_no_credits",{platform:"facebook"}),false,"no opt-in row (ACCB is a facebook account)");
 // an outbound row is never an event
 ok(db,{sql:`INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
  SELECT tenant_id,conversation_id,'out','mid.o1' FROM public.messages WHERE id='${id}';`},"outbound");
 const out=val(db,`SELECT id FROM public.messages WHERE wa_message_id='mid.o1'`);
 assert.equal(mark(db,out,"live_no_credits",{wa_message_id:"mid.o1"}),false);
 assert.equal(val(db,"SELECT count(*)::int FROM public.automation_inbound_recovery"),0,"nothing written at all");
 // enabled=false opt-in row: recorded (so a later re-enable never replays it)
 optin(db,B,false);
 assert.equal(mark(db,bid,"live_no_credits",{platform:"instagram"}),false,"platform must match the account");
 assert.equal(mark(db,bid,"live_no_credits",{platform:"facebook"}),true);
});

test("insert-only: an existing sweeper row (waiting/leased) is never changed",{skip},()=>{
 const db=clone("insert");
 optin(db,A,true);
 const id=ev(db,A,ACC,"mid.i1","10 minutes");
 const l=lease(db);
 assert.deepEqual(l.map(x=>x.inbound_message_id),[id]);
 const before=rows(db,`SELECT status,reason,attempts,lease_token FROM public.automation_inbound_recovery WHERE inbound_message_id='${id}'`);
 assert.equal(mark(db,id,"live_auto_reply_off"),false);
 assert.deepEqual(rows(db,`SELECT status,reason,attempts,lease_token FROM public.automation_inbound_recovery WHERE inbound_message_id='${id}'`),before);
});

test("rollback removes the function and restores the pre-360000 schema; re-apply is idempotent",{skip},()=>{
 const db=clone("rb");
 ok(db,{file:REC},"re-apply");
 ok(db,{file:REC_RB},"rollback");
 assert.equal(val(db,`to_regprocedure('${LIVE_SIG}') IS NULL`),true);
 ok(db,{file:REC},"re-apply after rollback");
 assert.equal(val(db,`to_regprocedure('${LIVE_SIG}') IS NOT NULL`),true);
});
