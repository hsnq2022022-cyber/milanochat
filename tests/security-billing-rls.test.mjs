// S2 (20261029240000_tenants_billing_rls) and the S3 rate-limit store
// (20261029250000_milan_rate_limits).
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards), like the flow-* SQL suites.
// Fixture: roles anon / authenticated / service_role (BYPASSRLS), auth.uid()
// from request.jwt.claim.sub, the tenants + wa_bindings definitions, the
// tenants RLS statements and grant_credits copied VERBATIM from
// supabase/schema.sql, a channel_accounts table with an owner FOR ALL policy,
// and Supabase's default table grants (ALL to anon/authenticated/service_role).
// Never connects to any remote host; inherited PG* variables are stripped.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync,writeFileSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";

const MIG="supabase/migrations/20261029240000_tenants_billing_rls.sql";
const RB="supabase/rollbacks/20261029240000_tenants_billing_rls.rollback.sql";
const RL="supabase/migrations/20261029250000_milan_rate_limits.sql";
const RL_RB="supabase/rollbacks/20261029250000_milan_rate_limits.rollback.sql";
const src=f=>readFileSync(f,"utf8");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");

// ---------------------------------------------------------------- static
test("240000/250000: newest migrations, one bounded transaction each, rollbacks exist",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 for(const s of ["20261029240000","20261029250000"])assert.equal(stamps.filter(x=>x===s).length,1,s);
 // 20261029260000..290000 (tests/security-tenant-isolation-sql.test.mjs) are newer security migrations.
 for(const s of stamps)if(!["20261029240000","20261029250000","20261029260000","20261029270000","20261029280000","20261029290000","20261029300000","20261029310000","20261029320000"].includes(s))assert.ok(s<"20261029240000",s);
 for(const f of [MIG,RB,RL,RL_RB]){
  const s=src(f),code=noComments(s);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m,f);
  assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1,f);
  assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.doesNotMatch(code,/\bTRUNCATE\b|DROP\s+COLUMN|ALTER\s+TABLE\s+public\.tenants\s+(ADD|DROP|ALTER)/i,f);
 }
 const rl=noComments(src(RL));
 assert.doesNotMatch(rl,/SECURITY\s+DEFINER/i);
 assert.equal((rl.match(/SECURITY INVOKER\nSET search_path = ''/g)??[]).length,2);
 assert.doesNotMatch(rl,/GRANT[^;]*\bTO\s+(anon|authenticated|PUBLIC)\b/i);
 const m=noComments(src(MIG));
 assert.doesNotMatch(m,/GRANT\s+(INSERT|UPDATE)\s+ON\s+TABLE\s+public\.tenants\s+TO\s+(anon|authenticated|PUBLIC)/i);
 assert.match(m,/GRANT UPDATE \(business_name, source_url\) ON TABLE public\.tenants TO authenticated;/);
 assert.doesNotMatch(m,/TO\s+anon\b/i,"nothing is granted to anon");
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
function psql(db,{file,sql}={}){
 const a=["-X","-q","-t","-A","-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose","-h",dir,"-p",String(port),"-U","postgres","-d",db];
 if(file)a.push("-f",file);
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input:sql,env:clientEnv(),maxBuffer:1<<26});
}
function ok(db,s,label){
 const r=psql(db,s);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return r.stdout.trim();
}
const sqlState=err=>(err.match(/ERROR:\s+([0-9A-Z]{5}):/)??[])[1];
// Runs `stmt` as `role` (optionally with a JWT subject) inside a transaction.
function as(db,role,stmt,sub){
 const pre=`BEGIN;${sub?`SET LOCAL "request.jwt.claim.sub"='${sub}';`:""}SET LOCAL ROLE ${role};\n`;
 return psql(db,{sql:`${pre}${stmt}\nCOMMIT;`});
}
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

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UA="11111111-1111-4111-8111-111111111111",UB="22222222-2222-4222-8222-222222222222";

function schemaExcerpt(){
 const s=src("supabase/schema.sql");
 const block=start=>{const a=s.indexOf(start);assert.ok(a>=0,start);return s.slice(a,s.indexOf("\n);\n",a)+4);};
 const stmt=start=>{const a=s.indexOf(start);assert.ok(a>=0,start);return s.slice(a,s.indexOf(";\n",a)+2);};
 const fn=start=>{const a=s.indexOf(start);assert.ok(a>=0,start);return s.slice(a,s.indexOf("$$;\n",a)+4);};
 return [block("create table public.tenants ("),block("create table if not exists public.wa_bindings ("),
  fn("create or replace function public.grant_credits("),
  stmt("alter table public.tenants               enable row level security;"),
  stmt("create policy tenants_owner_all on public.tenants"),stmt("create policy tenants_claim_link on public.tenants")].join("\n");
}
const FIXTURE=()=>`
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
 AS $u$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $u$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE EXTENSION pgcrypto;
${schemaExcerpt()}
CREATE TABLE public.channel_accounts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 channel text NOT NULL, external_id text, status text NOT NULL DEFAULT 'active',
 UNIQUE(tenant_id,channel,external_id));
ALTER TABLE public.channel_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY channel_accounts_owner ON public.channel_accounts FOR ALL
 USING (tenant_id IN (SELECT id FROM public.tenants WHERE user_id = auth.uid()))
 WITH CHECK (tenant_id IN (SELECT id FROM public.tenants WHERE user_id = auth.uid()));
-- Supabase default privileges on public tables.
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
INSERT INTO auth.users VALUES ('${UA}'),('${UB}');
INSERT INTO public.tenants(id,user_id,business_name,source_type,credits_remaining,is_active)
VALUES ('${A}','${UA}','A','manual',5,true),('${B}','${UB}','B','manual',0,false);
INSERT INTO public.wa_bindings(phone_id,tenant_id) VALUES ('1000001','${A}');
`;
// Effective ACLs (NULL = the built-in default), order-insensitive.
const ACL=`SELECT string_agg(x,E'\\n' ORDER BY x) FROM (
 SELECT 'r:'||c.relname||':'||(SELECT string_agg(i::text,',' ORDER BY i::text) FROM unnest(coalesce(c.relacl,acldefault('r',c.relowner))) i)||':'||c.relrowsecurity FROM pg_class c
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
 UNION ALL SELECT 'a:'||attrelid::regclass||'.'||attname||':'||coalesce(attacl::text,'') FROM pg_attribute
  WHERE attrelid IN ('public.tenants'::regclass,'public.wa_bindings'::regclass,'public.channel_accounts'::regclass) AND attnum>0
 UNION ALL SELECT 'p:'||tablename||':'||policyname||':'||cmd||':'||roles::text||':'||coalesce(qual,'')||':'||coalesce(with_check,'')
  FROM pg_policies WHERE schemaname='public'
 UNION ALL SELECT 'f:'||p.oid::regprocedure||':'||(SELECT string_agg(i::text,',' ORDER BY i::text) FROM unnest(coalesce(p.proacl,acldefault('f',p.proowner))) i) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
) s(x)`;

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"sec-rls-"));
 if(isRoot)chownSync(dir,Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout.trim()),
  Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout.trim()));
 port=20000+Math.floor(Math.random()*20000);
 const init=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(init.status,0,init.stderr);
 const st=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off`,"start"]);
 assert.equal(st.status,0,st.stderr);started=true;
 ok("postgres",{sql:"CREATE DATABASE base;"},"create base");
 const fx=join(dir,"fixture.sql");writeFileSync(fx,FIXTURE());
 ok("base",{file:fx},"fixture");
 for(const d of ["oldvuln","m"])ok("postgres",{sql:`CREATE DATABASE ${d} TEMPLATE base;`},d);
});
after(()=>{
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 if(dir)rmSync(dir,{recursive:true,force:true});
});

test("OLD behaviour (schema.sql as is) is exploitable — proves the tests below detect it",{skip},()=>{
 const db="oldvuln";
 // anon via tenants_claim_link (USING claim_token IS NOT NULL, role PUBLIC):
 // an unfiltered UPDATE needs no SELECT policy -> credits/activation of EVERY tenant
 allowed(db,"anon",`UPDATE public.tenants SET credits_remaining=999999,is_active=true;`);
 assert.equal(val(db,`(SELECT count(*) FROM public.tenants WHERE credits_remaining=999999 AND is_active)`),"2");
 // owner via tenants_owner_all
 assert.match(allowed(db,"authenticated",`UPDATE public.tenants SET credits_remaining=777 WHERE id='${A}' RETURNING 1;`,UA),/1/);
 // anon via rpc grant_credits (SECURITY DEFINER, EXECUTE to PUBLIC)
 allowed(db,"anon",`SELECT public.grant_credits('${B}',1000);`);
 // anon rewrites a phone binding (no RLS on wa_bindings)
 assert.match(allowed(db,"anon",`UPDATE public.wa_bindings SET tenant_id='${B}' WHERE phone_id='1000001' RETURNING 1;`),/1/);
});

test("migration: owner cannot write billing/state columns; safe column OK; inserts denied; anon claim-link gone",{skip},()=>{
 const db="m";
 const pre=val(db,ACL);
 ok(db,{file:MIG},"apply 240000");
 // authenticated owner
 for(const [col,v] of [["credits_remaining","999"],["is_active","true"],["activated_at","now()"],
  ["claim_token","'x'"],["user_id",`'${UB}'`],["source_type","'website'"]])
  denied(db,"authenticated",`UPDATE public.tenants SET ${col}=${v} WHERE id='${A}';`,UA,`owner UPDATE ${col}`);
 assert.match(allowed(db,"authenticated",`UPDATE public.tenants SET business_name='New' WHERE id='${A}' RETURNING business_name;`,UA),/New/);
 assert.equal(allowed(db,"authenticated",`UPDATE public.tenants SET business_name='X' WHERE id='${B}' RETURNING 1;`,UA),"","not owner: 0 rows");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.tenants;`,UA),"1","owner sees own tenant only");
 denied(db,"authenticated",`INSERT INTO public.tenants(user_id,business_name,source_type,credits_remaining,is_active) VALUES('${UA}','Z','manual',100,true);`,UA,"owner INSERT with billing cols");
 denied(db,"authenticated",`INSERT INTO public.tenants(business_name,source_type) VALUES('Z','manual');`,UA,"owner INSERT");
 // anon: claim-link UPDATE path and inserts
 denied(db,"anon",`UPDATE public.tenants SET credits_remaining=999999,is_active=true WHERE id='${B}';`,null,"anon UPDATE (claim link)");
 denied(db,"anon",`UPDATE public.tenants SET credits_remaining=999999,is_active=true;`,null,"anon unfiltered UPDATE (claim link)");
 denied(db,"authenticated",`UPDATE public.tenants SET credits_remaining=999999;`,UA,"owner unfiltered UPDATE");
 denied(db,"anon",`UPDATE public.tenants SET user_id='${UA}' WHERE id='${B}';`,null,"anon claim takeover");
 denied(db,"anon",`INSERT INTO public.tenants(business_name,source_type,credits_remaining) VALUES('Z','manual',5);`,null,"anon INSERT");
 assert.equal(allowed(db,"anon",`SELECT count(*) FROM public.tenants;`),"0","anon reads nothing");
 assert.equal(val(db,`array_to_string(ARRAY(SELECT policyname FROM pg_policies WHERE tablename='tenants' ORDER BY 1),',')`),
  "tenants_owner_delete,tenants_owner_select,tenants_owner_update");
 // grant_credits rpc
 denied(db,"anon",`SELECT public.grant_credits('${B}',1000);`,null,"anon rpc grant_credits");
 denied(db,"authenticated",`SELECT public.grant_credits('${A}',1000);`,UA,"owner rpc grant_credits");
 // wa_bindings / channel_accounts direct writes (S1 bypass)
 denied(db,"anon",`UPDATE public.wa_bindings SET tenant_id='${B}' WHERE phone_id='1000001';`,null,"anon wa_bindings UPDATE");
 denied(db,"authenticated",`INSERT INTO public.wa_bindings(phone_id,tenant_id) VALUES('2000002','${A}');`,UA,"owner wa_bindings INSERT");
 denied(db,"authenticated",`SELECT * FROM public.wa_bindings;`,UA,"owner wa_bindings SELECT");
 denied(db,"authenticated",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${A}','whatsapp','1000001');`,UA,"owner channel_accounts INSERT");
 // service role (server paths) unaffected
 assert.match(allowed(db,"service_role",`UPDATE public.tenants SET credits_remaining=credits_remaining+1,is_active=true WHERE id='${B}' RETURNING credits_remaining;`),/^1$/m);
 allowed(db,"service_role",`INSERT INTO public.tenants(business_name,source_type,credits_remaining,is_active) VALUES('S','manual',0,false);`);
 allowed(db,"service_role",`SELECT public.grant_credits('${B}',10);`);
 allowed(db,"service_role",`INSERT INTO public.wa_bindings(phone_id,tenant_id) VALUES('3000003','${B}');`);
 allowed(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${B}','whatsapp','3000003');`);
 assert.equal(val(db,`(SELECT credits_remaining FROM public.tenants WHERE id='${B}')`),"11");
 // idempotent re-run keeps the ORIGINAL recorded state
 const note=val(db,`obj_description((SELECT oid FROM pg_policy WHERE polname='tenants_owner_select'),'pg_policy')`);
 const post=val(db,ACL);
 ok(db,{file:MIG},"re-apply 240000");
 assert.equal(val(db,ACL),post,"re-run is a no-op");
 assert.equal(val(db,`obj_description((SELECT oid FROM pg_policy WHERE polname='tenants_owner_select'),'pg_policy')`),note);
 assert.match(note,/^CREATED_BY_20261029240000_TENANTS_BILLING_RLS\|legacy=owner_all,claim_link,;/);
 // rollback restores the exact previous ACLs / policies (twice: idempotent)
 ok(db,{file:RB},"rollback 240000");
 assert.equal(val(db,ACL),pre,"rollback restores previous grants/policies");
 ok(db,{file:RB},"rollback again (no-op)");
 assert.equal(val(db,ACL),pre);
 allowed(db,"anon",`UPDATE public.tenants SET credits_remaining=4242;`);
 assert.equal(val(db,`(SELECT count(*) FROM public.tenants WHERE credits_remaining=4242)`),"3","old (vulnerable) behaviour restored");
});

test("migration refuses unexpected tenants policies / definitions without any change",{skip},()=>{
 for(const [label,sql,re] of [
  ["extra policy",`CREATE POLICY tenants_extra ON public.tenants FOR SELECT USING (true);`,/unexpected policy tenants_extra/],
  ["altered claim link",`DROP POLICY tenants_claim_link ON public.tenants; CREATE POLICY tenants_claim_link ON public.tenants FOR UPDATE TO anon USING (true);`,/tenants_claim_link has an unexpected definition/],
  ["unmarked new name",`CREATE POLICY tenants_owner_select ON public.tenants FOR SELECT USING (true);`,/exists without marker/],
  ["RLS disabled",`ALTER TABLE public.tenants DISABLE ROW LEVEL SECURITY;`,/not enabled on public\.tenants/]]){
  const db="r"+Math.random().toString(36).slice(2,8);
  ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE base;`},db);
  ok(db,{sql},label);
  const b=val(db,ACL);
  const r=psql(db,{file:MIG});
  assert.notEqual(r.status,0,label);assert.match(r.stderr,re,label);
  assert.equal(val(db,ACL),b,`${label}: unchanged`);
 }
});

test("250000 rate limiter: atomic fixed window, service_role only, prune, rollback",{skip},()=>{
 const db="m";
 ok(db,{file:RL},"apply 250000");
 ok(db,{file:RL},"re-apply 250000 (idempotent)");
 const hit=(k,l=10,w=60)=>JSON.parse(allowed(db,"service_role",`SELECT public.milan_rate_limit_hit('${k}',${l},${w});`));
 const res=[];for(let i=0;i<11;i++)res.push(hit("w:ip:abc"));
 assert.deepEqual(res.map(r=>r.allowed),[...Array(10).fill(true),false],"11th hit in the window is blocked");
 assert.equal(res[10].hits,11);
 assert.ok(res[10].retry_after>=1&&res[10].retry_after<=60);
 assert.equal(hit("w:ip:other").allowed,true,"buckets are independent");
 // concurrency: 30 parallel sessions, limit 10 -> exactly 10 allowed
 const procs=[];
 for(let i=0;i<30;i++)procs.push(new Promise(res=>{
  const c=spawn(join(BIN,"psql"),["-X","-q","-t","-A","-h",dir,"-p",String(port),"-U","postgres","-d",db,"-c",
   "SET ROLE service_role; SELECT public.milan_rate_limit_hit('conc',10,3600)->>'allowed';"],{env:clientEnv()});
  let out="";c.stdout.on("data",d=>out+=d);c.on("close",()=>res(out.trim()));}));
 return Promise.all(procs).then(outs=>{
  assert.equal(outs.filter(o=>o==="true").length,10);
  assert.equal(val(db,`(SELECT hits FROM public.milan_rate_limits WHERE bucket_key='conc')`),"30");
  for(const role of ["anon","authenticated"]){
   denied(db,role,`SELECT public.milan_rate_limit_hit('x',10,60);`,UA,`${role} execute`);
   denied(db,role,`SELECT * FROM public.milan_rate_limits;`,UA,`${role} select`);
  }
  const bad=as(db,"service_role",`SELECT public.milan_rate_limit_hit('',10,60);`);
  assert.equal(sqlState(bad.stderr),"22023");
  ok(db,{sql:`INSERT INTO public.milan_rate_limits VALUES('old',now()-interval '3 days',5);`},"old row");
  assert.equal(allowed(db,"service_role",`SELECT public.milan_rate_limit_prune(500);`),"1");
  assert.equal(val(db,`(SELECT count(*) FROM public.milan_rate_limits WHERE bucket_key='old')`),"0");
  assert.equal(val(db,`(SELECT prosecdef::text||array_to_string(proconfig,',') FROM pg_proc WHERE proname='milan_rate_limit_hit')`),'falsesearch_path=""');
  ok(db,{file:RL_RB},"rollback 250000");
  assert.equal(val(db,`to_regclass('public.milan_rate_limits') IS NULL AND to_regprocedure('public.milan_rate_limit_hit(text,integer,integer)') IS NULL`),"t");
  ok(db,{file:RL_RB},"rollback 250000 again");
 });
});

test("S1 SQL semantics: the old upsert (DO UPDATE) overwrites; ON CONFLICT DO NOTHING never does, even concurrently",{skip},async()=>{
 const db="s1";
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE base;`},db);
 // old statement generated by supabase-js upsert({phone_id,tenant_id},{onConflict:"phone_id"})
 allowed(db,"service_role",`INSERT INTO public.wa_bindings(phone_id,tenant_id) VALUES('1000001','${B}') ON CONFLICT(phone_id) DO UPDATE SET phone_id=excluded.phone_id,tenant_id=excluded.tenant_id;`);
 assert.equal(val(db,`(SELECT tenant_id FROM public.wa_bindings WHERE phone_id='1000001')`),B,"old: hijacked");
 ok(db,{sql:`UPDATE public.wa_bindings SET tenant_id='${A}' WHERE phone_id='1000001';`},"reset");
 // new statement (ignoreDuplicates:true)
 allowed(db,"service_role",`INSERT INTO public.wa_bindings(phone_id,tenant_id) VALUES('1000001','${B}') ON CONFLICT(phone_id) DO NOTHING;`);
 assert.equal(val(db,`(SELECT tenant_id FROM public.wa_bindings WHERE phone_id='1000001')`),A,"new: unchanged");
 // concurrency: 20 sessions alternate A/B on one new phone_id; each reads the owner back
 const runs=[];
 for(let i=0;i<20;i++){const t=i%2?A:B;runs.push(new Promise(res=>{
  const c=spawn(join(BIN,"psql"),["-X","-q","-t","-A","-h",dir,"-p",String(port),"-U","postgres","-d",db,"-c",
   `SET ROLE service_role; INSERT INTO public.wa_bindings(phone_id,tenant_id) VALUES('9000009','${t}') ON CONFLICT(phone_id) DO NOTHING; SELECT tenant_id='${t}' FROM public.wa_bindings WHERE phone_id='9000009';`],{env:clientEnv()});
  let out="";c.stdout.on("data",d=>out+=d);c.on("close",()=>res({t,mine:out.trim()==="t"}));}));}
 const outs=await Promise.all(runs);
 const owner=val(db,`(SELECT tenant_id FROM public.wa_bindings WHERE phone_id='9000009')`);
 assert.ok(outs.every(o=>o.mine===(o.t===owner)),"every session sees the single winner");
 assert.equal(new Set(outs.filter(o=>o.mine).map(o=>o.t)).size,1);
});
