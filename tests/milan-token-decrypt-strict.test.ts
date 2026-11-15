// Channel ACCESS TOKENS in milan-api are decrypted STRICTLY
// (decryptAccessTokenStrict): an undecryptable / empty token never reaches
// Meta (no fetch), it fails clearly with the fixed code "token_unavailable".
// Display fields (names, phone, message bodies) keep the LENIENT decryptField
// (placeholder on failure), whose failure log no longer contains any part of
// the ciphertext. Behavioural: the REAL functions are sliced out of
// supabase/functions/milan-api/index.ts, type-stripped and run against fakes
// (real AES-GCM via node's WebCrypto, fake fetch, captured console). The real
// processExclusiveEvent (exclusiveMessageClaim.ts) drives the webhook send.
// No Deno, no network, no database.
// Run: node --experimental-strip-types --test tests/milan-token-decrypt-strict.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import {processExclusiveEvent} from "../supabase/functions/milan-api/exclusiveMessageClaim.ts";

const IDX=readFileSync("supabase/functions/milan-api/index.ts","utf8");
const strip=(s:string)=>stripTypeScriptTypes(s,{mode:"strip"});
function between(a:string,b:string,from=0){
 const i=IDX.indexOf(a,from);const j=IDX.indexOf(b,i+a.length);
 assert.ok(i>=0&&j>i,"located: "+a.slice(0,50));
 return IDX.slice(i,j);
}

const PLACEHOLDER="[رسالة غير قابلة للقراءة]";
const KEY="unit-test-field-key";
const ACC="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const TEN="11111111-1111-4111-8111-111111111111";
const IG_TOKEN="IGQVJtest-valid-token-value-0001";
const EAA_TOKEN="EAAtest-valid-page-token-0002";
const CUSTOMER="Layla Customer";

type Log=[string,unknown[]];
function cons(){const logs:Log[]=[];const c:any={};
 for(const k of ["log","info","warn","error","debug"])c[k]=(...a:unknown[])=>logs.push([k,a]);
 return {logs,c};}

/** Crypto block of index.ts: aesKey .. decryptAccessTokenStrict (real code). */
const CRYPTO_SRC=between("const hex = (",'.join("");')+'.join("");\n'+
 between("async function aesKey(","/* ═══════════════════════════════════════════════════════════════════════\n   المصادقة");
function cryptoKit(key:string,console:any){
 return new Function("env","enc","dec","crypto","console",strip(CRYPTO_SRC)+
  "\nreturn {encryptField,decryptField,decryptFieldStrict,decryptAccessTokenStrict,AccountTokenUnavailableError};")(
  (n:string)=>n==="FIELD_ENCRYPTION_KEY"?key:"",new TextEncoder(),new TextDecoder(),globalThis.crypto,console);
}
/** Flip one hex char of the ciphertext part: GCM authentication then fails. */
function tamper(stored:string){
 const p=stored.split(":");const d=p[4];
 p[4]=(d[0]==="0"?"1":"0")+d.slice(1);return p.join(":");
}

/** sendMetaDirectMessage + providerIdFromResponse (real code), fetch injected. */
const PROVIDER_SRC=between("async function providerIdFromResponse(","\n}\n")+"\n}\n";
const SEND_META_SRC=between("async function sendMetaDirectMessage(","return providerIdFromResponse(res,channel);\n}\n")+
 "return providerIdFromResponse(res,channel);\n}\n";
function metaSender(fetch:any){
 return new Function("fetch",strip(PROVIDER_SRC+SEND_META_SRC)+"\nreturn sendMetaDirectMessage;")(fetch);
}
function fakeFetch(){
 const calls:{url:string,init:any}[]=[];
 const f=async(url:string,init:any)=>{calls.push({url,init});
  return {ok:true,status:200,json:async()=>({recipient_id:"r",message_id:"mid.OK1"}),text:async()=>""};};
 return {calls,f};
}

/** The REAL webhook `send` hook of handleIncomingWebhookMessage. */
const WEBHOOK_SEND_SRC=between("    send: async (text) => {","    ...(deliveryTracking?{delivery:{");
// The lenient decryptField is injected too (real code, same key), so a
// regression back to it would really send the placeholder and be caught.
function webhookSend(deps:{channel:string,account:any,chatId:string,decryptAccessTokenStrict:any,
 sendMetaDirectMessage:any,console:any,decryptField?:any}){
 return new Function("channel","phoneId","sendWa","chatId","account","decryptAccessTokenStrict",
  "sendMetaDirectMessage","console","decryptField",strip("function __f(){const __o={\n"+WEBHOOK_SEND_SRC+"};\nreturn __o.send;}")+"\nreturn __f();")(
  deps.channel,null,async()=>{throw Error("WhatsApp must not be used");},deps.chatId,deps.account,
  deps.decryptAccessTokenStrict,deps.sendMetaDirectMessage,deps.console,deps.decryptField);
}
async function runWebhook(send:any){
 const persisted:string[]=[];const debited:string[]=[];
 const outcome=await processExclusiveEvent({
  prepareFlow:async()=>null,
  claim:async()=>({acquired:true,route:"legacy_ai",claim_id:"c1",outgoing_message_id:"o1"}),
  legacyAnswer:async()=>"reply text",
  send,
  persistSent:async(id,_t,mid)=>{persisted.push(id+":"+mid);return true;},
  debit:async(id)=>{debited.push(id);return 5;},
 });
 return {outcome,persisted,debited};
}

/** The REAL sendToConversation (Instagram/Facebook branches exercised). */
const STC_SRC=between("async function sendToConversation(","/* ═══════════════════════════════════════════════════════════════════════\n   Widget Helpers");
function sendToConversation(deps:{fetchAccountWithToken:any,decryptAccessTokenStrict:any,
 sendMetaDirectMessage:any,console:any,decryptField?:any}){
 return new Function("fetchAccountWithToken","decryptAccessTokenStrict","sendMetaDirectMessage","console","decryptField",
  strip(STC_SRC)+"\nreturn sendToConversation;")(deps.fetchAccountWithToken,deps.decryptAccessTokenStrict,
  deps.sendMetaDirectMessage,deps.console,deps.decryptField);
}

/** The REAL profile-fetch token block of the instagram_webhook loop. */
const PROFILE_SRC=between("              let senderToken: string | null = null;","              // لا نكتب شيئًا");
function profileBlock(deps:{decryptAccessTokenStrict:any,fetchSenderProfile:any,console:any}){
 return new Function("account","msg","channel","decryptAccessTokenStrict","fetchSenderProfile","console","decryptField",
  strip("async function __p(){\n"+PROFILE_SRC+"\nreturn profile;}")+"\nreturn __p();");
}
const FSP_SRC=between("async function fetchSenderProfile(","async function handleIncomingWebhookMessage(");
function fetchSenderProfile(fetch:any,console:any){
 return new Function("fetch","console",strip(FSP_SRC)+"\nreturn fetchSenderProfile;")(fetch,console);
}

/** (d): no ciphertext, token, id, tenant or customer name in any log line. */
function assertCleanLogs(logs:Log[],secrets:string[]){
 const flat=JSON.stringify(logs);
 assert.doesNotMatch(flat,/enc:v1/,"no ciphertext prefix logged");
 for(const s of secrets.filter(Boolean)){
  assert.ok(!flat.includes(s),"secret/identifier never logged");
  if(s.startsWith("enc:v1:")){
   for(const part of s.split(":").slice(2))
    if(part.length>=8)assert.ok(!flat.includes(part.slice(0,8)),"no ciphertext fragment logged");
  }
 }
}

// ===================================================== (a) display fields
test("(a) decryptField (display fields) is unchanged: placeholder on failure, value on success, plaintext passthrough; failure log has no ciphertext",async()=>{
 const {logs,c}=cons();const k=cryptoKit(KEY,c);
 const stored=await k.encryptField(CUSTOMER);
 assert.equal(await k.decryptField(stored),CUSTOMER,"valid value decrypts");
 assert.equal(await k.decryptField("+9647700000000"),"+9647700000000","legacy plaintext unchanged");
 assert.equal(await k.decryptField(null),"");
 assert.equal(logs.length,0,"success logs nothing");
 const bad=tamper(stored);
 assert.equal(await k.decryptField(bad),PLACEHOLDER,"lenient: placeholder kept for display fields");
 const other=cryptoKit("another-key",c);
 assert.equal(await other.decryptField(stored),PLACEHOLDER,"wrong key -> placeholder");
 assert.deepEqual(logs,[["error",["[decryptField] decryption_failed"]],["error",["[decryptField] decryption_failed"]]],
  "fixed generic message only");
 assertCleanLogs(logs,[stored,bad,CUSTOMER]);
});
test("(a) static: decryptField's catch logs no argument derived from the stored value",()=>{
 const fn=between("async function decryptField(","async function decryptFieldStrict(");
 const cat=fn.slice(fn.indexOf("} catch"));
 assert.doesNotMatch(cat,/stored|substring|slice\(|\.message/,"no ciphertext / error text in the log");
 assert.match(cat,/return "\[رسالة غير قابلة للقراءة\]";/);
});

// ===================================================== strict token helper
test("decryptAccessTokenStrict: throws a typed token_unavailable on tamper / wrong key / empty / whitespace; legacy plaintext unchanged; logs nothing",async()=>{
 const {logs,c}=cons();const k=cryptoKit(KEY,c);
 const stored=await k.encryptField(IG_TOKEN);
 assert.equal(await k.decryptAccessTokenStrict(stored),IG_TOKEN);
 assert.equal(await k.decryptAccessTokenStrict(EAA_TOKEN),EAA_TOKEN,"legacy plaintext token passes as before");
 const blank=await k.encryptField("   ");
 // Each sliced kit has its own class object, so match by name + code.
 const isTyped=(e:any)=>e?.name==="AccountTokenUnavailableError"&&e.code==="token_unavailable"&&
  e.message==="token_unavailable";
 await assert.rejects(k.decryptAccessTokenStrict(tamper(stored)),k.AccountTokenUnavailableError);
 for(const v of [tamper(stored),blank,"",null,undefined,"enc:v1:zz:zz:zz","enc:v1:"])
  await assert.rejects(k.decryptAccessTokenStrict(v),isTyped);
 await assert.rejects(cryptoKit("another-key",c).decryptAccessTokenStrict(stored),isTyped);
 assert.deepEqual(logs,[],"the strict helper logs nothing");
});

// ===================================================== (b)/(c) webhook send
test("(b) webhook AI/V2 send: undecryptable token -> NO fetch to Meta, outcome send_failed, nothing persisted/billed, generic log",async()=>{
 const {logs,c}=cons();const k=cryptoKit(KEY,c);const ff=fakeFetch();
 const stored=tamper(await k.encryptField(IG_TOKEN));
 const account={id:ACC,tenant_id:TEN,external_id:"1789",access_token_encrypted:stored};
 const send=webhookSend({channel:"instagram",account,chatId:"instagram:555",
  decryptAccessTokenStrict:k.decryptAccessTokenStrict,sendMetaDirectMessage:metaSender(ff.f),console:c,decryptField:k.decryptField});
 const r=await runWebhook(send);
 assert.equal(ff.calls.length,0,"fetch never called: no placeholder token sent to Meta");
 assert.equal(r.outcome,"send_failed","claimed event ends in the existing terminal outcome");
 assert.deepEqual(r.persisted,[]);assert.deepEqual(r.debited,[]);
 assert.deepEqual(logs,[["warn",["[webhook-claim] account token unavailable; no provider request",{code:"token_unavailable"}]]]);
 assertCleanLogs(logs,[stored,IG_TOKEN,ACC,TEN,"1789"]);
});
test("(b) webhook send: Facebook with an encrypted empty token -> NO fetch, send_failed",async()=>{
 const {logs,c}=cons();const k=cryptoKit(KEY,c);const ff=fakeFetch();
 const stored=await k.encryptField(" ");
 const send=webhookSend({channel:"facebook",account:{id:ACC,external_id:"p1",access_token_encrypted:stored},
  chatId:"facebook:777",decryptAccessTokenStrict:k.decryptAccessTokenStrict,sendMetaDirectMessage:metaSender(ff.f),console:c,decryptField:k.decryptField});
 assert.equal((await runWebhook(send)).outcome,"send_failed");
 assert.equal(ff.calls.length,0);
 assertCleanLogs(logs,[stored,ACC]);
});
test("(c) regression: valid encrypted token sends exactly as before (one request, same URL/headers/body) -> sent_and_billed",async()=>{
 const {logs,c}=cons();const k=cryptoKit(KEY,c);
 const cases=[
  {channel:"instagram",token:IG_TOKEN,url:"https://graph.instagram.com/v21.0/me/messages",
   headers:{"content-type":"application/json",authorization:`Bearer ${IG_TOKEN}`},
   body:{recipient:{id:"555"},message:{text:"reply text"}}},
  {channel:"instagram",token:EAA_TOKEN,url:"https://graph.facebook.com/v21.0/1789/messages",
   headers:{"content-type":"application/json"},
   body:{recipient:{id:"555"},message:{text:"reply text"},access_token:EAA_TOKEN}},
  {channel:"facebook",token:EAA_TOKEN,url:"https://graph.facebook.com/v21.0/me/messages",
   headers:{"content-type":"application/json"},
   body:{recipient:{id:"555"},message:{text:"reply text"},access_token:EAA_TOKEN}},
 ];
 for(const x of cases){
  const ff=fakeFetch();
  const send=webhookSend({channel:x.channel,chatId:x.channel+":555",
   account:{id:ACC,external_id:"1789",access_token_encrypted:await k.encryptField(x.token)},
   decryptAccessTokenStrict:k.decryptAccessTokenStrict,sendMetaDirectMessage:metaSender(ff.f),console:c,decryptField:k.decryptField});
  const r=await runWebhook(send);
  assert.equal(r.outcome,"sent_and_billed");
  assert.deepEqual(r.persisted,["o1:mid.OK1"]);
  assert.equal(ff.calls.length,1);
  assert.equal(ff.calls[0].url,x.url);
  assert.equal(ff.calls[0].init.method,"POST");
  assert.deepEqual(ff.calls[0].init.headers,x.headers);
  assert.deepEqual(JSON.parse(ff.calls[0].init.body),x.body);
 }
 assert.deepEqual(logs,[],"a valid send logs nothing from the token path");
});

// ===================================================== sendToConversation
test("(b) sendToConversation (dashboard/manual send): undecryptable token -> clear 'relink' error, NO fetch; (c) valid token sends",async()=>{
 const {logs,c}=cons();const k=cryptoKit(KEY,c);
 const good=await k.encryptField(EAA_TOKEN);const bad=tamper(good);
 for(const legacyShape of [false,true]){
  const ff=fakeFetch();
  const stored={v:bad};
  const fn=sendToConversation({
   fetchAccountWithToken:async()=>({id:ACC,tenant_id:TEN,external_id:"1789",access_token_encrypted:stored.v}),
   decryptAccessTokenStrict:k.decryptAccessTokenStrict,sendMetaDirectMessage:metaSender(ff.f),console:c,decryptField:k.decryptField});
  const conv=()=>legacyShape
   ?{channel:"facebook",recipient:"555",account:{external_id:"1789",access_token_encrypted:stored.v}}
   :{channel:"facebook",account_id:ACC,wa_chat_id:"facebook:555"};
  await assert.rejects(fn(null,TEN,conv(),"hello"),
   (e:any)=>/لا يوجد توكن محفوظ لحساب facebook — أعد ربط الحساب/.test(e.message));
  assert.equal(ff.calls.length,0,"no request to Meta with a placeholder token");
  stored.v=good;
  await fn(null,TEN,conv(),"hello");
  assert.equal(ff.calls.length,1,"valid token still sends");
  assert.equal(ff.calls[0].url,"https://graph.facebook.com/v21.0/me/messages");
  assert.deepEqual(JSON.parse(ff.calls[0].init.body),
   {recipient:{id:"555"},message:{text:"hello"},access_token:EAA_TOKEN});
 }
 assert.deepEqual(logs,[["warn",["[sendToConversation] token_unavailable"]],["warn",["[sendToConversation] token_unavailable"]]]);
 assertCleanLogs(logs,[good,bad,EAA_TOKEN,ACC,TEN]);
});

// ===================================================== profile fetch
test("(b) instagram_webhook profile fetch: undecryptable token -> fetch never called, no profile; (c) valid token fetches",async()=>{
 const {logs,c}=cons();const k=cryptoKit(KEY,c);
 const good=await k.encryptField(IG_TOKEN);const bad=tamper(good);
 const ff=fakeFetch();
 const fsp=fetchSenderProfile(async(url:string)=>{ff.calls.push({url,init:null});
  return {ok:true,json:async()=>({name:CUSTOMER,profile_pic:"https://x.test/p.jpg"})};},c);
 const block=profileBlock({decryptAccessTokenStrict:k.decryptAccessTokenStrict,fetchSenderProfile:fsp,console:c});
 const msg={senderId:"555"};
 const none=await block({id:ACC,tenant_id:TEN,access_token_encrypted:bad},msg,"instagram",k.decryptAccessTokenStrict,fsp,c,k.decryptField);
 assert.deepEqual(none,{name:null,avatar:null});
 assert.equal(ff.calls.length,0,"no profile request with a placeholder token");
 assert.deepEqual(logs,[["warn",["[instagram_webhook] token_unavailable; profile fetch skipped"]]]);
 const ok=await block({id:ACC,tenant_id:TEN,access_token_encrypted:good},msg,"instagram",k.decryptAccessTokenStrict,fsp,c,k.decryptField);
 assert.equal(ok.name,CUSTOMER);
 assert.equal(ff.calls.length,1);
 assert.ok(ff.calls[0].url.startsWith("https://graph.instagram.com/v21.0/555?fields=name,username,profile_pic&access_token="));
 assertCleanLogs(logs,[good,bad,IG_TOKEN,ACC,TEN,CUSTOMER]);
});

// ===================================================== static inventory
test("static: every Meta token call site uses the strict helper; only Salla still uses decryptField for a token",()=>{
 const tokenDecrypts=[...IDX.matchAll(/await (decrypt\w+)\(\s*(\w+)\.access_token_encrypted/g)].map(m=>m[1]+":"+m[2]);
 assert.deepEqual(tokenDecrypts,[
  "decryptAccessTokenStrict:account", // sendToConversation (legacy conv.account)
  "decryptAccessTokenStrict:account", // sendToConversation (account_id)
  "decryptAccessTokenStrict:account", // webhook AI/V2 send hook
  "decryptAccessTokenStrict:account", // instagram_webhook profile fetch
  "decryptField:sallaAcc",            // Salla API (not Meta; out of this scope)
 ]);
 assert.doesNotMatch(IDX,/Decryption failed for value/);
 assert.doesNotMatch(IDX,/token decrypt failed \| account=/);
});
