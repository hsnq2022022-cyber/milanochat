/**
 * REVIEW ONLY. One bounded server-only scheduled wake-up batch.
 * Does NOT send any provider message, debit, or activate a flow.
 * Requires installed flow_commit_run_step / flow_lease_due_runs proposal.
 * A scheduler/deployment is NOT approved or configured.
 */
import {createClient} from "npm:@supabase/supabase-js@2";
import type {FlowDocument} from "../../../src/flow/model.ts";
import {planRuntimeTransition} from "../../../src/flow/runtimePlan.ts";

const base=Deno.env.get("SUPABASE_URL")??"";
const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")??"";
const maxPerTick=20;
function answer(message:string,status=200){return new Response(JSON.stringify({message}),{
 status,headers:{"content-type":"application/json;charset=utf-8"}});
}
function validVariables(value:unknown):value is Record<string,string>{
 return !!value&&typeof value==="object"&&!Array.isArray(value)&&
 Object.entries(value).every(([k,v])=>/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(k)&&
 !k.startsWith("__")&&typeof v==="string") &&
 new TextEncoder().encode(JSON.stringify(value)).length<=32768;
}
Deno.serve(async(req)=>{
 if(req.method!=="POST")return answer("method not allowed",405);
 const authorization=req.headers.get("authorization")??"";
 if(!service||authorization!== "Bearer "+service)return answer("unauthorized",401);
 if(!base)return answer("backend not configured",503);
 const sb=createClient(base,service);
 let body:unknown;
 try{body=await req.json();}catch{return answer("invalid json",400);}
 if(!body||typeof body!=="object"||(body as Record<string,unknown>).mode!=="tick")
  return answer("unsupported operation",400);
 const {data:gate,error:ge}=await sb.from("automation_flow_global_switch")
  .select("enabled").eq("singleton",true).single();
 if(ge||gate?.enabled!==true)return answer("flow global switch OFF",423);
 const {data:leases,error:le}=await sb.rpc("flow_lease_due_runs",{p_limit:maxPerTick});
 if(le||!Array.isArray(leases)){
  console.error("[flow-worker] lease failed",{code:le?.code??"invalid_result"});
  return answer("unable to lease due runs",503);
 }
 let committed=0,blocked=0;
 for(const item of leases){
  const tenantId=String(item.tenant_id??""),runId=String(item.run_id??"");
  const lease=String(item.lease_token??"");
  try{
   const {data:run,error:re}=await sb.from("automation_flow_runs").select("*")
    .eq("tenant_id",tenantId).eq("id",runId).single();
   if(re||!run||run.run_status!=="sleeping")throw Error("missing sleeping run");
   const {data:published,error:pe}=await sb.from("automation_flow_publications")
    .select("document")
    .eq("tenant_id",tenantId).eq("flow_key",run.flow_key)
    .eq("revision",run.publication_revision)
    .eq("channel_account_id",run.channel_account_id)
    .eq("platform",run.platform).single();
   if(pe||!published?.document)throw Error("missing immutable publication");
   const doc=published.document as FlowDocument;
   if(!validVariables(run.variables))throw Error("invalid run variables");
   const state={
    flowId:run.flow_key,revision:Number(run.publication_revision),
    nodeId:run.current_node_id,status:run.run_status as "sleeping",
    stepCount:Number(run.step_count),variables:run.variables,
    wakeAt:run.wake_at?new Date(run.wake_at).getTime():null
   };
   const plan=planRuntimeTransition(doc,state,{
    eventKey:"scheduled:"+runId,nowMs:Date.now(),seed:0
   });
   if(plan.error||plan.state.status==="blocked")throw Error("blocked runtime plan");
   // LLM needs owner-scoped verified knowledge and human/credit checks before
   // any send. This worker does not emit unsupported AI effects.
   if(plan.effects.some(e=>e.kind==="message"&&"source" in e&&e.source==="knowledge_ai"))
    throw Error("knowledge AI requires trusted handler, no emission");
   const effects=plan.effects.map(e=>({
    kind:e.kind,idempotencyKey:e.idempotencyKey,
    payload:e
   }));
   const metric=plan.state.status==="completed"?"completed":
    plan.state.status==="handoff"?"handoff":"transition";
   const {data:ok,error:ce}=await sb.rpc("flow_commit_run_step",{
    p_tenant:tenantId,p_run:runId,p_expect_step:run.step_count,
    p_expect_status:run.run_status,p_next_node:plan.state.nodeId,
    p_next_step:plan.state.stepCount,p_next_status:plan.state.status,
    p_variables:plan.state.variables,
    p_wake_at:plan.state.wakeAt?new Date(plan.state.wakeAt).toISOString():null,
    p_effects:effects,p_metric:metric,p_lease_token:lease
   });
   if(ce||ok!==true)throw Error("atomic transition not committed");
   committed++;
  }catch(e){
   blocked++;
   // Expiring lease permits later manual review, NOT provider send retries.
   console.error("[flow-worker] run blocked",{
    tenantId,runId,reason:e instanceof Error?e.message:"unknown"
   });
  }
 }
 return new Response(JSON.stringify({leased:leases.length,committed,blocked,sends:0}),
  {headers:{"content-type":"application/json"}});
});
