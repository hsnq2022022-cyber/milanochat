// Security boundary tests for the REAL milan-api webhook handler (no source-string checks).
// The handler module is imported with Deno.serve captured and globalThis.fetch replaced by a
// recorder, so every Supabase/Meta request the handler makes is observed. No network, no secrets.
// Run: deno test -A --no-lock --node-modules-dir=none tests/flow-security-webhook-boundary.test.ts
import {assert,assertEquals} from "jsr:@std/assert@1";
import {verifyTokenMatches} from "../supabase/functions/milan-api/verifyToken.ts";

const APP_SECRET="test-app-secret-not-real";
const SUPABASE_URL="http://supabase.invalid";
const TENANT_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IG_ID="17841400000000001";
const SECRET_TEXT="private-customer-text-xyz";

type Recorded={method:string;url:string;body:string};
let calls:Recorded[]=[];
let accountRows:unknown[]=[];
globalThis.fetch=(async(input:Request|URL|string,init?:RequestInit)=>{
 const req=new Request(input as Request,init);
 const url=req.url;
 let body="";
 try{body=await req.clone().text();}catch{/* no body */}
 if(!url.startsWith(SUPABASE_URL))throw new Error("unexpected outbound host "+new URL(url).host);
 calls.push({method:req.method,url,body});
 const table=new URL(url).pathname.split("/").pop();
 const data=req.method==="GET"&&table==="channel_accounts"?accountRows:[];
 return new Response(JSON.stringify(req.headers.get("accept")?.includes("vnd.pgrst.object")?
   (Array.isArray(data)?data[0]??null:data):data),
  {status:200,headers:{"content-type":"application/json"}});
}) as typeof fetch;

const envMap:Record<string,string>={SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY:"service-role-test",
 INSTAGRAM_APP_SECRET:APP_SECRET,META_APP_SECRET:"",WHATSAPP_APP_SECRET:APP_SECRET,
 WHATSAPP_VERIFY_TOKEN:"wa-verify-token-test",INSTAGRAM_VERIFY_TOKEN:"ig-verify-token-test",META_WEBHOOK_VERIFY_TOKEN:""};
const realEnvGet=Deno.env.get.bind(Deno.env);
Deno.env.get=((k:string)=>k in envMap?envMap[k]:realEnvGet(k)) as typeof Deno.env.get;
let handler:((r:Request)=>Promise<Response>)|null=null;
const realServe=Deno.serve;
(Deno as unknown as {serve:unknown}).serve=((h:(r:Request)=>Promise<Response>)=>{handler=h;
 return {finished:Promise.resolve(),shutdown:async()=>{},ref(){},unref(){},addr:{}} as never;}) as never;
await import("../supabase/functions/milan-api/index.ts");
(Deno as unknown as {serve:unknown}).serve=realServe;
assert(handler,"handler captured");

const hmac=async(secret:string,raw:string)=>{
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const sig=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw)));
 return "sha256="+[...sig].map(b=>b.toString(16).padStart(2,"0")).join("");
};
const igBody=(extra:Record<string,unknown>={})=>JSON.stringify({object:"instagram",entry:[{id:IG_ID,time:1,
 messaging:[{sender:{id:"555"},recipient:{id:IG_ID},timestamp:1,
  message:{mid:"mid.forged",text:SECRET_TEXT,...extra}}]}]});
const post=(action:string,raw:string,sig?:string)=>handler!(new Request(
 `${SUPABASE_URL}/functions/v1/milan-api?action=${action}`,{method:"POST",
  headers:{"content-type":"application/json",...(sig!==undefined?{"x-hub-signature-256":sig}:{})},body:raw}));
const withLogs=async<T>(fn:()=>Promise<T>)=>{
 const lines:string[]=[];
 const o={e:console.error,w:console.warn,l:console.log,i:console.info};
 const cap=(...a:unknown[])=>{lines.push(a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" "));};
 console.error=cap;console.warn=cap;console.log=cap;console.info=cap;
 try{return {result:await fn(),logs:lines.join("\n")};}
 finally{console.error=o.e;console.warn=o.w;console.log=o.l;console.info=o.i;}
};
const reset=()=>{calls=[];accountRows=[];envMap.INSTAGRAM_APP_SECRET=APP_SECRET;envMap.META_APP_SECRET="";
 envMap.WHATSAPP_APP_SECRET=APP_SECRET;
 envMap.WHATSAPP_VERIFY_TOKEN="wa-verify-token-test";envMap.INSTAGRAM_VERIFY_TOKEN="ig-verify-token-test";envMap.META_WEBHOOK_VERIFY_TOKEN="";};

Deno.test("instagram: forged / missing / malformed signature is ignored and touches NO database",async()=>{
 const raw=igBody();
 const wrong=await hmac("attacker-secret",raw);
 for(const sig of [wrong,"","sha256=zz","sha256="+"0".repeat(64),await hmac(APP_SECRET,raw+" ")]){
  reset();
  const {result,logs}=await withLogs(()=>post("instagram_webhook",raw,sig));
  assertEquals(result.status,200);
  assertEquals(await result.json(),{received:true});
  assertEquals(calls.length,0,"no Supabase request of any kind for an unsigned event");
  assert(!logs.includes(SECRET_TEXT),"message text never logged");
  assert(!logs.includes(APP_SECRET),"secret never logged");
  if(sig.length>20)assert(!logs.includes(sig),"signature never logged");
 }
});
Deno.test("facebook page + whatsapp: bad signature is 401 and touches NO database",async()=>{
 reset();
 const page=JSON.stringify({object:"page",entry:[{id:IG_ID,messaging:[{sender:{id:"1"},recipient:{id:IG_ID},message:{mid:"m",text:SECRET_TEXT}}]}]});
 const wa=JSON.stringify({object:"whatsapp_business_account",entry:[{id:"1",changes:[{field:"messages",value:{messages:[{from:"1",id:"w",text:{body:SECRET_TEXT}}]}}]}]});
 const bad=await hmac("attacker-secret",page);
 let r=await post("instagram_webhook",page,bad);assertEquals(r.status,401);await r.body?.cancel();
 r=await post("instagram_webhook",page);assertEquals(r.status,401);await r.body?.cancel();
 r=await post("whatsapp_webhook",wa,await hmac("attacker-secret",wa));assertEquals(r.status,401);await r.body?.cancel();
 r=await post("whatsapp_webhook",wa,"");assertEquals(r.status,401);await r.body?.cancel();
 assertEquals(calls.length,0);
});
Deno.test("missing signing secrets fail closed (503), never accept unsigned events",async()=>{
 reset();envMap.INSTAGRAM_APP_SECRET="";envMap.META_APP_SECRET="";envMap.WHATSAPP_APP_SECRET="";
 const raw=igBody();
 const r=await post("instagram_webhook",raw,"sha256="+"0".repeat(64));
 assertEquals(r.status,503);await r.body?.cancel();
 assertEquals(calls.length,0);
 reset();
});
Deno.test("signed event for an unknown account creates no durable work; payload tenant fields cannot override identity",async()=>{
 reset();
 const raw=igBody({tenant_id:TENANT_B,tenantId:TENANT_B,account_id:TENANT_B});
 reset();
 const sig=await hmac(APP_SECRET,raw);
 const {result:res}=await withLogs(()=>post("instagram_webhook",raw,sig));
 await res.body?.cancel();
 const writes=calls.filter(c=>c.method!=="GET");
 assertEquals(writes.length,0,"unknown account: only reads, no insert/update/RPC");
 for(const c of calls)assert(!c.body.includes(TENANT_B),"attacker-supplied tenant id is never sent to the database");
});
Deno.test("signed event for tenant A's account: every write carries tenant A, never an id injected in the payload",async()=>{
 reset();
 accountRows=[{id:"acc-a",tenant_id:TENANT_A,channel:"instagram",external_id:IG_ID,status:"active",
  agent_enabled:false,auto_reply:false,access_token_encrypted:null}];
 const raw=igBody({tenant_id:TENANT_B,tenantId:TENANT_B});
 const sig=await hmac(APP_SECRET,raw);
 const {result}=await withLogs(()=>post("instagram_webhook",raw,sig));
 await result.body?.cancel();
 for(const c of calls.filter(x=>x.method!=="GET"))
  assert(!c.body.includes(TENANT_B),"write body never contains the injected foreign tenant id: "+c.url);
 for(const c of calls)assert(!c.url.includes(TENANT_B),"no request addressed to the foreign tenant");
});
Deno.test("replayed signed event: both deliveries reach the same idempotent key, never a foreign one",async()=>{
 reset();
 accountRows=[{id:"acc-a",tenant_id:TENANT_A,channel:"instagram",external_id:IG_ID,status:"active",
  agent_enabled:false,auto_reply:false,access_token_encrypted:null}];
 const raw=igBody();
 const sig=await hmac(APP_SECRET,raw);
 const a=await post("instagram_webhook",raw,sig);await a.body?.cancel();
 const first=calls.slice();calls=[];
 const b=await post("instagram_webhook",raw,sig);await b.body?.cancel();
 // Deterministic: the replay issues the same sequence of requests as the first delivery
 // (the dedupe is enforced by the database unique key, exercised in flow-lifecycle-integration).
 assertEquals(calls.map(c=>c.method+" "+new URL(c.url).pathname),first.map(c=>c.method+" "+new URL(c.url).pathname));
});
Deno.test("oversized and malformed bodies are rejected before any signature or database work",async()=>{
 reset();
 const huge="x".repeat(6*1024*1024);
 let r=await post("instagram_webhook",huge,"sha256="+"0".repeat(64));
 assert(r.status===413||r.status===400,"oversized rejected: "+r.status);await r.body?.cancel();
 r=await post("instagram_webhook","{not json",await hmac(APP_SECRET,"{not json"));
 assertEquals(r.status,400);await r.body?.cancel();
 assertEquals(calls.length,0);
});

// ---------------------------------------------------------------- GET verify-token handshake
const handshake=(action:string,q:Record<string,string|undefined>)=>{
 const u=new URL(`${SUPABASE_URL}/functions/v1/milan-api`);
 u.searchParams.set("action",action);
 for(const [k,v] of Object.entries(q))if(v!==undefined)u.searchParams.set(k,v);
 return handler!(new Request(u,{method:"GET"}));
};
const WA="wa-verify-token-test",IG="ig-verify-token-test";
for(const [action,good] of [["whatsapp_webhook",WA],["instagram_webhook",IG]] as const){
 Deno.test(`${action} GET handshake: exact token echoes the challenge (200); every other token is 403 Forbidden, no database access, no token in logs`,async()=>{
  reset();
  const ok=await handshake(action,{"hub.mode":"subscribe","hub.verify_token":good,"hub.challenge":"challenge-123"});
  assertEquals(ok.status,200);assertEquals(await ok.text(),"challenge-123");
  const bad:Array<[string,Record<string,string|undefined>]>=[
   ["wrong same length",{"hub.verify_token":good.slice(0,-1)+"X"}],
   ["prefix (shorter)",{"hub.verify_token":good.slice(0,-1)}],
   ["extension (longer)",{"hub.verify_token":good+"x"}],
   ["different case",{"hub.verify_token":good.toUpperCase()}],
   ["empty",{"hub.verify_token":""}],
   ["missing",{}],
   ["whitespace padded",{"hub.verify_token":" "+good}],
   ["unicode lookalike",{"hub.verify_token":good.replace("e","\u0435")}],
   ["very long",{"hub.verify_token":"a".repeat(8000)}],
   ["wrong mode",{"hub.mode":"unsubscribe","hub.verify_token":good}],
   ["missing mode",{"hub.mode":undefined,"hub.verify_token":good}]];
  for(const [name,q] of bad){
   const {result,logs}=await withLogs(()=>handshake(action,{"hub.mode":"subscribe","hub.challenge":"c",...q}));
   assertEquals(result.status,403,name);assertEquals(await result.text(),"Forbidden",name);
   assert(!logs.includes(good),"configured token never logged: "+name);
  }
  assertEquals(calls.length,0,"the handshake never touches the database");
 });
 Deno.test(`${action} GET handshake: an unset configured token never matches (even an empty or missing presented token)`,async()=>{
  reset();
  envMap.WHATSAPP_VERIFY_TOKEN="";envMap.INSTAGRAM_VERIFY_TOKEN="";envMap.META_WEBHOOK_VERIFY_TOKEN="";
  for(const t of ["","x",undefined]){
   const r=await handshake(action,{"hub.mode":"subscribe","hub.verify_token":t,"hub.challenge":"c"});
   assertEquals(r.status,403);assertEquals(await r.text(),"Forbidden");
  }
  reset();
 });
}
Deno.test("instagram GET handshake keeps the META_WEBHOOK_VERIFY_TOKEN fallback; INSTAGRAM_VERIFY_TOKEN wins when both are set",async()=>{
 reset();
 envMap.INSTAGRAM_VERIFY_TOKEN="";envMap.META_WEBHOOK_VERIFY_TOKEN="meta-fallback-token";
 let r=await handshake("instagram_webhook",{"hub.mode":"subscribe","hub.verify_token":"meta-fallback-token","hub.challenge":"fb"});
 assertEquals([r.status,await r.text()],[200,"fb"]);
 envMap.INSTAGRAM_VERIFY_TOKEN=IG;
 r=await handshake("instagram_webhook",{"hub.mode":"subscribe","hub.verify_token":"meta-fallback-token","hub.challenge":"fb"});
 assertEquals(r.status,403);await r.body?.cancel();
 reset();
});
Deno.test("verifyTokenMatches: exact match only; null/undefined/empty/unequal-length inputs are false and never throw",()=>{
 assert(verifyTokenMatches("abc","abc"));assert(verifyTokenMatches("é✓","é✓"));
 for(const [a,b] of [["abc","abd"],["abc","ab"],["ab","abc"],["","abc"],["abc",""],["",""],[null,"abc"],[undefined,"abc"],["abc",null],["abc",undefined],[null,null],["a\u0000","a"]] as const)
  assertEquals(verifyTokenMatches(a as string|null,b as string|null),false,JSON.stringify([a,b]));
});
Deno.test("regression guard: the handshake in milan-api/index.ts never compares the verify token with a plain ===",async()=>{
 const src=await Deno.readTextFile(new URL("../supabase/functions/milan-api/index.ts",import.meta.url));
 assert(!/token\s*===\s*expected/.test(src),"plain token comparison is back");
 assertEquals((src.match(/verifyTokenMatches\(token, expected\)/g)??[]).length,2,"both Meta handshakes use verifyTokenMatches");
});
