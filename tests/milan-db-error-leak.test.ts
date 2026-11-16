// T5-S2 hardening of supabase/functions/milan-api/index.ts: Postgres /
// PostgREST / internal error text (message, details, hint, SQL, table /
// column / constraint names, row values such as tokens or phone numbers,
// file paths) never reaches a client response body or a log line.
//  - every `return err(...)` DB failure site uses dbFail(): fixed Arabic text,
//    SAME status (500; claim_account keeps 404 for an invalid token) and the
//    same { error } body; the log is a fixed tag + coarse code only.
//  - thrown DB errors (fetchAccountWithToken, widget session / messages,
//    match_knowledge, widget_message insert) carry fixed Arabic messages, so
//    clientErrorMessage never forwards DB text; the reply 502 branch for a
//    failed account read is preserved (message keeps "توكن").
//  - clientErrorMessage forwards a plain Error only when it is Arabic text.
//  - log-only sites (consume_reply, widget.js, profile update, widget AI
//    error, widget answer insert) never log the error text.
// Behavioural: the REAL code is sliced out of index.ts, type-stripped and run
// against fakes with a captured console (same technique as
// tests/milan-provider-error-leak.test.ts). No Deno, no network, no database.
// Run: node --experimental-strip-types --test tests/milan-db-error-leak.test.ts
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
/** From IDX[start] (an opening "name(") to its matching ")" (+ ";" if any). */
function callFrom(start:number){
 let i=IDX.indexOf("(",start),depth=0,q:string|null=null;
 for(;i<IDX.length;i++){
  const ch=IDX[i];
  if(q){if(ch==="\\"){i++;continue;}if(ch===q)q=null;continue;}
  if(ch==='"'||ch==="'"||ch==="`"){q=ch;continue;}
  if(ch==="(")depth++;
  else if(ch===")"&&--depth===0){i++;break;}
 }
 if(IDX[i]===";")i++;
 return IDX.slice(start,i);
}
/** The `head(...)` call that contains `marker` (nearest `head` before it). */
function callAround(head:string,marker:string){
 const m=IDX.indexOf(marker);assert.ok(m>=0,"located: "+marker.slice(0,50));
 assert.equal(IDX.indexOf(marker,m+1),-1,"unique: "+marker.slice(0,50));
 const s=IDX.lastIndexOf(head,m);const c=callFrom(s);
 assert.ok(s+c.length>m,"marker inside the call: "+marker.slice(0,50));
 return c;
}

// ---------------------------------------------------------------- canaries
const TOKEN="tok_LEAKCANARY_claim_9f8e7d";
const PHONE="+966500000123";
const PATH="/var/lib/postgresql/data/LEAKCANARY";
const DB_ERR={
 message:`relation "tenants" does not exist LEAKCANARY`,
 details:`Key (claim_token)=(${TOKEN}) already exists; phone ${PHONE}`,
 hint:`violates constraint "tenants_claim_token_lc_key" at ${PATH}`,
 code:"42P01",
};
const CANARIES=["LEAKCANARY",TOKEN,PHONE,PATH,"relation","does not exist","tenants_claim_token_lc_key",
 "claim_token","violates","42P01x"];
function rendered(x:unknown){
 let s="";
 try{s+=JSON.stringify(x);}catch{/* cyclic */}
 s+="\n"+inspect(x,{depth:null,showHidden:true});
 if(x instanceof Error)s+="\n"+String(x)+"\n"+x.message+"\n"+(x.stack??"");
 return s;
}
function assertNoLeak(what:string,x:unknown){
 const r=rendered(x);
 for(const s of CANARIES)assert.ok(!r.includes(s),what+": never contains "+s);
}
type Log=[string,unknown[]];
function cons(){const logs:Log[]=[];const c:any={};
 for(const k of ["log","info","warn","error","debug"])c[k]=(...a:unknown[])=>logs.push([k,a]);
 return {logs,c};}

// ---------------------------------------------------------------- real code
const JSON_ERR_SRC=between("const json = (","/* ═══");
const ATU_SRC=between("class AccountTokenUnavailableError extends Error {","\n}\n")+"\n}\n";
const WA_CLASS_SRC=between("class WaAuthError extends Error {","\n}\n")+"\n}\n";
const HELPERS_SRC=between("/* ── Stage 6 hardening: provider/network errors","/**\n * fetch مع إعادة");
const FAWT_SRC=between("async function fetchAccountWithToken(","/**\n * يرسل نصاً");
const SESSION_SRC=between("async function getOrCreateWidgetSession(","/**\n * جلب رسائل جلسة Widget");
const WMSG_SRC=between("async function widgetMessages(","/**\n * التأكد أن");
const AFK_SRC=between("async function answerFromKnowledge(","\n/* ═══");
const REPLY_CATCH_SRC=between("          /* فشل التوكن/المصادقة → 502 برسالة عربية واضحة */","        }\n\n        await sb");
const TOP_CATCH_SRC=between("  } catch (e) {\n    // Stage 6: safe fields only","\n});");

function kit(console_:any){
 const src=strip("const CORS={};\n"+JSON_ERR_SRC+ATU_SRC+WA_CLASS_SRC+HELPERS_SRC+FAWT_SRC+SESSION_SRC+WMSG_SRC+AFK_SRC+
  "\nfunction replyCatch(e){\n"+REPLY_CATCH_SRC+"\n}"+
  "\nfunction topCatch(e,action){\ntry{throw e;\n"+TOP_CATCH_SRC+"\n}")+
  "\nreturn {json,err,dbFail,safeDbCode,DB_ERROR_MESSAGE,clientErrorMessage,safeErrorLog,WaAuthError,ProviderHttpError,"+
  "fetchAccountWithToken,getOrCreateWidgetSession,widgetMessages,answerFromKnowledge,replyCatch,topCatch};";
 return new Function("console","env","embed","pg",src)(console_,()=>"",async()=>[[0.1]],(v:unknown)=>JSON.stringify(v));
}
async function body(r:Response){return {status:r.status,...(await r.json())};}

/** Fake PostgREST query builder: every terminal call resolves to `result`. */
function fakeSb(result:{data:unknown,error:unknown}){
 const q:any=new Proxy({},{get(_t,p){
  if(p==="then")return (res:any,rej:any)=>Promise.resolve(result).then(res,rej);
  return ()=>q;}});
 return {from:()=>q,rpc:async()=>result};
}

const READ="تعذر جلب البيانات — حاول مرة أخرى";
const SAVE="تعذر حفظ التغييرات — حاول مرة أخرى";
const DEL="تعذر الحذف — حاول مرة أخرى";
const KB="تعذر حفظ المحتوى في قاعدة المعرفة";
const GENERIC="تعذر إتمام العملية — حاول مرة أخرى";
// tag -> exact client text on a DB error (status 500 for every site).
const EXPECTED:Record<string,string>={
 create_tenant:"تعذر إنشاء الحساب — حاول مرة أخرى",
 qa_save_source_insert:"تعذر إنشاء مصدر المعرفة", qa_save_chunks_insert:KB,
 ingest_text_source_insert:"تعذر إنشاء المصدر", ingest_text_chunks_insert:KB,
 qa_test:"فشل البحث في قاعدة المعرفة",
 claim_account:GENERIC,
 widget_dashboard_list:READ, widget_dashboard_create:"تعذر إنشاء Widget",
 widget_dashboard_update:"تعذر تحديث Widget", widget_dashboard_delete:DEL,
 conversations:READ, messages:READ, unresolved:READ, knowledge:READ,
 agent_prompt_set:SAVE, takeover:SAVE, release:SAVE,
 knowledge_add_url_source_insert:"تعذر إنشاء المصدر", knowledge_add_url_chunks_insert:KB,
 knowledge_add_text_source_insert:"تعذر إنشاء المصدر", knowledge_add_text_chunks_insert:KB,
 knowledge_delete:DEL,
 pay_create:"تعذر إنشاء الفاتورة — حاول مرة أخرى",
};
// Without a DB error (`error || !data` branches): the old intentional text/status.
const NO_ERROR:Record<string,[number,string]>={
 create_tenant:[500,"خطأ"], claim_account:[404,"رمز غير صالح أو مستخدم"],
 qa_save_source_insert:[500,"تعذر إنشاء مصدر المعرفة"],
 ingest_text_source_insert:[500,"تعذر إنشاء المصدر"],
 widget_dashboard_create:[500,"تعذر إنشاء Widget"], widget_dashboard_update:[500,"تعذر تحديث Widget"],
 knowledge_add_url_source_insert:[500,"تعذر إنشاء المصدر"], knowledge_add_text_source_insert:[500,"تعذر إنشاء المصدر"],
};

/** Every `return err(...)` statement in index.ts that reports a DB failure. */
function dbErrSites(){
 const out:{tag:string,src:string}[]=[];
 for(let i=IDX.indexOf("return err(");i>=0;i=IDX.indexOf("return err(",i+1)){
  const c=callFrom(i);
  if(!c.includes("dbFail("))continue;
  const m=/dbFail\(\w+, "([a-z_]+)"/.exec(c);
  assert.ok(m,"tagged: "+c.slice(0,80));
  out.push({tag:m![1],src:c});
 }
 return out;
}
function runSite(k:any,src:string,error:unknown){
 return new Function("err","dbFail","error","srcError","chunksError","upErr",src)(
  k.err,k.dbFail,error,error,error,error) as Response;
}

// ========================================================= err() DB sites
test("every DB err() site: fixed Arabic text, status 500, { error } only, no canary in body or logs",async()=>{
 const sites=dbErrSites();
 assert.deepEqual(sites.map(s=>s.tag).sort(),Object.keys(EXPECTED).sort(),"one site per expected action");
 for(const s of sites){
  const {logs,c}=cons();const k=kit(c);
  const r=await body(runSite(k,s.src,DB_ERR));
  assert.deepEqual(r,{status:500,error:EXPECTED[s.tag]},s.tag);
  assertNoLeak(s.tag+" body",r);
  assert.equal(logs.length,1,s.tag+": one log line");
  assert.deepEqual(logs[0],["error",["[milan-api] db error",{tag:s.tag,code:"42P01"}]],s.tag+" log");
  assertNoLeak(s.tag+" log",logs);
 }
});

test("error || !data branches without a DB error keep their intentional text and status (claim_account 404)",async()=>{
 const sites=dbErrSites();
 for(const [tag,[status,msg]] of Object.entries(NO_ERROR)){
  const s=sites.find(x=>x.tag===tag)!;assert.ok(s,tag);
  const {logs,c}=cons();
  assert.deepEqual(await body(runSite(kit(c),s.src,null)),{status,error:msg},tag);
  assert.deepEqual(logs,[],tag+": nothing logged without an error");
 }
});

test("safeDbCode: SQLSTATE / PGRSTnnn only; any other code (text, values) -> unknown",()=>{
 const k=kit(cons().c);
 assert.equal(k.safeDbCode({code:"23505"}),"23505");
 assert.equal(k.safeDbCode({code:"PGRST116"}),"PGRST116");
 for(const bad of [{code:TOKEN},{code:"23505 "+PHONE},{code:42},{},null,"x",{get code(){throw new Error(TOKEN);}}])
  assert.equal(k.safeDbCode(bad),"unknown");
});

// ======================================================= thrown DB errors
test("fetchAccountWithToken DB error: fixed message, reply keeps 502, top-level 500; no canary anywhere",async()=>{
 const {logs,c}=cons();const k=kit(c);
 let thrown:unknown;
 try{await k.fetchAccountWithToken(fakeSb({data:null,error:DB_ERR}),"acc");}catch(e){thrown=e;}
 assert.ok(thrown instanceof Error);
 assert.equal((thrown as Error).message,"تعذر قراءة توكن حساب القناة — حاول مرة أخرى");
 assertNoLeak("thrown",thrown);
 assert.deepEqual(await body(k.replyCatch(thrown)),{status:502,error:"تعذر قراءة توكن حساب القناة — حاول مرة أخرى"});
 assert.deepEqual(await body(k.topCatch(thrown,"reply")),{status:500,error:"تعذر قراءة توكن حساب القناة — حاول مرة أخرى"});
 assertNoLeak("logs",logs);
 assert.deepEqual(logs[0],["error",["[milan-api] db error",{tag:"account_read",code:"42P01"}]]);
 // no row: intentional Arabic message unchanged
 let none:any;try{await k.fetchAccountWithToken(fakeSb({data:null,error:null}),"acc");}catch(e){none=e;}
 assert.equal(none.message,"لا يوجد حساب مرتبط بهذه المحادثة");
});

test("widget session insert / widget messages read / match_knowledge: fixed messages, top-level 500, no canary",async()=>{
 const {logs,c}=cons();const k=kit(c);
 const cases:[string,()=>Promise<unknown>,string][]=[
  ["widget_session_insert",()=>k.getOrCreateWidgetSession(
   {from:()=>{let n=0;const q:any=new Proxy({},{get(_t,p){
    if(p==="then")return (res:any)=>res(n++===0?{data:null,error:null}:{data:null,error:DB_ERR});
    if(p==="maybeSingle")return ()=>Promise.resolve({data:null,error:null});
    if(p==="single")return ()=>Promise.resolve({data:null,error:DB_ERR});
    return ()=>q;}});return q;}},
   {id:"w",tenant_id:"t"},"visitor-1"),"تعذر إنشاء جلسة Widget"],
  ["widget_messages_read",()=>k.widgetMessages(fakeSb({data:null,error:DB_ERR}),"s","t"),"تعذر جلب رسائل الجلسة"],
  ["match_knowledge",()=>k.answerFromKnowledge(fakeSb({data:null,error:DB_ERR}),{id:"t"},"سؤال"),"فشل البحث في قاعدة المعرفة"],
 ];
 for(const [tag,run,msg] of cases){
  let thrown:unknown;try{await run();}catch(e){thrown=e;}
  assert.ok(thrown instanceof Error,tag);
  assert.equal((thrown as Error).message,msg,tag);
  assertNoLeak(tag,thrown);
  assert.equal(k.clientErrorMessage(thrown,"خطأ داخلي"),msg,tag);
  assert.deepEqual(await body(k.topCatch(thrown,"widget_session")),{status:500,error:msg},tag);
  assert.ok(logs.some(([,a])=>JSON.stringify(a)===JSON.stringify(["[milan-api] db error",{tag,code:"42P01"}])),tag+" logged");
 }
 assertNoLeak("logs",logs);
});

test("widget_message customer insert failure throws a fixed message (top-level 500)",async()=>{
 const stmt=callAround("throw new Error(","dbFail(insertInError,");
 const {logs,c}=cons();const k=kit(c);
 let thrown:unknown;
 try{new Function("dbFail","insertInError",stmt)(k.dbFail,DB_ERR);}catch(e){thrown=e;}
 assert.equal((thrown as Error).message,"تعذر حفظ الرسالة — حاول مرة أخرى");
 assert.deepEqual(await body(k.topCatch(thrown,"widget_message")),{status:500,error:"تعذر حفظ الرسالة — حاول مرة أخرى"});
 assertNoLeak("thrown",thrown);assertNoLeak("logs",logs);
});

// =================================================== clientErrorMessage
test("clientErrorMessage: plain Error with DB / English internal text -> fallback; Arabic messages forwarded",()=>{
 const k=kit(cons().c);
 for(const e of [new Error(DB_ERR.message),new Error(DB_ERR.details),new Error("fetchAccountWithToken: "+DB_ERR.message),
  new Error("No API key found for embeddings"),Object.assign(new Error(DB_ERR.message),{code:"42P01"})])
  assert.equal(k.clientErrorMessage(e,"خطأ داخلي"),"خطأ داخلي");
 for(const m of ["لا يوجد حساب مرتبط بهذه المحادثة","visitorId مطلوب","تعذر فتح الرابط (HTTP 404)",
  "لا يوجد توكن محفوظ لحساب instagram — أعد ربط الحساب"])
  assert.equal(k.clientErrorMessage(new Error(m),"x"),m);
 // a PostgREST error object (not an Error) is never forwarded either
 assert.equal(k.clientErrorMessage(DB_ERR,"خطأ داخلي"),"خطأ داخلي");
});

test("top-level handler: a raw DB-text Error / PostgREST object -> 500 خطأ داخلي, logs safe fields only",async()=>{
 const {logs,c}=cons();const k=kit(c);
 for(const e of [new Error(DB_ERR.message+" "+DB_ERR.details),DB_ERR]){
  assert.deepEqual(await body(k.topCatch(e,"conversations")),{status:500,error:"خطأ داخلي"});
 }
 assertNoLeak("logs",logs);
});

// ===================================================== log-only sites
test("log-only sites never log DB / fetch error text (code only)",()=>{
 const {logs,c}=cons();const k=kit(c);
 const fetchErr=new TypeError("error sending request for url ("+PATH+"?t="+TOKEN+")");
 const run=(stmt:string,names:string[],vals:unknown[])=>
  new Function("console","safeErrorLog","safeDbCode",...names,stmt)(c,k.safeErrorLog,k.safeDbCode,...vals);
 run(callAround("console.error(","[webhook_billing] consume_reply PostgREST error"),
  ["tenantId","outgoingId","error"],["t","m",DB_ERR]);
 run(callAround("console.error(","[widget.js] Error fetching script:"),["error"],[fetchErr]);
 run(callAround("console.error(","sender profile update failed"),["chatId","profUpdErr"],["instagram:1",DB_ERR]);
 run(callAround("console.error(","\"[widget_message] AI error\""),["e"],[new Error(DB_ERR.message)]);
 run(callAround("console.error(","[widget_message] answer insert failed"),["found","widgetSaveError"],
  [{tenant:{id:"t"}},DB_ERR]);
 assert.equal(logs.length,5);
 assertNoLeak("log-only sites",logs);
 assert.deepEqual(logs[0][1][1],{tenantId:"t",messageId:"m",code:"42P01"});
 assert.deepEqual(logs[2][1][1],{code:"42P01"});
 assert.deepEqual(logs[4][1][1],{tenantId:"t",code:"42P01"});
});

// ==================================================== source-level guard
test("source guard: no error .message reaches err(), a thrown Error or a log line in index.ts",()=>{
 const lines=IDX.split("\n");
 // Justified exceptions: WaAuthError / Moyasar ProviderHttpError messages are
 // fixed by construction (tests/milan-provider-error-leak.test.ts).
 const ALLOWED=new Set([
  "err(e.message, 502);",
  "(await providerHttpError(\"Moyasar\", res)).message,",
 ]);
 // each err(e.message, 502) sits directly under an `instanceof WaAuthError` guard
 const wa=IDX.split("return err(e.message, 502);");
 assert.equal(wa.length,4,"three WaAuthError sites");
 for(const before of wa.slice(0,-1))
  assert.match(before.slice(-80),/if \(e instanceof WaAuthError\) \{\s*$/);
 const offenders:string[]=[];
 // err( followed (possibly on the next lines) by an identifier's .message
 for(let i=IDX.indexOf("err(");i>=0;i=IDX.indexOf("err(",i+1)){
  const c=callFrom(i);
  if(/\b\w+\??\.message\b/.test(c)&&![...ALLOWED].some(a=>c.includes(a)))offenders.push(c.slice(0,120));
 }
 for(const [n,l] of lines.entries()){
  const t=l.trim();
  if(/\b(error|err|e|srcError|chunksError|upErr|insertInError|profUpdErr|widgetSaveError)\??\.(message|details|hint)\b/.test(t)){
   const ok=/^(if \(e instanceof|e instanceof Error \? e\.message|return e\.message;|\/\[\\u0600|\/\*\*|\*|\/\/|return err\(e\.message, 502\);|\(await providerHttpError)/.test(t)||
    /^if \(e instanceof Error && e\.name === "SafeFetchError"\) return e\.message;$/.test(t);
   if(!ok)offenders.push((n+1)+": "+t);
  }
 }
 assert.deepEqual(offenders,[]);
 assert.doesNotMatch(IDX,/throw new Error\([^;]*\.message/);
 assert.doesNotMatch(IDX,/\$\{\w+\??\.message\}/);
});
