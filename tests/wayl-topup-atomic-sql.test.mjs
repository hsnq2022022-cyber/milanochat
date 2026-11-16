// 20261115130000_wayl_topup_atomic_grant: public.wayl_grant_topup_once(uuid,
// integer,text,jsonb) marks a Wayl top-up paid AND credits the payment's own
// tenant in ONE transaction, exactly once, fail closed.
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards). Never connects to any remote host;
// inherited PG* variables are stripped.
// Fixture = the LIVE shape as reported by the operator: roles anon /
// authenticated / service_role (BYPASSRLS); tenants(credits_remaining,
// is_active, activated_at) with RLS; payments(id PK, tenant_id, provider,
// invoice_id UNIQUE, amount, currency, status CHECK(created|paid|failed|
// refunded), credits_granted, webhook_event, created_at, paid_at) with RLS on
// and NO policies; grant_credits(uuid,integer) as in supabase/schema.sql
// (SECURITY DEFINER, service_role only); Supabase default privileges (new
// functions executable by PUBLIC, anon, authenticated, service_role).
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync,writeFileSync} from "node:fs";
import {spawn,spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const MIG="supabase/migrations/20261115130000_wayl_topup_atomic_grant.sql";
const RB="supabase/rollbacks/20261115130000_wayl_topup_atomic_grant.rollback.sql";
const OLD="supabase/migrations/20261028230000_wayl_atomic_topup.sql";
const MARK="CREATED_BY_20261115130000_WAYL_TOPUP_ATOMIC_GRANT";
const SIG="public.wayl_grant_topup_once(uuid,integer,text,jsonb)";
const src=f=>readFileSync(f,"utf8");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");

// ---------------------------------------------------------------- static
test("static: one bounded transaction, SECURITY DEFINER + empty search_path, service_role-only EXECUTE, no data change",()=>{
 assert.ok(existsSync(RB));
 for(const f of [MIG,RB]){
  const s=src(f),code=noComments(s);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\nSET LOCAL search_path = '';\n/m,f);
  assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1,f);
  assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.ok(code.includes(`'${MARK}'`),f);
  assert.doesNotMatch(code,/^\s*(TRUNCATE|INSERT|DELETE|ALTER\s+TABLE|DROP\s+TABLE)\b|cron\.|vault\.|net\.http_|sb_secret_|eyJ[A-Za-z0-9_-]{30,}/im,f);
 }
 const code=noComments(src(MIG));
 assert.match(code,/CREATE OR REPLACE FUNCTION public\.wayl_grant_topup_once\(\n p_payment_id uuid, p_expected_amount integer, p_currency text, p_event jsonb\n\) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''/);
 assert.match(code,/REVOKE ALL ON FUNCTION public\.wayl_grant_topup_once\(uuid,integer,text,jsonb\)\n FROM PUBLIC,anon,authenticated;/);
 assert.match(code,/GRANT EXECUTE ON FUNCTION public\.wayl_grant_topup_once\(uuid,integer,text,jsonb\)\n TO service_role;/);
 assert.doesNotMatch(code,/GRANT[^;]*\bTO\s+(PUBLIC|anon|authenticated)\b/i);
 // the only UPDATEs are inside the function body (payments row of p_payment_id)
 const body=code.slice(code.indexOf("$waylgrant$"),code.lastIndexOf("$waylgrant$"));
 assert.equal((code.match(/\bUPDATE\b/g)??[]).length,(body.match(/\bUPDATE\b/g)??[]).length,"no UPDATE outside the function");
 assert.match(body,/FOR UPDATE;/);
 assert.doesNotMatch(body,/p_event\s*(->|#>|->>)/,"nothing is read from the provider body");
 // both files carry the same self-md5, and it is the md5 of the body actually written
 const md5s=[MIG,RB].map(f=>(src(f).match(/v_self_md5 constant text := '([0-9a-f]{32})'/)??[])[1]);
 assert.ok(md5s[0]&&md5s[0]===md5s[1],"same v_self_md5 in migration and rollback");
 const raw=src(MIG);const prosrc=raw.slice(raw.indexOf("$waylgrant$")+"$waylgrant$".length,raw.lastIndexOf("$waylgrant$"));
 assert.equal(createHash("md5").update(prosrc.replace(/[ \t\n\r\f\v]+/g," ").trim()).digest("hex"),md5s[0],"v_self_md5 matches the body");
 // deploy-order note present in both
 assert.match(src(MIG),/apply this migration FIRST/);
 assert.match(src(RB),/does not call this function\n-- FIRST/);
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
const psqlArgs=db=>["-X","-q","-t","-A","-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose","-h",dir,"-p",String(port),"-U","postgres","-d",db];
function psql(db,{file,sql}={}){
 const a=psqlArgs(db);
 if(file)a.push("-f",file);
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input:sql,env:clientEnv(),maxBuffer:1<<26});
}
function psqlAsync(db,sql){
 return new Promise((resolve)=>{
  const t0=Date.now();
  const p=spawn(join(BIN,"psql"),psqlArgs(db),{env:clientEnv()});
  let out="",err="";
  p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
  p.on("close",status=>resolve({status,stdout:out,stderr:err,ms:Date.now()-t0}));
  p.stdin.end(sql);
 });
}
function ok(db,s,label){
 const r=psql(db,s);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return r.stdout.trim();
}
function fails(db,s,label,re){
 const r=psql(db,s);
 assert.notEqual(r.status,0,`${label} must fail`);
 if(re)assert.match(r.stderr,re,label);
 return r.stderr;
}
const sqlState=err=>(err.match(/ERROR:\s+([0-9A-Z]{5}):/)??[])[1];
const val=(db,q)=>ok(db,{sql:`SELECT (${q});`},q);
let dbn=0;
const fresh=(template="base")=>{const d=`d${++dbn}`;ok("postgres",{sql:`CREATE DATABASE ${d} TEMPLATE ${template};`},d);return d;};

const TA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",TB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P1="11111111-1111-4111-8111-111111111111"; // A, created, 35000, credits 1000 stored
const P2="22222222-2222-4222-8222-222222222222"; // A, created, 85000, no stored credits (table)
const P3="33333333-3333-4333-8333-333333333333"; // A, failed
const P4="44444444-4444-4444-8444-444444444444"; // A, refunded
const P5="55555555-5555-4555-8555-555555555555"; // A, moyasar provider
const P6="66666666-6666-4666-8666-666666666666"; // A, SAR currency
const P7="77777777-7777-4777-8777-777777777777"; // B, created, 225000, stored credits 10000
const P8="88888888-8888-4888-8888-888888888888"; // A, created, 12345 (unknown package, no credits)
const P9="99999999-9999-4999-8999-999999999999"; // A, created, credits_granted 5 (inconsistent)
const PX="12121212-1212-4212-8212-121212121212"; // absent
const FIXTURE=`
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Supabase default privileges for objects created by the migration owner.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE public.tenants(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, business_name text NOT NULL DEFAULT 'x',
 credits_remaining integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT false, activated_at timestamptz);
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.payments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 provider text NOT NULL DEFAULT 'moyasar', invoice_id text UNIQUE, amount integer NOT NULL,
 currency text NOT NULL DEFAULT 'SAR',
 status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','refunded')),
 credits_granted integer NOT NULL DEFAULT 0, webhook_event jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz);
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.grant_credits(p_tenant_id uuid, p_credits integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
begin
  update public.tenants
     set credits_remaining = credits_remaining + p_credits,
         is_active = true,
         activated_at = coalesce(activated_at, now())
   where id = p_tenant_id;
end;
$$;
REVOKE EXECUTE ON FUNCTION public.grant_credits(uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_credits(uuid,integer) TO service_role;
INSERT INTO public.tenants(id,credits_remaining) VALUES ('${TA}',5),('${TB}',7);
INSERT INTO public.payments(id,tenant_id,provider,invoice_id,amount,currency,status,credits_granted,webhook_event) VALUES
 ('${P1}','${TA}','wayl','inv-1',35000,'IQD','created',0,'{"source":"wayl-topup-v2","credits":1000}'),
 ('${P2}','${TA}','wayl','inv-2',85000,'IQD','created',0,NULL),
 ('${P3}','${TA}','wayl','inv-3',35000,'IQD','failed',0,'{"credits":1000}'),
 ('${P4}','${TA}','wayl','inv-4',35000,'IQD','refunded',0,'{"credits":1000}'),
 ('${P5}','${TA}','moyasar','inv-5',35000,'IQD','created',0,'{"credits":1000}'),
 ('${P6}','${TA}','wayl','inv-6',35000,'SAR','created',0,'{"credits":1000}'),
 ('${P7}','${TB}','wayl','inv-7',225000,'IQD','created',0,'{"credits":10000}'),
 ('${P8}','${TA}','wayl','inv-8',12345,'IQD','created',0,'{"source":"x"}'),
 ('${P9}','${TA}','wayl','inv-9',35000,'IQD','created',5,'{"credits":1000}');
`;

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"wayl-grant-"));
 if(isRoot)chownSync(dir,Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout.trim()),
  Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout.trim()));
 port=20000+Math.floor(Math.random()*20000);
 const init=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(init.status,0,init.stderr);
 const st=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off`,"start"]);
 assert.equal(st.status,0,st.stderr);started=true;
 ok("postgres",{sql:"CREATE DATABASE base;"},"create base");
 const fx=join(dir,"fixture.sql");writeFileSync(fx,FIXTURE);
 ok("base",{file:fx},"fixture");
});
after(()=>{
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 if(dir)rmSync(dir,{recursive:true,force:true});
});

const callSql=(id,amount,cur,ev='{"referenceId":"x"}')=>
 `SELECT ${SIG.replace(/\(.*$/,"")}(${id===null?"NULL":`'${id}'`},${amount===null?"NULL":amount},${cur===null?"NULL":`'${cur}'`},${ev===null?"NULL":`'${ev}'::jsonb`})`;
const asRole=(role,stmt)=>`BEGIN;SET LOCAL ROLE ${role};\n${stmt};\nCOMMIT;`;
function grant(db,id,amount,cur,ev){
 const r=psql(db,{sql:asRole("service_role",callSql(id,amount,cur,ev))});
 assert.equal(r.status,0,r.stderr);
 return JSON.parse(r.stdout.trim());
}
// Full observable state of both tables (every column).
const STATE=`SELECT string_agg(x,E'\\n' ORDER BY x) FROM (
 SELECT 'p:'||to_jsonb(p)::text FROM public.payments p
 UNION ALL SELECT 't:'||to_jsonb(t)::text FROM public.tenants t) s(x)`;
const state=db=>val(db,`(${STATE})`);
const bal=(db,t)=>Number(val(db,`(SELECT credits_remaining FROM public.tenants WHERE id='${t}')`));
const pay=(db,id)=>JSON.parse(val(db,`(SELECT to_jsonb(p) FROM public.payments p WHERE id='${id}')`));
const fnAcl=db=>val(db,`(SELECT coalesce(string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END||'='||a.privilege_type,',' ORDER BY 1),'')
 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid=to_regprocedure('${SIG}') AND a.grantee<>p.proowner)`);
const normMd5=db=>val(db,`(SELECT md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))) FROM pg_proc WHERE oid=to_regprocedure('${SIG}'))`);

test("apply, re-apply (idempotent), rollback, rollback refused twice, apply again; data untouched",{skip},()=>{
 const db=fresh();
 const s0=state(db);
 const gcAcl=val(db,`(SELECT proacl::text FROM pg_proc WHERE oid='public.grant_credits(uuid,integer)'::regprocedure)`);
 ok(db,{file:MIG},"apply");
 assert.equal(val(db,`obj_description(to_regprocedure('${SIG}'),'pg_proc')`),MARK);
 assert.equal(val(db,`(SELECT prosecdef::text||':'||proconfig::text||':'||prorettype::regtype::text FROM pg_proc WHERE oid=to_regprocedure('${SIG}'))`),
  'true:{"search_path=\\"\\""}:jsonb');
 const md5=(src(MIG).match(/v_self_md5 constant text := '([0-9a-f]{32})'/))[1];
 assert.equal(normMd5(db),md5,"installed body md5 == v_self_md5 (re-apply and rollback depend on it)");
 assert.equal(fnAcl(db),"service_role=EXECUTE","EXECUTE: service_role only (default privileges revoked)");
 assert.equal(state(db),s0,"apply changes no data");
 ok(db,{file:MIG},"re-apply");
 assert.equal(fnAcl(db),"service_role=EXECUTE");
 assert.equal(val(db,`(SELECT count(*) FROM pg_proc WHERE proname='wayl_grant_topup_once')`),"1");
 ok(db,{file:RB},"rollback");
 assert.equal(val(db,`to_regprocedure('${SIG}') IS NULL`),"t");
 assert.equal(state(db),s0,"rollback changes no data");
 assert.equal(val(db,`(SELECT proacl::text FROM pg_proc WHERE oid='public.grant_credits(uuid,integer)'::regprocedure)`),gcAcl,"grant_credits ACL untouched");
 fails(db,{file:RB},"second rollback",/not installed; nothing to roll back/);
 ok(db,{file:MIG},"apply after rollback");
 assert.equal(fnAcl(db),"service_role=EXECUTE");
});

test("refusals: unmarked same-signature function, marked foreign body, unknown overload, missing grant_credits; rollback never drops foreign",{skip},()=>{
 // unmarked function of the same signature: apply refused, rollback refused, function kept
 let db=fresh();
 ok(db,{sql:`CREATE FUNCTION ${SIG.replace("(uuid,integer,text,jsonb)","(a uuid,b integer,c text,d jsonb)")} RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;`},"foreign");
 fails(db,{file:MIG},"apply over unmarked",/Unrecognized existing function/);
 fails(db,{file:RB},"rollback of unmarked",/Refusing to drop unrecognized function/);
 assert.equal(val(db,`to_regprocedure('${SIG}') IS NOT NULL`),"t");
 // marked, but body changed
 db=fresh();
 ok(db,{file:MIG},"apply");
 ok(db,{sql:`CREATE OR REPLACE FUNCTION ${SIG.replace("(uuid,integer,text,jsonb)","(p_payment_id uuid, p_expected_amount integer, p_currency text, p_event jsonb)")} RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$BEGIN RETURN '{}'::jsonb; END$f$;`},"tamper");
 fails(db,{file:MIG},"re-apply over tampered body",/carries the marker but not this migration's body/);
 fails(db,{file:RB},"rollback of tampered body",/marked but its body is not/);
 // unknown overload of the same name
 db=fresh();
 ok(db,{sql:`CREATE FUNCTION public.wayl_grant_topup_once(x text) RETURNS int LANGUAGE sql AS $$SELECT 1$$;`},"overload");
 fails(db,{file:MIG},"apply with unknown overload",/Unrecognized overload/);
 // missing prerequisite
 db=fresh();
 ok(db,{sql:`DROP FUNCTION public.grant_credits(uuid,integer);`},"drop gc");
 fails(db,{file:MIG},"apply without grant_credits",/prerequisite missing: public.grant_credits/);
 assert.equal(val(db,`to_regprocedure('${SIG}') IS NULL`),"t","nothing installed");
});

test("coexists with the REVIEW-ONLY 20261028230000 (uuid,integer) overload; rollback leaves it untouched",{skip},()=>{
 const db=fresh();
 ok(db,{file:OLD},"old overload");
 ok(db,{file:MIG},"apply");
 ok(db,{file:MIG},"re-apply");
 ok(db,{file:RB},"rollback");
 assert.equal(val(db,`to_regprocedure('public.wayl_grant_topup_once(uuid,integer)') IS NOT NULL`),"t");
 assert.equal(val(db,`to_regprocedure('${SIG}') IS NULL`),"t");
});

test("EXECUTE denied to anon / authenticated / PUBLIC-only roles; service_role allowed",{skip},()=>{
 const db=fresh();
 ok(db,{file:MIG},"apply");
 ok(db,{sql:`CREATE ROLE some_other NOLOGIN; GRANT USAGE ON SCHEMA public TO some_other;`},"role");
 const s0=state(db);
 for(const role of ["anon","authenticated","some_other"]){
  const err=fails(db,{sql:asRole(role,callSql(P1,35000,"IQD"))},`${role} call`);
  assert.equal(sqlState(err),"42501",`${role}: ${err}`);
 }
 assert.equal(state(db),s0,"denied calls change nothing");
 assert.equal(val(db,`has_function_privilege('anon','${SIG}','EXECUTE')`),"f");
 assert.equal(val(db,`has_function_privilege('authenticated','${SIG}','EXECUTE')`),"f");
 assert.equal(grant(db,P1,35000,"IQD").granted,true,"service_role call works");
});

test("created -> paid: stored credits to the row's own tenant, once; already_paid is a no-op",{skip},()=>{
 const db=fresh();
 ok(db,{file:MIG},"apply");
 const ev=JSON.stringify({referenceId:P1,paymentStatus:"Complete",total:35000,credits:999999,tenant_id:TB,p_credits:5,webhook_event:{credits:7}});
 assert.deepEqual(grant(db,P1,35000," iqd ",ev),{granted:true,reason:"granted",credits:1000});
 assert.equal(bal(db,TA),1005);
 assert.equal(bal(db,TB),7,"other tenant untouched despite tenant_id in the body");
 const p=pay(db,P1);
 assert.equal(p.status,"paid");assert.equal(p.credits_granted,1000);assert.ok(p.paid_at);
 assert.equal(p.webhook_event.credits,1000,"server key preserved, not overwritten by the body");
 assert.equal(p.webhook_event.source,"wayl-topup-v2");
 assert.deepEqual(p.webhook_event.wayl,JSON.parse(ev),"provider body nested under wayl");
 assert.equal(val(db,`(SELECT is_active::text||':'||(activated_at IS NOT NULL)::text FROM public.tenants WHERE id='${TA}')`),"true:true","grant_credits side effects kept");
 const s1=state(db);
 for(let i=0;i<3;i++)assert.deepEqual(grant(db,P1,35000,"IQD"),{granted:false,reason:"already_paid",credits:0});
 assert.deepEqual(grant(db,P1,1,"USD"),{granted:false,reason:"already_paid",credits:0},"replay with other values");
 assert.equal(state(db),s1,"replays change nothing");
 // package-table fallback when no stored credits; other tenant B
 assert.deepEqual(grant(db,P2,85000,"IQD"),{granted:true,reason:"granted",credits:3000});
 assert.equal(bal(db,TA),4005);
 assert.deepEqual(grant(db,P7,225000,"IQD"),{granted:true,reason:"granted",credits:10000});
 assert.equal(bal(db,TB),10007);assert.equal(bal(db,TA),4005,"B's payment credits only B");
});

test("mismatches, non-created statuses, non-Wayl rows, unknown credits, bad arguments: no grant, no change",{skip},()=>{
 const db=fresh();
 ok(db,{file:MIG},"apply");
 const s0=state(db);
 const cases=[
  [P1,34999,"IQD","amount_mismatch"],[P1,35001,"IQD","amount_mismatch"],[P1,35000,"USD","currency_mismatch"],
  [P1,35000,"","currency_mismatch"],
  [P3,35000,"IQD","not_payable"],[P4,35000,"IQD","not_payable"],
  [P5,35000,"IQD","not_wayl"],[P6,35000,"SAR","currency_mismatch"],[P6,35000,"IQD","currency_mismatch"],
  [P8,12345,"IQD","credits_unknown"],[P9,35000,"IQD","manual_review"],[PX,35000,"IQD","not_found"],
  [null,35000,"IQD","invalid_arguments"],[P1,null,"IQD","invalid_arguments"],[P1,0,"IQD","invalid_arguments"],
  [P1,-35000,"IQD","invalid_arguments"],[P1,35000,null,"invalid_arguments"],[P1,35000,"IQD","invalid_arguments",null],
  [P1,35000,"IQD","invalid_arguments","[1]"],
 ];
 for(const [id,amt,cur,reason,ev] of cases){
  const r=grant(db,id,amt,cur,ev===undefined?'{"referenceId":"x"}':ev);
  assert.deepEqual(r,{granted:false,reason,credits:0},JSON.stringify([id,amt,cur,ev]));
 }
 assert.equal(state(db),s0,"no row changed by any rejected call");
 // stored credits invalid / out of range -> credits_unknown
 for(const c of ['"abc"','0','-5','1000001','true','1.5']){
  ok(db,{sql:`UPDATE public.payments SET webhook_event=jsonb_build_object('credits','${c}'::jsonb) WHERE id='${P1}';`},c);
  assert.equal(grant(db,P1,35000,"IQD").reason,"credits_unknown",c);
 }
 // int4 overflow of the tenant balance -> credit_overflow, nothing changed
 ok(db,{sql:`UPDATE public.payments SET webhook_event='{"credits":1000}' WHERE id='${P1}'; UPDATE public.tenants SET credits_remaining=2147483000 WHERE id='${TA}';`},"near max");
 const s1=state(db);
 assert.equal(grant(db,P1,35000,"IQD").reason,"credit_overflow");
 assert.equal(state(db),s1);
});

test("concurrent double call: exactly one grant, the waiter sees already_paid",{skip},async()=>{
 const db=fresh();
 ok(db,{file:MIG},"apply");
 // Deterministic contention: A holds the row lock (call done, txn open) for 1.5 s;
 // B starts while A is open and must block on FOR UPDATE, then see 'paid'.
 const hold=(s)=>`BEGIN;SET LOCAL ROLE service_role;\n${callSql(P1,35000,"IQD")};\nSELECT pg_sleep(${s});\nCOMMIT;`;
 const a=psqlAsync(db,hold(1.5));
 await new Promise(r=>setTimeout(r,500));
 const b=psqlAsync(db,asRole("service_role",callSql(P1,35000,"IQD")));
 const [ra,rb]=await Promise.all([a,b]);
 assert.equal(ra.status,0,ra.stderr);assert.equal(rb.status,0,rb.stderr);
 const ja=JSON.parse(ra.stdout.trim().split("\n")[0]),jb=JSON.parse(rb.stdout.trim());
 assert.equal(ja.reason,"granted");assert.equal(jb.reason,"already_paid");
 assert.ok(rb.ms>=700,`B waited for A's lock (${rb.ms} ms)`);
 assert.equal(bal(db,TA),1005);
 // Burst: 12 simultaneous callers, each holding its transaction briefly.
 const n=12;
 const rs=await Promise.all(Array.from({length:n},()=>psqlAsync(db,hold(0.05).replace(P1,P2).replace("35000","85000"))));
 const reasons=rs.map(r=>{assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim().split("\n")[0]).reason;});
 assert.equal(reasons.filter(x=>x==="granted").length,1,reasons.join(","));
 assert.equal(reasons.filter(x=>x==="already_paid").length,n-1,reasons.join(","));
 assert.equal(bal(db,TA),4005,"85000 package granted exactly once");
 assert.equal(pay(db,P2).credits_granted,3000);
});

test("atomicity: a failure after the claim rolls back the payment AND the balance; a retry then grants once",{skip},()=>{
 const db=fresh();
 ok(db,{file:MIG},"apply");
 const s0=state(db);
 const callErr=()=>{const r=psql(db,{sql:asRole("service_role",callSql(P1,35000,"IQD"))});assert.notEqual(r.status,0,"must raise");return r.stderr;};
 // (1) grant_credits raises after crediting
 ok(db,{sql:`CREATE OR REPLACE FUNCTION public.grant_credits(p_tenant_id uuid, p_credits integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  begin update public.tenants set credits_remaining = credits_remaining + p_credits where id = p_tenant_id; raise exception 'boom'; end; $$;`},"failing gc");
 assert.match(callErr(),/boom/);
 assert.equal(state(db),s0,"payment still created, balance unchanged");
 // (2) grant_credits silently credits nothing -> postcondition raises
 ok(db,{sql:`CREATE OR REPLACE FUNCTION public.grant_credits(p_tenant_id uuid, p_credits integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  begin perform 1; end; $$;`},"noop gc");
 assert.match(callErr(),/tenant balance not credited/);
 assert.equal(state(db),s0);
 // (3) grant_credits credits the WRONG amount -> postcondition raises
 ok(db,{sql:`CREATE OR REPLACE FUNCTION public.grant_credits(p_tenant_id uuid, p_credits integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  begin update public.tenants set credits_remaining = credits_remaining + p_credits * 2 where id = p_tenant_id; end; $$;`},"double gc");
 assert.match(callErr(),/tenant balance not credited/);
 assert.equal(state(db),s0);
 // (4) failure in the payments write (trigger) -> nothing credited
 ok(db,{sql:`CREATE OR REPLACE FUNCTION public.grant_credits(p_tenant_id uuid, p_credits integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  begin update public.tenants set credits_remaining = credits_remaining + p_credits, is_active = true, activated_at = coalesce(activated_at, now()) where id = p_tenant_id; end; $$;
  CREATE FUNCTION public.t_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'payments write failed'; END$$;
  CREATE TRIGGER t_fail BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.t_fail();`},"failing trigger");
 assert.match(callErr(),/payments write failed/);
 assert.equal(state(db),s0);
 // (5) the caller's transaction aborts after a successful call -> both roll back
 ok(db,{sql:`DROP TRIGGER t_fail ON public.payments;`},"drop trigger");
 const r=psql(db,{sql:`BEGIN;SET LOCAL ROLE service_role;\n${callSql(P1,35000,"IQD")};\nSELECT 1/0;\nCOMMIT;`});
 assert.notEqual(r.status,0);
 assert.equal(state(db),s0);
 // retry after the fault is gone: exactly one grant
 assert.equal(grant(db,P1,35000,"IQD").reason,"granted");
 assert.equal(grant(db,P1,35000,"IQD").reason,"already_paid");
 assert.equal(bal(db,TA),1005);
});
