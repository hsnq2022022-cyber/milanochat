/**
 * FUTURE integration point. Caller must FIRST verify the raw webhook body
 * with the real X-Hub-Signature-256. Never use this from an unsigned endpoint.
 * Only stable Meta message IDs can be correlated. Watermark-only read events
 * are deliberately skipped; they do not identify a message reliably.
 */
export type MetaReceipt={accountExternalId:string;platform:"instagram"|"facebook";
 providerMessageId:string;status:"delivered"|"read"};
const isRecord=(v:unknown):v is Record<string,unknown>=>
 !!v&&typeof v==="object"&&!Array.isArray(v);
const safeId=(v:unknown,max=255):v is string=>
 typeof v==="string"&&v.length>0&&v.length<=max;
export function extractMetaDeliveryReceipts(payload:unknown):MetaReceipt[]{
 if(!isRecord(payload)||!Array.isArray(payload.entry))return [];
 const platform=payload.object==="instagram"?"instagram":
  payload.object==="page"?"facebook":null;
 if(!platform)return [];
 const out:MetaReceipt[]=[], seen=new Set<string>();
 for(const entry of payload.entry.slice(0,100)){
  if(!isRecord(entry)||!safeId(entry.id,128))continue;
  const groups:unknown[]=[entry.messaging];
  if(Array.isArray(entry.changes)){
   for(const change of entry.changes.slice(0,100)){
    if(isRecord(change)&&isRecord(change.value)){
     if(Array.isArray(change.value.messaging))groups.push(change.value.messaging);
     else groups.push([change.value]);
    }
   }
  }
  for(const group of groups){
   if(!Array.isArray(group))continue;
   for(const event of group.slice(0,100)){
    if(!isRecord(event))continue;
    for(const status of ["delivered","read"] as const){
     const block=status==="delivered"?event.delivery:event.read;
     if(!isRecord(block)||!Array.isArray(block.mids))continue;
     for(const id of block.mids.slice(0,100)){
      if(!safeId(id))continue;
      const k=entry.id+"/"+status+"/"+id;
      if(seen.has(k))continue;
      seen.add(k);
      out.push({accountExternalId:entry.id,platform,providerMessageId:id,status});
      if(out.length>=100)return out;
     }
    }
   }
  }
 }
 return out;
}
export type ReceiptDb={
 from(table:string):unknown;
 rpc(name:string,args:Record<string,unknown>):Promise<{data:unknown;error:{code?:string}|null}>;
};
export async function recordVerifiedMetaReceipts(db:any,payload:unknown):Promise<number>{
 const receipts=extractMetaDeliveryReceipts(payload);
 let inserted=0;
 for(const receipt of receipts){
  // The same Meta app may contain multiple accounts; reject ambiguity.
  const byExternal=await db.from("channel_accounts").select("id,tenant_id,platform")
   .eq("external_id",receipt.accountExternalId)
   .eq("platform",receipt.platform).limit(2);
  if(byExternal.error)throw Error("Meta account lookup failed");
  let candidates=byExternal.data??[];
  if(candidates.length===0){
   const byPlatform=await db.from("channel_accounts").select("id,tenant_id,platform")
    .eq("platform_account_id",receipt.accountExternalId)
    .eq("platform",receipt.platform).limit(2);
   if(byPlatform.error)throw Error("Meta account mapping failed");
   candidates=byPlatform.data??[];
  }
  if(candidates.length!==1)continue;
  const account=candidates[0];
  if(!safeId(account.id,40)||!safeId(account.tenant_id,40))continue;
  const {data,error}=await db.rpc("flow_record_meta_delivery",{
   p_tenant:account.tenant_id,p_account:account.id,p_platform:receipt.platform,
   p_provider_message_id:receipt.providerMessageId,p_status:receipt.status
  });
  if(error)throw Error("Meta receipt persistence unavailable: "+(error.code??"unknown"));
  if(data===true)inserted++;
 }
 return inserted;
}
