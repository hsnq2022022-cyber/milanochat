import type {FlowDocument,Platform,TriggerMode} from "./model";

/**
 * Pure, untrusted event routing proposal for stage 9.
 * It NEVER receives a raw Meta webhook, validates a signature, sends a message,
 * or activates a flow. A future trusted backend must authenticate webhooks,
 * resolve the tenant from the connected Meta account, and enforce idempotency.
 */
export type NormalizedInboundEvent={
  tenantId:string;
  accountId:string;
  eventId:string;
  platform:Platform;
  mode:TriggerMode;
  senderId:string;
  text:string;
  isEcho?:boolean;
};

export type EnabledFlow={
  id:string;
  tenantId:string;
  accountId:string;
  enabled:boolean;
  document:FlowDocument;
};

export type EventMatch={
  flowId:string;
  triggerNodeId:string;
  idempotencyKey:string;
};

const MAX_TEXT=8192;
const MAX_KEYWORDS=40;
const MAX_KEYWORD_LENGTH=120;

export function normalizeTriggerText(raw:string):string{
  return raw.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[\u064B-\u065F\u0670\u0640]/g,"")
    .replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي")
    .replace(/\s+/g," ").trim();
}

export function parseTriggerKeywords(raw:string):string[]{
  return [...new Set(raw.split(/[,،\n]/).map(normalizeTriggerText)
    .filter(s=>s.length>0&&s.length<=MAX_KEYWORD_LENGTH))].slice(0,MAX_KEYWORDS);
}

function validIdentity(s:string):boolean {
  return s.length>0&&s.length<=256&&s.trim()===s&&!/[\u0000-\u001F]/.test(s);
}

/**
 * The caller must supply only server-verified tenant/account ownership and
 * deduplicated inbound events. This function deliberately rejects unsupported
 * modes instead of guessing how ad, live, story or referral payloads behave.
 */
export function matchInboundEvent(
  event:NormalizedInboundEvent,
  flows:readonly EnabledFlow[]
):EventMatch[] {
  if(event.isEcho||!validIdentity(event.tenantId)||!validIdentity(event.accountId)
    ||!validIdentity(event.eventId)||!validIdentity(event.senderId)
    ||!["instagram","messenger","whatsapp"].includes(event.platform)
    ||!["message","keyword","comment"].includes(event.mode)
    ||typeof event.text!=="string"||event.text.length>MAX_TEXT)return [];
  // Meta permissions, webhook event support, and subscription state must be
  // checked by the trusted adapter. This layer only matches known modes.
  if(event.platform==="whatsapp"&&event.mode==="comment")return [];
  const text=normalizeTriggerText(event.text);
  const matches:EventMatch[]=[];
  for(const flow of flows){
    if(!flow.enabled||flow.tenantId!==event.tenantId||flow.accountId!==event.accountId
      ||!validIdentity(flow.id)||flow.document?.version!==3)continue;
    const triggers=flow.document.nodes.filter(n=>n.data.kind==="trigger");
    if(triggers.length!==1)continue;
    const trigger=triggers[0],data=trigger.data;
    if(data.platform!==event.platform)continue;
    if(!["message","keyword","comment"].includes(data.triggerMode))continue;
    // "message" matches all direct messages. "keyword" matches direct messages
    // containing configured terms. Comment keywords are optional.
    if(data.triggerMode==="message"&&event.mode!=="message")continue;
    if(data.triggerMode==="keyword"&&event.mode!=="keyword"&&event.mode!=="message")continue;
    if(data.triggerMode==="comment"&&event.mode!=="comment")continue;
    const keywords=parseTriggerKeywords(data.keywords||"");
    if(data.triggerMode==="keyword"&&!keywords.length)continue;
    if((data.triggerMode==="keyword"||data.triggerMode==="comment")&&keywords.length
      &&!keywords.some(word=>text.includes(word)))continue;
    // Do not construct this key from message text or timestamps. It must
    // identify the exact event and flow within one verified account.
    matches.push({
      flowId:flow.id,
      triggerNodeId:trigger.id,
      idempotencyKey:JSON.stringify([event.tenantId,event.platform,event.accountId,event.eventId,flow.id])
    });
  }
  return matches;
}
