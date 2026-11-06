/**
 * Pure server-side eligibility for a single durable Outbox effect.
 * Browser flags and payloads must never grant production sending permission.
 * Production rollout supports Instagram; WhatsApp/Facebook only while
 * FLOW_MULTICHANNEL_ENABLED is on (multichannelEnabled===true, read by the
 * worker), with the same production approval and exact canary account.
 * Test-only keeps legacy canaries.
 */
export function canDispatchOutbox(input:{
 globalEnabled:unknown;
 tenantEnabled:unknown;
 testOnly:unknown;
 productionApproved:unknown;
 platform:unknown;
 accountId:unknown;
 canaryAccountId:unknown;
 accountActive:unknown;
 agentEnabled:unknown;
 autoReply:unknown;
 tenantActive:unknown;
 credits:unknown;
 revisionActive:unknown;
 humanTakeover:unknown;
 /** FLOW_MULTICHANNEL_ENABLED (default OFF); absent or not exactly true = OFF. */
 multichannelEnabled?:unknown;
}):boolean{
 if(input.globalEnabled!==true||input.tenantEnabled!==true||
    input.accountActive!==true||input.agentEnabled!==true||
    input.autoReply!==true||input.tenantActive!==true||
    input.revisionActive!==true||input.humanTakeover===true||
    typeof input.credits!=="number"||!Number.isFinite(input.credits)||
    input.credits<=0)return false;
 if(input.platform!=="instagram"&&input.platform!=="facebook"&&
    input.platform!=="whatsapp")return false;
 const productionPlatform=input.platform==="instagram"||
  (input.multichannelEnabled===true&&
   (input.platform==="whatsapp"||input.platform==="facebook"));
 return input.testOnly===true||
   (productionPlatform&&input.productionApproved===true&&
    typeof input.accountId==="string"&&input.accountId.length>0&&
    input.canaryAccountId===input.accountId);
}
