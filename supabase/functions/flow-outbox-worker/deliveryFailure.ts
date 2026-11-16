/**
 * T6-S4: durable provider-failure metadata for a reserved Outbox delivery.
 *
 * A failed send (ProviderTextHttpError for text, ProviderHttpError for images
 * and multichannel sends) is reduced to a closed, validated record: failure
 * class, HTTP status, Meta error code/subcode and the Meta error type
 * identifier. NOTHING else is ever kept: no message text, token, URL, header,
 * raw body, Meta message or fbtrace_id. Any other error (network, timeout,
 * invalid request, payload refused) yields NO record, and the delivery is
 * finished exactly as before (flow_finish_outbox_delivery 'uncertain').
 *
 * The record is persisted through public.flow_fail_outbox_delivery
 * (20261115150000), which finishes the attempt in the SAME transaction:
 *  - 'uncertain' for every class (no resend, no billing, human review);
 *  - 'rejected' (-> dead_letter) ONLY for (a) an image Meta refused
 *    (classifyMediaFailure 'media_rejected', unchanged image policy) and
 *    (b) a text/question with class 'rejected_invalid' = HTTP 4xx (not 408 /
 *    429) with Meta code 100 (invalid parameter: Meta refused the request,
 *    nothing was delivered). The SQL function re-validates both. Every other
 *    class (outside_window, auth, throttled, permanent_other, ambiguous) stays
 *    'uncertain'.
 * When the new function is missing (worker deployed before the migration),
 * errors or returns false, finishFailure returns "fallback" and the caller
 * runs its unchanged flow_finish_outbox_delivery path (the old behaviour).
 * No retry and no second provider call exist anywhere in this module.
 */
import {ProviderHttpError,ProviderTextHttpError,describeTextSendFailure,
 type TextSendFailureClass} from "./deliveryCore.ts";
import {classifyMediaFailure} from "./mediaPolicy.ts";

export type DeliveryFailureClass=TextSendFailureClass|"media_rejected";
export const DELIVERY_FAILURE_CLASSES:readonly DeliveryFailureClass[]=
 ["outside_window","auth","throttled","rejected_invalid","permanent_other","ambiguous","media_rejected"];
export type DeliveryFailureRecord={
 failureClass:DeliveryFailureClass;httpStatus:number|null;
 errorCode:number|null;errorSubcode:number|null;errorType:string|null;
};
const META_TYPE=/^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const safeType=(v:unknown):string|null=>typeof v==="string"&&META_TYPE.test(v)?v:null;

/**
 * Validated failure record of a thrown send error, or null when the error is
 * not a provider HTTP error (no status = no provider evidence). Never throws.
 */
export function deliveryFailureRecord(err:unknown,image:boolean):DeliveryFailureRecord|null{
 try{
  const text=err instanceof ProviderTextHttpError,http=err instanceof ProviderHttpError;
  if(!text&&!http)return null;
  const d=describeTextSendFailure(err);
  if(d.status===null)return null;
  const errorType=safeType(text?(err as ProviderTextHttpError).meta.type:(err as ProviderHttpError).metaType);
  const failureClass:DeliveryFailureClass=
   image&&http&&classifyMediaFailure(err)==="media_rejected"?"media_rejected":d.class;
  return {failureClass,httpStatus:d.status,errorCode:d.code,errorSubcode:d.subcode,errorType};
 }catch{return null;}
}

/** Definite text refusal: class rejected_invalid with HTTP 4xx (not 408/429) and Meta code 100. */
export function definiteTextRejection(r:DeliveryFailureRecord|null):boolean{
 return !!r&&r.failureClass==="rejected_invalid"&&typeof r.httpStatus==="number"&&
  r.httpStatus>=400&&r.httpStatus<=499&&r.httpStatus!==408&&r.httpStatus!==429&&r.errorCode===100;
}

/** Outcome requested from flow_fail_outbox_delivery (the SQL function re-validates it). */
export function failureResult(r:DeliveryFailureRecord,image:boolean):"rejected"|"uncertain"{
 if(image)return r.failureClass==="media_rejected"?"rejected":"uncertain";
 return definiteTextRejection(r)?"rejected":"uncertain";
}

/** Exact flow_fail_outbox_delivery arguments: tenant-scoped, validated fields only. */
export function failureRpcArgs(tenantId:string,outboxId:string,result:"rejected"|"uncertain",
 r:DeliveryFailureRecord){
 return {p_tenant:tenantId,p_outbox:outboxId,p_result:result,p_failure_class:r.failureClass,
  p_http_status:r.httpStatus,p_error_code:r.errorCode,p_error_subcode:r.errorSubcode,
  p_error_type:r.errorType};
}

/** Holder filled by captureFailure (one per effect, like media/textSend in index.ts). */
export type FailureCapture={record:DeliveryFailureRecord|null;rejected:boolean};
export const newFailureCapture=():FailureCapture=>({record:null,rejected:false});

/**
 * Records the validated failure of `send` and rethrows the SAME error, so
 * executeOnce keeps its exact behaviour (confirm("uncertain",null), no resend).
 * The error object itself is never stored.
 */
export function captureFailure<T>(capture:FailureCapture,image:boolean,send:Promise<T>):Promise<T>{
 return send.catch(e=>{capture.record=deliveryFailureRecord(e,image);throw e;});
}

type RpcClient={rpc(fn:string,args:Record<string,unknown>):PromiseLike<{data:unknown;error:{code?:string}|null}>};

/**
 * Finishes a failed delivery WITH its failure record. "rejected" / "uncertain"
 * = the attempt was finished by flow_fail_outbox_delivery; "fallback" = it was
 * not (function missing, error, or false), the caller must run its unchanged
 * flow_finish_outbox_delivery path. That path is a guarded no-op when this
 * call did commit (attempt no longer 'attempting'), so it can never double-finish.
 */
export async function finishFailure(sb:RpcClient,tenantId:string,outboxId:string,
 r:DeliveryFailureRecord,image:boolean):Promise<"rejected"|"uncertain"|"fallback">{
 const call=async(result:"rejected"|"uncertain"):Promise<boolean|null>=>{
  try{
   const {data,error}=await sb.rpc("flow_fail_outbox_delivery",failureRpcArgs(tenantId,outboxId,result,r));
   if(error){console.error("[outbox] failure finish error",{code:typeof error.code==="string"?error.code.slice(0,16):"unknown"});return null;}
   return data===true;
  }catch{console.error("[outbox] failure finish error",{code:"exception"});return null;}
 };
 if(failureResult(r,image)==="rejected"){
  const rejected=await call("rejected");
  if(rejected===true)return "rejected";
 }
 return await call("uncertain")===true?"uncertain":"fallback";
}
