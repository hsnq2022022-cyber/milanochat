import {test} from "node:test";
import {strict as assert} from "node:assert";
import {processExclusiveEvent} from "../supabase/functions/milan-api/exclusiveMessageClaim.ts";
import {simpleMessageFromDocument} from "../supabase/functions/milan-api/flowPrepareMessage.ts";

const owner = (route="legacy_ai") => ({acquired:true,route,outgoing_message_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"});
function fixture({switchOn=false,engineBroken=false}={}){
 let sent=0,billed=0,oldAI=0,prepared=0,stored=0;
 let held=false;
 const deps={
  async prepareFlow(){prepared++;if(engineBroken)throw Error("runtime unavailable");return switchOn?"Flow answer":null;},
  async claim(ready){
   await Promise.resolve();
   if(held)return {...owner(ready&&switchOn?"flow":"legacy_ai"),acquired:false};
   held=true;return owner(ready&&switchOn?"flow":"legacy_ai");
  },
  async legacyAnswer(){oldAI++;return "Legacy answer";},
  async send(){sent++;},
  async persistSent(){stored++;return true;},
  async debit(){billed++;return 4}
 };
 return {deps,snapshot:()=>({sent,billed,oldAI,prepared,stored})};
}
test("single event -> exactly one provider send and one debit",async()=>{
 const f=fixture();
 assert.equal(await processExclusiveEvent(f.deps),"sent_and_billed");
 assert.deepEqual(f.snapshot(),{sent:1,billed:1,oldAI:1,prepared:1,stored:1});
});
test("same webhook twice -> no duplicate send or charge",async()=>{
 const f=fixture();
 assert.equal(await processExclusiveEvent(f.deps),"sent_and_billed");
 assert.equal(await processExclusiveEvent(f.deps),"duplicate");
 assert.equal(f.snapshot().sent,1);assert.equal(f.snapshot().billed,1);
});
test("two concurrent attempts -> only one outgoing and one credit",async()=>{
 const f=fixture();
 const outcomes=await Promise.all([processExclusiveEvent(f.deps),processExclusiveEvent(f.deps)]);
 assert.deepEqual(outcomes.sort(),["duplicate","sent_and_billed"]);
 assert.equal(f.snapshot().sent,1);assert.equal(f.snapshot().billed,1);
});
test("global OFF -> legacy AI exclusively responds",async()=>{
 const f=fixture({switchOn:false});
 assert.equal(await processExclusiveEvent(f.deps),"sent_and_billed");
 assert.equal(f.snapshot().oldAI,1);assert.equal(f.snapshot().sent,1);
});
test("engine throws before claim -> legacy AI exclusively responds",async()=>{
 const f=fixture({switchOn:true,engineBroken:true});
 assert.equal(await processExclusiveEvent(f.deps),"sent_and_billed");
 assert.equal(f.snapshot().oldAI,1);assert.equal(f.snapshot().sent,1);
});
test("flow enabled and healthy -> flow text without invoking old AI",async()=>{
 const f=fixture({switchOn:true});
 assert.equal(await processExclusiveEvent(f.deps),"sent_and_billed");
 assert.equal(f.snapshot().oldAI,0);assert.equal(f.snapshot().sent,1);
});
test("DB claim unavailable: never send to avoid duplicate",async()=>{
 const f=fixture();
 f.deps.claim=async()=>{throw Error("db unavailable");};
 assert.equal(await processExclusiveEvent(f.deps),"claim_failed");
 assert.equal(f.snapshot().sent,0);
});
test("network send error: at most one attempt; no double billing",async()=>{
 const f=fixture();
 f.deps.send=async()=>{throw Error("ambiguous provider delivery");};
 assert.equal(await processExclusiveEvent(f.deps),"send_failed");
 assert.equal(await processExclusiveEvent(f.deps),"duplicate");
 assert.equal(f.snapshot().billed,0);
});
test("safe flow subset accepts one trigger->message only",()=>{
 const doc={version:3,name:"x",nodes:[
  {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
  {id:"msg",data:{kind:"message",text:"Hello",options:[],contentBlocks:[],image:""}}],
  edges:[{source:"start",target:"msg",sourceHandle:"next"}]};
 assert.equal(simpleMessageFromDocument(doc,"instagram"),"Hello");
 assert.equal(simpleMessageFromDocument(doc,"facebook"),null);
 assert.equal(simpleMessageFromDocument({...doc,edges:[]},"instagram"),null);
 assert.equal(simpleMessageFromDocument({...doc,nodes:[...doc.nodes,{id:"http",data:{kind:"request"}}]},"instagram"),null);
});
