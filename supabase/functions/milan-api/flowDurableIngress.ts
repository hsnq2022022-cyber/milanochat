/**
 * SERVER ONLY. Signed Instagram webhook -> durable question/delay plan.
 * Disabled until an explicit operator-selected account passes live send tests.
 * Never calls Meta or charges: effects are stored for the separate Outbox.
 */
import {createRuntimeState,planRuntimeTransition,type RuntimeState} from "../../../src/flow/runtimePlan.ts";
import type {FlowDocument} from "../../../src/flow/model.ts";

type RecordValue=Record<string,unknown>;
const record=(v:unknown):v is RecordValue=>!!v&&typeof v==="object"&&!Array.isArray(v);
const edge=(e:RecordValue,source:string,target:string,handle:string)=>
 e.source===source&&e.target===target&&e.sourceHandle===handle;
const safeId=(s:unknown):s is string=>typeof s==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(s);
const message=(n:RecordValue)=>record(n.data)&&n.data.kind==="message"&&
 typeof n.data.text==="string"&&n.data.text.trim().length>0&&
 new TextEncoder().encode(n.data.text).byteLength<=1000&&
 n.data.image===""&&Array.isArray(n.data.options)&&n.data.options.length===0&&
 Array.isArray(n.data.contentBlocks)&&n.data.contentBlocks.length===0;

/** The only advanced runtime graphs approved for initial live testing. */
export function supportedDurableDocument(raw:unknown):raw is FlowDocument{
 if(!record(raw)||raw.version!==3||!Array.isArray(raw.nodes)||
    !Array.isArray(raw.edges))return false;
 const nodes=raw.nodes as unknown[],edges=raw.edges as unknown[];
 if(nodes.some(n=>!record(n)||!safeId(n.id)||!record(n.data))||
    edges.some(e=>!record(e))||
    new Set(nodes.map(n=>(n as RecordValue).id)).size!==nodes.length)return false;
 const trigger=nodes.filter(n=>(n as RecordValue).data &&
  ((n as RecordValue).data as RecordValue).kind==="trigger") as RecordValue[];
 if(trigger.length!==1)return false;
 const s=trigger[0],d=s.data as RecordValue;
 if(d.platform!=="instagram"||d.triggerMode!=="message")return false;
 if(nodes.length===3&&edges.length===2){
  const delay=nodes.find(n=>((n as RecordValue).data as RecordValue).kind==="delay") as RecordValue|undefined;
  const reply=nodes.find(n=>((n as RecordValue).data as RecordValue).kind==="message") as RecordValue|undefined;
  if(!delay||!reply||!message(reply))return false;
  const data=delay.data as RecordValue;
  if(typeof data.delayValue!=="number"||!Number.isSafeInteger(data.delayValue)||
     data.delayValue<1||data.delayValue>30||
     !["seconds","minutes","hours","days"].includes(String(data.delayUnit)))return false;
  return edges.filter(e=>edge(e as RecordValue,s.id as string,delay.id as string,"next")).length===1&&
   edges.filter(e=>edge(e as RecordValue,delay.id as string,reply.id as string,"next")).length===1;
 }
 if(nodes.length===4&&edges.length===3){
  const q=nodes.find(n=>((n as RecordValue).data as RecordValue).kind==="question") as RecordValue|undefined;
  const replies=nodes.filter(n=>((n as RecordValue).data as RecordValue).kind==="message") as RecordValue[];
  if(!q||replies.length!==2||!replies.every(message))return false;
  const qd=q.data as RecordValue;
  if(qd.inputMode!=="buttons"||typeof qd.text!=="string"||
     !qd.text.trim()||new TextEncoder().encode(qd.text).byteLength>1000||
     !Array.isArray(qd.options)||qd.options.length!==2)return false;
  const opts=qd.options as unknown[];
  if(opts.some(o=>!record(o)||!safeId(o.id)||typeof o.label!=="string"||
     !o.label.trim()||o.label.length>20||
     (o.action!==undefined&&o.action!=="step"))||
     new Set(opts.map(o=>(o as RecordValue).id)).size!==2)return false;
  return edges.filter(e=>edge(e as RecordValue,s.id as string,q.id as string,"next")).length===1&&
   opts.every((o,i)=>edges.filter(e=>edge(e as RecordValue,q.id as string,
     replies[i].id as string,(o as RecordValue).id as string)).length===1);
 }
 return false;
}
export function selectedFlowChoice(raw:unknown):string|null{
 if(!record(raw)||!record(raw.quick_reply))return null;
 const payload=raw.quick_reply.payload;
 if(typeof payload!=="string"||!payload.startsWith("flow-choice:"))return null;
 const value=payload.slice("flow-choice:".length);
 return safeId(value)?value:null;
}
const effectsPayload=(effects:ReturnType<typeof planRuntimeTransition>["effects"])=>
 effects.map(e=>({kind:e.kind,idempotencyKey:e.idempotencyKey,payload:e}));
const safePlan=(plan:ReturnType<typeof planRuntimeTransition>)=>
 !plan.error&&plan.state.status!=="blocked"&&
 ["completed","sleeping","awaiting_input"].includes(plan.state.status)&&
 plan.effects.length===1&&plan.effects.every(e=>
  ["message","question","delay"].includes(e.kind)&&!("source" in e));

export type DurableEvent={
 tenantId:string;accountId:string;conversationId:string;inboundId:string;
 eventId:string;platform:string;selectedChoiceId?:string|null;
};
type Db={from(table:string):any;rpc(name:string,args:RecordValue):Promise<{data:any;error:any}>};
type Result="fallback"|"handled";
const validEvent=(e:DurableEvent)=>
 [e.tenantId,e.accountId,e.conversationId,e.inboundId].every(x=>
  typeof x==="string"&&/^[a-f\d]{8}-[a-f\d-]{27,36}$/i.test(x))&&
 typeof e.eventId==="string"&&e.eventId.length>=1&&e.eventId.length<=256&&
 e.platform==="instagram";
/**
 * Returns handled only when this server-owned path has taken responsibility
 * or must fail closed. false/fallback allows the existing text-only engine.
 */
export async function attemptDurableInstagram(
 db:Db,event:DurableEvent
):Promise<Result>{
 if(Deno.env.get("FLOW_DURABLE_INGRESS_ENABLED")!=="true"||
    Deno.env.get("FLOW_DURABLE_CANARY_ACCOUNT_ID")!==event.accountId||
    !validEvent(event))return "fallback";
 try{
  const [g,s]=await Promise.all([
   db.from("automation_flow_global_switch").select("enabled")
    .eq("singleton",true).maybeSingle(),
   db.from("automation_flow_tenant_switches").select("enabled,production_approved")
    .eq("tenant_id",event.tenantId).maybeSingle()
  ]);
  if(g.error||s.error)return "handled";
  if(g.data?.enabled!==true||s.data?.enabled!==true||
     s.data?.production_approved!==true)return "fallback";
  const waiting=await db.from("automation_flow_runs")
   .select("id,tenant_id,channel_account_id,platform,conversation_id,flow_key,publication_revision,current_node_id,run_status,step_count,variables,wake_at")
   .eq("tenant_id",event.tenantId).eq("channel_account_id",event.accountId)
   .eq("conversation_id",event.conversationId).eq("run_status","awaiting_input")
   .limit(2);
  if(waiting.error)return "handled";
  const current=waiting.data??[];
  if(current.length>1)return "handled";
  const choice=event.selectedChoiceId??null;
  if(current.length===1){
   const run=current[0];
   if(!choice||!safeId(choice)||run.platform!=="instagram")return "handled";
   const publication=await db.from("automation_flow_publications")
    .select("document").eq("tenant_id",event.tenantId)
    .eq("channel_account_id",event.accountId).eq("platform","instagram")
    .eq("flow_key",run.flow_key).eq("revision",run.publication_revision).maybeSingle();
   if(publication.error||!supportedDurableDocument(publication.data?.document))
    return "handled";
   const doc=publication.data.document;
   const state:RuntimeState={
    flowId:run.flow_key,revision:Number(run.publication_revision),
    nodeId:run.current_node_id,status:"awaiting_input",stepCount:Number(run.step_count),
    variables:run.variables??{},wakeAt:null
   };
   const plan=planRuntimeTransition(doc,state,{
    eventKey:event.eventId,nowMs:Date.now(),seed:0,answer:choice
   });
   if(!safePlan(plan))return "handled";
   const claim=await db.rpc("flow_claim_inbound",{
    p_tenant_id:event.tenantId,p_account_id:event.accountId,
    p_platform:"instagram",p_provider_event_id:event.eventId,
    p_conversation_id:event.conversationId,p_inbound_message_id:event.inboundId,
    p_engine_ready:true
   });
   if(claim.error||!Array.isArray(claim.data)||claim.data.length!==1||
      claim.data[0].acquired!==true||claim.data[0].route!=="flow")
    return "handled";
   const commit=await db.rpc("flow_resume_button_run",{
    p_tenant:event.tenantId,p_run:run.id,p_event:event.eventId,
    p_inbound:event.inboundId,p_expect_step:state.stepCount,
    p_expect_node:state.nodeId,p_next:plan.state.nodeId,
    p_next_step:plan.state.stepCount,p_status:plan.state.status,
    p_variables:plan.state.variables,
    p_wake:plan.state.wakeAt?new Date(plan.state.wakeAt).toISOString():null,
    p_effects:effectsPayload(plan.effects)
   });
   if(commit.error||commit.data!==true)
    console.warn("[flow-durable] button continuation pending manual review");
   return "handled";
  }
  if(choice)return "handled"; // stale choice must never start a fresh run.
  const active=await db.from("automation_flow_activations")
   .select("flow_key,revision,is_active").eq("tenant_id",event.tenantId)
   .eq("channel_account_id",event.accountId).eq("platform","instagram")
   .eq("is_active",true).limit(2);
  if(active.error)return "handled";
  if(!Array.isArray(active.data)||active.data.length!==1)return "fallback";
  const selection=active.data[0];
  if(!Number.isSafeInteger(Number(selection.revision)))return "handled";
  const pub=await db.from("automation_flow_publications").select("document")
   .eq("tenant_id",event.tenantId).eq("channel_account_id",event.accountId)
   .eq("platform","instagram").eq("flow_key",selection.flow_key)
   .eq("revision",selection.revision).maybeSingle();
  if(pub.error)return "handled";
  if(!supportedDurableDocument(pub.data?.document))return "fallback";
  const doc=pub.data.document;
  const state=createRuntimeState(doc,selection.flow_key,Number(selection.revision));
  const plan=planRuntimeTransition(doc,state,{
   eventKey:event.eventId,nowMs:Date.now(),seed:0
  });
  if(!safePlan(plan))return "handled";
  const claim=await db.rpc("flow_claim_inbound",{
   p_tenant_id:event.tenantId,p_account_id:event.accountId,
   p_platform:"instagram",p_provider_event_id:event.eventId,
   p_conversation_id:event.conversationId,p_inbound_message_id:event.inboundId,
   p_engine_ready:true
  });
  if(claim.error||!Array.isArray(claim.data)||claim.data.length!==1||
    claim.data[0].acquired!==true||claim.data[0].route!=="flow")
   return "handled";
  const begin=await db.rpc("flow_begin_durable_run",{
   p_tenant:event.tenantId,p_account:event.accountId,
   p_conversation:event.conversationId,p_inbound:event.inboundId,
   p_event:event.eventId,p_flow:selection.flow_key,p_revision:selection.revision,
   p_start:state.nodeId,p_next:plan.state.nodeId,
   p_next_step:plan.state.stepCount,p_status:plan.state.status,
   p_variables:plan.state.variables,
   p_wake:plan.state.wakeAt?new Date(plan.state.wakeAt).toISOString():null,
   p_effects:effectsPayload(plan.effects)
  });
  if(begin.error||typeof begin.data!=="string")
   console.warn("[flow-durable] initial run pending manual review");
  return "handled";
 }catch(error){
  console.error("[flow-durable] guarded path failed",error instanceof Error?error.name:"unknown");
  return "handled";
 }
}
