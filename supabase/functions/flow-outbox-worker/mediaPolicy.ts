/**
 * SERVER ONLY. Image (media) send policy shared by milan-api/flowDurableIngress.ts
 * (whitelist) and the Outbox worker (message_image effects). Pure, no IO.
 *
 * FLOW_MEDIA_SEND_ENABLED (default OFF). DO NOT ENABLE before the operator
 * GO and before 20261029210000_flow_media_effects is applied (outbox CHECK,
 * flow_commit_run_step, flow_reserve_outbox_delivery, and the 'rejected'
 * outcome of flow_finish_outbox_delivery). The planner (src/flow/runtimePlan.ts
 * / runtimeChain.ts) emits message_image for text+image message nodes and the
 * publication gate requires message:image in FLOW_ACTIVATION_CAPABILITIES plus
 * this flag; without the migration no image effect can be stored or reserved.
 */
export const FLOW_MEDIA_SEND_FLAG="FLOW_MEDIA_SEND_ENABLED";
export const FLOW_MEDIA_PATH="/storage/v1/object/public/flow-media/";
/**
 * Server-side copy of src/flow/model.ts isAllowedImageUrl: https, no
 * credentials, host = project host (from SUPABASE_URL when present), public
 * flow-media object path, no traversal or encoded separators. Additionally
 * canonical only (no query/fragment, href unchanged by the URL parser).
 */
export function isAllowedFlowImageUrl(raw:unknown,supabaseUrl?:string|null):boolean{
 if(typeof raw!=="string"||!raw||raw!==raw.trim())return false;
 let u:URL;
 try{u=new URL(raw);}catch{return false;}
 if(u.protocol!=="https:"||u.username||u.password)return false;
 // Stricter than the editor rule: only the canonical form is sent to Meta
 // (dot segments such as %2e%2e would otherwise be resolved by the parser).
 if(u.href!==raw||u.search||u.hash)return false;
 if(supabaseUrl){
  try{if(u.host!==new URL(supabaseUrl).host)return false;}catch{return false;}
 }
 if(!u.pathname.startsWith(FLOW_MEDIA_PATH)||u.pathname.length===FLOW_MEDIA_PATH.length)return false;
 let decoded=u.pathname;
 try{for(let i=0;i<3;i++)decoded=decodeURIComponent(decoded);}catch{return false;}
 if(/(^|[\\/])\.\.?([\\/]|$)/.test(decoded)||decoded.includes("\\")||/%2e|%2f|%5c/i.test(u.pathname))return false;
 return true;
}
/** Pre-send decision for one message_image effect (no request is made unless "send"). */
export type MediaGate={action:"send";url:string}|{action:"hold"}|
 {action:"fail";code:"media_platform_unsupported"|"media_url_invalid"};
export function mediaEffectGate(input:{flagEnabled:boolean;platform:unknown;
 payload:unknown;supabaseUrl?:string|null}):MediaGate{
 // Flag OFF: leave the row untouched (like the other operator gates).
 if(!input.flagEnabled)return {action:"hold"};
 if(input.platform!=="instagram")return {action:"fail",code:"media_platform_unsupported"};
 const p=input.payload as Record<string,unknown>|null;
 const url=p&&typeof p==="object"?p.url:undefined;
 if(!isAllowedFlowImageUrl(url,input.supabaseUrl))return {action:"fail",code:"media_url_invalid"};
 return {action:"send",url:url as string};
}
/**
 * Classification of a failed image send (after reservation). Images are not
 * idempotent: NO outcome here ever leads to a resend.
 *  permanent: Meta 4xx on the attachment/URL (e.g. 400 / error code 100);
 *  auth:      token errors (401/403, code 190), handled like text (uncertain);
 *  uncertain: 5xx, 429, timeouts, network errors, anything unknown.
 */
export type MediaFailure="media_rejected"|"auth"|"uncertain";
export function classifyMediaFailure(err:unknown):MediaFailure{
 const e=err as {status?:unknown;metaCode?:unknown}|null;
 const status=e&&typeof e==="object"&&typeof e.status==="number"?e.status:null;
 const code=e&&typeof e==="object"&&typeof e.metaCode==="number"?e.metaCode:null;
 if(status===null)return "uncertain";
 if(status===401||status===403||code===190)return "auth";
 if(status>=400&&status<500&&status!==408&&status!==429)return "media_rejected";
 return "uncertain";
}
/**
 * flow_finish_outbox_delivery outcome (20261029210000). Only a permanent
 * provider rejection of an IMAGE ("media_rejected") becomes "rejected": the
 * effect ends as dead_letter (never resent, never billed). Everything else
 * keeps the executeOnce status: confirmed stays confirmed, auth / 5xx / 429 /
 * network / unknown stay uncertain (human review, never a blind resend).
 */
export type FinishOutcome="confirmed"|"uncertain"|"rejected";
export function finishOutcome(status:"confirmed"|"uncertain",failure:MediaFailure|null):FinishOutcome{
 return status==="uncertain"&&failure==="media_rejected"?"rejected":status;
}
