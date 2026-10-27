import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {inboundInsertDisposition} from "../supabase/functions/_shared/inboundInsert.ts";

test("a successful inbound insert proceeds to one reply",()=>{
  assert.equal(inboundInsertDisposition(null),"stored");
  assert.equal(inboundInsertDisposition(undefined),"stored");
});
test("a unique conflict is treated as a duplicate and never proceeds to reply",()=>{
  assert.equal(inboundInsertDisposition({code:"23505",message:"duplicate key value"}),"duplicate");
});
test("database failures cannot trigger a reply or credit deduction",()=>{
  for(const code of ["42501","23503","08006","PGRST116"])
    assert.equal(inboundInsertDisposition({code,message:"error"}),"failed");
});
test("incoming webhook explicitly handles the PostgREST error RESULT",()=>{
  const source=readFileSync(new URL("../supabase/functions/milan-api/index.ts",import.meta.url),"utf8");
  assert.match(source,/const\s*\{\s*error:\s*incomingInsertError\s*\}\s*=\s*await\s+sb/);
  assert.match(source,/inboundInsertDisposition\(incomingInsertError\)/);
  assert.match(source,/if\s*\(disposition === "duplicate"\)\s*\{[\s\S]*?return;/);
  assert.match(source,/if\s*\(disposition === "failed"\)\s*\{[\s\S]*?return;/);
});
