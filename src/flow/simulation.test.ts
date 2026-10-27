import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseWeightedPort, MAX_SIMULATOR_STEPS, normalizeArabicDigits, validCustomerInput } from "./simulation.ts";

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

test("typed question field validations cover normal text, email, phone and number",()=>{
 const cases:[string,string,boolean][]=[
  ["text","مرحبا",true],["text","   ",false],
  ["email","someone@example.com",true],["email","someone.example.com",false],["email","someone@",false],
  ["phone","+964 770 123 4567",true],["phone","٠٧٧٠١٢٣٤٥٦٧",true],["phone","abc1234567",false],["phone","1234",false],
  ["number","123.50",true],["number","١٢٣٫٥",false],["number","۱۲۳",true],
  ["number","12abc",false],["number","Infinity",false],["number"," ",false]
 ];
 for(const [mode,value,valid] of cases)assert.equal(validCustomerInput(mode,value),valid,mode+":"+value);
 assert.equal(normalizeArabicDigits("٠٧٧٠ ۱۲۳٤"),"0770 1234");
});
