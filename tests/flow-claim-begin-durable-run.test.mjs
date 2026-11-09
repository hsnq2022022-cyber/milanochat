// 20261029330000_flow_claim_begin_durable_run: claim (+ canary audit) +
// supersede + begin of a NEW durable run in ONE transaction. When the start
// is refused (NULL) the claim is rolled back with it (private SQLSTATE
// FB330); when anything raises, the whole RPC aborts. So an orphaned
// route='flow' claim (V2 silent, customer without a reply) can no longer be
// committed, and V2's flow_claim_inbound acquires the event afterwards.
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) built from the repo fixture chain,
// migrations 20261028220000 .. 20261029230000 + 20261029300000, and the
// PRODUCTION body of flow_claim_inbound (tests/sql/fixtures/
// production-flow-claim-inbound.sql). Never connects to any remote host;
// inherited PG* variables are stripped. Fault injection (triggers in schema t)
// exists only inside the throwaway databases. Billing is out of scope.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const M="supabase/migrations/";
const MIG=M+"20261029330000_flow_claim_begin_durable_run.sql";
const RB="supabase/rollbacks/20261029330000_flow_claim_begin_durable_run.rollback.sql";
const PROD_CLAIM="tests/sql/fixtures/production-flow-claim-inbound.sql";
const INGRESS="supabase/functions/milan-api/flowDurableIngress.ts";
const MARK="CREATED_BY_20261029330000_FLOW_CLAIM_BEGIN_DURABLE_RUN";
const ARGS="boolean,uuid,uuid,text,text,uuid,uuid,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb";
const SIG=`public.flow_claim_begin_durable_run(${ARGS})`;
const CLAIM_SIG="public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)";
const DURABLE_SIG="public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)";
const SUPER_SIG="public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)";
const BEGIN_SIG="public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)";
const PROD_CLAIM_MD5="cced049e635e02b5a0be1353704b5020";   // production, normalized
const PROD_CLAIM_RAW_MD5="d67fcf35e9042857c4f488d45cd9f9b9"; // production, raw prosrc
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
const BODY=()=>between(src(MIG),"AS $claimbegin$","$claimbegin$");

// ---------------------------------------------------------------- static
test("330000 is the newest migration; its rollback and the whole called chain exist",()=>{
 const stamps=readdirSync(M).filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 assert.equal(stamps.filter(s=>s==="20261029330000").length,1);
 for(const s of stamps)assert.ok(s<="20261029330000",s);
 for(const f of [...CHAIN125_300,RB,PROD_CLAIM])assert.ok(existsSync(f),f);
});
test("migration and rollback: one bounded transaction, additive, service_role only, no DELETE, no data change",()=>{
 for(const f of [MIG,RB]){
  const s=src(f),code=noComments(s);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
  assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1,f);assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.doesNotMatch(code,/\bDELETE\b|\bTRUNCATE\b|\bUPDATE\s+public\.|\bINSERT\b|\bALTER\s+TABLE\b|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+TABLE|CREATE\s+TRIGGER/i,f);
  assert.doesNotMatch(code,/SECURITY DEFINER|\bTO\s+(anon|authenticated|PUBLIC)\b|CREATE POLICY|WHEN OTHERS/i,f);
  assert.doesNotMatch(code,/consume_|credits|wayl|topup|cron\.|vault\.|net\.http_|pg_sleep/i,f);
  assert.ok(code.includes(`v_marker constant text := '${MARK}'`),f);
 }
 // grep -c DELETE: not even in a comment of the migration's function or preflight.
 assert.equal((src(MIG).match(/DELETE/g)??[]).length,0,"no DELETE anywhere in the migration");
 const code=noComments(src(MIG));
 assert.doesNotMatch(code,/\bDROP\b/i,"migration never drops");
 assert.doesNotMatch(code,/CREATE\s+FUNCTION/i,"CREATE OR REPLACE only (idempotent)");
 assert.equal((code.match(/CREATE OR REPLACE FUNCTION/g)??[]).length,1);
 assert.ok(code.includes("CREATE OR REPLACE FUNCTION public.flow_claim_begin_durable_run(\n"+
  " p_canary boolean,p_tenant uuid,p_account uuid,p_platform text,p_event text,\n"+
  " p_conversation uuid,p_inbound uuid,p_flow text,p_revision bigint,p_start text,\n"+
  " p_next text,p_next_step integer,p_status text,p_variables jsonb,p_wake timestamptz,\n"+
  " p_effects jsonb\n) RETURNS TABLE(acquired boolean,run_id uuid) LANGUAGE plpgsql SECURITY INVOKER SET search_path=''\n"));
 assert.ok(code.includes(`REVOKE ALL ON FUNCTION ${SIG}\n FROM PUBLIC,anon,authenticated;`));
 assert.ok(code.includes(`GRANT EXECUTE ON FUNCTION ${SIG}\n TO service_role;`));
 assert.equal((code.match(/^(GRANT|REVOKE) /gm)??[]).length,2);
 assert.ok(code.includes(`COMMENT ON FUNCTION ${SIG}\n IS '${MARK}';`));
 assert.doesNotMatch(noComments(src(RB)),/^(REVOKE|GRANT)/m,"rollback never changes privileges");
 assert.equal((noComments(src(RB)).match(/^DROP FUNCTION /gm)??[]).length,1);
 assert.ok(noComments(src(RB)).includes(`DROP FUNCTION ${SIG};`),"rollback drops only the new function");
});
test("body: claim first, then the superseding begin; only the private SQLSTATE FB330 is caught",()=>{
 const b=BODY();
 const iCanary=b.indexOf("public.flow_claim_inbound_durable(\n    p_tenant,p_account,p_platform,p_event,p_conversation,p_inbound) c;");
 const iTest=b.indexOf("public.flow_claim_inbound(\n    p_tenant,p_account,p_platform,p_event,p_conversation,p_inbound,true) c;");
 const iBegin=b.indexOf("v_run := public.flow_begin_durable_run_superseding(\n    p_tenant,p_account,p_conversation,p_inbound,p_event,p_flow,p_revision,\n"+
  "    p_start,p_next,p_next_step,p_status,p_variables,p_wake,p_effects);");
 assert.ok(iCanary>0&&iTest>0&&iBegin>0,"exact calls");
 assert.ok(iCanary<iBegin&&iTest<iBegin,"claim before begin (lock order: claim entry, then advisory)");
 assert.match(b,/IF p_canary THEN\n/);
 assert.equal((b.match(/EXCEPTION WHEN/g)??[]).length,1);
 assert.match(b,/ EXCEPTION WHEN SQLSTATE 'FB330' THEN\n(  --[^\n]*\n)*  RETURN;\n END;/,"rolled back path returns no row");
 assert.equal((b.match(/USING ERRCODE='FB330';/g)??[]).length,2);
 assert.match(b,/IF v_route IS DISTINCT FROM 'flow' THEN\n    RAISE EXCEPTION '[^']+'\n     USING ERRCODE='FB330';/);
 assert.match(b,/IF v_run IS NULL THEN\n    RAISE EXCEPTION '[^']+'\n     USING ERRCODE='FB330';/);
 assert.doesNotMatch(b,/pg_advisory|DELETE|UPDATE|INSERT/i,"no own locks or writes: only the called functions write");
 // Every called object is schema-qualified.
 for(const m of b.matchAll(/\b([a-z_]+)\(/g))
  if(!["IF","RETURN","EXCEPTION"].includes(m[1].toUpperCase()))assert.ok(b.includes("public."+m[1]+"(")||m[1]==="c",m[1]);
 // Self hash in preflight and rollback = this body (same normalization as Postgres).
 const h=md5(norm(b));
 assert.ok(src(MIG).includes(`v_self_md5 constant text := '${h}';`),"migration self hash");
 assert.ok(src(RB).includes(`v_self_md5 constant text := '${h}';`),"rollback self hash");
 for(const x of [PROD_CLAIM_MD5,"c9299f42239a6a4f275ba4be61e04b9d","08d4eccd3e8c2acdccbd1bef59d39c73","d0fea89cd85053ee62276bccf4156d43"])
  assert.ok(src(MIG).includes(`'${x}'`),x);
});
test("production flow_claim_inbound fixture: production body, header and marker; differs from the repo body",()=>{
 const f=src(PROD_CLAIM);
 const body=between(f,"AS $claim$","$claim$");
 assert.equal(md5(body),PROD_CLAIM_RAW_MD5);assert.equal(Buffer.byteLength(body),2716);
 assert.equal(md5(norm(body)),PROD_CLAIM_MD5);
 const repo=between(src(M+"20261028220000_webhook_exclusive_claim.sql"),"AS $claim$","$claim$");
 assert.match(md5(norm(repo)),/^a70c60d7/,"repo 220000 body hash");
 assert.ok(body.includes("WHERE tenant_id=p_tenant_id AND enabled AND (test_only OR production_approved)) AND"));
 assert.ok(body.includes("AND (c.account_id=p_account_id OR c.account_id IS NULL)"));
 assert.ok(f.includes("LANGUAGE plpgsql SECURITY INVOKER SET search_path=''\n"));
 assert.ok(f.includes(`COMMENT ON FUNCTION ${CLAIM_SIG}\n IS 'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM';`));
 assert.ok(f.includes(`GRANT EXECUTE ON FUNCTION ${CLAIM_SIG}\n TO service_role;`));
});
test("milan-api starts a new durable run only through the atomic claim+begin RPC",()=>{
 const ing=src(INGRESS);
 assert.equal((ing.match(/rpc\("flow_claim_begin_durable_run"/g)??[]).length,1);
 assert.doesNotMatch(ing,/rpc\("flow_begin_durable_run_superseding"|rpc\("flow_begin_durable_run"/);
 assert.ok(ing.includes("p_canary:canary,"));
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
  const t0=Date.now();
  const p=spawn(join(BIN,"psql"),pargs(db),{env:clientEnv()});
  let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
  p.on("close",code=>res({code,out,err,end:Date.now(),ms:Date.now()-t0}));p.stdin.end(sql);
 });
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
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
// Schema (+ optionally data) fingerprint of schema public. exclude: function name left out.
const FP=(data,exclude)=>`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||
  coalesce(p.proacl::text,'')||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||pg_get_function_result(p.oid)||':'||
  p.prosecdef||':'||pg_get_function_arguments(p.oid)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ${exclude?`AND p.proname<>'${exclude}'`:""}
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')||':'||c.relrowsecurity
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'i:'||pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'c:'||a.attrelid::regclass::text||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v') AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid)||':'||convalidated
  FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 't:'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text FROM pg_trigger t WHERE NOT t.tgisinternal
  AND t.tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
 ${data?`UNION ALL SELECT 'd:'||c.oid::regclass::text||':'||md5(query_to_xml(
   format('SELECT t::text AS v FROM %s t ORDER BY 1',c.oid::regclass),false,false,'')::text)
  FROM pg_class c WHERE c.relkind IN('r','p') AND c.relnamespace='public'::regnamespace`:""}
) s(x);`;
const fp=(db,data=true,exclude)=>ok(db,{sql:FP(data,exclude)},"fingerprint").out;
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
const doc={version:3,name:"two choices",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"choose",image:"",contentBlocks:[],options:[
  {id:"prices",label:"prices"},{id:"support",label:"support"}]}},
 {id:"yes",data:{kind:"message",text:"prices text",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"support text",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},{source:"choose",target:"yes",sourceHandle:"prices"},
  {source:"choose",target:"no",sourceHandle:"support"}]};
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
 M+"20261028220000_webhook_exclusive_claim.sql",M+"20261028224000_delivery_attempts.sql",
 M+"20261028225000_flow_runtime_advance.sql",M+"20261028226000_flow_outbox_delivery_attempts.sql",
 "tests/sql/flow-staff-membership-bootstrap.sql",M+"20261028227000_tenant_staff_memberships.sql",
 M+"20261028228000_flow_internal_actions.sql",...CHAIN125_300];
const SEED=`
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES ('${ACCB}','${B}','instagram','instagram');
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by) VALUES
 ('${A}','buttons',1,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${B}','bflow',1,'${ACCB}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active) VALUES
 ('${A}','${ACC}','instagram','buttons',1,true),('${B}','${ACCB}','instagram','bflow',1,true);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved)
VALUES('${A}',true,false,true),('${B}',true,false,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by) VALUES
 ('${A}','${ACC}','instagram','op'),('${B}','${ACCB}','instagram','op');
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO service_role;
CREATE TABLE t.e(name text PRIMARY KEY,tenant uuid,acc uuid,conv uuid,msg uuid,mid text);
-- One inbound event: a conversation bound to the account (or a given one) + the persisted inbound message.
CREATE FUNCTION t.ev(p_name text,p_tenant uuid,p_acc uuid,p_conv uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid:=p_conv; m uuid;
BEGIN
 IF c IS NULL THEN
  INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
  VALUES(gen_random_uuid(),p_tenant,p_acc,'instagram:'||gen_random_uuid()) RETURNING id INTO c;
 END IF;
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
 VALUES(p_tenant,c,'in','mid.'||p_name) RETURNING id INTO m;
 INSERT INTO t.e VALUES(p_name,p_tenant,p_acc,c,m,'mid.'||p_name);
END $f$;
-- Fault injection (test databases only): delay a run insert while every lock
-- taken so far is held, or raise from inside begin.
CREATE FUNCTION t.slow() RETURNS trigger LANGUAGE plpgsql AS $s$
BEGIN
 IF current_setting('t.sleep',true)='on' THEN PERFORM pg_catalog.pg_sleep(1.5); END IF;
 IF current_setting('t.raise',true)='on' THEN RAISE EXCEPTION 'injected fault' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $s$;
CREATE TRIGGER t_slow BEFORE INSERT ON public.automation_flow_runs FOR EACH ROW EXECUTE FUNCTION t.slow();
ANALYZE;`;
const SR="service_role";
const L=v=>v===null||v===undefined?"NULL":`'${String(v).replace(/'/g,"''")}'`;
const Q_EFFECT=k=>`[{"kind":"question","idempotencyKey":"q.${k}","payload":{"kind":"question","text":"choose","inputMode":"buttons","choices":["prices","support"],"choiceIds":["prices","support"]}}]`;
function callSql(e,o={}){
 const a={canary:true,tenant:e.tenant,acc:e.acc,platform:"instagram",mid:e.mid,conv:e.conv,msg:e.msg,
  flow:e.acc===ACCB?"bflow":"buttons",rev:1,start:"start",next:"choose",step:1,status:"awaiting_input",
  vars:"{}",wake:null,effects:Q_EFFECT(e.name),...o};
 return `SELECT acquired,run_id FROM public.flow_claim_begin_durable_run(${a.canary===null?"NULL":a.canary},${L(a.tenant)},${L(a.acc)},`+
  `${L(a.platform)},${L(a.mid)},${L(a.conv)},${L(a.msg)},${L(a.flow)},${a.rev===null?"NULL":a.rev},${L(a.start)},${L(a.next)},`+
  `${a.step===null?"NULL":a.step},${L(a.status)},${a.vars===null?"NULL":L(a.vars)+"::jsonb"},`+
  `${a.wake===null?"NULL":L(a.wake)+"::timestamptz"},${a.effects===null?"NULL":L(a.effects)+"::jsonb"})`;
}
const start=(db,e,o)=>rows(db,callSql(e,o),SR);
const mk=(db,name,tenant=A,acc=ACC,conv=null)=>{
 ok(db,{sql:`SELECT t.ev('${name}','${tenant}','${acc}',${L(conv)});`},`event ${name}`);
 return rows(db,`SELECT * FROM t.e WHERE name='${name}'`)[0];
};
// V2's own claim (milan-api index.ts): same key, p_engine_ready=false.
const v2Sql=(e,ready=false)=>`SELECT acquired,route FROM public.flow_claim_inbound(${L(e.tenant)},${L(e.acc)},'instagram',${L(e.mid)},${L(e.conv)},${L(e.msg)},${ready})`;
const v2=(db,e)=>rows(db,v2Sql(e),SR);
const counts=(db,e)=>rows(db,`SELECT
 (SELECT count(*) FROM public.automation_message_claims WHERE provider_event_id='${e.mid}')::int AS claims,
 (SELECT count(*) FROM public.automation_flow_canary_claims WHERE provider_event_id='${e.mid}')::int AS canary,
 (SELECT count(*) FROM public.automation_flow_event_receipts WHERE provider_event_id='${e.mid}')::int AS receipts,
 (SELECT count(*) FROM public.automation_flow_runs WHERE provider_event_id='${e.mid}')::int AS runs,
 (SELECT count(*) FROM public.automation_flow_outbox o JOIN public.automation_flow_runs r ON r.id=o.run_id
   WHERE r.provider_event_id='${e.mid}')::int AS outbox`)[0];
const ZERO={claims:0,canary:0,receipts:0,runs:0,outbox:0};
const runRow=run=>`SELECT run_status,ended_reason FROM public.automation_flow_runs WHERE id='${run}'`;
const active=(db,conv)=>rows(db,`SELECT id FROM public.automation_flow_runs WHERE conversation_id='${conv}'
 AND run_status IN('ready','awaiting_input','sleeping') ORDER BY id`).map(r=>r.id);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const startedOk=(db,e,o)=>{const r=start(db,e,o);assert.equal(r.length,1,JSON.stringify(r));
 assert.equal(r[0].acquired,true);assert.match(String(r[0].run_id),UUID);return r[0].run_id;};
const outLines=out=>out.split("\n").map(l=>l.trim()).filter(Boolean);

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-claim-begin-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+330)%20000);
 let r=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(r.status,0,r.stderr);
 r=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off -c deadlock_timeout=200ms`,"start"]);
 assert.equal(r.status,0,r.stderr+r.stdout);
 started=true;
 ok("postgres",{sql:"CREATE DATABASE base;"},"createdb");
 ok("base",{sql:src("tests/sql/fixtures/flow-live-shape-bootstrap.sql")},"live shape");
 for(const f of CHAIN)ok("base",f==="@LIVE"?{sql:LIVE}:{file:f},f);
 ok("base",{sql:SEED},"seed");
 // repo: chain with the REPO flow_claim_inbound; c300: production body; g330: plus this migration.
 ok("postgres",{sql:"CREATE DATABASE repo TEMPLATE base;"},"repo");
 ok("postgres",{sql:"CREATE DATABASE c300 TEMPLATE base;"},"c300");
 ok("c300",{file:PROD_CLAIM},"production flow_claim_inbound");
 ok("postgres",{sql:"CREATE DATABASE g330 TEMPLATE c300;"},"g330");
 ok("g330",{file:MIG},"330000");
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});
let clones=0;
function clone(prefix,template="g330"){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},`clone ${db}`);
 return db;
}
const TEST_MODE=`UPDATE public.automation_flow_tenant_switches SET test_only=true WHERE tenant_id IN('${A}','${B}')`;

test("fixture: the installed flow_claim_inbound is the production body (normalized md5 pinned)",{skip},()=>{
 const h=db=>rows(db,`SELECT md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))) AS n,md5(prosrc) AS raw,
  obj_description(oid,'pg_proc') AS marker,prosecdef,proconfig FROM pg_proc WHERE oid='${CLAIM_SIG}'::regprocedure`)[0];
 assert.deepEqual(h("g330"),{n:PROD_CLAIM_MD5,raw:PROD_CLAIM_RAW_MD5,marker:"CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM",
  prosecdef:false,proconfig:['search_path=""']});
 assert.match(h("repo").n,/^a70c60d7/,"repo template keeps the repo body");
 for(const role of ["anon","authenticated","public"])
  assert.equal(val("g330",`SELECT has_function_privilege('${role}','${CLAIM_SIG}','EXECUTE')`),false,role);
 // Every pinned prerequisite hash matches this local chain.
 for(const [sig,x] of [[DURABLE_SIG,"c9299f42239a6a4f275ba4be61e04b9d"],[SUPER_SIG,"08d4eccd3e8c2acdccbd1bef59d39c73"],
   [BEGIN_SIG,"d0fea89cd85053ee62276bccf4156d43"],[SIG,md5(norm(BODY()))]])
  assert.equal(val("g330",`SELECT md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))) FROM pg_proc WHERE oid='${sig}'::regprocedure`),x,sig);
});

test("4) success: one claim (flow) + canary audit + receipt + run + outbox; V2 then sees a duplicate",{skip},()=>{
 const db=clone("ok");
 const e=mk(db,"s1");
 const run=startedOk(db,e);
 assert.deepEqual(counts(db,e),{claims:1,canary:1,receipts:1,runs:1,outbox:1});
 assert.equal(val(db,`SELECT route FROM public.automation_message_claims WHERE provider_event_id='${e.mid}'`),"flow");
 assert.deepEqual(rows(db,runRow(run))[0],{run_status:"awaiting_input",ended_reason:null});
 assert.deepEqual(v2(db,e),[{acquired:false,route:"flow"}],"V2 duplicate: stays silent");
 // Replay of the same event: (false,NULL), nothing changes.
 const before=fp(db);
 assert.deepEqual(start(db,e),[{acquired:false,run_id:null}]);
 assert.equal(fp(db),before);
 // A later event of the same conversation supersedes the run atomically.
 const e2=mk(db,"s2",A,ACC,e.conv);
 const run2=startedOk(db,e2);
 assert.deepEqual(rows(db,runRow(run))[0],{run_status:"blocked",ended_reason:"superseded"});
 assert.deepEqual(active(db,e.conv),[run2]);
 // Test mode (test_only tenant): claim through flow_claim_inbound, no canary audit row.
 ok(db,{sql:TEST_MODE},"test mode");
 const t=mk(db,"t1");
 startedOk(db,t,{canary:false});
 assert.deepEqual(counts(db,t),{claims:1,canary:0,receipts:1,runs:1,outbox:1});
 assert.deepEqual(v2(db,t),[{acquired:false,route:"flow"}]);
});

test("1) begin returns NULL: claim, canary audit, receipt, run and supersede all rolled back; V2 acquires",{skip},()=>{
 const db=clone("null");
 const e0=mk(db,"n0");const old=startedOk(db,e0);
 const cases=[["unknown flow",{flow:"nope"}],["trigger node mismatch",{start:"choose"}],["unpublished revision",{rev:2}],
  ["step 0",{step:0}]];
 for(const [label,o] of cases){
  const e=mk(db,`n_${label.replace(/\W/g,"")}`,A,ACC,e0.conv);
  const before=fp(db);
  assert.deepEqual(start(db,e,o),[],`${label}: no row`);
  assert.equal(fp(db),before,`${label}: nothing committed (older run, its outbox rows intact)`);
  assert.deepEqual(counts(db,e),ZERO,label);
  assert.deepEqual(active(db,e0.conv),[old],`${label}: older run still active (supersede undone)`);
  assert.deepEqual(v2(db,e),[{acquired:true,route:"legacy_ai"}],`${label}: V2 acquires the same key`);
 }
 // Account auto_reply off: in test mode flow_claim_inbound still acquires a 'flow' claim and begin
 // refuses it (rolled back); in canary mode the durable claim itself is not eligible. Both leave nothing.
 for(const canary of [true,false]){
  const d=clone("nullflag");
  if(!canary)ok(d,{sql:TEST_MODE},"test mode");
  ok(d,{sql:`UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}'`},"auto_reply off");
  const e=mk(d,"f1");const before=fp(d);
  assert.deepEqual(start(d,e,{canary}),[],`canary=${canary}`);
  assert.equal(fp(d),before);assert.deepEqual(counts(d,e),ZERO);
  assert.deepEqual(v2(d,e),[{acquired:true,route:"legacy_ai"}]);
 }
 // Test mode: the production claim body accepts a conversation without account_id
 // (route 'flow'), begin refuses it -> the claim is rolled back.
 const d=clone("nullacc");ok(d,{sql:TEST_MODE},"test mode");
 const e=mk(d,"u1");
 ok(d,{sql:`UPDATE public.conversations SET account_id=NULL WHERE id='${e.conv}'`},"unbound conversation");
 const probe=clone("nullaccprobe",d);
 assert.deepEqual(rows(probe,`SELECT acquired,route FROM public.flow_claim_inbound('${A}','${ACC}','instagram','${e.mid}','${e.conv}','${e.msg}',true)`,SR),
  [{acquired:true,route:"flow"}],"(the claim alone WOULD commit a flow claim)");
 const before=fp(d);
 assert.deepEqual(start(d,e,{canary:false}),[]);
 assert.equal(fp(d),before);assert.deepEqual(counts(d,e),ZERO);
 assert.deepEqual(v2(d,e),[{acquired:true,route:"legacy_ai"}]);
 // Mutation check: without the FB330 rollback (plain RETURN) the refused start leaves an orphaned claim.
 const m=clone("nullmut");
 const fnSrc=val(m,`SELECT pg_get_functiondef('${SIG}'::regprocedure)`);
 const mutated=fnSrc.replace(/RAISE EXCEPTION 'flow_claim_begin_durable_run: start refused'\s+USING ERRCODE='FB330';/,"RETURN;");
 assert.notEqual(mutated,fnSrc);
 ok(m,{sql:mutated+";"},"mutated body");
 const me=mk(m,"m1");
 assert.deepEqual(start(m,me,{flow:"nope"}),[]);
 assert.deepEqual(counts(m,me),{claims:1,canary:1,receipts:0,runs:0,outbox:0},"mutant commits the orphaned claim");
 assert.deepEqual(v2(m,me),[{acquired:false,route:"flow"}],"mutant: V2 silent (the original defect)");
});

test("2) begin raises P0001: the RPC errors, nothing is committed, V2 acquires",{skip},()=>{
 const db=clone("p0001");
 const e0=mk(db,"r0");const old=startedOk(db,e0);
 for(const [label,o,pre,re] of [
   ["first step rejected",{status:"bogus"},"",/First durable step rejected/],
   ["effects not an array",{effects:"{}"},"",/First durable step rejected/],
   ["injected fault in begin",{},"SET t.raise='on';\n",/injected fault/]]){
  for(const canary of [true,false]){
   const d=clone("p0001c",db);
   if(!canary)ok(d,{sql:TEST_MODE},"test mode");
   const e=mk(d,`r_${label.replace(/\W/g,"")}`,A,ACC,e0.conv);
   const before=fp(d);
   const r=psql(d,{sql:pre+`SET ROLE ${SR};\n`+callSql(e,{canary,...o})+";"});
   assert.notEqual(r.status,0,`${label}: must raise`);
   assert.match(r.stderr,re,label);
   assert.equal(sqlState(r.stderr),"P0001",label);
   assert.notEqual(sqlState(r.stderr),"FB330","the private SQLSTATE never escapes");
   assert.equal(fp(d),before,`${label} canary=${canary}: no partial change`);
   assert.deepEqual(counts(d,e),ZERO);
   assert.deepEqual(active(d,e0.conv),[old],"older run untouched");
   assert.deepEqual(v2(d,e),[{acquired:true,route:"legacy_ai"}]);
  }
 }
});

test("3) begin raises 23505 (one-active-run guard): the RPC errors, nothing is committed, V2 acquires",{skip},()=>{
 const db=clone("u23505");
 const e0=mk(db,"c0");const old=startedOk(db,e0);
 // Keep the older run active although superseded (fault injection), so the guard trigger fires.
 ok(db,{sql:`CREATE FUNCTION t.keep() RETURNS trigger LANGUAGE plpgsql AS $k$
  BEGIN IF NEW.ended_reason='superseded' THEN RETURN NULL; END IF; RETURN NEW; END $k$;
  CREATE TRIGGER keep BEFORE UPDATE ON public.automation_flow_runs FOR EACH ROW EXECUTE FUNCTION t.keep();`},"fault");
 for(const canary of [true,false]){
  const d=clone("u23505c",db);
  if(!canary)ok(d,{sql:TEST_MODE},"test mode");
  const e=mk(d,"c1",A,ACC,e0.conv);
  const before=fp(d);
  const r=psql(d,{sql:callSql(e,{canary})+";",role:SR});
  assert.notEqual(r.status,0);
  assert.equal(sqlState(r.stderr),"23505");assert.match(r.stderr,/flow_active_run_exists/);
  assert.equal(fp(d),before,`canary=${canary}: claim, audit, receipt and outbox cancels rolled back`);
  assert.deepEqual(counts(d,e),ZERO);
  assert.deepEqual(active(d,e0.conv),[old]);
  assert.deepEqual(v2(d,e),[{acquired:true,route:"legacy_ai"}]);
 }
});

test("7) test mode: flow_claim_inbound routes legacy_ai -> claim rolled back, no row; V2 acquires later",{skip},()=>{
 for(const [label,sql] of [
   ["no active activation",`UPDATE public.automation_flow_activations SET is_active=false WHERE tenant_id='${A}'`],
   ["global switch off","UPDATE public.automation_flow_global_switch SET enabled=false"],
   ["tenant neither test_only nor approved",`UPDATE public.automation_flow_tenant_switches SET test_only=false,production_approved=false WHERE tenant_id='${A}'`]]){
  const db=clone("legacy");ok(db,{sql:TEST_MODE},"test mode");ok(db,{sql},label);
  const e=mk(db,"l1");
  const probe=clone("legacyprobe",db);
  assert.deepEqual(rows(probe,`SELECT acquired,route FROM public.flow_claim_inbound('${A}','${ACC}','instagram','${e.mid}','${e.conv}','${e.msg}',true)`,SR),
   [{acquired:true,route:"legacy_ai"}],`${label}: (the claim alone WOULD commit legacy_ai)`);
  const before=fp(db);
  assert.deepEqual(start(db,e,{canary:false}),[],label);
  assert.equal(fp(db),before,label);assert.deepEqual(counts(db,e),ZERO);
  assert.deepEqual(v2(db,e),[{acquired:true,route:"legacy_ai"}],label);
 }
 // Canary mode with a test_only tenant: the durable claim is not eligible -> no row, nothing written.
 const db=clone("legacycanary");ok(db,{sql:TEST_MODE},"test mode");
 const e=mk(db,"l2");const before=fp(db);
 assert.deepEqual(start(db,e,{canary:true}),[]);assert.equal(fp(db),before);
});

test("8) forged / cross-tenant ids and invalid arguments: no row, no claim, no run",{skip},()=>{
 const db=clone("forged");
 const ea=mk(db,"a1"),eb=mk(db,"b1",B,ACCB);
 const ea0=mk(db,"a0",A,ACC,ea.conv);const aRun=startedOk(db,ea0);
 const FOREIGN="99999999-9999-4999-8999-999999999999";
 const cases=[
  ["tenant B with tenant A's event",ea,{tenant:B,flow:"bflow"}],
  ["tenant A with tenant B's event",eb,{tenant:A,flow:"buttons"}],
  ["tenant A event, tenant B account",ea,{acc:ACCB}],
  ["tenant A event, tenant B conversation",ea,{conv:eb.conv}],
  ["tenant A event, tenant B inbound",ea,{msg:eb.msg}],
  ["tenant B event, tenant A conversation",eb,{conv:ea.conv}],
  ["unknown inbound",ea,{msg:FOREIGN}],["unknown conversation",ea,{conv:FOREIGN}],["unknown account",ea,{acc:FOREIGN}],
  ["forged event id",ea,{mid:"mid.forged"}],["other platform",ea,{platform:"facebook"}],
  ...["canary","tenant","acc","platform","mid","conv","msg","flow","rev","start","next","step","status","vars","effects"]
   .map(k=>[`NULL ${k}`,ea,{[k]:null}])];
 for(const canary of [true,false]){
  const d=clone("forgedc",db);
  if(!canary)ok(d,{sql:TEST_MODE},"test mode");
  for(const [label,e,o] of cases){
   const before=fp(d);
   assert.deepEqual(start(d,e,{canary,...o}),[],`${label} canary=${canary}`);
   assert.equal(fp(d),before,`${label} canary=${canary}: nothing changed`);
  }
  assert.deepEqual(active(d,ea.conv),[aRun],"tenant A run untouched");
  // The legitimate calls still work afterwards.
  startedOk(d,eb,{canary});startedOk(d,ea,{canary});
 }
});

test("5) V2 racing the atomic start on another connection: exactly one owner, no unique-violation leak",{skip},async()=>{
 // (a) atomic start first, held open inside begin (after claim + advisory lock); V2 waits, then sees a duplicate.
 {
  const db=clone("race_a");const e=mk(db,"x1");
  const s=psqlAsync(db,`SET t.sleep='on';\nSET ROLE ${SR};\n${callSql(e)};\n`);
  await wait(400);
  const t0=Date.now();
  const v=await psqlAsync(db,`SET ROLE ${SR};\n${v2Sql(e)};\n`);
  const r=await s;
  assert.equal(r.code,0,r.err);assert.equal(v.code,0,v.err);
  assert.match(r.out,/^t\|[0-9a-f-]{36}$/m,"atomic start owns it");
  assert.deepEqual(outLines(v.out),["f|flow"],"V2 waited and then saw the committed claim");
  assert.ok(v.end>=r.end-150&&v.end-t0>=600,`V2 waited for the start to commit (${v.end-t0} ms)`);
  assert.deepEqual(counts(db,e),{claims:1,canary:1,receipts:1,runs:1,outbox:1});
 }
 // (a') atomic start holds the claim and waits on the conversation advisory lock held by a third
 // connection, which meanwhile deactivates the flow; begin then refuses -> FB330 rollback of the
 // claim; the queued V2 claim wakes up and acquires. Lock order claim -> advisory, V2 claim only.
 {
  const db=clone("race_a2");const e=mk(db,"x2");
  const holder=psqlAsync(db,`BEGIN;\nSELECT pg_advisory_xact_lock(hashtextextended('flow_active_run:${A}:${e.conv}',0));\n`+
   `UPDATE public.automation_flow_activations SET is_active=false WHERE tenant_id='${A}' AND flow_key='buttons';\n`+
   `SELECT pg_sleep(1.5);\nCOMMIT;\n`);
  await wait(300);
  // The canary claim needs an active activation at claim time: claim BEFORE the holder's update
  // commits (READ COMMITTED: the update is not visible yet).
  const s=psqlAsync(db,`SET ROLE ${SR};\n${callSql(e)};\n`);
  await wait(300);
  // Probe: the start holds an uncommitted claim on this key while it waits for the advisory lock.
  const probe=await psqlAsync(db,`SET lock_timeout='100ms';\nSET ROLE ${SR};\n${v2Sql(e)};\n`);
  assert.notEqual(probe.code,0);assert.match(probe.err,/55P03|lock timeout/,"claim entry held by the waiting start");
  const v=psqlAsync(db,`SET ROLE ${SR};\n${v2Sql(e)};\n`);
  const [h,r,w]=await Promise.all([holder,s,v]);
  assert.equal(h.code,0,h.err);assert.equal(r.code,0,r.err);assert.equal(w.code,0,w.err);
  assert.deepEqual(outLines(r.out),[],"refused start: no row");
  assert.deepEqual(outLines(w.out),["t|legacy_ai"],"V2 acquired after the rollback");
  assert.ok(w.end>=h.end-150&&r.end>=h.end-150,`start and V2 both waited for the lock holder (${w.end-h.end}/${r.end-h.end} ms)`);
  assert.deepEqual(counts(db,e),{claims:1,canary:0,receipts:0,runs:0,outbox:0});
  assert.equal(val(db,`SELECT route FROM public.automation_message_claims WHERE provider_event_id='${e.mid}'`),"legacy_ai");
 }
 // (b) V2 first, held open; the atomic start waits on the claim entry, then returns (false,NULL).
 {
  const db=clone("race_b");const e=mk(db,"x3");
  const v=psqlAsync(db,`SET ROLE ${SR};\nBEGIN;\n${v2Sql(e)};\nSELECT pg_sleep(1.5);\nCOMMIT;\n`);
  await wait(400);
  const r=await psqlAsync(db,`SET ROLE ${SR};\n${callSql(e)};\n`);
  const w=await v;
  assert.equal(w.code,0,w.err);assert.equal(r.code,0,r.err);
  assert.deepEqual(outLines(w.out),["t|legacy_ai"]);
  assert.deepEqual(outLines(r.out),["f|"],"(false,NULL): V2 owns it");
  assert.ok(r.ms>=700&&r.end>=w.end-150,`the start waited on V2's uncommitted claim (${r.ms} ms)`);
  assert.deepEqual(counts(db,e),{claims:1,canary:0,receipts:0,runs:0,outbox:0});
 }
 // (b') V2 first but rolls back: the waiting atomic start acquires and starts.
 {
  const db=clone("race_b2");const e=mk(db,"x4");
  const v=psqlAsync(db,`SET ROLE ${SR};\nBEGIN;\n${v2Sql(e)};\nSELECT pg_sleep(1.5);\nROLLBACK;\n`);
  await wait(400);
  const r=await psqlAsync(db,`SET ROLE ${SR};\n${callSql(e)};\n`);
  assert.equal((await v).code,0);assert.equal(r.code,0,r.err);
  assert.match(r.out,/^t\|[0-9a-f-]{36}$/m);
  assert.deepEqual(counts(db,e),{claims:1,canary:1,receipts:1,runs:1,outbox:1});
 }
 // Same races in test mode (both use flow_claim_inbound on the same key).
 {
  const db=clone("race_t");ok(db,{sql:TEST_MODE},"test mode");const e=mk(db,"x5");
  const s=psqlAsync(db,`SET t.sleep='on';\nSET ROLE ${SR};\n${callSql(e,{canary:false})};\n`);
  await wait(400);
  const v=await psqlAsync(db,`SET ROLE ${SR};\n${v2Sql(e)};\n`);
  const r=await s;
  assert.equal(r.code,0,r.err);assert.equal(v.code,0,v.err);
  assert.match(r.out,/^t\|[0-9a-f-]{36}$/m);assert.deepEqual(outLines(v.out),["f|flow"]);
  const e2=mk(db,"x6");
  const w=psqlAsync(db,`SET ROLE ${SR};\nBEGIN;\n${v2Sql(e2)};\nSELECT pg_sleep(1.5);\nCOMMIT;\n`);
  await wait(400);
  const r2=await psqlAsync(db,`SET ROLE ${SR};\n${callSql(e2,{canary:false})};\n`);
  assert.equal((await w).code,0);assert.equal(r2.code,0,r2.err);
  assert.deepEqual(outLines(r2.out),["f|"]);
  assert.deepEqual(counts(db,e2),{claims:1,canary:0,receipts:0,runs:0,outbox:0});
 }
});

test("6) concurrent atomic starts: same event -> one run; different events of one conversation -> no deadlock",{skip},async()=>{
 for(const canary of [true,false]){
  const db=clone("conc");if(!canary)ok(db,{sql:TEST_MODE},"test mode");
  const e=mk(db,"k1");
  const s1=psqlAsync(db,`SET t.sleep='on';\nSET ROLE ${SR};\n${callSql(e,{canary})};\n`);
  await wait(400);
  const s2=psqlAsync(db,`SET ROLE ${SR};\n${callSql(e,{canary})};\n`);
  const [r1,r2]=await Promise.all([s1,s2]);
  assert.equal(r1.code,0,r1.err);assert.equal(r2.code,0,r2.err);
  assert.match(r1.out,/^t\|[0-9a-f-]{36}$/m);
  assert.deepEqual(outLines(r2.out),["f|"],"second delivery: (false,NULL)");
  assert.deepEqual(counts(db,e),{claims:1,canary:canary?1:0,receipts:1,runs:1,outbox:1});
  // Different events of the SAME conversation, started together several times
  // (each holds its own claim entry, they serialize on the conversation advisory lock).
  const c0=mk(db,"d0");startedOk(db,c0,{canary});
  for(let i=0;i<3;i++){
   const a=mk(db,`d${i}a`,A,ACC,c0.conv),b=mk(db,`d${i}b`,A,ACC,c0.conv);
   const p1=psqlAsync(db,`SET t.sleep='on';\nSET ROLE ${SR};\n${callSql(a,{canary})};\n`);
   await wait(i===2?0:200);
   const p2=psqlAsync(db,`SET ROLE ${SR};\n${callSql(b,{canary})};\n`);
   const [q1,q2]=await Promise.all([p1,p2]);
   assert.equal(q1.code,0,q1.err);assert.equal(q2.code,0,q2.err);
   assert.doesNotMatch(q1.err+q2.err,/deadlock|40P01|23505/);
   assert.match(q1.out,/^t\|/m);assert.match(q2.out,/^t\|/m);
   assert.equal(active(db,c0.conv).length,1,"at most one active run");
  }
  // Two starts racing on different events, each also raced by V2 on the other's key.
  const x=mk(db,"y1",A,ACC,c0.conv),y=mk(db,"y2",A,ACC,c0.conv);
  const all=await Promise.all([
   psqlAsync(db,`SET t.sleep='on';\nSET ROLE ${SR};\n${callSql(x,{canary})};\n`),
   (async()=>{await wait(150);return psqlAsync(db,`SET ROLE ${SR};\n${callSql(y,{canary})};\n`);})(),
   (async()=>{await wait(300);return psqlAsync(db,`SET ROLE ${SR};\n${v2Sql(x)};\n${v2Sql(y)};\n`);})()]);
  for(const q of all){assert.equal(q.code,0,q.err);assert.doesNotMatch(q.err,/deadlock|40P01|23505/);}
  assert.deepEqual(outLines(all[2].out),["f|flow","f|flow"],"V2 duplicates on both keys");
  assert.equal(active(db,c0.conv).length,1);
 }
});

test("9a) privileges, attributes, argument names, hostile search_path",{skip},()=>{
 const db=clone("acl");
 for(const role of ["anon","authenticated","public"])
  assert.equal(val(db,`SELECT has_function_privilege('${role}','${SIG}','EXECUTE')`),false,role);
 assert.equal(val(db,`SELECT has_function_privilege('service_role','${SIG}','EXECUTE')`),true);
 const meta=rows(db,`SELECT p.prosecdef,p.proconfig,p.provolatile,p.proisstrict,p.pronargdefaults,p.proargnames,
  pg_get_function_result(p.oid) AS res,(SELECT lanname FROM pg_language l WHERE l.oid=p.prolang) AS lang,
  obj_description(p.oid,'pg_proc') AS marker FROM pg_proc p WHERE p.oid='${SIG}'::regprocedure`)[0];
 assert.deepEqual(meta,{prosecdef:false,proconfig:['search_path=""'],provolatile:"v",proisstrict:false,pronargdefaults:0,
  proargnames:["p_canary","p_tenant","p_account","p_platform","p_event","p_conversation","p_inbound","p_flow","p_revision",
   "p_start","p_next","p_next_step","p_status","p_variables","p_wake","p_effects","acquired","run_id"],
  res:"TABLE(acquired boolean, run_id uuid)",lang:"plpgsql",marker:MARK});
 const e=mk(db,"p1");
 for(const role of ["anon","authenticated"]){
  const r=psql(db,{sql:callSql(e)+";",role});
  assert.notEqual(r.status,0);assert.equal(sqlState(r.stderr),"42501",role);
 }
 assert.deepEqual(counts(db,e),ZERO);
 // Only the new function differs from the pre-migration schema: no table/column/index/trigger/ACL
 // (and so no DELETE grant) is introduced or changed.
 assert.equal(fp(db,false,"flow_claim_begin_durable_run"),fp("c300",false,"flow_claim_begin_durable_run"));
 assert.equal(val(db,`SELECT count(*) FROM pg_proc WHERE proname='flow_claim_begin_durable_run'`),1);
 // Hostile search_path: public objects are used, never a shadow schema.
 ok(db,{sql:`CREATE SCHEMA evil; GRANT USAGE ON SCHEMA evil TO service_role;
  CREATE FUNCTION evil.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
   RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
  GRANT EXECUTE ON FUNCTION evil.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb) TO service_role;`},"evil");
 const r=psql(db,{sql:`SET search_path=evil,public;\n${callSql(e)};`,role:SR});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout.trim(),/^t\|[0-9a-f-]{36}$/);
});

test("9b) migration: idempotent re-apply; preflight refusals",{skip},()=>{
 const db=clone("idem");
 const once=fp(db);
 ok(db,{file:MIG},"re-apply");
 assert.equal(fp(db),once,"re-apply changes nothing");
 // The REPO flow_claim_inbound body (a70c60d7...) is refused: production body required.
 refused(clone("pfrepo","repo"),MIG,/public\.flow_claim_inbound\(uuid,uuid,text,text,uuid,uuid,boolean\) does not have the expected definition/,"repo claim body");
 const CLAIM_HEAD=between(src(PROD_CLAIM),"BEGIN;\n","AS $claim$");
 const prodBody=between(src(PROD_CLAIM),"AS $claim$","$claim$");
 for(const [label,sql,re,tpl] of [
  ["claim body tampered (marker kept)",`${CLAIM_HEAD}AS $claim$${prodBody.replace("legacy_ai","legacy_ai ")}$claim$;`,
   /flow_claim_inbound\(uuid,uuid,text,text,uuid,uuid,boolean\) does not have the expected definition/],
  ["claim marker missing",`COMMENT ON FUNCTION ${CLAIM_SIG} IS NULL;`,/lacks marker CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM/],
  ["claim extra overload","CREATE FUNCTION public.flow_claim_inbound(uuid) RETURNS uuid LANGUAGE sql AS 'SELECT $1';",
   /Unrecognized overload of public\.flow_claim_inbound;/],
  ["claim SECURITY DEFINER",`ALTER FUNCTION ${CLAIM_SIG} SECURITY DEFINER;`,/flow_claim_inbound\(.*does not have the expected definition/],
  ["durable claim marker missing",`COMMENT ON FUNCTION ${DURABLE_SIG} IS 'x';`,/lacks marker CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE/],
  ["durable claim body tampered",`SELECT 1;`,/flow_claim_inbound_durable\(.*does not have the expected definition/,"c210like"],
  ["superseding missing",`DROP FUNCTION ${SUPER_SIG} CASCADE;`,/Missing function public\.flow_begin_durable_run_superseding/],
  ["superseding search_path changed",`ALTER FUNCTION ${SUPER_SIG} SET search_path=public;`,/flow_begin_durable_run_superseding\(.*does not have the expected definition/],
  ["begin extra overload","CREATE FUNCTION public.flow_begin_durable_run(uuid) RETURNS uuid LANGUAGE sql AS 'SELECT $1';",
   /Unrecognized overload of public\.flow_begin_durable_run;/],
  ["begin marker missing",`COMMENT ON FUNCTION ${BEGIN_SIG} IS 'operator';`,/lacks marker CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS/],
  ["canary claims table unmarked","COMMENT ON TABLE public.automation_flow_canary_claims IS NULL;",/Unrecognized table public\.automation_flow_canary_claims/],
  ["claims table unmarked","COMMENT ON TABLE public.automation_message_claims IS 'x';",/Unrecognized table public\.automation_message_claims/],
  ["guard trigger disabled","ALTER TABLE public.automation_flow_runs DISABLE TRIGGER flow_one_active_run_guard;",/trigger flow_one_active_run_guard/],
  ["new function unmarked",`COMMENT ON FUNCTION ${SIG} IS 'operator';`,/Unrecognized existing function public\.flow_claim_begin_durable_run; refusing to overwrite/],
  ["new function marked, foreign body",`CREATE OR REPLACE FUNCTION ${SIG.replace(ARGS,"p_canary boolean,p_tenant uuid,p_account uuid,p_platform text,p_event text,p_conversation uuid,p_inbound uuid,p_flow text,p_revision bigint,p_start text,p_next text,p_next_step integer,p_status text,p_variables jsonb,p_wake timestamptz,p_effects jsonb")}
    RETURNS TABLE(acquired boolean,run_id uuid) LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $x$BEGIN RETURN; END$x$;`,
   /carries the marker but not this migration's body/],
  ["new function foreign overload","CREATE FUNCTION public.flow_claim_begin_durable_run(uuid) RETURNS uuid LANGUAGE sql AS 'SELECT $1';",
   /Unrecognized overload of public\.flow_claim_begin_durable_run exists/]]){
  if(tpl==="c210like"){
   // 170000 body of flow_claim_inbound_durable (marker kept) instead of the 230000 one.
   const d=clone("pf","c300");
   const s170=src(M+"20261029170000_flow_canary_claim_durable.sql");
   const i=s170.indexOf("CREATE OR REPLACE FUNCTION public.flow_claim_inbound_durable(");
   const def170=s170.slice(i,s170.indexOf("$claim$;",i)+"$claim$;".length);
   assert.ok(i>0&&def170.endsWith("$claim$;"));
   ok(d,{sql:def170},label);
   assert.equal(val(d,`SELECT obj_description('${DURABLE_SIG}'::regprocedure,'pg_proc')`),"CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE");
   refused(d,MIG,re,label);
   continue;
  }
  const d=clone("pf",label.startsWith("new function")?"g330":"c300");
  ok(d,{sql},label);
  refused(d,MIG,re,label);
 }
 refused(clone("bare","template1"),MIG,/Claim\+begin prerequisite missing: public\.automation_message_claims/,"empty database");
});

test("9c) rollback: drops only its own function; refused when absent, unmarked or foreign body",{skip},()=>{
 const db=clone("rb");
 const e=mk(db,"k1");const run=startedOk(db,e);
 const data=rows(db,"SELECT id,run_status FROM public.automation_flow_runs ORDER BY id");
 const claims=rows(db,"SELECT id,route FROM public.automation_message_claims ORDER BY id");
 ok(db,{file:RB},"330000 rollback");
 assert.equal(val(db,`SELECT to_regprocedure('${SIG}') IS NULL`),true);
 assert.equal(fp(db,false),fp("c300",false),"schema identical to the pre-330000 state");
 assert.deepEqual(rows(db,"SELECT id,run_status FROM public.automation_flow_runs ORDER BY id"),data,"no run touched");
 assert.deepEqual(rows(db,"SELECT id,route FROM public.automation_message_claims ORDER BY id"),claims,"no claim touched");
 assert.match(String(run),UUID);
 refused(db,RB,/20261029330000_flow_claim_begin_durable_run not installed; nothing to roll back/,"rollback twice");
 ok(db,{file:MIG},"re-apply");assert.equal(fp(db,false),fp("g330",false));
 const u=clone("rbu");
 ok(u,{sql:`COMMENT ON FUNCTION ${SIG} IS 'operator note';`},"unmark");
 refused(u,RB,/Refusing to drop unrecognized function public\.flow_claim_begin_durable_run \(marker=operator note\)/,"unmarked");
 const f=clone("rbf");
 const def=val(f,`SELECT pg_get_functiondef('${SIG}'::regprocedure)`);
 ok(f,{sql:def.replace("v_outcome:='lost';","v_outcome:='none';")+";"},"foreign body, marker kept");
 assert.equal(val(f,`SELECT obj_description('${SIG}'::regprocedure,'pg_proc')`),MARK);
 refused(f,RB,/marked but its body is not the 20261029330000 definition/,"foreign body");
 assert.equal(val(f,`SELECT to_regprocedure('${SIG}') IS NOT NULL`),true);
});

// ---- Preflight: service_role EXECUTE on every callee and the critical FKs (matched structurally).
const FK4="tenant_id,channel_account_id,platform,provider_event_id";
const fkName=(rel,ref)=>`SELECT conname FROM pg_constraint WHERE contype='f' AND conrelid='public.${rel}'::regclass AND confrelid='public.${ref}'::regclass`;
const dropFk=(rel,ref)=>`DO $d$ DECLARE n text; BEGIN ${fkName(rel,ref)} INTO STRICT n;
 EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I','${rel}',n); END $d$;`;
test("9d) preflight refuses without service_role EXECUTE on any called function",{skip},()=>{
 for(const sig of [CLAIM_SIG,DURABLE_SIG,SUPER_SIG,BEGIN_SIG]){
  const d=clone("pfx","c300");
  ok(d,{sql:`REVOKE EXECUTE ON FUNCTION ${sig} FROM service_role;`},sig);
  assert.equal(val(d,`SELECT has_function_privilege('service_role','${sig}','EXECUTE')`),false,`${sig}: no PUBLIC grant masks the revoke`);
  const re=new RegExp("Claim\\+begin prerequisite missing: EXECUTE on "+sig.replace(/[()+.]/g,"\\$&")+" for service_role");
  refused(d,MIG,re,`EXECUTE revoked: ${sig}`);
  // Same on a database where 330000 is already installed (re-apply).
  const g=clone("pfxg","g330");
  ok(g,{sql:`REVOKE EXECUTE ON FUNCTION ${sig} FROM service_role;`},sig);
  refused(g,MIG,re,`EXECUTE revoked (re-apply): ${sig}`);
 }
});
test("9e) preflight refuses a missing or different critical FK; constraint names are irrelevant",{skip},()=>{
 const runsReceipts=/Claim\+begin prerequisite missing: foreign key public\.automation_flow_runs\(tenant_id,channel_account_id,platform,provider_event_id\) -> public\.automation_flow_event_receipts\(tenant_id,channel_account_id,platform,provider_event_id\)$/m;
 const canary=/Claim\+begin prerequisite missing: foreign key public\.automation_flow_canary_claims\(tenant_id,channel_account_id,platform,provider_event_id\) -> public\.automation_message_claims\(tenant_id,channel_account_id,platform,provider_event_id\) with NO ACTION \(no cascade\)/;
 const runsTenants=/Claim\+begin prerequisite missing: foreign key public\.automation_flow_runs\(tenant_id\) -> public\.tenants\(id\)$/m;
 // The fixture holds exactly one FK per pair (names differ from production).
 for(const [rel,ref] of [["automation_flow_runs","automation_flow_event_receipts"],
   ["automation_flow_canary_claims","automation_message_claims"],["automation_flow_runs","tenants"]])
  assert.equal(rows("c300",fkName(rel,ref)).length,1,`${rel}->${ref}`);
 const RECANARY=(cols,act="")=>dropFk("automation_flow_canary_claims","automation_message_claims")+
  `\nALTER TABLE public.automation_flow_canary_claims ADD CONSTRAINT x_fk FOREIGN KEY(${cols})
   REFERENCES public.automation_message_claims(${cols})${act};`;
 for(const [label,sql,re] of [
  ["runs->receipts dropped",dropFk("automation_flow_runs","automation_flow_event_receipts"),runsReceipts],
  ["runs->receipts replaced by a 3-column FK to another table",dropFk("automation_flow_runs","automation_flow_event_receipts")+
   `\nALTER TABLE public.automation_flow_runs ADD CONSTRAINT x_fk FOREIGN KEY(${FK4})
    REFERENCES public.automation_flow_canary_claims(${FK4}) NOT VALID;`,runsReceipts],
  ["canary->claims dropped",dropFk("automation_flow_canary_claims","automation_message_claims"),canary],
  ["canary->claims recreated ON DELETE CASCADE",RECANARY(FK4," ON DELETE CASCADE"),canary],
  ["canary->claims recreated ON DELETE RESTRICT (not NO ACTION)",RECANARY(FK4," ON DELETE RESTRICT"),canary],
  ["canary->claims recreated with a different column order",
   RECANARY("channel_account_id,tenant_id,platform,provider_event_id"),canary],
  ["runs->tenants dropped",dropFk("automation_flow_runs","tenants"),runsTenants]]){
  for(const tpl of ["c300","g330"]){
   const d=clone("pffk",tpl);
   ok(d,{sql},label);
   refused(d,MIG,re,`${label} (${tpl})`);
  }
 }
 // Renamed constraints (production names) still pass: matched by structure, not name.
 const d=clone("pfname","c300");
 ok(d,{sql:`DO $d$ DECLARE r record; BEGIN
  FOR r IN SELECT c.conrelid::regclass AS rel,c.conname,x.nn FROM pg_constraint c JOIN (VALUES
   ('public.automation_flow_runs'::regclass,'public.automation_flow_event_receipts'::regclass,'automation_flow_runs_tenant_id_channel_account_id_platform_fkey'),
   ('public.automation_flow_canary_claims'::regclass,'public.automation_message_claims'::regclass,'renamed_canary_claim_fk'),
   ('public.automation_flow_runs'::regclass,'public.tenants'::regclass,'renamed_runs_tenant_fk')) x(rel,ref,nn)
   ON c.conrelid=x.rel AND c.confrelid=x.ref AND c.contype='f'
  LOOP IF r.conname<>r.nn THEN EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',r.rel,r.conname,r.nn); END IF; END LOOP;
 END $d$;`},"rename FKs");
 ok(d,{file:MIG},"applies with renamed FKs");
 assert.equal(val(d,`SELECT obj_description('${SIG}'::regprocedure,'pg_proc')`),MARK);
 // runs->tenants: any referential action is accepted (production: CASCADE); only the columns matter.
 const c=clone("pfcas","c300");
 ok(c,{sql:dropFk("automation_flow_runs","tenants")+
  "\nALTER TABLE public.automation_flow_runs ADD CONSTRAINT t_fk FOREIGN KEY(tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;"},"cascade tenants FK");
 ok(c,{file:MIG},"applies with runs->tenants ON DELETE CASCADE");
});

// ---- Retry rationale (the Edge repeats an ambiguous call ONCE with identical arguments).
test("10) identical second call: committed first -> (false,NULL); rolled back first -> acquires; in flight -> waits",{skip},async()=>{
 for(const canary of [true,false]){
  const db=clone("retry");if(!canary)ok(db,{sql:TEST_MODE},"test mode");
  const one={claims:1,canary:canary?1:0,receipts:1,runs:1,outbox:1};
  // (a) first attempt committed (response lost): the retry sees acquired=false and changes nothing.
  const e=mk(db,"r1");
  const run=startedOk(db,e,{canary});
  const before=fp(db);
  assert.deepEqual(start(db,e,{canary}),[{acquired:false,run_id:null}],`canary=${canary}: retry after commit`);
  assert.equal(fp(db),before,"retry after commit changes nothing");
  assert.deepEqual(counts(db,e),one);
  assert.deepEqual(rows(db,runRow(run))[0],{run_status:"awaiting_input",ended_reason:null});
  // (b) first attempt rolled back (client gone / transaction aborted): the retry acquires.
  const f=mk(db,"r2");
  let r=psql(db,{sql:`SET ROLE ${SR};\nBEGIN;\n${callSql(f,{canary})};\nROLLBACK;\n`});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/^t\|[0-9a-f-]{36}$/m,"(the first attempt had acquired)");
  assert.deepEqual(counts(db,f),ZERO);
  startedOk(db,f,{canary});assert.deepEqual(counts(db,f),one);
  // (b') first attempt raised (e.g. statement timeout): nothing committed, the retry acquires.
  const g=mk(db,"r3");
  r=psql(db,{sql:`SET t.raise='on';\nSET ROLE ${SR};\n${callSql(g,{canary})};\n`});
  assert.notEqual(r.status,0);assert.deepEqual(counts(db,g),ZERO);
  startedOk(db,g,{canary});assert.deepEqual(counts(db,g),one);
  // (c) first attempt still in flight: the retry blocks on the claim unique entry, then sees (false,NULL).
  const h=mk(db,"r4");
  const s1=psqlAsync(db,`SET t.sleep='on';\nSET ROLE ${SR};\n${callSql(h,{canary})};\n`);
  await wait(400);
  const s2=await psqlAsync(db,`SET ROLE ${SR};\n${callSql(h,{canary})};\n`);
  const r1=await s1;
  assert.equal(r1.code,0,r1.err);assert.equal(s2.code,0,s2.err);
  assert.match(r1.out,/^t\|[0-9a-f-]{36}$/m);
  assert.deepEqual(outLines(s2.out),["f|"],"in-flight first attempt committed: retry gets (false,NULL)");
  assert.ok(s2.ms>=700&&s2.end>=r1.end-150,`retry waited for the first attempt (${s2.ms} ms)`);
  assert.deepEqual(counts(db,h),one);
  // (c') first attempt in flight and then rolled back: the waiting retry acquires.
  const k=mk(db,"r5");
  const s3=psqlAsync(db,`SET ROLE ${SR};\nBEGIN;\n${callSql(k,{canary})};\nSELECT pg_sleep(1.5);\nROLLBACK;\n`);
  await wait(400);
  const s4=await psqlAsync(db,`SET ROLE ${SR};\n${callSql(k,{canary})};\n`);
  const r3=await s3;
  assert.equal(r3.code,0,r3.err);assert.equal(s4.code,0,s4.err);
  assert.match(s4.out,/^t\|[0-9a-f-]{36}$/m,"retry acquired after the first attempt rolled back");
  assert.ok(s4.ms>=700,`retry waited (${s4.ms} ms)`);
  assert.deepEqual(counts(db,k),one);
  // (d) not eligible: both attempts return no row and nothing is ever written.
  const n=mk(db,"r6");const b0=fp(db);
  assert.deepEqual(start(db,n,{canary,flow:"nope"}),[]);assert.deepEqual(start(db,n,{canary,flow:"nope"}),[]);
  assert.equal(fp(db),b0);
 }
});
