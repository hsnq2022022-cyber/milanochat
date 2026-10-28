/**
 * REVIEW ONLY — Wayl-specific top-up callback. MUST deploy verify_jwt=false
 * and secret PAYMENTS_ENABLED=true only after independent sandbox GO.
 * Legacy wayl-webhook stays untouched; never point a new payment there.
 */
import {createClient} from "npm:@supabase/supabase-js@2";
const env=(name:string)=>Deno.env.get(name)??"";
const reply=(status:number,body:string)=>new Response(body,{
 status,headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder=new TextEncoder();
function hex(input:ArrayBuffer){
 return Array.from(new Uint8Array(input),v=>v.toString(16).padStart(2,"0")).join("");
}
export async function verifyWaylSignature(raw:string,header:string,secret:string):Promise<boolean>{
 const provided=header.toLowerCase().replace(/^sha256=/,"").trim();
 if(!/^[0-9a-f]{64}$/.test(provided)||secret.length<32)return false;
 const key=await crypto.subtle.importKey("raw",encoder.encode(secret),
  {name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const expected=hex(await crypto.subtle.sign("HMAC",key,encoder.encode(raw)));
 let diff=0;
 for(let i=0;i<64;i++)diff|=expected.charCodeAt(i)^provided.charCodeAt(i);
 return diff===0;
}
export async function handle(req:Request){
 if(req.method!=="POST")return reply(405,"method not allowed");
 if(env("PAYMENTS_ENABLED")!=="true"||env("WAYL_TOPUP_WEBHOOK_ENABLED")!=="true")
  return reply(503,"payment processing disabled");
 const secret=env("WAYL_WEBHOOK_SECRET"),base=env("SUPABASE_URL"),
  key=env("SUPABASE_SERVICE_ROLE_KEY");
 if(!secret||secret.length<32||!base||!key)return reply(503,"configuration unavailable");
 const bytes=new Uint8Array(await req.arrayBuffer());
 if(bytes.byteLength===0||bytes.byteLength>32768)return reply(413,"invalid payload size");
 const raw=new TextDecoder().decode(bytes);
 if(!await verifyWaylSignature(raw,req.headers.get("x-wayl-signature-256")??"",secret))
  return reply(401,"invalid signature");
 let payload:unknown;
 try{payload=JSON.parse(raw)}catch{return reply(400,"invalid JSON")}
 if(!payload||typeof payload!=="object"||Array.isArray(payload))
  return reply(400,"invalid event");
 const data=payload as Record<string,unknown>;
 if(typeof data.referenceId!=="string"||!uuid.test(data.referenceId))
  return reply(200,"ignored invalid reference");
 const state=String(data.paymentStatus??"").trim().toLowerCase();
 // Wayl's link API reports "Complete". Webhook schemas may use a
 // different paymentStatus enum. Never silently acknowledge a signed
 // "Paid" event as non-payment: preserve retry/manual reconciliation
 // until sandbox confirmation and an authenticated status lookup exist.
 if(state==="paid"){
  console.warn("[wayl-topup-webhook] paid webhook status requires provider reconciliation");
  return reply(503,"signed paid status requires provider verification");
 }
 // Delivered is NOT sufficient payment evidence; require completed status.
 if(state!=="complete"&&state!=="completed"){
  return reply(200,"non-payment event ignored");
 }
 const amount=typeof data.total==="number"?data.total:
  typeof data.total==="string"&&/^\d+$/.test(data.total)?Number(data.total):NaN;
 if(!Number.isSafeInteger(amount)||amount<=0)
  return reply(400,"invalid confirmed amount");
 const sb=createClient(base,key,{auth:{autoRefreshToken:false,persistSession:false}});
 const {data:result,error}=await sb.rpc("wayl_grant_topup_once",{
  p_payment:data.referenceId,p_paid_iqd:amount
 });
 if(error){
  console.error("[wayl-topup-webhook] atomic grant unavailable",error.code??"unknown");
  return reply(503,"grant unavailable; retry");
 }
 switch(result){
  case "applied":
  case "already_applied":return reply(200,"ok");
  case "not_found":
  case "invalid":
  case "amount_mismatch":
  case "manual_review":
  case "unknown_package":
  case "tenant_unavailable":
   console.warn("[wayl-topup-webhook] manual verification required",result);
   // Do not acknowledge an unapplied CONFIRMED charge as successfully credited.
   return reply(503,"payment requires reconciliation");
  default:return reply(503,"unexpected result");
 }
}
if(import.meta.main)Deno.serve(handle);
