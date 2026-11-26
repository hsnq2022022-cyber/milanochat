// tenant-admin handler: authentication, admin allowlist, validation, operator identity, RPC wiring and error mapping.
// Mocks only (in-memory client): no network, no database, no secrets.
// Run: node --experimental-strip-types --test tests/tenant-admin-handler.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {handleTenantAdmin,ORIGIN,type Db} from "../supabase/functions/tenant-admin/handler.ts";

const ADMIN="11111111-1111-4111-8111-111111111111",USER="22222222-2222-4222-8222-222222222222";
const T="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
type Call={fn:string;args:Record<string,unknown>};
function harness(opts:{admins?:string|undefined;rpc?:(fn:string,a:any)=>any;tenants?:any[];actions?:any[]}={}){
 const rpcCalls:Call[]=[];const queries:string[][]=[];
 const db:Db={
  auth:{getUser:async(jwt:string)=>({data:{user:jwt==="jwt-admin"?{id:ADMIN}:jwt==="jwt-user"?{id:USER}:null},error:null})},
  rpc:async(fn,args)=>{rpcCalls.push({fn,args});return {data:opts.rpc?opts.rpc(fn,args):{ok:true,balance:10,duplicate:false},error:null};},
  from:(t:string)=>{
   const log=[t];queries.push(log);
   const q:any={select:()=>q,ilike:(c:string,v:string)=>{log.push(`ilike:${c}:${v}`);return q;},eq:(c:string,v:string)=>{log.push(`eq:${c}:${v}`);return q;},
    order:()=>q,limit:async(n:number)=>{log.push(`limit:${n}`);return {data:t==="tenants"?(opts.tenants??[]):(opts.actions??[]),error:null};}};
   return q;}
 };
 const env={SUPABASE_URL:"http://x.invalid",SUPABASE_SERVICE_ROLE_KEY:"service-test",TENANT_ADMIN_USER_IDS:"admins" in opts?opts.admins:ADMIN} as Record<string,string|undefined>;
 return {rpcCalls,queries,call:(body:unknown,token="jwt-admin",over:{origin?:string|null;method?:string}={})=>
  handleTenantAdmin(new Request("http://x.invalid/functions/v1/tenant-admin",{method:over.method??"POST",
   headers:{...(over.origin===null?{}:{origin:over.origin??ORIGIN}),"content-type":"application/json",
    ...(token?{authorization:"Bearer "+token}:{})},body:(over.method??"POST")==="POST"?JSON.stringify(body):undefined}),
   {env:k=>env[k],db:()=>db})};
}
const adjust=(o:Record<string,unknown>={})=>({action:"adjust_credits",tenantId:T,delta:100,reason:"payment confirmed outside",idempotencyKey:"key-12345678",...o});

test("transport: foreign origin 403, OPTIONS 204, GET 405, missing/invalid bearer 401 - before any database access",async()=>{
 const h=harness();
 assert.equal((await h.call(adjust(),"jwt-admin",{origin:"https://evil.example"})).status,403);
 assert.equal((await h.call(adjust(),"jwt-admin",{origin:null})).status,403);
 assert.equal((await h.call({},"jwt-admin",{method:"OPTIONS"})).status,204);
 assert.equal((await h.call({},"jwt-admin",{method:"GET"})).status,405);
 assert.equal((await h.call(adjust(),"")).status,401);
 assert.equal((await h.call(adjust(),"jwt-forged")).status,401);
 assert.equal(h.rpcCalls.length+h.queries.length,0);
});

test("authorisation: a signed-in non-admin gets one generic 403 on every action and can only ask whoami; unset/malformed allowlist denies everyone",async()=>{
 const h=harness();
 assert.deepEqual(await (await h.call({action:"whoami"},"jwt-user")).json(),{ok:true,admin:false});
 for(const b of [{action:"list_tenants"},{action:"ledger",tenantId:T},adjust(),{action:"set_active",tenantId:T,active:true,reason:"abc",idempotencyKey:"key-12345678"},{action:"nope"},{}]){
  const r=await h.call(b,"jwt-user");assert.equal(r.status,403);assert.deepEqual(await r.json(),{error:"Admin access required"});
 }
 assert.equal(h.rpcCalls.length+h.queries.length,0,"no database access for a non-admin");
 for(const admins of [undefined,"","not-a-uuid",ADMIN+",garbage",ADMIN+","]){
  const x=harness({admins});
  assert.deepEqual(await (await x.call({action:"whoami"})).json(),{ok:true,admin:false},String(admins));
  assert.equal((await x.call(adjust())).status,403);assert.equal(x.rpcCalls.length,0);
 }
 assert.deepEqual(await (await harness().call({action:"whoami"})).json(),{ok:true,admin:true});
});

test("no identity spoofing: the operator id is the verified user, never a body field; tenant ids must be UUIDs",async()=>{
 const h=harness();
 const r=await h.call(adjust({operatorId:USER,operator_id:USER,userId:USER,p_operator:USER,admin:true}));
 assert.equal(r.status,200);
 assert.equal(h.rpcCalls[0].fn,"admin_adjust_credits");
 assert.deepEqual(h.rpcCalls[0].args,{p_tenant:T,p_operator:ADMIN,p_delta:100,p_reason:"payment confirmed outside",p_key:"key-12345678"});
 for(const t of ["x","1","' OR 1=1 --",undefined,123,T+"x"]){
  const bad=await h.call(adjust({tenantId:t}));assert.equal(bad.status,400,String(t));
 }
 assert.equal(h.rpcCalls.length,1);
});

test("validation: amount, reason, key and state are strict; nothing reaches the database when invalid",async()=>{
 const h=harness();
 for(const d of [0,1.5,"100",null,NaN,1_000_001,-1_000_001,Infinity,undefined])
  assert.equal((await h.call(adjust({delta:d}))).status,400,String(d));
 for(const reason of ["","  ","ab",undefined,5,"x".repeat(501)])assert.equal((await h.call(adjust({reason}))).status,400,String(reason));
 for(const k of ["","short","has space 123456","x".repeat(101),undefined,7,"bad/slash/key"])assert.equal((await h.call(adjust({idempotencyKey:k}))).status,400,String(k));
 const act={action:"set_active",tenantId:T,reason:"payment confirmed",idempotencyKey:"key-12345678"};
 for(const a of ["true",1,null,undefined])assert.equal((await h.call({...act,active:a})).status,400,String(a));
 assert.equal(h.rpcCalls.length,0);
 assert.equal((await h.call(adjust({delta:-250}))).status,200);
 assert.equal(h.rpcCalls[0].args.p_delta,-250);
 assert.equal((await h.call({...act,active:false})).status,200);
 assert.deepEqual(h.rpcCalls[1],{fn:"admin_set_tenant_active",args:{p_tenant:T,p_operator:ADMIN,p_active:false,p_reason:"payment confirmed",p_key:"key-12345678"}});
});

test("body limits: oversized and malformed bodies are rejected",async()=>{
 const h=harness();
 assert.equal((await h.call(adjust({reason:"x".repeat(5000)}))).status,413);
 const raw=await handleTenantAdmin(new Request("http://x.invalid",{method:"POST",headers:{origin:ORIGIN,authorization:"Bearer jwt-admin"},body:"{not json"}),
  {env:k=>({SUPABASE_URL:"u",SUPABASE_SERVICE_ROLE_KEY:"k",TENANT_ADMIN_USER_IDS:ADMIN} as any)[k],db:()=>({}) as any});
 assert.equal(raw.status,400);
 const arr=await h.call([1,2,3]);assert.equal(arr.status,400);
 assert.equal(h.rpcCalls.length,0);
});

test("RPC results map to stable statuses: duplicate and success 200, insufficient balance / idempotency conflict 409, unknown tenant 404, RPC failure 503 without internals",async()=>{
 const results:Array<[any,number]>=[[{ok:true,duplicate:true,balance:7},200],[{ok:false,error:"insufficient_balance",balance:3},409],
  [{ok:false,error:"idempotency_conflict"},409],[{ok:false,error:"tenant_not_found"},404],[{ok:false,error:"invalid_arguments"},400]];
 for(const [res,status] of results){
  const h=harness({rpc:()=>res});const r=await h.call(adjust());
  assert.equal(r.status,status,JSON.stringify(res));
  const b=await r.json();assert.equal(b.ok??false,res.ok===true);
 }
 const failing:Db={auth:{getUser:async()=>({data:{user:{id:ADMIN}},error:null})},from:()=>({}),
  rpc:async()=>({data:null,error:{message:"relation \"secret_table\" does not exist",code:"42P01"}})};
 const r=await handleTenantAdmin(new Request("http://x.invalid",{method:"POST",headers:{origin:ORIGIN,authorization:"Bearer j"},body:JSON.stringify(adjust())}),
  {env:k=>({SUPABASE_URL:"u",SUPABASE_SERVICE_ROLE_KEY:"service-secret",TENANT_ADMIN_USER_IDS:ADMIN} as any)[k],db:()=>failing});
 assert.equal(r.status,503);
 const text=await r.text();assert.ok(!text.includes("secret_table")&&!text.includes("42P01")&&!text.includes("service-secret"));
});

test("reads: list_tenants is bounded and escapes the search; ledger is scoped to the requested tenant; responses carry no secrets",async()=>{
 const h=harness({tenants:[{id:T,business_name:"Shop",is_active:true,credits_remaining:5,created_at:"2026-11-01"}],
  actions:[{id:"1",action:"credit_grant",amount:100,balance_after:105,reason:"r",operator_id:ADMIN,created_at:"2026-11-02"}]});
 const l=await (await h.call({action:"list_tenants",search:"  50%,_(x)\\ ",limit:9999})).json();
 assert.deepEqual(l.tenants.map((t:any)=>t.id),[T]);
 assert.ok(h.queries[0].includes("limit:50"),"an out-of-range limit falls back to the default");
 assert.ok(h.queries[0].some(x=>x.startsWith("ilike:business_name:%50")&&!/[,()%]{2}|\\/.test(x.slice(22))),"search wildcards and separators are neutralised: "+h.queries[0].join("|"));
 const g=await (await h.call({action:"ledger",tenantId:T})).json();
 assert.equal(g.actions.length,1);
 assert.ok(h.queries[1].includes(`eq:tenant_id:${T}`)&&h.queries[1].includes("limit:100"));
 assert.ok(!JSON.stringify([l,g]).includes("service-test"));
});
