import type {SupabaseClient} from "npm:@supabase/supabase-js@2";
import {authorizeFlowAI} from "../../../src/flow/aiMetricsGate.ts";

/** Trusted server-side RAG, no fake text, no use of other tenants' documents. */
export type KnowledgeScope={
 tenantId:string;publishedTenantId:string;conversationTenantId:string;
 agentEnabled:boolean;humanTakeover:boolean;credits:number;businessName:string;
};
export type KnowledgeDependencies={
 embed(text:string):Promise<number[]>;
 complete(system:string,user:string):Promise<{answer:unknown;grounded:unknown;supporting_quote:unknown}>;
};
type Chunk={id:string;content:string;similarity:number};
const quoteInSource=(quote:string,rows:Chunk[])=>rows.some(r=>r.content.includes(quote));
export async function answerWithVerifiedKnowledge(
 sb:Pick<SupabaseClient,"rpc"|"from">,scope:KnowledgeScope,question:string,deps:KnowledgeDependencies
):Promise<string|null>{
 if(!scope||!scope.tenantId||!scope.agentEnabled||scope.humanTakeover||
    !Number.isFinite(scope.credits)||scope.credits<=0||typeof question!=="string"||
    question.trim().length<1||question.length>4000)
  return null;
 if(scope.tenantId!==scope.publishedTenantId||
    scope.tenantId!==scope.conversationTenantId)return null;
 const vector=await deps.embed(question);
 if(!Array.isArray(vector)||vector.length===0||vector.length>4096||
    !vector.every(v=>typeof v==="number"&&Number.isFinite(v)))return null;
 const {data,error}=await sb.rpc("match_knowledge",{
  p_tenant_id:scope.tenantId,
  p_query:"["+vector.join(",")+"]",
  p_limit:5,p_threshold:0.25
 });
 if(error)throw Error("RAG lookup failed: "+(error.code??"unknown"));
 const candidates=(Array.isArray(data)?data:[]).filter((r:unknown):r is Chunk=>{
  if(!r||typeof r!=="object")return false;
  const x=r as Record<string,unknown>;
  return typeof x.id==="string"&&typeof x.content==="string"&&
    x.content.length>0&&x.content.length<=5000&&
    typeof x.similarity==="number"&&x.similarity>=0.25;
 }).slice(0,5);
 if(!candidates.length)return null;
 // Do NOT trust match_knowledge to imply approved ownership; revalidate
 // every source ID against tenant-scoped knowledge_chunks (service role).
 const ids=candidates.map(x=>x.id);
 const {data:owned,error:ownershipError}=await sb.from("knowledge_chunks")
  .select("id,tenant_id,content,source_id").eq("tenant_id",scope.tenantId)
  .in("id",ids).limit(5);
 if(ownershipError)throw Error("RAG ownership lookup failed");
 const verifiedRows=(owned??[]).filter((r:{tenant_id:string;source_id:string|null})=>
  r.tenant_id===scope.tenantId && typeof r.source_id==="string");
 const sourceIds=[...new Set(verifiedRows.map((r:{source_id:string})=>r.source_id))];
 if(!sourceIds.length)return null;
 const {data:sources,error:sourceError}=await sb.from("knowledge_sources")
  .select("id,tenant_id,status").eq("tenant_id",scope.tenantId)
  .eq("status","indexed").in("id",sourceIds).limit(5);
 if(sourceError)throw Error("RAG source approval lookup failed");
 const validSources=new Set((sources??[]).filter((r:{tenant_id:string;status:string})=>
  r.tenant_id===scope.tenantId&&r.status==="indexed")
  .map((r:{id:string})=>r.id));
 const known=new Map(verifiedRows.filter((r:{source_id:string})=>
   validSources.has(r.source_id)).map((r:{id:string;content:string})=>[r.id,r.content]));
 const evidence=candidates.filter(x=>known.get(x.id)===x.content);
 const auth=authorizeFlowAI({
  verifiedTenantId:scope.tenantId,publishedFlowTenantId:scope.publishedTenantId,
  knowledgeTenantId:scope.tenantId,conversationTenantId:scope.conversationTenantId,
  sourceCount:evidence.length,retrievedEvidenceCount:evidence.length,
  knowledgeRetrievalSucceeded:true,creditBalance:scope.credits,
  humanTakeover:scope.humanTakeover,agentEnabled:scope.agentEnabled
 });
 if(!auth.allowed)return null;
 const context=evidence.map((x,i)=>"["+String(i+1)+"] "+x.content).join("\n");
 const result=await deps.complete(
  "You are an Arabic business assistant for "+scope.businessName+
  ". Answer ONLY with supplied verified knowledge. If unknown return grounded:false."+
  " Return JSON {answer:string,grounded:boolean,supporting_quote:string}."+
  " supporting_quote MUST be an exact contiguous excerpt from context.",
  "Verified store knowledge:\n"+context+"\nCustomer:\n"+question.trim()
 );
 const answer=typeof result.answer==="string"?result.answer.trim():"";
 const quote=typeof result.supporting_quote==="string"?result.supporting_quote.trim():"";
 if(result.grounded!==true||!answer||answer.length>2000||
    quote.length<12||quote.length>700||!quoteInSource(quote,evidence))
  return null;
 return answer;
}
export function openAIKnowledgeDependencies(fetcher:typeof fetch=fetch):KnowledgeDependencies{
 const apiKey=Deno.env.get("EMBED_API_KEY")??Deno.env.get("LLM_API_KEY")??"";
 const llmKey=Deno.env.get("LLM_API_KEY")??"";
 return {
  async embed(text){
   if(!apiKey)throw Error("Embedding key missing");
   const r=await fetcher("https://api.openai.com/v1/embeddings",{
    method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+apiKey},
    body:JSON.stringify({model:Deno.env.get("EMBED_MODEL")||"text-embedding-3-small",input:text}),
    signal:AbortSignal.timeout(20000)
   });
   if(!r.ok)throw Error("Embedding HTTP "+r.status);
   const data=await r.json();
   return data?.data?.[0]?.embedding??[];
  },
  async complete(system,user){
   if(!llmKey)throw Error("LLM key missing");
   const r=await fetcher("https://api.openai.com/v1/chat/completions",{
    method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+llmKey},
    body:JSON.stringify({model:Deno.env.get("LLM_MODEL")||"gpt-4o-mini",
      response_format:{type:"json_object"},
      messages:[{role:"system",content:system},{role:"user",content:user}]}),
    signal:AbortSignal.timeout(25000)
   });
   if(!r.ok)throw Error("LLM HTTP "+r.status);
   const data=await r.json();
   try{return JSON.parse(data.choices?.[0]?.message?.content??"{}");}
   catch{return {answer:null,grounded:false,supporting_quote:null};}
  }
 };
}
