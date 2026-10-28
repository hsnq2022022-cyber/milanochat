import type {SupabaseClient} from "npm:@supabase/supabase-js@2";

export type WidgetCharge = {status:"charged"|"already_charged"|"no_credit"|"invalid"|"error";remaining?:number};

/** No direct browser RPC. The caller must use the server's service-role client. */
export async function chargeWidgetReply(
 sb:Pick<SupabaseClient,"rpc">,tenantId:string,widgetMessageId:string
):Promise<WidgetCharge>{
 try{
  const {data,error}=await sb.rpc("consume_widget_reply",{
   p_tenant_id:tenantId,p_widget_message_id:widgetMessageId
  });
  if(error){
   console.error("[widget_billing] RPC error",{
    tenantId,widgetMessageId,code:error.code??"unknown",message:error.message??"unknown"
   });
   return {status:"error"};
  }
  if(typeof data!=="number"||!Number.isInteger(data)){
   console.error("[widget_billing] invalid RPC result",{tenantId,widgetMessageId});
   return {status:"error"};
  }
  if(data===-2)return {status:"already_charged"};
  if(data===-1){console.error("[widget_billing] no credit after answer",{tenantId,widgetMessageId});return {status:"no_credit"};}
  if(data===-3){console.error("[widget_billing] invalid Widget message owner",{tenantId,widgetMessageId});return {status:"invalid"};}
  if(data>=0)return {status:"charged",remaining:data};
  console.error("[widget_billing] unrecognized result",{tenantId,widgetMessageId,result:data});
  return {status:"error"};
 }catch(e){
  console.error("[widget_billing] unexpected exception",{
   tenantId,widgetMessageId,message:e instanceof Error?e.message:"unknown"
  });
  return {status:"error"};
 }
}
