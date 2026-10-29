import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {confirmedOutboxMid,matchesPreviouslyPersistedReply} from
 "../supabase/functions/flow-outbox-worker/confirmedSettlement.ts";

test("confirmed Meta acknowledgements alone can settle later without resend",()=>{
 const effect={delivery_status:"charge_pending",provider_message_id:"mid.ig.confirmed"};
 const journal={status:"confirmed",provider_message_id:"mid.ig.confirmed"};
 assert.equal(confirmedOutboxMid(effect,journal),"mid.ig.confirmed");
 assert.equal(confirmedOutboxMid({...effect,delivery_status:"pending"},journal),null);
 assert.equal(confirmedOutboxMid({...effect,provider_message_id:"changed"},journal),null);
 assert.equal(confirmedOutboxMid(effect,{...journal,status:"uncertain"}),null);
 assert.equal(confirmedOutboxMid(effect,null),null);
 assert.equal(confirmedOutboxMid({...effect,provider_message_id:" "},{status:"confirmed",provider_message_id:" "}),null);
});
test("previously persisted reply must belong to same tenant/conversation/outgoing ID and MID",()=>{
 const expected={id:"out-1",tenantId:"tenant-1",conversationId:"conv-1",providerMid:"ig.mid"};
 const row={id:"out-1",tenant_id:"tenant-1",conversation_id:"conv-1",
  direction:"out",is_auto:true,wa_message_id:"ig.mid",external_message_id:"ig.mid"};
 assert.equal(matchesPreviouslyPersistedReply(row,expected),true);
 for(const field of ["id","tenant_id","conversation_id","direction",
  "is_auto","wa_message_id","external_message_id"]){
  const wrong={...row,[field]:field==="is_auto"?false:"other"};
  assert.equal(matchesPreviouslyPersistedReply(wrong,expected),false,field);
 }
 assert.equal(matchesPreviouslyPersistedReply(null,expected),false);
});
test("worker resumes confirmed charge_pending without any provider network retry",()=>{
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.match(code,/\.in\("delivery_status",\["pending","charge_pending"\]\)/);
 const guard=code.indexOf('if(effect.delivery_status==="charge_pending")');
 const send=code.indexOf('const token=account.platform');
 assert(guard>0 && send>guard);
 assert.match(code,/const mid=confirmedOutboxMid\(effect,attempt\)/);
 assert.match(code,/report\(await persistAndBill\(mid\)\?"settled":"billing_pending"\)/);
 assert.match(code,/if\(attemptError\|\|!mid\)\{report\("blocked"\);continue;\}/);
 assert.match(code,/matchesPreviouslyPersistedReply\(prior/);
 assert.match(code,/persistAndBill\s*\n\s*\}\);/);
});
