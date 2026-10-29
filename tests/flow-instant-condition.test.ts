import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {simpleMessageFromDocument} from "../supabase/functions/milan-api/flowPrepareMessage.ts";

const valid=()=>({
 version:3,name:"Instant condition",nodes:[
  {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
  {id:"test",data:{kind:"condition",conditionField:"message",operator:"contains",conditionValue:"سعر"}},
  {id:"yes",data:{kind:"message",text:"هذه الأسعار",image:"",options:[],contentBlocks:[]}},
  {id:"no",data:{kind:"message",text:"كيف نساعدك؟",image:"",options:[],contentBlocks:[]}}
 ],edges:[
  {source:"start",target:"test",sourceHandle:"next"},
  {source:"test",target:"yes",sourceHandle:"yes"},
  {source:"test",target:"no",sourceHandle:"no"}
 ]
});
test("Arabic inbound condition routes yes/no, irrespective of array order",()=>{
 const d=valid();
 assert.equal(simpleMessageFromDocument(d,"instagram","ما هو سعر الخدمة؟"),"هذه الأسعار");
 assert.equal(simpleMessageFromDocument(d,"instagram","أهلاً"),"كيف نساعدك؟");
 assert.equal(simpleMessageFromDocument({...d,nodes:[...d.nodes].reverse(),edges:[...d.edges].reverse()},"instagram","سعر"),"هذه الأسعار");
});
test("equals, not_equals and exists have bounded matching semantics",()=>{
 const d=valid(),c=d.nodes[1].data;
 c.operator="equals"; c.conditionValue="أهلاً";
 assert.equal(simpleMessageFromDocument(d,"instagram","أهلاً"),"هذه الأسعار");
 assert.equal(simpleMessageFromDocument(d,"instagram","اهلا"),"كيف نساعدك؟");
 c.operator="not_equals";
 assert.equal(simpleMessageFromDocument(d,"instagram","أهلاً"),"كيف نساعدك؟");
 assert.equal(simpleMessageFromDocument(d,"instagram","غير مطابق"),"هذه الأسعار");
 c.operator="exists";
 assert.equal(simpleMessageFromDocument(d,"instagram",""),"كيف نساعدك؟");
 assert.equal(simpleMessageFromDocument(d,"instagram","x"),"هذه الأسعار");
});
test("foreign account, unsupported nodes, malformed graph, and unsafe condition fail closed",()=>{
 const d=valid();
 assert.equal(simpleMessageFromDocument(d,"facebook","سعر"),null);
 assert.equal(simpleMessageFromDocument(d,"instagram","x".repeat(4097)),null);
 assert.equal(simpleMessageFromDocument({...d,nodes:[...d.nodes,{id:"action",data:{kind:"action"}}]},"instagram","سعر"),null);
 assert.equal(simpleMessageFromDocument({...d,edges:[d.edges[0],d.edges[1],d.edges[1]]},"instagram","سعر"),null);
 assert.equal(simpleMessageFromDocument({...d,nodes:d.nodes.map(n=>n.id==="test"?{...n,data:{...n.data,conditionField:"other"}}:n)},"instagram","سعر"),null);
 assert.equal(simpleMessageFromDocument({...d,nodes:d.nodes.map(n=>n.id==="test"?{...n,data:{...n.data,operator:"code"}}:n)},"instagram","سعر"),null);
 assert.equal(simpleMessageFromDocument({...d,nodes:d.nodes.map(n=>n.id==="yes"?{...n,data:{...n.data,options:[{label:"send"}]}}:n)},"instagram","سعر"),null);
});
test("the real webhook passes customer text and the activation manifest recognizes only the condition capability",()=>{
 const webhook=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const publication=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 assert.match(webhook,/sb, tenantId, String\(account\.id\), channel, customerText/);
 assert.match(publication,/"message:text","condition"/);
 assert.doesNotMatch(publication,/"condition","delay"/);
});
