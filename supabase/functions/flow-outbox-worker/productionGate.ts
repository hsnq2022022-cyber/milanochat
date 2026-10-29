/**
 * Pure server-side eligibility for a single durable Outbox effect.
 * Browser flags and payloads must never grant production sending permission.
 * Production rollout supports Instagram only; test-only keeps legacy canaries.
 */
export function canDispatchOutbox(input:{
 globalEnabled:unknown;
 tenantEnabled:unknown;
 testOnly:unknown;
 productionApproved:unknown;
 platform:unknown;
 accountActive:unknown;
 agentEnabled:unknown;
 autoReply:unknown;
 tenantActive:unknown;
 credits:unknown;
 revisionActive:unknown;
 humanTakeover:unknown;
}):boolean{
 if(input.globalEnabled!==true||input.tenantEnabled!==true||
    input.accountActive!==true||input.agentEnabled!==true||
    input.autoReply!==true||input.tenantActive!==true||
    input.revisionActive!==true||input.humanTakeover===true||
    typeof input.credits!=="number"||!Number.isFinite(input.credits)||
    input.credits<=0)return false;
 if(input.platform!=="instagram"&&input.platform!=="facebook"&&
    input.platform!=="whatsapp")return false;
 return input.testOnly===true||
   (input.platform==="instagram"&&input.productionApproved===true);
}
