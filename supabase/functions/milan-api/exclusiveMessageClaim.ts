/** Exclusive Webhook owner. One committed claim -> at most one provider attempt. */
export type Route="legacy_ai"|"flow";
export type Claimed={
 acquired:boolean;route:Route;claim_id?:string;outgoing_message_id:string;
};
export type Result=
 |"duplicate"|"claim_failed"|"empty"|"sent_and_billed"
 |"sent_billing_failed"|"sent_persist_failed"|"send_failed"
 |"delivery_unavailable"|"sent_unconfirmed";
export type DeliveryHooks={
 /** Must be atomically unique by claim_id. No send if it returns false. */
 begin(claimId:string,outgoingMessageId:string,text:string):Promise<boolean>;
 /** Success or ambiguous result. Never resends. */
 finish(claimId:string,status:"confirmed"|"uncertain",providerMessageId:string|null):Promise<boolean>;
};
export type Dependencies={
 prepareFlow():Promise<string|null>;
 claim(engineReady:boolean):Promise<Claimed|null>;
 legacyAnswer():Promise<string|null>;
 send(text:string):Promise<{providerMessageId:string|null}|void>;
 persistSent(messageId:string,text:string):Promise<boolean>;
 debit(messageId:string):Promise<number>;
 delivery?:DeliveryHooks; // explicit phased rollout: OFF unless provided
};

/**
 * Claim is permanent. Provider calls and DB are not one transaction.
 * Uncertain response is NEVER blindly retried, even if DB confirmation fails.
 */
export async function processExclusiveEvent(d:Dependencies):Promise<Result>{
 let prepared:string|null=null;
 try{prepared=await d.prepareFlow();}catch{prepared=null;}
 let c:Claimed|null;
 try{c=await d.claim(Boolean(prepared));}catch{return "claim_failed";}
 if(!c||!["legacy_ai","flow"].includes(c.route)||typeof c.outgoing_message_id!=="string")
  return "claim_failed";
 if(!c.acquired)return "duplicate";
 let reply:string|null;
 try{reply=c.route==="flow"&&prepared?prepared:await d.legacyAnswer();}
 catch{return "empty";}
 if(!reply?.trim())return "empty";
 const text=reply.trim();
 if(d.delivery){
  if(!c.claim_id||typeof c.claim_id!=="string")return "delivery_unavailable";
  try{
   if(!await d.delivery.begin(c.claim_id,c.outgoing_message_id,text))
    return "delivery_unavailable";
  }catch{return "delivery_unavailable";}
 }
 let providerMessageId:string|null=null;
 try{
  const sent=await d.send(text);
  providerMessageId=sent?.providerMessageId??null;
 }catch{
  if(d.delivery&&c.claim_id){
   try{await d.delivery.finish(c.claim_id,"uncertain",null);}catch{/* task queues stale attempting */}
  }
  return "send_failed";
 }
 if(d.delivery&&c.claim_id){
  try{
   const acknowledged=await d.delivery.finish(c.claim_id,"confirmed",providerMessageId);
   if(!acknowledged)return "sent_unconfirmed";
  }catch{return "sent_unconfirmed";}
 }
 let persisted=false;
 try{persisted=await d.persistSent(c.outgoing_message_id,text);}catch{/* external provider might have accepted */}
 if(!persisted)return "sent_persist_failed";
 try{
  const result=await d.debit(c.outgoing_message_id);
  return Number.isInteger(result)&&(result>=0||result===-2)
   ?"sent_and_billed":"sent_billing_failed";
 }catch{return "sent_billing_failed";}
}
