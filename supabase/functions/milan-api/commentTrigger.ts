/**
 * PURE (no env, no Deno, no IO). Comment automation building blocks:
 *  1. commentTriggerConfig / commentTriggerProblem: server-side validation of
 *     a comment trigger node of a PUBLISHED flow document, normalized to the
 *     snake_case trigger config model.
 *  2. normalizeMetaComments: Instagram `comments` and Facebook Page `feed`
 *     (item "comment", verb "add") change events -> customer comments, with
 *     the account's own comments dropped (no self-reply loops) and duplicates
 *     of one comment id in the same body removed.
 *  3. commentMatches: target scope (all / specific post id) and match type
 *     (any / keyword, case-insensitive, Arabic-safe).
 *
 * NOT an authorization boundary: call normalizeMetaComments only AFTER the
 * X-Hub-Signature-256 verification; tenant/account resolution stays with the
 * caller. Nothing here sends, stores or logs.
 *
 * Mapping (published document node.data, camelCase, preserved by
 * src/flow/model.ts importFlow) -> snake_case config:
 *   commentScope ('all'|'specific')   -> target_scope
 *   commentPostId (string)            -> specific_post_id (only when 'specific')
 *   commentMatchType ('any'|'keyword')-> match_type
 *   keywords (comma/newline string)   -> keywords: string[] (normalized)
 *   publicReplyText (string)          -> public_reply_text (trimmed)
 * Absent fields on old documents: scope 'all'; match type 'keyword' when
 * keywords are present, else 'any' (the src/flow/model.ts load default).
 * A snake_case object is accepted too (same rules).
 */
export type CommentTargetScope="all"|"specific";
export type CommentMatchType="any"|"keyword";
export type CommentTriggerConfig={
 target_scope:CommentTargetScope;
 specific_post_id?:string;
 match_type:CommentMatchType;
 keywords:string[];
 public_reply_text:string;
};
/** Meta comment text limit (Instagram caption/comment = 2200 characters). */
export const PUBLIC_REPLY_MAX=2200;
/** Same bounds as src/flow/eventRouting.ts parseTriggerKeywords. */
export const MAX_COMMENT_KEYWORDS=40;
export const MAX_COMMENT_KEYWORD_LENGTH=120;
/** Raw keywords string bound (src/flow/model.ts importFlow keeps <= 500). */
export const MAX_KEYWORDS_RAW=500;
/** Instagram media id (digits) or Facebook post id (pageId_postId). */
const POST_ID=/^[0-9]{1,32}(_[0-9]{1,32})?$/;
/** Instagram comment id (digits) or Facebook comment id (postId_commentId). */
export const COMMENT_ID=/^[0-9]{1,32}(_[0-9]{1,32})?$/;
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

type Rec=Record<string,unknown>;
const rec=(v:unknown):v is Rec=>!!v&&typeof v==="object"&&!Array.isArray(v);

/**
 * Identical to src/flow/eventRouting.ts normalizeTriggerText (parity is
 * pinned by tests/flow-comment-automation.test.ts): NFKC, lower case, Arabic
 * diacritics/tatweel removed, alef/yaa variants folded, whitespace collapsed.
 */
export function normalizeCommentText(raw:string):string{
 return raw.normalize("NFKC").toLocaleLowerCase("en-US")
  .replace(/[ً-ٰٟـ]/g,"")
  .replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي")
  .replace(/\s+/g," ").trim();
}
/** Raw split pieces (comma, Arabic comma, newline), normalized, empties dropped. */
const keywordPieces=(raw:string)=>raw.split(/[,،\n]/).map(normalizeCommentText).filter(s=>s.length>0);

type Parsed={config:CommentTriggerConfig}|{problem:string};
function parse(data:unknown):Parsed{
 if(!rec(data))return {problem:"comment_trigger_invalid"};
 const pick=(camel:string,snake:string)=>data[camel]!==undefined?data[camel]:data[snake];
 const scopeRaw=pick("commentScope","target_scope");
 const postRaw=pick("commentPostId","specific_post_id");
 const matchRaw=pick("commentMatchType","match_type");
 const kwRaw=data.keywords;
 const replyRaw=pick("publicReplyText","public_reply_text");
 if(scopeRaw!==undefined&&scopeRaw!=="all"&&scopeRaw!=="specific")
  return {problem:"comment_scope_invalid"};
 if(postRaw!==undefined&&typeof postRaw!=="string")return {problem:"comment_post_id_invalid"};
 if(matchRaw!==undefined&&matchRaw!=="any"&&matchRaw!=="keyword")
  return {problem:"comment_match_type_invalid"};
 let pieces:string[];
 if(kwRaw===undefined||kwRaw===null)pieces=[];
 else if(typeof kwRaw==="string"){
  if(kwRaw.length>MAX_KEYWORDS_RAW)return {problem:"comment_keywords_too_long"};
  pieces=keywordPieces(kwRaw);
 }else if(Array.isArray(kwRaw)){
  if(!kwRaw.every(k=>typeof k==="string"))return {problem:"comment_keywords_invalid"};
  pieces=(kwRaw as string[]).map(normalizeCommentText).filter(s=>s.length>0);
 }else return {problem:"comment_keywords_invalid"};
 if(pieces.some(k=>k.length>MAX_COMMENT_KEYWORD_LENGTH))return {problem:"comment_keyword_too_long"};
 const keywords=[...new Set(pieces)];
 if(keywords.length>MAX_COMMENT_KEYWORDS)return {problem:"comment_keywords_too_many"};
 const target_scope:CommentTargetScope=scopeRaw==="specific"?"specific":"all";
 // Old documents without a match type: keyword when keywords exist (model.ts default).
 const match_type:CommentMatchType=matchRaw==="keyword"||matchRaw==="any"?matchRaw:
  keywords.length>0?"keyword":"any";
 if(typeof replyRaw!=="string")return {problem:"public_reply_required"};
 const reply=replyRaw.trim();
 if(!reply)return {problem:"public_reply_required"};
 if(reply.length>PUBLIC_REPLY_MAX)return {problem:"public_reply_too_long"};
 if(CONTROL.test(reply))return {problem:"public_reply_invalid"};
 const config:CommentTriggerConfig={target_scope,match_type,keywords,public_reply_text:reply};
 if(target_scope==="specific"){
  const post=typeof postRaw==="string"?postRaw.trim():"";
  if(!post)return {problem:"comment_post_id_required"};
  if(!POST_ID.test(post))return {problem:"comment_post_id_invalid"};
  config.specific_post_id=post;
 }
 if(match_type==="keyword"&&keywords.length<1)return {problem:"comment_keyword_required"};
 return {config};
}
/** Validated snake_case config of a comment trigger's data, else null. */
export function commentTriggerConfig(data:unknown):CommentTriggerConfig|null{
 const r=parse(data);
 return "config" in r?r.config:null;
}
/** Problem code of a comment trigger's data, null when valid. */
export function commentTriggerProblem(data:unknown):string|null{
 const r=parse(data);
 return "problem" in r?r.problem:null;
}
/**
 * Publication check for a whole document. Documents whose trigger is not a
 * comment trigger return null (unchanged behaviour: no new requirement).
 */
export function documentCommentTriggerProblem(doc:unknown):string|null{
 if(!rec(doc)||!Array.isArray(doc.nodes))return null;
 for(const n of doc.nodes as unknown[]){
  if(!rec(n)||!rec(n.data))continue;
  if(n.data.kind==="trigger"&&n.data.triggerMode==="comment"){
   const problem=commentTriggerProblem(n.data);
   if(problem)return problem;
  }
 }
 return null;
}

export type NormalizedComment={
 platform:"instagram"|"facebook";
 /** entry.id: Instagram professional account id / Facebook Page id. */
 accountExternalId:string;
 commentId:string;
 /** Instagram media.id / Facebook post_id. */
 postId:string;
 /** Instagram parent_id / Facebook parent_id when the comment is a reply, else null. */
 parentId:string|null;
 text:string;
 fromId:string;
 /** Facebook from.name; Instagram from.username; else null. */
 fromName:string|null;
};
export const MAX_NORMALIZED_COMMENTS=200;
const MAX_COMMENT_CHARS=8192;
const metaId=(v:unknown):string=>{
 if(typeof v==="number"&&Number.isSafeInteger(v)&&v>0)return String(v);
 return typeof v==="string"&&/^[0-9]{1,32}$/.test(v)?v:"";
};
const compoundId=(v:unknown):string=>typeof v==="string"&&COMMENT_ID.test(v)?v:metaId(v);
const name=(v:unknown):string|null=>typeof v==="string"&&v.trim()&&v.length<=256&&!CONTROL.test(v)?v.trim():null;
/**
 * Signed webhook body -> customer comments. `ownIds` = ids of the business
 * itself (connected account / Page ids): a comment authored by entry.id or
 * any own id is dropped, so the public reply never triggers itself.
 * Ignores edits/removals (Facebook verb != "add"), non-comment feed items,
 * empty or oversized text and malformed shapes. Never throws.
 */
export function normalizeMetaComments(body:unknown,ownIds:readonly string[]=[]):NormalizedComment[]{
 const out:NormalizedComment[]=[];
 const seen=new Set<string>();
 if(!rec(body)||(body.object!=="instagram"&&body.object!=="page")||!Array.isArray(body.entry))return out;
 const platform=body.object==="instagram"?"instagram":"facebook";
 for(const entry of body.entry as unknown[]){
  if(!rec(entry)||!Array.isArray(entry.changes))continue;
  const account=metaId(entry.id);
  if(!account)continue;
  for(const change of entry.changes as unknown[]){
   if(out.length>=MAX_NORMALIZED_COMMENTS)return out;
   if(!rec(change)||!rec(change.value))continue;
   const v=change.value;
   let c:NormalizedComment|null=null;
   if(platform==="instagram"&&change.field==="comments"){
    const from=rec(v.from)?v.from:{};
    const media=rec(v.media)?v.media:{};
    c={platform,accountExternalId:account,commentId:compoundId(v.id),postId:compoundId(media.id),
     parentId:compoundId(v.parent_id)||null,text:typeof v.text==="string"?v.text:"",
     fromId:metaId(from.id),fromName:name(from.username)??name(from.name)};
   }else if(platform==="facebook"&&change.field==="feed"&&v.item==="comment"&&v.verb==="add"){
    const from=rec(v.from)?v.from:{};
    c={platform,accountExternalId:account,commentId:compoundId(v.comment_id),postId:compoundId(v.post_id),
     parentId:compoundId(v.parent_id)||null,text:typeof v.message==="string"?v.message:"",
     fromId:metaId(from.id),fromName:name(from.name)};
   }
   if(!c||!c.commentId||!c.postId||!c.fromId)continue;
   if(!c.text.trim()||c.text.length>MAX_COMMENT_CHARS)continue;
   // No self-reply loop: the business' own comments (incl. our public reply).
   if(c.fromId===account||ownIds.includes(c.fromId))continue;
   const key=platform+":"+account+":"+c.commentId;
   if(seen.has(key))continue;
   seen.add(key);out.push(c);
  }
 }
 return out;
}
/**
 * Comment trigger match. Scope: 'all' or exact post id equality. Match type:
 * 'any', or 'keyword' = the normalized comment contains at least one
 * normalized keyword (same containment rule as eventRouting.ts).
 */
export function commentMatches(config:CommentTriggerConfig,comment:{postId:string;text:string}):boolean{
 if(!config||!comment||typeof comment.text!=="string"||typeof comment.postId!=="string")return false;
 if(config.target_scope==="specific"&&(!config.specific_post_id||comment.postId!==config.specific_post_id))
  return false;
 if(config.match_type==="any")return true;
 if(config.match_type!=="keyword"||!Array.isArray(config.keywords)||config.keywords.length<1)return false;
 const text=normalizeCommentText(comment.text);
 return config.keywords.some(k=>typeof k==="string"&&k.length>0&&text.includes(normalizeCommentText(k)));
}

export type CommentFlowPlan={
 config:CommentTriggerConfig;
 triggerId:string;
 /** The single DM node (sent as an Instagram/Messenger private reply). */
 messageId:string;
 dmText:string;
 /** Optional end node after the DM. */
 endId:string|null;
};
const SAFE_NODE=/^[a-zA-Z0-9_-]{1,128}$/;
const dmTextOk=(t:unknown):t is string=>typeof t==="string"&&t.trim().length>0&&
 new TextEncoder().encode(t).byteLength<=1000&&!CONTROL.test(t);
/**
 * The ONLY comment-automation graph that runs live: one comment trigger on the
 * account's platform ('instagram', or 'messenger' for a Facebook Page) with a
 * valid config -> exactly one plain text message (no buttons, image or
 * content blocks; Meta allows ONE private reply per comment) -> optional end.
 * Anything else returns null (never runs; existing behaviour unchanged).
 */
export function commentFlowPlan(raw:unknown,accountPlatform:string):CommentFlowPlan|null{
 if(!rec(raw)||raw.version!==3||!Array.isArray(raw.nodes)||!Array.isArray(raw.edges))return null;
 const triggerPlatform=accountPlatform==="facebook"?"messenger":accountPlatform==="instagram"?"instagram":null;
 if(!triggerPlatform)return null;
 const nodes=raw.nodes as unknown[],edges=raw.edges as unknown[];
 if(nodes.length<2||nodes.length>3||edges.length<1||edges.length>2)return null;
 if(!nodes.every(n=>rec(n)&&typeof n.id==="string"&&SAFE_NODE.test(n.id)&&rec(n.data)))return null;
 const list=nodes as Array<{id:string;data:Rec}>;
 if(new Set(list.map(n=>n.id)).size!==list.length)return null;
 const triggers=list.filter(n=>n.data.kind==="trigger");
 const messages=list.filter(n=>n.data.kind==="message");
 const ends=list.filter(n=>n.data.kind==="end");
 if(triggers.length!==1||messages.length!==1||triggers.length+messages.length+ends.length!==list.length)return null;
 const t=triggers[0],m=messages[0],end=ends[0]??null;
 if(t.data.triggerMode!=="comment"||t.data.platform!==triggerPlatform)return null;
 const config=commentTriggerConfig(t.data);
 if(!config)return null;
 const d=m.data;
 if(!dmTextOk(d.text)||!(d.image===""||d.image===undefined)||
    !(d.contentBlocks===undefined||(Array.isArray(d.contentBlocks)&&d.contentBlocks.length===0))||
    !(d.options===undefined||(Array.isArray(d.options)&&d.options.length===0)))return null;
 const handle=(e:Rec)=>e.sourceHandle===undefined||e.sourceHandle===null||e.sourceHandle===""||e.sourceHandle==="next";
 const want=[[t.id,m.id],...(end?[[m.id,end.id]]:[])];
 if(edges.length!==want.length||!edges.every(e=>rec(e)&&handle(e)))return null;
 for(const [s,g] of want)
  if((edges as Rec[]).filter(e=>e.source===s&&e.target===g).length!==1)return null;
 return {config,triggerId:t.id,messageId:m.id,dmText:(d.text as string).trim(),endId:end?end.id:null};
}
