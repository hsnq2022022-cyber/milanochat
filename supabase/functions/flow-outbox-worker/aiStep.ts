/**
 * Flow Builder "AI step" (an `action` node with actionType "ai"; the button
 * action "ai" creates the same node). The planner emits the existing
 * knowledge_ai message effect ({kind:"message",source:"knowledge_ai",text:""});
 * this module only supplies what the existing durable knowledge path
 * (flowKnowledge.ts + knowledgeRetry.ts + the SQL claim/store/finish RPCs)
 * lacked for a live AI step:
 *  - the question: the customer's LAST inbound message of the run's
 *    conversation (tenant- and conversation-scoped, decrypted in memory only);
 *  - the tenant's own system message (tenants.agent_system_prompt, read by id);
 *  - the provider configuration of the live bot (milan-api answerFromKnowledge:
 *    same secret names, same embedding endpoint/model selection), so the query
 *    vector lives in the same space as the stored knowledge.
 *
 * FLOW_AI_STEP_ENABLED (default OFF) is read fail-closed and ALSO requires
 * FLOW_RAG_ENABLED (the existing knowledge kill switch). OFF: nothing here is
 * used; the ingress refuses the AI action and the worker behaves as before.
 *
 * Never logs or returns customer text, system messages or answers in errors:
 * failures carry short snake_case codes only.
 */
import type {SupabaseClient} from "npm:@supabase/supabase-js@2";
import {KnowledgeError,knowledgeHttpError,knowledgeQuestionValid,classifyKnowledgeError,
 answerWithVerifiedKnowledgeOutcome,type KnowledgeDependencies,type KnowledgeOutcome,
 type KnowledgeScope} from "./flowKnowledge.ts";

export type EnvGet=(name:string)=>string|undefined;

/** Both flags must be exactly "true"; no Deno runtime or any error = OFF. */
export function aiStepEnabled(get?:EnvGet):boolean{
 try{
  const read:EnvGet=get??(name=>Deno.env.get(name));
  return read("FLOW_AI_STEP_ENABLED")==="true"&&read("FLOW_RAG_ENABLED")==="true";
 }catch{return false;}
}

export type AiQuestion={kind:"ok";text:string}|{kind:"none"}|{kind:"error"};
/**
 * The customer's last inbound message of THIS tenant conversation, created no
 * later than the AI effect (a newer message never changes the question of an
 * already queued step). Read error = "error" (caller holds the effect, no
 * state change); missing/unreadable/invalid text = "none" (not retryable).
 */
export async function lastInboundQuestion(
 sb:Pick<SupabaseClient,"from">,
 scope:{tenantId:string;conversationId:string;before:string},
 decrypt:(encrypted:string)=>Promise<string>
):Promise<AiQuestion>{
 if(!scope||typeof scope.tenantId!=="string"||!scope.tenantId||
    typeof scope.conversationId!=="string"||!scope.conversationId||
    typeof scope.before!=="string"||!scope.before)return {kind:"none"};
 let rows:unknown;
 try{
  const {data,error}=await sb.from("messages")
   .select("tenant_id,conversation_id,direction,body_encrypted,created_at")
   .eq("tenant_id",scope.tenantId).eq("conversation_id",scope.conversationId)
   .eq("direction","in").lte("created_at",scope.before)
   .order("created_at",{ascending:false}).limit(1);
  if(error||!Array.isArray(data))return {kind:"error"};
  rows=data;
 }catch{return {kind:"error"};}
 const row=(rows as Record<string,unknown>[])[0];
 // Defense in depth: never use a row of another tenant/conversation.
 if(!row||typeof row!=="object"||row.tenant_id!==scope.tenantId||
    row.conversation_id!==scope.conversationId||row.direction!=="in"||
    typeof row.body_encrypted!=="string"||!row.body_encrypted)return {kind:"none"};
 let text="";
 try{text=(await decrypt(row.body_encrypted)).trim();}catch{return {kind:"none"};}
 return knowledgeQuestionValid(text)?{kind:"ok",text}:{kind:"none"};
}

/** Same bound as milan-api answerFromKnowledge. */
export const MAX_SYSTEM_PROMPT_CHARS=8000;
/**
 * The tenant's own system message, read by tenant id only (service role).
 * Lookup error throws a retryable KnowledgeError (classified as transient).
 */
export async function tenantSystemPrompt(
 sb:Pick<SupabaseClient,"from">,tenantId:string
):Promise<string|null>{
 const {data,error}=await sb.from("tenants").select("id,agent_system_prompt")
  .eq("id",tenantId).maybeSingle();
 if(error)throw new KnowledgeError("Tenant prompt lookup failed","rag_lookup_failed",true);
 if(!data||(data as {id?:unknown}).id!==tenantId)return null;
 const raw=(data as {agent_system_prompt?:unknown}).agent_system_prompt;
 const prompt=typeof raw==="string"?raw.trim():"";
 return prompt?prompt.slice(0,MAX_SYSTEM_PROMPT_CHARS):null;
}

/**
 * One AI-step model attempt: tenant system message + the existing verified
 * knowledge core (tenant-scoped match_knowledge, ownership + approval
 * re-validation, grounded answer with a verified supporting quote).
 * Never throws (same contract as answerWithVerifiedKnowledgeOutcome).
 */
export async function generateAiStepAnswer(
 sb:Pick<SupabaseClient,"rpc"|"from">,scope:KnowledgeScope,question:string,
 deps:KnowledgeDependencies
):Promise<KnowledgeOutcome>{
 let ownerInstructions:string|null;
 try{ownerInstructions=await tenantSystemPrompt(sb,scope.tenantId);}
 catch(err){return classifyKnowledgeError(err);}
 return answerWithVerifiedKnowledgeOutcome(sb,{...scope,ownerInstructions},question,deps);
}

const OPENAI_BASE="https://api.openai.com/v1";
const GEMINI_EMBED_URL=
 "https://generativelanguage.googleapis.com/v1/models/text-embedding-004:batchEmbedContents";
function firstKey(get:EnvGet,names:string[]):string{
 for(const n of names){
  const v=(get(n)??"").trim();
  if(v)return v;
 }
 return "";
}
function httpsBase(raw:string|undefined,fallback:string):string{
 const v=(raw??"")||fallback;
 if(!/^https:\/\/[^\s/?#@]+/.test(v))
  throw new KnowledgeError("AI base URL invalid","ai_config_invalid",false);
 return v;
}
/**
 * Provider port of the AI step: the live bot's configuration (milan-api
 * aiKey/embed/chatJSON) behind the existing KnowledgeDependencies interface.
 * Same secret names, no new secret: embeddings EMBED_API_KEY, GEMINI_API_KEY,
 * LLM_API_KEY, OPENAI_API_KEY (a Google "AIza" key uses Gemini
 * text-embedding-004, otherwise EMBED_BASE_URL/EMBED_MODEL); chat LLM_API_KEY,
 * GEMINI_API_KEY, EMBED_API_KEY, OPENAI_API_KEY at LLM_BASE_URL/LLM_MODEL.
 * No in-request retries: the Outbox owns the bounded backoff.
 */
export function liveBotKnowledgeDependencies(
 fetcher:typeof fetch=fetch,get?:EnvGet
):KnowledgeDependencies{
 const read:EnvGet=get??(name=>Deno.env.get(name));
 return {
  async embed(text){
   const key=firstKey(read,["EMBED_API_KEY","GEMINI_API_KEY","LLM_API_KEY","OPENAI_API_KEY"]);
   if(!key)throw new KnowledgeError("Embedding key missing","ai_config_missing",false);
   if(key.startsWith("AIza")){
    const r=await fetcher(GEMINI_EMBED_URL,{
     method:"POST",headers:{"content-type":"application/json","x-goog-api-key":key},
     body:JSON.stringify({requests:[{model:"models/text-embedding-004",
      content:{parts:[{text}]}}]}),
     signal:AbortSignal.timeout(20000)
    });
    if(!r.ok)throw knowledgeHttpError("Embedding",r.status);
    const data=await r.json();
    return data?.embeddings?.[0]?.values??[];
   }
   const r=await fetcher(httpsBase(read("EMBED_BASE_URL"),OPENAI_BASE)+"/embeddings",{
    method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key},
    body:JSON.stringify({model:read("EMBED_MODEL")||"text-embedding-3-small",input:[text]}),
    signal:AbortSignal.timeout(20000)
   });
   if(!r.ok)throw knowledgeHttpError("Embedding",r.status);
   const data=await r.json();
   return data?.data?.[0]?.embedding??[];
  },
  async complete(system,user){
   const key=firstKey(read,["LLM_API_KEY","GEMINI_API_KEY","EMBED_API_KEY","OPENAI_API_KEY"]);
   if(!key)throw new KnowledgeError("LLM key missing","ai_config_missing",false);
   const r=await fetcher(httpsBase(read("LLM_BASE_URL"),OPENAI_BASE)+"/chat/completions",{
    method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key},
    body:JSON.stringify({model:read("LLM_MODEL")||"gpt-4o-mini",
     response_format:{type:"json_object"},
     messages:[{role:"system",content:system},{role:"user",content:user}]}),
    signal:AbortSignal.timeout(25000)
   });
   if(!r.ok)throw knowledgeHttpError("LLM",r.status);
   const data=await r.json();
   try{return JSON.parse(data.choices?.[0]?.message?.content??"{}");}
   catch{return {answer:null,grounded:false,supporting_quote:null};}
  }
 };
}
