// knowledge_ai outbox retry migration (20261029140000): static checks always
// run; behavioural checks run against a THROWAWAY local PostgreSQL cluster
// (temporary data dir, unix socket only, listen_addresses='', removed after)
// when PostgreSQL server binaries are present. Never connects to any remote
// host or connection string.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";

const MIG="supabase/migrations/20261029140000_flow_outbox_ai_retry.sql";
const RB="supabase/rollbacks/20261029140000_flow_outbox_ai_retry.rollback.sql";
const LIFECYCLE="supabase/migrations/20261029130000_flow_run_lifecycle.sql";
const migration=readFileSync(MIG,"utf8");
const rollback=readFileSync(RB,"utf8");
const SIGS=["flow_claim_outbox_ai(uuid,uuid,integer,integer)",
 "flow_store_outbox_ai_answer(uuid,uuid,uuid,text)",
 "flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer)"];

// ---------------------------------------------------------------- static
test("AI retry migration is the newest migration and later than the lifecycle migration",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql"))
  .map(f=>f.split("_")[0].padEnd(14,"0"));
 const mine="20261029140000";
 // 20261029150000_flow_takeover_resume depends on this migration (its
 // preflight requires the 140000 functions) and may follow it.
 // 20261029160000_flow_credits_pause requires 150000 (and this migration).
 // 20261029170000_flow_canary_claim_durable requires 160000 (and this migration).
 // 20261029180000_flow_durable_button_run_guards requires 170000 (and this migration).
 // 20261029190000_flow_begin_durable_run_superseding requires 180000 (and this migration).
 // 20261029200000_flow_media_storage is an independent storage bucket (no flow object).
 // 20261029210000_flow_media_effects requires 190000 (and this migration) (tests/flow-media-effects.test.mjs).
 // 20261029220000_flow_media_stale_sweep requires 210000 (tests/flow-media-stale-sweep.test.mjs).
 // 20261029230000_flow_multichannel_support requires 220000 (tests/flow-multichannel-support.test.mjs).
 const successors=["20261029150000","20261029160000","20261029170000","20261029180000","20261029190000",
  "20261029200000","20261029210000","20261029220000","20261029230000","20261029240000","20261029250000","20261029260000","20261029270000","20261029280000","20261029290000","20261029300000"];
 for(const s of stamps)if(s!==mine&&!successors.includes(s))
  assert.ok(s<mine,`older migration ${s} must precede ${mine}`);
 assert.ok(existsSync(LIFECYCLE));
});
test("migration is additive: no status CHECK change, no drops except the superset cancel_reason CHECK",()=>{
 assert.doesNotMatch(migration,/\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION|TRIGGER)\b/i);
 assert.doesNotMatch(migration,/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
 assert.doesNotMatch(migration,/cron\.schedule|vault\.|net\.http_|sb_secret_|eyJ[A-Za-z0-9_-]{30,}/);
 assert.doesNotMatch(migration,/CREATE\s+FUNCTION/i,"CREATE OR REPLACE only");
 assert.doesNotMatch(migration,/SECURITY DEFINER/);
 const drops=migration.match(/DROP CONSTRAINT[^;]*;/g)??[];
 assert.deepEqual(drops,["DROP CONSTRAINT IF EXISTS automation_flow_outbox_cancel_reason_chk;"]);
 // Every lifecycle reason survives in the replacement CHECK.
 const lifecycle=readFileSync(LIFECYCLE,"utf8");
 const old=lifecycle.match(/automation_flow_outbox_cancel_reason_chk CHECK\(\s*cancel_reason IS NULL OR cancel_reason IN\(([\s\S]*?)\)\)/)[1];
 const neu=migration.match(/automation_flow_outbox_cancel_reason_chk CHECK\(\s*cancel_reason IS NULL OR cancel_reason IN\(([\s\S]*?)\)\)/)[1];
 const list=s=>s.split(",").map(x=>x.trim().replace(/'/g,"")).filter(Boolean);
 for(const r of list(old))assert.ok(list(neu).includes(r),r);
 assert.deepEqual(list(neu).filter(r=>!list(old).includes(r)),["no_knowledge","ai_unavailable","ai_retries_exhausted"]);
 assert.doesNotMatch(migration,/ALTER TABLE[^;]*delivery_status[^;]*CHECK/i);
 assert.match(migration,/ADD COLUMN IF NOT EXISTS ai_attempts integer NOT NULL DEFAULT 0/);
});
test("functions are service_role only and the rollback removes them",()=>{
 for(const s of SIGS){
  const e=s.replace(/[()]/g,"\\$&");
  assert.match(migration,new RegExp(`REVOKE ALL ON FUNCTION public\\.${e} FROM PUBLIC,anon,authenticated;`));
  assert.match(migration,new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${e} TO service_role;`));
  assert.match(rollback,new RegExp(`DROP FUNCTION IF EXISTS public\\.${e};`));
 }
 assert.doesNotMatch(migration,/TO\s+(anon|authenticated)\b/);
});
const LIFECYCLE_RB="supabase/rollbacks/20261029130000_flow_run_lifecycle.rollback.sql";
test("both rollbacks set bounded lock/statement timeouts right after BEGIN",()=>{
 for(const src of [rollback,readFileSync(LIFECYCLE_RB,"utf8")])
  assert.match(src,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m);
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
function psqlArgs(db){return ["-X","-q","-t","-A","-v","ON_ERROR_STOP=1","-h",dir,"-p",String(port),"-U","postgres","-d",db];}
function psql(db,{file,sql}){
 const args=psqlArgs(db);
 if(file)args.push("-f",file);
 return spawnSync(join(BIN,"psql"),args,{encoding:"utf8",input:sql??undefined});
}
function ok(db,src,label){
 const r=psql(db,src);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return r;
}
function psqlAsync(db,sql){
 return new Promise(res=>{
  const p=spawn(join(BIN,"psql"),psqlArgs(db));
  let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
  p.on("close",code=>res({code,out,err}));
  p.stdin.end(sql);
 });
}

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-ai-retry-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+7)%20000);
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
const RUN="77777777-7777-4777-8777-7777777777a4";
// Same order as the CI "Outbox send ledger" job, then lifecycle, then this migration.
function bootstrap(db,{withRoles}){
 let shape=readFileSync("tests/sql/fixtures/flow-live-shape-bootstrap.sql","utf8");
 if(!withRoles)shape=shape.split("\n").filter(l=>!l.startsWith("CREATE ROLE ")).join("\n");
 ok(db,{sql:shape},"live shape");
 for(const f of ["tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
  "tests/sql/flow-exclusive-claim-bootstrap.sql","supabase/migrations/20261028220000_webhook_exclusive_claim.sql",
  "supabase/migrations/20261028224000_delivery_attempts.sql","supabase/migrations/20261028225000_flow_runtime_advance.sql",
  "tests/sql/flow-phase4-runtime-bootstrap.sql","tests/sql/flow-outbox-delivery-bootstrap.sql",
  "supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql",LIFECYCLE])
  ok(db,{file:f},f);
 ok(db,{file:MIG},"migration");
 // Helpers reference the new columns, so they are created after the migration.
 ok(db,{sql:SEED},"seed");
}
const SEED=`
UPDATE public.automation_flow_global_switch SET enabled=true;
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only)
VALUES('${A}',true,true),('${B}',true,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=true;
CREATE SCHEMA ait;
GRANT USAGE ON SCHEMA ait TO service_role,authenticated;
CREATE TABLE ait.ids(name text PRIMARY KEY,id uuid NOT NULL);
GRANT SELECT,INSERT ON ait.ids TO service_role;
GRANT SELECT ON ait.ids TO authenticated;
CREATE FUNCTION ait.id(p text) RETURNS uuid LANGUAGE sql STABLE AS $f$SELECT id FROM ait.ids WHERE name=p$f$;
CREATE FUNCTION ait.fx(p_name text,p_age interval DEFAULT '0'::interval) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v uuid;
BEGIN
 INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload,created_at)
 VALUES('${A}','${RUN}','ai-'||p_name,'message',
  '{"kind":"message","source":"knowledge_ai"}'::jsonb,now()-p_age) RETURNING id INTO v;
 INSERT INTO ait.ids VALUES(p_name,v);
 RETURN v;
END $f$;
CREATE FUNCTION ait.eq(got anycompatible,want anycompatible,label text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF got IS DISTINCT FROM want THEN
 RAISE EXCEPTION 'ASSERT FAILED [%]: got % want %',label,got,want; END IF; END $f$;
CREATE FUNCTION ait.ox(p uuid) RETURNS text LANGUAGE sql STABLE AS $f$
 SELECT delivery_status||'/'||coalesce(cancel_reason,'-')||'/'||ai_attempts||'/'||coalesce(ai_last_error_code,'-')
 FROM public.automation_flow_outbox WHERE id=p$f$;
CREATE FUNCTION ait.claim(p uuid) RETURNS record LANGUAGE sql AS $f$
 SELECT (c.outcome,c.claim_token,c.attempt,c.answer_encrypted)
 FROM public.flow_claim_outbox_ai('${A}',p,5,120) c$f$;
CREATE FUNCTION ait.outcome(p uuid) RETURNS text LANGUAGE sql AS $f$
 SELECT c.outcome FROM public.flow_claim_outbox_ai('${A}',p,5,120) c$f$;
CREATE FUNCTION ait.token(p uuid) RETURNS uuid LANGUAGE sql STABLE AS $f$
 SELECT ai_lease_token FROM public.automation_flow_outbox WHERE id=p$f$;
-- Mirror of the worker list filter (index.ts): pending/charge_pending, or due retry_wait.
CREATE FUNCTION ait.listed(p_limit int) RETURNS uuid[] LANGUAGE sql STABLE AS $f$
 SELECT coalesce(array_agg(id ORDER BY created_at),'{}') FROM (
  SELECT id,created_at FROM public.automation_flow_outbox
  WHERE effect_kind IN('message','question') AND payload->>'source'='knowledge_ai'
   AND (delivery_status IN('pending','charge_pending')
    OR (delivery_status='retry_wait' AND retry_at<=now()))
  ORDER BY created_at LIMIT p_limit) q $f$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ait TO service_role;
`;

const BEHAVIOUR=`
SET ROLE service_role;
DO $t$
DECLARE c record; tok uuid; s text; i int; d interval;
BEGIN
 -- transient: backoff scheduled, NOT cancelled, cannot be reserved while waiting
 PERFORM ait.fx('t1');
 SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('t1'),5,120);
 PERFORM ait.eq(c.outcome,'claimed','T claim'); PERFORM ait.eq(c.attempt,1,'T attempt 1');
 PERFORM ait.eq(ait.outcome(ait.id('t1')),'busy','T second claim while lease live');
 PERFORM ait.eq(public.flow_finish_outbox_ai('${A}',ait.id('t1'),c.claim_token,'retry','ai_http_429',60,5),
  'retry_wait','T retry scheduled');
 PERFORM ait.eq(ait.ox(ait.id('t1')),'retry_wait/-/1/ai_http_429','T state');
 SELECT retry_at-now() INTO d FROM public.automation_flow_outbox WHERE id=ait.id('t1');
 PERFORM ait.eq(d BETWEEN interval '59 seconds' AND interval '61 seconds',true,'T retry_at ~ +60s');
 PERFORM ait.eq(ait.outcome(ait.id('t1')),'not_due','T not due');
 PERFORM ait.eq(public.flow_reserve_outbox_delivery('${A}',ait.id('t1')),false,'T retry_wait cannot be reserved');
 PERFORM ait.eq(public.flow_finish_outbox_ai('${A}',ait.id('t1'),c.claim_token,'retry','x',60,5),NULL::text,'T stale token finish refused');
 UPDATE public.automation_flow_outbox SET retry_at=now()-interval '1 second' WHERE id=ait.id('t1');
 SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('t1'),5,120);
 PERFORM ait.eq((c.outcome,c.attempt)::text,'(claimed,2)','T due again -> claimed attempt 2');
 PERFORM ait.eq(ait.ox(ait.id('t1')),'pending/-/2/ai_http_429','T back to pending under claim');

 -- bounded: attempts 2..5 transient -> dead_letter/ai_retries_exhausted
 FOR i IN 2..5 LOOP
  IF i>2 THEN
   UPDATE public.automation_flow_outbox SET retry_at=now()-interval '1 second' WHERE id=ait.id('t1');
   SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('t1'),5,120);
   PERFORM ait.eq(c.attempt,i,'X attempt '||i);
  END IF;
  s:=public.flow_finish_outbox_ai('${A}',ait.id('t1'),c.claim_token,'retry','ai_http_5xx',(60*2^(i-1))::int,5);
  PERFORM ait.eq(s,CASE WHEN i<5 THEN 'retry_wait' ELSE 'dead_letter' END,'X finish '||i);
 END LOOP;
 PERFORM ait.eq(ait.ox(ait.id('t1')),'dead_letter/ai_retries_exhausted/5/ai_http_5xx','X exhausted');
 PERFORM ait.eq(ait.outcome(ait.id('t1')),'not_claimable','X terminal');
 PERFORM ait.eq(public.flow_skip_outbox_effect('${A}',ait.id('t1'),'manual'),false,'X dead_letter not re-cancelled');

 -- no_knowledge: terminal cancel, distinct reason, never claimable again
 PERFORM ait.fx('nk');
 SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('nk'),5,120);
 PERFORM ait.eq(public.flow_finish_outbox_ai('${A}',ait.id('nk'),c.claim_token,'no_knowledge',NULL,60,5),'cancelled','NK');
 PERFORM ait.eq(ait.ox(ait.id('nk')),'cancelled/no_knowledge/1/-','NK state');
 PERFORM ait.eq((SELECT cancelled_at IS NOT NULL AND retry_at IS NULL FROM public.automation_flow_outbox WHERE id=ait.id('nk')),true,'NK stamps');
 PERFORM ait.eq(ait.outcome(ait.id('nk')),'not_claimable','NK not retried');

 -- permanent: dead_letter/ai_unavailable at attempt 1
 PERFORM ait.fx('pm');
 SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('pm'),5,120);
 PERFORM ait.eq(public.flow_finish_outbox_ai('${A}',ait.id('pm'),c.claim_token,'permanent','ai_http_401',60,5),'dead_letter','PM');
 PERFORM ait.eq(ait.ox(ait.id('pm')),'dead_letter/ai_unavailable/1/ai_http_401','PM state');

 -- free text never stored as an error code; delay clamped to 30..1800 s
 PERFORM ait.fx('cl');
 SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('cl'),5,120);
 PERFORM public.flow_finish_outbox_ai('${A}',ait.id('cl'),c.claim_token,'retry','Bearer sk-secret customer text',99999,5);
 PERFORM ait.eq(ait.ox(ait.id('cl')),'retry_wait/-/1/ai_unknown','CL code sanitized');
 PERFORM ait.eq((SELECT retry_at<=now()+interval '1801 seconds' FROM public.automation_flow_outbox WHERE id=ait.id('cl')),true,'CL clamp max');
 BEGIN
  UPDATE public.automation_flow_outbox SET ai_last_error_code='Free Text' WHERE id=ait.id('cl');
  RAISE EXCEPTION 'CL CHECK missing';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE public.automation_flow_outbox SET cancel_reason='bogus' WHERE id=ait.id('cl');
  RAISE EXCEPTION 'CL cancel_reason CHECK missing';
 EXCEPTION WHEN check_violation THEN NULL; END;

 -- answer stored once under the claim, reused (cached) and sent exactly once
 PERFORM ait.fx('ans');
 SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('ans'),5,120);
 PERFORM ait.eq(public.flow_store_outbox_ai_answer('${A}',ait.id('ans'),gen_random_uuid(),'enc:v1:aa:bb:cc'),false,'ANS wrong token');
 PERFORM ait.eq(public.flow_store_outbox_ai_answer('${B}',ait.id('ans'),c.claim_token,'enc:v1:aa:bb:cc'),false,'ANS cross-tenant');
 PERFORM ait.eq(public.flow_store_outbox_ai_answer('${A}',ait.id('ans'),c.claim_token,'plain text'),false,'ANS must be encrypted');
 PERFORM ait.eq(public.flow_store_outbox_ai_answer('${A}',ait.id('ans'),c.claim_token,'enc:v1:aa:bb:cc'),true,'ANS stored');
 PERFORM ait.eq(public.flow_store_outbox_ai_answer('${A}',ait.id('ans'),c.claim_token,'enc:v1:dd:ee:ff'),false,'ANS not overwritten');
 PERFORM ait.eq(public.flow_finish_outbox_ai('${A}',ait.id('ans'),c.claim_token,'retry','ai_timeout',60,5),NULL::text,'ANS no retry after answer');
 SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('ans'),5,120);
 PERFORM ait.eq((c.outcome,c.attempt,c.answer_encrypted)::text,'(cached,1,enc:v1:aa:bb:cc)','ANS restart -> cached, no new attempt');
 PERFORM ait.eq(public.flow_reserve_outbox_delivery('${A}',ait.id('ans')),true,'ANS reserved once');
 PERFORM ait.eq(public.flow_reserve_outbox_delivery('${A}',ait.id('ans')),false,'ANS second reserve refused');
 PERFORM ait.eq(ait.outcome(ait.id('ans')),'not_claimable','ANS in flight is never re-claimed');
 PERFORM ait.eq((SELECT count(*)::int FROM public.automation_flow_delivery_attempts WHERE outbox_id=ait.id('ans')),1,'ANS one attempt row');

 -- worker killed mid-generation: lease expires, attempt is counted, old token is dead
 PERFORM ait.fx('crash');
 SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('crash'),5,120);
 tok:=c.claim_token;
 PERFORM ait.eq(ait.outcome(ait.id('crash')),'busy','CR lease live');
 UPDATE public.automation_flow_outbox SET ai_lease_expires_at=now()-interval '1 second' WHERE id=ait.id('crash');
 SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('crash'),5,120);
 PERFORM ait.eq((c.outcome,c.attempt)::text,'(claimed,2)','CR resumed');
 PERFORM ait.eq(public.flow_store_outbox_ai_answer('${A}',ait.id('crash'),tok,'enc:v1:aa:bb:cc'),false,'CR old token cannot store');
 PERFORM ait.eq(public.flow_finish_outbox_ai('${A}',ait.id('crash'),tok,'no_knowledge',NULL,60,5),NULL::text,'CR old token cannot finish');
 -- repeated crashes exhaust the budget without any further model call
 UPDATE public.automation_flow_outbox SET ai_attempts=5,ai_lease_expires_at=now()-interval '1 second' WHERE id=ait.id('crash');
 PERFORM ait.eq(ait.outcome(ait.id('crash')),'exhausted','CR exhausted');
 PERFORM ait.eq(ait.ox(ait.id('crash')),'dead_letter/ai_retries_exhausted/5/ai_attempt_abandoned','CR dead letter');

 -- tenant isolation and argument validation
 PERFORM ait.fx('iso');
 PERFORM ait.eq((SELECT outcome FROM public.flow_claim_outbox_ai('${B}',ait.id('iso'),5,120)),'not_claimable','ISO cross-tenant claim');
 PERFORM ait.eq(ait.ox(ait.id('iso')),'pending/-/0/-','ISO untouched');
 PERFORM ait.eq(public.flow_finish_outbox_ai('${A}',ait.id('iso'),gen_random_uuid(),'bogus',NULL,60,5),NULL::text,'ISO bad result');
 BEGIN PERFORM public.flow_claim_outbox_ai('${A}',ait.id('iso'),99,120);
  RAISE EXCEPTION 'ISO bounds not enforced';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'invalid ai claim arguments' THEN RAISE; END IF; END;

 -- lifecycle semantics preserved on AI-backoff rows
 PERFORM public.flow_skip_outbox_effect('${A}',ait.id('cl'),'human_takeover');
 PERFORM ait.eq(ait.ox(ait.id('cl')),'cancelled/human_takeover/1/ai_unknown','LC takeover cancels retry_wait');
END $t$;

-- queue recovery: a backed-off head item does not occupy scan slots; it is
-- listed again once due and resumes from its persisted attempt count.
DO $t$
DECLARE c record;
BEGIN
 UPDATE public.automation_flow_outbox SET delivery_status='cancelled',cancel_reason='manual'
 WHERE delivery_status='pending' AND payload->>'source'='knowledge_ai';
 PERFORM ait.fx('q_old','3 minutes'); PERFORM ait.fx('q_new1','2 minutes'); PERFORM ait.fx('q_new2','1 minute');
 SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('q_old'),5,120);
 PERFORM public.flow_finish_outbox_ai('${A}',ait.id('q_old'),c.claim_token,'retry','ai_timeout',60,5);
 PERFORM ait.eq(ait.listed(1),ARRAY[ait.id('q_new1')],'Q backed-off head skipped with limit 1');
 PERFORM ait.eq(ait.listed(10),ARRAY[ait.id('q_new1'),ait.id('q_new2')],'Q newer listed');
 UPDATE public.automation_flow_outbox SET retry_at=now()-interval '1 second' WHERE id=ait.id('q_old');
 PERFORM ait.eq(ait.listed(10),ARRAY[ait.id('q_old'),ait.id('q_new1'),ait.id('q_new2')],'Q due again');
 SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('q_old'),5,120);
 PERFORM ait.eq((c.outcome,c.attempt)::text,'(claimed,2)','Q resumed attempt count');
END $t$;
RESET ROLE;

-- privileges
SET ROLE authenticated;
DO $t$
BEGIN
 BEGIN PERFORM public.flow_claim_outbox_ai('${A}',ait.id('iso'),5,120);
  RAISE EXCEPTION 'authenticated may claim';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.flow_finish_outbox_ai('${A}',ait.id('iso'),gen_random_uuid(),'no_knowledge',NULL,60,5);
  RAISE EXCEPTION 'authenticated may finish';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $t$;
RESET ROLE;
`;

test("live PG: AI retry behaviour, idempotency and rollback",{skip},()=>{
 ok("postgres",{sql:"CREATE DATABASE airetry;"},"createdb");
 bootstrap("airetry",{withRoles:true});
 ok("airetry",{sql:BEHAVIOUR},"behaviour");
 ok("airetry",{file:MIG},"migration re-applied (idempotent)");
 ok("airetry",{sql:`DO $t$ BEGIN
  PERFORM ait.eq(ait.ox(ait.id('pm')),'dead_letter/ai_unavailable/1/ai_http_401','state kept on re-apply');
 END $t$;`},"re-apply kept data");
 ok("airetry",{file:RB},"rollback");
 ok("airetry",{sql:`DO $t$ BEGIN
  IF to_regprocedure('public.flow_claim_outbox_ai(uuid,uuid,integer,integer)') IS NOT NULL
  OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='automation_flow_outbox'
    AND column_name IN('ai_attempts','ai_last_error_code','ai_lease_token','ai_lease_expires_at','ai_answer_encrypted'))
  OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='automation_flow_outbox' AND column_name='retry_at')
  OR EXISTS(SELECT 1 FROM public.automation_flow_outbox WHERE cancel_reason IN('no_knowledge','ai_unavailable','ai_retries_exhausted'))
  OR position('''ai_retries_exhausted''' IN (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conname='automation_flow_outbox_cancel_reason_chk'))>0
  OR (SELECT delivery_status FROM public.automation_flow_outbox WHERE id=ait.id('pm'))<>'dead_letter'
  OR (SELECT delivery_status FROM public.automation_flow_outbox WHERE id=ait.id('q_new1'))<>'pending'
  THEN RAISE EXCEPTION 'rollback incomplete'; END IF;
  -- lifecycle functions still work after the rollback
  PERFORM public.flow_skip_blocked_outbox(60,10);
 END $t$;`},"rollback verified");
 ok("airetry",{file:MIG},"migration re-applied after rollback");
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
 UNION ALL SELECT 'o:'||md5(coalesce(string_agg(o::text,',' ORDER BY o.id),'')) FROM public.automation_flow_outbox o
) s(x);`;

test("live PG: wrong rollback order is refused; 140000 then 130000 works; both re-apply",{skip},()=>{
 ok("postgres",{sql:"CREATE DATABASE aiorder;"},"createdb");
 bootstrap("aiorder",{withRoles:false});
 ok("aiorder",{sql:`SET ROLE service_role; DO $s$ DECLARE c record; BEGIN
  PERFORM ait.fx('o_nk'); SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('o_nk'),5,120);
  PERFORM ait.eq(public.flow_finish_outbox_ai('${A}',ait.id('o_nk'),c.claim_token,'no_knowledge',NULL,60,5),'cancelled','seed nk');
  PERFORM ait.fx('o_rt'); SELECT * INTO c FROM public.flow_claim_outbox_ai('${A}',ait.id('o_rt'),5,120);
  PERFORM ait.eq(public.flow_finish_outbox_ai('${A}',ait.id('o_rt'),c.claim_token,'retry','ai_timeout',60,5),'retry_wait','seed retry');
 END $s$;`},"seed");
 // Wrong order: lifecycle rollback first must be refused and change nothing.
 const before=ok("aiorder",{sql:SNAP},"snapshot").stdout;
 const wrong=psql("aiorder",{file:LIFECYCLE_RB});
 assert.notEqual(wrong.status,0,"lifecycle rollback must refuse while 140000 is installed");
 assert.match(wrong.stderr,/roll back 20261029140000_flow_outbox_ai_retry first/);
 assert.equal(ok("aiorder",{sql:SNAP},"snapshot").stdout,before,"refused rollback changed nothing");
 ok("aiorder",{sql:`SET ROLE service_role; DO $t$ BEGIN
  PERFORM ait.eq(ait.ox(ait.id('o_nk')),'cancelled/no_knowledge/1/-','140000 state intact');
  PERFORM ait.eq((SELECT outcome FROM public.flow_claim_outbox_ai('${A}',ait.id('o_nk'),5,120)),'not_claimable','140000 functions still work');
  PERFORM public.flow_skip_blocked_outbox(60,10);
 END $t$;`},"still installed and working");
 // Correct order.
 ok("aiorder",{file:RB},"140000 rollback");
 ok("aiorder",{file:LIFECYCLE_RB},"130000 rollback after 140000");
 ok("aiorder",{sql:`DO $t$ BEGIN
  IF to_regprocedure('public.flow_claim_outbox_ai(uuid,uuid,integer,integer)') IS NOT NULL
  OR to_regprocedure('public.flow_cancel_run(uuid,uuid,text,text)') IS NOT NULL
  OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='automation_flow_outbox'
    AND column_name IN('ai_attempts','cancel_reason','cancelled_at'))
  OR obj_description('public.flow_lease_due_runs(integer)'::regprocedure,'pg_proc')<>'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE'
  OR (SELECT delivery_status FROM public.automation_flow_outbox WHERE idempotency_key='ai-o_nk')<>'cancelled'
  OR (SELECT delivery_status FROM public.automation_flow_outbox WHERE idempotency_key='ai-o_rt')<>'pending'
  THEN RAISE EXCEPTION 'ordered rollback incomplete'; END IF; END $t$;`},"ordered rollback verified");
 // Re-apply in migration order.
 ok("aiorder",{file:LIFECYCLE},"130000 re-applied");
 ok("aiorder",{file:MIG},"140000 re-applied");
 ok("aiorder",{sql:`SET ROLE service_role; DO $t$ BEGIN
  PERFORM ait.eq(ait.outcome(ait.id('o_rt')),'claimed','re-applied functions work');
  PERFORM public.flow_skip_blocked_outbox(60,10);
 END $t$;`},"re-apply verified");
});

test("live PG: concurrent workers cannot both claim one effect; a killed worker's claim resumes",{skip},async()=>{
 ok("postgres",{sql:"CREATE DATABASE airace;"},"createdb");
 bootstrap("airace",{withRoles:false});
 ok("airace",{sql:"SELECT ait.fx('race');"},"seed effect");
 const id=ok("airace",{sql:"SELECT ait.id('race');"},"id").stdout.trim();
 const claim=`SELECT outcome||':'||coalesce(attempt::text,'-') FROM public.flow_claim_outbox_ai('${A}','${id}',5,120);`;
 // Worker 1 holds the row lock (open transaction), worker 2 races it.
 const first=psqlAsync("airace",`SET ROLE service_role; BEGIN; ${claim} SELECT pg_sleep(1.5); COMMIT;`);
 await new Promise(r=>setTimeout(r,500));
 const second=psqlAsync("airace",`SET ROLE service_role; ${claim}`);
 const [a,b]=await Promise.all([first,second]);
 assert.equal(a.code,0,a.err);assert.equal(b.code,0,b.err);
 assert.match(a.out,/^claimed:1$/m);
 assert.match(b.out,/^busy:-$/m,"locked row is skipped, not waited on or double-claimed");
 // After commit the live AI lease still blocks a third worker.
 assert.match(ok("airace",{sql:`SET ROLE service_role; ${claim}`},"third").stdout,/^busy:-$/m);
 // Eight simultaneous workers after the lease expires: exactly one wins.
 ok("airace",{sql:`UPDATE public.automation_flow_outbox SET ai_lease_expires_at=now()-interval '1 second' WHERE id='${id}';`},"expire");
 const many=await Promise.all(Array.from({length:8},()=>psqlAsync("airace",`SET ROLE service_role; ${claim}`)));
 for(const r of many)assert.equal(r.code,0,r.err);
 const outs=many.map(r=>r.out.trim()).sort();
 assert.equal(outs.filter(o=>o==="claimed:2").length,1,outs.join(","));
 assert.equal(outs.filter(o=>o==="busy:-").length,7,outs.join(","));
 assert.equal(ok("airace",{sql:`SELECT ai_attempts FROM public.automation_flow_outbox WHERE id='${id}';`},"attempts").stdout.trim(),"2");
});
