/**
 * Pure server-side eligibility for a single durable Outbox effect.
 * Browser flags and payloads must never grant production sending permission.
 * Production rollout supports Instagram; WhatsApp/Facebook only while
 * FLOW_MULTICHANNEL_ENABLED is on (multichannelEnabled===true, read by the
 * worker), with the same production approval and exact canary account.
 * Test-only keeps legacy canaries.
 */
import {durableAccountAllowed} from "../_shared/durableAccounts.ts";
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
 /**
  * The operator registry (automation_flow_canary_accounts) holds exactly this
  * tenant/account/platform. Required for PRODUCTION sending, like the SQL claim
  * flow_claim_inbound_durable; absent or not exactly true = NOT registered. A removed row
  * therefore HOLDS pending effects (blocked, not cancelled; the stale sweep bounds them).
  */
 registryRegistered?:unknown;
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
    durableAccountAllowed(input.canaryAccountId,input.accountId)&&
    input.registryRegistered===true);
}
