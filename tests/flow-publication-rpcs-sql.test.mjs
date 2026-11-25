/**
 * 20261115170000_flow_publication_rpcs on a THROWAWAY local PostgreSQL cluster (temporary data dir, unix
 * socket only, removed afterwards). No network, no remote database. The four functions are the ones
 * production runs (verified read only on 2026-11-25); the hashes below are the production values.
 *
 * Static: pinned hashes, the production approval gate text, caller/signature agreement with
 * supabase/functions/flow-publication/index.ts. Live: real SQL behaviour of every function, grants and
 * security attributes, apply / apply twice / rollback exactness / re-apply, adoption of a
 * production-identical state, drift refusal.
 */
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,existsSync,mkdtempSync,rmSync,chownSync,readdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const MIG="supabase/migrations/20261115170000_flow_publication_rpcs.sql";
const RB="supabase/rollbacks/20261115170000_flow_publication_rpcs.rollback.sql";
const OWN="CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS";
const HIST="CREATED_BY_20261028200000_FLOW_PUBLICATION_RATE_LIMIT";
const md5=x=>createHash("md5").update(x).digest("hex");
const norm=x=>x.replace(/\s+/g," ").trim();
const body=(f,tag)=>{const s=readFileSync(f,"utf8");const o=`AS $${tag}$`;const a=s.indexOf(o)+o.length;return s.slice(a,s.indexOf(`$${tag}$`,a));};
// Verified against the production catalog, read only, 2026-11-25: [raw md5 of prosrc, normalised md5]
const LIVE={
 publish:["32fad2b386e36e44e635989c9fa07bd5","0af572406d18d48d737d89fe4aa6b4db"],
 activate:["365673115a22b53c61535152c37c78f8","3b11ae1b179956791b1d13a663b03b03"],
 deactivate:["4cf99a57ab6b17e336d53fafdb5f9778","c24977b58a9873b3946c25d186fad9d4"],
 limit:["c6b8a1fedb0933f87435af8b11c99a71","539eecaaa05b083eda3b402e5b8b2193"]};
const SIGS={
 publish:"flow_publish_revision(uuid,uuid,text,text,uuid,jsonb)",
 activate:"flow_activate_revision(uuid,uuid,text,text,bigint,uuid)",
 deactivate:"flow_deactivate_revision(uuid,uuid,text,text,uuid)",
 limit:"flow_publication_rate_allow(uuid)"};

// ------------------------------------------------------------------------------- static
test("the migration bodies are byte-identical to the verified production definitions",()=>{
 for(const [tag,[raw,n]] of Object.entries(LIVE)){
  const b=body(MIG,tag);
  assert.equal(md5(b),raw,`${tag}: raw md5 equals production`);
  assert.equal(md5(norm(b)),n,`${tag}: normalised md5 equals production`);
  assert.ok(readFileSync(MIG,"utf8").includes(`'${n}'`)&&readFileSync(RB,"utf8").includes(`'${n}'`),`${tag}: pinned in migration and rollback`);
 }
});
test("production approval gate: (test_only OR production_approved), never a test_only-only gate",()=>{
 const a=body(MIG,"activate");
 assert.ok(a.includes("AND s.enabled AND (s.test_only OR s.production_approved) FOR SHARE"));
 assert.doesNotMatch(a,/AND s\.test_only FOR SHARE/);
 // it is exactly what supabase/proposals/automation_flow_production_approval.sql patches in
 const prop=readFileSync("supabase/proposals/automation_flow_production_approval.sql","utf8");
 assert.ok(prop.includes("new_fragment := 'AND (s.test_only OR s.production_approved) FOR SHARE'"));
 assert.ok(a.includes("AND (s.test_only OR s.production_approved) FOR SHARE"));
});
test("migration and rollback run the same guard; the migration changes no table, column or constraint of the installed runtime",()=>{
 const m=readFileSync(MIG,"utf8"),rb=readFileSync(RB,"utf8");
 const guard=t=>t.slice(t.indexOf("DO $guard$"),t.indexOf("$guard$;"));
 const stripSet=t=>t.replace(/\n -- What THIS migration creates[^\n]*\n PERFORM set_config\([^\n]*\n/,"\n");
 assert.equal(stripSet(guard(m)),guard(rb),"identical checks");
 for(const must of ["Unrecognized overload of public.% exists","p.prosecdef","p.proisstrict","p.provolatile<>'v'","p.proconfig IS DISTINCT FROM ARRAY['search_path=\"\"']",
  "pg_catalog.pg_get_function_arguments(v_fn) IS DISTINCT FROM r.args","pg_catalog.pg_get_function_result(v_fn) IS DISTINCT FROM r.res",
  "md5(btrim(regexp_replace(p.prosrc"])assert.ok(m.includes(must)&&rb.includes(must),must);
 assert.doesNotMatch(m,/\bALTER\s+TABLE\s+public\.(automation_flow|tenants|channel_accounts)/i);
 assert.doesNotMatch(m,/\bDROP\s+(TABLE|FUNCTION)\b/i);
 assert.match(m,/IDEMPOTENT/);assert.match(rb,/Idempotent/);
});
test("the Edge Function calls exactly the SQL parameter names (static half)",()=>{
 const src=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const called=n=>[...src.matchAll(new RegExp(`rpc\\(\\s*"${n}"\\s*,\\s*\\{([^}]*)\\}`,"g"))].map(m=>[...m[1].matchAll(/(p_[a-z_]+)\s*:/g)].map(k=>k[1]).sort().join(","));
 const params=sig=>readFileSync(MIG,"utf8").match(new RegExp(`FUNCTION public\\.${sig.split("(")[0]}\\(([^)]*)\\)`))[1].split(",").map(s=>s.trim().split(/\s+/)[0]).sort().join(",");
 for(const [tag,sig] of Object.entries(SIGS)){
  const n=sig.split("(")[0];const calls=called(n);
  assert.ok(calls.length>=1,`${n} is called`);
  for(const c of calls)assert.equal(c,params(sig),`${n}: caller arguments equal the SQL parameters`);
 }
});

// ------------------------------------------------------------------------------- live PostgreSQL
function findPgBin(){
 const c=[];if(process.env.PG_BIN)c.push(process.env.PG_BIN);
 try{for(const v of readdirSync("/usr/lib/postgresql").sort().reverse())c.push(`/usr/lib/postgresql/${v}/bin`);}catch{}
 return c.find(d=>["initdb","pg_ctl","postgres","psql"].every(b=>existsSync(join(d,b))))??null;
}
const BIN=findPgBin();
const isRoot=typeof process.getuid==="function"&&process.getuid()===0;
const canRun=!isRoot||spawnSync("id",["-u","postgres"]).status===0;
const skip=BIN&&canRun?false:"PostgreSQL server binaries unavailable; static checks only";
let dir,port,started=false;
const asServer=(cmd,args)=>isRoot?spawnSync("runuser",["-u","postgres","--",join(BIN,cmd),...args],{encoding:"utf8"}):spawnSync(join(BIN,cmd),args,{encoding:"utf8"});
const env=(extra={})=>{const e={};for(const [k,v] of Object.entries(process.env))if(!k.startsWith("PG"))e[k]=v;return {...e,...extra};};
function psql(db,{file,sql,user="postgres",extra}={}){
 const a=["-X","-q","-t","-A","-F","\t","-v","ON_ERROR_STOP=1","-h",dir,"-p",String(port),"-U",user,"-d",db];
 if(file)a.push("-f",file);
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input:sql,env:env(extra)});
}
const ok=(db,src,label)=>{const r=psql(db,src);assert.equal(r.status,0,`${label}\n${r.stderr}`);return r.stdout.trim();};
const q=(db,sql)=>ok(db,{sql},sql.slice(0,80));
before(()=>{
 if(skip)return;
 dir=mkdtempSync(join(tmpdir(),"flow-pubrpc-pg-"));
 if(isRoot){const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout),gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);chownSync(dir,uid,gid);}
 port=21000+((process.pid+7)%20000);
 let r=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);assert.equal(r.status,0,r.stderr);
 r=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",`-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off`,"start"]);
 assert.equal(r.status,0,r.stderr+r.stdout);started=true;
});
after(()=>{if(!dir)return;if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);rmSync(dir,{recursive:true,force:true});});

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UA="99999999-9999-4999-8999-99999999999a",UB="99999999-9999-4999-8999-99999999999b";
const IA="11111111-1111-4111-8111-111111111111",IA2="44444444-4444-4444-8444-444444444444",FB="22222222-2222-4222-8222-222222222222";
const DOC=`'{"version":"3","nodes":[],"edges":[]}'::jsonb`;
const pub=(t=A,acc=IA,plat="instagram",key="welcome",actor=UA,doc=DOC)=>`SELECT coalesce(public.flow_publish_revision('${t}','${acc}','${plat}','${key}','${actor}',${doc})::text,'NULL')`;
const act=(t=A,acc=IA,plat="instagram",key="welcome",rev=1,actor=UA)=>`SELECT public.flow_activate_revision('${t}','${acc}','${plat}','${key}',${rev},'${actor}')`;
const deact=(t=A,acc=IA,plat="instagram",key="welcome",actor=UA)=>`SELECT public.flow_deactivate_revision('${t}','${acc}','${plat}','${key}','${actor}')`;
const cnt=(db,t)=>Number(q(db,`SELECT count(*) FROM public.${t}`));
const createDb=(name,tpl)=>ok("postgres",{sql:`CREATE DATABASE ${name}${tpl?` TEMPLATE ${tpl}`:""};`},"createdb "+name);

// Fingerprint of everything the migration can touch (functions, rate table, grants, comments, data)
const FP=`SELECT md5(coalesce(string_agg(x,E'\\n' ORDER BY x),'')) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||coalesce(p.proacl::text,'')||':'||coalesce(p.proconfig::text,'')||':'||p.prosecdef::text||':'||p.provolatile::text
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'flow\\_%' ESCAPE '\\'
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')||':'||c.relrowsecurity::text
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 'c:'||attrelid::regclass::text||'.'||attname||':'||format_type(atttypid,atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND attnum>0 AND NOT attisdropped
) s(x);`;
const fp=db=>q(db,FP);

function buildBase(){
 // cluster roles of the live shape, only when absent
 ok("postgres",{sql:`DO $r$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=n) THEN EXECUTE format('CREATE ROLE %I NOLOGIN%s',n,CASE WHEN n='service_role' THEN ' BYPASSRLS' ELSE '' END); END IF; END LOOP; END $r$;`},"roles");
 createDb("rpc_pre");
 const shape=readFileSync("tests/sql/fixtures/flow-live-shape-bootstrap.sql","utf8").split("\n").filter(l=>!l.startsWith("CREATE ROLE ")).join("\n");
 ok("rpc_pre",{sql:shape},"live shape");
 ok("rpc_pre",{sql:`
  ALTER TABLE public.tenants ADD COLUMN user_id uuid,ADD COLUMN is_active boolean NOT NULL DEFAULT true;
  ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,
   ADD COLUMN auto_reply boolean NOT NULL DEFAULT true;
  UPDATE public.tenants SET user_id='${UA}' WHERE id='${A}';UPDATE public.tenants SET user_id='${UB}' WHERE id='${B}';
  INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES('${IA2}','${A}','instagram','instagram');`},"installed columns");
 for(const f of ["tests/sql/fixtures/installed-flow-switches.sql"])ok("rpc_pre",{file:f},f);
 ok("rpc_pre",{sql:"ALTER TABLE public.automation_flow_tenant_switches ADD COLUMN IF NOT EXISTS production_approved boolean NOT NULL DEFAULT false;"},"production_approved");
 ok("rpc_pre",{file:"tests/sql/fixtures/installed-flow-runtime.sql"},"installed-flow-runtime");
 ok("rpc_pre",{sql:`INSERT INTO public.automation_flow_global_switch(singleton,enabled) VALUES(true,true) ON CONFLICT(singleton) DO UPDATE SET enabled=true;
  INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved) VALUES('${A}',true,false,true)
   ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
  INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved) VALUES('${B}',true,true,false)
   ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=true,production_approved=false;`},"switch rows");
 createDb("rpc_post","rpc_pre");
 ok("rpc_post",{file:MIG},"apply migration");
}

test("live: SQL behaviour of publish, validation, activation gate, deactivation, rate limit, isolation, atomicity",{skip},()=>{
 buildBase();
 const T=n=>{createDb(n,"rpc_post");return n;};
 // ---------------- publish: valid
 let db=T("rpc_pub");
 assert.equal(q(db,pub()),"1");assert.equal(q(db,pub()),"2","revisions are monotonic per flow key");
 assert.equal(q(db,pub(A,IA,"instagram","other")),"1","another key starts at 1");
 assert.equal(q(db,`SELECT published_by::text||'|'||channel_account_id::text||'|'||platform FROM public.automation_flow_publications WHERE flow_key='welcome' AND revision=2`),`${UA}|${IA}|instagram`);
 assert.equal(q(db,pub(B,FB,"facebook","bkey",UB)),"1","another tenant has its own revisions");
 // ---------------- publish: rejected (NULL, nothing stored)
 const before=cnt(db,"automation_flow_publications");
 const big=`jsonb_build_object('version','3','nodes',jsonb_build_array(repeat('x',4300000)),'edges','[]'::jsonb)`;
 const bad=[
  ["key with a space",pub(A,IA,"instagram","bad key")],["empty key",pub(A,IA,"instagram","")],["key too long",pub(A,IA,"instagram","k".repeat(129))],
  ["document version 2",pub(A,IA,"instagram","welcome",UA,`'{"version":"2","nodes":[],"edges":[]}'::jsonb`)],
  ["nodes not an array",pub(A,IA,"instagram","welcome",UA,`'{"version":"3","nodes":{},"edges":[]}'::jsonb`)],
  ["edges missing",pub(A,IA,"instagram","welcome",UA,`'{"version":"3","nodes":[]}'::jsonb`)],
  ["document is an array",pub(A,IA,"instagram","welcome",UA,`'[]'::jsonb`)],["document over 4 MiB",pub(A,IA,"instagram","welcome",UA,big)],
  ["actor is not the tenant owner",pub(A,IA,"instagram","welcome",UB)],["account of another tenant",pub(A,FB,"facebook","welcome")],
  ["platform does not match the account",pub(A,IA,"facebook","welcome")],["flow key bound to another account",pub(A,IA2,"instagram","welcome")],
  ["unknown tenant",pub("cccccccc-cccc-4ccc-8ccc-cccccccccccc")]];
 for(const [label,sql] of bad)assert.equal(q(db,sql),"NULL",label);
 assert.equal(q(db,`SELECT public.flow_publish_revision(NULL,'${IA}','instagram','k','${UA}',${DOC}) IS NULL AND public.flow_publish_revision('${A}','${IA}',NULL,'k','${UA}',${DOC}) IS NULL AND public.flow_publish_revision('${A}','${IA}','instagram',NULL,'${UA}',${DOC}) IS NULL AND public.flow_publish_revision('${A}','${IA}','instagram','k','${UA}',NULL) IS NULL`),"t","NULL arguments");
 assert.equal(cnt(db,"automation_flow_publications"),before,"no row stored by any rejected publish");
 ok(db,{sql:"UPDATE public.channel_accounts SET is_active=false WHERE id='"+IA+"';"},"suspend");
 assert.equal(q(db,pub()),"NULL","inactive account");
 ok(db,{sql:"UPDATE public.channel_accounts SET is_active=true WHERE id='"+IA+"'; UPDATE public.tenants SET is_active=false WHERE id='"+A+"';"},"suspend tenant");
 assert.equal(q(db,pub()),"NULL","inactive tenant");

 // ---------------- activate (production approval gate) and deactivate
 db=T("rpc_act");q(db,pub());q(db,pub());
 const swi=(set)=>ok(db,{sql:`UPDATE public.automation_flow_tenant_switches SET ${set} WHERE tenant_id='${A}';`},set);
 const row=()=>q(db,`SELECT revision||'|'||is_active||'|'||(activated_at IS NOT NULL) FROM public.automation_flow_activations WHERE tenant_id='${A}' AND flow_key='welcome'`);
 assert.equal(q(db,act()),"t","approved production tenant (test_only=false, production_approved=true)");assert.equal(row(),"1|true|true");
 q(db,deact());assert.equal(row(),"1|false|true");
 const refused=(label,pre,undo,sql=act())=>{ if(pre)ok(db,{sql:pre},label);try{assert.equal(q(db,sql),"f",label);}finally{if(undo)ok(db,{sql:undo},"undo "+label);}};
 refused("production NOT approved and not test_only","UPDATE public.automation_flow_tenant_switches SET production_approved=false,test_only=false WHERE tenant_id='"+A+"';","UPDATE public.automation_flow_tenant_switches SET production_approved=true WHERE tenant_id='"+A+"';");
 refused("tenant switch disabled","UPDATE public.automation_flow_tenant_switches SET enabled=false WHERE tenant_id='"+A+"';","UPDATE public.automation_flow_tenant_switches SET enabled=true WHERE tenant_id='"+A+"';");
 refused("global switch off","UPDATE public.automation_flow_global_switch SET enabled=false;","UPDATE public.automation_flow_global_switch SET enabled=true;");
 refused("no tenant switch row","DELETE FROM public.automation_flow_tenant_switches WHERE tenant_id='"+A+"';","INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved) VALUES('"+A+"',true,false,true);");
 refused("account auto_reply off","UPDATE public.channel_accounts SET auto_reply=false WHERE id='"+IA+"';","UPDATE public.channel_accounts SET auto_reply=true WHERE id='"+IA+"';");
 refused("account agent disabled","UPDATE public.channel_accounts SET agent_enabled=false WHERE id='"+IA+"';","UPDATE public.channel_accounts SET agent_enabled=true WHERE id='"+IA+"';");
 refused("account inactive","UPDATE public.channel_accounts SET is_active=false WHERE id='"+IA+"';","UPDATE public.channel_accounts SET is_active=true WHERE id='"+IA+"';");
 refused("tenant inactive","UPDATE public.tenants SET is_active=false WHERE id='"+A+"';","UPDATE public.tenants SET is_active=true WHERE id='"+A+"';");
 refused("actor is not the owner",null,null,act(A,IA,"instagram","welcome",1,UB));
 refused("platform mismatch",null,null,act(A,IA,"facebook"));
 refused("revision that was never published",null,null,act(A,IA,"instagram","welcome",99));
 refused("revision 0",null,null,act(A,IA,"instagram","welcome",0));
 refused("publication belongs to another account",null,null,act(A,IA2));
 refused("account of another tenant",null,null,act(A,FB,"facebook"));
 assert.equal(q(db,`SELECT public.flow_activate_revision(NULL,'${IA}','instagram','welcome',1,'${UA}') OR public.flow_activate_revision('${A}','${IA}','instagram','welcome',NULL,'${UA}') OR public.flow_activate_revision('${A}','${IA}','instagram',NULL,1,'${UA}')`),"f","NULL arguments");
 assert.equal(row(),"1|false|true","no refused call changed the activation row");
 swi("test_only=true,production_approved=false");assert.equal(q(db,act()),"t","a test_only tenant still activates (test_only OR production_approved)");
 swi("test_only=false,production_approved=true");
 assert.equal(q(db,act(A,IA,"instagram","welcome",2)),"t");assert.equal(row(),"2|true|true","same key, newer revision: one row updated in place");
 assert.equal(cnt(db,"automation_flow_activations"),1);
 // deactivate: stays possible without any switch, approval or healthy account
 ok(db,{sql:"UPDATE public.automation_flow_global_switch SET enabled=false; UPDATE public.automation_flow_tenant_switches SET enabled=false,production_approved=false WHERE tenant_id='"+A+"'; UPDATE public.channel_accounts SET is_active=false,auto_reply=false WHERE id='"+IA+"';"},"everything off");
 assert.equal(q(db,deact(A,IA,"instagram","welcome",UB)),"f","wrong actor cannot deactivate");assert.equal(row(),"2|true|true");
 assert.equal(q(db,deact(A,IA,"instagram","unknown-key")),"f");
 assert.equal(q(db,deact()),"t","deactivation works with switches off, approval revoked and the account suspended");assert.equal(row(),"2|false|true");
 assert.equal(q(db,deact()),"t","deactivating again is a harmless no-op");
 // ---------------- transaction atomicity
 db=T("rpc_atomic");
 ok(db,{sql:`BEGIN;${pub()};${act()};ROLLBACK;`},"rolled back");
 assert.equal(cnt(db,"automation_flow_publications")+cnt(db,"automation_flow_activations"),0,"a rolled back transaction leaves neither a revision nor an activation");
 const failing=psql(db,{sql:`BEGIN;${pub()};SELECT 1/0;COMMIT;`});
 assert.notEqual(failing.status,0);assert.equal(cnt(db,"automation_flow_publications"),0,"an error after a publish rolls it back");
 // ---------------- rate limit: 30 per tenant and UTC minute (one transaction = one fixed bucket)
 db=T("rpc_rate");
 const calls=Array.from({length:31},()=>`SELECT public.flow_publication_rate_allow('${A}')`).join(";");
 const out=psql(db,{sql:`BEGIN;${calls};COMMIT;`}).stdout.trim().split("\n");
 assert.deepEqual([out.slice(0,30).every(x=>x==="t"),out[30]],[true,"f"],"calls 1..30 allowed, call 31 refused");
 assert.equal(q(db,`SELECT request_count FROM public.flow_publication_rate_windows WHERE tenant_id='${A}'`),"30");
 assert.equal(q(db,`SELECT public.flow_publication_rate_allow('${B}')`),"t","tenants are limited independently");
 assert.equal(q(db,`SELECT public.flow_publication_rate_allow('cccccccc-cccc-4ccc-8ccc-cccccccccccc')`),"f","unknown tenant");
 assert.equal(q(db,`SELECT public.flow_publication_rate_allow(NULL)`),"f");
 ok(db,{sql:`INSERT INTO public.flow_publication_rate_windows(tenant_id,window_start,request_count) VALUES
  ('${A}',date_trunc('minute',now()-interval '49 hours'),5),('${A}',date_trunc('minute',now()-interval '47 hours'),5),('${B}',date_trunc('minute',now()-interval '49 hours'),5);`},"old windows");
 q(db,`SELECT public.flow_publication_rate_allow('${A}')`);
 assert.equal(q(db,`SELECT count(*) FROM public.flow_publication_rate_windows WHERE tenant_id='${A}' AND window_start<now()-interval '48 hours'`),"0","tenant A's expired windows are removed");
 assert.equal(q(db,`SELECT count(*) FROM public.flow_publication_rate_windows WHERE tenant_id='${A}' AND window_start>now()-interval '48 hours' AND request_count=5`),"1","a window inside 48 hours is kept");
 assert.equal(q(db,`SELECT count(*) FROM public.flow_publication_rate_windows WHERE tenant_id='${B}' AND window_start<now()-interval '48 hours'`),"1","another tenant's rows are never touched");
});

test("live: grants, ownership, security mode, search_path and caller/signature agreement",{skip},()=>{
 if(!existsSync(join(dir,"data")))return;
 const db="rpc_post";
 for(const sig of Object.values(SIGS)){
  const r=q(db,`SELECT pg_get_userbyid(p.proowner)||'|'||p.prosecdef::text||'|'||p.provolatile::text||'|'||p.proisstrict::text||'|'||coalesce(array_to_string(p.proconfig,','),'')||'|'||coalesce(p.proacl::text,'NULL')||'|'||obj_description(p.oid,'pg_proc')
   FROM pg_proc p WHERE p.oid='public.${sig}'::regprocedure`);
  assert.equal(r,`postgres|false|v|false|search_path=""|{postgres=X/postgres,service_role=X/postgres}|${OWN}`,sig);
  assert.equal(q(db,`SELECT has_function_privilege('anon','public.${sig}','EXECUTE')::text||has_function_privilege('authenticated','public.${sig}','EXECUTE')||has_function_privilege('public','public.${sig}','EXECUTE')||has_function_privilege('service_role','public.${sig}','EXECUTE')`),"falsefalsefalsetrue",sig);
 }
 for(const role of ["anon","authenticated"]){
  const r=psql(db,{sql:`SET ROLE ${role}; SELECT public.flow_publication_rate_allow('${A}');`});
  assert.notEqual(r.status,0);assert.match(r.stderr,/permission denied for function flow_publication_rate_allow/,role);
 }
 assert.equal(q(db,`SELECT c.relrowsecurity::text||'|'||obj_description(c.oid,'pg_class') FROM pg_class c WHERE c.oid='public.flow_publication_rate_windows'::regclass`),`true|${OWN}`);
 const acl=q(db,`SELECT relacl::text FROM pg_class WHERE oid='public.flow_publication_rate_windows'::regclass`);
 assert.doesNotMatch(acl,/(^|[{,"])(=|anon=|authenticated=)/);assert.match(acl,/service_role=arwd/);
 // the SQL parameter names are exactly the names the Edge Function sends
 const src=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 for(const sig of Object.values(SIGS)){
  const n=sig.split("(")[0];
  const names=q(db,`SELECT array_to_string(proargnames,',') FROM pg_proc WHERE oid='public.${sig}'::regprocedure`).split(",").sort().join(",");
  const calls=[...src.matchAll(new RegExp(`rpc\\(\\s*"${n}"\\s*,\\s*\\{([^}]*)\\}`,"g"))].map(m=>[...m[1].matchAll(/(p_[a-z_]+)\s*:/g)].map(k=>k[1]).sort().join(","));
  assert.ok(calls.length>=1);for(const c of calls)assert.equal(c,names,`${n}: caller and database agree`);
 }
});

test("live: apply, apply twice, rollback exactness, re-apply, adoption of a production-identical state, rollback data guard",{skip},()=>{
 if(!existsSync(join(dir,"data")))return;
 const pre=fp("rpc_pre"),post=fp("rpc_post");
 assert.notEqual(pre,post);
 createDb("rpc_twice","rpc_post");ok("rpc_twice",{file:MIG},"second application");
 assert.equal(fp("rpc_twice"),post,"applying twice changes nothing");
 // rollback from the migrated state restores EXACTLY the predecessor (functions, table, grants, comments)
 createDb("rpc_rb","rpc_post");ok("rpc_rb",{file:RB},"rollback");
 assert.equal(fp("rpc_rb"),pre,"exact restoration");
 assert.equal(q("rpc_rb",`SELECT count(*) FROM pg_proc WHERE proname IN('flow_publish_revision','flow_activate_revision','flow_deactivate_revision','flow_publication_rate_allow')`),"0");
 ok("rpc_rb",{file:RB},"rollback twice");assert.equal(fp("rpc_rb"),pre,"rolling back twice changes nothing");
 ok("rpc_rb",{file:MIG},"re-apply after rollback");assert.equal(fp("rpc_rb"),post,"re-apply gives the same state");
 // production state: the four functions and the rate table pre-exist WITHOUT this migration's marker
 createDb("rpc_prod","rpc_post");
 ok("rpc_prod",{sql:`${["publish","activate","deactivate"].map(t=>`COMMENT ON FUNCTION public.${SIGS[t]} IS NULL;`).join("")}
  COMMENT ON FUNCTION public.${SIGS.limit} IS '${HIST}';COMMENT ON TABLE public.flow_publication_rate_windows IS '${HIST}';`},"production-like markers");
 const prod=fp("rpc_prod");
 ok("rpc_prod",{file:MIG},"apply over production-identical objects");
 assert.equal(fp("rpc_prod"),prod,"adopted: no object, comment, grant or body changes");
 ok("rpc_prod",{file:RB},"rollback over production-identical objects");
 assert.equal(fp("rpc_prod"),prod,"rollback never removes objects it did not create");
 assert.equal(q("rpc_prod",`SELECT count(*) FROM pg_proc WHERE proname IN('flow_publish_revision','flow_activate_revision','flow_deactivate_revision','flow_publication_rate_allow')`),"4","all four production functions remain");
 // a used rate window table (created by this migration) blocks the rollback unless the operator opts in
 createDb("rpc_data","rpc_post");q("rpc_data",`SELECT public.flow_publication_rate_allow('${A}')`);
 const blocked=psql("rpc_data",{file:RB});
 assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/Refusing 20261115170000 rollback: 1 rate window row\(s\) exist/);
 assert.equal(fp("rpc_data").length,32);assert.equal(cnt("rpc_data","flow_publication_rate_windows"),1,"nothing was removed");
 const forced=psql("rpc_data",{file:RB,extra:{PGOPTIONS:"-c flow.rollback_20261115170000=discard-rate-windows"}});
 assert.equal(forced.status,0,forced.stderr);assert.equal(q("rpc_data",`SELECT to_regclass('public.flow_publication_rate_windows') IS NULL`),"t");
});

test("live: drift, foreign objects and missing prerequisites are refused by the migration (and the rollback), nothing changes",{skip},()=>{
 if(!existsSync(join(dir,"data")))return;
 const refuses=(db,file,re,label)=>{const before=fp(db);const r=psql(db,{file});
  assert.notEqual(r.status,0,`${label}: must be refused`);assert.match(r.stderr,re,`${label}: ${r.stderr}`);assert.equal(fp(db),before,`${label}: nothing changed`);};
 const DRIFT=/differs from the verified production definition; refusing to replace it/;
 const OVERLOAD=/Unrecognized overload of public\.\w+ exists; refusing to replace it/;
 const TABLE=/is not the recognised rate limiter table; refusing to use it/;
 const gate=`DO $t$ BEGIN EXECUTE replace(pg_get_functiondef('public.${SIGS.activate}'::regprocedure),'(s.test_only OR s.production_approved)','s.test_only'); END $t$;`;
 const cases=[
  ["publish body replaced",`CREATE OR REPLACE FUNCTION public.flow_publish_revision(p_tenant_id uuid,p_account_id uuid,p_platform text,p_flow_key text,p_actor_id uuid,p_document jsonb) RETURNS bigint LANGUAGE plpgsql SET search_path='' AS $x$BEGIN RETURN NULL; END$x$;`,DRIFT,true],
  ["activation gate reverted to test_only only",gate,DRIFT,true],
  ["deactivate made SECURITY DEFINER",`ALTER FUNCTION public.${SIGS.deactivate} SECURITY DEFINER;`,DRIFT,true],
  ["rate limiter search_path changed",`ALTER FUNCTION public.${SIGS.limit} SET search_path=public;`,DRIFT,true],
  ["activate made STRICT",`ALTER FUNCTION public.${SIGS.activate} STRICT;`,DRIFT,true],
  ["publish made STABLE",`ALTER FUNCTION public.${SIGS.publish} STABLE;`,DRIFT,true],
  ["foreign comment on a function",`COMMENT ON FUNCTION public.${SIGS.activate} IS 'SOMETHING_ELSE';`,DRIFT,true],
  ["extra overload of publish",`CREATE FUNCTION public.flow_publish_revision(uuid) RETURNS int LANGUAGE sql AS 'SELECT 1';`,OVERLOAD,true],
  ["extra overload of the rate limiter",`CREATE FUNCTION public.flow_publication_rate_allow(uuid,int) RETURNS boolean LANGUAGE sql AS 'SELECT true';`,OVERLOAD,true],
  ["rate table gained a column",`ALTER TABLE public.flow_publication_rate_windows ADD COLUMN extra int;`,TABLE,true],
  ["rate table lost its CHECK",`ALTER TABLE public.flow_publication_rate_windows DROP CONSTRAINT flow_publication_rate_windows_request_count_check;`,TABLE,true],
  ["rate table lost row level security",`ALTER TABLE public.flow_publication_rate_windows DISABLE ROW LEVEL SECURITY;`,TABLE,true]];
 for(const [i,[label,sql,re,both]] of cases.entries()){
  const t=`rpc_d${i}`;createDb(t,"rpc_post");ok(t,{sql},"tamper: "+label);
  refuses(t,MIG,re,"migration: "+label);if(both)refuses(t,RB,re,"rollback: "+label);
 }
 // predecessor-state refusals (nothing was created yet)
 createDb("rpc_p1","rpc_pre");ok("rpc_p1",{sql:`CREATE FUNCTION public.flow_activate_revision(p_tenant_id uuid,p_account_id uuid,p_platform text,p_flow_key text,p_revision bigint,p_actor_id uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';`},"foreign function");
 refuses("rpc_p1",MIG,DRIFT,"a pre-existing function that is not the verified one");
 createDb("rpc_p2","rpc_pre");ok("rpc_p2",{sql:"CREATE TABLE public.flow_publication_rate_windows(tenant_id uuid);"},"foreign table");
 refuses("rpc_p2",MIG,TABLE,"a pre-existing foreign rate table");
 createDb("rpc_p3","rpc_pre");ok("rpc_p3",{sql:"ALTER TABLE public.automation_flow_tenant_switches DROP COLUMN production_approved;"},"no approval column");
 refuses("rpc_p3",MIG,/Missing public\.automation_flow_tenant_switches\.production_approved/,"missing production_approved");
 createDb("rpc_p4","rpc_pre");ok("rpc_p4",{sql:"ALTER TABLE public.automation_flow_activations DROP CONSTRAINT automation_flow_activations_pkey;"},"no unique key");
 refuses("rpc_p4",MIG,/lacks its unique \(tenant_id,channel_account_id,platform,flow_key\) key/,"missing activation key");
 createDb("rpc_p5","rpc_pre");ok("rpc_p5",{sql:"DROP TABLE public.automation_flow_activations;"},"no activations table");
 refuses("rpc_p5",MIG,/Missing public\.automation_flow_activations\./,"missing runtime table");
});
