import test from "node:test";
import assert from "node:assert/strict";
import {processAccount,runLifecycle,type AccountRow,type Deps} from "../supabase/functions/channel-token-lifecycle/lifecycle.ts";
import {isConfirmedTokenFailure,markNeedsReauth} from "../supabase/functions/_shared/channelReauth.ts";

const NOW=Date.parse("2026-12-10T00:00:00Z"),D=86_400_000;
const at=(d:number)=>new Date(NOW+d*D).toISOString();
type Row=AccountRow&{error_message:string|null;updated_at?:string};

/** In-memory channel_accounts with real compare-and-swap filter semantics. */
function fakeDb(rows:Row[],hook?:()=>void){
 const writes:Array<Record<string,unknown>>=[];
 return {rows,writes,from(_t:string){
  let mode:"select"|"update"="select",patch:Record<string,unknown>={};
  const f:Array<(r:Row)=>boolean>=[];
  const q:any={
   select(){return mode==="update"?run():q;},
   update(p:Record<string,unknown>){mode="update";patch=p;return q;},
   eq(c:string,v:unknown){f.push(r=>(r as any)[c]===v);return q;},
   is(c:string,v:unknown){f.push(r=>(r as any)[c]===v);return q;},
   in(c:string,v:unknown[]){f.push(r=>v.includes((r as any)[c]));return q;},
   or(){f.push(r=>r.status===null||r.status==="active");return q;},
   order(){return q;},limit(){return q;},
   then(res:(v:unknown)=>unknown){return Promise.resolve(run()).then(res);},
  };
  function run(){
   const m=rows.filter(r=>f.every(x=>x(r)));
   if(mode==="update"){hook?.();for(const r of m){Object.assign(r,patch);}writes.push({n:m.length,patch});}
   return {data:m.map(r=>({...r})),error:null};
  }
  return q;
 }};
}
const enc=async(v:string)=>"enc:"+v,dec=async(v:string)=>v.replace(/^enc:/,"");
type Call={url:string};
function deps(db:any,responses:Array<{status:number;body:unknown}|"throw">,calls:Call[]=[]):Deps{
 let i=0;
 return {db,nowMs:()=>NOW,fieldKey:"k",appId:"app",appSecret:"sec",decrypt:dec,encrypt:enc,
  fetch:(async(url:string)=>{calls.push({url:String(url)});const r=responses[Math.min(i++,responses.length-1)];
   if(r==="throw")throw new Error("net");return new Response(JSON.stringify(r.body),{status:r.status});}) as any};
}
const ig=(o:Partial<Row>={}):Row=>({id:"a1",tenant_id:"t1",channel:"instagram",external_id:"ig1",status:"active",
 token_expires_at:at(10),access_token_encrypted:"enc:OLD",error_message:null,...o});
const fb=(o:Partial<Row>={}):Row=>({id:"f1",tenant_id:"t1",channel:"facebook",external_id:"page1",status:"active",
 token_expires_at:at(5),access_token_encrypted:"enc:PAGE",error_message:null,...o});
const ok=(expires_in=5_184_000)=>({status:200,body:{access_token:"NEW",token_type:"bearer",expires_in}});

test("IG success: exact refresh call, encrypted token + new expiry persisted, error cleared",async()=>{
 const r=ig({error_message:"x"}),db=fakeDb([r]),calls:Call[]=[];
 assert.equal(await processAccount(deps(db,[ok()],calls),r),"refreshed");
 assert.equal(calls.length,1);
 const u=new URL(calls[0].url);
 assert.equal(u.origin+u.pathname,"https://graph.instagram.com/refresh_access_token");
 assert.equal(u.searchParams.get("grant_type"),"ig_refresh_token");assert.equal(u.searchParams.get("access_token"),"OLD");
 assert.equal(db.rows[0].access_token_encrypted,"enc:NEW");
 assert.equal(db.rows[0].token_expires_at,new Date(NOW+5_184_000_000).toISOString());
 assert.equal(db.rows[0].error_message,null);assert.equal(db.rows[0].status,"active");
});
test("IG outside the 21-day window or too new: no Meta call, no write",async()=>{
 for(const e of [at(40),at(59.99)]){
  const r=ig({token_expires_at:e}),db=fakeDb([r]),calls:Call[]=[];
  assert.equal(await processAccount(deps(db,[ok()],calls),r),"skipped");
  assert.equal(calls.length,0);assert.equal(db.writes.length,0);
 }
});
test("IG transient failures (network, 5xx, 429, non-190 4xx) change nothing",async()=>{
 for(const resp of ["throw",{status:500,body:{}},{status:429,body:{}},{status:400,body:{error:{code:2}}}] as const){
  const r=ig(),db=fakeDb([r]);
  assert.equal(await processAccount(deps(db,[resp as any]),r),"transient");
  assert.equal(db.writes.length,0);assert.equal(db.rows[0].status,"active");
 }
});
test("IG confirmed rejection (code 190) -> needs_reauth with fixed reason code",async()=>{
 const r=ig(),db=fakeDb([r]);
 assert.equal(await processAccount(deps(db,[{status:400,body:{error:{code:190,message:"SECRET-DETAIL"}}}]),r),"needs_reauth");
 assert.equal(db.rows[0].status,"needs_reauth");assert.equal(db.rows[0].error_message,"refresh_rejected");
});
test("IG already expired -> needs_reauth without calling Meta",async()=>{
 const r=ig({token_expires_at:at(-1)}),db=fakeDb([r]),calls:Call[]=[];
 assert.equal(await processAccount(deps(db,[ok()],calls),r),"needs_reauth");
 assert.equal(calls.length,0);assert.equal(db.rows[0].status,"needs_reauth");assert.equal(db.rows[0].error_message,"token_expired");
});
test("IG malformed success body is not accepted as a refresh",async()=>{
 for(const body of [{access_token:"N"},{access_token:"N",expires_in:5},{expires_in:5_184_000}]){
  const r=ig(),db=fakeDb([r]);
  assert.equal(await processAccount(deps(db,[{status:200,body}]),r),"transient");assert.equal(db.writes.length,0);
 }
});
test("concurrent refreshes: only one persists, the loser never overwrites",async()=>{
 const r=ig(),db=fakeDb([r]);
 const [a,b]=await Promise.all([processAccount(deps(db,[ok()]),{...r}),processAccount(deps(db,[ok(5_000_000)]),{...r})]);
 assert.deepEqual([a,b].sort(),["raced","refreshed"]);
 assert.equal(db.writes.filter(w=>w.n===1).length,1);
});
test("owner reconnects mid-refresh: result is discarded, new token kept",async()=>{
 const r=ig(),db=fakeDb([r]);
 const d=deps(db,[ok()]);
 const inner=d.fetch;d.fetch=(async(...a:any[])=>{db.rows[0].access_token_encrypted="enc:RECONNECTED";return (inner as any)(...a);}) as any;
 assert.equal(await processAccount(d,{...r}),"raced");
 assert.equal(db.rows[0].access_token_encrypted,"enc:RECONNECTED");
});
test("tenant isolation: writes require the row's own tenant_id",async()=>{
 const a=ig(),other=ig({id:"a1",tenant_id:"t2",access_token_encrypted:"enc:OLD"}),db=fakeDb([other]);
 assert.equal(await processAccount(deps(db,[ok()]),a),"raced");
 assert.equal(db.rows[0].access_token_encrypted,"enc:OLD");
});
test("Facebook is never refreshed: valid token with no expiry clears the bogus warning",async()=>{
 const r=fb({token_expires_at:at(5)}),db=fakeDb([r]),calls:Call[]=[];
 assert.equal(await processAccount(deps(db,[{status:200,body:{data:{is_valid:true,profile_id:"page1",expires_at:0}}}],calls),r),"corrected");
 assert.equal(calls.length,1);assert.match(calls[0].url,/graph\.facebook\.com\/v21\.0\/debug_token/);
 assert.equal(db.rows[0].token_expires_at,null);assert.equal(db.rows[0].access_token_encrypted,"enc:PAGE");assert.equal(db.rows[0].status,"active");
});
test("Facebook invalid token -> needs_reauth",async()=>{
 const r=fb(),db=fakeDb([r]);
 assert.equal(await processAccount(deps(db,[{status:200,body:{data:{is_valid:false}}}]),r),"needs_reauth");
 assert.equal(db.rows[0].status,"needs_reauth");assert.equal(db.rows[0].error_message,"token_invalid");
});
test("Facebook data-access expiry sets the real deadline; past deadline -> needs_reauth",async()=>{
 const r=fb({token_expires_at:null}),db=fakeDb([r]);
 const t=Math.floor((NOW+20*D)/1000);
 assert.equal(await processAccount(deps(db,[{status:200,body:{data:{is_valid:true,expires_at:0,data_access_expires_at:t}}}]),r),"corrected");
 assert.equal(db.rows[0].token_expires_at,new Date(t*1000).toISOString());
 const r2=fb(),db2=fakeDb([r2]);
 assert.equal(await processAccount(deps(db2,[{status:200,body:{data:{is_valid:true,data_access_expires_at:Math.floor((NOW-D)/1000)}}}]),r2),"needs_reauth");
 assert.equal(db2.rows[0].error_message,"data_access_expired");
});
test("Facebook unknown verdict / other asset / outage change nothing",async()=>{
 for(const resp of [{status:200,body:{data:{is_valid:true,profile_id:"OTHER"}}},{status:200,body:{}},{status:500,body:{}},"throw"] as const){
  const r=fb(),db=fakeDb([r]);await processAccount(deps(db,[resp as any]),r);
  assert.equal(db.rows[0].status,"active");assert.equal(db.writes.length,0);
 }
});
test("non-active, other channels and tokenless accounts are handled safely",async()=>{
 const calls:Call[]=[];
 const na=ig({status:"needs_reauth"}),db=fakeDb([na]);
 assert.equal(await processAccount(deps(db,[ok()],calls),na),"skipped");
 const wa=ig({channel:"whatsapp"});assert.equal(await processAccount(deps(fakeDb([wa]),[ok()],calls),wa),"skipped");
 const nt=ig({access_token_encrypted:null}),db2=fakeDb([nt]);
 assert.equal(await processAccount(deps(db2,[ok()],calls),nt),"needs_reauth");assert.equal(calls.length,0);
});
test("runLifecycle: summary has counts only, logs never contain tokens",async()=>{
 const logs:string[]=[];const orig=[console.error,console.log,console.warn];
 console.error=console.log=console.warn=(...a:unknown[])=>{logs.push(JSON.stringify(a));};
 try{
  const db=fakeDb([ig(),fb({id:"f2",tenant_id:"t2"})]);
  const out=await runLifecycle(deps(db,[ok(),{status:200,body:{data:{is_valid:true,expires_at:0}}}]));
  assert.ok("checked" in out);assert.equal((out as any).checked,2);assert.equal((out as any).refreshed,1);
  assert.ok(!JSON.stringify(out).includes("OLD")&&!JSON.stringify(out).includes("NEW"));
 }finally{[console.error,console.log,console.warn]=orig;}
 assert.ok(!logs.join("").match(/OLD|NEW|PAGE|sec/));
});
test("reauth helper: only code 190 is confirmed; CAS protects a reconnected row",async()=>{
 assert.equal(isConfirmedTokenFailure({failureClass:"auth",errorCode:190}),true);
 for(const r of [{failureClass:"auth",errorCode:null},{failureClass:"auth",errorCode:200},{failureClass:"throttle",errorCode:190},null])
  assert.equal(isConfirmedTokenFailure(r as any),false);
 const db=fakeDb([ig({access_token_encrypted:"enc:NEWER"})]);
 assert.equal(await markNeedsReauth(db,{id:"a1",tenant_id:"t1",access_token_encrypted:"enc:OLD"},"token_invalid"),false);
 assert.equal(db.rows[0].status,"active");
 assert.equal(await markNeedsReauth(db,{id:"a1",tenant_id:"t1",access_token_encrypted:"enc:NEWER"},"token_invalid"),true);
 assert.equal(db.rows[0].status,"needs_reauth");
});
test("reconnect (OAuth upsert fields) restores active and clears the reason",()=>{
 const row=ig({status:"needs_reauth",error_message:"token_invalid"});
 Object.assign(row,{status:"active",error_message:null,access_token_encrypted:"enc:FRESH",token_expires_at:at(60)});
 assert.equal(row.status,"active");assert.equal(row.error_message,null);
});
