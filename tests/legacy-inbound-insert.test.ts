import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {persistInboundOnce} from "../supabase/functions/milan-api/persistInboundOnce.ts";

test("successful PostgREST insert is accepted exactly once",async()=>{
 let calls=0;
 const status=await persistInboundOnce(async()=>{calls++;return {error:null};});
 assert.equal(status,"saved");
 assert.equal(calls,1);
});
test("Postgres unique index 23505 prevents a second AI reply",async()=>{
 assert.equal(await persistInboundOnce(async()=>({error:{code:"23505"}})),"duplicate");
});
test("database failures returned as data must stop replies, not silently continue",async()=>{
 for(const code of ["42501","23503","PGRST116","08006","42P01","unknown"]){
  assert.equal(await persistInboundOnce(async()=>({error:{code}})),"failed");
 }
});
test("transport failures and empty database responses fail closed",async()=>{
 assert.equal(await persistInboundOnce(async()=>{throw Error("connection reset");}),"failed");
 assert.equal(await persistInboundOnce(async()=>null),"failed");
 assert.equal(await persistInboundOnce(async()=>undefined),"failed");
});
test("no duplicate ID or PII is logged by the new integration",()=>{
 const source=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const helper=readFileSync("supabase/functions/milan-api/persistInboundOnce.ts","utf8");
 const idx=source.indexOf("const incomingResult = await persistInboundOnce");
 const failed=source.indexOf('if (incomingResult !== "saved")',idx);
 const rag=source.indexOf("await answerFromKnowledge(",failed);
 assert.ok(idx>=0&&failed>idx&&rag>failed);
 const block=source.slice(failed,rag);
 assert.match(block,/return;/);
 assert.doesNotMatch(block,/\$\{externalMsgId\}|\$\{customerText\}/);
 assert.match(source,/import \{ persistInboundOnce \} from "\.\/persistInboundOnce\.ts";/);
 assert.doesNotMatch(helper,/sendMetaDirectMessage|sendWa|consume_reply|grant_credits/);
});
