import { test } from "node:test";
import assert from "node:assert/strict";
import { canConnect, exampleFlow, importFlow, makeNode, outputs, upsertConnection, validateDocument } from "./model.ts";

test("example keeps three pricing messages as natural terminal branches",()=>{
  const doc=exampleFlow();
  assert.deepEqual(validateDocument(doc),[]);
  assert.equal(doc.nodes.filter(n=>n.data.kind==="message").length,4);
});
test("reject self-loop and edges into trigger",()=>{
  const doc=exampleFlow(),a=doc.nodes[0],b=doc.nodes[1];
  assert.equal(canConnect({source:b.id,target:b.id,sourceHandle:"next",targetHandle:"in"},doc),false);
  assert.equal(canConnect({source:b.id,target:a.id,sourceHandle:"next",targetHandle:"in"},doc),false);
});
test("reconnecting an outgoing handle replaces the previous destination",()=>{
  const doc=exampleFlow(),n=doc.nodes.find(n=>n.data.title==="الترحيب")!,another=doc.nodes[3];
  const after=upsertConnection(doc,{source:n.id,target:another.id,sourceHandle:"next",targetHandle:"in"});
  assert.equal(after.edges.filter(e=>e.source===n.id&&e.sourceHandle==="next").length,1);
  assert.equal(after.edges.find(e=>e.source===n.id)?.target,another.id);
});
test("condition and randomizer expose independent source handles",()=>{
  const c=makeNode("condition",{x:0,y:0});
  const r=makeNode("randomizer",{x:0,y:0});
  assert.deepEqual(outputs(c).map(p=>p.id),["yes","no"]);
  assert.equal(outputs(r).length,2);
});
test("imports previous version two drafts safely",()=>{
  const old={version:2,name:"old",nodes:[{id:"a",type:"trigger",x:0,y:0,title:"بداية",text:"",keyword:"hello",image:"",delay:30,choices:[]},{id:"b",type:"message",x:0,y:200,title:"مرحبا",text:"hello",keyword:"",image:"",delay:30,choices:[]}],edges:[{id:"ab",from:"a",port:"next",to:"b"}]};
  const result=importFlow(old);
  assert.ok(result);
  assert.equal(result.nodes.length,2);
  assert.equal(result.edges[0].target,"b");
});
test("rejects invalid oversized and dangling imports",()=>{
  assert.equal(importFlow({version:3,name:"evil",nodes:[],edges:[]}),null);
  assert.equal(importFlow({version:3,name:"evil",nodes:exampleFlow().nodes,edges:[{source:"missing",target:"absent"}]}),null);
});

test("v3 export and import preserve stable graph identifiers and data",()=>{
  const before=exampleFlow();
  const result=importFlow(JSON.parse(JSON.stringify(before)));
  assert.ok(result);
  assert.deepEqual(result,before);
});
test("v2 importer preserves original IDs and existing edge ports",()=>{
  const old={version:2,name:"old",nodes:[
    {id:"trigger-one",type:"trigger",x:20,y:20,title:"بداية",keyword:"hello",choices:[]},
    {id:"reply-one",type:"message",x:20,y:220,title:"رد",text:"مرحباً",choices:[]}
  ],edges:[{id:"edge-one",from:"trigger-one",port:"next",to:"reply-one"}]};
  const restored=importFlow(old);
  assert.ok(restored);
  assert.deepEqual(restored.nodes.map(n=>n.id),["trigger-one","reply-one"]);
  assert.equal(restored.edges[0].id,"edge-one");
  assert.equal(restored.edges[0].sourceHandle,"next");
});
