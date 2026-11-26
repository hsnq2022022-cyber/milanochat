// Manual commercial administration (20261126100000_manual_credit_admin): atomic, idempotent, tenant-safe credit
// grants/deductions and activation changes, with an audit ledger. THROWAWAY local PostgreSQL only (temporary
// data dir, unix socket, removed afterwards); never connects to a remote host.
// Fixture: roles anon / authenticated / service_role (BYPASSRLS), auth.uid() from request.jwt.claim.sub, the
// tenants definition + RLS copied VERBATIM from supabase/schema.sql, Supabase's default table grants.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync,writeFileSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";

const MIG="supabase/migrations/20261126100000_manual_credit_admin.sql";
const RB="supabase/rollbacks/20261126100000_manual_credit_admin.rollback.sql";
const src=f=>readFileSync(f,"utf8");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");

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
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
INSERT INTO auth.users VALUES ('${UA}'),('${UB}');
INSERT INTO public.tenants(id,user_id,business_name,source_type,credits_remaining,is_active)
VALUES ('${A}','${UA}','A','manual',5,false),('${B}','${UB}','B','manual',7,true);
`;
const OP="99999999-9999-4999-8999-999999999999",OP2="88888888-8888-4888-8888-888888888888";
const adjust=(db,t,op,d,reason,key)=>JSON.parse(val(db,`public.admin_adjust_credits('${t}','${op}',${d},'${reason}','${key}')::text`));
const active=(db,t,op,a,reason,key)=>JSON.parse(val(db,`public.admin_set_tenant_active('${t}','${op}',${a},'${reason}','${key}')::text`));
const bal=(db,t)=>Number(val(db,`SELECT credits_remaining FROM public.tenants WHERE id='${t}'`));
const rows=(db,t)=>Number(val(db,`SELECT count(*) FROM public.tenant_admin_actions WHERE tenant_id='${t}'`));
function runAsync(db,sql){
 return new Promise(res=>{
  const p=spawn(join(BIN,"psql"),["-X","-q","-t","-A","-d",db,"-h",dir,"-p",String(port),"-U","postgres"],{env:clientEnv()});
  let out="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",()=>{});
  p.on("close",()=>res(out.trim()));p.stdin.end(sql);
 });
}
let nDb=0;
const fresh=()=>{const n="t"+(++nDb);ok("postgres",{sql:`CREATE DATABASE ${n} TEMPLATE base;`},n);ok(n,{file:MIG},"apply");return n;};

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"credit-admin-"));
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
});
after(()=>{
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 if(dir)rmSync(dir,{recursive:true,force:true});
});

test("static: one bounded transaction, SECURITY DEFINER + empty search_path, service_role-only EXECUTE, no client write grants, rollback exists",()=>{
 const m=noComments(src(MIG)),r=noComments(src(RB));
 for(const [f,c] of [[MIG,m],[RB,r]]){
  assert.equal((c.match(/^BEGIN;$/gm)??[]).length,1,f);assert.equal((c.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.match(c,/SET LOCAL lock_timeout='3s';\s*SET LOCAL statement_timeout='60s';/,f);
  assert.doesNotMatch(c,/CONCURRENTLY|cron\.|vault\.|net\.http_|sb_secret_|eyJ[A-Za-z0-9_-]{30,}/i,f);
 }
 assert.equal((m.match(/SECURITY DEFINER SET search_path = ''/g)??[]).length,2);
 assert.match(m,/REVOKE ALL ON FUNCTION public\.admin_adjust_credits[^;]*FROM PUBLIC, anon, authenticated;/);
 assert.match(m,/GRANT EXECUTE ON FUNCTION public\.admin_adjust_credits[^;]*TO service_role;/);
 assert.doesNotMatch(m,/GRANT[^;]*\bTO\s+(anon|PUBLIC)\b/i);
 assert.doesNotMatch(m,/GRANT\s+(ALL|INSERT|UPDATE|DELETE)[^;]*TO[^;]*authenticated/i);
 assert.match(r,/Refusing: the manual credit ledger is not empty/);
});

test("grant and deduct: balance, ledger row (operator, reason, amount, balance_after), replay is a no-op",{skip},()=>{
 const db=fresh();
 const g=adjust(db,A,OP,100,"تأكيد دفع 80000 خارج المنصة","key-grant-0001");
 assert.deepEqual([g.ok,g.duplicate,g.balance],[true,false,105]);
 assert.equal(bal(db,A),105);
 assert.equal(val(db,`SELECT action||'|'||amount||'|'||balance_after||'|'||operator_id||'|'||reason FROM public.tenant_admin_actions WHERE tenant_id='${A}'`),
  `credit_grant|100|105|${OP}|تأكيد دفع 80000 خارج المنصة`);
 const again=adjust(db,A,OP,100,"تأكيد دفع 80000 خارج المنصة","key-grant-0001");
 assert.deepEqual([again.ok,again.duplicate,again.balance],[true,true,105]);
 assert.equal(bal(db,A),105,"a replay never grants twice");assert.equal(rows(db,A),1);
 const d=adjust(db,A,OP,-5,"تصحيح خطأ إدخال","key-deduct-001");
 assert.deepEqual([d.ok,d.balance],[true,100]);
 assert.equal(val(db,`SELECT action||'|'||amount FROM public.tenant_admin_actions WHERE idempotency_key='key-deduct-001'`),"credit_deduct|5");
});

test("idempotency conflicts and invalid input change nothing",{skip},()=>{
 const db=fresh();
 assert.equal(adjust(db,A,OP,10,"first grant ok","key-conflict-1").ok,true);
 for(const [op,d] of [[OP2,10],[OP,11],[OP,-10]]){
  const c=adjust(db,A,op,d,"conflicting reuse","key-conflict-1");
  assert.deepEqual([c.ok,c.error],[false,"idempotency_conflict"]);
 }
 assert.equal(bal(db,A),15);assert.equal(rows(db,A),1);
 const bad=[[A,OP,0,"zero delta ok","key-bad-0001"],[A,OP,1000001,"too large ok","key-bad-0002"],[A,OP,5,"ab","key-bad-0003"],
  [A,OP,5,"short key reason","k"],[A,OP,5,"   ","key-bad-0005"]];
 for(const [t,o,d,r,k] of bad){
  const x=adjust(db,t,o,d,r,k);assert.deepEqual([x.ok,x.error],[false,"invalid_arguments"],JSON.stringify([d,r,k]));
 }
 assert.equal(val(db,`public.admin_adjust_credits('${A}',NULL,5,'null operator ok','key-bad-0006')::text`).includes("invalid_arguments"),true);
 assert.equal(bal(db,A),15);assert.equal(rows(db,A),1);
});

test("a deduction can never take the balance below zero; exact deduction reaches zero; unknown tenant is refused",{skip},()=>{
 const db=fresh();
 const x=adjust(db,B,OP,-8,"too much deduction","key-neg-00001");
 assert.deepEqual([x.ok,x.error,x.balance],[false,"insufficient_balance",7]);
 assert.equal(bal(db,B),7);assert.equal(rows(db,B),0);
 assert.equal(adjust(db,B,OP,-7,"exact deduction ok","key-neg-00002").balance,0);
 const u=adjust(db,"cccccccc-cccc-4ccc-8ccc-cccccccccccc",OP,5,"unknown tenant ok","key-unk-00001");
 assert.deepEqual([u.ok,u.error],[false,"tenant_not_found"]);
});

test("tenant safety: a change on tenant A never touches tenant B; the same key is independent per tenant",{skip},()=>{
 const db=fresh();
 assert.equal(adjust(db,A,OP,50,"grant for tenant A","key-shared-01").balance,55);
 assert.equal(bal(db,B),7,"tenant B untouched");
 const b=adjust(db,B,OP,3,"grant for tenant B","key-shared-01");
 assert.deepEqual([b.ok,b.duplicate,b.balance],[true,false,10]);
 assert.equal(rows(db,A),1);assert.equal(rows(db,B),1);
});

test("atomic under real concurrency: 8 sessions, one key -> one grant; 8 deductions of 1 from a balance of 5 -> exactly 5 succeed, never negative",{skip},async()=>{
 const db=fresh();
 const same=await Promise.all(Array.from({length:8},()=>runAsync(db,`SELECT public.admin_adjust_credits('${A}','${OP}',10,'concurrent same key','key-conc-same')::text;`)));
 const parsed=same.map(s=>JSON.parse(s));
 assert.equal(parsed.filter(p=>p.ok&&!p.duplicate).length,1,"exactly one application");
 assert.equal(parsed.filter(p=>p.ok&&p.duplicate).length,7);
 assert.equal(bal(db,A),15);assert.equal(rows(db,A),1);
 const db2=fresh();
 const many=await Promise.all(Array.from({length:8},(_,i)=>runAsync(db2,`SELECT public.admin_adjust_credits('${A}','${OP}',-1,'concurrent deduction ${i}','key-conc-d-${i}00')::text;`)));
 const p2=many.map(s=>JSON.parse(s));
 assert.equal(p2.filter(p=>p.ok).length,5);assert.equal(p2.filter(p=>p.error==="insufficient_balance").length,3);
 assert.equal(bal(db2,A),0);assert.equal(rows(db2,A),5);
});

test("activate / suspend / reactivate: transitions are recorded, no-ops are not, replays are idempotent",{skip},()=>{
 const db=fresh();
 assert.equal(val(db,`SELECT is_active FROM public.tenants WHERE id='${A}'`),"f");
 const a=active(db,A,OP,true,"payment confirmed outside","key-act-00001");
 assert.deepEqual([a.ok,a.unchanged,a.active],[true,false,true]);
 assert.equal(val(db,`SELECT is_active AND activated_at IS NOT NULL FROM public.tenants WHERE id='${A}'`),"t");
 assert.equal(active(db,A,OP,true,"payment confirmed outside","key-act-00001").duplicate,true);
 assert.equal(active(db,A,OP,true,"already active repeat","key-act-00002").unchanged,true);
 const s=active(db,A,OP,false,"subscription ended","key-sus-00001");assert.equal(s.ok,true);
 assert.equal(val(db,`SELECT is_active FROM public.tenants WHERE id='${A}'`),"f");
 assert.equal(active(db,A,OP,true,"renewed outside platform","key-act-00003").ok,true);
 assert.equal(val(db,`SELECT string_agg(action,',' ORDER BY created_at,id) FROM public.tenant_admin_actions WHERE tenant_id='${A}'`),"activate,suspend,activate");
 assert.equal(active(db,A,OP2,true,"conflict other operator","key-act-00003").error,"idempotency_conflict");
 assert.equal(active(db,"cccccccc-cccc-4ccc-8ccc-cccccccccccc",OP,true,"unknown tenant ok","key-act-00009").error,"tenant_not_found");
});

test("privileges: clients cannot run the functions or write the ledger; an owner reads only own rows and never operator_id; service_role works",{skip},()=>{
 const db=fresh();
 adjust(db,A,OP,10,"grant for tenant A","key-priv-0001");adjust(db,B,OP,10,"grant for tenant B","key-priv-0002");
 for(const role of ["anon","authenticated"]){
  for(const call of [`SELECT public.admin_adjust_credits('${A}','${OP}',999999,'self grant attempt','key-hack-0001');`,
    `SELECT public.admin_set_tenant_active('${A}','${OP}',true,'self activate try','key-hack-0002');`])
   denied(db,role,call,UA,`${role} ${call.slice(0,40)}`);
  denied(db,role,`INSERT INTO public.tenant_admin_actions(tenant_id,operator_id,action,reason,idempotency_key) VALUES ('${A}','${OP}','activate','forged entry ok','key-hack-0003');`,UA,`${role} insert`);
  denied(db,role,`UPDATE public.tenant_admin_actions SET reason='tampered ledger';`,UA,`${role} update`);
  denied(db,role,`DELETE FROM public.tenant_admin_actions;`,UA,`${role} delete`);
 }
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.tenant_admin_actions;`,UA,"owner A reads"),"1","owner A sees only own rows");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.tenant_admin_actions WHERE tenant_id='${B}';`,UA,"owner A reads B"),"0");
 assert.equal(allowed(db,"authenticated",`SELECT reason, amount, balance_after FROM public.tenant_admin_actions;`,UA,"safe columns"),"grant for tenant A|10|15");
 denied(db,"authenticated",`SELECT operator_id FROM public.tenant_admin_actions;`,UA,"operator_id hidden");
 denied(db,"anon",`SELECT count(*) FROM public.tenant_admin_actions;`,undefined,"anon read");
 assert.equal(allowed(db,"service_role",`SELECT (public.admin_adjust_credits('${A}','${OP}',1,'service role grant','key-svc-00001')->>'ok');`,undefined,"service_role"),"true");
});

test("apply twice is a no-op; rollback refused while the ledger has rows, works when empty, re-apply works; foreign objects are never touched",{skip},()=>{
 const db=fresh();
 const snap=()=>val(db,`SELECT md5(string_agg(x,',' ORDER BY x)) FROM (SELECT p.oid::regprocedure::text||md5(p.prosrc) x FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'admin_%' UNION ALL SELECT 't:'||relname||c.relrowsecurity FROM pg_class c WHERE relnamespace='public'::regnamespace AND relname='tenant_admin_actions') s`);
 const before=snap();ok(db,{file:MIG},"re-apply");assert.equal(snap(),before,"idempotent");
 adjust(db,A,OP,1,"row blocks rollback","key-rb-000001");
 const r=psql(db,{file:RB});assert.notEqual(r.status,0);assert.match(r.stderr,/ledger is not empty/);
 assert.equal(val(db,`to_regclass('public.tenant_admin_actions') IS NOT NULL`),"t");
 ok(db,{sql:"DELETE FROM public.tenant_admin_actions;"},"empty ledger");
 ok(db,{file:RB},"rollback");
 assert.equal(val(db,`to_regclass('public.tenant_admin_actions') IS NULL AND to_regprocedure('public.admin_adjust_credits(uuid,uuid,integer,text,text)') IS NULL`),"t");
 const r2=psql(db,{file:RB});assert.notEqual(r2.status,0);assert.match(r2.stderr,/not installed/);
 ok(db,{file:MIG},"re-apply after rollback");
 // foreign (unmarked) object of the same name: migration and rollback both refuse and change nothing
 const f="t"+(++nDb);ok("postgres",{sql:`CREATE DATABASE ${f} TEMPLATE base;`},f);
 ok(f,{sql:"CREATE TABLE public.tenant_admin_actions(id int);"},"foreign table");
 const m=psql(f,{file:MIG});assert.notEqual(m.status,0);assert.match(m.stderr,/not owned by this migration/);
 const rb=psql(f,{file:RB});assert.notEqual(rb.status,0);assert.match(rb.stderr,/not owned by this migration/);
 assert.equal(val(f,`to_regclass('public.tenant_admin_actions') IS NOT NULL`),"t");
});
