// 20261029310000_flow_ai_generations: AI flow builder credits (generate-flow).
// public.flow_ai_generations + flow_ai_generation_reserve / commit / release.
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards), like the other security / flow
// SQL suites. Fixture: roles anon / authenticated / service_role (BYPASSRLS),
// auth.uid() stub, supabase/schema.sql VERBATIM (pgvector swapped for a
// stub), and Supabase's default grants INCLUDING default privileges for
// future objects (so the migration's REVOKEs are really exercised).
// The real generate-flow handler + supabaseCreditPort are also driven against
// the SQL (LLM faked). Never connects to any remote host.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync,writeFileSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {handleGenerateFlow,APPROVED_ORIGIN} from "../supabase/functions/generate-flow/handler.ts";
import {supabaseCreditPort} from "../supabase/functions/generate-flow/credits.ts";

const MIG="supabase/migrations/20261029310000_flow_ai_generations.sql";
const RB="supabase/rollbacks/20261029310000_flow_ai_generations.rollback.sql";
const MARK="CREATED_BY_20261029310000_FLOW_AI_GENERATIONS";
const SIGS=["public.flow_ai_generation_reserve(uuid,uuid,text,integer)",
 "public.flow_ai_generation_commit(uuid,uuid,jsonb)","public.flow_ai_generation_release(uuid,uuid)"];
const src=f=>readFileSync(f,"utf8");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");

// ---------------------------------------------------------------- static
test("310000 is the newest migration; rollback exists",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 assert.equal(stamps.filter(s=>s==="20261029310000").length,1);
 // 20261029320000_oauth_tables (MCP server OAuth storage) is independent of the AI builder.
 for(const s of stamps)assert.ok(s<="20261029310000"||s==="20261029320000",s);
 assert.ok(existsSync(RB));
});
test("migration and rollback: one bounded transaction, service_role-only, SECURITY DEFINER with empty search_path",()=>{
 for(const f of [MIG,RB]){
  const s=src(f),code=noComments(s);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
  assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1,f);assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.doesNotMatch(code,/\bTRUNCATE\b|CONCURRENTLY|cron\.|vault\.|net\.http_|grant_credits|consume_|wayl|topup/i,f);
  assert.doesNotMatch(code,/GRANT[^;]*\bTO\s+(anon|authenticated|PUBLIC)\b/i,`${f}: nothing granted to client roles`);
 }
 const code=noComments(src(MIG));
 assert.equal((code.match(/SECURITY DEFINER\nSET search_path = ''/g)??[]).length,3);
 assert.doesNotMatch(code,/SECURITY INVOKER|CREATE POLICY/);
 assert.match(code,/ALTER TABLE public\.flow_ai_generations ENABLE ROW LEVEL SECURITY;/);
 assert.match(code,/REVOKE ALL ON TABLE public\.flow_ai_generations FROM PUBLIC, anon, authenticated;/);
 for(const sig of SIGS){
  assert.ok(code.includes(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated;`),sig);
  assert.ok(code.includes(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`),sig);
  assert.ok(code.includes(`COMMENT ON FUNCTION ${sig} IS '${MARK}';`),sig);
 }
 assert.match(code,/interval '180 seconds'/);
 assert.match(code,/credits_remaining >= p_cost/);
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
const psqlArgs=db=>["-X","-q","-t","-A","-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose","-h",dir,"-p",String(port),"-U","postgres","-d",db];
function psql(db,{file,sql,env}={}){
 const a=psqlArgs(db);
 if(file)a.push("-f",file);
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input:sql,env:clientEnv(env),maxBuffer:1<<26});
}
function psqlAsync(db,sql){
 return new Promise(res=>{
  const c=spawn(join(BIN,"psql"),psqlArgs(db),{env:clientEnv()});
  let out="",err="";c.stdout.on("data",d=>out+=d);c.stderr.on("data",d=>err+=d);
  c.on("close",status=>res({status,stdout:out,stderr:err}));
  c.stdin.end(sql);
 });
}
function ok(db,s,label){
 const r=psql(db,s);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return r.stdout.trim();
}
const sqlState=err=>(err.match(/ERROR:\s+([0-9A-Z]{5}):/)??[])[1];
const asSql=(role,stmt,sub)=>`BEGIN;${sub?`SET LOCAL "request.jwt.claim.sub"='${sub}';`:""}SET LOCAL ROLE ${role};\n${stmt}\nCOMMIT;`;
const as=(db,role,stmt,sub)=>psql(db,{sql:asSql(role,stmt,sub)});
const val=(db,q)=>ok(db,{sql:`SELECT (${q});`},q);
const SR="service_role";
const svc=(db,stmt)=>{const r=as(db,SR,stmt);assert.equal(r.status,0,`${stmt}\n${r.stderr}`);return r.stdout.trim();};
let dbn=0;
const fresh=(template="g310")=>{const d=`d${++dbn}`;ok("postgres",{sql:`CREATE DATABASE ${d} TEMPLATE ${template};`},d);return d;};

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",C="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UA="11111111-1111-4111-8111-111111111111",UB="22222222-2222-4222-8222-222222222222";
const R1="d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1",R2="d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2",R3="d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3";
const H1="1".repeat(64),H2="2".repeat(64);
const DOC={nodes:[{id:"n1",type:"flowNode"}],edges:[]};
const J=o=>`'${JSON.stringify(o).replace(/'/g,"''")}'::jsonb`;
const reserve=(db,t,r,h=H1,cost=5)=>JSON.parse(svc(db,`SELECT public.flow_ai_generation_reserve('${t}','${r}','${h}',${cost});`));
const commit=(db,t,r,d=DOC)=>svc(db,`SELECT public.flow_ai_generation_commit('${t}','${r}',${J(d)});`);
const release=(db,t,r)=>svc(db,`SELECT public.flow_ai_generation_release('${t}','${r}');`);
const credits=(db,t)=>Number(val(db,`SELECT credits_remaining FROM public.tenants WHERE id='${t}'`));
const row=(db,t,r)=>{const o=val(db,`SELECT coalesce((SELECT to_jsonb(g)-'document'||jsonb_build_object('has_doc',g.document IS NOT NULL) FROM public.flow_ai_generations g WHERE tenant_id='${t}' AND request_id='${r}'),'null')`);return JSON.parse(o);};

const VECTOR_STUB=`-- pgvector stub (extension unavailable in this sandbox)
CREATE DOMAIN public.vector AS double precision[];
CREATE FUNCTION public.vector_cosine_distance_stub(a public.vector, b public.vector) RETURNS double precision
 LANGUAGE sql IMMUTABLE AS $c$ SELECT 0::double precision $c$;
CREATE OPERATOR public.<=> (LEFTARG = public.vector, RIGHTARG = public.vector, FUNCTION = public.vector_cosine_distance_stub);
`;
function fixture(){
 const schema=src("supabase/schema.sql");
 assert.ok(schema.includes("create extension if not exists vector;\n"));
 return `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
 AS $u$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $u$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
${schema.replace("create extension if not exists vector;\n",VECTOR_STUB)}
-- Supabase default privileges (existing AND future objects).
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
INSERT INTO auth.users VALUES ('${UA}'),('${UB}');
INSERT INTO public.tenants(id,user_id,business_name,source_type,credits_remaining,is_active) VALUES
 ('${A}','${UA}','A','manual',12,true),('${B}','${UB}','B','manual',4,true),('${C}',NULL,'C','manual',50,false);
`;
}
const SNAP=`SELECT string_agg(x,E'\\n' ORDER BY x) FROM (
 SELECT 'r:'||c.relname||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity||':'||coalesce(obj_description(c.oid,'pg_class'),'')
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'p:'||tablename||':'||policyname FROM pg_policies WHERE schemaname='public'
 UNION ALL SELECT 'f:'||p.oid::regprocedure||':'||p.prosecdef||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||md5(p.prosrc)||':'||
   coalesce(p.proacl::text,'')||':'||coalesce(obj_description(p.oid,'pg_proc'),'') FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
) s(x)`;

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-ai-gen-pg-"));
 if(isRoot)chownSync(dir,Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout.trim()),
  Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout.trim()));
 port=20000+((process.pid+310)%20000);
 const init=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(init.status,0,init.stderr);
 const st=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off`,"start"]);
 assert.equal(st.status,0,st.stderr+st.stdout);started=true;
 ok("postgres",{sql:"CREATE DATABASE base;"},"create base");
 const fx=join(dir,"fixture.sql");writeFileSync(fx,fixture());
 ok("base",{file:fx},"fixture");
 ok("postgres",{sql:"CREATE DATABASE g310 TEMPLATE base;"},"g310");
 ok("g310",{file:MIG},"apply 310000");
});
after(()=>{
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 if(dir)rmSync(dir,{recursive:true,force:true});
});

test("live: re-apply is a no-op; markers, DEFINER/search_path, privileges (anon/authenticated denied)",{skip},()=>{
 const db=fresh();
 const pre=val(db,SNAP);
 ok(db,{file:MIG},"re-apply");
 assert.equal(val(db,SNAP),pre);
 assert.equal(val(db,`obj_description('public.flow_ai_generations'::regclass,'pg_class')`),MARK);
 assert.equal(val(db,`SELECT relrowsecurity FROM pg_class WHERE oid='public.flow_ai_generations'::regclass`),"t");
 assert.equal(val(db,`SELECT count(*) FROM pg_policies WHERE tablename='flow_ai_generations'`),"0");
 for(const sig of SIGS){
  assert.equal(val(db,`SELECT prosecdef::text||'|'||array_to_string(proconfig,',') FROM pg_proc WHERE oid='${sig}'::regprocedure`),'true|search_path=""');
  for(const role of ["anon","authenticated","public"])
   assert.equal(val(db,`has_function_privilege('${role}','${sig}','EXECUTE')`),"f",`${sig} ${role}`);
  assert.equal(val(db,`has_function_privilege('service_role','${sig}','EXECUTE')`),"t",sig);
 }
 for(const role of ["anon","authenticated"])for(const p of ["SELECT","INSERT","UPDATE","DELETE"])
  assert.equal(val(db,`has_table_privilege('${role}','public.flow_ai_generations','${p}')`),"f",`${role} ${p}`);
 const deniedCalls=[`SELECT * FROM public.flow_ai_generations;`,
  `SELECT public.flow_ai_generation_reserve('${A}','${R1}','${H1}',5);`,
  `SELECT public.flow_ai_generation_release('${A}','${R1}');`,
  `SELECT public.flow_ai_generation_commit('${A}','${R1}','{"nodes":[],"edges":[]}');`];
 for(const stmt of deniedCalls){
  for(const [role,sub] of [["anon",null],["authenticated",UA]]){
   const r=as(db,role,stmt,sub);
   assert.notEqual(r.status,0,`${role}: ${stmt}`);assert.equal(sqlState(r.stderr),"42501",`${role}: ${r.stderr}`);
  }
 }
 assert.equal(credits(db,A),12,"denied calls changed nothing");
});

test("live: refuses to take over an unmarked table",{skip},()=>{
 const db=fresh("base");
 ok(db,{sql:"CREATE TABLE public.flow_ai_generations(x int);"},"plant");
 const r=psql(db,{file:MIG});
 assert.notEqual(r.status,0);assert.match(r.stderr,/without marker/);
});

test("live: happy path reserve -> commit; duplicate returns the cached document without a second charge",{skip},()=>{
 const db=fresh();
 assert.deepEqual(reserve(db,A,R1),{status:"reserved",remaining:7});
 assert.equal(credits(db,A),7);
 assert.deepEqual(reserve(db,A,R1),{status:"in_flight"});
 assert.equal(commit(db,A,R1),"committed");
 assert.equal(commit(db,A,R1),"already");
 assert.deepEqual(reserve(db,A,R1),{status:"cached",document:DOC});
 assert.deepEqual(reserve(db,A,R1),{status:"cached",document:DOC});
 assert.equal(release(db,A,R1),"noop","a committed charge is never refunded");
 assert.equal(credits(db,A),7);
 const r=row(db,A,R1);
 assert.equal(r.status,"committed");assert.equal(r.charges,1);assert.equal(r.refunds,0);assert.equal(r.has_doc,true);assert.equal(r.cost,5);
 // Tenant isolation: the same request_id under tenant B is a separate row; B cannot read A's cache.
 assert.deepEqual(reserve(db,B,R1),{status:"no_credit"});
 assert.equal(commit(db,B,R1),"not_reserved");
 assert.equal(release(db,B,R1),"noop");
 assert.equal(credits(db,A),7);assert.equal(credits(db,B),4);
});

test("live: insufficient credits / inactive tenant / invalid args: no charge, no row",{skip},()=>{
 const db=fresh();
 assert.deepEqual(reserve(db,B,R1),{status:"no_credit"});
 assert.equal(credits(db,B),4);assert.equal(row(db,B,R1),null);
 assert.deepEqual(reserve(db,C,R1),{status:"no_credit"},"inactive tenant");
 assert.equal(credits(db,C),50);
 assert.deepEqual(reserve(db,"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",R1),{status:"invalid"});
 assert.deepEqual(reserve(db,A,R1,"nothex"),{status:"invalid"});
 assert.deepEqual(reserve(db,A,R1,H1,0),{status:"invalid"});
 assert.deepEqual(reserve(db,A,R1,H1,101),{status:"invalid"});
 assert.equal(credits(db,A),12);
 // Exactly enough: 12 -> 7 -> 2, then no_credit (never negative).
 assert.equal(reserve(db,A,R1).status,"reserved");assert.equal(reserve(db,A,R2).status,"reserved");
 assert.deepEqual(reserve(db,A,R3),{status:"no_credit"});
 assert.equal(credits(db,A),2);
 const bad=psql(db,{sql:`UPDATE public.tenants SET credits_remaining=0 WHERE id='${A}';`});
 assert.equal(bad.status,0);
 assert.deepEqual(reserve(db,A,R3),{status:"no_credit"});
 assert.equal(credits(db,A),0);
});

test("live: release refunds exactly once; retry with the same request_id is allowed after a refund",{skip},()=>{
 const db=fresh();
 assert.equal(reserve(db,A,R1).status,"reserved");
 assert.equal(release(db,A,R1),"released");
 assert.equal(release(db,A,R1),"noop");
 assert.equal(release(db,A,R1),"noop");
 assert.equal(credits(db,A),12);
 assert.equal(commit(db,A,R1),"not_reserved","a released reservation cannot be committed");
 assert.deepEqual(reserve(db,A,R1),{status:"reserved",remaining:7},"retry after refund");
 assert.equal(commit(db,A,R1),"committed");
 const r=row(db,A,R1);
 assert.deepEqual([r.status,r.charges,r.refunds],["committed",2,1]);
 assert.equal(credits(db,A),7,"net one charge");
 // State CHECK makes a double refund impossible even for direct writes.
 const w=psql(db,{sql:`UPDATE public.flow_ai_generations SET status='released',refunds=refunds+1,document=NULL WHERE request_id='${R1}';`});
 assert.equal(w.status,0,"charges=2,refunds=2 is a consistent released row");
 const w2=psql(db,{sql:`UPDATE public.flow_ai_generations SET refunds=refunds+1 WHERE request_id='${R1}';`});
 assert.equal(sqlState(w2.stderr),"23514");
});

test("live: same request_id with a different prompt hash -> mismatch, no charge",{skip},()=>{
 const db=fresh();
 assert.equal(reserve(db,A,R1).status,"reserved");
 assert.deepEqual(reserve(db,A,R1,H2),{status:"mismatch"});
 assert.equal(commit(db,A,R1),"committed");
 assert.deepEqual(reserve(db,A,R1,H2),{status:"mismatch"});
 assert.equal(credits(db,A),7);
});

test("live: stale reservations (> 180 s) are refunded exactly once by the next reserve",{skip},()=>{
 const db=fresh();
 assert.equal(reserve(db,A,R1).status,"reserved");
 assert.equal(credits(db,A),7);
 ok(db,{sql:`UPDATE public.flow_ai_generations SET reserved_at=now()-interval '170 seconds' WHERE request_id='${R1}';`},"young");
 assert.deepEqual(reserve(db,A,R1),{status:"in_flight"},"not yet stale");
 assert.equal(credits(db,A),7);
 ok(db,{sql:`UPDATE public.flow_ai_generations SET reserved_at=now()-interval '181 seconds' WHERE request_id='${R1}';`},"age");
 // Another tenant's reserve never sweeps A.
 ok(db,{sql:`UPDATE public.tenants SET credits_remaining=10 WHERE id='${B}';`},"fund B");
 assert.equal(reserve(db,B,R2).status,"reserved");
 assert.equal(credits(db,A),7);
 // A's next reserve (different request) refunds R1 first, then debits R2.
 assert.deepEqual(reserve(db,A,R2),{status:"reserved",remaining:7});
 assert.deepEqual([row(db,A,R1).status,row(db,A,R1).refunds],["released",1]);
 assert.deepEqual(reserve(db,A,R3),{status:"reserved",remaining:2});
 assert.equal(row(db,A,R1).refunds,1,"refunded exactly once");
 assert.equal(release(db,A,R1),"noop");
 assert.equal(commit(db,A,R1),"not_reserved","a swept crash can never be committed later");
 // The crashed request itself may be retried (charged again: net one charge).
 assert.equal(release(db,A,R3),"released");
 assert.deepEqual(reserve(db,A,R1),{status:"reserved",remaining:2});
 assert.deepEqual([row(db,A,R1).charges,row(db,A,R1).refunds],[2,1]);
 // Stale sweep of the SAME request_id on its own retry.
 ok(db,{sql:`UPDATE public.flow_ai_generations SET reserved_at=now()-interval '200 seconds' WHERE request_id='${R1}' AND tenant_id='${A}';`},"age2");
 assert.deepEqual(reserve(db,A,R1),{status:"reserved",remaining:2});
 assert.deepEqual([row(db,A,R1).charges,row(db,A,R1).refunds,credits(db,A)],[3,2,2]);
});

test("live: concurrent duplicate reserves charge once (tenant row lock)",{skip},async()=>{
 const db=fresh();
 const call=`BEGIN;SET LOCAL ROLE service_role;SELECT '@'||public.flow_ai_generation_reserve('${A}','${R1}','${H1}',5)::text;SELECT pg_sleep(0.4);COMMIT;`;
 const results=await Promise.all(Array.from({length:6},()=>psqlAsync(db,call)));
 const statuses=results.map(r=>{assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.split("\n").find(l=>l.startsWith("@")).slice(1)).status;}).sort();
 assert.deepEqual(statuses,["in_flight","in_flight","in_flight","in_flight","in_flight","reserved"]);
 assert.equal(credits(db,A),7);
 // Concurrent distinct requests against 12 credits: exactly two succeed, never negative.
 const db2=fresh();
 const ids=[R1,R2,R3,"d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4"];
 const many=await Promise.all(ids.map(id=>psqlAsync(db2,
  `BEGIN;SET LOCAL ROLE service_role;SELECT '@'||public.flow_ai_generation_reserve('${A}','${id}','${H1}',5)::text;COMMIT;`)));
 const st=many.map(r=>JSON.parse(r.stdout.split("\n").find(l=>l.startsWith("@")).slice(1)).status).sort();
 assert.deepEqual(st,["no_credit","no_credit","reserved","reserved"]);
 assert.equal(credits(db2,A),2);
 // Concurrent double release refunds once.
 const rel=await Promise.all([R1,R1,R1].map(()=>psqlAsync(db,
  `BEGIN;SET LOCAL ROLE service_role;SELECT '@'||public.flow_ai_generation_release('${A}','${R1}');COMMIT;`)));
 assert.deepEqual(rel.map(r=>r.stdout.trim().slice(1)).sort(),["noop","noop","released"]);
 assert.equal(credits(db,A),12);
});

test("live: commit rejects a malformed document; the reservation stays releasable",{skip},()=>{
 const db=fresh();
 assert.equal(reserve(db,A,R1).status,"reserved");
 for(const d of [`'[]'::jsonb`,`'{"nodes":1,"edges":[]}'::jsonb`,`'{"nodes":[]}'::jsonb`,"NULL"]){
  const r=as(db,SR,`SELECT public.flow_ai_generation_commit('${A}','${R1}',${d});`);
  assert.equal(sqlState(r.stderr),"22023",d);
 }
 assert.equal(release(db,A,R1),"released");
 assert.equal(credits(db,A),12);
});

/** supabase-js-shaped rpc client over psql as service_role (named arguments). */
const lit=v=>v===null||v===undefined?"NULL":typeof v==="number"?String(v):typeof v==="object"?J(v):`'${String(v).replace(/'/g,"''")}'`;
const pgRpc=db=>({rpc:async(fn,args)=>{
 const named=Object.entries(args).map(([k,v])=>`${k} => ${lit(v)}`).join(", ");
 const r=as(db,SR,`SELECT '@'||coalesce(to_jsonb(public.${fn}(${named}))::text,'null');`);
 if(r.status!==0)return {data:null,error:{code:sqlState(r.stderr)??"unknown"}};
 return {data:JSON.parse(r.stdout.split("\n").find(l=>l.startsWith("@")).slice(1)),error:null};
}});
const GOOD={nodes:[{id:"t",type:"trigger",data:{channel:"instagram"}},{id:"m",type:"message",data:{text:"أهلاً"}},{id:"e",type:"end"}],
 edges:[{source:"t",target:"m"},{source:"m",target:"e"}]};
function deps(db,llm){
 const calls={llm:0};
 return {calls,deps:{
  env:k=>k==="FLOW_AI_BUILDER_ENABLED"?"true":"",
  authUser:async()=>({id:UA}),tenantForUser:async()=>({id:A}),
  limiter:{hit:async()=>({allowed:true,retryAfter:1,source:"db"})},
  credits:supabaseCreditPort(pgRpc(db)),
  llm:async()=>{calls.llm++;return llm();},log:()=>{}}};
}
const post=(d,request_id=R1,prompt="رحب بالعميل")=>handleGenerateFlow(new Request("https://x/functions/v1/generate-flow",{method:"POST",
 headers:{origin:APPROVED_ORIGIN,authorization:"Bearer valid-jwt-token-abcdef","content-type":"application/json"},
 body:JSON.stringify({prompt,tenant_id:A,request_id})}),d).then(async r=>({status:r.status,json:await r.json()}));

test("live: generate-flow handler against the real SQL (charge once, cache, refunds, retry)",{skip},async()=>{
 const db=fresh();
 const ok1=deps(db,async()=>JSON.stringify(GOOD));
 const a=await post(ok1.deps);
 assert.equal(a.status,200);assert.equal(a.json.cached,false);assert.equal(a.json.credits_charged,5);
 assert.equal(credits(db,A),7);
 const b=await post(ok1.deps);
 assert.equal(b.status,200);assert.equal(b.json.cached,true);assert.deepEqual(b.json.document,a.json.document);
 assert.equal(ok1.calls.llm,1);assert.equal(credits(db,A),7);
 const mm=await post(ok1.deps,R1,"وصف مختلف");
 assert.equal(mm.status,422);assert.equal(mm.json.error,"invalid_request");
 // LLM failure -> refund; validation failure -> refund; retry same request_id succeeds.
 const boom=deps(db,async()=>{throw new Error("down");});
 const f=await post(boom.deps,R2);
 assert.equal(f.status,502);assert.equal(f.json.message,"حدث خطأ في الاتصال بالذكاء الاصطناعي، تم استرداد الرصيد");
 assert.equal(credits(db,A),7);
 const junk=deps(db,async()=>"not json");
 const v=await post(junk.deps,R2);
 assert.equal(v.status,422);assert.equal(v.json.message,"فشل توليد التدفق، تم استرداد الرصيد");
 assert.equal(credits(db,A),7);
 const retry=await post(ok1.deps,R2);
 assert.equal(retry.status,200);assert.equal(retry.json.cached,false);
 assert.equal(credits(db,A),2);
 assert.deepEqual([row(db,A,R2).charges,row(db,A,R2).refunds],[3,2]);
 // Insufficient: 2 credits left -> 402, no LLM call.
 const poor=deps(db,async()=>JSON.stringify(GOOD));
 const p=await post(poor.deps,R3);
 assert.equal(p.status,402);assert.equal(p.json.message,"رصيدك غير كافٍ لتوليد التدفق بالذكاء الاصطناعي");
 assert.equal(poor.calls.llm,0);assert.equal(credits(db,A),2);assert.equal(row(db,A,R3),null);
});

test("live: rollback guards (reserved credits, data), clean rollback restores the base schema, re-apply works",{skip},()=>{
 const db=fresh();
 assert.equal(reserve(db,A,R1).status,"reserved");
 let r=psql(db,{file:RB});
 assert.notEqual(r.status,0);assert.match(r.stderr,/holds reserved credits/);
 assert.equal(release(db,A,R1),"released");
 r=psql(db,{file:RB});
 assert.notEqual(r.status,0);assert.match(r.stderr,/holds rows; set milan\.rollback_310000/);
 const base=fresh("base");
 assert.notEqual(val(db,SNAP),val(base,SNAP));
 ok(db,{file:RB,env:{PGOPTIONS:"-c milan.rollback_310000=discard-flow-ai-generations"}},"rollback with discard");
 assert.equal(val(db,SNAP),val(base,SNAP),"schema identical to before 310000");
 r=psql(db,{file:RB});
 assert.notEqual(r.status,0);assert.match(r.stderr,/not installed; nothing to roll back/);
 ok(db,{file:MIG},"re-apply after rollback");
 // Empty table: plain rollback works without the discard setting.
 const db2=fresh();
 ok(db2,{file:RB},"rollback empty");
 assert.equal(val(db2,SNAP),val(base,SNAP));
 // Unmarked function makes the rollback refuse as a whole.
 const db3=fresh();
 ok(db3,{sql:`COMMENT ON FUNCTION public.flow_ai_generation_release(uuid,uuid) IS 'someone else';`},"unmark");
 r=psql(db3,{file:RB});
 assert.notEqual(r.status,0);assert.match(r.stderr,/without marker/);
 assert.equal(val(db3,`to_regclass('public.flow_ai_generations') IS NOT NULL`),"t");
});
