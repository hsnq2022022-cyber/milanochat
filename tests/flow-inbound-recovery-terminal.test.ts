// LIVE deliberate no-reply exits must never be answered LATE by the opt-in
// recovery sweeper (inboundRecovery.ts). milan-api/index.ts
// handleIncomingWebhookMessage records a terminal 'resolved' recovery row
// (markLiveNoReply -> flow_inbound_recovery_live_resolved, migration
// 20261029360000) on: human takeover, credits pause, auto reply off, no
// credits. Tenant missing/inactive exits happen BEFORE the inbound row is
// persisted, so discovery (which reads public.messages) cannot see them.
// Offline: a stateful fake with the SQL semantics of discovery/lease/finish and
// of the new function; the real SQL is exercised on a scratch PostgreSQL
// cluster by tests/flow-inbound-recovery-terminal-sql.test.mjs.
// Run: node --experimental-strip-types --test tests/flow-inbound-recovery-terminal.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInboundRecovery,markLiveNoReply,LIVE_NO_REPLY_REASONS,RECOVERY_GRACE_SECONDS,
 type LiveNoReplyReason,type RedriveEvent} from "../supabase/functions/milan-api/inboundRecovery.ts";

const T="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC="11111111-1111-4111-8111-111111111111";
const CONV="44444444-4444-4444-8444-444444444444";
const SECRET="customer-private-text-xyz";
type Row=Record<string,any>;

/**
 * Stateful world. rpc() implements:
 *  * flow_inbound_recovery_live_resolved: opt-in row required, same ownership
 *    rule as the SQL (message/conversation/account of the tenant, direction
 *    'in', wa_message_id = event, account platform), INSERT only;
 *  * flow_inbound_recovery_lease: discovery (opted in, after the grace, no
 *    claim, no terminal routing retry, NO EXISTING RECOVERY ROW) + lease;
 *  * flow_inbound_recovery_finish, flow_claim_inbound.
 */
function world(o:{markerFails?:"error"|"throw"}={}){
 let now=Date.parse("2026-11-10T12:00:00Z");
 const tables:Record<string,Row[]>={
  automation_inbound_recovery_tenants:[{tenant_id:T,enabled:true}],
  tenants:[{id:T,is_active:true,credits_remaining:10}],
  messages:[],automation_message_claims:[],
  conversations:[{id:CONV,tenant_id:T,account_id:ACC,wa_chat_id:"instagram:555",transferred:false,
   auto_paused_reason:null,human_agent_expires_at:null}],
  channel_accounts:[{id:ACC,tenant_id:T,channel:"instagram",platform:"instagram",external_id:"178",
   status:"active",agent_enabled:true,auto_reply:true,access_token_encrypted:"enc:v1:x"}],
  automation_flow_runs:[],automation_inbound_routing_retries:[],automation_inbound_recovery:[],
 };
 const rpcs:Array<{name:string;args:Row}>=[];
 const sent:string[]=[];
 let routingUnknown=false;let seq=0;
 const db:any={
  from:(table:string)=>{
   const f:Record<string,unknown>={};let gt:[string,string]|null=null;
   const run=()=>{
    let rows=(tables[table]??[]).filter(r=>Object.entries(f).every(([k,v])=>r[k]===v));
    if(gt)rows=rows.filter(r=>String(r[gt![0]])>gt![1]);
    return {data:rows.map(r=>({...r})),error:null};
   };
   const q:any={select:()=>q,eq:(k:string,v:unknown)=>{f[k]=v;return q;},
    gt:(k:string,v:string)=>{gt=[k,v];return q;},limit:async()=>run(),
    maybeSingle:async()=>({data:run().data[0]??null,error:null})};
   return q;
  },
  rpc:async(name:string,a:Row)=>{
   rpcs.push({name,args:{...a}});
   if(name==="flow_inbound_recovery_live_resolved"){
    if(o.markerFails==="throw")throw Error("network down");
    if(o.markerFails==="error")return {data:null,error:{code:"PGRST202",message:"missing"}};
    if(!(LIVE_NO_REPLY_REASONS as readonly string[]).includes(a.p_reason))return {data:false,error:null};
    if(!tables.automation_inbound_recovery_tenants.some(x=>x.tenant_id===a.p_tenant))return {data:false,error:null};
    const m=tables.messages.find(x=>x.id===a.p_inbound&&x.tenant_id===a.p_tenant&&x.direction==="in"&&
     x.conversation_id===a.p_conversation&&x.wa_message_id===a.p_event);
    const c=m&&tables.conversations.find(x=>x.id===m.conversation_id&&x.tenant_id===m.tenant_id);
    const acc=c&&tables.channel_accounts.find(x=>x.id===a.p_account&&x.tenant_id===c.tenant_id&&x.platform===a.p_platform);
    if(!m||!c||!acc||!(c.account_id===a.p_account||c.account_id==null))return {data:false,error:null};
    if(tables.automation_inbound_recovery.some(x=>x.tenant_id===a.p_tenant&&x.inbound_message_id===a.p_inbound))
     return {data:false,error:null};
    tables.automation_inbound_recovery.push({tenant_id:a.p_tenant,inbound_message_id:a.p_inbound,
     conversation_id:a.p_conversation,status:"resolved",reason:a.p_reason,created:m.created_at});
    return {data:true,error:null};
   }
   if(name==="flow_inbound_recovery_lease"){
    for(const m of tables.messages){
     const opt=tables.automation_inbound_recovery_tenants.find(x=>x.tenant_id===m.tenant_id&&x.enabled);
     const created=Date.parse(m.created_at);
     if(!opt||m.direction!=="in"||!m.wa_message_id)continue;
     if(created>now-a.p_grace_seconds*1000||created<=now-48*3600*1000)continue;
     if(tables.automation_message_claims.some(x=>x.tenant_id===m.tenant_id&&(x.inbound_message_id===m.id||x.provider_event_id===m.wa_message_id)))continue;
     if(tables.automation_inbound_routing_retries.some(x=>x.tenant_id===m.tenant_id&&x.inbound_message_id===m.id&&
      ["resolved","exhausted"].includes(x.status)))continue;
     if(tables.automation_inbound_recovery.some(x=>x.tenant_id===m.tenant_id&&x.inbound_message_id===m.id))continue;
     tables.automation_inbound_recovery.push({tenant_id:m.tenant_id,inbound_message_id:m.id,
      conversation_id:m.conversation_id,status:"waiting",reason:null});
    }
    const out:Row[]=[];
    for(const r of tables.automation_inbound_recovery){
     if(r.status!=="waiting")continue;
     r.status="leased";r.token="99999999-9999-4999-8999-"+String(++seq).padStart(12,"0");
     out.push({tenant_id:r.tenant_id,inbound_message_id:r.inbound_message_id,conversation_id:r.conversation_id,
      lease_token:r.token,attempts:1});
    }
    return {data:out,error:null};
   }
   if(name==="flow_inbound_recovery_finish"){
    const r=tables.automation_inbound_recovery.find(x=>x.tenant_id===a.p_tenant&&x.inbound_message_id===a.p_inbound&&
     x.status==="leased"&&x.token===a.p_token);
    if(!r)return {data:null,error:null};
    r.status=a.p_result==="retry"?"waiting":a.p_result;r.reason=a.p_reason;
    return {data:r.status,error:null};
   }
   if(name==="flow_claim_inbound"){
    if(tables.automation_message_claims.some(x=>x.tenant_id===a.p_tenant_id&&x.provider_event_id===a.p_provider_event_id))
     return {data:[{acquired:false}],error:null};
    tables.automation_message_claims.push({id:"c"+(++seq),tenant_id:a.p_tenant_id,
     provider_event_id:a.p_provider_event_id,inbound_message_id:a.p_inbound_message_id});
    return {data:[{acquired:true}],error:null};
   }
   throw Error("unexpected rpc "+name);
  }
 };
 const tenant=()=>tables.tenants[0],account=()=>tables.channel_accounts[0],conv=()=>tables.conversations[0];

 /**
  * Mirrors milan-api/index.ts handleIncomingWebhookMessage (order pinned by
  * the static test below): tenant missing/inactive BEFORE the inbound insert;
  * persist once; transferred / credits paused / auto reply off / no credits ->
  * liveNoReply + resolvedAfterRedrive; routing unknown -> "retry" (no claim);
  * else exclusive claim -> one send. Re-drive: no insert, no liveNoReply.
  */
 async function handle(mid:string,text:string,redrive?:{conversationId:string;inboundId:string}):Promise<"retry"|void>{
  const retryKey={tenantId:T,accountId:ACC,platform:"instagram",eventId:mid};
  const liveNoReply=async(reason:LiveNoReplyReason,conversationId:string,inboundId:string|null)=>{
   if(redrive||!inboundId)return;
   await markLiveNoReply(db,{...retryKey,conversationId:String(conversationId),inboundId},reason);
  };
  const t=tenant();
  if(!t||t.is_active===false)return;
  const c=conv();
  let inboundId:string|null=redrive?redrive.inboundId:null;
  if(!redrive){
   if(tables.messages.some(m=>m.wa_message_id===mid))return; // duplicate pre-check / unique index
   inboundId="77777777-7777-4777-8777-"+String(tables.messages.length+1).padStart(12,"0");
   tables.messages.push({id:inboundId,tenant_id:T,conversation_id:c.id,direction:"in",wa_message_id:mid,
    body_encrypted:"enc:v1:opaque",created_at:new Date(now).toISOString()});
  }
  if(c.transferred){await liveNoReply("live_human_takeover",c.id,inboundId);return;}
  if(c.auto_paused_reason==="credits"){await liveNoReply("live_credits_paused",c.id,inboundId);return;}
  const acc=account();
  if(acc.agent_enabled===false||acc.auto_reply===false){await liveNoReply("live_auto_reply_off",c.id,inboundId);return;}
  if(Number(t.credits_remaining??0)<=0){
   c.auto_paused_reason="credits";
   await liveNoReply("live_no_credits",c.id,inboundId);return;
  }
  if(routingUnknown)return "retry"; // no claim acquired, nothing marked
  const cl=await db.rpc("flow_claim_inbound",{p_tenant_id:T,p_account_id:ACC,p_platform:"instagram",
   p_provider_event_id:mid,p_conversation_id:c.id,p_inbound_message_id:inboundId,p_engine_ready:false});
  if(cl.data[0].acquired)sent.push("reply:"+mid);
 }
 const sweep=async()=>{
  const logs:unknown[]=[];
  const old={warn:console.warn,error:console.error,log:console.log,info:console.info};
  for(const k of ["warn","error","log","info"] as const)(console as any)[k]=(...x:unknown[])=>logs.push(x);
  try{
   const out=await runInboundRecovery(db,{nowMs:()=>now,decrypt:async()=>SECRET,
    redrive:(e:RedriveEvent)=>handle(e.eventId,e.text,{conversationId:e.conversationId,inboundId:e.inboundId})});
   return {out,logs};
  }finally{Object.assign(console,old);}
 };
 return {db,tables,rpcs,sent,handle,sweep,tenant,account,conv,
  advance:(sec:number)=>{now+=sec*1000;},setRoutingUnknown:(v:boolean)=>{routingUnknown=v;},
  rec:(mid:string)=>{const m=tables.messages.find(x=>x.wa_message_id===mid);
   return m?tables.automation_inbound_recovery.find(x=>x.inbound_message_id===m.id):undefined;}};
}
const quiet=async<T>(fn:()=>Promise<T>):Promise<{v:T;logs:unknown[]}>=>{
 const logs:unknown[]=[];
 const old={warn:console.warn,error:console.error,log:console.log,info:console.info};
 for(const k of ["warn","error","log","info"] as const)(console as any)[k]=(...x:unknown[])=>logs.push(x);
 try{return {v:await fn(),logs};}finally{Object.assign(console,old);}
};
const markerCalls=(w:ReturnType<typeof world>)=>w.rpcs.filter(r=>r.name==="flow_inbound_recovery_live_resolved");
const AFTER_GRACE=RECOVERY_GRACE_SECONDS+60;

// --------------------------------------------------------------- scenarios
test("(a) auto reply disabled: live exit writes the terminal marker; after auto reply is re-enabled the sweeper leases nothing and never replies",async()=>{
 const w=world();
 w.account().auto_reply=false;
 assert.equal(await w.handle("mid-a","hi"),undefined);
 assert.deepEqual(w.sent,[]);
 assert.equal(markerCalls(w).length,1);
 assert.deepEqual([w.rec("mid-a")?.status,w.rec("mid-a")?.reason],["resolved","live_auto_reply_off"]);
 w.account().auto_reply=true;            // condition clears inside the 48h window
 w.advance(AFTER_GRACE);
 const s=await w.sweep();
 assert.deepEqual(s.out,{},"nothing discovered, nothing leased");
 assert.deepEqual(w.sent,[],"no late reply");
 // agent_enabled=false is the same exit
 const w2=world();w2.account().agent_enabled=false;
 await w2.handle("mid-a2","hi");
 assert.equal(w2.rec("mid-a2")?.reason,"live_auto_reply_off");
});

test("(b) credits exhausted: live exit writes the marker; after a top-up (credits>0, pause cleared) no late reply",async()=>{
 const w=world();
 w.tenant().credits_remaining=0;
 assert.equal(await w.handle("mid-b","hi"),undefined);
 assert.deepEqual(w.sent,[]);
 assert.equal(w.conv().auto_paused_reason,"credits","existing behaviour kept: conversation paused");
 assert.deepEqual([w.rec("mid-b")?.status,w.rec("mid-b")?.reason],["resolved","live_no_credits"]);
 w.tenant().credits_remaining=50;w.conv().auto_paused_reason=null;
 w.advance(AFTER_GRACE);
 assert.deepEqual((await w.sweep()).out,{});
 assert.deepEqual(w.sent,[]);
 // a conversation already paused for credits: same guarantee
 const w2=world();w2.conv().auto_paused_reason="credits";
 await w2.handle("mid-b2","hi");
 assert.equal(w2.rec("mid-b2")?.reason,"live_credits_paused");
 w2.conv().auto_paused_reason=null;w2.advance(AFTER_GRACE);
 assert.deepEqual((await w2.sweep()).out,{});assert.deepEqual(w2.sent,[]);
});

test("(c) tenant inactive: the live exit is BEFORE the inbound insert; nothing persisted, no marker needed, reactivation never causes a late reply",async()=>{
 const w=world();
 w.tenant().is_active=false;
 assert.equal(await w.handle("mid-c","hi"),undefined);
 assert.equal(w.tables.messages.length,0,"not persisted");
 assert.equal(markerCalls(w).length,0);
 w.tenant().is_active=true;
 w.advance(AFTER_GRACE);
 assert.deepEqual((await w.sweep()).out,{});
 assert.deepEqual(w.sent,[]);
});

test("human takeover: live exit writes the marker; after the takeover ends no late reply",async()=>{
 const w=world();
 w.conv().transferred=true;
 await w.handle("mid-h","hi");
 assert.equal(w.rec("mid-h")?.reason,"live_human_takeover");
 w.conv().transferred=false;w.advance(AFTER_GRACE);
 assert.deepEqual((await w.sweep()).out,{});
 assert.deepEqual(w.sent,[]);
});

test("negative control: a genuinely retryable (routing unknown) event is NOT marked and IS recovered exactly once",async()=>{
 const w=world();
 w.setRoutingUnknown(true);
 assert.equal(await w.handle("mid-r","price?"),"retry");
 assert.equal(markerCalls(w).length,0,"no terminal marker for an unowned event");
 assert.equal(w.rec("mid-r"),undefined);
 w.setRoutingUnknown(false);
 w.advance(AFTER_GRACE);
 const s=await w.sweep();
 assert.deepEqual(s.out,{"resolved:processed":1});
 assert.deepEqual(w.sent,["reply:mid-r"]);
 assert.equal(markerCalls(w).length,0,"re-drive never writes a live marker");
 w.advance(AFTER_GRACE);
 assert.deepEqual((await w.sweep()).out,{});
 assert.deepEqual(w.sent,["reply:mid-r"],"exactly once");
 const flat=JSON.stringify(s.logs);
 assert.ok(!flat.includes(SECRET)&&!flat.includes(CONV),"no text, no ids in logs");
});

test("normal live reply is unchanged: one reply, no marker",async()=>{
 const w=world();
 await w.handle("mid-n","hi");
 assert.deepEqual(w.sent,["reply:mid-n"]);
 assert.equal(markerCalls(w).length,0);
});

test("marker-write failure (RPC error / throw) does not alter the webhook outcome, sends nothing, logs nothing",async()=>{
 for(const mode of ["error","throw"] as const){
  const w=world({markerFails:mode});
  w.account().auto_reply=false;
  const {v,logs}=await quiet(()=>w.handle("mid-f","hi"));
  assert.equal(v,undefined,mode+": same outcome as a successful marker (200, no retry)");
  assert.deepEqual(w.sent,[],mode);
  assert.deepEqual(logs,[],mode+": nothing logged");
  assert.equal(markerCalls(w).length,1,mode);
 }
});

// ------------------------------------------------------------ helper unit
test("markLiveNoReply: exact scoped payload; invalid input never calls the RPC; never throws; bounded wait",async()=>{
 const calls:Row[]=[];
 const ok:any={rpc:async(n:string,a:Row)=>{calls.push({n,...a});return {data:true,error:null};}};
 const e={tenantId:T,accountId:ACC,platform:"instagram",eventId:"mid.1",conversationId:CONV,
  inboundId:"77777777-7777-4777-8777-777777777771"};
 assert.equal(await markLiveNoReply(ok,e,"live_auto_reply_off"),true);
 assert.deepEqual(calls,[{n:"flow_inbound_recovery_live_resolved",p_tenant:T,p_account:ACC,p_platform:"instagram",
  p_event:"mid.1",p_conversation:CONV,p_inbound:e.inboundId,p_reason:"live_auto_reply_off"}]);
 calls.length=0;
 const bad:Array<[Row,string]>=[[{...e,tenantId:"x"},"live_no_credits"],[{...e,accountId:""},"live_no_credits"],
  [{...e,platform:"telegram"},"live_no_credits"],[{...e,eventId:""},"live_no_credits"],
  [{...e,eventId:"x".repeat(257)},"live_no_credits"],[{...e,inboundId:"nope"},"live_no_credits"],
  [{...e,conversationId:"nope"},"live_no_credits"],[e,"auto_reply_off"],[null as any,"live_no_credits"]];
 for(const [x,r] of bad)assert.equal(await markLiveNoReply(ok,x as any,r as any),false,JSON.stringify(r));
 assert.equal(calls.length,0,"no RPC for invalid input");
 const {v:results,logs}=await quiet(async()=>[
  await markLiveNoReply({rpc:()=>{throw Error("sync "+SECRET);}} as any,e,"live_no_credits"),
  await markLiveNoReply({rpc:async()=>{throw Error("async "+SECRET);}} as any,e,"live_no_credits"),
  await markLiveNoReply({rpc:async()=>({data:null,error:{code:"42883"}})} as any,e,"live_no_credits"),
  await markLiveNoReply({rpc:async()=>({data:false,error:null})} as any,e,"live_no_credits"),
  await markLiveNoReply({rpc:()=>new Promise(()=>{})} as any,e,"live_no_credits",20),
 ]);
 assert.deepEqual(results,[false,false,false,false,false]);
 assert.deepEqual(logs,[],"never logs");
});

// ----------------------------------------------------------- index.ts pins
test("index.ts wiring: four live no-reply exits mark (with their reason), live only, before the existing return; tenant exits precede the insert",()=>{
 const s=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const h=s.slice(s.indexOf("async function handleIncomingWebhookMessage("),s.indexOf("Deno.serve("));
 assert.match(h,/const liveNoReply = async \(reason: LiveNoReplyReason, conversationId: string, inboundId: string \| null\) => \{\n\s+if \(redrive \|\| !inboundId\) return;\n\s+await markLiveNoReply\(sb, \{ \.\.\.retryKey, conversationId: String\(conversationId\), inboundId \}, reason\);\n\s+\};/);
 // The four deliberate no-reply exits are decided by ONE pure gate (messageRouting.ts conversationGate), which names
 // each with its own reason; index.ts maps the decision to a single marked exit (live only, before the return).
 const routing=readFileSync("supabase/functions/milan-api/messageRouting.ts","utf8");
 for(const reason of ["live_human_takeover","live_credits_paused","live_auto_reply_off","live_no_credits"])
  assert.ok(routing.includes('reason:"'+reason+'"'),reason);
 assert.match(h,/await liveNoReply\(decision\.reason, conv\.id, inboundMessageId\);\n\s+await resolvedAfterRedrive\(\);\n\s+return;/);
 assert.equal((h.match(/await liveNoReply\(/g)??[]).length,1,"one marked exit, fed by the four routed no-reply reasons");
 assert.deepEqual([...LIVE_NO_REPLY_REASONS].sort(),["live_auto_reply_off","live_credits_paused","live_human_takeover","live_no_credits"]);
 // tenant missing / inactive exits are before the inbound insert -> nothing to discover
 const insert=h.indexOf("await persistInboundOnce(");
 assert.ok(h.indexOf("if (!tenant) {")>0&&h.indexOf("if (!tenant) {")<insert);
 assert.ok(h.indexOf("if (tenant.is_active === false) {")>0&&h.indexOf("if (tenant.is_active === false) {")<insert);
 // every marker call comes after the insert and before routing/claim (never changes the reply decision)
 const mark=h.indexOf("await liveNoReply(decision.reason");
 assert.ok(mark>insert&&mark>h.indexOf("await routeInbound("),"marked only AFTER the routing decision said no-reply");
 assert.match(s,/import \{ inboundRecoveryEnabled, runInboundRecovery, recoveryLeaseActive, markLiveNoReply, type LiveNoReplyReason \} from "\.\/inboundRecovery\.ts";/);
});
