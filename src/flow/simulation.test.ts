import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseWeightedPort, MAX_SIMULATOR_STEPS } from "./simulation.ts";

test("fixed seeds choose exactly the same branch on every restart",()=>{
 const branches=[{id:"A",weight:50},{id:"B",weight:25},{id:"C",weight:25}];
 const sequence=Array.from({length:75},(_,step)=>chooseWeightedPort(branches,42,step));
 assert.deepEqual(sequence,Array.from({length:75},(_,step)=>chooseWeightedPort(branches,42,step)));
 assert.equal(new Set(sequence).size,3);
});
test("weighted selector respects 100% and zero-weight branches",()=>{
 for(let step=0;step<400;step++){
  assert.equal(chooseWeightedPort([{id:"zero",weight:0},{id:"full",weight:100}],42,step),"full");
 }
 assert.equal(chooseWeightedPort([],42,0),"next");
 assert.equal(chooseWeightedPort([{id:"fallback",weight:0}],42,0),"fallback");
});
test("global step ceiling protects repeated interactions",()=>{
 assert.equal(MAX_SIMULATOR_STEPS,150);
});
