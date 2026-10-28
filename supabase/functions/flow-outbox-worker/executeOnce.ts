/**
 * No provider send before durable reservation. Failed/ambiguous provider response
 * never triggers automatic resend. "confirmed" = accepted HTTP 2xx, NOT delivered.
 */
export type OutboxResult=
 "not_reserved"|"invalid"|"sent_unconfirmed"|"uncertain"|
 "billing_pending"|"settled";
export type OutboxDependencies={
 reserve():Promise<boolean>;
 send():Promise<string|null>;
 confirm(status:"confirmed"|"uncertain",providerId:string|null):Promise<boolean>;
 persistAndBill(providerId:string|null):Promise<boolean>;
};
export async function executeOnce(d:OutboxDependencies):Promise<OutboxResult>{
 let won=false;
 try{won=await d.reserve();}catch{return "not_reserved";}
 if(!won)return "not_reserved";
 let providerId:string|null;
 try{providerId=await d.send();}
 catch{
  try{await d.confirm("uncertain",null);}catch{/* abandoned attempt becomes human review */}
  return "uncertain";
 }
 // HTTP 2xx without a stable provider MID is NOT proof of a traceable send.
 // Do not persist a charge or retry the recipient: the provider might have
 // accepted the message. Route this attempt to human reconciliation instead.
 if(typeof providerId!=="string"||!providerId.trim()){
  try{await d.confirm("uncertain",null);}catch{/* pending attempt is reviewable */}
  return "uncertain";
 }
 try{
  if(!await d.confirm("confirmed",providerId))return "sent_unconfirmed";
 }catch{return "sent_unconfirmed";}
 try{
  return await d.persistAndBill(providerId)?"settled":"billing_pending";
 }catch{return "billing_pending";}
}
