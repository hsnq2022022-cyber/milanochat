/**
 * PURE (no env, no Deno, no IO, no imports). Server-side DM keyword trigger
 * matcher for the Edge Functions (milan-api V2 + durable ingress + inbound
 * selection, flow-publication publish/activate checks).
 *
 * Semantics are IDENTICAL to src/flow/eventRouting.ts (normalizeTriggerText,
 * parseTriggerKeywords, keywordMatchMode, keywordMatchesText and the keyword
 * branch of matchInboundEvent) for the same inputs; tests/flow-keyword-trigger.test.ts
 * runs one shared input table through both copies so they cannot drift. A
 * separate copy (like commentTrigger.ts normalizeCommentText) keeps this
 * module free of the extensionless type import in eventRouting.ts.
 *
 * Normalization (exactly eventRouting.ts): remove invisible formatting
 * characters (HIDDEN_FORMAT_CHARS), NFKC, toLocaleLowerCase("en-US"),
 * remove Arabic tashkeel U+064B..U+065F, superscript alef U+0670 and tatweel
 * U+0640, fold أ إ آ ٱ -> ا and ى -> ي, collapse whitespace, trim.
 * Deliberately NOT done: no ة/ه folding, no ؤ/ئ folding, no digit folding, no
 * morphological folding (Arabic prefixes such as ال / و / ب / ل stay part of
 * the word), no stemming, no singular/plural folding. Customers add word
 * variants as extra keywords.
 *
 * Match modes (the keyword trigger's `operator`):
 *  - "exact":    the normalized WHOLE message equals a normalized keyword/phrase.
 *  - "contains": a normalized keyword/phrase occurs in the normalized message
 *                as a complete token or contiguous phrase: the character
 *                before and after the occurrence is the start/end of the text
 *                or NOT a Unicode letter, number or combining mark
 *                (\p{L}\p{N}\p{M}). "tod" matches "TOD 5", "(TOD)", "tod!"
 *                but NOT "today". Found with indexOf + boundary checks; no
 *                RegExp is ever built from a keyword, so metacharacters are
 *                literal.
 * Legacy operator values (documents saved before the mode existed: the
 * trigger carried the condition-node default) map deterministically to
 * "contains" (the behaviour they always had): missing, "contains", "equals",
 * "not_equals", "exists". Any other value is INVALID: never matches, refused
 * at publish/activate (keywordTriggerProblem).
 * An empty or all-blank keyword list NEVER matches. The stored keyword string
 * is never mutated.
 */
export const MAX_TRIGGER_KEYWORDS=40;
export const MAX_TRIGGER_KEYWORD_LENGTH=120;
/**
 * ONE inbound text cap (characters, String.length) for flow selection,
 * keyword matching, the V2 runtime (flowPrepareMessage.ts) and the Meta
 * ingress normalizer (normalizeMetaMessage.ts); src/flow/eventRouting.ts
 * MAX_TEXT holds the same value (parity-tested). Text longer than this is
 * never matched or answered by a flow (the AI path is unchanged).
 */
export const MAX_INBOUND_TEXT=4096;
export const MAX_TRIGGER_TEXT=MAX_INBOUND_TEXT;
/**
 * Invisible formatting characters REMOVED before matching (text and
 * keywords): soft hyphen U+00AD, Arabic letter mark U+061C, zero-width
 * space/non-joiner/joiner and LRM/RLM U+200B..U+200F, bidi embeddings and
 * overrides U+202A..U+202E, word joiner and invisible operators
 * U+2060..U+2064, bidi isolates U+2066..U+2069, BOM/ZWNBSP U+FEFF.
 * They can neither create an artificial word boundary nor hide a keyword.
 */
export const HIDDEN_FORMAT_CHARS=/[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
export type KeywordMatchMode="contains"|"exact";
const LEGACY_CONTAINS=["contains","equals","not_equals","exists"];

/** Same transformation as eventRouting.ts normalizeTriggerText; non-strings -> "". */
export function normalizeTriggerText(raw:unknown):string{
 if(typeof raw!=="string")return "";
 return raw.replace(HIDDEN_FORMAT_CHARS,"").normalize("NFKC").toLocaleLowerCase("en-US")
  .replace(/[ً-ٰٟـ]/g,"")
  .replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي")
  .replace(/\s+/g," ").trim();
}

/**
 * Same as eventRouting.ts parseTriggerKeywords: split on comma, Arabic comma
 * and newline, normalize, drop empties and keywords above 120 characters,
 * de-duplicate, keep at most 40. Non-strings -> [].
 */
export function parseTriggerKeywords(raw:unknown):string[]{
 if(typeof raw!=="string")return [];
 return [...new Set(raw.split(/[,،\n]/).map(normalizeTriggerText)
  .filter(s=>s.length>0&&s.length<=MAX_TRIGGER_KEYWORD_LENGTH))].slice(0,MAX_TRIGGER_KEYWORDS);
}

/**
 * Normalized keyword list of a stored trigger value. A string is the stored
 * editor format; an array is accepted with the same per-keyword rules (each
 * element is one keyword, never split further).
 */
function keywordList(keywords:unknown):string[]{
 return Array.isArray(keywords)?
  [...new Set(keywords.map(normalizeTriggerText)
   .filter(s=>s.length>0&&s.length<=MAX_TRIGGER_KEYWORD_LENGTH))].slice(0,MAX_TRIGGER_KEYWORDS):
  parseTriggerKeywords(keywords);
}

export type KeywordListProblem="keyword_trigger_requires_keywords"|"keyword_trigger_too_many_keywords"|"keyword_trigger_keyword_too_long";
/**
 * Explicit validation of a configured keyword list (never silent
 * truncation): split like parseTriggerKeywords (comma, Arabic comma,
 * newline; an array = one keyword per element), normalize, drop blanks,
 * de-duplicate; then
 *  - any keyword longer than 120 normalized characters -> keyword_too_long;
 *  - more than 40 distinct keywords (counted AFTER de-duplication) -> too_many;
 *  - none left -> requires_keywords.
 * Identical in src/flow/eventRouting.ts keywordListProblem.
 */
export function keywordListProblem(raw:unknown):KeywordListProblem|null{
 const items=Array.isArray(raw)?raw.map(normalizeTriggerText):
  typeof raw==="string"?raw.split(/[,،\n]/).map(normalizeTriggerText):[];
 const kept=[...new Set(items.filter(s=>s.length>0))];
 if(kept.some(k=>k.length>MAX_TRIGGER_KEYWORD_LENGTH))return "keyword_trigger_keyword_too_long";
 if(kept.length>MAX_TRIGGER_KEYWORDS)return "keyword_trigger_too_many_keywords";
 return kept.length===0?"keyword_trigger_requires_keywords":null;
}

/** Match mode of a keyword trigger's operator value; null = invalid (never matches). */
export function keywordMatchMode(operator:unknown):KeywordMatchMode|null{
 if(operator===undefined||operator===null)return "contains";
 if(operator==="exact")return "exact";
 return typeof operator==="string"&&LEGACY_CONTAINS.includes(operator)?"contains":null;
}

const WORD=/[\p{L}\p{N}\p{M}]/u;
/** Code point ending right before index i (handles surrogate pairs). */
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
 * PURE core on ALREADY NORMALIZED text and keyword. "exact": whole-text
 * equality. "contains": occurrence with token boundaries on both sides.
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

/** Never throws; false for anything malformed, empty keyword lists, invalid modes and oversized text. */
export function matchesKeywordTrigger(input:{keywords:unknown;operator?:unknown;text:unknown}):boolean{
 return longestKeywordMatch(input)>0;
}
/** Length of the longest matching normalized keyword (0 = no match). */
function longestKeywordMatch(input:{keywords:unknown;operator?:unknown;text:unknown}):number{
 if(!input||typeof input!=="object")return 0;
 const {keywords,text}=input;
 const mode=keywordMatchMode(input.operator);
 if(!mode||typeof text!=="string"||text.length>MAX_TRIGGER_TEXT)return 0;
 // An invalid list (too many / too long / empty) never matches (fail safe).
 if(keywordListProblem(keywords)!==null)return 0;
 const list=keywordList(keywords);
 if(list.length===0)return 0;
 const normalized=normalizeTriggerText(text);
 return list.filter(k=>keywordMatchesText(normalized,k,mode)).reduce((m,k)=>Math.max(m,k.length),0);
}

type Rec=Record<string,unknown>;
const rec=(v:unknown):v is Rec=>!!v&&typeof v==="object"&&!Array.isArray(v);

/** data of the document's single trigger node, else null (0 or 2+ triggers, malformed). */
export function documentTriggerData(doc:unknown):Rec|null{
 if(!rec(doc)||!Array.isArray(doc.nodes))return null;
 const triggers=(doc.nodes as unknown[]).filter(n=>rec(n)&&rec(n.data)&&n.data.kind==="trigger") as Array<{data:Rec}>;
 return triggers.length===1?triggers[0].data:null;
}

/**
 * Publication check of a DM keyword trigger: at least one keyword that
 * survives parsing AND a valid match mode. Non-keyword triggers (message,
 * comment, ...) return null: no new requirement for them.
 */
export function keywordTriggerProblem(triggerData:unknown):string|null{
 if(!rec(triggerData)||triggerData.kind!=="trigger"||triggerData.triggerMode!=="keyword")return null;
 if(keywordMatchMode(triggerData.operator)===null)return "keyword_trigger_invalid_match_mode";
 return keywordListProblem(triggerData.keywords);
}

/** Whole-document form of keywordTriggerProblem (every trigger node is checked). */
export function documentKeywordTriggerProblem(doc:unknown):string|null{
 if(!rec(doc)||!Array.isArray(doc.nodes))return null;
 for(const n of doc.nodes as unknown[]){
  if(!rec(n)||!rec(n.data))continue;
  const problem=keywordTriggerProblem(n.data);
  if(problem)return problem;
 }
 return null;
}

/**
 * Runtime gate of a DM trigger for one inbound text:
 *  - "message": every direct message (unchanged existing semantics, keywords ignored);
 *  - "keyword": only text matching at least one valid keyword in the trigger's mode;
 *  - anything else (comment, story, ad, live, referral, malformed): false.
 */
export function dmTriggerAcceptsText(triggerData:unknown,text:unknown):boolean{
 if(!rec(triggerData)||triggerData.kind!=="trigger")return false;
 if(triggerData.triggerMode==="message")return true;
 if(triggerData.triggerMode!=="keyword")return false;
 return matchesKeywordTrigger({keywords:triggerData.keywords,operator:triggerData.operator,text});
}

/**
 * Specificity of a keyword trigger for one inbound text: the length (in
 * normalized characters) of the LONGEST keyword that matches in the
 * trigger's own mode (same rule as dmTriggerAcceptsText). 0 when the trigger
 * is not a keyword trigger or nothing matches. Used only to rank several
 * matching keyword flows (flowInboundSelection.ts).
 */
export function matchedKeywordLength(triggerData:unknown,text:unknown):number{
 if(!rec(triggerData)||triggerData.kind!=="trigger"||triggerData.triggerMode!=="keyword")return 0;
 return longestKeywordMatch({keywords:triggerData.keywords,operator:triggerData.operator,text});
}
/** True when the trigger is a keyword trigger in "exact" mode (selection tie-break). */
export function isExactKeywordTrigger(triggerData:unknown):boolean{
 return rec(triggerData)&&triggerData.kind==="trigger"&&triggerData.triggerMode==="keyword"&&
  keywordMatchMode(triggerData.operator)==="exact";
}
