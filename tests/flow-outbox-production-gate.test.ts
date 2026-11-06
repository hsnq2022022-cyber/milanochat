import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {canDispatchOutbox} from "../supabase/functions/flow-outbox-worker/productionGate.ts";
const eligible={
 globalEnabled:true,tenantEnabled:true,testOnly:false,
 productionApproved:true,platform:"instagram",
 accountId:"ig-owner-canary",canaryAccountId:"ig-owner-canary",accountActive:true,
 agentEnabled:true,autoReply:true,tenantActive:true,credits:3,
 revisionActive:true,humanTakeover:false
} as const;
test("production operator approval permits only active Instagram revision",()=>{
 assert.equal(canDispatchOutbox(eligible),true);
 for(const [name,value] of [
  ["globalEnabled",false],["tenantEnabled",false],["productionApproved",false],
  ["canaryAccountId","other"],["accountId","other"],["canaryAccountId",""],
  ["revisionActive",false],["accountActive",false],["agentEnabled",false],
  ["autoReply",false],["tenantActive",false],["humanTakeover",true],
  ["credits",0],["credits",-1],["credits",NaN],
 ] as const){
  assert.equal(canDispatchOutbox({...eligible,[name]:value}),false,"Rejected "+name);
 }
 assert.equal(canDispatchOutbox({...eligible,productionApproved:"true"}),false);
 assert.equal(canDispatchOutbox({...eligible,platform:"facebook"}),false);
 assert.equal(canDispatchOutbox({...eligible,platform:"whatsapp"}),false);
 assert.equal(canDispatchOutbox({...eligible,platform:"fake"}),false);
});
test("test-only canaries retain existing provider support but need active revision",()=>{
 for(const platform of ["instagram","facebook","whatsapp"]){
  assert.equal(canDispatchOutbox({...eligible,platform,testOnly:true,productionApproved:false}),true);
  assert.equal(canDispatchOutbox({...eligible,platform,testOnly:true,revisionActive:false}),false);
 }
});
test("worker reads server switches and exact revision, persists provider MID once",()=>{
 const worker=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.match(worker,/select\("enabled,test_only,production_approved"\)/);
 assert.match(worker,/from\("automation_flow_activations"\)/);
 assert.match(worker,/\.eq\("revision",run\.publication_revision\)/);
 assert.match(worker,/\.eq\("is_active",true\)\.maybeSingle\(\)/);
 assert.match(worker,/account\.platform!==run\.platform/);
 assert.match(worker,/canaryAccountId:env\("FLOW_DURABLE_CANARY_ACCOUNT_ID"\)/);
 assert.match(worker,/canDispatchOutbox\(/);
 assert.match(worker,/typeof providerId!=="string"\|\|!providerId\.trim\(\)/);
 assert.match(worker,/external_message_id:providerId/);
 assert.match(worker,/env\("FLOW_OUTBOX_SEND_ENABLED"\)!=="true"/);
});
test("FLOW_MULTICHANNEL_ENABLED: WhatsApp/Facebook production dispatch needs the flag, approval and the exact canary",()=>{
 for(const platform of ["whatsapp","facebook"]){
  for(const flag of [undefined,false,"true",1])
   assert.equal(canDispatchOutbox({...eligible,platform,multichannelEnabled:flag}),false,`${platform} flag=${flag}`);
  const on={...eligible,platform,multichannelEnabled:true};
  assert.equal(canDispatchOutbox(on),true,platform);
  for(const [name,value] of [["productionApproved",false],["canaryAccountId","other"],["canaryAccountId",""],
   ["revisionActive",false],["humanTakeover",true],["credits",0]] as const)
   assert.equal(canDispatchOutbox({...on,[name]:value}),false,`${platform} ${name}`);
 }
 assert.equal(canDispatchOutbox({...eligible,platform:"telegram",multichannelEnabled:true}),false);
 // Instagram is unchanged by the flag.
 for(const flag of [undefined,true,false])
  assert.equal(canDispatchOutbox({...eligible,multichannelEnabled:flag}),true);
 const worker=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.match(worker,/humanTakeover:takeover,\n\s+multichannelEnabled:env\("FLOW_MULTICHANNEL_ENABLED"\)==="true"\n\s+\}\)\)\{/);
});
