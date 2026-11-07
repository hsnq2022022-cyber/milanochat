// 20261029160000_flow_credits_pause: tenant credit exhaustion is a temporary
// pause for durable runs. Static checks always run; behavioural checks run
// against a THROWAWAY local PostgreSQL cluster (temporary data dir, unix
// socket only, listen_addresses='', removed afterwards) when PostgreSQL server
// binaries are present. Never connects to any remote host or connection string.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";

const MIG="supabase/migrations/20261029160000_flow_credits_pause.sql";
const RB="supabase/rollbacks/20261029160000_flow_credits_pause.rollback.sql";
const TK="supabase/migrations/20261029150000_flow_takeover_resume.sql";
const TK_RB="supabase/rollbacks/20261029150000_flow_takeover_resume.rollback.sql";
const LC="supabase/migrations/20261029130000_flow_run_lifecycle.sql";
const LC_RB="supabase/rollbacks/20261029130000_flow_run_lifecycle.rollback.sql";
const AI="supabase/migrations/20261029140000_flow_outbox_ai_retry.sql";
const AI_RB="supabase/rollbacks/20261029140000_flow_outbox_ai_retry.rollback.sql";
const migration=readFileSync(MIG,"utf8");
const rollback=readFileSync(RB,"utf8");
const takeover=readFileSync(TK,"utf8");
const MARK="CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE";

// ---------------------------------------------------------------- static
test("160000 follows 130000/140000/150000; only 170000 (canary claim, depends on it) is newer",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql"))
  .map(f=>f.split("_")[0].padEnd(14,"0"));
 // 20261029170000_flow_canary_claim_durable requires 160000 (its preflight).
 // 20261029180000_flow_durable_button_run_guards requires 170000 (and this migration).
 // 20261029190000_flow_begin_durable_run_superseding requires 180000 (and this migration).
 // 20261029200000_flow_media_storage is an independent storage bucket (no flow object).
 // 20261029210000_flow_media_effects requires 190000 (and this migration) (tests/flow-media-effects.test.mjs).
 // 20261029220000_flow_media_stale_sweep requires 210000 (tests/flow-media-stale-sweep.test.mjs).
 // 20261029230000_flow_multichannel_support requires 220000 (tests/flow-multichannel-support.test.mjs).
 const successors=["20261029170000","20261029180000","20261029190000","20261029200000","20261029210000","20261029220000","20261029230000","20261029240000","20261029250000"];
 for(const s of stamps)if(s!=="20261029160000"&&!successors.includes(s))assert.ok(s<"20261029160000",s);
 assert.ok(existsSync(LC)&&existsSync(AI)&&existsSync(TK));
});
test("migration: bounded, one CREATE OR REPLACE with the same signature, service_role only",()=>{
 assert.match(migration,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m);
 assert.doesNotMatch(migration,/\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION|TRIGGER|CONSTRAINT)\b/i);
 assert.doesNotMatch(migration,/\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b|\bUPDATE\s+public\./i);
 assert.doesNotMatch(migration,/cron\.schedule|vault\.|net\.http_|sb_secret_|eyJ[A-Za-z0-9_-]{30,}/);
 assert.doesNotMatch(migration,/CREATE\s+FUNCTION/i);
 assert.doesNotMatch(migration,/SECURITY DEFINER/);
 assert.doesNotMatch(migration,/TO\s+(anon|authenticated)\b/);
 assert.equal((migration.match(/CREATE OR REPLACE FUNCTION/g)??[]).length,1);
 assert.match(migration,/CREATE OR REPLACE FUNCTION public\.flow_channel_temporarily_paused\(\n p_tenant uuid,p_account uuid\)\nRETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=''/);
 assert.match(migration,/REVOKE ALL ON FUNCTION public\.flow_channel_temporarily_paused\(uuid,uuid\) FROM PUBLIC,anon,authenticated;/);
 assert.match(migration,/GRANT EXECUTE ON FUNCTION public\.flow_channel_temporarily_paused\(uuid,uuid\) TO service_role;/);
 assert.match(migration,new RegExp(`flow_channel_temporarily_paused\\(uuid,uuid\\)\\n IS '${MARK}'`));
 for(const m of ["apply 20261029130000_flow_run_lifecycle first","apply 20261029140000_flow_outbox_ai_retry first",
  "apply 20261029150000_flow_takeover_resume first"])assert.ok(migration.includes(m),m);
});
test("rollback restores the exact 150000 body and marker; older rollbacks refuse while 160000 exists",()=>{
 const start="CREATE OR REPLACE FUNCTION public.flow_channel_temporarily_paused(";
 const i=takeover.indexOf(start);
 const original=takeover.slice(i,takeover.indexOf("$paused$;",i)+"$paused$;".length);
 assert.ok(original.length>200);
 assert.ok(rollback.includes(original));
 assert.match(rollback,/IS 'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME';/);
 assert.match(rollback,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m);
 for(const f of [TK_RB,AI_RB,LC_RB]){
  const s=readFileSync(f,"utf8");
  const guard=s.slice(s.indexOf("BEGIN;"),s.indexOf("$g$;")>0?s.indexOf("$g$;"):s.indexOf("$guard$;"));
  assert.ok(guard.includes(MARK),f);
  assert.match(guard,/RAISE EXCEPTION '[^']*roll back 20261029160000_flow_credits_pause first'/,f);
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
function clientEnv(){
 const env={};
 for(const [k,v] of Object.entries(process.env))if(!k.startsWith("PG"))env[k]=v;
 return env;
}
function psql(db,{file,sql}){
 const args=["-X","-q","-v","ON_ERROR_STOP=1","-h",dir,"-p",String(port),"-U","postgres","-d",db,"-tA"];
 if(file)args.push("-f",file);
 return spawnSync(join(BIN,"psql"),args,{encoding:"utf8",input:sql??undefined,env:clientEnv()});
}
function ok(db,src,label){
 const r=psql(db,src);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return r;
}
function refused(db,file,re,label){
 const r=psql(db,{file});
 assert.notEqual(r.status,0,`${label} must be refused`);
 assert.match(r.stderr,re,label);
}
before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-credits-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+29)%20000);
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

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC="11111111-1111-4111-8111-111111111111";
// Same chain as tests/flow-takeover-resume.test.mjs, through 150000.
function bootstrap(db){
 ok(db,{sql:readFileSync("tests/sql/fixtures/flow-live-shape-bootstrap.sql","utf8")},"live shape");
 for(const f of ["tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
  "tests/sql/flow-exclusive-claim-bootstrap.sql","supabase/migrations/20261028220000_webhook_exclusive_claim.sql",
  "supabase/migrations/20261028224000_delivery_attempts.sql","supabase/migrations/20261028225000_flow_runtime_advance.sql",
  "tests/sql/flow-phase4-runtime-bootstrap.sql","tests/sql/flow-outbox-delivery-bootstrap.sql",
  "supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql",LC,AI,TK])ok(db,{file:f},f);
 ok(db,{sql:SEED},"seed");
}
// Production names/types: tenants.credits_remaining integer NOT NULL DEFAULT
// (flow-exclusive-claim-bootstrap.sql, schema.sql), plus the optional flags
// and canonical takeover columns.
const SEED=`
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,ADD COLUMN auto_reply boolean NOT NULL DEFAULT true;
ALTER TABLE public.conversations ADD COLUMN transferred boolean NOT NULL DEFAULT false,
 ADD COLUMN auto_paused_reason text,ADD COLUMN human_agent_expires_at timestamptz;
GRANT SELECT ON public.tenants,public.channel_accounts,public.conversations TO service_role;
GRANT UPDATE ON public.tenants,public.conversations TO service_role;
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
VALUES('${A}','live',1,'${ACC}','instagram','{"version":3,"nodes":[],"edges":[]}','88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active)
VALUES('${A}','${ACC}','instagram','live',1,true);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only) VALUES('${A}',true,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
CREATE SCHEMA cp;
GRANT USAGE ON SCHEMA cp TO service_role;
CREATE TABLE cp.ids(name text PRIMARY KEY,id uuid NOT NULL);
GRANT SELECT,INSERT ON cp.ids TO service_role;
CREATE FUNCTION cp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS $f$SELECT id FROM cp.ids WHERE name=p$f$;
CREATE FUNCTION cp.run(p_name text,p_wake interval) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE ev text:='ev-'||gen_random_uuid(); v uuid; c uuid;
BEGIN
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(gen_random_uuid(),'${A}','${ACC}','instagram:'||gen_random_uuid()) RETURNING id INTO c;
 INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
 VALUES('${A}','${ACC}','instagram',ev);
 INSERT INTO public.automation_flow_runs(tenant_id,flow_key,publication_revision,channel_account_id,
  platform,conversation_id,provider_event_id,current_node_id,run_status,wake_at)
 VALUES('${A}','live',1,'${ACC}','instagram',c,ev,'n1','sleeping',now()-p_wake) RETURNING id INTO v;
 INSERT INTO cp.ids VALUES(p_name,v),(p_name||'_conv',c);
 INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
 VALUES('${A}',v,'k-'||p_name,'message','{"kind":"message","text":"hi"}'::jsonb) RETURNING id INTO c;
 INSERT INTO cp.ids VALUES(p_name||'_fx',c);
 RETURN v;
END $f$;
CREATE FUNCTION cp.eq(got anycompatible,want anycompatible,label text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF got IS DISTINCT FROM want THEN
 RAISE EXCEPTION 'ASSERT FAILED [%]: got % want %',label,got,want; END IF; END $f$;
CREATE FUNCTION cp.st(p text) RETURNS text LANGUAGE sql STABLE AS $f$
 SELECT run_status||'/'||coalesce(ended_reason,'-') FROM public.automation_flow_runs WHERE id=cp.id(p)$f$;
CREATE FUNCTION cp.ox(p text) RETURNS text LANGUAGE sql STABLE AS $f$
 SELECT delivery_status||'/'||coalesce(cancel_reason,'-') FROM public.automation_flow_outbox WHERE id=cp.id(p||'_fx')$f$;
CREATE FUNCTION cp.leased() RETURNS text[] LANGUAGE sql AS $f$
 SELECT coalesce(array_agg(n.name ORDER BY n.name),'{}') FROM public.flow_lease_due_runs(20) l
 JOIN cp.ids n ON n.id=l.run_id$f$;
CREATE FUNCTION cp.has_lease(p text) RETURNS boolean LANGUAGE sql STABLE AS $f$
 SELECT EXISTS(SELECT 1 FROM public.automation_flow_run_leases WHERE run_id=cp.id(p))$f$;
CREATE FUNCTION cp.done(p text) RETURNS void LANGUAGE sql AS $f$
 SELECT cp.eq(public.flow_commit_run_step('${A}',cp.id(p),0,'sleeping','end',1,'completed',
  '{}'::jsonb,NULL,'[]'::jsonb,'completed',
  (SELECT token FROM public.automation_flow_run_leases WHERE run_id=cp.id(p))),true,'commit '||p)$f$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cp TO service_role;
`;
const FN_SRC=`SELECT md5(p.prosrc)||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||coalesce(array_to_string(p.proacl,','),'')
 FROM pg_proc p WHERE p.oid='public.flow_channel_temporarily_paused(uuid,uuid)'::regprocedure;`;

test("live PG: out-of-credit tenant's runs stay sleeping (not leased, not ended), resume on top-up, 24h stale bound",{skip},()=>{
 ok("postgres",{sql:"CREATE DATABASE credits;"},"createdb");
 bootstrap("credits");
 const fn150=ok("credits",{sql:FN_SRC},"150000 fingerprint").stdout;
 // Defect under 150000: credits 0 does not pause; the run is leased (and would be advanced).
 ok("credits",{sql:`UPDATE public.tenants SET credits_remaining=0 WHERE id='${A}';
  SET ROLE service_role; DO $t$ BEGIN
  PERFORM cp.run('before','1 minute');
  PERFORM cp.eq(public.flow_channel_temporarily_paused('${A}','${ACC}'),false,'150000 ignores credits');
  PERFORM cp.eq(cp.leased(),'{before}'::text[],'150000 leases an out-of-credit run');
  PERFORM cp.done('before');
  PERFORM cp.eq(cp.st('before'),'completed/-','150000: run advanced without credit');
  PERFORM cp.eq(cp.ox('before'),'pending/-','its message can never be sent (send gate) until stale');
  END $t$;`},"150000 behaviour (defect)");
 // Fix.
 refused("credits",RB,/20261029160000_flow_credits_pause not installed; nothing to roll back/,"160000 rollback before 160000");
 ok("credits",{file:MIG},"160000");
 ok("credits",{sql:`SET ROLE service_role; DO $t$ BEGIN
  -- credits 0: not leased, NOT ended, no lease row, effect pending
  PERFORM cp.run('p','1 minute');
  PERFORM cp.eq(public.flow_channel_temporarily_paused('${A}','${ACC}'),true,'credits 0 paused');
  PERFORM cp.eq(cp.leased(),'{}'::text[],'credits 0: no lease');
  PERFORM cp.eq(cp.leased(),'{}'::text[],'credits 0: still no lease on later ticks');
  PERFORM cp.eq(cp.leased(),'{}'::text[],'credits 0: no lease_exhausted path');
  PERFORM cp.eq(cp.leased(),'{}'::text[],'credits 0: fourth tick');
  PERFORM cp.eq(cp.st('p'),'sleeping/-','credits 0: run kept');
  PERFORM cp.eq(cp.has_lease('p'),false,'credits 0: no lease row');
  PERFORM cp.eq(cp.ox('p'),'pending/-','credits 0: effect kept');
  -- negative balance is paused too
  UPDATE public.tenants SET credits_remaining=-3 WHERE id='${A}';
  PERFORM cp.eq(cp.leased(),'{}'::text[],'negative credits: no lease');
  -- top-up: leased on the next tick, first attempt, proceeds
  UPDATE public.tenants SET credits_remaining=10 WHERE id='${A}';
  PERFORM cp.eq(public.flow_channel_temporarily_paused('${A}','${ACC}'),false,'credits >0 not paused');
  PERFORM cp.eq(cp.leased(),'{p}'::text[],'top-up: leased');
  PERFORM cp.eq((SELECT attempts FROM public.automation_flow_run_leases WHERE run_id=cp.id('p')),1,'first lease attempt');
  PERFORM cp.done('p');
  PERFORM cp.eq(cp.st('p'),'completed/-','top-up: proceeds');
  -- 24h bound: paused for credits beyond max age ends 'stale', younger kept
  UPDATE public.tenants SET credits_remaining=0 WHERE id='${A}';
  PERFORM cp.run('old','25 hours'); PERFORM cp.run('young','23 hours');
  PERFORM cp.eq(cp.leased(),'{}'::text[],'stale: nothing leased');
  PERFORM cp.eq(cp.st('old'),'blocked/stale','credits pause >24h ended stale');
  PERFORM cp.eq(cp.ox('old'),'cancelled/stale','stale run effect cancelled');
  PERFORM cp.eq(cp.st('young'),'sleeping/-','credits pause <24h kept');
  UPDATE public.tenants SET credits_remaining=1 WHERE id='${A}';
  PERFORM cp.eq(cp.leased(),'{young}'::text[],'young run resumes after top-up');
  PERFORM cp.done('young');
 END $t$;`},"160000 behaviour");
 // NULL balance (non-number) fails closed; missing column = not paused.
 ok("credits",{sql:`ALTER TABLE public.tenants ALTER COLUMN credits_remaining DROP NOT NULL;
  UPDATE public.tenants SET credits_remaining=NULL WHERE id='${A}';
  DO $t$ BEGIN PERFORM cp.eq(public.flow_channel_temporarily_paused('${A}','${ACC}'),true,'NULL credits paused'); END $t$;
  UPDATE public.tenants SET credits_remaining=5 WHERE id='${A}';
  ALTER TABLE public.tenants ALTER COLUMN credits_remaining SET NOT NULL;`},"null credits");
 // Privileges unchanged: service_role only.
 ok("credits",{sql:`SET ROLE authenticated; DO $t$ BEGIN
  BEGIN PERFORM public.flow_channel_temporarily_paused('${A}','${ACC}'); RAISE EXCEPTION 'authenticated may probe';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $t$;`},"privileges");
 // Idempotent re-apply; 150000 re-apply and older rollbacks refused while 160000 is installed.
 ok("credits",{file:MIG},"160000 re-applied");
 refused("credits",TK,/Unrecognized existing function public\.flow_channel_temporarily_paused/,"150000 re-apply after 160000");
 for(const f of [TK_RB,AI_RB,LC_RB])refused("credits",f,/roll back 20261029160000_flow_credits_pause first/,f);
 // Rollback restores the exact 150000 definition, marker and privileges.
 ok("credits",{file:RB},"160000 rollback");
 assert.equal(ok("credits",{sql:FN_SRC},"fp").stdout,fn150,"exact 150000 definition restored");
 refused("credits",RB,/nothing to roll back/,"160000 rollback twice");
 ok("credits",{sql:`UPDATE public.tenants SET credits_remaining=0 WHERE id='${A}';
  SET ROLE service_role; DO $t$ BEGIN
  PERFORM cp.run('after_rb','1 minute');
  PERFORM cp.eq(cp.leased(),'{after_rb}'::text[],'150000 behaviour back after rollback');
  PERFORM cp.done('after_rb'); END $t$;`},"rollback behaviour");
 // Full chain still rolls back in order and re-applies.
 ok("credits",{file:TK_RB},"150000 rollback");
 ok("credits",{file:AI_RB},"140000 rollback");
 ok("credits",{file:LC_RB},"130000 rollback");
 refused("credits",MIG,/apply 20261029130000_flow_run_lifecycle first/,"160000 without 130000");
 ok("credits",{file:LC},"130000 re-applied");
 refused("credits",MIG,/apply 20261029140000_flow_outbox_ai_retry first/,"160000 without 140000");
 ok("credits",{file:AI},"140000 re-applied");
 refused("credits",MIG,/apply 20261029150000_flow_takeover_resume first/,"160000 without 150000");
 ok("credits",{file:TK},"150000 re-applied");
 ok("credits",{file:MIG},"160000 re-applied");
 // 130000 re-applied after 160000 (operator hazard): 160000 refuses to re-apply on the 130000 lease body.
 ok("credits",{file:LC},"130000 re-applied after 160000");
 refused("credits",MIG,/flow_lease_due_runs is not the 20261029150000 version/,"160000 on a 130000 lease body");
});
