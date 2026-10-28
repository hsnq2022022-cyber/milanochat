import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-contract guards, NOT integration tests. They enforce the existing
 * safety ordering while the durable outbox and staging provider mocks are
 * intentionally blocked on owner approval. Never call these "exactly-once".
 */
const source=readFileSync("supabase/functions/milan-api/index.ts","utf8");
const start=source.indexOf("async function handleIncomingWebhookMessage(");
const end=source.indexOf("Deno.serve(",start);
if(start<0||end<start)throw new Error("Cannot locate inbound handler");
const handler=source.slice(start,end);

function before(first:string,second:string):void{
 const a=handler.indexOf(first),b=handler.indexOf(second);
 assert.ok(a>=0,first+" missing from webhook handler");
 assert.ok(b>=0,second+" missing from webhook handler");
 assert.ok(a<b,first+" must run before "+second);
}
test("duplicate Meta event classification precedes AI and any provider reply",()=>{
 before("classifyInboundInsert(externalMsgId, insertion)","await answerFromKnowledge(");
 before("if (decision !== \"accepted\")","await answerFromKnowledge(");
 before("if (decision !== \"accepted\")","await sendWa(");
});
test("human takeover and paused-credits guards precede all AI and sending",()=>{
 before("if (conv.transferred)","await answerFromKnowledge(");
 before("if (conv.auto_paused_reason === \"credits\")","await answerFromKnowledge(");
 before("if (conv.transferred)","await sendMetaDirectMessage(");
});
test("account disable and depleted credits prevent entering AI or sender",()=>{
 before("account.agent_enabled === false","await answerFromKnowledge(");
 before("account.auto_reply === false","await answerFromKnowledge(");
 before("if (credits <= 0)","await answerFromKnowledge(");
 before("if (credits <= 0)","await sendWa(");
});
test("current billing path is post-send; not verified exactly-once",()=>{
 // This documents the unremediated issue rather than claiming recovery.
 before("await sendMetaDirectMessage(","const { data: sentMessage, error: sentInsertError }");
 before("const { data: sentMessage, error: sentInsertError }","const { data: balanceAfter, error: debitError }");
 assert.match(handler,/credit accounting failed after provider send/);
 assert.match(handler,/outgoing message delivered but could not persist for accounting/);
 // DO NOT turn this into a passing crash-replay assertion without a durable
 // receipt/outbox and an actual fake-provider integration test.
});
