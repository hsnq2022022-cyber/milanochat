/**
 * PURE (no env, no Deno, no IO). Converts a SIGNED WhatsApp Cloud API or
 * Facebook Messenger webhook body into inbound customer messages, in the same
 * shape the Instagram path extracts (extractIgMessages in index.ts: sender,
 * recipient, text, provider message id, flow-choice id) plus platform, account
 * external id, timestamp and kind.
 *
 * NOT an authorization boundary: call it only AFTER X-Hub-Signature-256
 * verification. Tenant/account resolution stays with the caller, by
 * (platform, accountExternalId) exactly like Instagram.
 *
 * Never throws on malformed shapes: anything unexpected yields no message.
 * Ignored on purpose (never customer messages): WhatsApp statuses[] (sent /
 * delivered / read / failed), errors[], non-text media (image, audio, video,
 * document, sticker, location, contacts, reaction, unsupported...); Messenger
 * is_echo, delivery, read, reaction, referral, optin, standby[] and
 * handover (pass/take/request_thread_control) events, attachment-only messages.
 */
export type MetaInboundPlatform="whatsapp"|"facebook";
export type MetaInboundKind="text"|"button_reply"|"list_reply"|"quick_reply"|"postback";
export type NormalizedInboundMessage={
 platform:MetaInboundPlatform;
 /** WhatsApp metadata.phone_number_id; Facebook Page id (entry.id). */
 accountExternalId:string;
 /** WhatsApp wa_id (message.from); Facebook PSID (sender.id). */
 senderId:string;
 /** WhatsApp phone_number_id; Facebook recipient.id (the Page). */
 recipientId:string;
 text:string;
 /** wamid / mid exactly as Meta sent it; null when absent (never synthesized). */
 providerMessageId:string|null;
 /** Milliseconds since epoch (WhatsApp seconds string * 1000, Facebook ms). */
 timestampMs:number|null;
 /** Flow button id when the tap payload is "flow-choice:<safe id>", else null. */
 choiceId:string|null;
 kind:MetaInboundKind;
 /** WhatsApp contacts[].profile.name for this sender, else null. */
 senderName:string|null;
};

/** Upper bound of messages returned from one POST (defensive). */
export const MAX_NORMALIZED_MESSAGES=500;
const MAX_TEXT_CHARS=4096;

type Rec=Record<string,unknown>;
const rec=(v:unknown):v is Rec=>!!v&&typeof v==="object"&&!Array.isArray(v);
const arr=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const str=(v:unknown):string=>typeof v==="string"?v:"";
/** Meta ids are numeric strings; numbers are accepted when they are safe integers. */
const metaId=(v:unknown):string=>{
 if(typeof v==="number"&&Number.isSafeInteger(v)&&v>0)return String(v);
 return typeof v==="string"&&/^[0-9]{1,30}$/.test(v)?v:"";
};
const providerId=(v:unknown):string|null=>
 typeof v==="string"&&v.length>=1&&v.length<=256?v:null;
const textOk=(t:string)=>t.trim().length>0&&t.length<=MAX_TEXT_CHARS;
/** Same rule as flowDurableIngress.selectedFlowChoice. */
export function flowChoiceFromPayload(payload:unknown):string|null{
 if(typeof payload!=="string"||!payload.startsWith("flow-choice:"))return null;
 const id=payload.slice("flow-choice:".length);
 return /^[a-zA-Z0-9_-]{1,128}$/.test(id)?id:null;
}
const secondsToMs=(v:unknown):number|null=>{
 const s=typeof v==="number"?String(v):v;
 if(typeof s!=="string"||!/^[0-9]{1,12}$/.test(s))return null;
 const ms=Number(s)*1000;
 return Number.isSafeInteger(ms)?ms:null;
};
const msTimestamp=(v:unknown):number|null=>
 typeof v==="number"&&Number.isSafeInteger(v)&&v>0?v:null;

function whatsappMessage(message:unknown,phoneId:string,names:Map<string,string>):
 NormalizedInboundMessage|null{
 if(!rec(message))return null;
 const senderId=metaId(message.from);
 if(!senderId)return null;
 let text="",kind:MetaInboundKind="text",choiceId:string|null=null;
 if(message.type==="text"&&rec(message.text)){
  text=str(message.text.body);
 }else if(message.type==="interactive"&&rec(message.interactive)){
  const it=message.interactive;
  const reply=it.type==="button_reply"?it.button_reply:it.type==="list_reply"?it.list_reply:null;
  if(!rec(reply))return null;
  kind=it.type==="button_reply"?"button_reply":"list_reply";
  text=str(reply.title);
  choiceId=flowChoiceFromPayload(reply.id);
 }else if(message.type==="button"&&rec(message.button)){
  // Template quick-reply button: modelled like an interactive button reply.
  kind="button_reply";
  text=str(message.button.text);
  choiceId=flowChoiceFromPayload(message.button.payload);
 }else{
  return null; // media, location, reaction, system, unsupported ...
 }
 if(!textOk(text))return null;
 return {platform:"whatsapp",accountExternalId:phoneId,senderId,recipientId:phoneId,text,
  providerMessageId:providerId(message.id),timestampMs:secondsToMs(message.timestamp),
  choiceId,kind,senderName:names.get(senderId)??null};
}

function normalizeWhatsApp(body:Rec):NormalizedInboundMessage[]{
 const out:NormalizedInboundMessage[]=[];
 for(const entry of arr(body.entry)){
  if(!rec(entry))continue;
  for(const change of arr(entry.changes)){
   if(!rec(change)||change.field!=="messages"||!rec(change.value))continue;
   const value=change.value;
   // statuses[] / errors[] are delivery receipts, never customer messages.
   const phoneId=rec(value.metadata)?metaId(value.metadata.phone_number_id):"";
   if(!phoneId)continue;
   const names=new Map<string,string>();
   for(const c of arr(value.contacts)){
    if(!rec(c))continue;
    const waId=metaId(c.wa_id),name=rec(c.profile)?str(c.profile.name).trim():"";
    if(waId&&name&&name.length<=256&&!names.has(waId))names.set(waId,name);
   }
   for(const message of arr(value.messages)){
    const m=whatsappMessage(message,phoneId,names);
    if(m)out.push(m);
    if(out.length>=MAX_NORMALIZED_MESSAGES)return out;
   }
  }
 }
 return out;
}

function facebookEvent(ev:unknown,pageId:string):NormalizedInboundMessage|null{
 if(!rec(ev))return null;
 const senderId=rec(ev.sender)?metaId(ev.sender.id):"";
 const recipientId=rec(ev.recipient)?metaId(ev.recipient.id):"";
 const accountExternalId=pageId||recipientId;
 // A message sent BY the page to itself is never a customer message.
 if(!senderId||!accountExternalId||senderId===accountExternalId)return null;
 const timestampMs=msTimestamp(ev.timestamp);
 if(rec(ev.message)){
  const m=ev.message;
  if(m.is_echo===true)return null;
  const text=str(m.text);
  if(!textOk(text))return null; // attachment-only / sticker / empty
  const quick=rec(m.quick_reply)?m.quick_reply:null;
  return {platform:"facebook",accountExternalId,senderId,recipientId,text,
   providerMessageId:providerId(m.mid),timestampMs,
   choiceId:quick?flowChoiceFromPayload(quick.payload):null,
   kind:quick?"quick_reply":"text",senderName:null};
 }
 if(rec(ev.postback)){
  const p=ev.postback;
  const text=str(p.title);
  if(!textOk(text))return null;
  return {platform:"facebook",accountExternalId,senderId,recipientId,text,
   providerMessageId:providerId(p.mid),timestampMs,
   choiceId:flowChoiceFromPayload(p.payload),kind:"postback",senderName:null};
 }
 // delivery, read, reaction, referral, optin, handover/thread control, ...
 return null;
}

function normalizeFacebook(body:Rec):NormalizedInboundMessage[]{
 const out:NormalizedInboundMessage[]=[];
 for(const entry of arr(body.entry)){
  if(!rec(entry))continue;
  const pageId=metaId(entry.id);
  // entry.standby[] (secondary receiver under handover) is never processed.
  for(const ev of arr(entry.messaging)){
   const m=facebookEvent(ev,pageId);
   if(m)out.push(m);
   if(out.length>=MAX_NORMALIZED_MESSAGES)return out;
  }
 }
 return out;
}

/**
 * object "whatsapp_business_account" -> WhatsApp, object "page" -> Facebook
 * Messenger; anything else (including "instagram") -> []. Never throws.
 */
export function normalizeMetaMessages(body:unknown):NormalizedInboundMessage[]{
 try{
  if(!rec(body))return [];
  if(body.object==="whatsapp_business_account")return normalizeWhatsApp(body);
  if(body.object==="page")return normalizeFacebook(body);
  return [];
 }catch{
  return [];
 }
}
