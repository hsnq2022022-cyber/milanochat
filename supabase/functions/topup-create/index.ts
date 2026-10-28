/**
 * REVIEW ONLY: Wayl top-up link creation. PAYMENTS_ENABLED is OFF by default.
 * Requires verified merchant credentials, a separate signed webhook and atomic grant RPC.
 */
import {createClient} from "npm:@supabase/supabase-js@2";
import {selectTopupPackage,validWaylCheckoutLink,serverReturnUrl,makeLinkPayload} from "./contract.ts";
const env=(key:string)=>Deno.env.get(key)??"";
const ORIGIN="https://hsnq2022022-cyber.github.io";
const headers={"content-type":"application/json; charset=utf-8","cache-control":"no-store",
 "access-control-allow-origin":ORIGIN,"access-control-allow-headers":"apikey,authorization,content-type",
 "access-control-allow-methods":"POST,OPTIONS","vary":"Origin"};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function handle(req:Request){
 if(req.headers.get("origin")!==ORIGIN)return json({error:"Origin not permitted"},403);
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.method!=="POST")return json({error:"Method not allowed"},405);
 if(env("PAYMENTS_ENABLED")!=="true")return json({error:"بوابة الدفع غير مفعّلة"},423);
 const base=env("SUPABASE_URL"),key=env("SUPABASE_SERVICE_ROLE_KEY"),
  merchant=env("WAYL_TOKEN"),webhookSecret=env("WAYL_WEBHOOK_SECRET"),
  redirect=serverReturnUrl(env("SITE_URL")),mode=env("WAYL_ENV");
 if(!base||!key||!merchant||!webhookSecret||webhookSecret.length<32||!redirect||
   (mode!=="test"&&mode!=="live"))
  return json({error:"Merchant configuration unavailable"},503);
 const auth=req.headers.get("authorization")??"";
 if(!auth.startsWith("Bearer ")||auth.length>8192)return json({error:"Unauthorized"},401);
 let input:Record<string,unknown>;
 try{
  const raw=await req.text();
  if(raw.length>1024)return json({error:"Payload too large"},413);
  const body:unknown=JSON.parse(raw);
  if(!body||typeof body!=="object"||Array.isArray(body))return json({error:"Invalid JSON"},400);
  input=body as Record<string,unknown>;
 }catch{return json({error:"Invalid JSON"},400)}
 const pkg=selectTopupPackage(input.packageId);
 if(!pkg||typeof input.tenantId!=="string"||!uuid.test(input.tenantId))
  return json({error:"Invalid tenant or package"},400);
 const sb=createClient(base,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:user,error:userError}=await sb.auth.getUser(auth.slice(7));
 if(userError||!user.user)return json({error:"Unauthorized"},401);
 const {data:tenant,error:tenantErr}=await sb.from("tenants")
  .select("id,user_id").eq("id",input.tenantId).maybeSingle();
 if(tenantErr)return json({error:"Tenant lookup failed"},503);
 if(!tenant||tenant.user_id!==user.user.id)return json({error:"Tenant unauthorized"},403);
 const paymentId=crypto.randomUUID(),packageId=input.packageId as string;
 const meta={source:"wayl-topup-v2",packageId,credits:pkg.credits,env:mode};
 const {error:insertError}=await sb.from("payments").insert({
  id:paymentId,tenant_id:tenant.id,provider:"wayl",amount:pkg.amountIQD,
  currency:"IQD",status:"creating",credits_granted:0,webhook_event:meta
 });
 if(insertError){
  console.error("[topup-create] create row failed",insertError.code);
  return json({error:"Payment record unavailable"},503);
 }
 const uncertain=async()=>{
  const {error}=await sb.from("payments").update({status:"creation_uncertain"})
   .eq("id",paymentId).eq("status","creating");
  if(error)console.error("[topup-create] status update failed",error.code);
 };
 let response:Response;
 try{
  response=await fetch("https://api.thewayl.com/api/v1/links",{
   method:"POST",headers:{"content-type":"application/json",
    "X-WAYL-AUTHENTICATION":merchant},
   body:JSON.stringify(makeLinkPayload({
    id:paymentId,amountIQD:pkg.amountIQD,label:pkg.label,env:mode,
    webhookUrl:base.replace(/\/+$/,"")+"/functions/v1/wayl-topup-webhook",
    webhookSecret,redirectUrl:redirect
   }))
  });
 }catch{
  await uncertain();
  return json({error:"إنشاء رابط الدفع غير مؤكد؛ تواصل مع الدعم قبل المحاولة مجددًا"},503);
 }
 let parsed:unknown;
 try{parsed=await response.json()}catch{parsed=null}
 const data=parsed&&typeof parsed==="object"?(parsed as Record<string,unknown>).data:null;
 const d=data&&typeof data==="object"?data as Record<string,unknown>:null;
 if(!response.ok||d?.referenceId!==paymentId||!validWaylCheckoutLink(d?.url)){
  await uncertain();
  return json({error:"تعذر التحقق من رابط الدفع؛ لا تعِد المحاولة تلقائيًا"},502);
 }
 const url=d.url;
 const code=typeof d.code==="string"&&d.code.length<=128?d.code:null;
 const {data:stored,error:saveError}=await sb.from("payments").update({
  status:"pending_payment",invoice_id:code,webhook_event:{...meta,checkoutUrl:url}
 }).eq("id",paymentId).eq("status","creating").select("id");
 if(saveError||!stored||stored.length!==1){
  console.error("[topup-create] link not persisted",saveError?.code??"unexpected_payment_status");
  return json({error:"تتطلب عملية الدفع مراجعة بشرية"},503);
 }
 return json({invoiceId:paymentId,paymentUrl:url});
}
if(import.meta.main)Deno.serve(handle);
