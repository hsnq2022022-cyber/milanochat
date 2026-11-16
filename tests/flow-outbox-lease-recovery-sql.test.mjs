// T6-S2: SQL proof that recovering an abandoned delivery lease through the
// EXISTING public.flow_finish_outbox_delivery(tenant,outbox,'uncertain',NULL)
// (latest body: 20261029210000; later migrations only pin its hash) is safe:
// tenant-scoped, one-shot, a no-op on rows that already advanced, never
// re-reservable, and serialized against a concurrent live finish.
//
// Behavioural checks run against a THROWAWAY local PostgreSQL cluster
// (temporary data dir, unix socket only, listen_addresses='', removed
// afterwards) built from the same fixture/migration chain as
// tests/flow-media-effects.test.mjs (.. 20261029190000, then 20261029210000).
// Never connects to any remote host; inherited PG* variables are stripped.
// No migration file is changed; no billing function runs.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";

const M210="supabase/migrations/20261029210000_flow_media_effects.sql";
const CHAIN125_190=["supabase/migrations/20261029125000_flow_durable_button_run.sql",
 "supabase/migrations/20261029130000_flow_run_lifecycle.sql",
 "supabase/migrations/20261029140000_flow_outbox_ai_retry.sql",
 "supabase/migrations/20261029150000_flow_takeover_resume.sql",
 "supabase/migrations/20261029160000_flow_credits_pause.sql",
 "supabase/migrations/20261029170000_flow_canary_claim_durable.sql",
 "supabase/migrations/20261029180000_flow_durable_button_run_guards.sql",
 "supabase/migrations/20261029190000_flow_begin_durable_run_superseding.sql"];
const src=f=>readFileSync(f,"utf8");

// ---------------------------------------------------------------- static
test("210000 holds the latest flow_finish_outbox_delivery body; no later migration redefines it",()=>{
 const defs=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).sort()
  .filter(f=>/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.flow_finish_outbox_delivery\s*\(/i.test(src("supabase/migrations/"+f)));
 assert.deepEqual(defs,["20261028226000_flow_outbox_delivery_attempts.sql","20261029210000_flow_media_effects.sql"]);
 const s=src(M210),fin=s.slice(s.indexOf("AS $finish$"),s.indexOf("END $finish$"));
 // Signature: no lease_token argument; tenant-scoped, one-shot attempt, leased-only outbox transition.
 assert.match(s,/FUNCTION public\.flow_finish_outbox_delivery\(\n p_tenant uuid,p_outbox uuid,p_result text,p_provider_message_id text DEFAULT NULL\)/);
 assert.doesNotMatch(fin,/lease_token\s*=\s*p_|lease_token\s*<>|lease_expires_at\s*[<>]/,"no lease token / expiry check");
 assert.ok(fin.includes("WHERE tenant_id=p_tenant AND outbox_id=p_outbox AND status='attempting';"));
 assert.ok(fin.includes("WHERE tenant_id=p_tenant AND id=p_outbox AND delivery_status='leased';"));
 assert.ok(fin.includes("IF NOT FOUND THEN RAISE EXCEPTION 'Outbox status changed after delivery';END IF;"));
 assert.match(s,/GRANT EXECUTE ON FUNCTION public\.flow_finish_outbox_delivery\(uuid,uuid,text,text\) TO service_role;/);
});

// ---------------------------------------------------------------- live PG
function findPgBin(){
 const cands=[];
 if(process.env.PG_BIN)cands.push(process.env.PG_BIN);
 try{for(const v of readdirSync("/usr/lib/postgresql").sort().reverse())cands.push(`/usr/lib/postgresql/${v}/bin`);}catch{}
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
function clientEnv(){const env={};for(const [k,v] of Object.entries(process.env))if(!k.startsWith("PG"))env[k]=v;return env;}
const pargs=db=>["-X","-q","-t","-A","-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose",
 "-h",dir,"-p",String(port),"-U","postgres","-d",db];
function psql(db,{file,sql,role}={}){
 const a=pargs(db);if(file)a.push("-f",file);
 const input=sql===undefined?undefined:(role?`SET ROLE ${role};\n`:"")+sql;
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input,env:clientEnv(),maxBuffer:1<<26});
}
function psqlAsync(db,sql){
 return new Promise(resolve=>{
  const p=spawn(join(BIN,"psql"),pargs(db),{env:clientEnv()});
  let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
  p.on("close",status=>resolve({status,stdout:out,stderr:err}));
  p.stdin.end(sql);
 });
}
function ok(db,s,label){const r=psql(db,s);assert.equal(r.status,0,`${label}\n${r.stderr}`);return r.stdout.trim();}
function rows(db,query,role){
 const r=psql(db,{sql:`SELECT '@@'||coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)::text FROM (${query}) x;`,role});
 assert.equal(r.status,0,`${query}\n${r.stderr}`);
 return JSON.parse(r.stdout.split("\n").find(l=>l.startsWith("@@")).slice(2));
}
const val=(db,query,role)=>rows(db,`SELECT (${query}) AS v`,role)[0]?.v;
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111",ACCB="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const IMG="https://abcd1234.supabase.co/storage/v1/object/public/flow-media/u1/0f8c2b1e-1111-4222-8333-444455556666.webp";
const doc={version:3,name:"lease",nodes:[{id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"m",data:{kind:"message",text:"hi",image:"",options:[]}}],edges:[{source:"start",target:"m",sourceHandle:"next"}]};
const J=o=>`'${JSON.stringify(o).replace(/'/g,"''")}'::jsonb`;
const L=v=>v===null?"NULL":`'${String(v).replace(/'/g,"''")}'`;
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
 "supabase/migrations/20261028228000_flow_internal_actions.sql",
 ...CHAIN125_190,M210];
const SEED=`
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES('${ACCB}','${B}','instagram','instagram');
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by) VALUES
 ('${A}','fa',1,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${B}','fb',1,'${ACCB}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active) VALUES
 ('${A}','${ACC}','instagram','fa',1,true),('${B}','${ACCB}','instagram','fb',1,true);
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
END $f$;`;
const SR="service_role";
// One durable start whose first commit stores [message seq0, question seq1, image seq2].
function start(db,name,{tenant=A,acc=ACC,flow="fa"}={}){
 const effects=JSON.stringify([
  {kind:"message",idempotencyKey:`m.${name}`,payload:{kind:"message",text:"hello",seq:0}},
  {kind:"question",idempotencyKey:`q.${name}`,payload:{kind:"question",text:"email?",inputMode:"text",seq:1}},
  {kind:"message_image",idempotencyKey:`i.${name}`,payload:{kind:"message_image",url:IMG,seq:2}}]);
 ok(db,{sql:`SELECT t.ev('${name}','${tenant}','${acc}');`},`event ${name}`);
 const e=rows(db,`SELECT * FROM t.e WHERE name='${name}'`)[0];
 const r=psql(db,{role:SR,sql:`SELECT public.flow_begin_durable_run(${L(e.tenant)},${L(e.acc)},${L(e.conv)},${L(e.msg)},${L(e.mid)},`+
  `${L(flow)},1,'start','m',2,'completed','{}'::jsonb,NULL,${L(effects)}::jsonb);`});
 assert.equal(r.status,0,r.stderr);
 const run=val(db,`SELECT r.id FROM public.automation_flow_runs r JOIN t.e ON e.mid=r.provider_event_id WHERE e.name='${name}'`);
 const out=rows(db,`SELECT id,tenant_id,effect_kind FROM public.automation_flow_outbox WHERE run_id='${run}'`);
 return Object.fromEntries(out.map(o=>[o.effect_kind,o]));
}
const reserve=(db,tenant,id)=>val(db,`public.flow_reserve_outbox_delivery('${tenant}','${id}')`,SR);
const finishSql=(tenant,id,res,mid=null)=>`public.flow_finish_outbox_delivery('${tenant}','${id}','${res}',${L(mid)})`;
const finish=(db,tenant,id,res,mid=null)=>val(db,finishSql(tenant,id,res,mid),SR);
const recover=(db,tenant,id)=>finish(db,tenant,id,"uncertain",null); // = leaseRecoveryFinishArgs
const state=(db,id)=>rows(db,`SELECT o.delivery_status AS s,o.lease_token IS NULL AS no_token,o.lease_expires_at IS NULL AS no_lease,
 o.provider_message_id AS o_mid,o.delivered_at IS NOT NULL AS delivered,a.status AS a,a.provider_message_id AS a_mid,
 a.uncertain_at IS NOT NULL AS unc_at,a.confirmed_at IS NOT NULL AS conf_at,a.review_status AS rv
 FROM public.automation_flow_outbox o LEFT JOIN public.automation_flow_delivery_attempts a
  ON a.tenant_id=o.tenant_id AND a.outbox_id=o.id WHERE o.id='${id}'`)[0];
const expire=(db,id,ago)=>ok(db,{sql:`UPDATE public.automation_flow_outbox SET lease_expires_at=now()-interval '${ago}' WHERE id='${id}'`},"expire");
// SQL equivalent of the PostgREST query in leaseRecovery.ts (grace 13 min, limit 20).
const SELECT_SQL=`SELECT id,tenant_id FROM public.automation_flow_outbox WHERE delivery_status='leased'
 AND effect_kind IN('message','question','message_image') AND lease_expires_at < now()-interval '13 minutes'
 ORDER BY lease_expires_at LIMIT 20`;

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-lease-recovery-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+613)%20000);
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
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});
let clones=0;
const clone=p=>{const db=`${p}_${++clones}`;ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE base;`},db);return db;};

test("abandoned lease of every provider kind: selected past grace and finished 'uncertain' exactly like a send-time failure",{skip},()=>{
 const db=clone("rec");
 const e=start(db,"r1");
 for(const k of ["message","question","message_image"])assert.equal(reserve(db,A,e[k].id),true,k);
 assert.deepEqual(rows(db,SELECT_SQL),[],"fresh leases (expire now()+2 min) are not selected");
 expire(db,e.message.id,"12 minutes 59 seconds");
 expire(db,e.question.id,"13 minutes 1 second");expire(db,e.message_image.id,"1 hour");
 assert.deepEqual(rows(db,SELECT_SQL).map(r=>r.id),[e.message_image.id,e.question.id],"within grace not selected; oldest first");
 for(const k of ["question","message_image"]){
  assert.equal(recover(db,A,e[k].id),true,k);
  assert.deepEqual(state(db,e[k].id),{s:"uncertain",no_token:true,no_lease:true,o_mid:null,delivered:false,
   a:"uncertain",a_mid:null,unc_at:true,conf_at:false,rv:"none"},k);
  assert.equal(recover(db,A,e[k].id),false,`${k}: idempotent second call`);
  assert.equal(reserve(db,A,e[k].id),false,`${k}: never re-reservable (never resent)`);
 }
 assert.equal(state(db,e.message.id).s,"leased","the lease within grace is untouched");
 // Identical end state to the send-time uncertain path (executeOnce throw -> confirm("uncertain",null)).
 const s=start(db,"r2");assert.equal(reserve(db,A,s.message.id),true);
 assert.equal(finish(db,A,s.message.id,"uncertain",null),true);
 assert.deepEqual(state(db,s.message.id),state(db,e.question.id));
});

test("tenant scoping: another tenant's id never finishes the row; each tenant's own row is finished",{skip},()=>{
 const db=clone("ten");
 const a=start(db,"ta"),b=start(db,"tb",{tenant:B,acc:ACCB,flow:"fb"});
 assert.equal(reserve(db,A,a.message.id),true);assert.equal(reserve(db,B,b.message.id),true);
 expire(db,a.message.id,"1 hour");expire(db,b.message.id,"1 hour");
 assert.equal(recover(db,B,a.message.id),false,"foreign tenant");assert.equal(recover(db,A,b.message.id),false,"foreign tenant");
 assert.equal(state(db,a.message.id).s,"leased");assert.equal(state(db,b.message.id).s,"leased");
 const sel=rows(db,SELECT_SQL);
 for(const r of sel)assert.equal(recover(db,r.tenant_id,r.id),true);
 assert.equal(sel.length,2);
 assert.equal(state(db,a.message.id).s,"uncertain");assert.equal(state(db,b.message.id).s,"uncertain");
});

test("advanced rows are a no-op: charge_pending, settled, uncertain, pending; billing state untouched",{skip},()=>{
 const db=clone("adv");
 const e=start(db,"a1"),f=start(db,"a2");
 for(const id of [e.message.id,e.question.id,e.message_image.id])assert.equal(reserve(db,A,id),true);
 assert.equal(finish(db,A,e.message.id,"confirmed","mid.live"),true);              // charge_pending
 assert.equal(finish(db,A,e.question.id,"confirmed","mid.q"),true);
 ok(db,{sql:`UPDATE public.automation_flow_outbox SET delivery_status='settled' WHERE id='${e.question.id}'`},"settle");
 assert.equal(finish(db,A,e.message_image.id,"uncertain"),true);                   // uncertain
 const before=[e.message.id,e.question.id,e.message_image.id,f.message.id].map(id=>state(db,id));
 for(const id of [e.message.id,e.question.id,e.message_image.id,f.message.id])
  assert.equal(recover(db,A,id),false,id);
 assert.deepEqual([e.message.id,e.question.id,e.message_image.id,f.message.id].map(id=>state(db,id)),before);
 assert.equal(before[0].s,"charge_pending");assert.equal(before[0].a_mid,"mid.live");
 assert.equal(before[3].s,"pending");assert.equal(before[3].a,null,"pending row: no attempt, nothing created");
 // Inconsistent pair (attempt still 'attempting' but outbox no longer leased): RAISE rolls back, nothing changes.
 assert.equal(reserve(db,A,f.question.id),true);
 ok(db,{sql:`UPDATE public.automation_flow_outbox SET delivery_status='cancelled' WHERE id='${f.question.id}'`},"force");
 const r=psql(db,{role:SR,sql:`SELECT ${finishSql(A,f.question.id,"uncertain")};`});
 assert.notEqual(r.status,0);assert.match(r.stderr,/Outbox status changed after delivery/);
 assert.equal(state(db,f.question.id).a,"attempting","attempt update rolled back");
});

async function race(db,first,second){
 // Session 1 finishes inside an open transaction and holds the attempt row lock.
 const s1=psqlAsync(db,`SET ROLE ${SR};\nBEGIN;\nSELECT ${first};\nSELECT pg_sleep(1.5);\nCOMMIT;\n`);
 let held=false;
 for(let i=0;i<200&&!held;i++){
  held=val(db,`SELECT count(*)>0 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT pg_sleep(1.5)%' AND state='active'`);
  if(!held)await new Promise(r=>setTimeout(r,25));
 }
 assert.ok(held,"session 1 holds its transaction");
 const t0=Date.now();
 const second_=val(db,second,SR);
 const waited=Date.now()-t0;
 const r1=await s1;assert.equal(r1.status,0,r1.stderr);
 return {second:second_,waited};
}
test("concurrency: live confirm committed first -> recovery waits, then no-op (billing path intact)",{skip},async()=>{
 const db=clone("racea");
 const e=start(db,"x1");assert.equal(reserve(db,A,e.message.id),true);expire(db,e.message.id,"1 hour");
 const {second,waited}=await race(db,finishSql(A,e.message.id,"confirmed","mid.live"),finishSql(A,e.message.id,"uncertain"));
 assert.equal(second,false);assert.ok(waited>=500,`recovery blocked on the row lock (${waited} ms)`);
 assert.deepEqual(state(db,e.message.id),{s:"charge_pending",no_token:true,no_lease:true,o_mid:"mid.live",delivered:true,
  a:"confirmed",a_mid:"mid.live",unc_at:false,conf_at:true,rv:"none"});
});
test("concurrency: recovery committed first -> late live confirm is refused; row stays uncertain, never re-reservable",{skip},async()=>{
 const db=clone("raceb");
 const e=start(db,"x2");assert.equal(reserve(db,A,e.message.id),true);expire(db,e.message.id,"1 hour");
 const {second,waited}=await race(db,finishSql(A,e.message.id,"uncertain"),finishSql(A,e.message.id,"confirmed","mid.late"));
 assert.equal(second,false);assert.ok(waited>=500,`live confirm blocked on the row lock (${waited} ms)`);
 assert.equal(state(db,e.message.id).s,"uncertain");assert.equal(state(db,e.message.id).a_mid,null);
 assert.equal(reserve(db,A,e.message.id),false);
});
