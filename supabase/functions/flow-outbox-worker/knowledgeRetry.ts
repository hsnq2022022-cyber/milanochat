/**
 * Pure, Deno-free retry policy for knowledge_ai outbox effects.
 *
 * Outcomes (see flowKnowledge.ts KnowledgeOutcome):
 *  - answer        -> answer is encrypted and persisted on the effect under the
 *                     AI claim BEFORE any provider send, so a later attempt or a
 *                     second worker reuses it and never calls the model again.
 *  - no_knowledge  -> terminal: cancelled / cancel_reason 'no_knowledge'.
 *  - ineligible    -> terminal: cancelled / cancel_reason 'ineligible'.
 *  - permanent     -> terminal: dead_letter / cancel_reason 'ai_unavailable'.
 *  - transient     -> retry_wait + retry_at (next attempt time) with bounded
 *                     exponential backoff; after AI_MAX_ATTEMPTS the effect is
 *                     dead_letter / cancel_reason 'ai_retries_exhausted'.
 * The atomic claim / store / finish transitions live in SQL
 * (20261029140000_flow_outbox_ai_retry.sql); this module only decides.
 * Provider sending stays one-shot through flow_reserve_outbox_delivery.
 */
import type {KnowledgeOutcome} from "./flowKnowledge.ts";

/** Total model attempts per effect (first try + 4 retries). Mirrored in SQL default. */
export const AI_MAX_ATTEMPTS=5;
/** Delay after attempt n (1-based) = base * 2^(n-1): 60s, 120s, 240s, 480s. */
export const AI_BACKOFF_BASE_SECONDS=60;
export const AI_BACKOFF_MAX_SECONDS=900;
/** Up to +10% random jitter so a provider outage does not retry in lockstep. */
export const AI_BACKOFF_JITTER_RATIO=0.1;
/** AI generation claim lease; an expired lease (crashed worker) can be re-claimed. */
export const AI_CLAIM_LEASE_SECONDS=120;

export type AiTerminalReason="no_knowledge"|"ineligible"|"ai_unavailable"|"ai_retries_exhausted";

export function aiRetryDelaySeconds(attempt:number,random:()=>number=Math.random):number{
 const n=Number.isInteger(attempt)&&attempt>=1?Math.min(attempt,10):1;
 const base=Math.min(AI_BACKOFF_BASE_SECONDS*2**(n-1),AI_BACKOFF_MAX_SECONDS);
 const r=random();
 const jitter=Number.isFinite(r)&&r>0?Math.min(r,1)*AI_BACKOFF_JITTER_RATIO:0;
 return Math.round(base*(1+jitter));
}

const CODE=/^[a-z0-9_]{1,48}$/;
/** Never persist free text: anything that is not a short snake_case code collapses. */
export function safeAiErrorCode(code:unknown):string{
 return typeof code==="string"&&CODE.test(code)?code:"ai_unknown";
}

export type AiDecision=
 |{action:"send";text:string}
 |{action:"finish";result:"no_knowledge"|"ineligible"}
 |{action:"finish";result:"permanent";code:string}
 |{action:"finish";result:"retry";code:string;delaySeconds:number;exhausted:boolean};

export function decideKnowledgeOutcome(outcome:KnowledgeOutcome,attempt:number,
 random:()=>number=Math.random):AiDecision{
 switch(outcome?.kind){
  case "answer":{
   const text=typeof outcome.text==="string"?outcome.text.trim():"";
   // An empty "answer" is a contract violation, not missing knowledge: retry.
   if(!text||text.length>4000)
    return retry("ai_bad_response",attempt,random);
   return {action:"send",text};
  }
  case "no_knowledge":return {action:"finish",result:"no_knowledge"};
  case "ineligible":return {action:"finish",result:"ineligible"};
  case "permanent":return {action:"finish",result:"permanent",code:safeAiErrorCode(outcome.code)};
  case "transient":return retry(outcome.code,attempt,random);
  default:return retry("ai_unknown",attempt,random);
 }
}
function retry(code:unknown,attempt:number,random:()=>number):AiDecision{
 return {action:"finish",result:"retry",code:safeAiErrorCode(code),
  delaySeconds:aiRetryDelaySeconds(attempt,random),
  exhausted:!(Number.isInteger(attempt)&&attempt<AI_MAX_ATTEMPTS)};
}

export type AiClaim=
 |{outcome:"claimed";token:string;attempt:number}
 |{outcome:"cached";answerEncrypted:string}
 |{outcome:"busy"|"not_due"|"not_claimable"|"exhausted"};

export type KnowledgeEffectDeps={
 /** Atomic claim (flow_claim_outbox_ai). Throw or return null on DB error. */
 claim():Promise<AiClaim|null>;
 decrypt(answerEncrypted:string):Promise<string>;
 /** Must not throw; see answerWithVerifiedKnowledgeOutcome. */
 generate():Promise<KnowledgeOutcome>;
 /** Persist encrypted answer under the claim token (flow_store_outbox_ai_answer). */
 store(token:string,text:string):Promise<boolean>;
 /** Terminal / backoff transition under the claim token (flow_finish_outbox_ai). */
 finish(token:string,decision:Exclude<AiDecision,{action:"send"}>):Promise<string|null>;
 random?:()=>number;
};
export type KnowledgeEffectResult={status:"send";text:string}|{status:"report";key:string};

/**
 * Resolve the text for one knowledge_ai effect. Returns "send" only with an
 * answer that is durably persisted on the effect (fresh or cached); every
 * other path reports and leaves sending to nobody.
 */
export async function resolveKnowledgeEffect(d:KnowledgeEffectDeps):Promise<KnowledgeEffectResult>{
 let claim:AiClaim|null;
 try{claim=await d.claim();}catch{return {status:"report",key:"blocked"};}
 if(!claim)return {status:"report",key:"blocked"};
 if(claim.outcome==="cached"){
  let text="";
  try{text=(await d.decrypt(claim.answerEncrypted)).trim();}catch{text="";}
  // Never regenerate when an answer exists but cannot be read: fail closed.
  if(!text||text.length>4000)return {status:"report",key:"ai_cached_unreadable"};
  return {status:"send",text};
 }
 if(claim.outcome==="exhausted")return {status:"report",key:"dead_letter_ai_retries_exhausted"};
 if(claim.outcome!=="claimed")return {status:"report",key:"ai_"+claim.outcome};
 let outcome:KnowledgeOutcome;
 try{outcome=await d.generate();}
 catch{outcome={kind:"transient",code:"ai_unknown"};}
 const decision=decideKnowledgeOutcome(outcome,claim.attempt,d.random);
 if(decision.action==="send"){
  let stored=false;
  try{stored=await d.store(claim.token,decision.text);}catch{stored=false;}
  // Lost claim or DB error: the answer is NOT sent from this attempt. The
  // claim lease expires and a later tick re-claims (counted, bounded).
  return stored?{status:"send",text:decision.text}:{status:"report",key:"ai_store_failed"};
 }
 let next:string|null=null;
 try{next=await d.finish(claim.token,decision);}catch{next=null;}
 if(!next)return {status:"report",key:"ai_finish_failed"};
 return {status:"report",key:next==="retry_wait"?"ai_retry_scheduled":
  next+"_"+(decision.result==="retry"?"ai_retries_exhausted":
   decision.result==="permanent"?"ai_unavailable":decision.result)};
}
