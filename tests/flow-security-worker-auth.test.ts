// Unauthorized invocation of the REAL worker handlers (flow-internal-worker, flow-outbox-worker,
// flow-runtime-worker): each module is imported with Deno.serve captured and fetch replaced by a
// recorder, so "no database/provider access before authentication" is observed, not read from source.
// Run: deno test -A --no-lock --node-modules-dir=none tests/flow-security-worker-auth.test.ts
import {assert,assertEquals} from "jsr:@std/assert@1";
import {constantTimeEqual,acceptsFlowWorkerBearer} from "../supabase/functions/flowWorkerAuth.ts";

const SERVICE="service-role-test-key",CRON="independent-cron-test-key";
const envMap:Record<string,string>={SUPABASE_URL:"http://supabase.invalid",SUPABASE_SERVICE_ROLE_KEY:SERVICE,
 flow_worker_service_role_key:CRON};
const realEnv=Deno.env.get.bind(Deno.env);
Deno.env.get=((k:string)=>k in envMap?envMap[k]:realEnv(k)) as typeof Deno.env.get;
let outbound:string[]=[];
globalThis.fetch=(async(i:Request|URL|string)=>{outbound.push(String(i instanceof Request?i.url:i));
 return new Response("[]",{status:200,headers:{"content-type":"application/json"}});}) as typeof fetch;

const cache=new Map<string,(r:Request)=>Promise<Response>>();
async function load(path:string){
 if(cache.has(path))return cache.get(path)!;
 let h:((r:Request)=>Promise<Response>)|null=null;
 const real=Deno.serve;
 (Deno as unknown as {serve:unknown}).serve=((a:unknown,b?:unknown)=>{
  h=(typeof a==="function"?a:b) as typeof h;
  return {finished:Promise.resolve(),shutdown:async()=>{},ref(){},unref(){},addr:{}} as never;}) as never;
 try{await import(path);}finally{(Deno as unknown as {serve:unknown}).serve=real;}
 assert(h,"handler captured from "+path);
 cache.set(path,h!);
 return h!;
}
const call=(h:(r:Request)=>Promise<Response>,auth:string|null,method="POST",body:unknown={mode:"tick"})=>
 h(new Request("http://x.invalid/functions/v1/w",{method,headers:{"content-type":"application/json",
  ...(auth===null?{}:{authorization:auth})},body:method==="POST"?JSON.stringify(body):undefined}));

const BAD:(string|null)[]=[null,"","Bearer","Bearer ","Bearer wrong","Bearer "+SERVICE+"x","bearer "+SERVICE,
 "Basic "+SERVICE,SERVICE,"Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig"];

Deno.test("constantTimeEqual: exact equality semantics (length, content, multibyte, empty)",()=>{
 assert(constantTimeEqual("abc","abc"));assert(constantTimeEqual("","")); assert(constantTimeEqual("é✓","é✓"));
 for(const [a,b] of [["abc","abd"],["abc","ab"],["ab","abc"],["abc",""],["","a"],["é","e"],["a\u0000","a"]])
  assert(!constantTimeEqual(a,b),JSON.stringify([a,b]));
 assert(acceptsFlowWorkerBearer("Bearer "+CRON,SERVICE,CRON));
 assert(!acceptsFlowWorkerBearer("Bearer "+CRON,SERVICE,""));
});

for(const [name,path,cronAllowed] of [
 ["flow-internal-worker","../supabase/functions/flow-internal-worker/index.ts",false],
 ["flow-outbox-worker","../supabase/functions/flow-outbox-worker/index.ts",true],
 ["flow-runtime-worker","../supabase/functions/flow-runtime-worker/index.ts",true]] as const){
 Deno.test(`${name}: missing / wrong / anon-JWT / malformed credentials -> 401 with zero outbound requests`,async()=>{
  const h=await load(path);
  for(const auth of BAD){
   outbound=[];
   const r=await call(h,auth);
   assertEquals(r.status,401,`${name} ${JSON.stringify(auth)}`);
   const text=await r.text();
   assert(!text.includes(SERVICE)&&!text.includes(CRON),"response never echoes credentials");
   assertEquals(outbound.length,0,"no database or provider request before authentication");
  }
 });
 Deno.test(`${name}: the independent cron token is ${cronAllowed?"accepted":"REJECTED"} (existing contract)`,async()=>{
  const h=await load(path);
  outbound=[];
  const r=await call(h,"Bearer "+CRON);
  await r.body?.cancel();
  if(cronAllowed)assert(r.status!==401,"cron token authenticates");
  else assertEquals(r.status,401);
 });
}
Deno.test("flow-internal-worker: GET is 405; correct key with Internal Actions OFF stays 423 with no database access",async()=>{
 const h=await load("../supabase/functions/flow-internal-worker/index.ts");
 outbound=[];
 let r=await call(h,"Bearer "+SERVICE,"GET");assertEquals(r.status,405);await r.body?.cancel();
 r=await call(h,"Bearer "+SERVICE);assertEquals(r.status,423);await r.body?.cancel();
 assertEquals(outbound.length,0);
});
