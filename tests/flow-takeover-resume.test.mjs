// 20261029150000_flow_takeover_resume: canonical takeover column and
// resumable pauses. Static checks always run; behavioural checks run against
// a THROWAWAY local PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) when PostgreSQL server binaries are
// present. Never connects to any remote host or connection string.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";

const MIG="supabase/migrations/20261029150000_flow_takeover_resume.sql";
const RB="supabase/rollbacks/20261029150000_flow_takeover_resume.rollback.sql";
const LC="supabase/migrations/20261029130000_flow_run_lifecycle.sql";
const LC_RB="supabase/rollbacks/20261029130000_flow_run_lifecycle.rollback.sql";
const AI="supabase/migrations/20261029140000_flow_outbox_ai_retry.sql";
const AI_RB="supabase/rollbacks/20261029140000_flow_outbox_ai_retry.rollback.sql";
const migration=readFileSync(MIG,"utf8");
const rollback=readFileSync(RB,"utf8");
const lifecycle=readFileSync(LC,"utf8");

// ---------------------------------------------------------------- static
test("150000 follows 130000/140000; only 160000 (credits pause) and 170000 (canary claim), which depend on it, are newer",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql"))
  .map(f=>f.split("_")[0].padEnd(14,"0"));
 // 20261029180000_flow_durable_button_run_guards requires 170000 (and this migration).
 // 20261029190000_flow_begin_durable_run_superseding requires 180000 (and this migration).
 // 20261029200000_flow_media_storage is an independent storage bucket (no flow object).
 // 20261029210000_flow_media_effects requires 190000 (and this migration) (tests/flow-media-effects.test.mjs).
 // 20261029220000_flow_media_stale_sweep requires 210000 (tests/flow-media-stale-sweep.test.mjs).
 // 20261029230000_flow_multichannel_support requires 220000 (tests/flow-multichannel-support.test.mjs).
 const successors=["20261029160000","20261029170000","20261029180000","20261029190000","20261029200000","20261029210000","20261029220000","20261029230000","20261029240000","20261029250000","20261029260000","20261029270000","20261029280000","20261029290000","20261029300000","20261029310000","20261029320000","20261029330000"];
 for(const s of stamps)if(s!=="20261029150000"&&!successors.includes(s))assert.ok(s<"20261029150000",s);
 assert.ok(existsSync(LC)&&existsSync(AI));
});
test("migration is additive, bounded and has no secrets/cron/drops",()=>{
 assert.match(migration,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m);
 assert.doesNotMatch(migration,/\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION|TRIGGER|CONSTRAINT)\b/i);
 assert.doesNotMatch(migration,/\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b|\bUPDATE\s+public\./i);
 assert.doesNotMatch(migration,/cron\.schedule|vault\.|net\.http_|sb_secret_|eyJ[A-Za-z0-9_-]{30,}/);
 assert.doesNotMatch(migration,/CREATE\s+FUNCTION/i,"CREATE OR REPLACE only");
 assert.doesNotMatch(migration,/SECURITY DEFINER/);
 assert.doesNotMatch(migration,/TO\s+(anon|authenticated)\b/);
 assert.match(migration,/CREATE OR REPLACE FUNCTION public\.flow_lease_due_runs\(p_limit integer DEFAULT 20\)\s*RETURNS TABLE\(tenant_id uuid,run_id uuid,lease_token uuid\)/);
 assert.match(migration,/CREATE OR REPLACE FUNCTION public\.flow_conversation_human_takeover\(\s*p_tenant uuid,p_conversation uuid\)\s*RETURNS boolean/);
 for(const s of ["flow_conversation_human_takeover(uuid,uuid)","flow_lease_due_runs(integer)",
  "flow_channel_temporarily_paused(uuid,uuid)","flow_end_stale_paused_runs(integer,integer)"]){
  const e=s.replace(/[()]/g,"\\$&");
  assert.match(migration,new RegExp(`REVOKE ALL ON FUNCTION public\\.${e} FROM PUBLIC,anon,authenticated;`));
  assert.match(migration,new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${e} TO service_role;`));
 }
 // Replaced functions keep the lifecycle marker; new ones carry the 150000 marker.
 assert.match(migration,/flow_lease_due_runs\(integer\)\n IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'/);
 assert.match(migration,/flow_conversation_human_takeover\(uuid,uuid\)\n IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'/);
 assert.match(migration,/flow_end_stale_paused_runs\(integer,integer\)\n IS 'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME'/);
});
test("takeover helper reads only the canonical column",()=>{
 const body=migration.match(/\$takeover\$[\s\S]*?\$takeover\$/)[0];
 assert.match(body,/human_agent_expires_at/);
 assert.doesNotMatch(body,/human_agent_until/);
 assert.match(body,/'manual_takeover'/);
});
test("lease no longer ends runs on auto_reply/agent_enabled/is_active",()=>{
 const body=migration.match(/\$lease\$[\s\S]*?\$lease\$/)[0];
 assert.doesNotMatch(body,/auto_reply|agent_enabled|is_active'/);
 assert.match(body,/AND NOT public\.flow_channel_temporarily_paused\(run\.tenant_id,run\.channel_account_id\)\n  ORDER BY/);
 assert.match(body,/PERFORM public\.flow_end_stale_paused_runs\(1440,100\);/);
});
test("rollback restores the exact 130000 bodies and has bounded timeouts",()=>{
 for(const [start,end] of [["CREATE OR REPLACE FUNCTION public.flow_conversation_human_takeover(","$takeover$;"],
  ["CREATE OR REPLACE FUNCTION public.flow_lease_due_runs(","$lease$;"]]){
  const i=lifecycle.indexOf(start);
  const original=lifecycle.slice(i,lifecycle.indexOf(end,i)+end.length);
  assert.ok(original.length>200);
  assert.ok(rollback.includes(original),start);
 }
 assert.match(rollback,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m);
 assert.match(rollback,/DROP FUNCTION IF EXISTS public\.flow_end_stale_paused_runs\(integer,integer\);/);
 assert.match(rollback,/DROP FUNCTION IF EXISTS public\.flow_channel_temporarily_paused\(uuid,uuid\);/);
});
test("older rollbacks refuse while 150000 objects exist",()=>{
 for(const f of [AI_RB,LC_RB]){
  const src=readFileSync(f,"utf8");
  const guard=src.slice(src.indexOf("BEGIN;"),src.indexOf("DROP "));
  assert.match(guard,/flow_channel_temporarily_paused\(uuid,uuid\)/,f);
  assert.match(guard,/flow_end_stale_paused_runs\(integer,integer\)/,f);
  assert.match(guard,/RAISE EXCEPTION '[^']*roll back 20261029150000_flow_takeover_resume first'/,f);
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
function psql(db,{file,sql}){
 const args=["-X","-q","-v","ON_ERROR_STOP=1","-h",dir,"-p",String(port),"-U","postgres","-d",db,"-tA"];
 if(file)args.push("-f",file);
 return spawnSync(join(BIN,"psql"),args,{encoding:"utf8",input:sql??undefined});
}
function ok(db,src,label){
 const r=psql(db,src);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return r;
}
before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-takeover-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+13)%20000);
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
const ACC2="99999999-9999-4999-8999-999999999999";
// Same order as the CI outbox job, then 130000, 140000 (and optionally 150000).
function bootstrap(db,{withRoles,upTo}){
 let shape=readFileSync("tests/sql/fixtures/flow-live-shape-bootstrap.sql","utf8");
 if(!withRoles)shape=shape.split("\n").filter(l=>!l.startsWith("CREATE ROLE ")).join("\n");
 ok(db,{sql:shape},"live shape");
 const files=["tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
  "tests/sql/flow-exclusive-claim-bootstrap.sql","supabase/migrations/20261028220000_webhook_exclusive_claim.sql",
  "supabase/migrations/20261028224000_delivery_attempts.sql","supabase/migrations/20261028225000_flow_runtime_advance.sql",
  "tests/sql/flow-phase4-runtime-bootstrap.sql","tests/sql/flow-outbox-delivery-bootstrap.sql",
  "supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql",LC,AI,MIG];
 for(const f of files.slice(0,files.indexOf(upTo)+1))ok(db,{file:f},f);
 ok(db,{sql:SEED},"seed");
}
// Live-only optional columns with production names/types (schema.sql,
// omnichannel migrations, human_agent_migration.sql).
const SEED=`
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,ADD COLUMN auto_reply boolean NOT NULL DEFAULT true;
ALTER TABLE public.conversations ADD COLUMN transferred boolean NOT NULL DEFAULT false,
 ADD COLUMN auto_paused_reason text,ADD COLUMN human_agent_expires_at timestamptz;
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES('${ACC2}','${A}','instagram','instagram');
GRANT SELECT ON public.tenants,public.channel_accounts,public.conversations TO service_role;
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
VALUES('${A}','live',1,'${ACC}','instagram','{"version":3,"nodes":[],"edges":[]}','88888888-8888-4888-8888-888888888888'),
      ('${A}','old',1,'${ACC}','instagram','{"version":3,"nodes":[],"edges":[]}','88888888-8888-4888-8888-888888888888'),
      ('${A}','live2',1,'${ACC2}','instagram','{"version":3,"nodes":[],"edges":[]}','88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active)
VALUES('${A}','${ACC}','instagram','live',1,true),('${A}','${ACC}','instagram','old',1,false),
      ('${A}','${ACC2}','instagram','live2',1,true);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only) VALUES('${A}',true,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
CREATE SCHEMA tr;
GRANT USAGE ON SCHEMA tr TO service_role;
CREATE TABLE tr.ids(name text PRIMARY KEY,id uuid NOT NULL);
GRANT SELECT,INSERT ON tr.ids TO service_role;
CREATE FUNCTION tr.id(p text) RETURNS uuid LANGUAGE sql STABLE AS $f$SELECT id FROM tr.ids WHERE name=p$f$;
CREATE FUNCTION tr.conv(p_acc uuid DEFAULT '${ACC}') RETURNS uuid LANGUAGE sql AS $f$
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(gen_random_uuid(),'${A}',p_acc,'instagram:'||gen_random_uuid()) RETURNING id$f$;
CREATE FUNCTION tr.run(p_name text,p_wake interval,p_flow text DEFAULT 'live',
 p_acc uuid DEFAULT '${ACC}',p_conv uuid DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE ev text:='ev-'||gen_random_uuid(); v uuid; c uuid:=coalesce(p_conv,tr.conv(p_acc));
BEGIN
 INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
 VALUES('${A}',p_acc,'instagram',ev);
 INSERT INTO public.automation_flow_runs(tenant_id,flow_key,publication_revision,channel_account_id,
  platform,conversation_id,provider_event_id,current_node_id,run_status,wake_at)
 VALUES('${A}',p_flow,1,p_acc,'instagram',c,ev,'n1','sleeping',now()-p_wake) RETURNING id INTO v;
 INSERT INTO tr.ids VALUES(p_name,v),(p_name||'_conv',c);
 INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
 VALUES('${A}',v,'k-'||p_name,'message','{"kind":"message","text":"hi"}'::jsonb)
 RETURNING id INTO c;
 INSERT INTO tr.ids VALUES(p_name||'_fx',c);
 RETURN v;
END $f$;
CREATE FUNCTION tr.eq(got anycompatible,want anycompatible,label text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF got IS DISTINCT FROM want THEN
 RAISE EXCEPTION 'ASSERT FAILED [%]: got % want %',label,got,want; END IF; END $f$;
CREATE FUNCTION tr.st(p text) RETURNS text LANGUAGE sql STABLE AS $f$
 SELECT run_status||'/'||coalesce(ended_reason,'-') FROM public.automation_flow_runs WHERE id=tr.id(p)$f$;
CREATE FUNCTION tr.ox(p text) RETURNS text LANGUAGE sql STABLE AS $f$
 SELECT delivery_status||'/'||coalesce(cancel_reason,'-') FROM public.automation_flow_outbox WHERE id=tr.id(p||'_fx')$f$;
CREATE FUNCTION tr.leased() RETURNS text[] LANGUAGE sql AS $f$
 SELECT coalesce(array_agg(n.name ORDER BY n.name),'{}') FROM public.flow_lease_due_runs(20) l
 JOIN tr.ids n ON n.id=l.run_id$f$;
CREATE FUNCTION tr.has_lease(p text) RETURNS boolean LANGUAGE sql STABLE AS $f$
 SELECT EXISTS(SELECT 1 FROM public.automation_flow_run_leases WHERE run_id=tr.id(p))$f$;
CREATE FUNCTION tr.done(p text) RETURNS void LANGUAGE sql AS $f$
 SELECT tr.eq(public.flow_commit_run_step('${A}',tr.id(p),0,'sleeping','end',1,'completed',
  '{}'::jsonb,NULL,'[]'::jsonb,'completed',
  (SELECT token FROM public.automation_flow_run_leases WHERE run_id=tr.id(p))),true,'commit '||p)$f$;
CREATE FUNCTION tr.takeover(p text,p_tr boolean,p_why text,p_at interval) RETURNS void LANGUAGE sql AS $f$
 UPDATE public.conversations SET transferred=p_tr,auto_paused_reason=p_why,
  human_agent_expires_at=CASE WHEN p_at IS NULL THEN NULL ELSE now()+p_at END
 WHERE id=tr.id(p||'_conv')$f$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tr TO service_role;
GRANT UPDATE ON public.conversations,public.channel_accounts,public.tenants TO service_role;
`;

const PAUSE=`
SET ROLE service_role;
DO $t$ BEGIN
 PERFORM tr.run('p','1 minute');
 -- (1) auto_reply off: not leased, NOT ended, effect stays pending
 UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}';
 PERFORM tr.eq(tr.leased(),'{}'::text[],'auto_reply off: no lease');
 PERFORM tr.eq(tr.st('p'),'sleeping/-','auto_reply off: run kept');
 PERFORM tr.eq(tr.ox('p'),'pending/-','auto_reply off: effect kept');
 PERFORM tr.eq(tr.has_lease('p'),false,'auto_reply off: no lease row');
 -- (2) agent_enabled off
 UPDATE public.channel_accounts SET auto_reply=true,agent_enabled=false WHERE id='${ACC}';
 PERFORM tr.eq(tr.leased(),'{}'::text[],'agent off: no lease');
 PERFORM tr.eq(tr.st('p'),'sleeping/-','agent off: run kept');
 -- (3) account inactive, tenant inactive
 UPDATE public.channel_accounts SET agent_enabled=true,is_active=false WHERE id='${ACC}';
 PERFORM tr.eq(tr.leased(),'{}'::text[],'account inactive: no lease');
 UPDATE public.channel_accounts SET is_active=true WHERE id='${ACC}';
 UPDATE public.tenants SET is_active=false WHERE id='${A}';
 PERFORM tr.eq(tr.leased(),'{}'::text[],'tenant inactive: no lease');
 PERFORM tr.eq(tr.st('p'),'sleeping/-','tenant inactive: run kept');
 UPDATE public.tenants SET is_active=true WHERE id='${A}';
 -- (4) re-enabled: leased and proceeds
 PERFORM tr.eq(tr.leased(),'{p}'::text[],'re-enabled: leased');
 PERFORM tr.eq((SELECT attempts FROM public.automation_flow_run_leases WHERE run_id=tr.id('p')),1,'first lease attempt');
 PERFORM tr.done('p');
 PERFORM tr.eq(tr.st('p'),'completed/-','re-enabled: proceeds');
END $t$;
-- (5) paused runs do not occupy the scan window (no head-of-line blocking)
DO $t$ DECLARE i int; BEGIN
 FOR i IN 1..30 LOOP PERFORM tr.run('hol'||i,'3 hours'::interval-i*interval '1 second','live2','${ACC2}'); END LOOP;
 PERFORM tr.run('fresh','1 minute');
 UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC2}';
 PERFORM tr.eq((SELECT array_agg(n.name) FROM public.flow_lease_due_runs(1) l JOIN tr.ids n ON n.id=l.run_id),
  ARRAY['fresh'],'eligible run leased past 30 older paused runs');
 PERFORM tr.eq((SELECT count(*)::int FROM public.automation_flow_runs WHERE channel_account_id='${ACC2}'
  AND run_status='sleeping' AND ended_reason IS NULL),30,'paused runs untouched');
 PERFORM tr.done('fresh');
END $t$;
-- (6) bounded safeguard: paused beyond max age ends 'stale'
DO $t$ BEGIN
 PERFORM tr.run('old_pause','25 hours','live2','${ACC2}');
 PERFORM tr.run('young_pause','23 hours','live2','${ACC2}');
 PERFORM tr.eq(tr.leased(),'{}'::text[],'stale: nothing leased');
 PERFORM tr.eq(tr.st('old_pause'),'blocked/stale','paused >24h ended stale');
 PERFORM tr.eq(tr.ox('old_pause'),'cancelled/stale','stale run effect cancelled');
 PERFORM tr.eq(tr.st('young_pause'),'sleeping/-','paused <24h kept');
 -- parameterized and clamped (p_max_age 1 -> 60 minutes, p_limit 0 -> 1)
 PERFORM tr.eq(public.flow_end_stale_paused_runs(1,0),1,'clamped limit=1');
 PERFORM tr.eq(public.flow_end_stale_paused_runs(1,500),30,'clamped age=60min');
 PERFORM tr.eq(tr.st('young_pause'),'blocked/stale','explicit shorter age');
 PERFORM tr.eq(public.flow_end_stale_paused_runs(NULL,NULL),0,'defaults, nothing left');
 PERFORM tr.eq(public.flow_end_stale_paused_runs(999999,999999),0,'upper clamp ok');
 UPDATE public.channel_accounts SET auto_reply=true WHERE id='${ACC2}';
 -- an eligible (not paused) old run is NOT ended stale: it is leased
 PERFORM tr.run('old_ok','30 hours');
 PERFORM tr.eq(tr.leased(),'{old_ok}'::text[],'old eligible run leased, not stale');
 PERFORM tr.done('old_ok');
END $t$;
RESET ROLE;
-- tenant switch gate: kept while fresh, ended stale past max age
UPDATE public.automation_flow_tenant_switches SET enabled=false WHERE tenant_id='${A}';
SET ROLE service_role;
DO $t$ BEGIN
 PERFORM tr.run('sw_new','5 minutes'); PERFORM tr.run('sw_old','2 days');
 PERFORM tr.eq(tr.leased(),'{}'::text[],'switch off: nothing leased');
 PERFORM tr.eq(tr.st('sw_new'),'sleeping/-','switch off fresh kept');
 PERFORM tr.eq(tr.st('sw_old'),'blocked/stale','switch off >24h stale');
END $t$;
RESET ROLE;
UPDATE public.automation_flow_tenant_switches SET enabled=true WHERE tenant_id='${A}';
-- global OFF freezes everything (no lease, no stale ending)
UPDATE public.automation_flow_global_switch SET enabled=false;
UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}';
SET ROLE service_role;
DO $t$ BEGIN
 PERFORM tr.run('g_old','3 days');
 PERFORM tr.eq(tr.leased(),'{}'::text[],'global off');
 PERFORM tr.eq(tr.st('g_old'),'sleeping/-','global off: not ended');
END $t$;
RESET ROLE;
UPDATE public.automation_flow_global_switch SET enabled=true;
UPDATE public.channel_accounts SET auto_reply=true WHERE id='${ACC}';
SET ROLE service_role;
DO $t$ BEGIN
 PERFORM tr.eq(tr.leased(),'{g_old,sw_new}'::text[],'resumed after global on');
 PERFORM tr.done('g_old'); PERFORM tr.done('sw_new');
END $t$;
RESET ROLE;
`;

const PERMANENT=`
SET ROLE service_role;
DO $t$ BEGIN
 -- revision inactive still ends the run
 PERFORM tr.run('rev','1 minute','old');
 -- takeover variants on the canonical columns
 PERFORM tr.run('ht_live','1 minute'); PERFORM tr.takeover('ht_live',true,'manual_takeover','1 hour');
 PERFORM tr.run('ht_null','1 minute'); PERFORM tr.takeover('ht_null',true,'manual_takeover',NULL);
 PERFORM tr.run('ht_ai','1 minute');   PERFORM tr.takeover('ht_ai',true,'ai_handoff','-1 hour');
 PERFORM tr.run('ht_exp','1 minute');  PERFORM tr.takeover('ht_exp',true,'manual_takeover','-1 hour');
 PERFORM tr.run('ht_off','1 minute');  PERFORM tr.takeover('ht_off',false,NULL,'1 hour');
 PERFORM tr.eq(tr.leased(),'{ht_exp,ht_off}'::text[],'only non-takeover runs leased');
 PERFORM tr.eq(tr.st('rev'),'blocked/revision_inactive','revision inactive ended');
 PERFORM tr.eq(tr.st('ht_live'),'blocked/human_takeover','live takeover ended');
 PERFORM tr.eq(tr.ox('ht_live'),'cancelled/human_takeover','live takeover effect skipped');
 PERFORM tr.eq(tr.st('ht_null'),'blocked/human_takeover','takeover without expiry ended');
 PERFORM tr.eq(tr.st('ht_ai'),'blocked/human_takeover','expired ai_handoff still a takeover');
 PERFORM tr.eq(tr.st('ht_exp'),'sleeping/-','expired manual takeover NOT ended');
 PERFORM tr.eq(tr.st('ht_off'),'sleeping/-','transferred=false NOT ended');
 PERFORM tr.done('ht_exp'); PERFORM tr.done('ht_off');
 PERFORM tr.eq(public.flow_conversation_human_takeover('${A}',gen_random_uuid()),true,'missing conversation fails closed');
END $t$;
-- outbox sweep uses the same helper: expired manual takeover is not cancelled
DO $t$ DECLARE r1 uuid; r2 uuid; BEGIN
 r1:=tr.run('ox_exp','-1 hour'); PERFORM tr.takeover('ox_exp',true,'manual_takeover','-1 minute');
 r2:=tr.run('ox_live','-1 hour'); PERFORM tr.takeover('ox_live',true,'manual_takeover','1 hour');
 PERFORM tr.eq(public.flow_skip_blocked_outbox(60,200),1,'one takeover effect swept');
 PERFORM tr.eq(tr.ox('ox_live'),'cancelled/human_takeover','live takeover effect cancelled');
 PERFORM tr.eq(tr.ox('ox_exp'),'pending/-','expired takeover effect kept');
 PERFORM public.flow_cancel_run('${A}',r1,'manual'); PERFORM public.flow_cancel_run('${A}',r2,'manual');
END $t$;
-- a paused account's fresh effect is not swept; only the 60-minute stale bound applies
DO $t$ DECLARE r uuid; BEGIN
 r:=tr.run('ox_pause','-1 hour','live2','${ACC2}');
 UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC2}';
 PERFORM tr.eq(public.flow_skip_blocked_outbox(60,200),0,'paused effect not swept');
 PERFORM tr.eq(tr.ox('ox_pause'),'pending/-','paused effect pending');
 UPDATE public.automation_flow_outbox SET created_at=now()-interval '2 hours' WHERE id=tr.id('ox_pause_fx');
 PERFORM tr.eq(public.flow_skip_blocked_outbox(60,200),1,'stale bound');
 PERFORM tr.eq(tr.ox('ox_pause'),'cancelled/stale','stale after 60 minutes');
 UPDATE public.channel_accounts SET auto_reply=true WHERE id='${ACC2}';
 PERFORM public.flow_cancel_run('${A}',r,'manual');
END $t$;
RESET ROLE;
-- malformed expiry fails closed (column temporarily text in this throwaway DB)
ALTER TABLE public.conversations ALTER COLUMN human_agent_expires_at TYPE text;
DO $t$ DECLARE c uuid:=tr.conv(); BEGIN
 UPDATE public.conversations SET transferred=true,auto_paused_reason='manual_takeover',
  human_agent_expires_at='garbage' WHERE id=c;
 PERFORM tr.eq(public.flow_conversation_human_takeover('${A}',c),true,'garbage expiry fails closed');
 UPDATE public.conversations SET human_agent_expires_at='2000-01-01T00:00:00Z' WHERE id=c;
 PERFORM tr.eq(public.flow_conversation_human_takeover('${A}',c),false,'parsable expired');
END $t$;
ALTER TABLE public.conversations ALTER COLUMN human_agent_expires_at TYPE timestamptz USING human_agent_expires_at::timestamptz;
-- privileges
SET ROLE authenticated;
DO $t$ BEGIN
 BEGIN PERFORM public.flow_end_stale_paused_runs(1440,1); RAISE EXCEPTION 'authenticated may end runs';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.flow_channel_temporarily_paused('${A}','${ACC}'); RAISE EXCEPTION 'authenticated may probe';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $t$;
RESET ROLE;
`;

test("live PG: temporary pauses resume, stale bound, permanent endings, canonical takeover",{skip},()=>{
 ok("postgres",{sql:"CREATE DATABASE resume;"},"createdb");
 bootstrap("resume",{withRoles:true,upTo:MIG});
 ok("resume",{sql:PAUSE},"pause behaviour");
 ok("resume",{sql:PERMANENT},"permanent behaviour");
 ok("resume",{file:MIG},"150000 re-applied (idempotent)");
 ok("resume",{sql:`SET ROLE service_role; DO $t$ BEGIN
  PERFORM tr.run('p_again','1 minute');
  UPDATE public.channel_accounts SET agent_enabled=false WHERE id='${ACC}';
  PERFORM tr.eq(tr.leased(),'{}'::text[],'paused after re-apply');
  PERFORM tr.eq(tr.st('p_again'),'sleeping/-','kept after re-apply');
  UPDATE public.channel_accounts SET agent_enabled=true WHERE id='${ACC}';
  PERFORM tr.eq(tr.leased(),'{p_again}'::text[],'resumed after re-apply');
 END $t$;`},"pause behaviour after re-apply");
});

const SNAP=`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'c:'||a.attrelid::regclass::text||'.'||a.attname FROM pg_attribute a
  JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'k:'||conname||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 't:'||tgname FROM pg_trigger WHERE NOT tgisinternal
 UNION ALL SELECT 'r:'||md5(coalesce(string_agg(r::text,',' ORDER BY r.id),'')) FROM public.automation_flow_runs r
 UNION ALL SELECT 'o:'||md5(coalesce(string_agg(o::text,',' ORDER BY o.id),'')) FROM public.automation_flow_outbox o
) s(x);`;
const FN_SRC=`SELECT md5(string_agg(p.oid::regprocedure::text||':'||md5(p.prosrc)||':'||
 coalesce(obj_description(p.oid,'pg_proc'),'')||':'||coalesce(array_to_string(p.proacl,','),''),'|' ORDER BY p.oid::regprocedure::text))
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  AND p.proname IN('flow_lease_due_runs','flow_conversation_human_takeover');`;

test("live PG: rollback order 150000 -> 140000 -> 130000; wrong order refused; re-apply works",{skip},()=>{
 ok("postgres",{sql:"CREATE DATABASE rborder;"},"createdb");
 bootstrap("rborder",{withRoles:false,upTo:AI});
 const lifecycleFns=ok("rborder",{sql:FN_SRC},"130000 function fingerprint").stdout;
 // 150000 rollback when 150000 is not installed is refused.
 let r=psql("rborder",{file:RB});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/20261029150000_flow_takeover_resume not installed/);
 ok("rborder",{file:MIG},"150000");
 assert.notEqual(ok("rborder",{sql:FN_SRC},"fp").stdout,lifecycleFns,"150000 replaced the bodies");
 ok("rborder",{sql:`SET ROLE service_role; SELECT tr.run('seed','1 minute');
  UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}';
  DO $t$ BEGIN PERFORM tr.eq(tr.leased(),'{}'::text[],'paused'); PERFORM tr.eq(tr.st('seed'),'sleeping/-','kept'); END $t$;`},"seed");
 // Wrong order: 140000 and 130000 rollbacks are refused and change nothing.
 for(const f of [AI_RB,LC_RB]){
  const before=ok("rborder",{sql:SNAP},"snapshot").stdout;
  r=psql("rborder",{file:f});
  assert.notEqual(r.status,0,`${f} must be refused while 150000 is installed`);
  assert.match(r.stderr,/roll back 20261029150000_flow_takeover_resume first/,f);
  assert.equal(ok("rborder",{sql:SNAP},"snapshot").stdout,before,`${f} refused without changes`);
 }
 // Correct order.
 ok("rborder",{file:RB},"150000 rollback");
 assert.equal(ok("rborder",{sql:FN_SRC},"fp").stdout,lifecycleFns,"exact 130000 definitions restored");
 ok("rborder",{sql:`DO $t$ BEGIN
  IF to_regprocedure('public.flow_end_stale_paused_runs(integer,integer)') IS NOT NULL
  OR to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)') IS NOT NULL
  THEN RAISE EXCEPTION '150000 rollback incomplete'; END IF; END $t$;
  SET ROLE service_role;
  DO $t$ BEGIN PERFORM tr.eq(tr.leased(),'{}'::text[],'130000 behaviour');
   PERFORM tr.eq(tr.st('seed'),'blocked/ineligible','130000 ends paused run again'); END $t$;`},"150000 rollback verified");
 // 150000 preflight refuses on a database without 140000.
 ok("rborder",{file:AI_RB},"140000 rollback");
 r=psql("rborder",{file:MIG});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/apply 20261029140000_flow_outbox_ai_retry first/);
 ok("rborder",{file:LC_RB},"130000 rollback");
 r=psql("rborder",{file:MIG});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/apply 20261029130000_flow_run_lifecycle first/);
 // Re-apply in migration order.
 ok("rborder",{file:LC},"130000 re-applied");
 ok("rborder",{file:AI},"140000 re-applied");
 ok("rborder",{file:MIG},"150000 re-applied");
 ok("rborder",{sql:`UPDATE public.channel_accounts SET auto_reply=true WHERE id='${ACC}';
  SET ROLE service_role; DO $t$ BEGIN
  PERFORM tr.run('again','1 minute');
  UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}';
  PERFORM tr.eq(tr.leased(),'{}'::text[],'paused after re-apply');
  PERFORM tr.eq(tr.st('again'),'sleeping/-','kept after re-apply');
  UPDATE public.channel_accounts SET auto_reply=true WHERE id='${ACC}';
  PERFORM tr.eq(tr.leased(),'{again}'::text[],'resumed after re-apply');
 END $t$;`},"re-apply verified");
});
