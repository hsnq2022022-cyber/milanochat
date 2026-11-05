// Flow run lifecycle migration (20261029130000): static checks always run;
// behavioural checks run against a THROWAWAY local PostgreSQL cluster
// (temporary data dir, unix socket only, listen_addresses='', removed after)
// when PostgreSQL server binaries are present. Never connects to any remote
// host or connection string.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync,writeFileSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";

const MIG="supabase/migrations/20261029130000_flow_run_lifecycle.sql";
const RB="supabase/rollbacks/20261029130000_flow_run_lifecycle.rollback.sql";
const ADV="supabase/migrations/20261028225000_flow_runtime_advance.sql";
const migration=readFileSync(MIG,"utf8");
const rollback=readFileSync(RB,"utf8");

// ---------------------------------------------------------------- static
test("lifecycle migration is the newest migration",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql"))
  .map(f=>f.split("_")[0].padEnd(14,"0"));
 const mine="20261029130000";
 // Reviewed follow-ups that depend on this migration (cancel_reason) may follow it.
 // 20261029150000_flow_takeover_resume replaces the lease/takeover functions
 // non-destructively (tests/flow-takeover-resume.test.mjs); this file keeps
 // testing the 130000 definitions that its rollback restores.
 // 20261029160000_flow_credits_pause replaces only the 150000 pause probe.
 // 20261029170000_flow_canary_claim_durable only adds objects (requires this chain).
 // 20261029180000_flow_durable_button_run_guards replaces only the two durable RPC bodies (requires this chain).
 const successors=["20261029140000","20261029150000","20261029160000","20261029170000","20261029180000"];
 for(const s of stamps)if(s!==mine&&!successors.includes(s))
  assert.ok(s<mine,`older migration ${s} must precede ${mine}`);
});
test("migration is additive, idempotent and has no secrets/cron/production-only objects",()=>{
 assert.doesNotMatch(migration,/\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION|TRIGGER)\b/i);
 assert.doesNotMatch(migration,/\bTRUNCATE\b/i);
 assert.doesNotMatch(migration,/DELETE\s+FROM\s+public\.automation_flow_(runs|outbox)\b/i);
 assert.doesNotMatch(migration,/\bCREATE\s+TABLE\b/i);
 assert.doesNotMatch(migration,/cron\.schedule|vault\.|net\.http_|flow_publish_revision/i);
 assert.doesNotMatch(migration,/sb_secret_|eyJ[A-Za-z0-9_-]{30,}/);
 assert.doesNotMatch(migration,/CREATE\s+FUNCTION/i,"every function uses CREATE OR REPLACE");
 assert.match(migration,/ADD COLUMN IF NOT EXISTS ended_reason/);
 assert.match(migration,/CREATE INDEX IF NOT EXISTS automation_flow_runs_waiting_idx/);
});
test("flow_lease_due_runs keeps its signature and return shape",()=>{
 assert.match(migration,/CREATE OR REPLACE FUNCTION public\.flow_lease_due_runs\(p_limit integer DEFAULT 20\)\s*RETURNS TABLE\(tenant_id uuid,run_id uuid,lease_token uuid\)/);
});
test("new functions are service_role only",()=>{
 const sigs=["flow_conversation_human_takeover(uuid,uuid)","flow_cancel_run(uuid,uuid,text,text)",
  "flow_expire_waiting_runs(integer,integer)","flow_lease_due_runs(integer)",
  "flow_skip_outbox_effect(uuid,uuid,text)","flow_skip_blocked_outbox(integer,integer)",
  "flow_resolve_duplicate_active_runs(integer)"];
 for(const s of sigs){
  const e=s.replace(/[()]/g,"\\$&");
  assert.match(migration,new RegExp(`REVOKE ALL ON FUNCTION public\\.${e} FROM PUBLIC,anon,authenticated;`));
  assert.match(migration,new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${e} TO service_role;`));
 }
 assert.doesNotMatch(migration,/TO\s+(anon|authenticated)\b/);
 assert.doesNotMatch(migration,/SECURITY DEFINER/);
});
test("rollback restores the original flow_lease_due_runs body verbatim",()=>{
 const original=readFileSync(ADV,"utf8").match(
  /CREATE FUNCTION public\.flow_lease_due_runs[\s\S]*?END \$lease\$;/)[0];
 assert.ok(rollback.includes(original.replace("CREATE FUNCTION","CREATE OR REPLACE FUNCTION")));
 assert.match(rollback,/'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE'/);
});
test("rollback sets bounded lock/statement timeouts right after BEGIN",()=>{
 assert.match(rollback,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m);
});
test("rollback refuses to run while 20261029140000 objects exist (wrong order)",()=>{
 const guard=rollback.slice(rollback.indexOf("BEGIN;"),rollback.indexOf("DROP TRIGGER"));
 for(const s of ["flow_claim_outbox_ai(uuid,uuid,integer,integer)","flow_store_outbox_ai_answer(uuid,uuid,uuid,text)",
  "flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer)","'ai_attempts'","automation_flow_outbox_ai_state_chk"])
  assert.ok(guard.includes(s),`guard checks ${s}`);
 assert.match(guard,/RAISE EXCEPTION '[^']*roll back 20261029140000_flow_outbox_ai_retry first'/);
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
let dir,port,started=false;

function asServer(cmd,args){
 return isRoot?spawnSync("runuser",["-u","postgres","--",join(BIN,cmd),...args],{encoding:"utf8"})
  :spawnSync(join(BIN,cmd),args,{encoding:"utf8"});
}
function psqlArgs(db){return ["-X","-q","-v","ON_ERROR_STOP=1","-h",dir,"-p",String(port),"-U","postgres","-d",db];}
function psql(db,{file,sql}){
 const args=psqlArgs(db);
 if(file)args.push("-f",file);
 const r=spawnSync(join(BIN,"psql"),args,{encoding:"utf8",input:sql??undefined});
 return r;
}
function ok(db,src,label){
 const r=psql(db,src);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return r;
}
function psqlAsync(db,sql){
 return new Promise(res=>{
  const p=spawn(join(BIN,"psql"),psqlArgs(db));
  let err="";p.stderr.on("data",d=>err+=d);
  p.on("close",code=>res({code,err}));
  p.stdin.end(sql);
 });
}

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-lifecycle-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+(process.pid%20000);
 let r=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(r.status,0,r.stderr);
 r=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off`,"start"]);
 assert.equal(r.status,0,r.stderr+r.stdout);
 started=true;
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111";
function bootstrap(db,{withRoles}){
 let shape=readFileSync("tests/sql/fixtures/flow-live-shape-bootstrap.sql","utf8");
 if(!withRoles)shape=shape.split("\n").filter(l=>!l.startsWith("CREATE ROLE ")).join("\n");
 ok(db,{sql:shape},"live shape");
 ok(db,{file:"tests/sql/fixtures/installed-flow-switches.sql"},"switches");
 ok(db,{file:"tests/sql/fixtures/installed-flow-runtime.sql"},"runtime");
 ok(db,{sql:`ALTER TABLE public.automation_flow_tenant_switches
  ADD COLUMN production_approved boolean NOT NULL DEFAULT false;`},"production_approved");
 ok(db,{file:ADV},"20261028225000");
 ok(db,{sql:SEED},"seed");
}
const SEED=`
GRANT SELECT ON public.tenants,public.channel_accounts,public.conversations TO service_role;
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
VALUES('${A}','live',1,'${ACC}','instagram','{"version":3,"nodes":[],"edges":[]}','88888888-8888-4888-8888-888888888888'),
      ('${A}','old',1,'${ACC}','instagram','{"version":3,"nodes":[],"edges":[]}','88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active)
VALUES('${A}','${ACC}','instagram','live',1,true),('${A}','${ACC}','instagram','old',1,false);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only) VALUES('${A}',true,true),('${B}',true,true);
UPDATE public.automation_flow_global_switch SET enabled=true;
CREATE SCHEMA lt;
GRANT USAGE ON SCHEMA lt TO service_role,authenticated;
CREATE TABLE lt.ids(name text PRIMARY KEY,id uuid NOT NULL);
GRANT SELECT ON lt.ids TO service_role,authenticated;
CREATE FUNCTION lt.id(p text) RETURNS uuid LANGUAGE sql STABLE AS $f$SELECT id FROM lt.ids WHERE name=p$f$;
CREATE FUNCTION lt.conv(p uuid DEFAULT gen_random_uuid()) RETURNS uuid LANGUAGE sql AS $f$
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(p,'${A}','${ACC}','ig:'||p) RETURNING id$f$;
CREATE FUNCTION lt.run(p_conv uuid,p_flow text,p_status text,p_wake timestamptz) RETURNS uuid
LANGUAGE plpgsql AS $f$
DECLARE ev text:='ev-'||gen_random_uuid(); v uuid;
BEGIN
 INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
 VALUES('${A}','${ACC}','instagram',ev);
 INSERT INTO public.automation_flow_runs(tenant_id,flow_key,publication_revision,channel_account_id,
  platform,conversation_id,provider_event_id,current_node_id,run_status,wake_at)
 VALUES('${A}',p_flow,1,'${ACC}','instagram',p_conv,ev,'n1',p_status,p_wake) RETURNING id INTO v;
 RETURN v;
END $f$;
CREATE FUNCTION lt.fx(p_run uuid,p_status text DEFAULT 'pending',p_kind text DEFAULT 'message',
 p_age interval DEFAULT '0'::interval) RETURNS uuid LANGUAGE sql AS $f$
 INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload,delivery_status,created_at)
 VALUES('${A}',p_run,'k-'||gen_random_uuid(),p_kind,jsonb_build_object('kind',p_kind,'text','hi','tag','x'),p_status,now()-p_age)
 RETURNING id$f$;
CREATE FUNCTION lt.eq(got anycompatible,want anycompatible,label text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF got IS DISTINCT FROM want THEN
 RAISE EXCEPTION 'ASSERT FAILED [%]: got % want %',label,got,want; END IF; END $f$;
CREATE FUNCTION lt.st(p uuid) RETURNS text LANGUAGE plpgsql STABLE AS $f$
BEGIN RETURN (SELECT run_status||'/'||coalesce(ended_reason,'-') FROM public.automation_flow_runs WHERE id=p); END $f$;
CREATE FUNCTION lt.ox(p uuid) RETURNS text LANGUAGE plpgsql STABLE AS $f$
BEGIN RETURN (SELECT delivery_status||'/'||coalesce(cancel_reason,'-') FROM public.automation_flow_outbox WHERE id=p); END $f$;
`;

const BEHAVIOUR=`
-- (B) ineligible head-of-line runs no longer block newer eligible ones
DO $s$
DECLARE i int;
BEGIN
 FOR i IN 1..25 LOOP
  INSERT INTO lt.ids VALUES('old'||i,lt.run(lt.conv(),'old','sleeping',now()-interval '2 hours'+i*interval '1 second'));
 END LOOP;
 INSERT INTO lt.ids VALUES('old1_fx',lt.fx(lt.id('old1')));
 INSERT INTO lt.ids VALUES('good',lt.run(lt.conv(),'live','sleeping',now()-interval '1 minute'));
END $s$;
SET ROLE service_role;
DO $t$
DECLARE got uuid[];
BEGIN
 SELECT array_agg(run_id) INTO got FROM public.flow_lease_due_runs(20);
 PERFORM lt.eq(got,ARRAY[lt.id('good')],'B only eligible run leased');
 PERFORM lt.eq((SELECT count(*)::int FROM public.automation_flow_runs
  WHERE flow_key='old' AND run_status='blocked' AND ended_reason='revision_inactive'),25,'B inactive ended');
 PERFORM lt.eq(lt.ox(lt.id('old1_fx')),'cancelled/revision_inactive','B pending effect skipped');
 PERFORM lt.eq((SELECT count(*)::int FROM public.automation_flow_run_leases WHERE run_id<>lt.id('good')),0,'B no stray leases');
END $t$;
RESET ROLE;
INSERT INTO lt.ids VALUES('good2',lt.run(lt.conv(),'live','sleeping',now()-interval '30 seconds'));
SET ROLE service_role;
DO $t$
DECLARE got uuid[];
BEGIN
 -- 'good' holds a live lease and is older; it must not consume the only slot.
 SELECT array_agg(run_id) INTO got FROM public.flow_lease_due_runs(1);
 PERFORM lt.eq(got,ARRAY[lt.id('good2')],'B live lease does not take a slot');
 SELECT array_agg(run_id) INTO got FROM public.flow_lease_due_runs(5);
 PERFORM lt.eq(got,NULL::uuid[],'B nothing re-leased while leases live');
 -- backward compatible commit with the lease token
 PERFORM lt.eq(public.flow_commit_run_step('${A}',lt.id('good'),0,'sleeping','end',1,'completed',
   '{}'::jsonb,NULL,'[]'::jsonb,'completed',
   (SELECT token FROM public.automation_flow_run_leases WHERE run_id=lt.id('good'))),true,'B commit with lease');
END $t$;
RESET ROLE;
-- lease exhaustion: 3 leases without a committed step, then ended
DO $t$
DECLARE i int; got uuid[];
BEGIN
 FOR i IN 2..3 LOOP
  UPDATE public.automation_flow_run_leases SET expires_at=now()-interval '1 second' WHERE run_id=lt.id('good2');
  SELECT array_agg(run_id) INTO got FROM public.flow_lease_due_runs(5);
  PERFORM lt.eq(got,ARRAY[lt.id('good2')],'B re-lease '||i);
  PERFORM lt.eq((SELECT attempts FROM public.automation_flow_run_leases WHERE run_id=lt.id('good2')),i,'B attempts');
 END LOOP;
 UPDATE public.automation_flow_run_leases SET expires_at=now()-interval '1 second' WHERE run_id=lt.id('good2');
 SELECT array_agg(run_id) INTO got FROM public.flow_lease_due_runs(5);
 PERFORM lt.eq(got,NULL::uuid[],'B exhausted not returned');
 PERFORM lt.eq(lt.st(lt.id('good2')),'blocked/lease_exhausted','B exhausted ended');
END $t$;
-- paused tenant: skipped, NOT modified
UPDATE public.automation_flow_tenant_switches SET enabled=false WHERE tenant_id='${A}';
INSERT INTO lt.ids VALUES('paused',lt.run(lt.conv(),'live','sleeping',now()-interval '5 minutes'));
DO $t$ BEGIN
 PERFORM lt.eq((SELECT count(*)::int FROM public.flow_lease_due_runs(5)),0,'paused no lease');
 PERFORM lt.eq(lt.st(lt.id('paused')),'sleeping/-','paused untouched');
END $t$;
UPDATE public.automation_flow_tenant_switches SET enabled=true WHERE tenant_id='${A}';
SELECT public.flow_cancel_run('${A}',lt.id('paused'),'manual');

-- live-only columns appear: read dynamically, human takeover fails closed
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,ADD COLUMN auto_reply boolean NOT NULL DEFAULT true;
ALTER TABLE public.conversations ADD COLUMN transferred boolean NOT NULL DEFAULT false,
 ADD COLUMN human_agent_until timestamptz;
DO $s$
DECLARE c uuid;
BEGIN
 c:=lt.conv(); UPDATE public.conversations SET human_agent_until=now()+interval '1 hour' WHERE id=c;
 INSERT INTO lt.ids VALUES('ht',lt.run(c,'live','sleeping',now()-interval '1 minute'));
 INSERT INTO lt.ids VALUES('ht_fx',lt.fx(lt.id('ht')));
 c:=lt.conv(); UPDATE public.conversations SET human_agent_until=now()-interval '1 hour' WHERE id=c;
 INSERT INTO lt.ids VALUES('ended_takeover',lt.run(c,'live','sleeping',now()-interval '1 minute'));
END $s$;
SET ROLE service_role;
DO $t$
DECLARE got uuid[];
BEGIN
 SELECT array_agg(run_id) INTO got FROM public.flow_lease_due_runs(5);
 PERFORM lt.eq(got,ARRAY[lt.id('ended_takeover')],'takeover lease');
 PERFORM lt.eq(lt.st(lt.id('ht')),'blocked/human_takeover','takeover run ended');
 PERFORM lt.eq(lt.ox(lt.id('ht_fx')),'cancelled/human_takeover','takeover effect skipped');
END $t$;
RESET ROLE;
SELECT public.flow_cancel_run('${A}',lt.id('ended_takeover'),'manual');
UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}';
INSERT INTO lt.ids VALUES('acct',lt.run(lt.conv(),'live','sleeping',now()-interval '1 minute'));
DO $t$ BEGIN
 PERFORM lt.eq((SELECT count(*)::int FROM public.flow_lease_due_runs(5)),0,'disabled account');
 PERFORM lt.eq(lt.st(lt.id('acct')),'blocked/ineligible','disabled account ended');
END $t$;
UPDATE public.channel_accounts SET auto_reply=true WHERE id='${ACC}';

-- (A) waiting runs expire / can be cancelled
DO $s$
BEGIN
 INSERT INTO lt.ids VALUES('w_old',lt.run(lt.conv(),'live','awaiting_input',NULL));
 INSERT INTO lt.ids VALUES('w_new',lt.run(lt.conv(),'live','awaiting_input',NULL));
 INSERT INTO lt.ids VALUES('w_inactive',lt.run(lt.conv(),'old','awaiting_input',NULL));
 INSERT INTO lt.ids VALUES('r_stale',lt.run(lt.conv(),'live','ready',NULL));
 UPDATE public.automation_flow_runs SET updated_at=now()-interval '2 hours'
  WHERE id IN(lt.id('w_old'),lt.id('r_stale'));
END $s$;
SET ROLE service_role;
DO $t$
BEGIN
 BEGIN PERFORM public.flow_expire_waiting_runs(1,10);
  RAISE EXCEPTION 'bounds not enforced';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'invalid expiry bounds' THEN RAISE; END IF;
 END;
 PERFORM lt.eq(public.flow_expire_waiting_runs(60,100),3,'A expired count');
 PERFORM lt.eq(lt.st(lt.id('w_old')),'blocked/input_timeout','A timeout');
 PERFORM lt.eq(lt.st(lt.id('w_inactive')),'blocked/revision_inactive','A inactive revision');
 PERFORM lt.eq(lt.st(lt.id('r_stale')),'blocked/stale','A stale ready');
 PERFORM lt.eq(lt.st(lt.id('w_new')),'awaiting_input/-','A fresh untouched');
 PERFORM lt.eq(public.flow_cancel_run('${B}',lt.id('w_new'),'free_text'),false,'A cross-tenant cancel refused');
 PERFORM lt.eq(public.flow_cancel_run('${A}',lt.id('w_new'),'bogus'),false,'A bad reason');
 PERFORM lt.eq(public.flow_cancel_run('${A}',lt.id('w_new'),'free_text','sleeping'),false,'A expect mismatch');
 PERFORM lt.eq(public.flow_cancel_run('${A}',lt.id('w_new'),'free_text','awaiting_input'),true,'A free text cancel');
 PERFORM lt.eq(public.flow_cancel_run('${A}',lt.id('w_new'),'free_text'),false,'A cancel twice');
 PERFORM lt.eq(lt.st(lt.id('w_new')),'blocked/free_text','A cancelled state');
 PERFORM lt.eq(public.flow_commit_run_step('${A}',lt.id('w_new'),0,'awaiting_input','end',1,'completed',
   '{}'::jsonb,NULL,'[]'::jsonb,'button',NULL),false,'A cancelled run cannot advance');
END $t$;
RESET ROLE;

-- (C) outbox skip
DO $s$
DECLARE r1 uuid; r2 uuid; c uuid;
BEGIN
 r1:=lt.run(lt.conv(),'live','sleeping',now()+interval '1 hour');
 INSERT INTO lt.ids VALUES('fresh',lt.fx(r1)),('old_msg',lt.fx(r1,'pending','question','3 hours')),
  ('charge',lt.fx(r1,'charge_pending','message','3 hours')),('tag',lt.fx(r1,'pending','tag','3 hours')),
  ('retry',lt.fx(r1,'retry_wait','message','3 hours'));
 c:=lt.conv(); UPDATE public.conversations SET transferred=true WHERE id=c;
 r2:=lt.run(c,'live','sleeping',now()+interval '1 hour');
 INSERT INTO lt.ids VALUES('t_msg',lt.fx(r2));
END $s$;
SET ROLE service_role;
DO $t$
BEGIN
 PERFORM lt.eq(public.flow_skip_blocked_outbox(60,200),3,'C swept count');
 PERFORM lt.eq(lt.ox(lt.id('old_msg')),'cancelled/stale','C stale question');
 PERFORM lt.eq(lt.ox(lt.id('retry')),'cancelled/stale','C stale retry');
 PERFORM lt.eq(lt.ox(lt.id('t_msg')),'cancelled/human_takeover','C takeover');
 PERFORM lt.eq(lt.ox(lt.id('fresh')),'pending/-','C fresh untouched');
 PERFORM lt.eq(lt.ox(lt.id('charge')),'charge_pending/-','C sent effect untouched');
 PERFORM lt.eq(lt.ox(lt.id('tag')),'pending/-','C internal effect untouched');
 PERFORM lt.eq(public.flow_skip_outbox_effect('${B}',lt.id('fresh'),'manual'),false,'C cross-tenant refused');
 PERFORM lt.eq(public.flow_skip_outbox_effect('${A}',lt.id('charge'),'manual'),false,'C charge_pending refused');
 PERFORM lt.eq(public.flow_skip_outbox_effect('${A}',lt.id('fresh'),'nope'),false,'C bad reason');
 PERFORM lt.eq(public.flow_skip_outbox_effect('${A}',lt.id('fresh'),'manual'),true,'C skip one');
 PERFORM lt.eq(public.flow_skip_outbox_effect('${A}',lt.id('fresh'),'manual'),false,'C skip twice');
END $t$;
RESET ROLE;

-- (E) one active run per conversation
DO $t$
DECLARE c uuid:=lt.conv(); e1 uuid; done uuid; e3 uuid;
BEGIN
 PERFORM lt.eq(to_regclass('public.flow_one_active_run_per_conversation') IS NOT NULL,true,'E index built');
 e1:=lt.run(c,'live','awaiting_input',NULL);
 BEGIN PERFORM lt.run(c,'live','sleeping',now()+interval '1 hour');
  RAISE EXCEPTION 'E second active run inserted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 done:=lt.run(c,'live','completed',NULL);
 BEGIN UPDATE public.automation_flow_runs SET run_status='ready' WHERE id=done;
  RAISE EXCEPTION 'E reactivation allowed';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 PERFORM public.flow_cancel_run('${A}',e1,'superseded');
 e3:=lt.run(c,'live','ready',NULL);
 UPDATE public.automation_flow_runs SET run_status='sleeping',wake_at=now() WHERE id=e3;
 PERFORM lt.eq(lt.st(e3),'sleeping/-','E active transitions allowed');
END $t$;

-- privileges
SET ROLE authenticated;
DO $t$
BEGIN
 BEGIN PERFORM public.flow_cancel_run('${A}',lt.id('fresh'),'manual');
  RAISE EXCEPTION 'authenticated may cancel runs';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.flow_lease_due_runs(1);
  RAISE EXCEPTION 'authenticated may lease';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $t$;
RESET ROLE;
`;

test("live PG: lifecycle behaviour, idempotency and rollback",{skip:live?false:"PostgreSQL server binaries unavailable; static checks only"},()=>{
 ok("postgres",{sql:"CREATE DATABASE lifecycle;"},"createdb");
 bootstrap("lifecycle",{withRoles:true});
 ok("lifecycle",{file:MIG},"migration");
 ok("lifecycle",{sql:BEHAVIOUR},"behaviour");
 ok("lifecycle",{file:MIG},"migration re-applied (idempotent)");
 ok("lifecycle",{file:RB},"rollback");
 ok("lifecycle",{sql:`DO $t$ BEGIN
  IF to_regprocedure('public.flow_cancel_run(uuid,uuid,text,text)') IS NOT NULL
  OR to_regclass('public.flow_one_active_run_per_conversation') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='flow_one_active_run_guard')
  OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='automation_flow_runs' AND column_name='ended_reason')
  OR obj_description('public.flow_lease_due_runs(integer)'::regprocedure,'pg_proc')<>'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE'
  OR (SELECT count(*) FROM public.automation_flow_runs WHERE run_status='blocked')=0
  THEN RAISE EXCEPTION 'rollback incomplete or resurrected runs'; END IF;
  PERFORM count(*) FROM public.flow_lease_due_runs(5);
 END $t$;`},"rollback verified");
 ok("lifecycle",{file:MIG},"migration re-applied after rollback");
});

// Schema + data fingerprint used to prove a refused rollback changed nothing.
const SNAP=`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'c:'||a.attrelid::regclass::text||'.'||a.attname FROM pg_attribute a
  JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'k:'||conname||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 'i:'||indexrelid::regclass::text FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 't:'||tgname FROM pg_trigger WHERE NOT tgisinternal
 UNION ALL SELECT 'r:'||md5(coalesce(string_agg(r::text,',' ORDER BY r.id),'')) FROM public.automation_flow_runs r
 UNION ALL SELECT 'o:'||md5(coalesce(string_agg(o::text,',' ORDER BY o.id),'')) FROM public.automation_flow_outbox o
) s(x);`;

test("live PG: lifecycle rollback is refused while a 20261029140000 object exists, then succeeds once it is gone",
 {skip:live?false:"PostgreSQL server binaries unavailable; static checks only"},()=>{
 ok("postgres",{sql:"CREATE DATABASE order_guard;"},"createdb");
 bootstrap("order_guard",{withRoles:false});
 ok("order_guard",{file:MIG},"migration");
 ok("order_guard",{sql:`DO $s$ DECLARE r uuid:=lt.run(lt.conv(),'live','sleeping',now()+interval '1 hour');
  BEGIN PERFORM lt.fx(r); PERFORM public.flow_cancel_run('${A}',r,'manual'); END $s$;`},"seed");
 // Stand-ins for each kind of 140000 object (the real migration is exercised
 // in flow-outbox-ai-retry.test.mjs); every one alone must block the rollback.
 const standIns=[
  ["ALTER TABLE public.automation_flow_outbox ADD COLUMN ai_attempts integer NOT NULL DEFAULT 0;",
   "ALTER TABLE public.automation_flow_outbox DROP COLUMN ai_attempts;"],
  ["ALTER TABLE public.automation_flow_outbox ADD COLUMN ai_answer_encrypted text;",
   "ALTER TABLE public.automation_flow_outbox DROP COLUMN ai_answer_encrypted;"],
  ["ALTER TABLE public.automation_flow_outbox ADD CONSTRAINT automation_flow_outbox_ai_state_chk CHECK(true);",
   "ALTER TABLE public.automation_flow_outbox DROP CONSTRAINT automation_flow_outbox_ai_state_chk;"],
  ["CREATE FUNCTION public.flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer) RETURNS text LANGUAGE sql AS 'SELECT NULL::text';",
   "DROP FUNCTION public.flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer);"],
 ];
 for(const [add,drop] of standIns){
  ok("order_guard",{sql:add},`add ${add}`);
  const before=ok("order_guard",{sql:SNAP},"snapshot").stdout;
  const r=psql("order_guard",{file:RB});
  assert.notEqual(r.status,0,`rollback must be refused with: ${add}`);
  assert.match(r.stderr,/roll back 20261029140000_flow_outbox_ai_retry first/);
  assert.equal(ok("order_guard",{sql:SNAP},"snapshot").stdout,before,"refused rollback changed nothing");
  ok("order_guard",{sql:drop},`drop ${drop}`);
 }
 ok("order_guard",{file:RB},"rollback once 140000 objects are gone");
 ok("order_guard",{sql:`DO $t$ BEGIN
  IF to_regprocedure('public.flow_cancel_run(uuid,uuid,text,text)') IS NOT NULL
  OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='automation_flow_outbox' AND column_name='cancel_reason')
  THEN RAISE EXCEPTION 'rollback incomplete'; END IF; END $t$;`},"rollback verified");
 ok("order_guard",{file:MIG},"migration re-applied after rollback");
});

test("live PG: pre-existing duplicate active runs do not fail the migration; trigger serializes concurrent starts",
 {skip:live?false:"PostgreSQL server binaries unavailable; static checks only"},async()=>{
 ok("postgres",{sql:"CREATE DATABASE dupes;"},"createdb");
 bootstrap("dupes",{withRoles:false});
 ok("dupes",{sql:`DO $s$ DECLARE c uuid:=lt.conv();
  BEGIN INSERT INTO lt.ids VALUES('d1',lt.run(c,'live','awaiting_input',NULL)),('d2',lt.run(c,'live','sleeping',now()+interval '1 hour'));
  UPDATE public.automation_flow_runs SET updated_at=now()-interval '1 minute' WHERE id=lt.id('d1');
  INSERT INTO lt.ids VALUES('dc',c); END $s$;`},"seed duplicates");
 const r=ok("dupes",{file:MIG},"migration with duplicates");
 assert.match(r.stderr,/unique index deferred/);
 ok("dupes",{sql:`DO $t$ BEGIN
  PERFORM lt.eq(to_regclass('public.flow_one_active_run_per_conversation') IS NULL,true,'index deferred');
  BEGIN PERFORM lt.run(lt.id('dc'),'live','ready',NULL); RAISE EXCEPTION 'third active run inserted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  UPDATE public.automation_flow_runs SET step_count=1 WHERE id=lt.id('d1');
 END $t$;
 SET ROLE service_role;
 DO $t$ BEGIN
  PERFORM lt.eq(public.flow_resolve_duplicate_active_runs(100),1,'one duplicate resolved');
  PERFORM lt.eq(lt.st(lt.id('d1')),'blocked/duplicate_active','older ended');
  PERFORM lt.eq(lt.st(lt.id('d2')),'sleeping/-','newest kept');
  PERFORM lt.eq(public.flow_resolve_duplicate_active_runs(100),0,'clean');
 END $t$;`},"duplicate guard");
 const conv="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
 ok("dupes",{sql:`SELECT lt.conv('${conv}');`},"conv");
 const first=psqlAsync("dupes",`BEGIN; SELECT lt.run('${conv}','live','sleeping',now()+interval '1 hour'); SELECT pg_sleep(1.5); COMMIT;`);
 await new Promise(r=>setTimeout(r,500));
 const second=psqlAsync("dupes",`SELECT lt.run('${conv}','live','awaiting_input',NULL);`);
 const [a,b]=await Promise.all([first,second]);
 assert.equal(a.code,0,a.err);
 assert.notEqual(b.code,0,"concurrent second start must be refused");
 assert.match(b.err,/flow_active_run_exists/);
 ok("dupes",{sql:`DO $t$ BEGIN PERFORM lt.eq((SELECT count(*)::int FROM public.automation_flow_runs
  WHERE conversation_id='${conv}' AND run_status IN('ready','awaiting_input','sleeping')),1,'exactly one'); END $t$;`},"count");
});
