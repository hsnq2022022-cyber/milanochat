/**
 * Server-only WhatsApp Cloud API and Facebook Messenger senders for the
 * Outbox worker, used ONLY while FLOW_MULTICHANNEL_ENABLED is on (index.ts).
 * The Instagram path (deliveryCore.sendProviderMessage) is not used or changed.
 *
 * Payload builders are pure (no IO): a request that cannot be represented on
 * the platform is refused with a stable code and NO request is made (never
 * silently trimmed or degraded). Placeholders are scrubbed with the shared
 * scrubPlaceholders pass first, so the stored body (deliveredText) equals the
 * sent text. No implicit retry: any failed send is classified, never resent.
 */
import {scrubPlaceholders,ProviderHttpError,type ProviderRequest} from "./deliveryCore.ts";
import {metaQuickReplies,messengerWebsiteButtons} from "./flowRichActions.ts";

/**
 * Same Graph version as every other worker call (deliveryCore.ts uses v21.0).
 * Kept identical on purpose for consistency (the brief mentioned v19.0).
 */
export const GRAPH_VERSION="v21.0";
const GRAPH="https://graph.facebook.com/"+GRAPH_VERSION;

export const WA_TEXT_MAX=4096,WA_BODY_MAX=1024,WA_BUTTONS_MAX=3,WA_BUTTON_TITLE_MAX=20,
 WA_CTA_DISPLAY_MAX=20,WA_URL_MAX=2000;
export const FB_TEXT_MAX=2000;
/** Meta error code: free-form message outside the 24h customer-service window. */
export const WA_OUTSIDE_WINDOW_CODE=131047;

export type MultichannelProblem=
 "mc_platform_invalid"|"mc_request_invalid"|"mc_image_unsupported"|
 "wa_phone_id_invalid"|"wa_text_invalid"|"wa_text_too_long"|"wa_body_too_long"|
 "wa_mixed_buttons"|"wa_too_many_buttons"|"wa_button_title_invalid"|"wa_button_id_invalid"|
 "wa_button_duplicate"|"wa_cta_url_single_only"|"wa_cta_display_text_invalid"|"wa_cta_url_invalid"|
 "fb_text_invalid"|"fb_text_too_long"|"fb_mixed_buttons"|"fb_quick_replies_invalid"|
 "fb_website_buttons_invalid";
export type BuiltRequest={url:string;headers:Record<string,string>;payload:Record<string,unknown>};
export type BuildResult={ok:true;request:BuiltRequest}|{ok:false;code:MultichannelProblem};

/** Not representable: thrown BEFORE any request (the worker checks earlier, before reserving). */
export class MultichannelPayloadError extends Error{
 code:MultichannelProblem;
 constructor(code:MultichannelProblem){super("Multichannel payload refused: "+code);this.code=code;}
}

const CONTROL=/[\u0000-\u001F\u007F-\u009F]/;
const chars=(s:string)=>[...s].length;
const nonEmpty=(s:unknown):s is string=>typeof s==="string"&&s.trim().length>0;
const safeId=(s:unknown):s is string=>typeof s==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(s);
const titleOk=(s:unknown,max:number):s is string=>nonEmpty(s)&&chars(s)<=max&&!CONTROL.test(s);
function httpsUrl(raw:unknown):string|null{
 if(typeof raw!=="string"||!raw||raw.length>WA_URL_MAX||/\s/.test(raw))return null;
 let u:URL;
 try{u=new URL(raw);}catch{return null;}
 if(u.protocol!=="https:"||u.username||u.password||!u.hostname||
    ["localhost","127.0.0.1","[::1]","::1"].includes(u.hostname))return null;
 return u.href;
}
const baseOk=(i:ProviderRequest)=>!!i&&typeof i==="object"&&
 typeof i.token==="string"&&i.token.length>=1&&i.token.length<=4096&&
 typeof i.recipient==="string"&&/^[0-9]{1,30}$/.test(i.recipient)&&
 typeof i.text==="string";

/**
 * WhatsApp Cloud API body:
 *  text:     {messaging_product,recipient_type,to,type:"text",text:{body}}      body <= 4096
 *  buttons:  type:"interactive", interactive:{type:"button",body:{text},
 *            action:{buttons:[{type:"reply",reply:{id:"flow-choice:<id>",title}}]}}
 *            1..3 buttons, title <= 20 (unique), body <= 1024
 *  cta_url:  type:"interactive", interactive:{type:"cta_url",body:{text},
 *            action:{name:"cta_url",parameters:{display_text,url}}}
 *            exactly ONE website button, display_text <= 20, https url, body <= 1024
 */
export function buildWhatsAppRequest(raw:ProviderRequest):BuildResult{
 if(!raw||raw.platform!=="whatsapp")return {ok:false,code:"mc_platform_invalid"};
 if(raw.imageUrl!==undefined)return {ok:false,code:"mc_image_unsupported"};
 const input=scrubPlaceholders(raw);
 if(!baseOk(input))return {ok:false,code:"mc_request_invalid"};
 if(typeof input.externalId!=="string"||!/^[0-9]{5,30}$/.test(input.externalId))
  return {ok:false,code:"wa_phone_id_invalid"};
 const text=input.text;
 if(!nonEmpty(text))return {ok:false,code:"wa_text_invalid"};
 const replies=input.quickReplies,sites=input.websiteButtons;
 if(replies!==undefined&&sites!==undefined)return {ok:false,code:"wa_mixed_buttons"};
 const head={messaging_product:"whatsapp",recipient_type:"individual",to:input.recipient};
 let payload:Record<string,unknown>;
 if(replies!==undefined){
  if(!Array.isArray(replies)||replies.length<1)return {ok:false,code:"wa_button_id_invalid"};
  if(replies.length>WA_BUTTONS_MAX)return {ok:false,code:"wa_too_many_buttons"};
  if(chars(text)>WA_BODY_MAX)return {ok:false,code:"wa_body_too_long"};
  const ids=new Set<string>(),titles=new Set<string>();
  const buttons=[];
  for(const o of replies){
   if(!o||!safeId(o.id))return {ok:false,code:"wa_button_id_invalid"};
   if(!titleOk(o.label,WA_BUTTON_TITLE_MAX))return {ok:false,code:"wa_button_title_invalid"};
   if(ids.has(o.id)||titles.has(o.label))return {ok:false,code:"wa_button_duplicate"};
   ids.add(o.id);titles.add(o.label);
   buttons.push({type:"reply",reply:{id:"flow-choice:"+o.id,title:o.label}});
  }
  payload={...head,type:"interactive",interactive:{type:"button",body:{text},action:{buttons}}};
 }else if(sites!==undefined){
  if(!Array.isArray(sites)||sites.length!==1)return {ok:false,code:"wa_cta_url_single_only"};
  if(chars(text)>WA_BODY_MAX)return {ok:false,code:"wa_body_too_long"};
  const b=sites[0];
  if(!b||!titleOk(b.label,WA_CTA_DISPLAY_MAX))return {ok:false,code:"wa_cta_display_text_invalid"};
  const url=httpsUrl(b.url);
  if(!url)return {ok:false,code:"wa_cta_url_invalid"};
  payload={...head,type:"interactive",interactive:{type:"cta_url",body:{text},
   action:{name:"cta_url",parameters:{display_text:b.label,url}}}};
 }else{
  if(chars(text)>WA_TEXT_MAX)return {ok:false,code:"wa_text_too_long"};
  payload={...head,type:"text",text:{body:text}};
 }
 return {ok:true,request:{url:GRAPH+"/"+input.externalId+"/messages",
  headers:{"content-type":"application/json",authorization:"Bearer "+input.token},payload}};
}

/**
 * Facebook Messenger Send API body:
 *  {recipient:{id},messaging_type:"RESPONSE",message:{text}}                  text <= 2000
 *  + quick_replies:[{content_type:"text",title,payload:"flow-choice:<id>"}]    1..13, title <= 20
 *  website buttons: message = existing generic template (messengerWebsiteButtons:
 *  1..3 web_url buttons, title <= 20, card title <= 80). Never mixed.
 * Token in the Authorization header (never in the URL or body).
 */
export function buildFacebookRequest(raw:ProviderRequest):BuildResult{
 if(!raw||raw.platform!=="facebook")return {ok:false,code:"mc_platform_invalid"};
 if(raw.imageUrl!==undefined)return {ok:false,code:"mc_image_unsupported"};
 const input=scrubPlaceholders(raw);
 if(!baseOk(input))return {ok:false,code:"mc_request_invalid"};
 const text=input.text;
 if(!nonEmpty(text))return {ok:false,code:"fb_text_invalid"};
 if(chars(text)>FB_TEXT_MAX)return {ok:false,code:"fb_text_too_long"};
 const replies=input.quickReplies,sites=input.websiteButtons;
 if(replies!==undefined&&sites!==undefined)return {ok:false,code:"fb_mixed_buttons"};
 let message:Record<string,unknown>={text};
 try{
  if(replies!==undefined)message={text,quick_replies:metaQuickReplies(replies,"facebook")};
 }catch{return {ok:false,code:"fb_quick_replies_invalid"};}
 try{
  if(sites!==undefined)message=messengerWebsiteButtons(text,sites);
 }catch{return {ok:false,code:"fb_website_buttons_invalid"};}
 return {ok:true,request:{url:GRAPH+"/me/messages",
  headers:{"content-type":"application/json",authorization:"Bearer "+input.token},
  payload:{recipient:{id:input.recipient},messaging_type:"RESPONSE",message}}};
}

/** Pre-reservation check used by the worker: null = representable. */
export function multichannelPayloadProblem(input:ProviderRequest):MultichannelProblem|null{
 const built=input?.platform==="whatsapp"?buildWhatsAppRequest(input):
  input?.platform==="facebook"?buildFacebookRequest(input):null;
 if(!built)return "mc_platform_invalid";
 return built.ok?null:built.code;
}

async function perform(built:BuildResult,platform:"whatsapp"|"facebook",
 fetcher:typeof fetch):Promise<string|null>{
 if(!built.ok)throw new MultichannelPayloadError(built.code);
 const {url,headers,payload}=built.request;
 const res=await fetcher(url,{method:"POST",headers,body:JSON.stringify(payload),
  signal:AbortSignal.timeout(15000)});
 if(!res.ok){
  // Keep the Meta error code (e.g. 131047) for classification; never the body.
  const failure:unknown=await res.json().catch(()=>null);
  const err=failure&&typeof failure==="object"?(failure as Record<string,unknown>).error:null;
  const code=err&&typeof err==="object"?(err as Record<string,unknown>).code:null;
  throw new ProviderHttpError(res.status,typeof code==="number"?code:null);
 }
 const data:unknown=await res.json().catch(()=>null);
 if(!data||typeof data!=="object")return null;
 const body=data as Record<string,unknown>;
 const first=Array.isArray(body.messages)?body.messages[0]:null;
 const candidate=platform==="whatsapp"?
  (first&&typeof first==="object"?(first as Record<string,unknown>).id:null):body.message_id;
 return typeof candidate==="string"&&candidate.length>0&&candidate.length<=255?candidate:null;
}
export function sendWhatsAppMessage(input:ProviderRequest,fetcher:typeof fetch=fetch):Promise<string|null>{
 return perform(buildWhatsAppRequest(input),"whatsapp",fetcher);
}
export function sendFacebookMessage(input:ProviderRequest,fetcher:typeof fetch=fetch):Promise<string|null>{
 return perform(buildFacebookRequest(input),"facebook",fetcher);
}
export function sendMultichannelMessage(input:ProviderRequest,fetcher:typeof fetch=fetch):Promise<string|null>{
 if(input?.platform==="whatsapp")return sendWhatsAppMessage(input,fetcher);
 if(input?.platform==="facebook")return sendFacebookMessage(input,fetcher);
 return Promise.reject(new MultichannelPayloadError("mc_platform_invalid"));
}

/**
 * Failure classification after a reserved send (reported in the tick outcome).
 * NONE of these leads to a resend; the delivery is finished 'uncertain'
 * (flow_finish_outbox_delivery 'rejected' is image-only in SQL).
 *  wa_outside_service_window: Meta 131047 (free-form outside the 24h window), permanent;
 *  provider_rejected:         other 4xx (not 408/429), permanent;
 *  auth:                      401/403 or code 190;
 *  payload_refused:           refused before the request (no request made);
 *  uncertain:                 5xx, 408, 429, timeout, network, unknown.
 */
export type MultichannelFailure="wa_outside_service_window"|"provider_rejected"|"auth"|
 "payload_refused"|"uncertain";
export function classifyMultichannelFailure(err:unknown):MultichannelFailure{
 if(err instanceof MultichannelPayloadError)return "payload_refused";
 const e=err as {status?:unknown;metaCode?:unknown}|null;
 const status=e&&typeof e==="object"&&typeof e.status==="number"?e.status:null;
 const code=e&&typeof e==="object"&&typeof e.metaCode==="number"?e.metaCode:null;
 if(status===null)return "uncertain";
 if(code===WA_OUTSIDE_WINDOW_CODE&&status>=400&&status<500)return "wa_outside_service_window";
 if(status===401||status===403||code===190)return "auth";
 if(status>=400&&status<500&&status!==408&&status!==429)return "provider_rejected";
 return "uncertain";
}
