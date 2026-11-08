import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importFlow } from "../src/flow/model.ts";

const gold=JSON.parse(readFileSync(new URL("./fixtures/flow-main-compat.json",import.meta.url),"utf8")) as {
  source:string;cases:Array<{name:string;input:unknown;expected:unknown}>;
};
test("golden fixtures were generated from main importer and cover all six scenarios",()=>{
  assert.equal(gold.source,"origin/main:src/flow/model.ts");
  assert.equal(gold.cases.length,7);
  const names=gold.cases.map(c=>c.name);
  for(const name of ["v2-simple","v3-simple","v3-buttons-actions","v3-image-pdf","v3-randomizer","v3-multiple-flows-primary","v3-multiple-flows-secondary"]){
    assert.ok(names.includes(name),name);
  }
});
/* Fields added after main (comment triggers). Old documents must load with exactly these defaults, and
   every other field must stay byte-identical to the main importer output. */
const ADDED=["commentScope","commentPostId","commentMatchType","publicReplyText"];
for(const {name,input,expected} of gold.cases){
  test("no import output regression against main: "+name,()=>{
    const actual=JSON.parse(JSON.stringify(importFlow(input)));
    for(const n of actual.nodes){
      const d=n.data as Record<string,unknown>;
      assert.equal(d.commentScope,"all");
      assert.equal(d.commentPostId,"");
      assert.equal(d.publicReplyText,"");
      assert.equal(d.commentMatchType,String(d.keywords||"").trim()?"keyword":"any");
      for(const k of ADDED)delete d[k];
    }
    assert.deepEqual(actual,expected);
  });
}
