// Stage 6 hardening of supabase/functions/milan-api/index.ts: provider
// secrets / bodies never reach logs, thrown messages or client responses.
//  - Gemini embeddings: the API key travels in the x-goog-api-key header, the
//    URL carries no key; fetchRetry logs a fixed category (never the error
//    object / text, which embeds the URL) and throws a fixed-message
//    ProviderNetworkError after the last attempt.
//  - Gemini / OpenAI embedding, chat (llm), Moyasar, WhatsApp send and Meta
//    send errors: ProviderHttpError with a FIXED message (provider + status +
//    validated code); the body is read only to extract the code.
//  - [wa] auth failure log: status + validated code, no Meta free text.
//  - instagram_webhook sender-profile step: fixed category only.
//  - reply / unresolved callers and the top-level handler: same statuses and
//    the same 502/400 branch (the old /توكن|token|auth|190/ test on the old
//    body-bearing message is preserved as ProviderHttpError.authHint), safe
//    client text and safe log fields.
// Behavioural: the REAL code is sliced out of index.ts, type-stripped and run
// with a fake fetch / captured console (same technique as
// tests/milan-profile-fetch-log-safety.test.ts). No Deno, no network.
// Run: node --experimental-strip-types --test tests/milan-provider-error-leak.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {inspect} from "node:util";
import {stripTypeScriptTypes} from "node:module";

const IDX=readFileSync(process.env.MILAN_IDX??"supabase/functions/milan-api/index.ts","utf8");
const strip=(s:string)=>stripTypeScriptTypes(s,{mode:"strip"});
function between(a:string,b:string,from=0){
 const i=IDX.indexOf(a,from);const j=IDX.indexOf(b,i+a.length);
 assert.ok(i>=0&&j>i,"located: "+a.slice(0,50));
 return IDX.slice(i,j);
}

const GKEY="AIzaLEAKCANARY-gemini-key-000111";
const OKEY="sk-LEAKCANARY-openai-key-000222";
const WATOKEN="EAALEAKCANARY-wa-token-000333";
const PAGE_TOKEN="EAALEAKCANARY-page-token-000444";
const SECRET="LEAKCANARY-provider-echo-secret-555";
const CUSTOMER="LEAKCANARY customer message: my card is 4111";
const BODY_WORDS=["LEAKCANARY",SECRET,CUSTOMER,"Invalid OAuth","Malformed","4111"];

type Log=[string,unknown[]];
function cons(){const logs:Log[]=[];const c:any={};
 for(const k of ["log","info","warn","error","debug"])c[k]=(...a:unknown[])=>logs.push([k,a]);
 return {logs,c};}
/** Every representation a log sink / error reporter could render. */
function rendered(x:unknown){
 let s="";
 try{s+=JSON.stringify(x);}catch{/* cyclic */}
 s+="\n"+inspect(x,{depth:null,showHidden:true});
 if(x instanceof Error)s+="\n"+String(x)+"\n"+x.message+"\n"+(x.stack??"");
 return s;
}
function assertNoLeak(what:string,x:unknown,extra:string[]=[]){
 const r=rendered(x);
 for(const s of [GKEY,OKEY,WATOKEN,PAGE_TOKEN,...BODY_WORDS,"?key=","key=AIza",...extra])
  assert.ok(!r.includes(s),what+": never contains "+s.slice(0,16));
}

// ---------------------------------------------------------------- real code
const HELPERS_SRC=between("/* ── Stage 6 hardening: provider/network errors","/**\n * fetch مع إعادة");
const AIKEY_SRC=between("function aiKey(","/* ── Stage 6 hardening");
const RETRY_SRC=between("async function fetchRetry(","async function embed(");
const EMBED_SRC=between("async function embed(","const pg =");
const CHAT_SRC=between("async function chatJSON(","\n}\n")+"\n}\n";
const ATU_SRC=between("class AccountTokenUnavailableError extends Error {","\n}\n")+"\n}\n";
const WA_SRC=between("class WaAuthError extends Error {","async function boundPhone(");
const META_SRC=between("async function sendMetaDirectMessage(","return providerIdFromResponse(res,channel);\n}\n")+
 "return providerIdFromResponse(res,channel);\n}\n";
const JSON_ERR_SRC=between("const json = (","/* ═══");
const REPLY_CATCH_SRC=between("          /* فشل التوكن/المصادقة → 502 برسالة عربية واضحة */","        }\n\n        await sb");
const UNRES_CATCH_SRC=between("              console.error(\n                \"[unresolved] send failed\"","            }\n          }\n        }\n\n        return json({");
const TOP_CATCH_SRC=between("  } catch (e) {\n    // Stage 6: safe fields only","\n});");
const MOYASAR_SRC=between("        if (!res.ok) {\n          // Stage 6: status + validated code only, never Moyasar's body.","        const inv: any");
// R1: the profile step now runs inside a deferred job; the slice ends at the first line after the catch.
const PROFILE_CATCH_SRC=between("            } catch (e: unknown) {\n              // Stage 6: fixed category only","            // R1: duration only");

function kit(o:{fetch:any,console:any,env?:Record<string,string>,waToken?:string}){
 const delays:number[]=[];
 const setTimeout=(fn:()=>void,ms:number)=>{delays.push(ms);fn();return 0;};
 const env=(k:string)=>o.env?.[k]??"";
 const src=strip(
  "const CORS={};\n"+JSON_ERR_SRC+ATU_SRC+AIKEY_SRC+HELPERS_SRC+RETRY_SRC+EMBED_SRC+CHAT_SRC+WA_SRC+META_SRC+
  "\nfunction replyCatch(e){\n"+REPLY_CATCH_SRC+"\n}"+
  "\nfunction unresolvedCatch(e){\ntry{throw e;}catch (e) {\n"+UNRES_CATCH_SRC+"\n}\n}"+
  "\nfunction topCatch(e,action){\ntry{throw e;\n"+TOP_CATCH_SRC+"\n}"+
  "\nasync function moyasar(res){\n"+MOYASAR_SRC+"\nreturn null;}"+
  // PROFILE_CATCH_SRC ends with the catch's "}"; the extra "}" closes profileStep.
  "\nfunction profileStep(e){\ntry{throw e;\n"+PROFILE_CATCH_SRC+"\n}"+

  "")+"\nreturn {fetchRetry,embed,chatJSON,sendWa,sendMetaDirectMessage,ProviderHttpError,ProviderNetworkError,"+
  "WaAuthError,safeProviderCode,safeErrorLog,clientErrorMessage,replyCatch,unresolvedCatch,topCatch,moyasar,profileStep};";
 const k=new Function("fetch","console","env","setTimeout","waToken",src)(
  o.fetch,o.console,env,setTimeout,()=>o.waToken??WATOKEN);
 return {...k,delays};
}
function resp(status:number,body:unknown){
 const text=typeof body==="string"?body:JSON.stringify(body);
 return {ok:status>=200&&status<300,status,text:async()=>text,json:async()=>JSON.parse(text)};
}
async function body(r:Response){return {status:r.status,...(await r.json())};}
const TYPE_ERR_URL=()=>new TypeError(
 `error sending request for url (https://generativelanguage.googleapis.com/v1/models/text-embedding-004:batchEmbedContents?key=${GKEY}): connection reset`);

// ========================================================== (a) Gemini key
test("(a) Gemini embed: key only in x-goog-api-key header, URL without key; success parse unchanged",async()=>{
 const {logs,c}=cons();const calls:any[]=[];
 const k=kit({console:c,env:{EMBED_API_KEY:GKEY},fetch:async(url:string,init:any)=>{calls.push({url,init});
  return resp(200,{embeddings:[{values:[0.1,0.2]},{values:[0.3]}]});}});
 assert.deepEqual(await k.embed(["q1","q2"]),[[0.1,0.2],[0.3]]);
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,"https://generativelanguage.googleapis.com/v1/models/text-embedding-004:batchEmbedContents");
 assert.ok(!calls[0].url.includes(GKEY)&&!calls[0].url.includes("key="),"no key in the URL");
 assert.deepEqual(calls[0].init.headers,{"content-type":"application/json","x-goog-api-key":GKEY});
 assert.equal(calls[0].init.method,"POST");
 assert.deepEqual(JSON.parse(calls[0].init.body),{requests:[
  {model:"models/text-embedding-004",content:{parts:[{text:"q1"}]}},
  {model:"models/text-embedding-004",content:{parts:[{text:"q2"}]}}]});
 assert.deepEqual(logs,[]);
});
test("(a) fetch throws a TypeError whose message has URL+key on every attempt: 3 attempts, same delays, fixed-category logs, fixed thrown message, safe top-level response",async()=>{
 const {logs,c}=cons();let n=0;
 const k=kit({console:c,env:{EMBED_API_KEY:GKEY},fetch:async()=>{n++;throw TYPE_ERR_URL();}});
 let thrown:any;
 await assert.rejects(k.embed(["q"]),(e:any)=>{thrown=e;return true;});
 assert.equal(n,3,"same retry count");
 assert.deepEqual(k.delays,[1000,2500],"same delays");
 assert.equal(thrown.name,"ProviderNetworkError");
 assert.equal(thrown.message,"ai network error (network)");
 assert.deepEqual(logs,[
  ["warn",["[ai] network error, attempt 1/3",{category:"network"}]],
  ["warn",["[ai] network error, attempt 2/3",{category:"network"}]],
  ["warn",["[ai] network error, attempt 3/3",{category:"network"}]]]);
 assertNoLeak("thrown",thrown,["googleapis","https://"]);
 assertNoLeak("logs",logs,["googleapis","https://"]);
 // the error reaching the top-level handler (same sliced kit: same classes)
 logs.length=0;
 const r=await body(k.topCatch(thrown,"qa_test"));
 assert.deepEqual(r,{status:500,error:"ai network error (network)"},"500 unchanged, fixed message");
 assert.deepEqual(logs,[["error",["[milan-api:qa_test]",{provider:"ai",category:"network"}]]]);
 assertNoLeak("top logs",logs,["googleapis","https://"]);
});
test("(a) a transient failure then success still retries and succeeds; transient log = status + attempts only",async()=>{
 const {logs,c}=cons();let n=0;
 const k=kit({console:c,env:{EMBED_API_KEY:GKEY},fetch:async()=>{n++;
  if(n===1)throw TYPE_ERR_URL();
  if(n===2)return resp(503,{error:{message:SECRET}});
  return resp(200,{embeddings:[{values:[1]}]});}});
 assert.deepEqual(await k.embed(["q"]),[[1]]);
 assert.equal(n,3);
 assert.deepEqual(logs,[["warn",["[ai] network error, attempt 1/3",{category:"network"}]],["warn",["[ai] transient 503, attempt 2/3"]]]);
 assertNoLeak("logs",logs);
});
test("(a) timeout / unknown thrown objects map to fixed categories",async()=>{
 for(const [err,cat] of [[Object.assign(new Error("timed out "+GKEY),{name:"TimeoutError"}),"timeout"],
  [{toString(){return GKEY;}},"unknown"],["raw string "+GKEY,"unknown"]] as const){
  const {logs,c}=cons();
  const k=kit({console:c,env:{EMBED_API_KEY:GKEY},fetch:async()=>{throw err;}});
  await assert.rejects(k.embed(["q"]),(e:any)=>e.message===`ai network error (${cat})`);
  assert.equal(logs.length,3);
  assertNoLeak("logs",logs);
 }
});

// ============================================== (b) provider bodies dropped
const ECHO={error:{message:`${SECRET} ${CUSTOMER} key=${GKEY}`,type:"invalid_request_error",code:"invalid_api_key"}};
test("(b) Gemini / OpenAI embedding + chat errors: fixed message with provider/status/code; no body",async()=>{
 const cases:[string,Record<string,string>,()=>any,string][]=[
  ["Gemini embedding",{EMBED_API_KEY:GKEY},(k:any)=>k.embed(["q"]),"Gemini embedding 400 (code invalid_api_key)"],
  ["OpenAI embedding",{EMBED_API_KEY:OKEY},(k:any)=>k.embed(["q"]),"OpenAI embedding 400 (code invalid_api_key)"],
  ["llm",{LLM_API_KEY:OKEY},(k:any)=>k.chatJSON("sys","user "+CUSTOMER),"llm 400 (code invalid_api_key)"],
 ] as any;
 for(const [provider,env,run,msg] of cases){
  const {logs,c}=cons();
  const k=kit({console:c,env,fetch:async()=>resp(400,ECHO)});
  let thrown:any;
  await assert.rejects(run(k),(e:any)=>{thrown=e;return true;});
  assert.ok(thrown instanceof k.ProviderHttpError);
  assert.equal(thrown.message,msg);
  assert.equal(thrown.provider,provider);assert.equal(thrown.status,400);assert.equal(thrown.code,"invalid_api_key");
  assertNoLeak(provider+" thrown",thrown);assertNoLeak(provider+" logs",logs);
  const r=await body(k.topCatch(thrown,"qa_test"));
  assert.deepEqual(r,{status:500,error:msg});
  assert.deepEqual(logs.at(-1),["error",["[milan-api:qa_test]",{provider,status:400,code:"invalid_api_key"}]]);
  assertNoLeak(provider+" logs after top",logs);
 }
});
test("(b) non-JSON / unreadable bodies: status only; hostile codes are dropped",async()=>{
 const {c,logs}=cons();
 const k=kit({console:c,env:{EMBED_API_KEY:OKEY},fetch:async()=>resp(500,"<html>"+SECRET+"</html>")});
 await assert.rejects(k.embed(["q"]),(e:any)=>e.message==="OpenAI embedding 500"&&e.code===undefined);
 const k2=kit({console:c,env:{EMBED_API_KEY:OKEY},fetch:async()=>({ok:false,status:403,text:async()=>{throw new Error(SECRET);}})});
 await assert.rejects(k2.embed(["q"]),(e:any)=>e.message==="OpenAI embedding 403");
 const k3=kit({console:c,env:{EMBED_API_KEY:OKEY},fetch:async()=>resp(401,{error:{code:SECRET+" with spaces"}})});
 await assert.rejects(k3.embed(["q"]),(e:any)=>e.message==="OpenAI embedding 401"&&e.code===undefined);
 assert.equal(k.safeProviderCode(190),190);assert.equal(k.safeProviderCode("OAuthException"),"OAuthException");
 assert.equal(k.safeProviderCode(NaN),undefined);assert.equal(k.safeProviderCode("a b"),undefined);
 assert.equal(k.safeProviderCode("x".repeat(41)),undefined);assert.equal(k.safeProviderCode({}),undefined);
 assertNoLeak("logs",logs);
});
test("(b)+(c) WhatsApp send: auth failure log = status + validated code only; other errors fixed; WaAuthError unchanged",async()=>{
 const meta401={error:{message:`Malformed access token ${WATOKEN} ${CUSTOMER}`,type:"OAuthException",code:190}};
 {
  const {logs,c}=cons();
  const k=kit({console:c,fetch:async()=>resp(400,meta401)});
  await assert.rejects(k.sendWa("123","9647700000000",CUSTOMER),(e:any)=>e instanceof k.WaAuthError&&/Meta code 190/.test(e.message));
  assert.deepEqual(logs,[["error",["[wa] auth failure",{status:400,code:190}]]]);
  assertNoLeak("wa auth logs",logs);
 }
 {
  const {logs,c}=cons();
  const k=kit({console:c,fetch:async()=>resp(401,"not json "+SECRET)});
  await assert.rejects(k.sendWa("123","9647700000000",CUSTOMER),(e:any)=>e instanceof k.WaAuthError);
  assert.deepEqual(logs,[["error",["[wa] auth failure",{status:401,code:undefined}]]]);
 }
 {
  const {logs,c}=cons();
  const k=kit({console:c,fetch:async()=>resp(400,{error:{message:`${SECRET} ${CUSTOMER}`,code:131030}})});
  let thrown:any;
  await assert.rejects(k.sendWa("123","9647700000000",CUSTOMER),(e:any)=>{thrown=e;return true;});
  assert.equal(thrown.message,"wa send 400 (code 131030)");
  assert.equal(thrown.status,400);assert.equal(thrown.code,131030);
  assertNoLeak("wa thrown",thrown);assertNoLeak("wa logs",logs);
 }
 {
  const {c}=cons();const calls:any[]=[];
  const k=kit({console:c,fetch:async(url:string,init:any)=>{calls.push({url,init});return resp(200,{messages:[{id:"wamid.OK"}]});}});
  assert.equal(await k.sendWa("123","9647700000000","hi"),"wamid.OK","provider id unchanged");
  assert.equal(calls[0].url,"https://graph.facebook.com/v21.0/123/messages");
 }
});
test("(b) Meta send (instagram/facebook): fixed message, provider id on success unchanged",async()=>{
 for(const channel of ["instagram","facebook"]){
  const {logs,c}=cons();
  const k=kit({console:c,fetch:async()=>resp(400,{error:{message:`${SECRET} ${CUSTOMER} ${PAGE_TOKEN}`,type:"OAuthException",code:10}})});
  let thrown:any;
  await assert.rejects(k.sendMetaDirectMessage({channel,externalId:"1789",token:PAGE_TOKEN,recipientId:"555",text:CUSTOMER}),
   (e:any)=>{thrown=e;return true;});
  assert.equal(thrown.message,`${channel} send 400 (code 10)`);
  assertNoLeak("meta thrown",thrown);assertNoLeak("meta logs",logs);
  const ok=kit({console:c,fetch:async()=>resp(200,{recipient_id:"r",message_id:"mid.OK1"})});
  assert.equal(await ok.sendMetaDirectMessage({channel,externalId:"1789",token:PAGE_TOKEN,recipientId:"555",text:"hi"}),"mid.OK1");
 }
});
test("(b) Moyasar: 502 with provider/status/code only",async()=>{
 const {logs,c}=cons();const k=kit({console:c,fetch:async()=>null});
 const r=await body(await k.moyasar(resp(400,{type:"invalid_request_error",message:`${SECRET} ${CUSTOMER}`,errors:{amount:[SECRET]}})));
 assert.deepEqual(r,{status:502,error:"Moyasar 400 (code invalid_request_error)"});
 assertNoLeak("moyasar client",r);assert.deepEqual(logs,[]);
 assert.equal(await k.moyasar(resp(201,{id:"inv"})),null,"ok response falls through unchanged");
});

// ================================================== (d) sender profile step
test("(d) sender-profile step: fixed category only",()=>{
 const {logs,c}=cons();const k=kit({console:c,fetch:null});
 k.profileStep(new TypeError(`fetch https://graph.instagram.com/v21.0/555?access_token=${PAGE_TOKEN} ${CUSTOMER}`));
 k.profileStep(new Error(SECRET));
 assert.deepEqual(logs,[["warn",["[instagram_webhook] sender profile step skipped",{category:"network"}]],
  ["warn",["[instagram_webhook] sender profile step skipped",{category:"unknown"}]]]);
 assertNoLeak("profile logs",logs,["access_token","https://"]);
});

// ======================================= (e) caller branches + top level
const LEGACY=/توكن|token|auth|190/i;
test("(e) reply / unresolved callers: SAME 502/400 branch as the old message test, safe client text, safe logs",async()=>{
 const bodies:[number,unknown][]=[
  [400,{error:{message:`Invalid OAuth access token ${SECRET}`,type:"OAuthException",code:190}}],
  [401,"Unauthorized "+SECRET],
  [400,{error:{message:`(#551) This person isn't available ${CUSTOMER}`,type:"OAuthException",code:551}}],
  [400,{error:{message:`(#100) param recipient ${CUSTOMER}`,type:"GraphMethodException",code:100}}],
  [500,"<html>"+CUSTOMER+"</html>"],
  [400,{error:{message:"x",code:190}}],
 ];
 for(const [status,b] of bodies){
  const raw=typeof b==="string"?b:JSON.stringify(b);
  const oldStatus=LEGACY.test(`instagram send ${status}: ${raw}`)?502:400;
  const {logs,c}=cons();
  const k=kit({console:c,fetch:async()=>resp(status,b)});
  let thrown:any;
  await assert.rejects(k.sendMetaDirectMessage({channel:"instagram",externalId:"1",token:PAGE_TOKEN,recipientId:"5",text:"t"}),
   (e:any)=>{thrown=e;return true;});
  for(const run of [k.replyCatch,k.unresolvedCatch]){
   const r=await body(run(thrown));
   assert.equal(r.status,oldStatus,`same branch for ${status} ${raw.slice(0,20)}`);
   assert.equal(r.error,thrown.message);
   assertNoLeak("client",r);
  }
  assertNoLeak("logs",logs);
 }
 // 190 / 401 Meta token failures still choose 502.
 const k=kit({console:cons().c,fetch:null});
 assert.equal((await body(k.replyCatch(new k.ProviderHttpError("instagram send",400,190,true)))).status,502);
 // WaAuthError: unchanged message + 502.
 const wa=new k.WaAuthError("توكن واتساب منتهي");
 assert.deepEqual(await body(k.replyCatch(wa)),{status:502,error:"توكن واتساب منتهي"});
 assert.deepEqual(await body(k.unresolvedCatch(wa)),{status:502,error:"توكن واتساب منتهي"});
 // Our own Arabic Error texts: unchanged message and branch.
 assert.deepEqual(await body(k.replyCatch(new Error("لا يوجد توكن محفوظ لحساب facebook — أعد ربط الحساب"))),
  {status:502,error:"لا يوجد توكن محفوظ لحساب facebook — أعد ربط الحساب"});
 assert.deepEqual(await body(k.replyCatch(new Error("واتساب غير مربوط — اربط رقم المنصة أولاً"))),
  {status:400,error:"واتساب غير مربوط — اربط رقم المنصة أولاً"});
 // A raw fetch TypeError: same branch, generic text.
 const te=new TypeError("error sending request for url (https://graph.facebook.com/v21.0/190/messages)");
 assert.deepEqual(await body(k.replyCatch(te)),{status:502,error:"فشل الإرسال"});
 const te2=new TypeError("error sending request for url (https://graph.facebook.com/v21.0/me/messages)");
 assert.deepEqual(await body(k.unresolvedCatch(te2)),{status:400,error:"فشل الإرسال"});
 assert.deepEqual(await body(k.replyCatch("str")),{status:400,error:"فشل الإرسال"});
});
test("(e) unresolved + top-level logs are safe fields; top-level statuses unchanged",async()=>{
 const {logs,c}=cons();const k=kit({console:c,fetch:null});
 k.unresolvedCatch(new k.ProviderHttpError("wa send",400,131030));
 k.unresolvedCatch(new TypeError("https://x/?access_token="+PAGE_TOKEN));
 assert.deepEqual(logs,[["error",["[unresolved] send failed",{provider:"wa send",status:400,code:131030}]],
  ["error",["[unresolved] send failed",{category:"network",name:"TypeError"}]]]);
 logs.length=0;
 assert.deepEqual(await body(k.topCatch(new k.WaAuthError("wa auth"),"reply")),{status:502,error:"wa auth"});
 assert.deepEqual(await body(k.topCatch(new Error("تعذر فتح الرابط (HTTP 404)"),"qa_extract")),{status:500,error:"تعذر فتح الرابط (HTTP 404)"});
 const sfe=Object.assign(new Error("تعذر فتح الرابط [network]"),{name:"SafeFetchError"});
 Object.setPrototypeOf(sfe,class SafeFetchError extends Error{}.prototype);
 assert.deepEqual(await body(k.topCatch(sfe,"qa_extract")),{status:500,error:"تعذر فتح الرابط [network]"},"SafeFetchError text kept");
 assert.deepEqual(await body(k.topCatch(new TypeError("fetch failed https://u/?access_token="+PAGE_TOKEN),"x")),{status:500,error:"خطأ داخلي"});
 assert.deepEqual(await body(k.topCatch({weird:SECRET},"x")),{status:500,error:"خطأ داخلي"});
 assert.deepEqual(await body(k.topCatch(new k.ProviderHttpError("llm",429),"x")),{status:500,error:"llm 429"});
 assertNoLeak("top logs",logs,["access_token","https://"]);
 for(const [,a] of logs)assert.ok(!(a[1] instanceof Error),"never the raw error object");
});
test("(e) chat success path unchanged: JSON content parsed, fallback model on transient failure",async()=>{
 const {c}=cons();const models:string[]=[];
 const k=kit({console:c,env:{LLM_API_KEY:OKEY,LLM_FALLBACK_MODEL:"fb-model"},fetch:async(_u:string,init:any)=>{
  const m=JSON.parse(init.body).model;models.push(m);
  return m==="fb-model"?resp(200,{choices:[{message:{content:"{\"a\":1}"}}]}):resp(503,{error:{message:SECRET}});}});
 assert.deepEqual(await k.chatJSON("s","u"),{a:1});
 assert.deepEqual(models,["gpt-4o-mini","gpt-4o-mini","gpt-4o-mini","fb-model"]);
});

// ======================================================= (f) source guards
test("(f) source guards: no key in URLs, no provider body / fbMessage interpolated into errors or logs",()=>{
 assert.doesNotMatch(IDX,/\?key=/);
 assert.doesNotMatch(IDX,/batchEmbedContents\?/);
 const fns=[EMBED_SRC,CHAT_SRC,WA_SRC,META_SRC,RETRY_SRC,MOYASAR_SRC,REPLY_CATCH_SRC,UNRES_CATCH_SRC,TOP_CATCH_SRC,PROFILE_CATCH_SRC];
 for(const f of fns){
  assert.doesNotMatch(f,/\$\{await res\.text\(\)\}/);
  assert.doesNotMatch(f,/\$\{raw\}/);
  assert.doesNotMatch(f,/fbMessage/);
  assert.doesNotMatch(f,/console\.\w+\([^;]*,\s*e\s*\)/,"never logs the raw error object");
  assert.doesNotMatch(f,/e\?\.message/);
 }
 assert.match(EMBED_SRC,/"x-goog-api-key": key/);
 assert.doesNotMatch(RETRY_SRC,/throw e;/);
 assert.doesNotMatch(TOP_CATCH_SRC,/\?\s*e\.message/,"top-level 500 no longer echoes arbitrary e.message");
});
