/**
 * Decision 1: unknown flow eligibility (read error) -> no flow, no AI, the
 * event stays retryable; provider redelivery re-drives it; bounded attempts;
 * exactly-once via the existing claims; exhausted = observable terminal state.
 * Offline: a stateful fake database with the SQL semantics of
 * flow_claim_inbound, flow_claim_begin_durable_run and the 20261029340000
 * functions (their real SQL is exercised in tests/flow-inbound-routing-retry-sql.test.mjs).
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {prepareSimpleFlowReply} from "../supabase/functions/milan-api/flowPrepareMessage.ts";
import {attemptDurableInstagram,durableIngressConfigured,supportedDurableDocument}
 from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {processExclusiveEvent} from "../supabase/functions/milan-api/exclusiveMessageClaim.ts";
import {recordRoutingFailure,markRoutingResolved,retryableEvent,webhookStatusFor,INBOUND_ROUTING_MAX_ATTEMPTS,
 isRetryableOutcome,retryAttemptCap}
 from "../supabase/functions/milan-api/inboundRoutingRetry.ts";

type Env=Record<string,string|undefined>;
async function withEnv<T>(env:Env,fn:()=>Promise<T>|T):Promise<T>{
 const old=(globalThis as any).Deno;
 (globalThis as any).Deno={env:{get:(k:string)=>env[k]}};
 try{return await fn();}finally{(globalThis as any).Deno=old;}
}
const quiet=async<T>(fn:()=>Promise<T>):Promise<T>=>{
 const saved={warn:console.warn,error:console.error,log:console.log};
 console.warn=()=>{};console.error=()=>{};console.log=()=>{};
 try{return await fn();}finally{Object.assign(console,saved);}
};

const T="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",A="11111111-1111-4111-8111-111111111111";
const CONV="44444444-4444-4444-8444-444444444444";
const trig=(triggerMode:string,keywords="")=>({kind:"trigger",platform:"instagram",triggerMode,keywords});
const v2Doc=(trigger:Record<string,unknown>,text:string)=>({version:3,nodes:[
 {id:"in",data:trigger},{id:"out",data:{kind:"message",text,options:[],contentBlocks:[],image:""}}],
 edges:[{source:"in",sourceHandle:"next",target:"out"}]});
const buttonsDoc=(trigger:Record<string,unknown>)=>({version:3,nodes:[
 {id:"start",data:trigger},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"Q",image:"",contentBlocks:[],options:[
  {id:"p",label:"P"},{id:"s",label:"S"}]}},
 {id:"yes",data:{kind:"message",text:"P",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"S",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},
  {source:"choose",target:"yes",sourceHandle:"p"},{source:"choose",target:"no",sourceHandle:"s"}]});

type Flow={flow_key:string;revision:number;document:unknown};
/** Stateful fake: failures are injected per table for the next N reads. */
function world(o:{flows:Flow[];noRetryTable?:boolean}){
 const fail:Record<string,number>={};
 const messages:Array<{id:string;wa_message_id:string;conversation_id:string}>=[];
 const claims=new Map<string,string>();
 const retries=new Map<string,{status:string;attempts:number;conversation_id:string;inbound_message_id:string}>();
 const runs:string[]=[];const rpcs:string[]=[];
 const key=(t:unknown,a:unknown,p:unknown,e:unknown)=>[t,a,p,e].join("|");
 const failing=(table:string)=>{if((fail[table]??0)>0){fail[table]--;return true;}return false;};
 const db:any={
  from:(table:string)=>{
   const f:Record<string,unknown>={};
   const q:any={select:()=>q,eq:(k:string,v:unknown)=>{f[k]=v;return q;},in:()=>q,gt:()=>q,lte:()=>q,
    maybeSingle:async()=>{
     if(failing(table))return {data:null,error:{code:"XX000",message:"db down"}};
     if(table==="automation_flow_global_switch")return {data:{enabled:true},error:null};
     if(table==="automation_flow_tenant_switches")return {data:{enabled:true,test_only:false,production_approved:true},error:null};
     if(table==="automation_flow_publications"){
      const hit=o.flows.find(x=>x.flow_key===f.flow_key&&x.revision===Number(f.revision));
      return {data:hit?{document:hit.document}:null,error:null};
     }
     if(table==="automation_inbound_routing_retries"){
      if(o.noRetryTable)return {data:null,error:{code:"42P01",message:"missing"}};
      const r=retries.get(key(f.tenant_id,f.channel_account_id,f.platform,f.provider_event_id));
      return {data:r?{tenant_id:f.tenant_id,channel_account_id:f.channel_account_id,platform:f.platform,
       provider_event_id:f.provider_event_id,...r}:null,error:null};
     }
     return {data:null,error:null};},
    limit:async()=>{
     if(failing(table))return {data:null,error:{code:"XX000",message:"db down"}};
     if(table==="automation_flow_activations")
      return {data:o.flows.map(x=>({flow_key:x.flow_key,revision:x.revision,is_active:true,activated_at:null})),error:null};
     if(table==="automation_message_claims")
      return {data:claims.has(key(f.tenant_id,f.channel_account_id,f.platform,f.provider_event_id))?[{id:"c"}]:[],error:null};
     if(table==="messages")return {data:messages.filter(m=>m.wa_message_id===f.wa_message_id).map(m=>({id:m.id})),error:null};
     return {data:[],error:null};}
   };return q;},
  rpc:async(name:string,a:any)=>{
   rpcs.push(name);
   if(name==="flow_claim_inbound"){
    const k=key(a.p_tenant_id,a.p_account_id,a.p_platform,a.p_provider_event_id);
    if(failing("rpc:flow_claim_inbound"))return {data:null,error:{code:"57014",message:"timeout"}};
    if(claims.has(k))return {data:[{acquired:false,route:claims.get(k),claim_id:"c",outgoing_message_id:"o"}],error:null};
    const route=a.p_engine_ready===true&&o.flows.length>0?"flow":"legacy_ai";
    claims.set(k,route);return {data:[{acquired:true,route,claim_id:"c",outgoing_message_id:"o-"+claims.size}],error:null};
   }
   if(name==="flow_claim_begin_durable_run"){
    const k=key(a.p_tenant,a.p_account,a.p_platform,a.p_event);
    if(failing("rpc:flow_claim_begin_durable_run"))return {data:null,error:{code:"57014",message:"timeout"}};
    if(claims.has(k))return {data:[{acquired:false,run_id:null}],error:null};
    claims.set(k,"flow");runs.push(a.p_flow);
    return {data:[{acquired:true,run_id:"88888888-8888-4888-8888-88888888888"+runs.length}],error:null};
   }
   if(name==="flow_inbound_routing_failed"){ // 20261029340000 semantics
    if(o.noRetryTable)return {data:null,error:{code:"PGRST202",message:"missing"}};
    const k=key(a.p_tenant,a.p_account,a.p_platform,a.p_event);
    if(claims.has(k))return {data:"claimed",error:null};
    const r=retries.get(k);
    if(!r){retries.set(k,{status:a.p_max_attempts<=1?"exhausted":"retrying",attempts:1,
     conversation_id:a.p_conversation,inbound_message_id:a.p_inbound});return {data:retries.get(k)!.status,error:null};}
    if(r.status==="retrying"){r.attempts++;if(r.attempts>=a.p_max_attempts)r.status="exhausted";}
    return {data:r.status,error:null};
   }
   if(name==="flow_inbound_routing_resolved"){
    const r=retries.get(key(a.p_tenant,a.p_account,a.p_platform,a.p_event));
    if(r&&r.status==="retrying"){r.status="resolved";return {data:true,error:null};}
    return {data:false,error:null};
   }
   throw Error("unexpected rpc "+name);
  }
 };
 const sent:string[]=[];let ai=0;const attempts:string[]=[];let lastOutcome:unknown=null;
 /** Conversation state for the KNOWN terminal exits (index.ts B-6). */
 const conversation={transferred:false};let sendFails=0;
 /**
  * One webhook delivery of ONE provider event, mirroring milan-api/index.ts:
  * duplicate pre-check (messages.wa_message_id) -> re-drive only a
  * 'retrying' row -> handleIncomingWebhookMessage (persist once, durable
  * attempt, V2/AI with the exclusive claim, keepRetryable / resolvedAfterRedrive)
  * -> 503 while the event is retryable, else 200.
  */
 async function deliver(mid:string,text:string,genuine=true):Promise<number>{
  const outcomes:unknown[]=[];
  const dup=messages.find(m=>m.wa_message_id===mid);
  let redrive:{conversationId:string;inboundId:string}|null=null;
  if(dup){
   redrive=await retryableEvent(db,{tenantId:T,accountId:A,platform:"instagram",eventId:mid});
   if(!redrive)return webhookStatusFor(outcomes);
  }
  outcomes.push(await handle(mid,text,redrive,genuine));
  return webhookStatusFor(outcomes);
 }
 async function handle(mid:string,text:string,redrive:{conversationId:string;inboundId:string}|null,genuine:boolean){
  const retryKey={tenantId:T,accountId:A,platform:"instagram",eventId:mid};
  const syntheticEvent=!genuine;
  const keepRetryable=async(inbound:string)=>{
   const d=await recordRoutingFailure(db,{...retryKey,conversationId:CONV,inboundId:inbound},retryAttemptCap(syntheticEvent));
   if(d==="retry")return "retry" as const;
  };
  const resolvedAfterRedrive=async()=>{if(redrive)await markRoutingResolved(db,retryKey);};
  // tenant read (index.ts): an error is UNKNOWN; before persisting it is a plain 503
  if(failing("tenants"))return redrive?await keepRetryable(redrive.inboundId):"retry" as const;
  let inboundId:string;
  if(redrive)inboundId=redrive.inboundId;
  else{
   if(messages.some(m=>m.wa_message_id===mid))return; // unique index: duplicate
   inboundId="77777777-7777-4777-8777-"+String(messages.length+1).padStart(12,"0");
   messages.push({id:inboundId,wa_message_id:mid,conversation_id:CONV});
  }
  // KNOWN terminal exit (human takeover): resolved, never retried
  if(conversation.transferred){await resolvedAfterRedrive();return;}
  const durable=await attemptDurableInstagram(db,{tenantId:T,accountId:A,conversationId:CONV,inboundId,
   eventId:mid,platform:"instagram",text,providerEventIdGenuine:genuine});
  if(durable==="retry")return await keepRetryable(inboundId);
  if(durable==="handled"){await resolvedAfterRedrive();return;}
  const outcome=await processExclusiveEvent({
   prepareFlow:()=>prepareSimpleFlowReply(db,T,A,"instagram",text,
    durableIngressConfigured(A,"instagram")?{durableDocument:(d)=>supportedDurableDocument(d,"instagram")}:{}),
   claim:async(ready)=>{const r=await db.rpc("flow_claim_inbound",{p_tenant_id:T,p_account_id:A,p_platform:"instagram",
    p_provider_event_id:mid,p_conversation_id:CONV,p_inbound_message_id:inboundId,p_engine_ready:ready});return r.data[0];},
   legacyAnswer:async()=>{ai++;return "AI";},
   send:async(t)=>{if(sendFails>0){sendFails--;attempts.push(t);throw Error("provider down");}
    sent.push(t);attempts.push(t);return {providerMessageId:"pm"+sent.length};},
   persistSent:async()=>true,debit:async()=>1
  });
  lastOutcome=outcome;
  if(isRetryableOutcome(outcome))return await keepRetryable(inboundId);
  await resolvedAfterRedrive();
 }
 return {db,deliver,fail,messages,claims,retries,runs,rpcs,sent,ai:()=>ai,conversation,attempts,
  failSend:(n:number)=>{sendFails=n;},outcome:()=>lastOutcome,
  row:(mid:string)=>retries.get([T,A,"instagram",mid].join("|"))};
}
// Worker readiness gates (flowDurableIngress.ts durableWorkerGatesOpen): a NEW
// durable run starts only while the operator gates of the workers that produce
// its reply are open, so the durable start tests run with them open.
const WORKERS_READY:Record<string,string>={FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved",
 FLOW_OUTBOX_SEND_ENABLED:"true",FLOW_ATOMIC_CONSUME_READY:"true",FLOW_DURABLE_SCHEDULER_ENABLED:"true",
 FLOW_RICH_BUTTONS_ENABLED:"true",FLOW_INTERNAL_ACTIONS_ENABLED:"true",FIELD_ENCRYPTION_KEY:"test-only-field-key"};
const canary={...WORKERS_READY,FLOW_DURABLE_INGRESS_ENABLED:"true",FLOW_DURABLE_CANARY_ACCOUNT_ID:A};
const v2Flows:Flow[]=[{flow_key:"prices",revision:2,document:v2Doc(trig("keyword","price"),"PRICES")}];

test("index.ts wiring: webhook 503 while retryable, re-drive only a 'retrying' duplicate, keepRetryable before any AI",()=>{
 const src=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 assert.equal((src.match(/webhookStatusFor\((ig|wa)Outcomes\) === 503/g)??[]).length,2);
 assert.equal((src.match(/const pending = await retryableEvent\(sb, \{/g)??[]).length,2);
 assert.match(src,/if\(durable==="retry"\)return await keepRetryable\(String\(conv\.id\),inboundMessageId\);/);
 assert.match(src,/if \(isRetryableOutcome\(outcome\)\)\n\s+return await keepRetryable\(String\(conv\.id\), inboundMessageId\);/);
 // B-5: no Meta mid -> attempt cap 1 (immediately 'exhausted', never a retryable 503)
 assert.match(src,/const syntheticEvent = channel !== "whatsapp" && providerEventIdGenuine !== true;/);
 assert.match(src,/\}, retryAttemptCap\(syntheticEvent\)\);/);
 // B-6: read errors before/while re-driving are unknown; proven terminal exits resolve
 assert.match(src,/if \(tenantError\) \{\n\s+console\.error\(`\[\$\{channel\}_webhook\] tenant read failed`\);\n\s+return await unknownState\(\);/);
 assert.match(src,/if \(convError\) \{\n\s+console\.error\(`\[\$\{channel\}_webhook\] conversation read failed`\);\n\s+return await unknownState\(\);/);
 assert.equal((src.match(/await resolvedAfterRedrive\(\);\n\s+return;/g)??[]).length,7,"tenant missing/inactive, conversation gone, transferred, credits (2), auto reply off");
 assert.match(src,/const incomingResult = redrive \? "saved" : await persistInboundOnce/);
 assert.match(src,/\.eq\("id", redrive\.conversationId\)\n\s+\.eq\("wa_chat_id", chatId\)/);
});

test("unknown eligibility (activation read error): no flow, no AI, 503, event retryable; recovery -> exactly one flow reply",async()=>{
 await quiet(()=>withEnv({},async()=>{
  const w=world({flows:v2Flows});
  w.fail.automation_flow_activations=1;
  assert.equal(await w.deliver("mid-1","price?"),503);
  assert.deepEqual(w.sent,[]);assert.equal(w.ai(),0);assert.equal(w.claims.size,0);
  assert.equal(w.messages.length,1,"inbound persisted once");
  assert.deepEqual({...w.row("mid-1")},{status:"retrying",attempts:1,conversation_id:CONV,inbound_message_id:w.messages[0].id});
  // provider redelivery after the database recovered
  assert.equal(await w.deliver("mid-1","price?"),200);
  assert.deepEqual(w.sent,["PRICES"]);assert.equal(w.ai(),0);
  assert.equal(w.messages.length,1,"no second inbound row");
  assert.equal(w.row("mid-1")!.status,"resolved");
  // later duplicates: nothing at all
  for(let i=0;i<3;i++)assert.equal(await w.deliver("mid-1","price?"),200);
  assert.deepEqual(w.sent,["PRICES"]);
 }));
});
test("recovery with no matching flow -> exactly one AI reply (only after a successful lookup)",async()=>{
 await quiet(()=>withEnv({},async()=>{
  const w=world({flows:v2Flows});
  w.fail.automation_flow_publications=1;
  assert.equal(await w.deliver("mid-2","hello"),503);
  assert.equal(w.ai(),0);assert.deepEqual(w.sent,[]);
  assert.equal(await w.deliver("mid-2","hello"),200);
  assert.equal(w.ai(),1);assert.deepEqual(w.sent,["AI"]);
  assert.equal(await w.deliver("mid-2","hello"),200);assert.equal(w.ai(),1);
 }));
});
test("switch read error is unknown eligibility too",async()=>{
 await quiet(()=>withEnv({},async()=>{
  const w=world({flows:v2Flows});
  w.fail.automation_flow_tenant_switches=1;
  assert.equal(await w.deliver("mid-3","hello"),503);
  assert.equal(w.ai(),0);assert.equal(w.row("mid-3")!.status,"retrying");
 }));
});
test("redelivery storm after recovery: still exactly one reply and one claim",async()=>{
 await quiet(()=>withEnv({},async()=>{
  const w=world({flows:v2Flows});
  w.fail.automation_flow_activations=1;
  assert.equal(await w.deliver("mid-4","price"),503);
  const codes=await Promise.all(Array.from({length:12},()=>w.deliver("mid-4","price")));
  assert.ok(codes.every(c=>c===200),String(codes));
  assert.deepEqual(w.sent,["PRICES"]);assert.equal(w.ai(),0);
  assert.equal(w.claims.size,1);assert.equal(w.messages.length,1);
 }));
});
test("attempts exhausted: bounded, terminal 'exhausted' (observable), never success, never answered",async()=>{
 await quiet(()=>withEnv({},async()=>{
  const w=world({flows:v2Flows});
  w.fail.automation_flow_activations=100;
  const codes:number[]=[];
  for(let i=0;i<INBOUND_ROUTING_MAX_ATTEMPTS+3;i++)codes.push(await w.deliver("mid-5","price"));
  assert.deepEqual(codes,[503,503,503,503,200,200,200,200]);
  assert.equal(w.row("mid-5")!.status,"exhausted");
  assert.equal(w.row("mid-5")!.attempts,INBOUND_ROUTING_MAX_ATTEMPTS);
  assert.deepEqual(w.sent,[]);assert.equal(w.ai(),0);assert.equal(w.claims.size,0);
  // even after recovery an exhausted event is not re-driven (investigation, not silent success)
  w.fail.automation_flow_activations=0;
  assert.equal(await w.deliver("mid-5","price"),200);
  assert.deepEqual(w.sent,[]);assert.equal(w.row("mid-5")!.status,"exhausted");
 }));
});
test("successful lookup, no match -> AI answers at once (unchanged); duplicate after success -> nothing",async()=>{
 await quiet(()=>withEnv({},async()=>{
  const w=world({flows:v2Flows});
  assert.equal(await w.deliver("mid-6","hello"),200);
  assert.deepEqual(w.sent,["AI"]);assert.equal(w.row("mid-6"),undefined);
  assert.equal(await w.deliver("mid-6","hello"),200);
  assert.deepEqual(w.sent,["AI"]);
  const none=world({flows:[]});
  assert.equal(await none.deliver("mid-6b","hello"),200);assert.deepEqual(none.sent,["AI"]);
 }));
});
test("durable path read error: same retry semantics; recovery starts exactly one durable run",async()=>{
 await quiet(()=>withEnv(canary,async()=>{
  const flows:Flow[]=[{flow_key:"menu",revision:3,document:buttonsDoc(trig("keyword","menu"))}];
  for(const table of ["automation_flow_activations","automation_flow_publications","automation_flow_global_switch"]){
   const w=world({flows});
   w.fail[table]=1;
   assert.equal(await w.deliver("mid-7","menu"),503,table);
   assert.equal(w.runs.length,0);assert.equal(w.ai(),0);assert.deepEqual(w.sent,[]);
   assert.equal(w.row("mid-7")!.status,"retrying");
   assert.equal(await w.deliver("mid-7","menu"),200);
   assert.deepEqual(w.runs,["menu"]);assert.equal(w.ai(),0);
   await Promise.all([w.deliver("mid-7","menu"),w.deliver("mid-7","menu")]);
   assert.deepEqual(w.runs,["menu"],"never a second run");
   assert.equal(w.row("mid-7")!.status,"resolved");
  }
 }));
});
test("migration 20261029340000 missing: fail safe (no flow, no AI, no duplicate), not retried",async()=>{
 await quiet(()=>withEnv({},async()=>{
  const w=world({flows:v2Flows,noRetryTable:true});
  w.fail.automation_flow_activations=1;
  assert.equal(await w.deliver("mid-8","price"),200);
  assert.deepEqual(w.sent,[]);assert.equal(w.ai(),0);assert.equal(w.claims.size,0);
  assert.equal(await w.deliver("mid-8","price"),200,"duplicate skipped as before");
  assert.deepEqual(w.sent,[]);assert.equal(w.ai(),0);
 }));
});
test("retry helpers: validation, mapping, fail closed",async()=>{
 const rpc=(data:unknown,error:unknown=null)=>({from:()=>{throw Error("no");},rpc:async()=>({data,error})}) as any;
 const ev={tenantId:T,accountId:A,platform:"instagram",eventId:"m",conversationId:CONV,inboundId:CONV};
 assert.equal(await recordRoutingFailure(rpc("retrying"),ev),"retry");
 assert.equal(await recordRoutingFailure(rpc("exhausted"),ev),"exhausted");
 assert.equal(await recordRoutingFailure(rpc("claimed"),ev),"claimed");
 assert.equal(await recordRoutingFailure(rpc(null),ev),"unavailable");
 assert.equal(await recordRoutingFailure(rpc("weird"),ev),"unavailable");
 assert.equal(await recordRoutingFailure(rpc(null,{code:"X"}),ev),"unavailable");
 assert.equal(await recordRoutingFailure({rpc:async()=>{throw Error("net");}} as any,ev),"unavailable");
 for(const bad of [{accountId:"undefined"},{tenantId:""},{platform:"sms"},{eventId:""},{inboundId:"x"}])
  assert.equal(await recordRoutingFailure(rpc("retrying"),{...ev,...bad}),"unavailable",JSON.stringify(bad));
 assert.equal(await retryableEvent(rpc(null),{...ev,accountId:"undefined"}),null);
 assert.equal(webhookStatusFor([undefined,"retry"]),503);
 assert.equal(webhookStatusFor([undefined,null]),200);
 assert.equal(webhookStatusFor([]),200);
 // a row of another account/event never re-drives
 const other={from:()=>{const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{tenant_id:T,channel_account_id:"22222222-2222-4222-8222-222222222222",
  platform:"instagram",provider_event_id:"m",status:"retrying",conversation_id:CONV,inbound_message_id:CONV},error:null})};return q;}} as any;
 assert.equal(await retryableEvent(other,ev),null);
});

// ---------------------------------------------------- Decision 3b: channels
test("channel text propagation (source): Instagram/Messenger msg.text and WhatsApp text.body reach the router as customerText",()=>{
 const src=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 // Instagram + Facebook Page: one handler; text from the signed event; account from channel_accounts, never the payload's tenant.
 assert.match(src,/typeof ev\.message\.text === "string"\n\s+\? ev\.message\.text/);
 assert.match(src,/igOutcomes\.push\(await handleIncomingWebhookMessage\(\n\s+sb,\n\s+account,\n\s+chatId,\n\s+msg\.text,/);
 assert.match(src,/\.eq\("channel", "facebook"\)\n\s+\.limit\(2\);/);
 // WhatsApp: text.body (or a canary flow-choice title); account from verified wa_bindings or channel_accounts.
 assert.match(src,/typeof message\?\.text\?\.body === "string"\n\s+\? message\.text\.body/);
 assert.match(src,/waOutcomes\.push\(await handleIncomingWebhookMessage\(\n\s+sb,\n\s+account,\n\s+chatId,\n\s+durableReply && !text \? durableReply\.text : text,/);
 assert.match(src,/const binding = bindingIsVerified\(bindingRow\) \? bindingRow : null;/);
 // the router receives exactly customerText and the verified account scope
 assert.match(src,/inboundId:inboundMessageId,eventId:externalMsgId,platform:channel,\n\s+text:customerText,/);
 assert.match(src,/sb, tenantId, String\(account\.id\), channel, customerText,/);
});
test("channel gates (behaviour): Messenger/WhatsApp keyword flows stay gated; Instagram runs",async()=>{
 const flows:Flow[]=[{flow_key:"kw",revision:1,document:v2Doc({...trig("keyword","menu"),platform:"instagram"},"IG")}];
 await withEnv({},async()=>{
  const w=world({flows});
  assert.equal(await prepareSimpleFlowReply(w.db,T,A,"instagram","menu"),"IG");
  for(const p of ["facebook","whatsapp"] as const)
   assert.equal(await prepareSimpleFlowReply(w.db,T,A,p,"menu"),null,p+": V2 off without FLOW_RUNTIME_MODE=message_only");
  // WhatsApp wa_bindings account (no channel_accounts id): never a flow
  assert.equal(await prepareSimpleFlowReply(w.db,T,"undefined" as any,"instagram","menu"),null);
  // durable for Messenger/WhatsApp: FLOW_MULTICHANNEL_ENABLED off -> fallback before any DB access
  const none={from:()=>{throw Error("no db");},rpc:()=>{throw Error("no rpc");}} as any;
  for(const platform of ["facebook","whatsapp"])
   assert.equal(await attemptDurableInstagram(none,{tenantId:T,accountId:A,conversationId:CONV,
    inboundId:CONV,eventId:"m",platform,text:"menu",providerEventIdGenuine:true}),"fallback");
 });
 await withEnv({...canary},async()=>{
  assert.equal(durableIngressConfigured(A,"facebook"),false,"multichannel gate off");
  assert.equal(durableIngressConfigured(A,"whatsapp"),false);
  assert.equal(durableIngressConfigured(A,"instagram"),true);
 });
});

// ------------------------------------------- B-1/B-2: unknown vs terminal outcomes
test("claim RPC failure (claim_failed) is retryable; redelivery answers exactly once",async()=>{
 await quiet(()=>withEnv({},async()=>{
  const w=world({flows:v2Flows});
  w.fail["rpc:flow_claim_inbound"]=1;
  assert.equal(await w.deliver("mid-c1","hello"),503);
  assert.equal(w.outcome(),"claim_failed");
  assert.equal(w.ai(),0);assert.deepEqual(w.sent,[]);assert.equal(w.row("mid-c1")!.status,"retrying");
  assert.equal(await w.deliver("mid-c1","hello"),200);
  assert.deepEqual(w.sent,["AI"]);assert.equal(w.row("mid-c1")!.status,"resolved");
  assert.equal(await w.deliver("mid-c1","hello"),200);assert.deepEqual(w.sent,["AI"]);
 }));
});
test("send failure AFTER an acquired claim is terminal: never retried, never sent twice",async()=>{
 await quiet(()=>withEnv({},async()=>{
  const w=world({flows:v2Flows});
  w.failSend(1);
  assert.equal(await w.deliver("mid-s1","price"),200);
  assert.equal(w.outcome(),"send_failed");
  assert.deepEqual(w.attempts,["PRICES"],"one provider attempt");
  assert.equal(w.row("mid-s1"),undefined,"no retry state: the claim owns the event");
  assert.equal(await w.deliver("mid-s1","price"),200);
  assert.deepEqual(w.attempts,["PRICES"],"redelivery never re-sends");
  // the same after a re-drive: claim acquired, send fails -> resolved (terminal), not retried
  const r=world({flows:v2Flows});
  r.fail.automation_flow_activations=1;
  assert.equal(await r.deliver("mid-s2","price"),503);
  r.failSend(1);
  assert.equal(await r.deliver("mid-s2","price"),200);
  assert.equal(r.row("mid-s2")!.status,"resolved");
  assert.equal(await r.deliver("mid-s2","price"),200);
  assert.deepEqual(r.attempts,["PRICES"]);
 }));
});
test("durable unknown states (claim RPC error, prior-delivery read error) are retryable; then exactly one run",async()=>{
 await quiet(()=>withEnv(canary,async()=>{
  const flows:Flow[]=[{flow_key:"menu",revision:3,document:buttonsDoc(trig("message"))}];
  for(const f of [{"rpc:flow_claim_begin_durable_run":2},{automation_message_claims:1},{messages:1}]){
   const w=world({flows});
   Object.assign(w.fail,f);
   assert.equal(await w.deliver("mid-d1","hi"),503,JSON.stringify(f));
   assert.equal(w.runs.length,0);assert.equal(w.ai(),0);assert.deepEqual(w.sent,[]);
   assert.equal(await w.deliver("mid-d1","hi"),200);
   assert.deepEqual(w.runs,["menu"]);assert.equal(w.ai(),0);
   assert.equal(await w.deliver("mid-d1","hi"),200);assert.deepEqual(w.runs,["menu"]);
  }
 }));
});

// ------------------------------------------------- B-6: known terminal exits
test("known terminal exit while re-driving (human takeover) resolves; a read error stays retryable",async()=>{
 await quiet(()=>withEnv({},async()=>{
  const w=world({flows:v2Flows});
  w.fail.automation_flow_activations=1;
  assert.equal(await w.deliver("mid-t1","price"),503);
  w.conversation.transferred=true;
  assert.equal(await w.deliver("mid-t1","price"),200);
  assert.equal(w.row("mid-t1")!.status,"resolved");
  assert.deepEqual(w.sent,[]);assert.equal(w.ai(),0);
  w.conversation.transferred=false;
  assert.equal(await w.deliver("mid-t1","price"),200,"resolved: never re-driven again");
  assert.deepEqual(w.sent,[]);
  // transient tenant read error during a re-drive: still retrying (attempt counted)
  const r=world({flows:v2Flows});
  r.fail.automation_flow_activations=1;
  assert.equal(await r.deliver("mid-t2","price"),503);
  r.fail.tenants=1;
  assert.equal(await r.deliver("mid-t2","price"),503);
  assert.deepEqual({status:r.row("mid-t2")!.status,attempts:r.row("mid-t2")!.attempts},{status:"retrying",attempts:2});
  assert.equal(await r.deliver("mid-t2","price"),200);
  assert.deepEqual(r.sent,["PRICES"]);
  // tenant read error BEFORE anything is persisted: plain 503, nothing stored, redelivery processed once
  const n=world({flows:v2Flows});
  n.fail.tenants=1;
  assert.equal(await n.deliver("mid-t3","price"),503);
  assert.equal(n.messages.length,0);assert.equal(n.row("mid-t3"),undefined);
  assert.equal(await n.deliver("mid-t3","price"),200);
  assert.deepEqual(n.sent,["PRICES"]);assert.equal(n.messages.length,1);
 }));
});

// ------------------------------------------------------- B-5: synthetic ids
import {syntheticEventId} from "../supabase/functions/milan-api/syntheticEventId.ts";
test("B-5: no Meta mid -> deterministic id from signed fields (no raw text), stable across redeliveries",async()=>{
 const base={entryId:"1784",recipientId:"1784",senderId:"9001",timestamp:1730000000000,text:"secret phone 0790"};
 const a=await syntheticEventId(base),b=await syntheticEventId({...base});
 assert.match(String(a),/^ig_syn_[0-9a-f]{40}$/);assert.equal(a,b);
 assert.doesNotMatch(String(a),/secret|0790|9001/);
 for(const over of [{text:"other"},{senderId:"9002"},{timestamp:1730000000001},{recipientId:"1"}])
  assert.notEqual(await syntheticEventId({...base,...over}),a,JSON.stringify(over));
 for(const over of [{timestamp:null},{timestamp:0},{timestamp:"x"},{senderId:""},{text:5}])
  assert.equal(await syntheticEventId({...base,...over} as any),null,JSON.stringify(over));
 const src=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 assert.match(src,/const msgId =\n\s+msg\.mid \|\| derivedId \|\| `ig_\$\{Date\.now\(\)\}`;/);
 assert.match(src,/if \(msg\.mid \|\| derivedId\) \{/,"derived ids take part in the duplicate pre-check");
 assert.equal((src.match(/typeof msg\.mid === "string" && msg\.mid\.length > 0;/g)??[]).length,1,"provenance stays mid-only");
});
test("B-5: unknown eligibility for a synthetic-id event -> immediately 'exhausted' (no 503); redelivery never processed twice",async()=>{
 await quiet(()=>withEnv({},async()=>{
  const w=world({flows:v2Flows});
  w.fail.automation_flow_activations=1;
  assert.equal(await w.deliver("ig_syn_abc","price",false),200,"never a retryable 503");
  assert.deepEqual({...w.row("ig_syn_abc")!,conversation_id:0,inbound_message_id:0},
   {status:"exhausted",attempts:1,conversation_id:0,inbound_message_id:0});
  for(let i=0;i<3;i++)assert.equal(await w.deliver("ig_syn_abc","price",false),200);
  assert.equal(w.messages.length,1,"one inbound row");assert.deepEqual(w.sent,[]);assert.equal(w.ai(),0);
  // a synthetic event with a KNOWN outcome is processed once, redeliveries are duplicates
  const k=world({flows:v2Flows});
  assert.equal(await k.deliver("ig_syn_def","price",false),200);
  assert.equal(await k.deliver("ig_syn_def","price",false),200);
  assert.deepEqual(k.sent,["PRICES"]);assert.equal(k.messages.length,1);
  // genuine ids keep the retry behaviour
  const g=world({flows:v2Flows});
  g.fail.automation_flow_activations=1;
  assert.equal(await g.deliver("mid-g","price",true),503);
  assert.equal(g.row("mid-g")!.status,"retrying");
  assert.equal(retryAttemptCap(true),1);assert.equal(retryAttemptCap(false),INBOUND_ROUTING_MAX_ATTEMPTS);
 }));
});
test("retryable outcome rule: only unowned outcomes",()=>{
 for(const o of ["routing_unavailable","claim_failed"])assert.equal(isRetryableOutcome(o),true,o);
 for(const o of ["duplicate","empty","sent_and_billed","sent_billing_failed","sent_persist_failed","send_failed",
  "delivery_unavailable","sent_unconfirmed",undefined])assert.equal(isRetryableOutcome(o),false,String(o));
});
test("durable: an unexpected exception inside the guarded path is UNKNOWN -> retry (never 'handled', never the AI)",async()=>{
 await quiet(()=>withEnv(canary,async()=>{
  const w=world({flows:[{flow_key:"menu",revision:3,document:buttonsDoc(trig("message"))}]});
  const throwing={rpc:w.db.rpc,from:(t:string)=>{if(t==="automation_flow_runs")throw Error("socket hang up");return w.db.from(t);}};
  assert.equal(await attemptDurableInstagram(throwing as any,{tenantId:T,accountId:A,conversationId:CONV,
   inboundId:"77777777-7777-4777-8777-000000000009",eventId:"mid-x",platform:"instagram",text:"hi",providerEventIdGenuine:true}),"retry");
  assert.equal(w.runs.length,0);assert.equal(w.claims.size,0);
 }));
});
