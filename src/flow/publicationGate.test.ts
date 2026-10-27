import {test} from "node:test";
import assert from "node:assert/strict";
import {edgeFor,makeNode} from "./model.ts";
import type {FlowDocument} from "./model.ts";
import {auditFlowPublication} from "./publicationGate.ts";

function minimal(){
 const start=makeNode("trigger",{x:0,y:0},{triggerMode:"message",platform:"instagram"});
 const msg=makeNode("message",{x:0,y:250},{text:"أهلًا بك",options:[]});
 const doc:FlowDocument={version:3,name:"مرحبًا",nodes:[start,msg],
   edges:[edgeFor({source:start.id,sourceHandle:"next",target:msg.id,targetHandle:"in"})]};
 return doc;
}
test("publishing fails closed while no real channel runtime exists",()=>{
 const doc=minimal(),before=JSON.stringify(doc);
 const result=auditFlowPublication(doc);
 assert.equal(result.canPublish,false);
 assert.ok(result.issues.some(x=>x.capability==="execution-engine"&&x.severity==="error"));
 assert.equal(JSON.stringify(doc),before,"No schema or local draft changes");
});
test("publish audit reports all server capabilities, not fictitious working buttons",()=>{
 const doc=minimal();
 doc.nodes[1].data.options=[{id:"button",label:"موقعنا",action:"website",url:"https://example.com"}];
 doc.nodes[1].data.contentBlocks=[{id:"image",type:"image",url:"https://example.com/image.png"}];
 const result=auditFlowPublication(doc);
 assert.equal(result.canPublish,false);
 for(const c of ["message:link","message:image","execution-engine"])
   assert.ok(result.required.includes(c as any),c);
});
test("server-supplied complete capabilities accept minimal connected text flow",()=>{
 const result=auditFlowPublication(minimal(),new Set(["execution-engine","instagram","trigger:message","message:text"]));
 assert.equal(result.canPublish,true);
 assert.equal(result.issues.filter(x=>x.severity==="error").length,0);
});
test("validator blockers cannot be bypassed by claiming every capability",()=>{
 const doc=minimal();
 doc.edges=[];
 const result=auditFlowPublication(doc,new Set(["execution-engine","instagram","trigger:message","message:text"]));
 assert.equal(result.canPublish,false);
 assert.ok(result.issues.some(x=>x.severity==="error"));
});
