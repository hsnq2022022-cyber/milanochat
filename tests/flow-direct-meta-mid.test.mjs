import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

test("direct webhook stores the confirmed Meta provider message ID on the persisted outgoing row",()=>{
 const m=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const sender=readFileSync("supabase/functions/milan-api/exclusiveMessageClaim.ts","utf8");
 assert.match(sender,/persistSent\(messageId:string,text:string,providerMessageId:string\)/);
 assert.match(sender,/d\.persistSent\(c\.outgoing_message_id,text,providerMessageId\)/);
 assert.match(m,/persistSent: async \(outgoingId, text, providerMessageId\) => \{/);
 assert.match(m,/is_auto: true,\s*wa_message_id: providerMessageId,\s*external_message_id: providerMessageId,/);
 assert.match(m,/const providerMessageId=await sendMetaDirectMessage\(/);
});
