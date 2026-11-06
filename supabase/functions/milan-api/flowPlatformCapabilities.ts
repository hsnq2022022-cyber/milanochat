/**
 * PURE (no env, no IO). Per-platform representability of a durable flow
 * document for WhatsApp and Facebook Messenger, mirroring the Outbox senders
 * (flow-outbox-worker/multichannelSend.ts) so a graph a platform cannot show
 * is refused up front (V2 fallback) instead of being sent degraded.
 *
 * NOT WIRED into flowDurableIngress.ts yet: the durable SQL chain
 * (automation_flow_canary_accounts CHECK, flow_claim_inbound_durable,
 * flow_begin_durable_run, flow_resume_button_run, outbox lease) is hard-coded
 * to platform 'instagram'. Use together with the generic whitelist once that
 * SQL is generalized. Instagram rules stay in supportedDurableDocument.
 *
 * Note the id mapping: channel_accounts / runs use "facebook", the flow
 * document trigger uses "messenger" (src/flow/model.ts Platform).
 */
export type MultichannelPlatform="whatsapp"|"facebook";
export const DOCUMENT_PLATFORM:Record<MultichannelPlatform,"whatsapp"|"messenger">=
 {whatsapp:"whatsapp",facebook:"messenger"};
export const PLATFORM_LIMITS={
 whatsapp:{replyButtons:3,title:20,websiteButtons:1,textPlain:4096,textWithButtons:1024,textWithWebsite:1024},
 facebook:{replyButtons:13,title:20,websiteButtons:3,textPlain:2000,textWithButtons:2000,textWithWebsite:80}
} as const;
export type CapabilityProblem=
 "document_invalid"|"trigger_platform_mismatch"|"media_unsupported"|"mixed_buttons"|
 "too_many_buttons"|"button_title_invalid"|"website_buttons_invalid"|"text_too_long"|
 "typed_question_unsupported";

type Rec=Record<string,unknown>;
const rec=(v:unknown):v is Rec=>!!v&&typeof v==="object"&&!Array.isArray(v);
const chars=(s:unknown)=>typeof s==="string"?[...s].length:0;
const titleOk=(s:unknown,max:number)=>typeof s==="string"&&s.trim().length>0&&chars(s)<=max;
const isWebsite=(o:Rec)=>o.action==="website";

function optionsProblem(platform:MultichannelPlatform,text:unknown,opts:unknown[]):CapabilityProblem|null{
 const lim=PLATFORM_LIMITS[platform];
 if(opts.length===0)return chars(text)>lim.textPlain?"text_too_long":null;
 if(!opts.every(rec))return "document_invalid";
 const web=(opts as Rec[]).filter(isWebsite).length;
 if(web>0&&web!==opts.length)return "mixed_buttons";
 if(web>0){
  if(web>lim.websiteButtons)return "website_buttons_invalid";
  if(!(opts as Rec[]).every(o=>titleOk(o.label,lim.title)))return "button_title_invalid";
  return chars(text)>lim.textWithWebsite?"text_too_long":null;
 }
 if(opts.length>lim.replyButtons)return "too_many_buttons";
 if(!(opts as Rec[]).every(o=>titleOk(o.label,lim.title)))return "button_title_invalid";
 return chars(text)>lim.textWithButtons?"text_too_long":null;
}

/** null = every node is representable on `platform`. Never throws. */
export function multichannelCapabilityProblem(raw:unknown,platform:MultichannelPlatform):
 CapabilityProblem|null{
 if(platform!=="whatsapp"&&platform!=="facebook")return "document_invalid";
 if(!rec(raw)||!Array.isArray(raw.nodes))return "document_invalid";
 for(const n of raw.nodes as unknown[]){
  if(!rec(n)||!rec(n.data))return "document_invalid";
  const d=n.data;
  if(d.kind==="trigger"&&d.platform!==DOCUMENT_PLATFORM[platform])return "trigger_platform_mismatch";
  if(d.kind==="message"){
   if(!(d.image===""||d.image===undefined)||
      (Array.isArray(d.contentBlocks)&&d.contentBlocks.length>0))return "media_unsupported";
   const p=optionsProblem(platform,d.text,Array.isArray(d.options)?d.options:[]);
   if(p)return p;
  }
  if(d.kind==="question"){
   // The worker sends plain (typed-answer) questions on Instagram only.
   if(d.inputMode!=="buttons")return "typed_question_unsupported";
   const opts=Array.isArray(d.options)?d.options:[];
   if(opts.some(o=>rec(o)&&isWebsite(o)))return "mixed_buttons";
   const p=optionsProblem(platform,d.text,opts);
   if(p)return p;
  }
 }
 return null;
}
