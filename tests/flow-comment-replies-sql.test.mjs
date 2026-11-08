// 20261029300000_comment_replies: comment automation storage and ordering.
// automation_comment_replies (durable comment dedupe + activity log, tenant
// RLS), 'reply_comment' effect kind, flow_begin_comment_run,
// flow_claim_comment_reply / flow_finish_comment_reply, the DM gate in
// flow_reserve_outbox_delivery and the sweep of reply_comment effects.
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) built like
// tests/flow-multichannel-support.test.mjs (fixture chain, migrations
// 20261028220000 .. 20261029230000, then 20261029300000). Never connects to a
// remote host; inherited PG* variables are stripped.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const M="supabase/migrations/",R="supabase/rollbacks/";
const MIG=M+"20261029300000_comment_replies.sql",RB=R+"20261029300000_comment_replies.rollback.sql";
const M210=M+"20261029210000_flow_media_effects.sql",M220=M+"20261029220000_flow_media_stale_sweep.sql",
 M230=M+"20261029230000_flow_multichannel_support.sql";
const CHAIN125_190=[M+"20261029125000_flow_durable_button_run.sql",M+"20261029130000_flow_run_lifecycle.sql",
 M+"20261029140000_flow_outbox_ai_retry.sql",M+"20261029150000_flow_takeover_resume.sql",
 M+"20261029160000_flow_credits_pause.sql",M+"20261029170000_flow_canary_claim_durable.sql",
 M+"20261029180000_flow_durable_button_run_guards.sql",M+"20261029190000_flow_begin_durable_run_superseding.sql"];
const MARK="CREATED_BY_20261029300000_COMMENT_REPLIES";
const SIGS={
 advance:"public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)",
 reserve:"public.flow_reserve_outbox_delivery(uuid,uuid)",
 skip_many:"public.flow_skip_blocked_outbox(integer,integer)"};
const NEW_SIGS=["public.flow_begin_comment_run(uuid,uuid,uuid,uuid,text,text,text,text,text,text,bigint,text,text,integer,jsonb)",
 "public.flow_claim_comment_reply(uuid,uuid,integer)",
 "public.flow_finish_comment_reply(uuid,uuid,uuid,text,text,text,integer,boolean,integer)"];
const src=f=>readFileSync(f,"utf8");
const md5=x=>createHash("md5").update(x).digest("hex");
const norm=x=>x.replace(/[ \t\n\r\f\v]+/g," ").replace(/^ +| +$/g,"");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");
const body=(f,tag)=>{const s=src(f),a=s.indexOf(`AS $${tag}$`);assert.ok(a>=0,`${f} ${tag}`);
 return s.slice(a+tag.length+5,s.indexOf(`$${tag}$`,a+tag.length+5));};
const PREV={advance:body(M230,"advance"),reserve:body(M230,"reserve"),skip_many:body(M220,"skip_many")};
const lines=s=>s.split("\n");
const added=(prev,now)=>lines(now).filter(l=>!lines(prev).includes(l));
const removed=(prev,now)=>lines(prev).filter(l=>!lines(now).includes(l));

// ---------------------------------------------------------------- static
test("300000 is the newest migration; rollback exists",()=>{
 const stamps=readdirSync(M).filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 assert.equal(stamps.filter(s=>s==="20261029300000").length,1);
 for(const s of stamps)assert.ok(s<="20261029300000",s);
 assert.ok(existsSync(RB));
});
test("migration and rollback: one bounded transaction, no SECURITY DEFINER, no billing, service_role-only RPCs",()=>{
 for(const f of [MIG,RB]){
  const s=src(f),code=noComments(s);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
  assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1,f);assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.doesNotMatch(code,/SECURITY DEFINER|\bTRUNCATE\b|consume_|credits_remaining|wayl|topup|cron\.|vault\.|net\.http_/i,f);
  assert.doesNotMatch(code,/GRANT EXECUTE[^;]*\bTO\s+(anon|authenticated|PUBLIC)\b/i,f);
 }
 const code=noComments(src(MIG));
 // The only grant to a client role: SELECT on the activity table (RLS-filtered).
 const clientGrants=[...code.matchAll(/^GRANT [^;]*TO (anon|authenticated|PUBLIC)\b[^;]*;/gm)].map(m=>m[0]);
 assert.deepEqual(clientGrants,["GRANT SELECT ON public.automation_comment_replies TO authenticated;"]);
 assert.match(code,/ALTER TABLE public\.automation_comment_replies ENABLE ROW LEVEL SECURITY;/);
 assert.match(code,/FOR SELECT TO authenticated\n\s+USING \(tenant_id IN \(SELECT t\.id FROM public\.tenants t WHERE t\.user_id = \(SELECT auth\.uid\(\)\)\)\);/);
 for(const sig of [...Object.values(SIGS),...NEW_SIGS]){
  assert.ok(code.includes(`REVOKE ALL ON FUNCTION ${sig}\n FROM PUBLIC,anon,authenticated;`),sig);
  assert.ok(code.includes(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`),sig);
 }
 for(const sig of NEW_SIGS)assert.ok(code.includes(`COMMENT ON FUNCTION ${sig} IS '${MARK}';`),sig);
 assert.equal((code.match(/SECURITY INVOKER SET search_path=''/g)??[]).length,6);
});
test("bodies: only the documented lines change; rollback restores the exact previous bodies",()=>{
 const m=src(MIG),r=src(RB);
 for(const k of Object.keys(PREV)){
  assert.equal(body(RB,k),PREV[k],`${k}: rollback body byte-identical`);
  const pair=`'${md5(norm(PREV[k]))}','${md5(norm(body(MIG,k)))}')`;
  assert.ok(m.includes(pair)&&r.includes(pair),`${k}: hashes embedded`);
 }
 const adv=body(MIG,"advance");
 assert.deepEqual(removed(PREV.advance,adv),["     kind NOT IN('message','question','delay','handoff','tag','untag','staff_notification','message_image') OR"]);
 assert.deepEqual(added(PREV.advance,adv),["     kind NOT IN('message','question','delay','handoff','tag','untag','staff_notification','message_image','reply_comment') OR"]);
 const res=body(MIG,"reserve");
 assert.deepEqual(removed(PREV.reserve,res),[]);
 assert.deepEqual(added(PREV.reserve,res),["  AND NOT EXISTS(SELECT 1 FROM public.automation_comment_replies cr",
  "   WHERE cr.tenant_id=o.tenant_id AND cr.run_id=o.run_id AND cr.reply_status<>'sent')"]);
 assert.ok(res.includes("o.effect_kind IN('message','question','message_image')"),"reply_comment is never reserved here");
 const swp=body(MIG,"skip_many");
 assert.ok(swp.includes("o.effect_kind IN('message','question','message_image','reply_comment')"));
 assert.ok(removed(PREV.skip_many,swp).every(l=>/effect_kind IN|SELECT q\.tenant_id|SELECT o\.tenant_id/.test(l)));
 assert.match(src(MIG),/'effect_kind IN \(''message'',''question'',''delay'',''handoff'',''tag'',''untag'',''staff_notification'',''message_image'',''reply_comment''\)'/);
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
function psql(db,{file,sql,role,sub}={}){
 const a=pargs(db);
 if(file)a.push("-f",file);
 const pre=(sub?`SET request.jwt.claim.sub='${sub}';\n`:"")+(role?`SET ROLE ${role};\n`:"");
 const input=sql===undefined?undefined:pre+sql;
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input,env:clientEnv(),maxBuffer:1<<26});
}
function ok(db,s,label){
 const r=psql(db,s);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return {out:r.stdout.trim(),err:r.stderr};
}
function rows(db,query,role,sub){
 const r=psql(db,{sql:`SELECT '@@'||coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)::text FROM (${query}) x;`,role,sub});
 assert.equal(r.status,0,`${query}\n${r.stderr}`);
 return JSON.parse(r.stdout.split("\n").find(l=>l.startsWith("@@")).slice(2));
}
const val=(db,query,role)=>rows(db,`SELECT (${query}) AS v`,role)[0]?.v;
const sqlState=err=>(err.match(/ERROR:\s+([0-9A-Z]{5}):/)??[])[1];
const SCHEMA_FP=`SELECT (string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||
  coalesce(p.proacl::text,'')||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||pg_get_function_result(p.oid)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')||':'||c.relrowsecurity
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid)||':'||convalidated||':'||
  coalesce(obj_description(oid,'pg_constraint'),'')
  FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 'p:'||schemaname||'.'||tablename||':'||policyname FROM pg_policies
) s(x);`;
const fp=db=>ok(db,{sql:SCHEMA_FP},"fingerprint").out;

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
// Owners from tests/sql/flow-staff-membership-bootstrap.sql (auth.uid() stub, tenants.user_id).
const UA="99999999-9999-4999-8999-999999999999",UB="88888888-8888-4888-8888-888888888888";
const IGA="11111111-1111-4111-8111-111111111111";  // tenant A instagram (fixture)
const FBB="22222222-2222-4222-8222-222222222222";  // tenant B facebook (fixture)
const REPLY="شكراً، راسلناك على الخاص";
const J=o=>`'${JSON.stringify(o).replace(/'/g,"''")}'::jsonb`;
const commentDoc=(platform="instagram",reply=` ${REPLY} `)=>({version:3,name:"comments",nodes:[
 {id:"start",data:{kind:"trigger",platform,triggerMode:"comment",publicReplyText:reply,
  commentScope:"all",commentMatchType:"any",keywords:""}},
 {id:"dm",data:{kind:"message",text:"hello from dm",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"dm"}]});
const dmDoc={version:3,name:"dm",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"m",data:{kind:"message",text:"hi",image:"",options:[],contentBlocks:[]}}],edges:[{source:"start",target:"m"}]};
const LIVE=`
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN business_name text NOT NULL DEFAULT 'Test Store';
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.tenants TO authenticated;
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
 M+"20261028228000_flow_internal_actions.sql",...CHAIN125_190,M210,M220,M230];
const PUB=[[A,"cig",IGA,"instagram",commentDoc()],[A,"dig",IGA,"instagram",dmDoc],
 [B,"cfb",FBB,"facebook",commentDoc("messenger")]];
const SEED=`
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by) VALUES
${PUB.map(([t,k,a,p,d])=>` ('${t}','${k}',1,'${a}','${p}',${J(d)},'88888888-8888-4888-8888-888888888888')`).join(",\n")};
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active) VALUES
${PUB.map(([t,k,a,p])=>` ('${t}','${a}','${p}','${k}',1,true)`).join(",\n")};
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved)
VALUES('${A}',true,false,true),('${B}',true,false,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by) VALUES
 ('${A}','${IGA}','instagram','op'),('${B}','${FBB}','facebook','op');
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO service_role;
CREATE TABLE t.e(name text PRIMARY KEY,tenant uuid,acc uuid,conv uuid,msg uuid);
GRANT SELECT ON t.e TO service_role;
CREATE FUNCTION t.ev(p_name text,p_tenant uuid,p_acc uuid,p_comment text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; m uuid;
BEGIN
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(gen_random_uuid(),p_tenant,p_acc,'instagram:'||gen_random_uuid()) RETURNING id INTO c;
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id,body_encrypted)
 VALUES(p_tenant,c,'in','comment:'||p_comment,'enc:v1:aa:bb:cc') RETURNING id INTO m;
 INSERT INTO t.e VALUES(p_name,p_tenant,p_acc,c,m);
END $f$;
ANALYZE;`;
const SR="service_role";
const L=v=>v===null||v===undefined?"NULL":`'${String(v).replace(/'/g,"''")}'`;
function ev(db,name,tenant,acc,comment){
 ok(db,{sql:`SELECT t.ev('${name}','${tenant}','${acc}','${comment}');`},`event ${name}`);
 return {...rows(db,`SELECT * FROM t.e WHERE name='${name}'`)[0],comment};
}
const effects=(comment,{reply=REPLY,order="ok"}={})=>{
 const r={kind:"reply_comment",idempotencyKey:`c.${comment}.r`,payload:{kind:"reply_comment",commentId:comment,postId:"9001",text:reply,seq:0}};
 const m={kind:"message",idempotencyKey:`c.${comment}.m`,payload:{kind:"message",nodeId:"dm",text:"hello from dm",seq:1}};
 return order==="ok"?[r,m]:[{...m,payload:{...m.payload,seq:0}},{...r,payload:{...r.payload,seq:1}}];
};
const beginC=(db,e,{tenant=e.tenant,flow="cig",acc=e.acc,fx=effects(e.comment)}={})=>val(db,
 `public.flow_begin_comment_run(${L(tenant)},${L(acc)},${L(e.conv)},${L(e.msg)},${L(e.comment)},'9001','5550001','Sara',`+
 `'enc:v1:00:11:22',${L(flow)},1,'start','dm',1,${J(fx)})`,SR);
const outbox=(db,run,kind)=>rows(db,`SELECT id,delivery_status,cancel_reason FROM public.automation_flow_outbox WHERE run_id='${run}' AND effect_kind='${kind}'`)[0];
const reserve=(db,tenant,id)=>val(db,`public.flow_reserve_outbox_delivery('${tenant}','${id}')`,SR);
const claimR=(db,tenant,id,lease=60)=>rows(db,`SELECT * FROM public.flow_claim_comment_reply('${tenant}','${id}',${lease})`,SR)[0];
const finishR=(db,tenant,id,token,result,{reply=null,code=null,delay=0,posted=true,max=5}={})=>val(db,
 `public.flow_finish_comment_reply('${tenant}','${id}',${L(token)},${L(result)},${L(reply)},${L(code)},${delay},${posted},${max})`,SR);
const activity=(db,run)=>rows(db,`SELECT reply_status,reply_id,reply_attempts,reply_error_code,dm_status,public_reply_text
 FROM public.automation_comment_replies WHERE run_id='${run}'`)[0];

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-comment-replies-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+300)%20000);
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
 ok("postgres",{sql:"CREATE DATABASE g300 TEMPLATE base;"},"g300");
 ok("g300",{file:MIG},"300000");
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});
let clones=0;
function clone(prefix,template="g300"){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},`clone ${db}`);
 return db;
}

test("live: re-apply is a no-op; markers, privileges and attributes",{skip},()=>{
 const db=clone("reapply");
 const before=fp(db);
 ok(db,{file:MIG},"re-apply");
 const after=fp(db),bs=new Set(before.split("\n")),as=new Set(after.split("\n"));
 assert.deepEqual([[...as].filter(x=>!bs.has(x)),[...bs].filter(x=>!as.has(x))],[[],[]]);
 for(const sig of [...Object.values(SIGS),...NEW_SIGS]){
  for(const role of ["anon","authenticated","public"])
   assert.equal(val(db,`SELECT has_function_privilege('${role}','${sig}','EXECUTE')`),false,`${sig} ${role}`);
  assert.equal(val(db,`SELECT has_function_privilege('service_role','${sig}','EXECUTE')`),true,sig);
 }
 for(const [k,sig] of Object.entries(SIGS))
  assert.equal(val(db,`SELECT md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))) FROM pg_proc WHERE oid='${sig}'::regprocedure`),
   md5(norm(body(MIG,k))),`installed ${k} body`);
 assert.equal(val(db,`SELECT obj_description('public.automation_comment_replies'::regclass,'pg_class')`),MARK);
 assert.equal(val(db,`SELECT has_table_privilege('anon','public.automation_comment_replies','SELECT')`),false);
 assert.equal(val(db,`SELECT has_table_privilege('authenticated','public.automation_comment_replies','INSERT')`),false);
 assert.equal(val(db,`SELECT has_table_privilege('authenticated','public.automation_comment_replies','UPDATE')`),false);
});

test("live: ordering gate — the DM is never reservable before the public reply is sent",{skip},()=>{
 const db=clone("order");
 const e=ev(db,"c1",A,IGA,"1801");
 const run=beginC(db,e);
 assert.equal(typeof run,"string");
 const r=outbox(db,run,"reply_comment"),m=outbox(db,run,"message");
 assert.equal(r.delivery_status,"pending");assert.equal(m.delivery_status,"pending");
 assert.deepEqual(activity(db,run),{reply_status:"pending",reply_id:null,reply_attempts:0,reply_error_code:null,
  dm_status:"pending",public_reply_text:REPLY});
 assert.equal(reserve(db,A,m.id),false,"DM held while the reply is pending");
 assert.equal(reserve(db,A,r.id),false,"reply_comment is never reserved by the DM reserve");
 const c=claimR(db,A,r.id);
 assert.equal(c.outcome,"claimed");assert.equal(c.prior_status,"pending");assert.equal(c.comment_id,"1801");
 assert.equal(c.reply_text,REPLY);
 assert.equal(claimR(db,A,r.id).outcome,"not_claimable","leased: no second claim");
 assert.equal(reserve(db,A,m.id),false,"DM held while the reply is in flight");
 // Direct data write cannot mark the DM before a sent reply (CHECK order_chk).
 const bad=psql(db,{sql:`UPDATE public.automation_comment_replies SET dm_status='sent' WHERE run_id='${run}';`});
 assert.equal(sqlState(bad.stderr),"23514");
 assert.equal(finishR(db,A,r.id,"00000000-0000-4000-8000-000000000000","sent",{reply:"1809"}),null,"wrong token");
 assert.equal(finishR(db,A,r.id,c.claim_token,"sent",{reply:"1809"}),"sent");
 assert.equal(finishR(db,A,r.id,c.claim_token,"sent",{reply:"1809"}),null,"finish is single-shot");
 assert.equal(outbox(db,run,"reply_comment").delivery_status,"settled");
 assert.equal(activity(db,run).reply_status,"sent");assert.equal(activity(db,run).reply_id,"1809");
 assert.equal(claimR(db,A,r.id).outcome,"not_claimable","a sent reply is never claimed again");
 assert.equal(reserve(db,A,m.id),true,"DM reservable only now");
 assert.equal(reserve(db,A,m.id),false,"and only once");
});

test("live: failed public reply stops the DM (dead_letter + DM cancelled + dm 'skipped')",{skip},()=>{
 const db=clone("fail");
 const e=ev(db,"c2",A,IGA,"1802");
 const run=beginC(db,e);
 const r=outbox(db,run,"reply_comment"),m=outbox(db,run,"message");
 const c=claimR(db,A,r.id);
 assert.equal(finishR(db,A,r.id,c.claim_token,"failed",{code:"meta_100"}),"failed");
 assert.equal(outbox(db,run,"reply_comment").delivery_status,"dead_letter");
 assert.deepEqual(outbox(db,run,"message"),{id:m.id,delivery_status:"cancelled",cancel_reason:"ineligible"});
 assert.deepEqual(activity(db,run),{reply_status:"failed",reply_id:null,reply_attempts:1,reply_error_code:"meta_100",
  dm_status:"skipped",public_reply_text:REPLY});
 assert.equal(reserve(db,A,m.id),false);
 assert.equal(claimR(db,A,r.id).outcome,"not_claimable");
});

test("live: retries are bounded; uncertain / crashed attempts come back as 'uncertain' (reconcile, never blind re-post)",{skip},()=>{
 const db=clone("retry");
 const e=ev(db,"c3",A,IGA,"1803");
 const run=beginC(db,e);
 const r=outbox(db,run,"reply_comment"),m=outbox(db,run,"message");
 // Throttled: retry_wait with backoff; not claimable before retry_at.
 let c=claimR(db,A,r.id);
 assert.equal(finishR(db,A,r.id,c.claim_token,"retry",{code:"meta_4",delay:600}),"retry");
 assert.equal(outbox(db,run,"reply_comment").delivery_status,"retry_wait");
 assert.equal(claimR(db,A,r.id).outcome,"not_claimable","before retry_at");
 ok(db,{sql:`UPDATE public.automation_flow_outbox SET retry_at=now()-interval '1 second' WHERE id='${r.id}';`},"due");
 c=claimR(db,A,r.id);
 assert.equal(c.prior_status,"pending");assert.equal(c.attempts,1);
 // Unknown outcome (timeout): uncertain -> next claim reports uncertain.
 assert.equal(finishR(db,A,r.id,c.claim_token,"uncertain",{code:"reply_uncertain"}),"uncertain");
 c=claimR(db,A,r.id);
 assert.equal(c.prior_status,"uncertain");assert.equal(c.attempts,2);
 // Worker crash while leased: lease expires -> reported as uncertain.
 ok(db,{sql:`UPDATE public.automation_flow_outbox SET lease_expires_at=now()-interval '1 second' WHERE id='${r.id}';`},"expire");
 const c2=claimR(db,A,r.id);
 assert.equal(c2.outcome,"claimed");assert.equal(c2.prior_status,"uncertain");
 assert.equal(finishR(db,A,r.id,c.claim_token,"sent",{reply:"x"}),null,"stale token after re-lease");
 // Reconcile found our reply: sent without counting a post.
 assert.equal(finishR(db,A,r.id,c2.claim_token,"sent",{reply:"1810",posted:false}),"sent");
 assert.equal(activity(db,run).reply_attempts,2);
 assert.equal(reserve(db,A,m.id),true);
 // Attempt bound: retry at the max fails for good and skips the DM.
 const e2=ev(db,"c4",A,IGA,"1804");
 const run2=beginC(db,e2);
 const r2=outbox(db,run2,"reply_comment");
 for(let i=1;i<=3;i++){
  const k=claimR(db,A,r2.id);
  assert.equal(finishR(db,A,r2.id,k.claim_token,"retry",{code:"meta_4",max:3}),i<3?"retry":"failed",`attempt ${i}`);
 }
 assert.deepEqual([activity(db,run2).reply_status,activity(db,run2).dm_status,activity(db,run2).reply_error_code],
  ["failed","skipped","reply_attempts_exhausted"]);
});

test("live: durable dedupe by comment id; refusals (reply text, order, tenant, platform, trigger mode)",{skip},()=>{
 const db=clone("dedupe");
 const e=ev(db,"c5",A,IGA,"1805");
 assert.equal(typeof beginC(db,e),"string");
 // Redelivery of the same comment: nothing new (no second row, claim, receipt or run).
 assert.equal(beginC(db,e),null);
 assert.equal(val(db,`SELECT count(*) FROM public.automation_comment_replies WHERE comment_id='1805'`),1);
 assert.equal(val(db,`SELECT count(*) FROM public.automation_flow_runs WHERE provider_event_id='comment:1805'`),1);
 const fresh=n=>ev(db,"r"+n,A,IGA,String(1900+n));
 let x=fresh(1);
 assert.equal(beginC(db,x,{fx:effects(x.comment,{reply:"another text"})}),null,"reply text must equal the published one");
 x=fresh(2);
 assert.equal(beginC(db,x,{fx:effects(x.comment,{order:"dm-first"})}),null,"DM before reply refused");
 x=fresh(3);
 assert.equal(beginC(db,x,{fx:[effects(x.comment)[0]]}),null,"reply without DM refused");
 x=fresh(4);
 assert.equal(beginC(db,x,{tenant:B}),null,"cross tenant");
 x=fresh(5);
 assert.equal(beginC(db,x,{flow:"dig"}),null,"a message-trigger flow never starts from a comment");
 x=fresh(6);
 assert.equal(beginC(db,x,{acc:FBB}),null,"another tenant's account");
 // Non-registered account / switches off.
 x=fresh(7);
 ok(db,{sql:`UPDATE public.automation_flow_tenant_switches SET production_approved=false WHERE tenant_id='${A}';`},"off");
 assert.equal(beginC(db,x),null,"tenant not approved");
 assert.equal(val(db,`SELECT count(*) FROM public.automation_comment_replies`),1,"refusals write nothing");
});

test("live: tenant RLS — owners read only their own activity; anon nothing; service_role all",{skip},()=>{
 const db=clone("rls");
 ok(db,{sql:`UPDATE public.channel_accounts SET external_id='17841' WHERE id='${FBB}';`},"fb");
 assert.equal(typeof beginC(db,ev(db,"a1",A,IGA,"2001")),"string");
 const fb=ev(db,"b1",B,FBB,"3001_1");
 ok(db,{sql:`UPDATE public.conversations SET wa_chat_id='facebook:'||id WHERE id='${fb.conv}';`},"fbconv");
 assert.equal(typeof beginC(db,fb,{flow:"cfb"}),"string","facebook comment run (messenger trigger)");
 const q=`SELECT comment_id FROM public.automation_comment_replies ORDER BY 1`;
 assert.deepEqual(rows(db,q,"authenticated",UA),[{comment_id:"2001"}]);
 assert.deepEqual(rows(db,q,"authenticated",UB),[{comment_id:"3001_1"}]);
 assert.deepEqual(rows(db,q,"authenticated","c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1"),[]);
 const anon=psql(db,{sql:q+";",role:"anon"});
 assert.equal(sqlState(anon.stderr),"42501");
 const w=psql(db,{sql:`UPDATE public.automation_comment_replies SET reply_status='sent',reply_id='x';`,role:"authenticated",sub:UA});
 assert.equal(sqlState(w.stderr),"42501");
 assert.equal(rows(db,q,SR).length,2);
 // Tenant B's service calls can never claim tenant A's reply effect.
 const run=val(db,`SELECT run_id FROM public.automation_comment_replies WHERE comment_id='2001'`);
 const r=outbox(db,run,"reply_comment");
 assert.equal(claimR(db,B,r.id).outcome,"not_claimable");
});

test("live: stale sweep cancels reply_comment and mirrors it into the activity row",{skip},()=>{
 const db=clone("sweep");
 const run=beginC(db,ev(db,"s1",A,IGA,"4001"));
 ok(db,{sql:`UPDATE public.automation_flow_outbox SET created_at=now()-interval '2 hours' WHERE run_id='${run}';`},"age");
 assert.equal(val(db,`public.flow_skip_blocked_outbox(60,200)`,SR),2);
 assert.equal(outbox(db,run,"reply_comment").cancel_reason,"stale");
 assert.equal(outbox(db,run,"message").delivery_status,"cancelled");
 const a=activity(db,run);
 assert.deepEqual([a.reply_status,a.reply_error_code,a.dm_status],["failed","cancelled_stale","skipped"]);
});

test("live: non-comment runs unchanged (DM run reserves without any comment row)",{skip},()=>{
 const db=clone("dm");
 const c=ok(db,{sql:`INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
  VALUES(gen_random_uuid(),'${A}','${IGA}','instagram:dm1') RETURNING id;`},"conv").out;
 const m=ok(db,{sql:`INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
  VALUES('${A}','${c}','in','mid.dm1') RETURNING id;`},"msg").out;
 assert.deepEqual(rows(db,`SELECT acquired,route FROM public.flow_claim_inbound_durable('${A}','${IGA}','instagram','mid.dm1','${c}','${m}')`,SR),
  [{acquired:true,route:"flow"}]);
 const fx=[{kind:"message",idempotencyKey:"dm1",payload:{kind:"message",text:"hi",seq:0}}];
 const run=val(db,`public.flow_begin_durable_run('${A}','${IGA}','${c}','${m}','mid.dm1','dig',1,'start','m',1,'completed','{}'::jsonb,NULL,${J(fx)})`,SR);
 assert.equal(typeof run,"string");
 assert.equal(reserve(db,A,outbox(db,run,"message").id),true);
 // A reply_comment effect can only come from flow_begin_comment_run's validated list; the DM flow's
 // commit accepts the kind, but no comment row means no gate: kinds are not a bypass of ownership.
 assert.equal(val(db,`SELECT count(*) FROM public.automation_comment_replies`),0);
});

test("live: rollback order and data guards; clean rollback restores the 230000 schema exactly",{skip},()=>{
 const db=clone("rb");
 beginC(db,ev(db,"x1",A,IGA,"5001"));
 // Older rollbacks refuse while 300000 is installed.
 for(const f of [R+"20261029230000_flow_multichannel_support.rollback.sql",R+"20261029220000_flow_media_stale_sweep.rollback.sql",
  R+"20261029210000_flow_media_effects.rollback.sql"]){
  const before=fp(db);
  const r=psql(db,{file:f});
  assert.notEqual(r.status,0,`${f} must refuse`);
  assert.equal(fp(db),before,`${f}: unchanged`);
 }
 // Data guard.
 let r=psql(db,{file:RB});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/comment data still depends on it/);
 ok(db,{sql:`DELETE FROM public.automation_flow_outbox WHERE run_id IN(SELECT run_id FROM public.automation_comment_replies);
  DELETE FROM public.automation_comment_replies;`},"clear");
 ok(db,{file:RB},"rollback");
 const base=clone("base","base");
 assert.equal(fp(db),fp(base),"schema identical to before 300000");
 r=psql(db,{file:RB});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/not installed; nothing to roll back/);
 ok(db,{file:MIG},"re-apply after rollback");
});
