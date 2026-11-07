// S6 (20261029260000_match_knowledge_tenant_guard), S7
// (20261029270000_payments_owner_read_only), S8
// (20261029280000_widget_credit_reservations + milan-api widgetBilling.ts
// driven against the real SQL) and S9 (20261029290000_wa_bindings_verification).
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards), like the other security / flow
// SQL suites. pgvector is NOT installed here, so the fixture uses a faithful
// stub: DOMAIN public.vector over double precision[] plus a cosine-distance
// OPERATOR public.<=> (same names, schema and operator the migration
// resolves from the catalog). Privileges / guards are ALSO asserted directly.
// Fixture: roles anon / authenticated / service_role (BYPASSRLS), auth.uid()
// from request.jwt.claim.sub, supabase/schema.sql VERBATIM (extensions
// swapped for pgcrypto + the vector stub), record_ai_usage /
// increment_widget_responses VERBATIM from the widget SQL files, and
// Supabase's default grants (ALL tables / EXECUTE functions to anon,
// authenticated, service_role). Never connects to any remote host.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync,writeFileSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {widgetBillingEnabled,reserveWidgetAnswer,commitWidgetAnswer,releaseWidgetAnswer,widgetBillingEarlyReply}
 from "../supabase/functions/milan-api/widgetBilling.ts";

const MK="supabase/migrations/20261029260000_match_knowledge_tenant_guard.sql";
const MK_RB="supabase/rollbacks/20261029260000_match_knowledge_tenant_guard.rollback.sql";
const PAY="supabase/migrations/20261029270000_payments_owner_read_only.sql";
const PAY_RB="supabase/rollbacks/20261029270000_payments_owner_read_only.rollback.sql";
const WB="supabase/migrations/20261029280000_widget_credit_reservations.sql";
const WB_RB="supabase/rollbacks/20261029280000_widget_credit_reservations.rollback.sql";
const WA="supabase/migrations/20261029290000_wa_bindings_verification.sql";
const WA_RB="supabase/rollbacks/20261029290000_wa_bindings_verification.rollback.sql";
const S2="supabase/migrations/20261029240000_tenants_billing_rls.sql";
const NEW=["20261029260000","20261029270000","20261029280000","20261029290000"];
const src=f=>readFileSync(f,"utf8");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");

// ---------------------------------------------------------------- static
test("260000..290000: newest migrations, one bounded transaction each, rollbacks exist",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 for(const s of NEW)assert.equal(stamps.filter(x=>x===s).length,1,s);
 for(const s of stamps)if(!NEW.includes(s))assert.ok(s<="20261029250000",s);
 for(const f of [MK,MK_RB,PAY,PAY_RB,WB,WB_RB,WA,WA_RB]){
  const s=src(f),code=noComments(s);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
  assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1,f);
  assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.doesNotMatch(code,/^\s*TRUNCATE\b|CONCURRENTLY|cron\.|vault\.|net\.http_|sb_secret_|eyJ[A-Za-z0-9_-]{30,}/im,f);
 }
 for(const f of [MK,PAY,WB,WA]){
  const code=noComments(src(f));
  assert.doesNotMatch(code,/GRANT[^;]*\bTO\s+(anon|authenticated|PUBLIC)\b/i,`${f}: nothing granted to client roles`);
  assert.doesNotMatch(code,/SECURITY\s+DEFINER/i,`${f}: no SECURITY DEFINER`);
 }
 const mk=noComments(src(MK));
 assert.match(mk,/LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''/);
 assert.match(mk,/current_user = 'service_role'/);
 assert.match(mk,/t\.user_id = auth\.uid\(\)/);
 assert.equal((noComments(src(WB)).match(/SECURITY INVOKER\nSET search_path = ''/g)??[]).length,3);
 assert.match(src(WA),/^--   UPDATE public\.wa_bindings$/m,"operator approval SQL documented in the header");
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
function denied(db,role,stmt,sub,label){
 const r=as(db,role,stmt,sub);
 assert.notEqual(r.status,0,`${label} must be denied`);
 assert.equal(sqlState(r.stderr),"42501",`${label}: ${r.stderr}`);
}
function allowed(db,role,stmt,sub,label){
 const r=as(db,role,stmt,sub);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return r.stdout.trim();
}
const val=(db,q)=>ok(db,{sql:`SELECT (${q});`},q);
let dbn=0;
const fresh=(template="base")=>{const d=`d${++dbn}`;ok("postgres",{sql:`CREATE DATABASE ${d} TEMPLATE ${template};`},d);return d;};

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UA="11111111-1111-4111-8111-111111111111",UB="22222222-2222-4222-8222-222222222222";
const Q="'{1,0}'::public.vector";
const MATCH=(t,lim=6)=>`SELECT count(*) FROM public.match_knowledge('${t}',${Q},${lim},0);`;

const VECTOR_STUB=`-- pgvector stub (extension unavailable in this sandbox)
CREATE DOMAIN public.vector AS double precision[];
CREATE FUNCTION public.vector_cosine_distance_stub(a public.vector, b public.vector) RETURNS double precision
 LANGUAGE sql IMMUTABLE AS $c$
 SELECT 1 - (SELECT sum(x*y) FROM unnest(a::float8[], b::float8[]) u(x,y))
          / (sqrt((SELECT sum(x*x) FROM unnest(a::float8[]) x)) * sqrt((SELECT sum(y*y) FROM unnest(b::float8[]) y))) $c$;
CREATE OPERATOR public.<=> (LEFTARG = public.vector, RIGHTARG = public.vector, FUNCTION = public.vector_cosine_distance_stub);
`;
function fixture(){
 const schema=src("supabase/schema.sql");
 assert.ok(schema.includes("create extension if not exists vector;\n"));
 const p2=src("supabase/widgets_phase2_migration.sql"),quota=src("supabase/widgets_quota_migration.sql");
 const cut=(s,start,end)=>{const a=s.indexOf(start);assert.ok(a>=0,start);return s.slice(a,s.indexOf(end,a)+end.length);};
 return `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
 AS $u$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $u$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
${schema.replace("create extension if not exists vector;\n",VECTOR_STUB)}
CREATE TABLE public.widgets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE, responses_used integer NOT NULL DEFAULT 0);
${cut(p2,"CREATE TABLE IF NOT EXISTS public.ai_usage (","\n);\n")}
${cut(p2,"CREATE OR REPLACE FUNCTION public.record_ai_usage(","$$;\n")}
${cut(quota,"CREATE OR REPLACE FUNCTION public.increment_widget_responses(","$$;\n")}
-- Supabase default privileges.
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
INSERT INTO auth.users VALUES ('${UA}'),('${UB}');
INSERT INTO public.tenants(id,user_id,business_name,source_type,credits_remaining,is_active)
VALUES ('${A}','${UA}','A','manual',5,true),('${B}','${UB}','B','manual',3,true);
INSERT INTO public.knowledge_sources(id,tenant_id,kind,status) VALUES
 ('a0000000-0000-4000-8000-000000000001','${A}','text','indexed'),('b0000000-0000-4000-8000-000000000001','${B}','text','indexed');
INSERT INTO public.knowledge_chunks(tenant_id,source_id,content,embedding) VALUES
 ('${A}','a0000000-0000-4000-8000-000000000001','A price list','{1,0}'),
 ('${B}','b0000000-0000-4000-8000-000000000001','B secret supplier terms','{1,0}'),
 ('${B}','b0000000-0000-4000-8000-000000000001','B internal margin','{0.9,0.1}');
INSERT INTO public.payments(tenant_id,invoice_id,amount,status,credits_granted) VALUES
 ('${A}','inv-a',9900,'paid',100),('${B}','inv-b',4900,'paid',50);
INSERT INTO public.widgets(id,tenant_id) VALUES ('c0000000-0000-4000-8000-00000000000b','${B}');
INSERT INTO public.wa_bindings(phone_id,tenant_id) VALUES ('1000001','${A}');
`;
}
// Effective ACLs / policies / function definitions / wa_bindings columns.
const SNAP=`SELECT string_agg(x,E'\\n' ORDER BY x) FROM (
 SELECT 'r:'||c.relname||':'||(SELECT string_agg(i::text,',' ORDER BY i::text) FROM unnest(coalesce(c.relacl,acldefault('r',c.relowner))) i)||':'||c.relrowsecurity FROM pg_class c
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
 UNION ALL SELECT 'p:'||tablename||':'||policyname||':'||cmd||':'||roles::text||':'||coalesce(qual,'')||':'||coalesce(with_check,'')
  FROM pg_policies WHERE schemaname='public'
 UNION ALL SELECT 'f:'||p.oid::regprocedure||':'||p.prosecdef||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||md5(p.prosrc)||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||
   (SELECT string_agg(i::text,',' ORDER BY i::text) FROM unnest(coalesce(p.proacl,acldefault('f',p.proowner))) i) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'a:'||attname||':'||format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.wa_bindings'::regclass AND attnum>0 AND NOT attisdropped
 UNION ALL SELECT 'k:'||conname FROM pg_constraint WHERE conrelid='public.wa_bindings'::regclass
) s(x)`;

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"sec-iso-"));
 if(isRoot)chownSync(dir,Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout.trim()),
  Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout.trim()));
 port=20000+Math.floor(Math.random()*20000);
 const init=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(init.status,0,init.stderr);
 const st=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off -c max_connections=60`,"start"]);
 assert.equal(st.status,0,st.stderr);started=true;
 ok("postgres",{sql:"CREATE DATABASE base;"},"create base");
 const fx=join(dir,"fixture.sql");writeFileSync(fx,fixture());
 ok("base",{file:fx},"fixture");
});
after(()=>{
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 if(dir)rmSync(dir,{recursive:true,force:true});
});

test("OLD behaviour (schema.sql as is) is exploitable — proves the tests below detect it",{skip},()=>{
 const db=fresh();
 assert.equal(allowed(db,"anon",MATCH(B)),"2","anon reads tenant B's chunks via SECURITY DEFINER rpc");
 assert.equal(allowed(db,"authenticated",MATCH(B),UA),"2","owner A reads tenant B's chunks");
 assert.match(allowed(db,"authenticated",`INSERT INTO public.payments(tenant_id,invoice_id,amount,status,credits_granted) VALUES('${A}','forged',1,'paid',999999) RETURNING 1;`,UA),/1/);
 assert.match(allowed(db,"authenticated",`UPDATE public.payments SET credits_granted=1 WHERE tenant_id='${A}' RETURNING 1;`,UA),/1/);
 assert.match(allowed(db,"authenticated",`DELETE FROM public.payments WHERE tenant_id='${A}' RETURNING 1;`,UA),/1/);
 allowed(db,"anon",`SELECT public.record_ai_usage('${B}','site_analysis');`);
 allowed(db,"anon",`SELECT public.increment_widget_responses('c0000000-0000-4000-8000-00000000000b');`);
 assert.equal(val(db,`(SELECT count(*) FROM public.ai_usage WHERE tenant_id='${B}')`),"1");
});

test("knowledge_chunks / knowledge_sources RLS: no cross-tenant direct read (unchanged policies)",{skip},()=>{
 const db=fresh();
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.knowledge_chunks WHERE tenant_id='${B}';`,UA),"0");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.knowledge_chunks;`,UA),"1");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.knowledge_sources WHERE tenant_id='${B}';`,UA),"0");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.knowledge_sources;`,UB),"1");
 for(const t of ["knowledge_chunks","knowledge_sources"])
  assert.equal(allowed(db,"anon",`SELECT count(*) FROM public.${t};`),"0",`anon ${t}`);
 assert.equal(allowed(db,"authenticated",`UPDATE public.knowledge_chunks SET content='x' WHERE tenant_id='${B}' RETURNING 1;`,UA),"","no cross-tenant write");
 const r=as(db,"authenticated",`INSERT INTO public.knowledge_chunks(tenant_id,content) VALUES('${B}','planted');`,UA);
 assert.notEqual(r.status,0,"no cross-tenant insert");assert.equal(sqlState(r.stderr),"42501");
});

test("260000 match_knowledge: client roles denied, service_role works, guard limits to owner, idempotent, rollback restores",{skip},()=>{
 const db=fresh();
 const pre=val(db,SNAP);
 ok(db,{file:MK},"apply 260000");
 denied(db,"anon",MATCH(B),null,"anon rpc match_knowledge");
 denied(db,"authenticated",MATCH(B),UA,"owner A rpc match_knowledge for B");
 denied(db,"authenticated",MATCH(A),UA,"owner A rpc match_knowledge (EXECUTE is service_role only)");
 assert.equal(allowed(db,"service_role",MATCH(B)),"2","service role: tenant B");
 assert.equal(allowed(db,"service_role",MATCH(A)),"1","service role: tenant A");
 assert.equal(allowed(db,"service_role",`SELECT string_agg(content||':'||similarity,',' ORDER BY similarity DESC) FROM public.match_knowledge('${B}',${Q},1,0);`),
  "B secret supplier terms:1","same result shape, ordering and limit");
 assert.equal(allowed(db,"service_role",`SELECT count(*) FROM public.match_knowledge('${B}',${Q});`),"2","defaults kept");
 assert.equal(val(db,`(SELECT prosecdef::text||array_to_string(proconfig,',') FROM pg_proc WHERE proname='match_knowledge')`),'falsesearch_path=""');
 assert.equal(val(db,`pg_get_function_result('public.match_knowledge'::regproc)`),"TABLE(id uuid, content text, similarity real)");
 // In-function guard, asserted directly: even if EXECUTE were granted again.
 const g=fresh(db);
 ok(g,{sql:`GRANT EXECUTE ON FUNCTION public.match_knowledge(uuid,public.vector,integer,real) TO anon, authenticated;`},"re-grant");
 assert.equal(allowed(g,"authenticated",MATCH(A),UA),"1","owner reads own tenant through the guard");
 assert.equal(allowed(g,"authenticated",MATCH(B),UA),"0","owner A gets NOTHING for tenant B");
 assert.equal(allowed(g,"authenticated",MATCH(B)),"0","authenticated without uid: nothing");
 assert.equal(allowed(g,"anon",MATCH(A)),"0","anon: nothing");
 ok(g,{sql:`ALTER ROLE authenticated BYPASSRLS;`},"rls bypass to isolate the in-function guard");
 assert.equal(allowed(g,"authenticated",MATCH(B),UA),"0","guard alone blocks cross-tenant even without RLS");
 ok(g,{sql:`ALTER ROLE authenticated NOBYPASSRLS;`},"restore");
 // idempotent
 const post=val(db,SNAP);
 ok(db,{file:MK},"re-apply 260000");
 assert.equal(val(db,SNAP),post,"re-run is a no-op");
 assert.match(val(db,`obj_description('public.match_knowledge'::regproc,'pg_proc')`),
  /^CREATED_BY_20261029260000_MATCH_KNOWLEDGE_TENANT_GUARD\|exec\.public=X;exec\.anon=X;exec\.authenticated=X;exec\.service_role=X;$/);
 // rollback restores exact body / attributes / grants (twice: idempotent)
 ok(db,{file:MK_RB},"rollback 260000");
 assert.equal(val(db,SNAP),pre,"rollback restores previous definition and grants");
 ok(db,{file:MK_RB},"rollback again (no-op)");
 assert.equal(val(db,SNAP),pre);
 assert.equal(allowed(db,"anon",MATCH(B)),"2","old (vulnerable) behaviour restored");
});

test("260000 refuses unexpected match_knowledge definitions without any change",{skip},()=>{
 const legacy=`CREATE OR REPLACE FUNCTION public.match_knowledge(p_tenant_id uuid,p_query public.vector,p_limit integer default 6,p_threshold real default 0.25)
 RETURNS TABLE(id uuid,content text,similarity real) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$`;
 for(const [label,sql,re] of [
  ["double precision variant",`DROP FUNCTION public.match_knowledge(uuid,public.vector,integer,real);
    CREATE FUNCTION public.match_knowledge(p_tenant_id uuid,p_query public.vector,p_limit integer default 6,p_threshold double precision default 0.25)
    RETURNS TABLE(id uuid,content text,similarity double precision) LANGUAGE sql STABLE SET search_path = public, pg_temp
    AS $$ SELECT kc.id,kc.content,1-(kc.embedding <=> p_query) FROM public.knowledge_chunks kc WHERE kc.tenant_id=p_tenant_id LIMIT p_limit $$;`,/unexpected signature/],
  ["altered body",`${legacy} select kc.id, kc.content, 1::real from public.knowledge_chunks kc limit p_limit; $$;`,/differs from the schema\.sql definition/],
  ["invoker already",`ALTER FUNCTION public.match_knowledge(uuid,public.vector,integer,real) SECURITY INVOKER;`,/differs from the schema\.sql definition/],
  ["second overload",`CREATE FUNCTION public.match_knowledge(p uuid) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;`,/exactly one public\.match_knowledge, found 2/],
  ["foreign comment",`COMMENT ON FUNCTION public.match_knowledge(uuid,public.vector,integer,real) IS 'hand made';`,/unexpected comment/]]){
  const db=fresh();
  ok(db,{sql},label);
  const b=val(db,SNAP);
  const r=psql(db,{file:MK});
  assert.notEqual(r.status,0,label);assert.match(r.stderr,re,label);
  assert.equal(val(db,SNAP),b,`${label}: unchanged`);
 }
});

test("270000 payments: owner SELECT own rows only, client writes denied, service_role writes, usage RPCs locked, rollback",{skip},()=>{
 const db=fresh();
 const pre=val(db,SNAP);
 ok(db,{file:PAY},"apply 270000");
 assert.equal(allowed(db,"authenticated",`SELECT string_agg(invoice_id,',') FROM public.payments;`,UA),"inv-a","owner A reads only A");
 assert.equal(allowed(db,"authenticated",`SELECT string_agg(invoice_id,',') FROM public.payments;`,UB),"inv-b","owner B reads only B");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.payments;`),"0","authenticated without uid: nothing");
 assert.equal(allowed(db,"anon",`SELECT count(*) FROM public.payments;`),"0","anon: nothing");
 for(const [role,sub] of [["authenticated",UA],["anon",null]]){
  denied(db,role,`INSERT INTO public.payments(tenant_id,invoice_id,amount,status,credits_granted) VALUES('${A}','forged',1,'paid',999999);`,sub,`${role} INSERT`);
  denied(db,role,`UPDATE public.payments SET credits_granted=999999 WHERE tenant_id='${A}';`,sub,`${role} UPDATE`);
  denied(db,role,`DELETE FROM public.payments WHERE tenant_id='${A}';`,sub,`${role} DELETE`);
  denied(db,role,`TRUNCATE public.payments;`,sub,`${role} TRUNCATE`);
  denied(db,role,`SELECT public.record_ai_usage('${B}','site_analysis');`,sub,`${role} record_ai_usage`);
  denied(db,role,`SELECT public.increment_widget_responses('c0000000-0000-4000-8000-00000000000b');`,sub,`${role} increment_widget_responses`);
 }
 allowed(db,"service_role",`INSERT INTO public.payments(tenant_id,invoice_id,amount) VALUES('${A}','srv',100);`);
 allowed(db,"service_role",`UPDATE public.payments SET status='paid',credits_granted=10 WHERE invoice_id='srv';`);
 allowed(db,"service_role",`DELETE FROM public.payments WHERE invoice_id='srv';`);
 allowed(db,"service_role",`SELECT public.record_ai_usage('${A}','site_analysis');`);
 assert.equal(allowed(db,"service_role",`SELECT public.increment_widget_responses('c0000000-0000-4000-8000-00000000000b');`),"1");
 assert.equal(allowed(db,"service_role",`SELECT count(*) FROM public.payments;`),"2");
 assert.equal(val(db,`array_to_string(ARRAY(SELECT policyname||':'||cmd||':'||roles::text FROM pg_policies WHERE tablename='payments'),',')`),
  "payments_owner_select:SELECT:{authenticated}");
 const post=val(db,SNAP);
 ok(db,{file:PAY},"re-apply 270000");
 assert.equal(val(db,SNAP),post,"re-run is a no-op");
 assert.match(val(db,`obj_description((SELECT oid FROM pg_policy WHERE polname='payments_owner_select'),'pg_policy')`),
  /^CREATED_BY_20261029270000_PAYMENTS_OWNER_READ_ONLY\|legacy=owner,;payments\.public=;payments\.anon=SIUDT;payments\.authenticated=SIUDT;payments\.service_role=SIUDT;record_ai_usage\.public=X;record_ai_usage\.anon=X;/);
 ok(db,{file:PAY_RB},"rollback 270000");
 assert.equal(val(db,SNAP),pre,"rollback restores previous grants/policies");
 ok(db,{file:PAY_RB},"rollback again (no-op)");
 assert.equal(val(db,SNAP),pre);
 assert.match(allowed(db,"authenticated",`UPDATE public.payments SET credits_granted=7 WHERE tenant_id='${A}' RETURNING 1;`,UA),/1/,"old behaviour restored");
});

test("270000 refuses unexpected payments policies without any change",{skip},()=>{
 for(const [label,sql,re] of [
  ["extra policy",`CREATE POLICY payments_public ON public.payments FOR SELECT USING (true);`,/unexpected policy payments_public/],
  ["altered owner policy",`DROP POLICY payments_owner ON public.payments; CREATE POLICY payments_owner ON public.payments FOR ALL USING (true);`,/payments_owner has an unexpected definition/],
  ["unmarked new name",`CREATE POLICY payments_owner_select ON public.payments FOR SELECT USING (true);`,/without marker/],
  ["RLS disabled",`ALTER TABLE public.payments DISABLE ROW LEVEL SECURITY;`,/not enabled on public\.payments/]]){
  const db=fresh();
  ok(db,{sql},label);
  const b=val(db,SNAP);
  const r=psql(db,{file:PAY});
  assert.notEqual(r.status,0,label);assert.match(r.stderr,re,label);
  assert.equal(val(db,SNAP),b,`${label}: unchanged`);
 }
});

// ---------------------------------------------------------------- S8 widget billing (module + real SQL)
const KEY_RE=/^w1:[0-9a-f]{64}$/;
function sqlRpc(db){
 const calls=[];
 return {calls,rpc:async(fn,a)=>{
  calls.push(fn);
  const q=v=>v===null||v===undefined?"NULL":`'${String(v).replace(/'/g,"''")}'`;
  const stmt=fn==="widget_credit_reserve"?`SELECT public.widget_credit_reserve(${q(a.p_tenant_id)},${q(a.p_session_id)},${q(a.p_key)},${Number(a.p_replay_seconds)})::text;`
   :fn==="widget_credit_commit"?`SELECT public.widget_credit_commit(${q(a.p_tenant_id)},${q(a.p_key)},${q(a.p_answer_message_id)});`
   :fn==="widget_credit_release"?`SELECT public.widget_credit_release(${q(a.p_tenant_id)},${q(a.p_key)});`:null;
  if(!stmt)return {data:null,error:{code:"PGRST202"}};
  const r=await psqlAsync(db,asSql("service_role",stmt));
  if(r.status!==0)return {data:null,error:{code:sqlState(r.stderr)??"XX000"}};
  const out=r.stdout.trim();
  return {data:fn==="widget_credit_reserve"?JSON.parse(out):out,error:null};
 }};
}
function messagesStore(){
 const rows=[];
 const from=table=>{
  assert.equal(table,"widget_messages");
  const f={};
  const b={select:()=>b,eq:(k,v)=>{f[k]=v;return b;},
   maybeSingle:async()=>({data:rows.find(r=>Object.entries(f).every(([k,v])=>r[k]===v))??null,error:null}),
   insert:async row=>{rows.push({id:randomUUID(),...row});return {error:null};}};
  return b;
 };
 return {rows,from};
}
/** The widget_message billing sequence of milan-api index.ts (after the S3 gates). */
async function widgetTurn(db,rpc,store,{tenantId,sessionId,message,flag,llm}){
 const t=val(db,`(SELECT credits_remaining||','||is_active FROM public.tenants WHERE id='${tenantId}')`).split(",");
 if(t[1]!=="true"||Number(t[0])<=0)return {kind:"error",reason:"precheck"};
 const ids={tenantId,widgetId:"w",sessionId};
 const bill=await reserveWidgetAnswer(rpc,{enabled:widgetBillingEnabled(flag),tenantId,sessionId,message});
 const early=await widgetBillingEarlyReply(store,bill,ids);
 if(early)return early;
 let answer;
 try{answer=await llm();}catch{await releaseWidgetAnswer(rpc,tenantId,bill);return {kind:"error",reason:"llm"};}
 if(!answer){await releaseWidgetAnswer(rpc,tenantId,bill);return {kind:"refusal"};}
 await store.from("widget_messages").insert({session_id:sessionId,widget_id:"w",tenant_id:tenantId,direction:"out",body:answer,kind:"answer"});
 const saved=store.rows[store.rows.length-1];
 const billingStatus=await commitWidgetAnswer(rpc,tenantId,bill,saved.id);
 return {kind:"answer",reply:answer,billingStatus};
}
const credits=(db,t)=>Number(val(db,`(SELECT credits_remaining FROM public.tenants WHERE id='${t}')`));

test("280000 + widgetBilling.ts: 0 credits blocked before LLM, 1 credit = one answer, idempotent, refund on failure, kill switch",{skip},async()=>{
 const db=fresh();
 ok(db,{file:WB},"apply 280000");
 ok(db,{file:WB},"re-apply 280000 (idempotent)");
 const rpc=sqlRpc(db),store=messagesStore();
 let llmCalls=0;
 const llm=async()=>{llmCalls++;return "answer "+llmCalls;};
 const S1=randomUUID(),S2=randomUUID();
 // 1 credit -> exactly one answer, then blocked (flag UNSET = billing ON)
 ok(db,{sql:`UPDATE public.tenants SET credits_remaining=1 WHERE id='${A}';`},"credits 1");
 const first=await widgetTurn(db,rpc,store,{tenantId:A,sessionId:S1,message:"q1",flag:undefined,llm});
 assert.equal(first.kind,"answer");assert.equal(first.billingStatus,"charged");
 assert.equal(credits(db,A),0);
 const second=await widgetTurn(db,rpc,store,{tenantId:A,sessionId:S1,message:"q2",flag:undefined,llm});
 assert.equal(second.kind,"error");assert.equal(llmCalls,1,"second question never reaches the LLM");
 // the atomic reserve blocks even when the pre-check snapshot is stale
 const stale=await reserveWidgetAnswer(rpc,{enabled:true,tenantId:A,sessionId:S1,message:"q3"});
 assert.deepEqual(stale,{kind:"no_credit"});
 const refusal=await widgetBillingEarlyReply(store,stale,{tenantId:A,widgetId:"w",sessionId:S1});
 assert.equal(refusal.kind,"error");assert.equal(store.rows.at(-1).kind,"error","refusal row stored like the existing path");
 // inactive tenant with credits -> no_credit, no debit
 ok(db,{sql:`UPDATE public.tenants SET credits_remaining=4,is_active=false WHERE id='${A}';`},"inactive");
 assert.deepEqual(await reserveWidgetAnswer(rpc,{enabled:true,tenantId:A,sessionId:S1,message:"q4"}),{kind:"no_credit"});
 assert.equal(credits(db,A),4);
 ok(db,{sql:`UPDATE public.tenants SET credits_remaining=3,is_active=true WHERE id='${A}';`},"active 3");
 // double submit (same session + text): sequential retry replays the saved answer, charged once
 const d1=await widgetTurn(db,rpc,store,{tenantId:A,sessionId:S2,message:"same",flag:"true",llm});
 const d2=await widgetTurn(db,rpc,store,{tenantId:A,sessionId:S2,message:"same",flag:"true",llm});
 assert.equal(d1.kind,"answer");assert.deepEqual(d2,{reply:d1.reply,kind:"answer"},"retry replays without LLM / charge");
 assert.equal(credits(db,A),2);
 // concurrent double submit: one LLM call and one charge
 const before=llmCalls;
 const slow=async()=>{llmCalls++;await new Promise(r=>setTimeout(r,300));return "slow";};
 const S3=randomUUID();
 const [c1,c2]=await Promise.all([1,2].map(()=>widgetTurn(db,rpc,store,{tenantId:A,sessionId:S3,message:"x",flag:"",llm:slow})));
 assert.equal(llmCalls-before,1,"exactly one LLM call");
 assert.deepEqual([c1.kind,c2.kind].sort(),["answer","error"]);
 assert.equal(credits(db,A),1,"charged once");
 // LLM failure / refusal: credit given back, nothing charged
 const boom=async()=>{throw new Error("provider down");};
 assert.equal((await widgetTurn(db,rpc,store,{tenantId:A,sessionId:S1,message:"fails",flag:undefined,llm:boom})).kind,"error");
 assert.equal(credits(db,A),1,"LLM failure leaves no charge");
 assert.equal((await widgetTurn(db,rpc,store,{tenantId:A,sessionId:S1,message:"unknown",flag:undefined,llm:async()=>null})).kind,"refusal");
 assert.equal(credits(db,A),1,"no answer leaves no charge");
 // the released key can be retried and is charged once on success
 assert.equal((await widgetTurn(db,rpc,store,{tenantId:A,sessionId:S1,message:"fails",flag:undefined,llm})).kind,"answer");
 assert.equal(credits(db,A),0);
 assert.equal(val(db,`(SELECT charges||'/'||refunds||'/'||status FROM public.widget_credit_reservations WHERE status='committed' AND charges=2)`),"2/1/committed");
 // kill switch: WIDGET_BILLING_V2_ENABLED=false -> legacy path, no RPC, no charge
 ok(db,{sql:`UPDATE public.tenants SET credits_remaining=1 WHERE id='${A}';`},"credits 1");
 const n=rpc.calls.length;
 for(const q of ["k1","k2","k3"])
  assert.equal((await widgetTurn(db,rpc,store,{tenantId:A,sessionId:S1,message:q,flag:"false",llm})).billingStatus,"deferred");
 assert.equal(rpc.calls.length,n,"no billing RPC under the kill switch");
 assert.equal(credits(db,A),1);
 // no reservation table content is customer text
 assert.equal(val(db,`(SELECT bool_and(idem_key ~ '^w1:[0-9a-f]{64}$') FROM public.widget_credit_reservations)`),"t");
 // fail closed when the SQL is missing (code deployed before the migration)
 const nodb=fresh();
 assert.deepEqual(await reserveWidgetAnswer(sqlRpc(nodb),{enabled:true,tenantId:A,sessionId:S1,message:"q"}),{kind:"unavailable"});
});

test("280000 SQL: atomic under concurrency, tenant-scoped, service_role only, rollback data guard",{skip},async()=>{
 const db=fresh();
 ok(db,{file:WB},"apply 280000");
 const key=i=>"w1:"+String(i).padStart(64,"0");
 const S=randomUUID();
 ok(db,{sql:`UPDATE public.tenants SET credits_remaining=5 WHERE id='${A}';`},"5 credits");
 const outs=await Promise.all(Array.from({length:20},(_,i)=>psqlAsync(db,asSql("service_role",
  `SELECT public.widget_credit_reserve('${A}','${S}','${key(i)}',120)->>'status';`))));
 assert.ok(outs.every(o=>o.status===0),outs.map(o=>o.stderr).join(""));
 assert.equal(outs.filter(o=>o.stdout.trim()==="reserved").length,5,"exactly the available credits");
 assert.equal(outs.filter(o=>o.stdout.trim()==="no_credit").length,15);
 assert.equal(credits(db,A),0);
 ok(db,{sql:`UPDATE public.tenants SET credits_remaining=5 WHERE id='${B}';`},"B 5");
 const same=await Promise.all(Array.from({length:12},()=>psqlAsync(db,asSql("service_role",
  `SELECT public.widget_credit_reserve('${B}','${S}','${key(99)}',120)->>'status';`))));
 assert.equal(same.filter(o=>o.stdout.trim()==="reserved").length,1,"same key: one debit");
 assert.equal(same.filter(o=>o.stdout.trim()==="in_flight").length,11);
 assert.equal(credits(db,B),4);
 // tenant-scoped: the same key for another tenant / another session never touches B's row
 assert.equal(allowed(db,"service_role",`SELECT public.widget_credit_release('${A}','${key(99)}');`),"noop");
 assert.equal(allowed(db,"service_role",`SELECT public.widget_credit_reserve('${B}','${randomUUID()}','${key(99)}',120)->>'status';`),"invalid");
 assert.equal(allowed(db,"service_role",`SELECT public.widget_credit_commit('${B}','${key(99)}','${randomUUID()}');`),"committed");
 assert.equal(allowed(db,"service_role",`SELECT public.widget_credit_release('${B}','${key(99)}');`),"noop","committed is never refunded");
 assert.equal(credits(db,B),4);
 // stale reservation (worker died mid-LLM) is resumed without a second debit
 allowed(db,"service_role",`SELECT public.widget_credit_reserve('${B}','${S}','${key(98)}',120);`);
 ok(db,{sql:`UPDATE public.widget_credit_reservations SET reserved_at=now()-interval '10 minutes' WHERE idem_key='${key(98)}';`},"age");
 assert.equal(allowed(db,"service_role",`SELECT public.widget_credit_reserve('${B}','${S}','${key(98)}',120)->>'status';`),"resumed");
 assert.equal(credits(db,B),3);
 const bad=as(db,"service_role",`SELECT public.widget_credit_reserve('${B}','${S}','not-a-key',120);`);
 assert.equal(sqlState(bad.stderr),"22023");
 for(const role of ["anon","authenticated"]){
  denied(db,role,`SELECT public.widget_credit_reserve('${A}','${S}','${key(1)}',120);`,UA,`${role} reserve`);
  denied(db,role,`SELECT public.widget_credit_release('${A}','${key(1)}');`,UA,`${role} release`);
  denied(db,role,`SELECT public.widget_credit_commit('${A}','${key(1)}',NULL);`,UA,`${role} commit`);
  denied(db,role,`SELECT * FROM public.widget_credit_reservations;`,UA,`${role} select`);
 }
 assert.equal(val(db,`(SELECT string_agg(DISTINCT prosecdef::text||array_to_string(proconfig,','),'') FROM pg_proc WHERE proname LIKE 'widget_credit_%')`),'falsesearch_path=""');
 // rollback refuses while reservations exist, unless explicitly discarded
 const r=psql(db,{file:WB_RB});
 assert.notEqual(r.status,0);assert.match(r.stderr,/holds rows/);
 ok(db,{file:WB_RB,env:{PGOPTIONS:"-c milan.rollback_280000=discard-widget-reservations"}},"rollback 280000");
 assert.equal(val(db,`to_regclass('public.widget_credit_reservations') IS NULL AND to_regprocedure('public.widget_credit_reserve(uuid,uuid,text,integer)') IS NULL`),"t");
 ok(db,{file:WB_RB},"rollback again (no-op)");
 // unmarked object of the same name is refused
 const u=fresh();
 ok(u,{sql:`CREATE TABLE public.widget_credit_reservations(x int);`},"squat");
 const ur=psql(u,{file:WB});
 assert.notEqual(ur.status,0);assert.match(ur.stderr,/without marker/);
});

// ---------------------------------------------------------------- S9 wa_bindings verification
test("290000: refuses before 240000; grandfathers existing rows; new rows unverified; clients cannot flip; rollback",{skip},()=>{
 const db=fresh();
 const r0=psql(db,{file:WA});
 assert.notEqual(r0.status,0);assert.match(r0.stderr,/apply 20261029240000_tenants_billing_rls first/);
 ok(db,{file:S2},"apply 240000");
 const pre=val(db,SNAP);
 ok(db,{file:WA},"apply 290000");
 assert.equal(val(db,`(SELECT is_verified||'/'||verified_by||'/'||(verified_at IS NOT NULL) FROM public.wa_bindings WHERE phone_id='1000001')`),
  "true/migration-grandfathered/true","existing binding grandfathered");
 // bind_number's statement (supabase-js upsert ignoreDuplicates) creates an UNVERIFIED row
 allowed(db,"service_role",`INSERT INTO public.wa_bindings(phone_id,tenant_id) VALUES('2000002','${B}') ON CONFLICT(phone_id) DO NOTHING;`);
 assert.equal(val(db,`(SELECT is_verified||'/'||coalesce(verified_by,'-') FROM public.wa_bindings WHERE phone_id='2000002')`),"false/-");
 // idempotent same-tenant re-bind never flips the flag (either way)
 for(const [p,t,exp] of [["2000002",B,"false"],["1000001",A,"true"]]){
  allowed(db,"service_role",`INSERT INTO public.wa_bindings(phone_id,tenant_id) VALUES('${p}','${t}') ON CONFLICT(phone_id) DO NOTHING;`);
  assert.equal(val(db,`(SELECT is_verified::text FROM public.wa_bindings WHERE phone_id='${p}')`),exp,`re-bind ${p}`);
 }
 // re-run never verifies newer bindings
 ok(db,{file:WA},"re-apply 290000");
 assert.equal(val(db,`(SELECT is_verified::text FROM public.wa_bindings WHERE phone_id='2000002')`),"false");
 // client roles cannot flip it
 denied(db,"authenticated",`UPDATE public.wa_bindings SET is_verified=true WHERE phone_id='2000002';`,UB,"owner flips is_verified");
 denied(db,"anon",`UPDATE public.wa_bindings SET is_verified=true;`,null,"anon flips is_verified");
 denied(db,"authenticated",`INSERT INTO public.wa_bindings(phone_id,tenant_id,is_verified,verified_by) VALUES('3000003','${B}',true,'me');`,UB,"owner inserts verified");
 // operator approval (service role) needs verified_by
 const nb=as(db,"service_role",`UPDATE public.wa_bindings SET is_verified=true WHERE phone_id='2000002';`);
 assert.equal(sqlState(nb.stderr),"23514","verified_by required");
 allowed(db,"service_role",`UPDATE public.wa_bindings SET is_verified=true,verified_at=now(),verified_by='ops:T-1' WHERE phone_id='2000002' AND tenant_id='${B}' AND NOT is_verified;`);
 assert.equal(val(db,`(SELECT is_verified::text FROM public.wa_bindings WHERE phone_id='2000002')`),"true");
 // rollback restores the previous columns exactly (twice: idempotent)
 ok(db,{file:WA_RB},"rollback 290000");
 assert.equal(val(db,SNAP),pre,"rollback restores previous wa_bindings definition");
 ok(db,{file:WA_RB},"rollback again (no-op)");
 // unmarked column is refused
 const u=fresh(db);
 ok(u,{sql:`ALTER TABLE public.wa_bindings ADD COLUMN is_verified boolean NOT NULL DEFAULT true;`},"hand-made column");
 const ur=psql(u,{file:WA});
 assert.notEqual(ur.status,0);assert.match(ur.stderr,/exists without marker/);
});
