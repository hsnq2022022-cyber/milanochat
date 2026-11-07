// 20261029230000_flow_multichannel_support: the durable Flow V3/V4 chain
// (canary registration CHECK, flow_claim_inbound_durable,
// flow_begin_durable_run, flow_resume_button_run, flow_end_stale_paused_runs,
// flow_lease_due_runs, flow_commit_run_step, flow_reserve_outbox_delivery)
// accepts 'whatsapp' and 'facebook' besides 'instagram', always compared with
// the row's OWN platform; account 'facebook' <-> document trigger 'messenger'.
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) built like
// tests/flow-media-stale-sweep.test.mjs: repo fixture chain (incl. the
// 20261028227000 / 228000 bootstrap), migrations 20261028220000 ..
// 20261029220000, then 20261029230000. Never connects to any remote host;
// inherited PG* variables are stripped. Billing is out of scope.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const MIG="supabase/migrations/20261029230000_flow_multichannel_support.sql";
const RB="supabase/rollbacks/20261029230000_flow_multichannel_support.rollback.sql";
const M="supabase/migrations/",R="supabase/rollbacks/";
const M150=M+"20261029150000_flow_takeover_resume.sql",M170=M+"20261029170000_flow_canary_claim_durable.sql",
 M180=M+"20261029180000_flow_durable_button_run_guards.sql",M210=M+"20261029210000_flow_media_effects.sql",
 M220=M+"20261029220000_flow_media_stale_sweep.sql";
const CHAIN125_190=[M+"20261029125000_flow_durable_button_run.sql",M+"20261029130000_flow_run_lifecycle.sql",
 M+"20261029140000_flow_outbox_ai_retry.sql",M150,M+"20261029160000_flow_credits_pause.sql",M170,M180,
 M+"20261029190000_flow_begin_durable_run_superseding.sql"];
const OLDER_RB=["20261029220000_flow_media_stale_sweep","20261029210000_flow_media_effects",
 "20261029190000_flow_begin_durable_run_superseding","20261029180000_flow_durable_button_run_guards",
 "20261029170000_flow_canary_claim_durable","20261029160000_flow_credits_pause","20261029150000_flow_takeover_resume",
 "20261029140000_flow_outbox_ai_retry","20261029130000_flow_run_lifecycle","20261029125000_flow_durable_button_run"]
 .map(n=>R+n+".rollback.sql");
const MARK="CREATED_BY_20261029230000_FLOW_MULTICHANNEL_SUPPORT";
const SIGS={
 claim:"public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)",
 begin:"public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)",
 resume:"public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)",
 stale:"public.flow_end_stale_paused_runs(integer,integer)",
 lease:"public.flow_lease_due_runs(integer)",
 advance:"public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)",
 reserve:"public.flow_reserve_outbox_delivery(uuid,uuid)"};
const src=f=>readFileSync(f,"utf8");
const md5=x=>createHash("md5").update(x).digest("hex");
const norm=x=>x.replace(/[ \t\n\r\f\v]+/g," ").replace(/^ +| +$/g,"");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");
const between=(s,open,tag)=>{const a=s.indexOf(open);assert.ok(a>=0,open);
 return s.slice(a+open.length,s.indexOf(`$${tag}$`,a+open.length));};
const body=(f,tag)=>between(src(f),`AS $${tag}$`,tag);
// The exact previous live body of every replaced function (latest migration defining it).
const PREV={claim:body(M170,"claim"),begin:between(src(M180),"v_begin_180 constant text := $begin$","begin"),
 resume:between(src(M180),"v_resume_180 constant text := $resume$","resume"),stale:body(M150,"stale"),
 lease:body(M150,"lease"),advance:body(M210,"advance"),reserve:body(M210,"reserve")};
const P="IN('instagram','whatsapp','facebook')";

// ---------------------------------------------------------------- static
test("230000 is the newest migration and follows the 125000..220000 chain",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 assert.equal(stamps.filter(s=>s==="20261029230000").length,1);
 // 240000 / 250000: security migrations, independent of the flow chain.
 for(const s of stamps)if(!["20261029230000","20261029240000","20261029250000","20261029260000","20261029270000","20261029280000","20261029290000"].includes(s))assert.ok(s<"20261029230000",s);
 for(const f of [...CHAIN125_190,M210,M220,RB,...OLDER_RB])assert.ok(existsSync(f),f);
});
test("migration and rollback: one bounded transaction, seven same-signature replacements, no billing, no row writes",()=>{
 for(const f of [MIG,RB]){
  const s=src(f),code=noComments(s);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
  assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1,f);assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.doesNotMatch(code,/SECURITY DEFINER|\bTO\s+(anon|authenticated|PUBLIC)\b|CREATE POLICY|\bTRUNCATE\b/i,f);
  assert.doesNotMatch(code,/consume_|credits_remaining|wayl|topup|cron\.|vault\.|net\.http_|flow_finish_outbox_delivery|flow_claim_inbound\(/i,f);
  assert.ok(code.includes(`v_marker constant text := '${MARK}'`),f);
  assert.equal((code.match(/CREATE OR REPLACE FUNCTION/g)??[]).length,7,f);
  assert.doesNotMatch(code,/CREATE\s+FUNCTION|CREATE\s+TABLE|DROP\s+(TABLE|FUNCTION|COLUMN|INDEX|TRIGGER)/i,f);
  const outside=code.replace(/\$(claim|begin|resume|stale|lease|advance|reserve)\$[\s\S]*?\$\1\$/g,"");
  assert.doesNotMatch(outside,/\bINSERT\b|\bUPDATE\s+public\.|\bDELETE\s+FROM\b/i,f);
  // The only DDL: the canary platform CHECK of automation_flow_canary_accounts.
  for(const m of outside.matchAll(/ALTER TABLE ([a-z_.]+)/gi))assert.equal(m[1],"public.automation_flow_canary_accounts",f);
 }
 const code=noComments(src(MIG));
 for(const sig of Object.values(SIGS)){
  assert.ok(code.includes(`REVOKE ALL ON FUNCTION ${sig}\n FROM PUBLIC,anon,authenticated;`),sig);
  assert.ok(code.includes(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`),sig);
 }
 assert.doesNotMatch(noComments(src(RB)),/^(REVOKE|GRANT)/m,"rollback never changes privileges");
 assert.match(code,/ADD CONSTRAINT automation_flow_canary_accounts_platform_chk\n\s+CHECK\(platform IN\('instagram','whatsapp','facebook'\)\) NOT VALID;/);
 assert.match(code,/VALIDATE CONSTRAINT automation_flow_canary_accounts_platform_chk;/);
 assert.match(noComments(src(RB)),/CHECK\(platform='instagram'\) NOT VALID;/);
});
test("bodies: only the platform comparisons change; headers identical; rollback restores the exact previous bodies",()=>{
 const m=src(MIG),r=src(RB);
 const headOf=(s,tag)=>{const i=s.indexOf(`AS $${tag}$`);return s.slice(s.lastIndexOf("CREATE OR REPLACE FUNCTION public.",i),i);};
 for(const [k,prev] of Object.entries(PREV)){
  assert.equal(body(RB,k),prev,`${k}: rollback body byte-identical to the previous live body`);
  assert.equal(headOf(m,k),headOf(r,k),`${k}: same header in migration and rollback`);
  const now=body(MIG,k);
  assert.doesNotMatch(now,/='instagram'|<>'instagram'|DISTINCT FROM 'instagram'/,k);
  assert.ok(now.includes(P),`${k} uses the single allowed list`);
  const gone=prev.split("\n").filter(l=>!now.split("\n").includes(l));
  assert.ok(gone.length>=1&&gone.every(l=>/instagram|INTO v_claim|DECLARE v_run/.test(l)),`${k}: only platform lines change: ${gone}`);
  // Hashes embedded in the migration preflight and the rollback guard.
  const pair=`'${md5(norm(prev))}','${md5(norm(now))}')`;
  assert.ok(m.includes(pair)&&r.includes(pair),k);
 }
 // Instagram-equivalent predicates; messenger mapping in begin only.
 assert.ok(body(MIG,"begin").includes("n#>>'{data,platform}'=CASE v_platform WHEN 'facebook' THEN 'messenger' ELSE v_platform END"));
 assert.ok(body(MIG,"begin").includes("AND cl.platform=a.platform AND cl.route='flow'"));
 for(const k of ["stale","lease","advance","reserve"])assert.equal((body(MIG,k).match(/production_approved AND r(un)?\.platform IN\(/g)??[]).length,1,k);
 // Headers equal the previous definitions (signature, defaults, attributes).
 assert.equal(headOf(m,"claim"),headOf(src(M170),"claim"));
 assert.equal(headOf(m,"lease"),headOf(src(M150),"lease"));
 assert.equal(headOf(m,"advance"),headOf(src(M210),"advance"));
 assert.equal(headOf(m,"begin")+"AS ",between(src(M180),"v_begin_head constant text := $head$","head"));
});
test("every older rollback (220000 .. 125000) refuses first while 230000 is installed",()=>{
 const hashes=Object.keys(PREV).map(k=>`'${md5(norm(body(MIG,k)))}'`);
 for(const f of OLDER_RB){
  const s=src(f),i=s.indexOf("-- 20261029230000 (multichannel support; requires 220000) is newer: roll it back first.");
  assert.ok(i>0,f);
  const g=s.slice(i,s.indexOf("END IF;",i));
  assert.ok(g.includes(`split_part(coalesce(obj_description(c.oid,'pg_constraint'),''),' ',1)='${MARK}'`),f);
  for(const sig of Object.values(SIGS))assert.ok(g.includes(`to_regprocedure('${sig}')`),`${f} ${sig}`);
  for(const h of hashes)assert.ok(g.includes(h),`${f} ${h}`);
  assert.match(g,/THEN RAISE EXCEPTION 'Refusing [^']*: 20261029230000 objects still exist; roll back 20261029230000_flow_multichannel_support first'; $/,f);
  const g220=s.indexOf("roll back 20261029220000_flow_media_stale_sweep first");
  assert.ok(f.includes("20261029220000")?i<s.indexOf("IF to_regprocedure(v_sig) IS NULL"):i<g220,f);
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
const FP=data=>`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||
  coalesce(p.proacl::text,'')||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||pg_get_function_result(p.oid)||':'||
  p.prosecdef||':'||pg_get_function_arguments(p.oid)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')||':'||c.relrowsecurity
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'c:'||a.attrelid::regclass::text||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v') AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid)||':'||convalidated||':'||
  coalesce(obj_description(oid,'pg_constraint'),'')
  FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 't:'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text FROM pg_trigger t WHERE NOT t.tgisinternal
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
const IGA="11111111-1111-4111-8111-111111111111";  // tenant A instagram (fixture)
const FBB="22222222-2222-4222-8222-222222222222";  // tenant B facebook (fixture)
const WAA="33333333-3333-4333-8333-333333333333";  // tenant A whatsapp (fixture)
const FBA="dddddddd-dddd-4ddd-8ddd-dddddddddddd";  // tenant A facebook
const WAB="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";  // tenant B whatsapp (never registered)
const docFor=trigger=>({version:3,name:"two choices",nodes:[
 {id:"start",data:{kind:"trigger",platform:trigger,triggerMode:"message"}},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"choose",image:"",contentBlocks:[],options:[
  {id:"prices",label:"prices"},{id:"support",label:"support"}]}},
 {id:"yes",data:{kind:"message",text:"prices text",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"support text",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},{source:"choose",target:"yes",sourceHandle:"prices"},
  {source:"choose",target:"no",sourceHandle:"support"}]});
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
 M+"20261028228000_flow_internal_actions.sql"];
const PUB=[[A,"ig",IGA,"instagram","instagram"],[A,"wa",WAA,"whatsapp","whatsapp"],[A,"fb",FBA,"facebook","messenger"],
 [A,"fbraw",FBA,"facebook","facebook"],[B,"bfb",FBB,"facebook","messenger"],[B,"bwa",WAB,"whatsapp","whatsapp"]];
const SEED=`
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES
 ('${FBA}','${A}','facebook','facebook'),('${WAB}','${B}','whatsapp','whatsapp');
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by) VALUES
${PUB.map(([t,k,a,p,trig])=>` ('${t}','${k}',1,'${a}','${p}',${J(docFor(trig))},'88888888-8888-4888-8888-888888888888')`).join(",\n")};
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active) VALUES
${PUB.map(([t,k,a,p])=>` ('${t}','${a}','${p}','${k}',1,true)`).join(",\n")};
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved)
VALUES('${A}',true,false,true),('${B}',true,false,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO service_role;
CREATE TABLE t.e(name text PRIMARY KEY,tenant uuid,acc uuid,conv uuid,msg uuid,mid text);
GRANT SELECT ON t.e TO service_role;
-- One inbound event: a conversation bound to the account (or an existing one) + the persisted message.
CREATE FUNCTION t.ev(p_name text,p_tenant uuid,p_acc uuid,p_conv uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid:=p_conv; m uuid;
BEGIN
 IF c IS NULL THEN
  INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
  VALUES(gen_random_uuid(),p_tenant,p_acc,'x:'||gen_random_uuid()) RETURNING id INTO c;
 END IF;
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
 VALUES(p_tenant,c,'in','mid.'||p_name) RETURNING id INTO m;
 INSERT INTO t.e VALUES(p_name,p_tenant,p_acc,c,m,'mid.'||p_name);
END $f$;
ANALYZE;`;
// Operator registration (table owner only).
const REG=`INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by) VALUES
 ('${A}','${IGA}','instagram','op'),('${A}','${WAA}','whatsapp','op'),('${A}','${FBA}','facebook','op'),('${B}','${FBB}','facebook','op');`;
const SR="service_role";
const L=v=>v===null||v===undefined?"NULL":`'${String(v).replace(/'/g,"''")}'`;
function ev(db,name,tenant,acc,conv=null){
 ok(db,{sql:`SELECT t.ev('${name}','${tenant}','${acc}',${L(conv)});`},`event ${name}`);
 return rows(db,`SELECT * FROM t.e WHERE name='${name}'`)[0];
}
const claim=(db,e,{tenant=e.tenant,acc=e.acc,platform})=>rows(db,
 `SELECT acquired,route FROM public.flow_claim_inbound_durable(${L(tenant)},${L(acc)},${L(platform)},${L(e.mid)},${L(e.conv)},${L(e.msg)})`,SR);
const Q=n=>JSON.stringify([{kind:"question",idempotencyKey:`q.${n}`,payload:{kind:"question",text:"choose",seq:0}}]);
const MSG=n=>JSON.stringify([{kind:"message",idempotencyKey:`m.${n}`,payload:{kind:"message",text:"prices text",seq:0}}]);
const begin=(db,e,flow,{tenant=e.tenant,status="awaiting_input",wake=null}={})=>val(db,
 `public.flow_begin_durable_run(${L(tenant)},${L(e.acc)},${L(e.conv)},${L(e.msg)},${L(e.mid)},${L(flow)},1,'start','choose',1,`+
 `${L(status)},'{}'::jsonb,${wake===null?"NULL":wake},${L(Q(e.name))}::jsonb)`,SR);
const resume=(db,e,run,{tenant=e.tenant}={})=>val(db,
 `public.flow_resume_button_run(${L(tenant)},${L(run)},${L(e.mid)},${L(e.msg)},1,'choose','yes',2,'completed','{}'::jsonb,NULL,${L(MSG(e.name))}::jsonb)`,SR);
const outboxOf=(db,run,kind)=>val(db,`SELECT id FROM public.automation_flow_outbox WHERE run_id='${run}' AND effect_kind='${kind}'`);
const reserve=(db,tenant,id)=>val(db,`public.flow_reserve_outbox_delivery('${tenant}','${id}')`,SR);
// Full scenario for one account: claim -> begin -> tap claim -> resume -> reserve both effects.
function scenario(db,tag,tenant,acc,platform,flow){
 const s=ev(db,`${tag}.s`,tenant,acc);
 const out={claim:claim(db,s,{platform})};
 out.run=begin(db,s,flow);
 if(out.run){
  const tap=ev(db,`${tag}.t`,tenant,acc,s.conv);
  out.tapClaim=claim(db,tap,{platform});
  out.resume=resume(db,tap,out.run);
  out.reserveQ=reserve(db,tenant,outboxOf(db,out.run,"question"));
  out.reserveM=reserve(db,tenant,outboxOf(db,out.run,"message"));
  out.row=rows(db,`SELECT platform,run_status,current_node_id,step_count FROM public.automation_flow_runs WHERE id='${out.run}'`)[0];
  out.receipts=rows(db,`SELECT platform,provider_event_id FROM public.automation_flow_event_receipts
   WHERE tenant_id='${tenant}' AND channel_account_id='${acc}' ORDER BY provider_event_id`);
  out.run=typeof out.run;
 }
 return out;
}

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-multichannel-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+230)%20000);
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
 ok("postgres",{sql:"CREATE DATABASE c210 TEMPLATE base;"},"c210");
 for(const f of [...CHAIN125_190,M210])ok("c210",{file:f},f);
 ok("postgres",{sql:"CREATE DATABASE c220 TEMPLATE c210;"},"c220");
 ok("c220",{file:M220},"220000");
 ok("postgres",{sql:"CREATE DATABASE g230 TEMPLATE c220;"},"g230");
 ok("g230",{file:MIG},"230000");
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});
let clones=0;
function clone(prefix,template="g230"){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},`clone ${db}`);
 return db;
}

test("live: installed bodies hash as embedded; markers, privileges and attributes unchanged",{skip},()=>{
 const meta=db=>rows(db,`SELECT p.oid::regprocedure::text AS sig,p.prosecdef,p.proconfig,p.proacl::text AS acl,p.provolatile,
  pg_get_function_arguments(p.oid) AS args,pg_get_function_result(p.oid) AS res,obj_description(p.oid,'pg_proc') AS marker
  FROM pg_proc p WHERE p.oid IN(${Object.values(SIGS).map(s=>`'${s}'::regprocedure`).join(",")}) ORDER BY 1`);
 assert.deepEqual(meta("g230"),meta("c220"),"only the bodies differ");
 for(const [k,sig] of Object.entries(SIGS)){
  const h=db=>val(db,`SELECT md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))) FROM pg_proc WHERE oid='${sig}'::regprocedure`);
  assert.equal(h("c220"),md5(norm(PREV[k])),k);assert.equal(h("g230"),md5(norm(body(MIG,k))),k);
  for(const role of ["anon","authenticated","public"])
   assert.equal(val("g230",`SELECT has_function_privilege('${role}','${sig}','EXECUTE')`),false,`${k} ${role}`);
  assert.equal(val("g230",`SELECT has_function_privilege('service_role','${sig}','EXECUTE')`),true,k);
 }
 const con=db=>rows(db,`SELECT pg_get_constraintdef(oid) AS def,convalidated AS v,obj_description(oid,'pg_constraint') AS c
  FROM pg_constraint WHERE conname='automation_flow_canary_accounts_platform_chk'`)[0];
 assert.deepEqual(con("c220"),{def:"CHECK ((platform = 'instagram'::text))",v:true,c:null});
 assert.deepEqual(con("g230"),{def:"CHECK ((platform = ANY (ARRAY['instagram'::text, 'whatsapp'::text, 'facebook'::text])))",
  v:true,c:`${MARK} previous_comment=null`});
});
test("live: CHECK accepts exactly instagram, whatsapp and facebook; the composite FK still binds tenant/account/platform",{skip},()=>{
 const db=clone("chk");
 ok(db,{sql:REG},"register the three platforms");
 for(const [p,acc,t] of [["telegram",WAB,B],["messenger",WAB,B],["Instagram",WAB,B],["",WAB,B]]){
  const r=psql(db,{sql:`INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by) VALUES('${t}','${acc}','${p}','op');`});
  assert.equal(sqlState(r.stderr),"23514",p);
 }
 // whatsapp is allowed by the CHECK but the account must belong to that tenant on that platform.
 for(const [t,acc,p] of [[B,FBA,"whatsapp"],[B,WAB,"instagram"]]){
  const r=psql(db,{sql:`INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by) VALUES('${t}','${acc}','${p}','op');`});
  assert.equal(sqlState(r.stderr),"23503",`${t} ${p}`);
 }
 // One canary per tenant and platform (unchanged primary key).
 const dup=psql(db,{sql:`INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by) VALUES('${A}','${WAA}','whatsapp','op');`});
 assert.equal(sqlState(dup.stderr),"23505");
 // service_role still cannot register a canary.
 const sr=psql(db,{role:SR,sql:`INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by) VALUES('${B}','${WAB}','whatsapp','op');`});
 assert.equal(sqlState(sr.stderr),"42501");
 // Before 230000 only instagram could be registered.
 const old=clone("chkold","c220");
 const r=psql(old,{sql:`INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by) VALUES('${A}','${WAA}','whatsapp','op');`});
 assert.equal(sqlState(r.stderr),"23514");
});
test("live: Instagram behaviour unchanged (same scenario on 220000 and 230000 gives identical results)",{skip},()=>{
 const a=clone("igold","c220"),b=clone("ignew");
 for(const db of [a,b])ok(db,{sql:`INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by) VALUES('${A}','${IGA}','instagram','op');`},"register ig");
 const ra=scenario(a,"ig",A,IGA,"instagram","ig"),rb=scenario(b,"ig",A,IGA,"instagram","ig");
 assert.deepEqual(rb,ra);
 assert.deepEqual(ra.claim,[{acquired:true,route:"flow"}]);
 assert.equal(ra.resume,true);assert.equal(ra.reserveQ,true);assert.equal(ra.reserveM,true);
 assert.deepEqual(ra.row,{platform:"instagram",run_status:"completed",current_node_id:"yes",step_count:2});
 // Refusals identical too: wrong platform, cross tenant, duplicate delivery.
 for(const db of [a,b]){
  const e=ev(db,"ig.x",A,IGA);
  assert.deepEqual(claim(db,e,{platform:"whatsapp"}),[]);
  assert.deepEqual(claim(db,e,{platform:"instagram",tenant:B}),[]);
  assert.deepEqual(claim(db,e,{platform:"instagram"}),[{acquired:true,route:"flow"}]);
  assert.deepEqual(claim(db,e,{platform:"instagram"}),[{acquired:false,route:"flow"}],"duplicate delivery");
 }
});
test("live: whatsapp and facebook claim / begin / resume / reserve work for registered canary accounts (messenger trigger)",{skip},()=>{
 const db=clone("mc");
 ok(db,{sql:REG},"register");
 for(const [tag,tenant,acc,platform,flow] of [["wa",A,WAA,"whatsapp","wa"],["fb",A,FBA,"facebook","fb"],["bfb",B,FBB,"facebook","bfb"]]){
  const r=scenario(db,tag,tenant,acc,platform,flow);
  assert.deepEqual(r.claim,[{acquired:true,route:"flow"}],tag);
  assert.equal(r.run,"string",tag);
  assert.deepEqual(r.tapClaim,[{acquired:true,route:"flow"}],tag);
  assert.equal(r.resume,true,tag);assert.equal(r.reserveQ,true,tag);assert.equal(r.reserveM,true,tag);
  assert.deepEqual(r.row,{platform,run_status:"completed",current_node_id:"yes",step_count:2},tag);
  assert.deepEqual(r.receipts.map(x=>x.platform),[platform,platform],tag);
  // Duplicate delivery of the start event: never a second claim or run.
  const s=rows(db,`SELECT * FROM t.e WHERE name='${tag}.s'`)[0];
  assert.deepEqual(claim(db,s,{platform}),[{acquired:false,route:"flow"}],tag);
  assert.equal(begin(db,s,flow),null,`${tag}: replayed begin`);
 }
 assert.equal(val(db,`SELECT count(*) FROM public.automation_flow_canary_claims WHERE platform IN('whatsapp','facebook')`),6);
 // Account 'facebook' requires the document trigger 'messenger': a 'facebook' trigger never starts.
 const raw=ev(db,"fbraw.s",A,FBA);
 assert.deepEqual(claim(db,raw,{platform:"facebook"}),[{acquired:true,route:"flow"}]);
 assert.equal(begin(db,raw,"fbraw"),null);
 // A whatsapp claim never starts an instagram flow, and vice versa (activation platform = claim platform).
 const cross=ev(db,"cross.s",A,WAA);
 assert.deepEqual(claim(db,cross,{platform:"whatsapp"}),[{acquired:true,route:"flow"}]);
 assert.equal(begin(db,cross,"ig"),null);
 assert.equal(val(db,`SELECT count(*) FROM public.automation_flow_runs WHERE provider_event_id IN('mid.fbraw.s','mid.cross.s')`),0);
});
test("live: unregistered account, wrong platform, cross-tenant and unknown platform are refused without writes",{skip},()=>{
 const db=clone("neg");
 ok(db,{sql:REG},"register");
 const before=()=>rows(db,`SELECT (SELECT count(*) FROM public.automation_message_claims) AS c,
  (SELECT count(*) FROM public.automation_flow_runs) AS r,(SELECT count(*) FROM public.automation_flow_event_receipts) AS rc`)[0];
 const n0=before();
 const wab=ev(db,"wab.s",B,WAB);
 assert.deepEqual(claim(db,wab,{platform:"whatsapp"}),[],"unregistered whatsapp account");
 const wa=ev(db,"wa.neg",A,WAA);
 for(const platform of ["facebook","instagram","telegram","messenger","WhatsApp","",null])
  assert.deepEqual(claim(db,wa,{platform}),[],`platform ${platform}`);
 assert.deepEqual(claim(db,wa,{platform:"whatsapp",tenant:B}),[],"cross-tenant claim");
 assert.deepEqual(claim(db,wa,{platform:"whatsapp",acc:FBA}),[],"other account of the tenant");
 assert.deepEqual(before(),{...n0},"no claim written");
 // A valid whatsapp claim cannot be begun or resumed for another tenant.
 assert.deepEqual(claim(db,wa,{platform:"whatsapp"}),[{acquired:true,route:"flow"}]);
 assert.equal(begin(db,wa,"wa",{tenant:B}),null);
 const run=begin(db,wa,"wa");
 assert.equal(typeof run,"string");
 const tap=ev(db,"wa.negtap",A,WAA,wa.conv);
 assert.deepEqual(claim(db,tap,{platform:"whatsapp"}),[{acquired:true,route:"flow"}]);
 assert.equal(resume(db,tap,run,{tenant:B}),false,"cross-tenant resume");
 assert.equal(resume(db,tap,run),true);
 // Not production approved: the whatsapp canary is not eligible (test_only=false).
 ok(db,{sql:`UPDATE public.automation_flow_tenant_switches SET production_approved=false WHERE tenant_id='${A}'`},"unapprove");
 const off=ev(db,"wa.off",A,WAA);
 assert.deepEqual(claim(db,off,{platform:"whatsapp"}),[]);
});
test("live: lease, stale sweep, commit and reserve admit production whatsapp/facebook runs like instagram",{skip},()=>{
 const db=clone("lease");
 ok(db,{sql:REG},"register");
 const e=ev(db,"wa.sleep",A,WAA);
 assert.deepEqual(claim(db,e,{platform:"whatsapp"}),[{acquired:true,route:"flow"}]);
 const run=val(db,`public.flow_begin_durable_run(${L(A)},${L(WAA)},${L(e.conv)},${L(e.msg)},${L(e.mid)},'wa',1,'start','choose',1,`+
  `'sleeping','{}'::jsonb,now()-interval '1 minute',${L(Q("sleep"))}::jsonb)`,SR);
 assert.equal(typeof run,"string");
 const leased=rows(db,"SELECT * FROM public.flow_lease_due_runs(10)",SR);
 assert.deepEqual(leased.map(r=>r.run_id),[run]);
 // Lease-guarded commit of the sleeping whatsapp run (production approved).
 const token=leased[0].lease_token;
 assert.equal(val(db,`public.flow_commit_run_step(${L(A)},${L(run)},1,'sleeping','yes',2,'completed','{}'::jsonb,NULL,'[]'::jsonb,'transition',${L(token)})`,SR),true);
 // Stale sweep: a paused-by-switch whatsapp run is ended only when its tenant is not approved.
 const e2=ev(db,"wa.stale",A,WAA,e.conv);
 assert.deepEqual(claim(db,e2,{platform:"whatsapp"}),[{acquired:true,route:"flow"}]);
 const run2=val(db,`public.flow_begin_durable_run(${L(A)},${L(WAA)},${L(e2.conv)},${L(e2.msg)},${L(e2.mid)},'wa',1,'start','choose',1,`+
  `'sleeping','{}'::jsonb,now()+interval '1 hour',${L(Q("stale"))}::jsonb)`,SR);
 ok(db,{sql:`UPDATE public.automation_flow_runs SET wake_at=now()-interval '3 days' WHERE id='${run2}'`},"age");
 assert.equal(val(db,"public.flow_end_stale_paused_runs(60,100)",SR),0,"approved: not paused, not ended");
 ok(db,{sql:`UPDATE public.automation_flow_tenant_switches SET production_approved=false WHERE tenant_id='${A}'`},"unapprove");
 const q=outboxOf(db,run2,"question");
 assert.equal(reserve(db,A,q),false,"not approved: never reserved");
 assert.equal(val(db,"public.flow_end_stale_paused_runs(60,100)",SR),1,"not approved: stale run ended");
 assert.deepEqual(rows(db,"SELECT * FROM public.flow_lease_due_runs(10)",SR),[],"not approved: never leased");
 assert.equal(val(db,`SELECT ended_reason FROM public.automation_flow_runs WHERE id='${run2}'`),"stale");
});
test("live: migration is idempotent; preflight refuses unexpected definitions and missing prerequisites",{skip},()=>{
 const db=clone("idem");
 const once=fp(db);
 const r=ok(db,{file:MIG},"re-apply");
 assert.match(r.err,/already has the 20261029230000 definition; left unchanged/);
 assert.equal(fp(db),once,"re-apply changes nothing");
 refused(clone("no220","c210"),MIG,/apply 20261029220000_flow_media_stale_sweep first/,"220000 missing");
 refused(clone("nochain","base"),MIG,/apply 20261029170000_flow_canary_claim_durable first/,"chain missing");
 const CLAIM_HEAD=src(MIG).slice(src(MIG).indexOf("CREATE OR REPLACE FUNCTION public.flow_claim_inbound_durable("),src(MIG).indexOf("AS $claim$")+3);
 for(const [label,sql,re,template] of [
  ["claim body tampered",`${CLAIM_HEAD}$x$BEGIN RETURN; END$x$;`,/flow_claim_inbound_durable\(uuid,uuid,text,text,uuid,uuid\) differs from both the 20261029170000 and the 20261029230000 definition; refusing to overwrite/,"c220"],
  ["claim body tampered after 230000",`${CLAIM_HEAD}$x$BEGIN RETURN; END$x$;`,/refusing to overwrite/,"g230"],
  ["lease made security definer",`ALTER FUNCTION ${SIGS.lease} SECURITY DEFINER;`,/flow_lease_due_runs\(integer\) differs from both/,"c220"],
  ["reserve search_path changed",`ALTER FUNCTION ${SIGS.reserve} SET search_path=public;`,/refusing to overwrite/,"c220"],
  ["stale marker removed",`COMMENT ON FUNCTION ${SIGS.stale} IS NULL;`,/Missing or unrecognized public\.flow_end_stale_paused_runs\(integer,integer\); apply 20261029150000_flow_takeover_resume first/,"c220"],
  ["foreign overload","CREATE FUNCTION public.flow_resume_button_run(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';",
   /Unrecognized overload of public\.flow_resume_button_run exists/,"c220"],
  ["CHECK replaced",`ALTER TABLE public.automation_flow_canary_accounts DROP CONSTRAINT automation_flow_canary_accounts_platform_chk,
    ADD CONSTRAINT automation_flow_canary_accounts_platform_chk CHECK(platform IN('instagram','whatsapp'));`,
   /Unrecognized CHECK on public\.automation_flow_canary_accounts\.platform/,"c220"],
  ["CHECK widened without the marker",`COMMENT ON CONSTRAINT automation_flow_canary_accounts_platform_chk ON public.automation_flow_canary_accounts IS NULL;`,
   /has the 20261029230000 definition without its marker; refusing/,"g230"],
  ["second platform CHECK",`ALTER TABLE public.automation_flow_canary_accounts ADD CONSTRAINT extra_platform_chk CHECK(platform<>'x');`,
   /Unrecognized CHECK on public\.automation_flow_canary_accounts\.platform \(count=2/,"c220"]]){
  const d=clone("pf",template);
  ok(d,{sql},label);
  refused(d,MIG,re,label);
 }
});
test("live: rollback refused out of order and with non-Instagram data; restores the exact 220000 state",{skip},()=>{
 const db=clone("rb");
 for(const f of OLDER_RB)refused(db,f,/roll back 20261029230000_flow_multichannel_support first/,f,
  {PGOPTIONS:"-c flow.rollback_170000=discard-canary-data -c flow.rollback_210000=keep-media-checks"});
 ok(db,{file:RB},"230000 rollback");
 assert.equal(fp(db),fp("c220"),"schema, comments, privileges and data identical to the 220000 state");
 refused(db,RB,/20261029230000_flow_multichannel_support not installed; nothing to roll back/,"rollback twice");
 ok(db,{file:MIG},"re-apply");assert.equal(fp(db),fp("g230"));
 ok(db,{file:RB},"rollback again");
 ok(db,{file:OLDER_RB[0]},"220000 rollback now allowed");

 // Data guard: registrations, active runs and open effects of WhatsApp/Facebook.
 const d=clone("rbdata");
 ok(d,{sql:REG},"register");
 refused(d,RB,/non-Instagram durable data still depends on it \(3 WhatsApp\/Facebook canary registration\(s\), 0 active run\(s\), 0 open outbox effect\(s\)\)/,"registrations");
 const e=ev(d,"wa.rb",A,WAA);
 assert.deepEqual(claim(d,e,{platform:"whatsapp"}),[{acquired:true,route:"flow"}]);
 const run=begin(d,e,"wa");
 ok(d,{sql:`DELETE FROM public.automation_flow_canary_accounts WHERE platform<>'instagram';`},"deregister");
 refused(d,RB,/\(0 WhatsApp\/Facebook canary registration\(s\), 1 active run\(s\), 1 open outbox effect\(s\)\)/,"active run");
 assert.equal(val(d,`public.flow_cancel_run('${A}','${run}','manual','awaiting_input')`,SR),true);
 const data=fp(d);
 ok(d,{file:RB},"rollback once nothing depends on it");
 assert.equal(val(d,`SELECT platform||'/'||run_status FROM public.automation_flow_runs WHERE id='${run}'`),"whatsapp/blocked","ended run kept");
 assert.notEqual(fp(d),data);
 assert.equal(val(d,`SELECT md5(prosrc) FROM pg_proc WHERE oid='${SIGS.claim}'::regprocedure`),md5(PREV.claim),"170000 body restored");
 // Ownership: a foreign body or an unmarked CHECK is refused, never replaced.
 const t=clone("rbt");
 ok(t,{sql:`CREATE OR REPLACE FUNCTION public.flow_reserve_outbox_delivery(p_tenant uuid,p_outbox uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $x$BEGIN RETURN false; END$x$;`},"tamper");
 refused(t,RB,/flow_reserve_outbox_delivery\(uuid,uuid\) has neither the 20261029230000 nor the previous body/,"tampered body");
 const u=clone("rbu");
 ok(u,{sql:`COMMENT ON CONSTRAINT automation_flow_canary_accounts_platform_chk ON public.automation_flow_canary_accounts IS 'operator';`},"unmark");
 refused(u,RB,/partial state/,"unmarked CHECK");
});
