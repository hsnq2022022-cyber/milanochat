// 20261115120000_channel_accounts_hardening: no client writes on
// public.channel_accounts, no browser read of token / metadata columns,
// one tenant per Meta asset (channel, external_id) for instagram / facebook /
// whatsapp (rows with status 'disconnected' excluded, so a soft-disconnected
// asset can be re-linked; needs_reauth still counts), postconditions that
// abort the transaction when a privilege is left behind.
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards), like the other security / flow
// SQL suites. Never connects to any remote host; inherited PG* variables are
// stripped.
// Fixture = the LIVE production shape as reported by the operator: roles
// anon / authenticated / service_role (BYPASSRLS), auth.uid() from
// request.jwt.claim.sub, tenants with its owner policy, channel_accounts with
// the live column list, unique (tenant_id, channel, external_id) and
// (tenant_id, id, platform), the sync_channel_platform trigger (body
// approximated: keeps channel/platform in step), the two live policies
// "users manage their channel accounts" (ALL, authenticated, no WITH CHECK)
// and "users see their channel accounts" (SELECT, authenticated), and
// Supabase's default grants (ALL to anon / authenticated / service_role).
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync,writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";

const MIG="supabase/migrations/20261115120000_channel_accounts_hardening.sql";
const RB="supabase/rollbacks/20261115120000_channel_accounts_hardening.rollback.sql";
const S2="supabase/migrations/20261029240000_tenants_billing_rls.sql";
const MARK="CREATED_BY_20261115120000_CHANNEL_ACCOUNTS_HARDENING";
const IDX="channel_accounts_channel_external_id_global_uq";
const src=f=>readFileSync(f,"utf8");
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");
const SENSITIVE=["access_token","access_token_encrypted","metadata","error_message","scope"];
const SAFE=["id","tenant_id","platform","platform_account_id","account_name","account_avatar","is_active",
 "connected_at","created_at","updated_at","channel","name","status","external_id","display_name","avatar_url",
 "token_expires_at","last_sync_at","page_id","page_name","agent_enabled","auto_reply_enabled","ai_enabled",
 "notify_enabled","auto_reply","language","handoff_rules","agent_config"];

// ---------------------------------------------------------------- static
test("20261115120000: newest migration, one bounded transaction each, no data change, service_role untouched",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).map(f=>f.split("_")[0].padEnd(14,"0"));
 assert.equal(stamps.filter(s=>s==="20261115120000").length,1);
 for(const s of stamps)assert.ok(s<="20261115120000",s);
 assert.ok(existsSync(RB));
 for(const f of [MIG,RB]){
  const s=src(f),code=noComments(s);
  assert.match(s,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\nSET LOCAL search_path = '';\n/m,f);
  assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1,f);
  assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1,f);
  assert.doesNotMatch(code,/CONCURRENTLY|^\s*(TRUNCATE|INSERT|UPDATE|DELETE)\b|SECURITY\s+DEFINER|cron\.|vault\.|net\.http_|sb_secret_|eyJ[A-Za-z0-9_-]{30,}/im,f);
  assert.doesNotMatch(code,/(GRANT|REVOKE)[^;]*service_role/i,`${f}: service_role privileges untouched`);
  assert.doesNotMatch(code,/salla_|widget_/i,`${f}: no Salla / widget objects`);
  assert.ok(code.includes(`v_marker constant text := '${MARK}'`),f);
 }
 const code=noComments(src(MIG));
 assert.match(code,/REVOKE ALL ON TABLE public\.channel_accounts FROM PUBLIC, anon, authenticated;/);
 assert.doesNotMatch(code,/GRANT[^;]*\bTO\s+(anon|PUBLIC)\b/i,"nothing granted to anon / PUBLIC");
 const grant=code.match(/GRANT SELECT \(([^)]*)\) ON TABLE public\.channel_accounts TO authenticated;/);
 assert.ok(grant,"column-level SELECT grant");
 assert.deepEqual(grant[1].split(",").map(x=>x.trim()),SAFE,"exactly the safe columns");
 for(const c of SENSITIVE)assert.ok(!grant[1].split(",").map(x=>x.trim()).includes(c),c);
 assert.match(code,/CREATE UNIQUE INDEX IF NOT EXISTS channel_accounts_channel_external_id_global_uq\n  ON public\.channel_accounts \(channel, external_id\)\n  WHERE external_id IS NOT NULL AND channel IN \('instagram','facebook','whatsapp'\)\n    AND status IS DISTINCT FROM 'disconnected';/);
 // the preflight duplicate count uses the SAME predicate as the index
 assert.match(code,/WHERE external_id IS NOT NULL AND channel IN \('instagram','facebook','whatsapp'\)\n     AND status IS DISTINCT FROM 'disconnected'\n   GROUP BY channel, external_id HAVING count\(\*\) > 1\) d;/);
 // postconditions run AFTER the REVOKE / GRANT, before COMMIT
 const post=code.slice(code.indexOf("DO $post$"));
 assert.ok(code.indexOf("DO $post$")>code.indexOf("REVOKE ALL ON TABLE public.channel_accounts FROM PUBLIC, anon, authenticated;"),"postconditions after the revoke");
 assert.ok(post.indexOf("$post$;")<post.indexOf("COMMIT;"),"postconditions inside the transaction");
 assert.match(post,/FOREACH v_name IN ARRAY ARRAY\['INSERT','UPDATE','DELETE','TRUNCATE'\] LOOP\n  IF has_table_privilege\('authenticated', v_t, v_name\) THEN\n   RAISE EXCEPTION/);
 assert.match(post,/IF has_table_privilege\('anon', v_t, 'SELECT'\) THEN\n  RAISE EXCEPTION/);
 assert.match(post,/FOREACH v_name IN ARRAY ARRAY\['access_token','access_token_encrypted','metadata','error_message','scope'\] LOOP\n  IF has_column_privilege\('authenticated', v_t, v_name, 'SELECT'\) THEN\n   RAISE EXCEPTION/);
 assert.match(post,/IF NOT has_column_privilege\('authenticated', v_t, v_name, 'SELECT'\) THEN\n   RAISE EXCEPTION/);
 assert.match(post,/IF NOT has_table_privilege\('service_role', v_t, 'INSERT'\) THEN\n  RAISE EXCEPTION/);
 // rollback checks marker AND shape (predicate) before dropping the index
 assert.match(noComments(src(RB)),/marked but has an unexpected shape/);
 for(const f of [MIG,RB])assert.ok(noComments(src(f)).includes("'andstatusisdistinctfrom''disconnected'''"),`${f}: predicate in the shape check`);
 assert.match(src(RB),/RE-OPENS the hole/,"rollback header warns");
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
function ok(db,s,label){
 const r=psql(db,s);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return r.stdout.trim();
}
const sqlState=err=>(err.match(/ERROR:\s+([0-9A-Z]{5}):/)??[])[1];
const asSql=(role,stmt,sub)=>`BEGIN;${sub?`SET LOCAL "request.jwt.claim.sub"='${sub}';`:""}SET LOCAL ROLE ${role};\n${stmt}\nCOMMIT;`;
const as=(db,role,stmt,sub)=>psql(db,{sql:asSql(role,stmt,sub)});
function failsWith(db,role,stmt,sub,code,label){
 const r=as(db,role,stmt,sub);
 assert.notEqual(r.status,0,`${label} must fail`);
 assert.equal(sqlState(r.stderr),code,`${label}: ${r.stderr}`);
 return r.stderr;
}
const denied=(db,role,stmt,sub,label)=>failsWith(db,role,stmt,sub,"42501",label);
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
const A_WA="a1000000-0000-4000-8000-000000000001",A_IG="a1000000-0000-4000-8000-000000000002";
const B_FB="b1000000-0000-4000-8000-000000000001",B_SA="b1000000-0000-4000-8000-000000000002";

const USING_LIVE="tenant_id IN (SELECT tenants.id FROM tenants WHERE tenants.user_id = auth.uid())";
const FIXTURE=`
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
 AS $u$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $u$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TABLE public.tenants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, business_name text);
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_owner_all ON public.tenants USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE TABLE public.channel_accounts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 platform text, platform_account_id text, account_name text, account_avatar text, access_token text,
 is_active boolean NOT NULL DEFAULT true, connected_at timestamptz DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 channel text, name text, status text NOT NULL DEFAULT 'active', metadata jsonb DEFAULT '{}'::jsonb,
 access_token_encrypted text, external_id text, display_name text, avatar_url text,
 token_expires_at timestamptz, last_sync_at timestamptz, error_message text, scope text,
 page_id text, page_name text, agent_enabled boolean NOT NULL DEFAULT true,
 auto_reply_enabled boolean DEFAULT true, ai_enabled boolean DEFAULT true, notify_enabled boolean DEFAULT true,
 auto_reply boolean NOT NULL DEFAULT true, language text DEFAULT 'ar',
 handoff_rules jsonb DEFAULT '{}'::jsonb, agent_config jsonb DEFAULT '{}'::jsonb,
 CONSTRAINT channel_accounts_tenant_id_channel_external_id_key UNIQUE (tenant_id, channel, external_id),
 CONSTRAINT channel_accounts_tenant_id_id_platform_key UNIQUE (tenant_id, id, platform));
CREATE INDEX channel_accounts_tenant_idx ON public.channel_accounts (tenant_id, channel);
CREATE FUNCTION public.sync_channel_platform() RETURNS trigger LANGUAGE plpgsql AS $t$
BEGIN
 IF NEW.platform IS NULL THEN NEW.platform := NEW.channel; END IF;
 IF NEW.channel IS NULL THEN NEW.channel := NEW.platform; END IF;
 RETURN NEW;
END $t$;
CREATE TRIGGER sync_channel_platform BEFORE INSERT OR UPDATE ON public.channel_accounts
 FOR EACH ROW EXECUTE FUNCTION public.sync_channel_platform();
ALTER TABLE public.channel_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage their channel accounts" ON public.channel_accounts FOR ALL TO authenticated
 USING (${USING_LIVE});
CREATE POLICY "users see their channel accounts" ON public.channel_accounts FOR SELECT TO authenticated
 USING (${USING_LIVE});
-- Supabase default privileges.
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
INSERT INTO public.tenants(id,user_id,business_name) VALUES ('${A}','${UA}','A'),('${B}','${UB}','B');
INSERT INTO public.channel_accounts(id,tenant_id,channel,external_id,access_token_encrypted,metadata,error_message,scope,access_token) VALUES
 ('${A_WA}','${A}','whatsapp','1000001','enc-a','{"k":"a"}','err-a','scope-a','tok-a'),
 ('${A_IG}','${A}','instagram','1784000001','enc-a2','{}',NULL,NULL,NULL),
 ('${B_FB}','${B}','facebook','200000001','enc-b','{"k":"b"}','err-b','scope-b','tok-b'),
 ('${B_SA}','${B}','salla','1000001',NULL,'{}',NULL,NULL,NULL);
`;
// Effective table / column ACLs, RLS flag, policies, indexes and their comments.
const SNAP=`SELECT string_agg(x,E'\\n' ORDER BY x) FROM (
 SELECT 'r:'||c.relname||':'||(SELECT string_agg(i::text,',' ORDER BY i::text) FROM unnest(coalesce(c.relacl,acldefault('r',c.relowner))) i)||':'||c.relrowsecurity FROM pg_class c
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
 UNION ALL SELECT 'a:'||attname||':'||coalesce((SELECT string_agg(i::text,',' ORDER BY i::text) FROM unnest(attacl) i),'') FROM pg_attribute
  WHERE attrelid='public.channel_accounts'::regclass AND attnum>0 AND NOT attisdropped
 UNION ALL SELECT 'p:'||tablename||':'||policyname||':'||permissive||':'||cmd||':'||roles::text||':'||coalesce(qual,'')||':'||coalesce(with_check,'')
  FROM pg_policies WHERE schemaname='public'
 UNION ALL SELECT 'pc:'||polname||':'||coalesce(obj_description(oid,'pg_policy'),'') FROM pg_policy
 UNION ALL SELECT 'i:'||indexdef||':'||coalesce(obj_description((schemaname||'.'||indexname)::regclass,'pg_class'),'') FROM pg_indexes WHERE schemaname='public'
) s(x)`;
const clientAcl=db=>val(db,`(SELECT coalesce(string_agg(x,',' ORDER BY x),'') FROM (
 SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END||'='||a.privilege_type
  FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
 WHERE c.oid='public.channel_accounts'::regclass AND (a.grantee=0 OR a.grantee::regrole::text IN ('anon','authenticated'))) s(x))`);
const colAcl=(db,role)=>val(db,`(SELECT coalesce(string_agg(att.attname||'='||a.privilege_type,',' ORDER BY att.attnum),'')
 FROM pg_attribute att, aclexplode(att.attacl) a
 WHERE att.attrelid='public.channel_accounts'::regclass AND att.attnum>0 AND a.grantee=${role==="PUBLIC"?"0":`'${role}'::regrole`})`);
const SAFE_SEL=`SELECT string_agg(${SAFE.map(c=>`coalesce(${c}::text,'')`).join("||'|'||")},E'\\n' ORDER BY id) FROM public.channel_accounts`;

before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"sec-ca-"));
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

test("OLD (live) behaviour is exploitable — proves the tests below detect it",{skip},()=>{
 const db=fresh();
 assert.equal(allowed(db,"authenticated",`UPDATE public.channel_accounts SET external_id='999' WHERE id='${A_WA}' RETURNING 1;`,UA),"1","owner re-points external_id");
 assert.equal(allowed(db,"authenticated",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${A}','facebook','200000001') RETURNING 1;`,UA),"1","owner claims tenant B's page id");
 assert.equal(allowed(db,"authenticated",`SELECT access_token_encrypted FROM public.channel_accounts WHERE id='${A_WA}';`,UA),"enc-a","owner reads the token column");
 assert.equal(allowed(db,"authenticated",`DELETE FROM public.channel_accounts WHERE id='${A_IG}' RETURNING 1;`,UA),"1");
});

test("(a)(b) owner: no INSERT/UPDATE/DELETE, safe columns of own rows only, no token columns; anon nothing",{skip},()=>{
 const db=fresh();
 ok(db,{file:MIG},"apply");
 // writes
 denied(db,"authenticated",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${A}','facebook','300');`,UA,"owner INSERT");
 denied(db,"authenticated",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${A}','whatsapp','1000001') ON CONFLICT (tenant_id,channel,external_id) DO UPDATE SET status='active';`,UA,"owner UPSERT");
 denied(db,"authenticated",`UPDATE public.channel_accounts SET external_id='999' WHERE id='${A_WA}';`,UA,"owner UPDATE external_id");
 denied(db,"authenticated",`UPDATE public.channel_accounts SET agent_enabled=false WHERE id='${A_WA}';`,UA,"owner UPDATE settings");
 denied(db,"authenticated",`DELETE FROM public.channel_accounts WHERE id='${A_WA}';`,UA,"owner DELETE");
 denied(db,"authenticated",`TRUNCATE public.channel_accounts;`,UA,"owner TRUNCATE");
 // reads
 assert.equal(allowed(db,"authenticated",`SELECT string_agg(id::text||':'||channel||':'||external_id||':'||status,',' ORDER BY id) FROM public.channel_accounts;`,UA),
  `${A_WA}:whatsapp:1000001:active,${A_IG}:instagram:1784000001:active`,"own rows, safe columns");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM (${SAFE_SEL}) s;`,UA),"1","every safe column selectable");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.channel_accounts;`,UA),"2");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.channel_accounts WHERE tenant_id='${B}';`,UA),"0","tenant B invisible to A");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.channel_accounts;`,UB),"2","B sees its own two");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.channel_accounts;`),"0","no uid: nothing");
 for(const c of SENSITIVE)denied(db,"authenticated",`SELECT ${c} FROM public.channel_accounts WHERE id='${A_WA}';`,UA,`owner SELECT ${c}`);
 denied(db,"authenticated",`SELECT * FROM public.channel_accounts;`,UA,"owner SELECT *");
 denied(db,"authenticated",`SELECT to_jsonb(ca) FROM public.channel_accounts ca;`,UA,"owner whole-row");
 // anon
 denied(db,"anon",`SELECT id FROM public.channel_accounts;`,null,"anon SELECT");
 denied(db,"anon",`SELECT count(*) FROM public.channel_accounts;`,null,"anon count");
 denied(db,"anon",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${A}','facebook','300');`,null,"anon INSERT");
 denied(db,"anon",`UPDATE public.channel_accounts SET status='active';`,null,"anon UPDATE");
 denied(db,"anon",`DELETE FROM public.channel_accounts;`,null,"anon DELETE");
 // exact privilege picture
 assert.equal(clientAcl(db),"","no table-level privilege for PUBLIC / anon / authenticated");
 assert.equal(colAcl(db,"authenticated"),SAFE.map(c=>`${c}=SELECT`).join(","),"authenticated: SELECT on the safe columns only");
 assert.equal(colAcl(db,"anon"),"");assert.equal(colAcl(db,"PUBLIC"),"");
 assert.equal(val(db,`(SELECT string_agg(policyname||':'||cmd||':'||roles::text||':'||coalesce(qual,'')||':'||coalesce(with_check,''),',') FROM pg_policies WHERE tablename='channel_accounts')`),
  "users see their channel accounts:SELECT:{authenticated}:(tenant_id IN ( SELECT tenants.id\n   FROM tenants\n  WHERE (tenants.user_id = auth.uid()))):","only the live read policy remains (untouched)");
 assert.equal(val(db,`obj_description((SELECT oid FROM pg_policy WHERE polname='users see their channel accounts'),'pg_policy') IS NULL`),"t","pre-existing read policy not marked");
});

test("(c) service_role keeps connect / upsert / settings / disconnect and token reads",{skip},()=>{
 const db=fresh();
 const svcBefore=val(db,`(SELECT string_agg(a.privilege_type,',' ORDER BY a.privilege_type) FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid='public.channel_accounts'::regclass AND a.grantee='service_role'::regrole)`);
 ok(db,{file:MIG},"apply");
 assert.equal(val(db,`(SELECT string_agg(a.privilege_type,',' ORDER BY a.privilege_type) FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid='public.channel_accounts'::regclass AND a.grantee='service_role'::regrole)`),svcBefore,"service_role ACL unchanged");
 assert.equal(allowed(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id,access_token_encrypted) VALUES('${A}','facebook','300000001','enc') RETURNING platform;`),"facebook","connect (trigger fills platform)");
 assert.equal(allowed(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id,access_token_encrypted,status) VALUES('${A}','facebook','300000001','enc2','active')
  ON CONFLICT (tenant_id,channel,external_id) DO UPDATE SET access_token_encrypted=EXCLUDED.access_token_encrypted RETURNING access_token_encrypted;`),"enc2","re-connect upsert");
 assert.equal(allowed(db,"service_role",`UPDATE public.channel_accounts SET agent_enabled=false, auto_reply=false WHERE id='${A_WA}' RETURNING agent_enabled;`),"f","settings");
 assert.equal(allowed(db,"service_role",`SELECT access_token_encrypted||metadata::text||error_message||scope||access_token FROM public.channel_accounts WHERE id='${A_WA}';`),'enc-a{"k": "a"}err-ascope-atok-a');
 assert.equal(allowed(db,"service_role",`SELECT count(*) FROM (SELECT to_jsonb(ca) FROM public.channel_accounts ca) s;`),"5","SECURITY INVOKER flow functions (to_jsonb(ca)) still work as service_role");
 assert.equal(allowed(db,"service_role",`DELETE FROM public.channel_accounts WHERE tenant_id='${A}' AND channel='facebook' RETURNING 1;`),"1","disconnect");
});

test("(d) global unique (channel, external_id) for instagram/facebook/whatsapp only",{skip},()=>{
 const db=fresh();
 ok(db,{file:MIG},"apply");
 assert.equal(val(db,`pg_get_indexdef('public.${IDX}'::regclass)`),
  `CREATE UNIQUE INDEX ${IDX} ON public.channel_accounts USING btree (channel, external_id) WHERE ((external_id IS NOT NULL) AND (channel = ANY (ARRAY['instagram'::text, 'facebook'::text, 'whatsapp'::text])) AND (status IS DISTINCT FROM 'disconnected'::text))`);
 for(const [ch,ext] of [["whatsapp","1000001"],["facebook","200000001"],["instagram","1784000001"]])
  failsWith(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${ch==="facebook"?A:B}','${ch}','${ext}');`,null,"23505",`${ch} in another tenant`);
 failsWith(db,"service_role",`UPDATE public.channel_accounts SET external_id='1000001', channel='whatsapp' WHERE id='${B_FB}';`,null,"23505","re-point B's row onto A's phone id");
 assert.equal(allowed(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id,status) VALUES('${A}','whatsapp','1000001','needs_reauth')
  ON CONFLICT (tenant_id,channel,external_id) DO UPDATE SET status=EXCLUDED.status RETURNING status;`),"needs_reauth","same-tenant upsert still works");
 assert.equal(allowed(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${A}','salla','1000001') RETURNING 1;`),"1","salla rows excluded (A salla = A whatsapp id = B salla id)");
 assert.equal(allowed(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${A}','instagram',NULL),('${B}','instagram',NULL),('${B}','instagram',NULL) RETURNING 1;`),"1\n1\n1","NULL external_id unaffected");
 assert.equal(allowed(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${A}','whatsapp','200000001') RETURNING 1;`),"1","same id on a different channel is fine");
});

test("(e) preflight: duplicates abort with a count-only message, state unchanged",{skip},()=>{
 const db=fresh();
 ok(db,{sql:`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES ('${B}','whatsapp','1000001'),('${A}','facebook','200000001');`},"seed dups");
 const pre=val(db,SNAP);
 const r=psql(db,{file:MIG});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/channel_accounts has 2 duplicate \(channel, external_id\) group\(s\) for instagram\/facebook\/whatsapp \(status not disconnected\); resolve them before applying 20261115120000/);
 assert.doesNotMatch(r.stderr,/1000001|200000001|[0-9a-f]{8}-[0-9a-f]{4}-/,"no external id or row id leaked");
 assert.equal(val(db,SNAP),pre,"nothing changed");
 // Salla / NULL duplicates do not trip the preflight.
 const d2=fresh();
 ok(d2,{sql:`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES ('${A}','salla','1000001'),('${A}','instagram',NULL),('${B}','instagram',NULL);`},"salla/null");
 ok(d2,{file:MIG},"apply with salla / NULL repeats");
 // A disconnected duplicate is outside the predicate; a needs_reauth one is not.
 const d3=fresh();
 ok(d3,{sql:`INSERT INTO public.channel_accounts(tenant_id,channel,external_id,status) VALUES ('${B}','whatsapp','1000001','disconnected');`},"disconnected dup");
 ok(d3,{file:MIG},"apply with a disconnected repeat");
 const d4=fresh();
 ok(d4,{sql:`INSERT INTO public.channel_accounts(tenant_id,channel,external_id,status) VALUES ('${B}','whatsapp','1000001','needs_reauth');`},"needs_reauth dup");
 const pre4=val(d4,SNAP);
 const r4=psql(d4,{file:MIG});
 assert.notEqual(r4.status,0,"needs_reauth duplicate refused");
 assert.match(r4.stderr,/channel_accounts has 1 duplicate \(channel, external_id\) group\(s\)/);
 assert.equal(val(d4,SNAP),pre4,"nothing changed");
});

test("(i) disconnect / re-link: a disconnected row neither blocks nor counts; needs_reauth blocks; same-tenant reconnect flips the same row",{skip},()=>{
 const db=fresh();
 ok(db,{file:MIG},"apply");
 // Disconnect = channels/index.ts soft delete: status='disconnected', external_id kept.
 assert.equal(allowed(db,"service_role",`UPDATE public.channel_accounts SET status='disconnected' WHERE id='${A_WA}' RETURNING external_id;`),"1000001","A disconnects (external_id kept)");
 const bRow=allowed(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id,status) VALUES('${B}','whatsapp','1000001','active')
  ON CONFLICT (tenant_id,channel,external_id) DO UPDATE SET status='active' RETURNING id;`);
 assert.match(bRow,/^[0-9a-f-]{36}$/,"B links the id A disconnected");
 // A reconnects while B holds a non-disconnected row -> 23505 on the global index (by name).
 const e=failsWith(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id,status) VALUES('${A}','whatsapp','1000001','active')
  ON CONFLICT (tenant_id,channel,external_id) DO UPDATE SET status='active';`,null,"23505","A reconnect while B holds the id");
 assert.match(e,new RegExp(IDX),"violation names the global index");
 // B disconnects; A's reconnect now flips A's SAME row back to active.
 ok(db,{sql:`UPDATE public.channel_accounts SET status='disconnected' WHERE id='${bRow}';`},"B disconnects");
 assert.equal(allowed(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id,status) VALUES('${A}','whatsapp','1000001','active')
  ON CONFLICT (tenant_id,channel,external_id) DO UPDATE SET status=EXCLUDED.status RETURNING id||':'||status;`),`${A_WA}:active`,"same-tenant reconnect: same row, active");
 // needs_reauth still counts: A's instagram row blocks B.
 ok(db,{sql:`UPDATE public.channel_accounts SET status='needs_reauth' WHERE id='${A_IG}';`},"A needs_reauth");
 const e2=failsWith(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${B}','instagram','1784000001');`,null,"23505","needs_reauth row blocks another tenant");
 assert.match(e2,new RegExp(IDX));
 // NULL status counts too.
 ok(db,{sql:`ALTER TABLE public.channel_accounts ALTER COLUMN status DROP NOT NULL; UPDATE public.channel_accounts SET status=NULL WHERE id='${A_IG}';`},"A status NULL");
 failsWith(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${B}','instagram','1784000001');`,null,"23505","NULL status row blocks another tenant");
 // The per-tenant constraint still raises its OWN name (not the global index).
 const e3=failsWith(db,"service_role",`INSERT INTO public.channel_accounts(tenant_id,channel,external_id) VALUES('${A}','whatsapp','1000001');`,null,"23505","per-tenant duplicate");
 assert.match(e3,/channel_accounts_tenant_id_channel_external_id_key/);
 assert.doesNotMatch(e3,new RegExp(IDX));
});

test("(j) postconditions: a left-behind privilege aborts the whole migration (mutations of the migration file)",{skip},()=>{
 const m=src(MIG);
 const muts=[
  ["REVOKE skipped","REVOKE ALL ON TABLE public.channel_accounts FROM PUBLIC, anon, authenticated;\n","",/postcondition failed: authenticated still has INSERT/],
  ["anon kept SELECT","REVOKE ALL ON TABLE public.channel_accounts FROM PUBLIC, anon, authenticated;\n","REVOKE ALL ON TABLE public.channel_accounts FROM PUBLIC, authenticated;\n",/postcondition failed: anon still has SELECT/],
  ["token column granted"," handoff_rules, agent_config) ON TABLE public.channel_accounts TO authenticated;"," handoff_rules, agent_config, scope) ON TABLE public.channel_accounts TO authenticated;",/postcondition failed: authenticated can still SELECT public\.channel_accounts\.scope/],
  ["safe column not granted","  handoff_rules, agent_config) ON TABLE","  handoff_rules) ON TABLE",/postcondition failed: authenticated cannot SELECT public\.channel_accounts\.agent_config/]];
 for(const [label,from,to,re] of muts){
  assert.equal(m.split(from).length,2,label);
  const f=join(dir,`mut-${label.replace(/\W+/g,"_")}.sql`);writeFileSync(f,m.replace(from,to));
  const db=fresh();
  const b=val(db,SNAP);
  const r=psql(db,{file:f});
  assert.notEqual(r.status,0,`${label}: aborts`);
  assert.match(r.stderr,re,label);
  assert.equal(val(db,SNAP),b,`${label}: transaction rolled back, nothing changed`);
 }
 // service_role without INSERT (pre-existing state) -> aborts too.
 const db=fresh();
 ok(db,{sql:"REVOKE INSERT ON public.channel_accounts FROM service_role;"},"svc no insert");
 const b=val(db,SNAP);
 const r=psql(db,{file:MIG});
 assert.notEqual(r.status,0);assert.match(r.stderr,/postcondition failed: service_role lost INSERT/);
 assert.equal(val(db,SNAP),b);
});

test("(f) re-apply is a no-op; (g) rollback restores the exact live state, twice; re-apply after rollback",{skip},()=>{
 const db=fresh();
 const pre=val(db,SNAP);
 const preAcl=clientAcl(db);
 ok(db,{file:MIG},"apply");
 const post=val(db,SNAP);
 assert.notEqual(post,pre);
 assert.match(val(db,`obj_description('public.${IDX}'::regclass,'pg_class')`),new RegExp(`^${MARK}\\|\\{`));
 ok(db,{file:MIG},"re-apply");
 assert.equal(val(db,SNAP),post,"re-apply is a no-op (grants, policies, index, recorded state)");
 ok(db,{file:RB},"rollback");
 assert.equal(val(db,SNAP),pre,"exact previous state");
 assert.equal(preAcl,["anon","authenticated"].flatMap(r=>["DELETE","INSERT","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"].map(p=>`${r}=${p}`)).join(","),"live: every table privilege to anon and authenticated");
 assert.equal(clientAcl(db),preAcl);
 assert.equal(val(db,`to_regclass('public.${IDX}') IS NULL`),"t","index gone");
 assert.equal(val(db,`(SELECT cmd||':'||roles::text||':'||coalesce(with_check,'-') FROM pg_policies WHERE policyname='users manage their channel accounts')`),"ALL:{authenticated}:-");
 assert.equal(allowed(db,"authenticated",`UPDATE public.channel_accounts SET agent_enabled=false WHERE id='${A_WA}' RETURNING 1;`,UA),"1","owner writes allowed again (hole re-opened)");
 assert.equal(allowed(db,"authenticated",`SELECT access_token_encrypted FROM public.channel_accounts WHERE id='${A_WA}';`,UA),"enc-a");
 const r=psql(db,{file:RB});
 assert.equal(r.status,0,r.stderr);
 assert.match(r.stderr,/not installed \(or already rolled back\); nothing to do/);
 assert.equal(val(db,SNAP),pre,"second rollback is a no-op");
 ok(db,{sql:`UPDATE public.channel_accounts SET agent_enabled=true WHERE id='${A_WA}';`},"reset row");
 ok(db,{file:MIG},"re-apply after rollback");
 assert.equal(val(db,SNAP),post,"same hardened state again");
});

test("missing read policy is created (marked) and dropped by the rollback; repo policy channel_accounts_owner is dropped and restored",{skip},()=>{
 const db=fresh();
 ok(db,{sql:`DROP POLICY "users see their channel accounts" ON public.channel_accounts;
  CREATE POLICY channel_accounts_owner ON public.channel_accounts FOR ALL
   USING (tenant_id IN (SELECT id FROM public.tenants WHERE user_id = auth.uid()))
   WITH CHECK (tenant_id IN (SELECT id FROM public.tenants WHERE user_id = auth.uid()));
  GRANT UPDATE (status) ON public.channel_accounts TO anon;`},"variant");
 const pre=val(db,SNAP);
 ok(db,{file:MIG},"apply");
 assert.equal(val(db,`(SELECT string_agg(policyname||':'||cmd||':'||roles::text,',') FROM pg_policies WHERE tablename='channel_accounts')`),"users see their channel accounts:SELECT:{authenticated}");
 assert.equal(val(db,`obj_description((SELECT oid FROM pg_policy WHERE polname='users see their channel accounts'),'pg_policy')`),MARK);
 assert.match(val(db,`(SELECT qual FROM pg_policies WHERE policyname='users see their channel accounts')`),/\( SELECT auth\.uid\(\) AS uid\)/,"(select auth.uid()) form");
 assert.equal(colAcl(db,"anon"),"","column grants of anon removed");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.channel_accounts;`,UA),"2");
 assert.equal(allowed(db,"authenticated",`SELECT count(*) FROM public.channel_accounts WHERE tenant_id='${B}';`,UA),"0");
 denied(db,"authenticated",`UPDATE public.channel_accounts SET status='active' WHERE id='${A_WA}';`,UA,"owner UPDATE");
 const post=val(db,SNAP);
 ok(db,{file:MIG},"re-apply");assert.equal(val(db,SNAP),post);
 ok(db,{file:RB},"rollback");
 assert.equal(val(db,SNAP),pre,"exact previous state incl. column grant and repo policy");
});

test("(h) refusals: foreign index, altered read policy, unknown policy, RLS off, missing column",{skip},()=>{
 for(const [label,sql,re,rbToo] of [
  ["foreign index",`CREATE UNIQUE INDEX ${IDX} ON public.channel_accounts (channel, external_id);`,/exists without marker/,true],
  ["foreign index with comment",`CREATE UNIQUE INDEX ${IDX} ON public.channel_accounts (channel, external_id); COMMENT ON INDEX public.${IDX} IS 'hand made';`,/exists without marker/,true],
  ["marked index, other shape",`CREATE UNIQUE INDEX ${IDX} ON public.channel_accounts (external_id, channel) WHERE external_id IS NOT NULL; COMMENT ON INDEX public.${IDX} IS '${MARK}|{}';`,/marked but has an unexpected shape/,false],
  ["marked index, predicate without the disconnected exclusion",`CREATE UNIQUE INDEX ${IDX} ON public.channel_accounts (channel, external_id) WHERE external_id IS NOT NULL AND channel IN ('instagram','facebook','whatsapp'); COMMENT ON INDEX public.${IDX} IS '${MARK}|{"table_acl":[],"column_acl":[],"policies":[],"see_created":false}';`,/marked but has an unexpected shape/,"shape"],
  ["broad read policy",`DROP POLICY "users see their channel accounts" ON public.channel_accounts; CREATE POLICY "users see their channel accounts" ON public.channel_accounts FOR SELECT TO authenticated USING (true);`,/unexpected definition/,false],
  ["read policy for anon",`ALTER POLICY "users see their channel accounts" ON public.channel_accounts TO anon, authenticated;`,/unexpected definition/,false],
  ["unknown policy",`CREATE POLICY staff_read ON public.channel_accounts FOR SELECT TO authenticated USING (true);`,/unexpected policy staff_read/,false],
  ["rls off",`ALTER TABLE public.channel_accounts DISABLE ROW LEVEL SECURITY;`,/Row level security is not enabled/,false],
  ["missing column",`ALTER TABLE public.channel_accounts DROP COLUMN page_name;`,/column public\.channel_accounts\.page_name/,false]]){
  const db=fresh();
  ok(db,{sql},label);
  const b=val(db,SNAP);
  const r=psql(db,{file:MIG});
  assert.notEqual(r.status,0,label);assert.match(r.stderr,re,label);
  assert.equal(val(db,SNAP),b,`${label}: unchanged`);
  if(rbToo){
   const x=psql(db,{file:RB});
   assert.notEqual(x.status,0,`${label}: rollback refuses`);
   assert.match(x.stderr,rbToo==="shape"?/marked but has an unexpected shape/:/Refusing to drop unrecognized index/,label);
   assert.equal(val(db,SNAP),b,`${label}: rollback changed nothing`);
  }
 }
 // rollback refuses a created read policy that lost its marker
 const db=fresh();
 ok(db,{sql:`DROP POLICY "users see their channel accounts" ON public.channel_accounts;`},"no read policy");
 ok(db,{file:MIG},"apply");
 ok(db,{sql:`COMMENT ON POLICY "users see their channel accounts" ON public.channel_accounts IS NULL;`},"unmark");
 const b=val(db,SNAP);
 const x=psql(db,{file:RB});
 assert.notEqual(x.status,0);assert.match(x.stderr,/its marker is missing/);
 assert.equal(val(db,SNAP),b,"rollback rolled back");
});

test("interplay with the unapplied 20261029240000 channel_accounts statements, either order",{skip},()=>{
 const s2=noComments(src(S2));
 const stmts=["REVOKE INSERT, UPDATE, DELETE ON TABLE public.channel_accounts FROM PUBLIC, anon, authenticated;",
  "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_accounts TO service_role;"];
 for(const x of stmts)assert.ok(s2.includes(x),x);
 const ref=fresh();ok(ref,{file:MIG},"apply");const hardened=val(ref,SNAP);
 const before240=fresh();ok(before240,{sql:stmts.join("\n")},"240000 first");ok(before240,{file:MIG},"then 20261115120000");
 const noState=x=>x.replace(new RegExp(`${MARK}\\|[^\n]*`,"g"),MARK);
 assert.equal(noState(val(before240,SNAP)),noState(hardened),"same hardened state (only the recorded previous state differs)");
 assert.equal(clientAcl(before240),"");assert.equal(colAcl(before240,"authenticated"),colAcl(ref,"authenticated"));
 const after240=fresh();ok(after240,{file:MIG},"20261115120000 first");ok(after240,{sql:stmts.join("\n")},"then 240000");
 assert.equal(val(after240,SNAP),hardened,"240000 statements after this migration change nothing");
 // Rollback after 240000-first restores the 240000 state (writes stay revoked).
 ok(before240,{file:RB},"rollback");
 assert.doesNotMatch(clientAcl(before240),/=(INSERT|UPDATE|DELETE)\b/,"240000's revokes preserved");
 assert.match(clientAcl(before240),/authenticated=SELECT/);
});
