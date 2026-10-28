import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

test("provider-sent messages persist an id before debit and pass correct RPC arguments",()=>{
  const source=readFileSync("supabase/functions/milan-api/index.ts","utf8");
  const handler=source.split("async function handleIncomingWebhookMessage(")[1]?.split("/* ═")[0]??"";
  const persisted=handler.indexOf('const { data: sentMessage, error: sentInsertError } = await sb');
  const selected=handler.indexOf('.select("id")',persisted);
  const called=handler.indexOf('"consume_reply"',persisted);
  assert.ok(persisted>0 && selected>persisted && called>selected);
  assert.match(handler,/p_tenant_id: tenantId,\s*p_message_id: sentMessage\.id/);
  assert.match(handler,/if \(sentInsertError \|\| !sentMessage\?\.id\)/);
  assert.match(handler,/if \(debitError \|\| typeof balanceAfter !== "number"/);
  assert.doesNotMatch(handler,/p_tenant_id: tenantId\s*\}\s*\)/);
});

test("incoming Meta webhook rejects duplicate message before any LLM, provider send or debit",()=>{
  const source=readFileSync("supabase/functions/milan-api/index.ts","utf8");
  const handler=source.split("async function handleIncomingWebhookMessage(")[1]?.split("/* ═")[0]??"";
  const initial=handler.indexOf('classifyInboundInsert(externalMsgId, insertion)');
  const rejected=handler.indexOf('if (decision !== "accepted")',initial);
  const ai=handler.indexOf('await answerFromKnowledge(',initial);
  assert.ok(initial>=0 && rejected>initial && ai>rejected);
  const rejectBlock=handler.slice(rejected,ai);
  assert.match(rejectBlock,/return;/);
});
