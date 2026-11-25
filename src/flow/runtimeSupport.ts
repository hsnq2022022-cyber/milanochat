/**
 * PURE (no React, no Deno, no browser globals; never throws): the single place
 * that says which flow shapes NO live engine can ever run, with the plain
 * Arabic reason shown to customers.
 *
 * Used by every layer that must agree, so a flow cannot look fine in one place
 * and fail in another:
 *  - validateForRuntime (below): editor "check" chip AND the server's
 *    preparePublishedDocument, so an unsupported flow is rejected BEFORE a
 *    revision is created. DRAFTS stay creatable/editable: plain validateDocument
 *    (structure only) is unchanged and still what the AI generator uses;
 *  - flow-publication: the 422 body carries these Arabic sentences;
 *  - the simulator: it stops at such a step instead of pretending it ran;
 *  - the editor: palette / trigger list mark these options unavailable.
 *
 * "Unsupported" here is STRUCTURAL (no engine runs it on any account). What
 * an individual account may use (buttons, delays, images, ...) stays an
 * account capability decided by the server (flow-publication capabilities.ts);
 * it is never decided here. The derivation itself lives in requirements.ts
 * (parity-tested against the server classifiers); this file adds no rules of
 * its own except the explicit list of trigger modes the runtime executes.
 */
import {deriveRequirements,nodeRequirements} from "./requirements.ts";
import type {UnsupportedReason} from "./requirements.ts";
import {validateDocument} from "./model.ts";
import type {FlowDocument,ValidationIssue,ValidationLibraryItem} from "./model.ts";

type Text={ar:string;en:string};

/** Plain-language sentence per structural reason (customer text: no jargon). */
export const UNSUPPORTED_TEXT:Record<UnsupportedReason,Text>={
 malformed_document:{ar:"تعذر قراءة التدفق. راجع الخطوات ثم أعد المحاولة.",en:"The flow document is malformed."},
 unknown_block:{ar:"هذه الخطوة غير معروفة ولن تعمل.",en:"Unknown step."},
 trigger_not_supported:{ar:"هذا النوع من بداية الأتمتة غير مدعوم بعد.",en:"This trigger type is not supported yet."},
 trigger_channel_mismatch:{ar:"بداية الأتمتة مضبوطة على قناة مختلفة عن الحساب المختار.",en:"The trigger targets another channel."},
 pdf_not_supported:{ar:"إرسال ملفات PDF غير مدعوم بعد.",en:"PDF sending is not supported."},
 number_question_not_supported:{ar:"سؤال الأرقام غير مدعوم بعد. استخدم سؤالًا نصيًا بدلًا منه.",en:"Number questions are not supported."},
 http_request_not_supported:{ar:"الطلب الخارجي غير مدعوم بعد.",en:"HTTP requests are not supported."},
 content_blocks_not_supported:{ar:"هذا النوع من المحتوى داخل الرسالة غير مدعوم بعد.",en:"This content block is not supported."},
 legacy_image_not_supported:{ar:"طريقة إضافة الصورة هذه غير مدعومة. أضف الصورة كمحتوى داخل الرسالة.",en:"Use an image content block."},
 button_action_not_supported:{ar:"نوع إجراء هذا الزر غير مدعوم بعد.",en:"This button action is not supported."},
 mixed_buttons_not_supported:{ar:"لا يمكن الجمع بين أزرار الروابط وأزرار الاختيار في رسالة واحدة.",en:"Website and reply buttons cannot be mixed."},
 inbound_message_condition:{ar:"الشرط على نص رسالة العميل يعمل فقط في تدفق قصير: بداية ثم شرط ثم رسالتان.",en:"Inbound-text conditions only work in a short flow: trigger, condition, two messages."},
 action_not_supported:{ar:"هذا الإجراء غير مدعوم بعد.",en:"This action is not supported."},
};

/**
 * Trigger modes some live engine executes (DM message / keyword, and comment
 * automation). Story replies, ad clicks, live comments and Messenger referral
 * links are offered by the model for the future but NOTHING executes them.
 */
export const RUNTIME_TRIGGER_MODES:readonly string[]=["message","keyword","comment"];
export const isRuntimeTriggerMode=(mode:unknown):boolean=>
 typeof mode==="string"&&RUNTIME_TRIGGER_MODES.includes(mode);

export const unsupportedText=(reason:string,en=false):string=>{
 const t=(UNSUPPORTED_TEXT as Record<string,Text|undefined>)[reason];
 return t?(en?t.en:t.ar):(en?"Not supported yet.":"هذه الخطوة غير مدعومة بعد، ولن تعمل بعد النشر.");
};

/** Reasons already reported with their own, more specific validateDocument message. */
const ALREADY_REPORTED:ReadonlySet<UnsupportedReason>=new Set(["pdf_not_supported","malformed_document","trigger_channel_mismatch"]);

/** nodeId -> structural reasons (stable order). Empty map = nothing structurally unsupported. */
export function unsupportedByNode(doc:unknown):Map<string,UnsupportedReason[]>{
 const out=new Map<string,UnsupportedReason[]>();
 try{
  for(const u of deriveRequirements(doc,null).unsupported){
   if(!u.nodeId)continue;
   const list=out.get(u.nodeId)??[];
   if(!list.includes(u.reason))list.push(u.reason);
   out.set(u.nodeId,list);
  }
 }catch{/* malformed input: other validation reports it */}
 return out;
}

/** Structural reasons of ONE node's data (palette candidate or existing block). */
export function staticUnsupportedReasons(data:unknown):UnsupportedReason[]{
 try{return nodeRequirements(data,null).unsupported;}catch{return [];}
}

export type UnsupportedFinding={nodeId:string;title:string;reason:UnsupportedReason;text:string};
/**
 * One finding per structurally unsupported step. `title` is the step's own title (may be "") and is the
 * ONLY label safe to show a customer; internal node ids stay out of customer text.
 * `includeReported` also returns reasons validateDocument words itself (PDF).
 */
export function unsupportedFindings(doc:{nodes:ReadonlyArray<{id:string;data:{title?:string}}>},
 opts:{includeReported?:boolean}={}):UnsupportedFinding[]{
 const out:UnsupportedFinding[]=[];
 const byNode=unsupportedByNode(doc);
 for(const node of doc.nodes){
  for(const reason of byNode.get(node.id)??[]){
   // validateDocument already words PDF specifically; callers that report ONLY these findings
   // (server rejection, publish preflight) pass includeReported so nothing is silently dropped.
   if(!opts.includeReported&&ALREADY_REPORTED.has(reason))continue;
   if(reason==="malformed_document"||reason==="trigger_channel_mismatch")continue;
   out.push({nodeId:node.id,title:String(node.data.title??"").trim(),reason,text:unsupportedText(reason)});
  }
 }
 return out;
}

/** Customer sentence for one finding: reason + the step's title when it has one. Never an id. */
export const findingSentence=(f:UnsupportedFinding):string=>f.title?f.text+" — "+f.title:f.text;

/**
 * Error findings for validateDocument: one per structurally unsupported
 * step, in plain Arabic, each naming the step (title, else id: this list is the editor's own check
 * panel, same style as every other validation message). Published documents carrying
 * any of these are refused (never saved), so nothing unrunnable is "published".
 */
export function runtimeUnsupportedIssues(doc:{nodes:ReadonlyArray<{id:string;data:{title?:string}}>},
 opts:{includeReported?:boolean}={}):ValidationIssue[]{
 return unsupportedFindings(doc,opts).map(f=>({
  message:f.text+" — "+(f.title||f.nodeId),
  nodeId:f.nodeId,severity:"error" as const,code:"FLOW_RUNTIME_UNSUPPORTED:"+f.reason,
 }));
}

/**
 * validateDocument + the structural runtime findings. The ONE validation used where "can this go live?" matters:
 * the editor check list and the server's publication preparation. (Drafting, import and AI generation keep
 * using plain validateDocument, so an unrunnable draft can still be saved, edited and fixed.)
 */
export function validateForRuntime(doc:FlowDocument,library?:readonly ValidationLibraryItem[]):ValidationIssue[]{
 return [...validateDocument(doc,library),...runtimeUnsupportedIssues(doc)];
}
