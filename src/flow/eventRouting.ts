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

/**
 * Same single inbound text cap as the server (triggerKeywords.ts
 * MAX_INBOUND_TEXT = normalizeMetaMessage.ts MAX_TEXT_CHARS); parity-tested.
 */
export const MAX_TEXT=4096;
const MAX_KEYWORDS=40;
const MAX_KEYWORD_LENGTH=120;
/** Invisible formatting characters removed before matching (identical to triggerKeywords.ts HIDDEN_FORMAT_CHARS). */
export const HIDDEN_FORMAT_CHARS=/[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export function normalizeTriggerText(raw:string):string{
  return raw.replace(HIDDEN_FORMAT_CHARS,"").normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[\u064B-\u065F\u0670\u0640]/g,"")
    .replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي")
    .replace(/\s+/g," ").trim();
}

export function parseTriggerKeywords(raw:string):string[]{
  return [...new Set(raw.split(/[,،\n]/).map(normalizeTriggerText)
    .filter(s=>s.length>0&&s.length<=MAX_KEYWORD_LENGTH))].slice(0,MAX_KEYWORDS);
}

export type KeywordListProblem="keyword_trigger_requires_keywords"|"keyword_trigger_too_many_keywords"|"keyword_trigger_keyword_too_long";
/**
 * Explicit list validation, identical to triggerKeywords.ts keywordListProblem:
 * after splitting, normalizing, dropping blanks and de-duplicating, a keyword
 * over 120 characters or more than 40 keywords is REJECTED (never truncated).
 */
export function keywordListProblem(raw:unknown):KeywordListProblem|null{
  const items=typeof raw==="string"?raw.split(/[,،\n]/).map(normalizeTriggerText):[];
  const kept=[...new Set(items.filter(s=>s.length>0))];
  if(kept.some(k=>k.length>MAX_KEYWORD_LENGTH))return "keyword_trigger_keyword_too_long";
  if(kept.length>MAX_KEYWORDS)return "keyword_trigger_too_many_keywords";
  return kept.length===0?"keyword_trigger_requires_keywords":null;
}
export type KeywordMatchMode="contains"|"exact";
const LEGACY_CONTAINS=["contains","equals","not_equals","exists"];
/**
 * Keyword trigger match mode (identical to the server copy
 * supabase/functions/milan-api/triggerKeywords.ts keywordMatchMode):
 * "exact" = whole normalized message; "contains" = whole token / contiguous
 * phrase. Legacy operator values (missing, contains, equals, not_equals,
 * exists: the condition default a trigger used to carry) -> "contains".
 * Anything else -> null (invalid, never matches).
 */
export function keywordMatchMode(operator:unknown):KeywordMatchMode|null{
  if(operator===undefined||operator===null)return "contains";
  if(operator==="exact")return "exact";
  return typeof operator==="string"&&LEGACY_CONTAINS.includes(operator)?"contains":null;
}
const WORD=/[\p{L}\p{N}\p{M}]/u;
function charBefore(s:string,i:number):string{
  if(i<=0)return "";
  const low=s.charCodeAt(i-1);
  if(low>=0xdc00&&low<=0xdfff&&i>=2){
    const high=s.charCodeAt(i-2);
    if(high>=0xd800&&high<=0xdbff)return s.slice(i-2,i);
  }
  return s[i-1];
}
function charAt(s:string,i:number):string{
  if(i>=s.length)return "";
  const cp=s.codePointAt(i);
  return cp===undefined?"":String.fromCodePoint(cp);
}
const boundary=(c:string)=>c===""||!WORD.test(c);
/**
 * On ALREADY NORMALIZED text/keyword. "exact": equality. "contains": an
 * occurrence whose neighbours are text start/end or a character that is not
 * a Unicode letter, number or combining mark. indexOf scanning only: never a
 * RegExp built from the keyword (metacharacters are literal).
 */
export function keywordMatchesText(text:string,keyword:string,mode:KeywordMatchMode):boolean{
  if(!keyword)return false;
  if(mode==="exact")return text===keyword;
  let from=0;
  while(from<=text.length-keyword.length){
    const i=text.indexOf(keyword,from);
    if(i<0)return false;
    if(boundary(charBefore(text,i))&&boundary(charAt(text,i+keyword.length)))return true;
    from=i+1;
  }
  return false;
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
    if(data.triggerMode==="keyword"){
      // Token-aware "contains" or whole-message "exact" (server: triggerKeywords.ts).
      const mode=keywordMatchMode(data.operator);
      if(!mode||keywordListProblem(data.keywords||"")!==null||
        !keywords.some(word=>keywordMatchesText(text,word,mode)))continue;
    }
    // Comment keywords: unchanged substring rule (server: commentTrigger.ts).
    if(data.triggerMode==="comment"&&keywords.length
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


export type ExclusiveEventRoute =
  | {status:"none";match:null}
  | {status:"ambiguous";match:null;candidateCount:number}
  | {status:"match";match:EventMatch};

/**
 * لا تشغّل أكثر من تدفق لنفس رسالة العميل.
 * تعدد القواعد المتطابقة يعني إعداداً ملتبساً: أوقف الرد بدلاً من إرساله مرتين.
 */
export function resolveExclusiveEventRoute(
  event:NormalizedInboundEvent,flows:readonly EnabledFlow[]
):ExclusiveEventRoute {
  const matches=matchInboundEvent(event,flows);
  if(matches.length===0)return {status:"none",match:null};
  if(matches.length!==1)return {status:"ambiguous",match:null,candidateCount:matches.length};
  return {status:"match",match:matches[0]};
}
