import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

test("flow shadow is inserted after all legacy safety gates and before RAG",()=>{
  const source=readFileSync("supabase/functions/milan-api/index.ts","utf8");
  const start=source.indexOf("async function handleIncomingWebhookMessage(");
  const end=source.indexOf("/* ═══════════════════════════════════════════════════════════════",start+2);
  assert.ok(start>=0&&end>start);
  const handler=source.slice(start,end);
  // The legacy safety gates (takeover, credits pause, auto-reply off, no credits) are ONE function in
  // messageRouting.ts that runs before the shadow hook (afterGate) and before any engine / RAG answer.
  const routing=readFileSync("supabase/functions/milan-api/messageRouting.ts","utf8");
  const gate=routing.indexOf("const gate=conversationGate(");
  const afterGate=routing.indexOf("deps.afterGate");
  assert.ok(gate>=0&&gate<afterGate&&afterGate<routing.indexOf("deps.attemptDurable()")&&afterGate<routing.indexOf("deps.exclusive()"));
  assert.ok(routing.includes("if(transferred)return"),"the takeover gate is part of the same function");
  const shadow=handler.indexOf('if (env("FLOW_SHADOW_MODE") === "observe")');
  const route=handler.indexOf("await routeInbound(");
  const hook=handler.indexOf("afterGate: async () => {");
  const rag=handler.indexOf("await answerFromKnowledge(");
  const send=handler.indexOf("await sendMetaDirectMessage(");
  assert.ok(route>=0&&route<hook&&hook<shadow&&shadow<rag&&rag<send);
  assert.match(source,/import \{ flowShadowMayObserve \} from "\.\/flowShadowGate\.ts";/);
  // Legacy provider sends and billing remain in the same code path.
  assert.match(handler,/await sendWa\(/);
  assert.match(handler,/await sendMetaDirectMessage\(/);
  assert.match(handler,/\.rpc\(\s*"consume_flow_reply"/);
});
test("flow shadow is explicitly read-only with no activation or send APIs",()=>{
  const source=readFileSync("supabase/functions/milan-api/flowShadowGate.ts","utf8");
  assert.doesNotMatch(source,/\.insert\(|\.update\(|\.delete\(|sendMeta|sendWa|consume_reply|grant_credits/);
  const all=readFileSync("supabase/functions/milan-api/index.ts","utf8");
  const match=all.match(/\[flow-shadow\] test account eligible; legacy AI remains owner/g)||[];
  assert.equal(match.length,1);
});
