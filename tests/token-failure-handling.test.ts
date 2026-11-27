import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import {classifyMetaTokenError,reauthReasonForFailure,safeReauthReason,markNeedsReauth,REAUTH_REASONS} from "../supabase/functions/_shared/channelReauth.ts";
import {processAccount,type AccountRow,type Deps} from "../supabase/functions/channel-token-lifecycle/lifecycle.ts";
import {channelTokenNotice,channelTokenState} from "../src/lib/channelTokenState.ts";

/* ───────── classification: what is a reconnect request and what is not ───────── */
test("only Meta code 190 requests a reconnect; subcodes refine the reason",()=>{
 const reason=(s:number|null,c:number|null,sub:number|null)=>{const v=classifyMetaTokenError(s,c,sub);return v.kind==="reauth"?v.reason:v.kind;};
 assert.equal(reason(400,190,463),"token_expired");
 assert.equal(reason(400,190,460),"password_changed");
 assert.equal(reason(400,190,458),"permission_revoked");
 assert.equal(reason(400,190,459),"checkpoint_required");
 assert.equal(reason(400,190,464),"checkpoint_required");
 assert.equal(reason(400,190,467),"token_invalid");
 assert.equal(reason(400,190,null),"token_invalid");
});
test("temporary failures never request a reconnect",()=>{
 for(const [s,c] of [[null,null],[500,null],[502,190+1],[503,null],[429,null],[400,1],[400,2],[400,4],[400,17],[400,32],[400,613],[400,368]] as const)
  assert.equal(classifyMetaTokenError(s,c,null).kind,"temporary",`${s}/${c}`);
});
test("permission / parameter / app-configuration errors are 'config', never a reconnect",()=>{
 for(const c of [10,100,200,210,299])assert.equal(classifyMetaTokenError(400,c,null).kind,"config",String(c));
});
test("unknown errors and 401/403 without a code are not a reconnect request",()=>{
 assert.equal(classifyMetaTokenError(400,2635,null).kind,"unknown");
 assert.equal(classifyMetaTokenError(401,null,null).kind,"unknown");
 assert.equal(classifyMetaTokenError(403,null,null).kind,"unknown");
});
test("a failed SEND is a confirmed token failure only for class auth + code 190",()=>{
 assert.equal(reauthReasonForFailure({failureClass:"auth",errorCode:190,errorSubcode:463}),"token_expired");
 assert.equal(reauthReasonForFailure({failureClass:"auth",errorCode:190,errorSubcode:null}),"token_invalid");
 for(const r of [{failureClass:"auth",errorCode:null},{failureClass:"throttled",errorCode:190},{failureClass:"ambiguous",errorCode:190},{failureClass:"auth",errorCode:200},null])
  assert.equal(reauthReasonForFailure(r as any),null);
});
test("only the closed reason list ever leaves the server",()=>{
 for(const r of REAUTH_REASONS)assert.equal(safeReauthReason(r),r);
 for(const bad of ["<script>","Invalid OAuth access token — secret detail","",null,undefined,42,"token_expired "])assert.equal(safeReauthReason(bad),null);
});

/* ───────── lifecycle transitions with a real compare-and-swap fake ───────── */
const NOW=Date.parse("2026-12-10T00:00:00Z"),D=86_400_000;
const at=(d:number)=>new Date(NOW+d*D).toISOString();
type Row=AccountRow&{error_message:string|null};
function fakeDb(rows:Row[]){
 const writes:Array<{n:number;patch:Record<string,unknown>}>=[];
 return {rows,writes,from(_t:string){
  const f:Array<(r:Row)=>boolean>=[];let patch:Record<string,unknown>|null=null;
  const q:any={update(p:Record<string,unknown>){patch=p;return q;},eq(c:string,v:unknown){f.push(r=>(r as any)[c]===v);return q;},
   is(c:string,v:unknown){f.push(r=>(r as any)[c]===v);return q;},
   select(){const m=rows.filter(r=>f.every(x=>x(r)));if(patch)for(const r of m)Object.assign(r,patch);writes.push({n:m.length,patch:patch??{}});return Promise.resolve({data:m.map(r=>({...r})),error:null});}};
  return q;}};
}
const ig=(o:Partial<Row>={}):Row=>({id:"a1",tenant_id:"t1",channel:"instagram",external_id:"ig1",status:"active",token_expires_at:at(10),access_token_encrypted:"enc:OLD",error_message:null,...o});
const fb=(o:Partial<Row>={}):Row=>({id:"f1",tenant_id:"t1",channel:"facebook",external_id:"page1",status:"active",token_expires_at:at(5),access_token_encrypted:"enc:PAGE",error_message:null,...o});
function deps(db:any,resp:{status:number;body:unknown}|"throw"):Deps{
 return {db,nowMs:()=>NOW,fieldKey:"k",appId:"app",appSecret:"sec",decrypt:async(v)=>v.replace(/^enc:/,""),encrypt:async(v)=>"enc:"+v,
  fetch:(async()=>{if(resp==="throw")throw new Error("net");return new Response(JSON.stringify(resp.body),{status:resp.status});}) as any};
}
const err=(code:number,subcode?:number)=>({error:{code,...(subcode!==undefined?{error_subcode:subcode}:{}),message:"SECRET-META-TEXT"}});

test("Instagram refresh: 190 with a subcode becomes needs_reauth with that reason; the row keeps its token",async()=>{
 for(const [sub,reason] of [[463,"token_expired"],[460,"password_changed"],[458,"permission_revoked"],[undefined,"refresh_rejected"]] as const){
  const r=ig(),db=fakeDb([r]);
  assert.equal(await processAccount(deps(db,{status:400,body:err(190,sub)}),{...r}),"needs_reauth");
  assert.equal(db.rows[0].status,"needs_reauth");assert.equal(db.rows[0].error_message,reason);assert.equal(db.rows[0].access_token_encrypted,"enc:OLD");
 }
});
test("Instagram refresh: temporary failures leave a valid connection untouched",async()=>{
 for(const resp of ["throw",{status:500,body:{}},{status:503,body:err(2)},{status:429,body:{}},{status:400,body:err(4)},{status:400,body:err(613)},{status:400,body:err(2635)},{status:401,body:{}}] as const){
  const r=ig(),db=fakeDb([r]);
  assert.equal(await processAccount(deps(db,resp as any),{...r}),"transient",JSON.stringify(resp));
  assert.equal(db.rows[0].status,"active");assert.equal(db.writes.length,0);
 }
});
test("Instagram refresh: permission / parameter errors are counted as config_error and never change the status",async()=>{
 for(const code of [10,100,200]){
  const r=ig(),db=fakeDb([r]);
  assert.equal(await processAccount(deps(db,{status:400,body:err(code)}),{...r}),"config_error");
  assert.equal(db.rows[0].status,"active");assert.equal(db.writes.length,0);
 }
});
test("Facebook debug_token: Meta's reason for THIS token decides; temporary or app-credential errors never mark the account",async()=>{
 for(const [sub,reason] of [[463,"token_expired"],[460,"password_changed"],[458,"permission_revoked"],[459,"checkpoint_required"],[undefined,"token_invalid"]] as const){
  const r=fb(),db=fakeDb([r]);
  // debug_token reports the reason as data.error.subcode; Graph errors elsewhere use error_subcode.
  assert.equal(await processAccount(deps(db,{status:200,body:{data:{is_valid:false,error:{code:190,...(sub?{subcode:sub}:{}),message:"x"}}}}),{...r}),"needs_reauth");
  assert.equal(db.rows[0].error_message,reason);
 }
 {const r=fb(),db=fakeDb([r]);
  await processAccount(deps(db,{status:200,body:{data:{is_valid:false,error:{code:190,error_subcode:460,message:"x"}}}}),{...r});
  assert.equal(db.rows[0].error_message,"password_changed");}
 // App-level credential problem (190 about OUR app token) / outage / garbage: no state change.
 for(const resp of [{status:400,body:err(190)},{status:400,body:err(10)},{status:500,body:{}},{status:200,body:{}},"throw"] as const){
  const r=fb(),db=fakeDb([r]);
  const out=await processAccount(deps(db,resp as any),{...r});
  assert.ok(out==="config_error"||out==="transient",`${JSON.stringify(resp)} -> ${out}`);
  assert.equal(db.rows[0].status,"active");assert.equal(db.writes.length,0);
 }
});
test("tenant isolation: marking one account never touches another tenant's row or another account of the same tenant",async()=>{
 const a=ig({id:"a1",tenant_id:"t1"}),b=ig({id:"a1",tenant_id:"t2"}),c=ig({id:"a2",tenant_id:"t1",external_id:"ig2"});
 const db=fakeDb([a,b,c]);
 assert.equal(await markNeedsReauth(db,{id:"a1",tenant_id:"t1",access_token_encrypted:"enc:OLD"},"token_invalid"),true);
 assert.equal(db.rows[0].status,"needs_reauth");
 assert.equal(db.rows[1].status,"active");assert.equal(db.rows[2].status,"active");
 assert.equal(await markNeedsReauth(db,{id:"a1",tenant_id:"t1",access_token_encrypted:"enc:OLD"},"token_invalid"),false,"already marked: no second write");
});
test("a reconnect that stored a new token is never undone by a late failure report",async()=>{
 const r=ig({access_token_encrypted:"enc:NEW"}),db=fakeDb([r]);
 assert.equal(await markNeedsReauth(db,{id:"a1",tenant_id:"t1",access_token_encrypted:"enc:OLD"},"token_invalid"),false);
 assert.equal(db.rows[0].status,"active");
});

/* ───────── the milan-api send path: real source of ProviderHttpError + noteMetaSendFailure ───────── */
const MILAN=readFileSync("supabase/functions/milan-api/index.ts","utf8");
const cls=MILAN.slice(MILAN.indexOf("function safeProviderCode"),MILAN.indexOf("/** Builds a ProviderHttpError from a raw body"));
const helper=MILAN.slice(MILAN.indexOf("async function noteMetaSendFailure("),MILAN.indexOf("async function sendMetaDirectMessage(opts"));
const build=new Function(stripTypeScriptTypes(
 "function __wrap(markNeedsReauth,classifyMetaTokenError){\n"+cls+"\n"+helper+"\nreturn {ProviderHttpError,noteMetaSendFailure};\n}",
 {mode:"strip"})+"\nreturn __wrap;")();
function sendHarness(markImpl?:(...a:any[])=>Promise<boolean>){
 const calls:any[]=[];
 const mark=markImpl??(async(_sb:unknown,row:unknown,reason:unknown)=>{calls.push({row,reason});return true;});
 const {ProviderHttpError,noteMetaSendFailure}=build(mark,classifyMetaTokenError);
 return {calls,ProviderHttpError,note:noteMetaSendFailure};
}
test("milan-api send failure: Meta 190 marks the exact account with the token that was used",async()=>{
 const h=sendHarness();
 await h.note({}, {id:"acc1",access_token_encrypted:"enc:T"},"tenant-1",new h.ProviderHttpError("instagram send",400,190));
 assert.equal(h.calls.length,1);
 assert.deepEqual(h.calls[0],{row:{id:"acc1",tenant_id:"tenant-1",access_token_encrypted:"enc:T"},reason:"token_invalid"});
});
test("milan-api send failure: temporary, permission, unknown and non-Meta errors never mark anything",async()=>{
 const h=sendHarness();
 for(const e of [new h.ProviderHttpError("instagram send",500),new h.ProviderHttpError("instagram send",429),new h.ProviderHttpError("instagram send",400,4),
  new h.ProviderHttpError("instagram send",400,10),new h.ProviderHttpError("instagram send",400,100),new h.ProviderHttpError("instagram send",403),
  new Error("network down"),"string error",null])
  await h.note({}, {id:"acc1",access_token_encrypted:"enc:T"},"tenant-1",e);
 await h.note({}, null,"tenant-1",new h.ProviderHttpError("instagram send",400,190));
 await h.note({}, {id:"","access_token_encrypted":"x"},"tenant-1",new h.ProviderHttpError("instagram send",400,190));
 assert.equal(h.calls.length,0);
});
test("milan-api send failure: a failing database write never changes the caller's error handling",async()=>{
 const h=sendHarness(async()=>{throw new Error("db down");});
 await assert.doesNotReject(()=>h.note({}, {id:"acc1",access_token_encrypted:"enc:T"},"tenant-1",new h.ProviderHttpError("instagram send",400,190)));
});
test("milan-api wiring: both Meta send call sites pass the observer; the thrown error is unchanged",()=>{
 assert.equal((MILAN.match(/onFailure: \(e\) => noteMetaSendFailure\(sb, account, tenantId, e\),/g)??[]).length,2);
 assert.match(MILAN,/const failure = await providerHttpError\(`\$\{channel\} send`, res\);\n\s+if \(opts\.onFailure\) await opts\.onFailure\(failure\);\n\s+throw failure;/);
 assert.match(MILAN,/const providerMessageId=await sendMetaDirectMessage\(\{/);
});

/* ───────── what the customer sees ───────── */
test("dashboard guidance: every reconnect reason has specific Arabic text; unknown or missing reasons fall back to the generic text",()=>{
 const info=channelTokenState({status:"needs_reauth",tokenExpiresAt:null},NOW);
 const generic=channelTokenNotice(info)!;
 assert.equal(generic.severity,"error");assert.match(generic.text,/[؀-ۿ]/);
 const texts=new Set<string>();
 for(const r of REAUTH_REASONS){const n=channelTokenNotice(info,r)!;assert.match(n.text,/[؀-ۿ]/,r);assert.match(n.text,/أعد|اكمل|أكمل/,r);texts.add(n.text);}
 assert.ok(texts.size>=6,"reasons get distinct guidance");
 assert.equal(channelTokenNotice(info,"<b>x</b>")!.text,generic.text);
 assert.equal(channelTokenNotice(info,null)!.text,generic.text);
 // the reason only refines needs_reauth; healthy stays silent even if a stale reason is present
 assert.equal(channelTokenNotice(channelTokenState({status:"active",tokenExpiresAt:at(40)},NOW),"token_expired"),null);
});
test("channels function exposes only the closed reason, only for needs_reauth rows",()=>{
 const src=readFileSync("supabase/functions/channels/index.ts","utf8");
 assert.match(src,/needsReauthReason: row\.status === "needs_reauth" \? safeReauthReason\(row\.error_message\) : null,/);
 assert.match(src,/import \{ safeReauthReason \} from "\.\.\/_shared\/channelReauth\.ts";/);
});
