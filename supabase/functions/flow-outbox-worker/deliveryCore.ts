import {metaQuickReplies,messengerWebsiteButtons,instagramWebsiteButtons,type QuickOption,type WebOption} from "./flowRichActions.ts";
import {isAllowedFlowImageUrl} from "./mediaPolicy.ts";
import {hasPlaceholder,sanitizePlaceholders,sanitizeLabel,clipChars,clipUtf8Bytes} from "../../../src/flow/placeholders.ts";
// Server-only Meta transport. No browser import and no implicit retry.
export type Provider="facebook"|"instagram"|"whatsapp";
export type ProviderRequest={
 platform:Provider;token:string;externalId:string;recipient:string;text:string;
 quickReplies?:QuickOption[];websiteButtons?:WebOption[];
 /**
  * Instagram image attachment (message_image, FLOW_MEDIA_SEND_ENABLED). When
  * set, text must be "" and no buttons: the body carries ONLY the attachment.
  * `imageHost` = SUPABASE_URL for the allowlist host check.
  */
 imageUrl?:string;imageHost?:string;
 /**
  * Comment automation only (FLOW_COMMENT_AUTOMATION_ENABLED): Instagram /
  * Messenger private reply to this comment id (recipient {comment_id}).
  * Absent: the request is byte-identical to before.
  */
 recipientCommentId?:string;
};
/** Non-2xx provider response; message identical to the previous plain Error. */
export class ProviderHttpError extends Error{
 status:number;metaCode:number|null;
 constructor(status:number,metaCode:number|null=null){
  super("Provider HTTP "+status);this.status=status;this.metaCode=metaCode;
 }
}
export type Sender=(input:ProviderRequest,perform?:typeof fetch)=>Promise<string|null>;
function valid(text:string,max:number){return typeof text==="string"&&text.length>0&&text.length<=max;}
/**
 * The text the customer actually receives for a text request: the single
 * scrub pass used by scrubPlaceholders (sanitize + channel clip). Used both
 * for the provider request and for the stored `messages` body, so the stored
 * text equals the sent text. Without placeholders the input text is returned
 * unchanged. Call it ONCE on the raw text (a second pass is not guaranteed to
 * be a no-op for nested braces such as `{{{{x}}}}`).
 */
export function deliveredText(input:Pick<ProviderRequest,"platform"|"text"|"websiteButtons">):string{
 if(typeof input.text!=="string"||!hasPlaceholder(input.text))return input.text;
 const text=sanitizePlaceholders(input.text);
 return input.websiteButtons?
  clipChars(text,input.platform==="instagram"?640:80):clipUtf8Bytes(text,1000);
}
/**
 * Defense in depth (last step before the request body): effects stored
 * before the planner/V2 fixes may still hold {{...}} placeholders. They are
 * scrubbed with the shared rule (first_name -> FIRST_NAME_FALLBACK, other ->
 * MISSING_VALUE_FALLBACK) in the text, quick-reply titles and website-button
 * titles, then clipped to the channel limit (plain text 1000 UTF-8 bytes,
 * Instagram button text 640, Messenger card title 80, titles 20). Button URLs,
 * image URLs and ids are never touched. Without placeholders the SAME input
 * object is returned (byte-identical request body).
 */
export function scrubPlaceholders(input:ProviderRequest):ProviderRequest{
 if(!input||typeof input!=="object")return input;
 let out=input;
 if(typeof input.text==="string"&&hasPlaceholder(input.text))
  out={...out,text:deliveredText(input)};
 if(Array.isArray(input.quickReplies)&&input.quickReplies.some(o=>hasPlaceholder(o?.label)))
  out={...out,quickReplies:input.quickReplies.map(o=>hasPlaceholder(o?.label)?{...o,label:sanitizeLabel(o.label)}:o)};
 if(Array.isArray(input.websiteButtons)&&input.websiteButtons.some(b=>hasPlaceholder(b?.label)))
  out={...out,websiteButtons:input.websiteButtons.map(b=>hasPlaceholder(b?.label)?{...b,label:sanitizeLabel(b.label)}:b)};
 return out;
}
export async function sendProviderMessage(input:ProviderRequest,perform:typeof fetch=fetch):Promise<string|null>{
 input=scrubPlaceholders(input);
 const image=!!input&&input.imageUrl!==undefined;
 if(!input||!["facebook","instagram","whatsapp"].includes(input.platform)||
  !valid(input.token,4096)||!valid(input.recipient,128)||
  !(image?input.text==="":valid(input.text,4000))||
  !/^[0-9]{1,30}$/.test(input.recipient))
  throw Error("Invalid provider message or account");
 if(image&&(input.platform!=="instagram"||input.quickReplies||input.websiteButtons||
  !isAllowedFlowImageUrl(input.imageUrl,input.imageHost)))
  throw Error("Invalid provider image message");
 const privateReply=input.recipientCommentId!==undefined;
 if(privateReply&&(image||input.platform==="whatsapp"||
  typeof input.recipientCommentId!=="string"||!/^[0-9]{1,32}(_[0-9]{1,32})?$/.test(input.recipientCommentId)))
  throw Error("Invalid private reply");
 let url="",headers:Record<string,string>={"content-type":"application/json"};
 if(input.quickReplies&&input.websiteButtons)throw Error("Mixed rich button formats not supported");
 let payload:Record<string,unknown>={};
 if(input.platform==="whatsapp"){
  if(input.quickReplies||input.websiteButtons)throw Error("WhatsApp rich buttons require separately approved template integration");
  if(!/^[0-9]{5,30}$/.test(input.externalId))throw Error("Missing WhatsApp phone ID");
  url="https://graph.facebook.com/v21.0/"+input.externalId+"/messages";
  headers.authorization="Bearer "+input.token;
  payload={messaging_product:"whatsapp",to:input.recipient,type:"text",text:{body:input.text}};
 }else{
  let message:Record<string,unknown>=image?
   {attachment:{type:"image",payload:{url:input.imageUrl}}}:{text:input.text};
  if(input.quickReplies) message={...message,quick_replies:metaQuickReplies(input.quickReplies,input.platform)};
  if(input.websiteButtons){
   // Instagram: button template (text <= 640, 1..3 web_url buttons).
   if(input.platform==="instagram")message=instagramWebsiteButtons(input.text,input.websiteButtons);
   else if(input.platform!=="facebook")throw Error("Website buttons require Facebook Messenger");
   else message=messengerWebsiteButtons(input.text,input.websiteButtons);
  }
  const envelope=privateReply?{recipient:{comment_id:input.recipientCommentId},message}:
   {recipient:{id:input.recipient},message};
  if(input.platform==="instagram"&&input.token.startsWith("IG")){
   url="https://graph.instagram.com/v21.0/me/messages";
   headers.authorization="Bearer "+input.token;
   payload=envelope;
  }else{
   if(input.platform==="instagram"&&!/^[0-9]{5,30}$/.test(input.externalId))
    throw Error("Invalid Instagram account ID");
   url=input.platform==="instagram"?
    "https://graph.facebook.com/v21.0/"+input.externalId+"/messages":
    "https://graph.facebook.com/v21.0/me/messages";
   // Match live milan-api's existing API payload.
   payload={...envelope,access_token:input.token};
  }
 }
 const res=await perform(url,{method:"POST",headers,body:JSON.stringify(payload),
  signal:AbortSignal.timeout(15000)});
 if(!res.ok){
  if(!image)throw Error("Provider HTTP "+res.status);
  // Image only: keep the Meta error code (e.g. 100 invalid/unfetchable URL).
  const failure:unknown=await res.json().catch(()=>null);
  const err=failure&&typeof failure==="object"?(failure as Record<string,unknown>).error:null;
  const code=err&&typeof err==="object"?(err as Record<string,unknown>).code:null;
  throw new ProviderHttpError(res.status,typeof code==="number"?code:null);
 }
 const data:unknown=await res.json().catch(()=>null);
 if(!data||typeof data!=="object")return null;
 const body=data as Record<string,unknown>;
 const first=Array.isArray(body.messages)?body.messages[0]:null;
 const candidate=input.platform==="whatsapp"&&first&&typeof first==="object"?
  (first as Record<string,unknown>).id:body.message_id??body.id;
 return valid(candidate as string,255)?candidate as string:null;
}
/** v101 field format: enc:v1:iv_hex:tag_hex:ciphertext_hex */
export async function decryptAccountToken(value:string,fieldKey:string):Promise<string>{
 if(!value.startsWith("enc:v1:"))throw Error("Account token is not encrypted");
 if(!fieldKey)throw Error("FIELD_ENCRYPTION_KEY missing");
 const parts=value.split(":");
 if(parts.length!==5||!/^([0-9a-f]{2})+$/i.test(parts[2])||
    !/^([0-9a-f]{2})+$/i.test(parts[3])||
    !/^([0-9a-f]{2})+$/i.test(parts[4])||
    parts[2].length!==24||parts[3].length!==32)throw Error("Invalid encrypted account token");
 const binary=(hex:string)=>Uint8Array.from(hex.match(/../g)!.map(v=>parseInt(v,16)));
 const material=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(fieldKey));
 const aes=await crypto.subtle.importKey("raw",material,{name:"AES-GCM"},false,["decrypt"]);
 const cipher=binary(parts[4]),tag=binary(parts[3]);
 const combined=new Uint8Array(cipher.length+tag.length);
 combined.set(cipher);combined.set(tag,cipher.length);
 const plaintext=await crypto.subtle.decrypt({name:"AES-GCM",iv:binary(parts[2])},
   aes,combined);
 return new TextDecoder().decode(plaintext);
}
export async function encryptMessageBody(value:string,fieldKey:string):Promise<string>{
 if(!fieldKey)throw Error("FIELD_ENCRYPTION_KEY missing");
 const material=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(fieldKey));
 const aes=await crypto.subtle.importKey("raw",material,{name:"AES-GCM"},false,["encrypt"]);
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},aes,new TextEncoder().encode(value)));
 const hex=(b:Uint8Array)=>Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");
 return "enc:v1:"+hex(iv)+":"+hex(encrypted.slice(-16))+":"+hex(encrypted.slice(0,-16));
}
