// fetchSenderProfile (supabase/functions/milan-api/index.ts) builds a Meta
// Graph URL that carries `access_token=<token>`. Its FAILURE logs must never
// contain the token, the URL, Meta's free-text error message or the senderId:
//  - catch: a fixed category only (network / timeout / bad_response / unknown),
//    never e.message / stack / cause / the error object;
//  - !res.ok: HTTP status + a sanitized Meta error code only.
// Behaviour is otherwise unchanged (same URLs, same {name,avatar} results, same
// success log). Behavioural: the REAL function is sliced out of index.ts,
// type-stripped and run with a fake fetch and a captured console (same
// technique as tests/milan-token-decrypt-strict.test.ts). No Deno, no network.
// Run: node --experimental-strip-types --test tests/milan-profile-fetch-log-safety.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {inspect} from "node:util";
import {stripTypeScriptTypes} from "node:module";

const IDX=readFileSync("supabase/functions/milan-api/index.ts","utf8");
function between(a:string,b:string,from=0){
 const i=IDX.indexOf(a,from);const j=IDX.indexOf(b,i+a.length);
 assert.ok(i>=0&&j>i,"located: "+a.slice(0,50));
 return IDX.slice(i,j);
}
const FSP_SRC=between("async function fetchSenderProfile(","async function handleIncomingWebhookMessage(");
function load(fetch:any,console:any){
 return new Function("fetch","console",stripTypeScriptTypes(FSP_SRC,{mode:"strip"})+"\nreturn fetchSenderProfile;")(fetch,console);
}

type Log=[string,unknown[]];
function cons(){const logs:Log[]=[];const c:any={};
 for(const k of ["log","info","warn","error","debug"])c[k]=(...a:unknown[])=>logs.push([k,a]);
 return {logs,c};}

const IG_TOKEN="IGQVJ-LEAKCANARY-ig-token-7f3a9c";
const EAA_TOKEN="EAA-LEAKCANARY-page-token-5b2e1d";
const SENDER="17841400000099887";
const META_MSG="Malformed access token";

const PATHS=[
 {channel:"instagram",token:IG_TOKEN,host:"graph.instagram.com",
  url:`https://graph.instagram.com/v21.0/${SENDER}?fields=name,username,profile_pic&access_token=${encodeURIComponent(IG_TOKEN)}`},
 {channel:"instagram",token:EAA_TOKEN,host:"graph.facebook.com",
  url:`https://graph.facebook.com/v21.0/${SENDER}?fields=name,profile_picture&access_token=${encodeURIComponent(EAA_TOKEN)}`},
 {channel:"facebook",token:EAA_TOKEN,host:"graph.facebook.com",
  url:`https://graph.facebook.com/v21.0/${SENDER}?fields=name,picture&access_token=${encodeURIComponent(EAA_TOKEN)}`},
];

/** Every representation a log sink could render (JSON + full inspect incl. stack/cause/hidden). */
function rendered(logs:Log[]){
 return JSON.stringify(logs)+"\n"+inspect(logs,{depth:null,showHidden:true})+"\n"+
  logs.map(([,a])=>a.map(x=>{try{return String(x);}catch{return "";}}).join(" ")).join("\n");
}
function assertNoLeak(logs:Log[],p:{token:string,host:string}){
 const r=rendered(logs);
 for(const s of [p.token,encodeURIComponent(p.token),"LEAKCANARY","access_token=","access_token",p.host,
  "/v21.0/","fields=",SENDER,META_MSG,"https://"])
  assert.ok(!r.includes(s),"never logged: "+s.slice(0,14));
}
function onlyFailureLog(logs:Log[],category:string){
 assert.deepEqual(logs,[["warn",["[fetchSenderProfile] failed",{category}]]],"fixed category only");
}

// ===================================================== (a) network error embeds the URL
test("(a)+(e) fetch throws a TypeError whose message is the full URL: only category 'network' is logged; result {null,null}; all three paths",async()=>{
 for(const p of PATHS){
  const {logs,c}=cons();const calls:string[]=[];
  const fsp=load(async(url:string)=>{calls.push(url);
   const e=new TypeError(`error sending request for url (${url}): connection refused`);
   (e as any).cause=new Error("tcp connect error "+url);throw e;},c);
  assert.deepEqual(await fsp({channel:p.channel,senderId:SENDER,token:p.token}),{name:null,avatar:null});
  assert.deepEqual(calls,[p.url],"same request URL as before");
  onlyFailureLog(logs,"network");
  assertNoLeak(logs,p);
 }
});
test("(a) timeout / abort / code-only errors map to fixed categories, nothing else logged",async()=>{
 const p=PATHS[0];
 const mk=(name:string,code?:string)=>{const e=new Error("aborted "+p.url);e.name=name;if(code)(e as any).code=code;return e;};
 const cases:[unknown,string][]=[
  [mk("AbortError"),"timeout"],[mk("TimeoutError"),"timeout"],[mk("Error","UND_ERR_CONNECT_TIMEOUT"),"timeout"],
  [mk("Error","ECONNRESET"),"network"],[mk("RangeError"),"unknown"],
 ];
 for(const [err,cat] of cases){
  const {logs,c}=cons();
  const r=await load(async()=>{throw err;},c)({channel:p.channel,senderId:SENDER,token:p.token});
  assert.deepEqual(r,{name:null,avatar:null});
  onlyFailureLog(logs,cat);assertNoLeak(logs,p);
 }
});

// ===================================================== (b) HTTP error with token-echoing message
test("(b)+(e) HTTP 400 JSON echoing the token: logs status + numeric code only; no message, no senderId, no token",async()=>{
 for(const p of PATHS){
  const {logs,c}=cons();
  const fsp=load(async(url:string)=>({ok:false,status:400,json:async()=>({error:{
   message:`${META_MSG} input: ${p.token} for ${url}`,type:"OAuthException",code:190,fbtrace_id:"AbCdTrace"}})}),c);
  assert.deepEqual(await fsp({channel:p.channel,senderId:SENDER,token:p.token}),{name:null,avatar:null});
  assert.deepEqual(logs,[["warn",["[fetchSenderProfile] http_error",{status:400,code:190}]]]);
  assert.match(rendered(logs),/400/);assert.match(rendered(logs),/190/);
  assertNoLeak(logs,p);
 }
});
test("(b) Meta code sanitizer: short safe strings kept; token-bearing / long / non-scalar codes omitted",async()=>{
 const p=PATHS[0];
 const cases:[any,unknown][]=[
  [{error:{code:"OAuthException"}},"OAuthException"],
  [{code:"rate_limit.v2-1"},"rate_limit.v2-1"],
  [{error_type:"IGApiException"},"IGApiException"],
  [{error:{code:`bad ${p.token}`}},undefined],
  [{error:{code:p.token+p.token}},undefined],
  [{error:{code:"x".repeat(41)}},undefined],
  [{error:{code:{url:p.url}}},undefined],
  [{error:{code:Number.NaN}},undefined],
  [{error:{code:""}},undefined],
  [{error_message:`${META_MSG} ${p.token}`,message:p.url},undefined],
 ];
 for(const [body,code] of cases){
  const {logs,c}=cons();
  const r=await load(async()=>({ok:false,status:401,json:async()=>body}),c)({channel:p.channel,senderId:SENDER,token:p.token});
  assert.deepEqual(r,{name:null,avatar:null});
  assert.deepEqual(logs,[["warn",["[fetchSenderProfile] http_error",{status:401,code}]]]);
  assertNoLeak(logs,p);
 }
});

// ===================================================== (c) non-JSON error body
test("(c) non-JSON error body / res.json() throwing (message with token+URL): status only, no leak",async()=>{
 for(const p of PATHS){
  for(const thrown of [new SyntaxError(`Unexpected token < in JSON at ${p.url}`),`raw ${p.token}`,{url:p.url}]){
   const {logs,c}=cons();
   const r=await load(async()=>({ok:false,status:502,json:async()=>{throw thrown;},
    text:async()=>`<html>${p.token}</html>`}),c)({channel:p.channel,senderId:SENDER,token:p.token});
   assert.deepEqual(r,{name:null,avatar:null});
   assert.deepEqual(logs,[["warn",["[fetchSenderProfile] http_error",{status:502,code:undefined}]]]);
   assertNoLeak(logs,p);
  }
 }
});
test("(c) success status but res.json() throws (SyntaxError with token): category bad_response only",async()=>{
 const p=PATHS[1];const {logs,c}=cons();
 const r=await load(async()=>({ok:true,status:200,json:async()=>{throw new SyntaxError("bad json "+p.url);}}),c)(
  {channel:p.channel,senderId:SENDER,token:p.token});
 assert.deepEqual(r,{name:null,avatar:null});
 onlyFailureLog(logs,"bad_response");assertNoLeak(logs,p);
});

// ===================================================== (d) odd thrown values
test("(d) error without message / non-Error thrown values (string with token, object with url, null, hostile getters): 'unknown', no leak",async()=>{
 for(const p of PATHS){
  const noMsg=new Error();(noMsg as any).cause={url:p.url};
  const hostile={get name(){throw new Error(p.url);},get code(){throw new Error(p.token);},toString(){return p.url;}};
  const values:unknown[]=[noMsg,`fetch failed ${p.url} ${p.token}`,{url:p.url,token:p.token},null,undefined,42,hostile,
   Object.assign(Object.create(null),{message:p.url})];
  for(const v of values){
   const {logs,c}=cons();
   const r=await load(async()=>{throw v;},c)({channel:p.channel,senderId:SENDER,token:p.token});
   assert.deepEqual(r,{name:null,avatar:null});
   onlyFailureLog(logs,"unknown");assertNoLeak(logs,p);
  }
 }
});

// ===================================================== (f) success control
test("(f) success path unchanged: same URLs, parsed name/avatar, success log present/missing only",async()=>{
 const bodies=[
  {body:{name:"  Layla Customer ",profile_pic:"https://cdn.test/a.jpg"},want:{name:"Layla Customer",avatar:"https://cdn.test/a.jpg"}},
  {body:{username:" layla_c ",profile_picture:"https://cdn.test/b.jpg"},want:{name:"@layla_c",avatar:"https://cdn.test/b.jpg"}},
  {body:{name:" ",picture:{data:{url:"https://cdn.test/c.jpg"}}},want:{name:null,avatar:"https://cdn.test/c.jpg"}},
  {body:{},want:{name:null,avatar:null}},
 ];
 for(const p of PATHS)for(const b of bodies){
  const {logs,c}=cons();const calls:string[]=[];
  const r=await load(async(url:string)=>{calls.push(url);return {ok:true,status:200,json:async()=>b.body};},c)(
   {channel:p.channel,senderId:SENDER,token:p.token});
  assert.deepEqual(r,b.want);
  assert.deepEqual(calls,[p.url]);
  assert.deepEqual(logs,[["log",["[fetchSenderProfile]",{senderId:SENDER,
   name:b.want.name?"present":"missing",avatar:b.want.avatar?"present":"missing"}]]]);
  const flat=rendered(logs);
  assert.ok(!flat.includes("Layla")&&!flat.includes("layla")&&!flat.includes("cdn.test"),"no name/avatar values");
  assert.ok(!flat.includes(p.token)&&!flat.includes("access_token"),"no token");
 }
});
test("(f) guards unchanged: whatsapp / no token / no senderId -> no fetch, no log, {null,null}",async()=>{
 for(const o of [{channel:"whatsapp",senderId:SENDER,token:EAA_TOKEN},{channel:"instagram",senderId:SENDER,token:null},
  {channel:"facebook",senderId:"",token:EAA_TOKEN}]){
  const {logs,c}=cons();let n=0;
  assert.deepEqual(await load(async()=>{n++;return {ok:true,json:async()=>({})};},c)(o),{name:null,avatar:null});
  assert.equal(n,0);assert.deepEqual(logs,[]);
 }
});

// ===================================================== (g) source guard
test("(g) static: fetchSenderProfile never logs error text, the error object, errMsg or the senderId on failure",()=>{
 assert.doesNotMatch(FSP_SRC,/e\?\.message|\be\.message|errMsg|\.stack\b|\.cause\b/);
 assert.doesNotMatch(FSP_SRC,/console\.\w+\([^;]*,\s*e\s*\)/,"no console.*(..., e)");
 assert.doesNotMatch(FSP_SRC,/console\.\w+\([^;]*\bur[li]\b/i,"the URL is never logged");
 const fail=FSP_SRC.slice(FSP_SRC.indexOf("if (!res.ok)"),FSP_SRC.indexOf("const pj"));
 assert.ok(fail.length>0,"located the !res.ok branch");
 assert.doesNotMatch(fail,/console\.warn\([^;]*(senderId|message)/,"failure log: no senderId/message");
 const cat=FSP_SRC.slice(FSP_SRC.lastIndexOf("} catch (e"));
 assert.match(cat,/console\.warn\("\[fetchSenderProfile\] failed", \{ category \}\);/);
 assert.match(fail,/console\.warn\("\[fetchSenderProfile\] http_error", \{ status: res\.status, code \}\);/);
});
