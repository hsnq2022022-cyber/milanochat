import {test} from "node:test";
import assert from "node:assert/strict";
import {edgeFor,makeNode} from "./model.ts";
import type {FlowDocument} from "./model.ts";
import {auditFlowPublication} from "./publicationGate.ts";
import {readFileSync} from "node:fs";

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

// ---- Image blocks: activation needs message:image from the SERVER AND FLOW_MEDIA_SEND_ENABLED.
import {flowNeedsMedia,parseCapabilities,mediaActivationAllowed,withMediaGate} from "./publicationGate.ts";
const IMG="https://abcd1234.supabase.co/storage/v1/object/public/flow-media/u1/0f8c2b1e-1111-4222-8333-444455556666.webp";
test("needsMedia is derived from the document: image blocks or legacy node images only",()=>{
 const doc=minimal();
 assert.equal(flowNeedsMedia(doc),false);
 doc.nodes[1].data.contentBlocks=[{id:"t",type:"text",text:"x"},{id:"p",type:"pdf",url:IMG}];
 assert.equal(flowNeedsMedia(doc),false,"text/pdf blocks are not image media");
 doc.nodes[1].data.contentBlocks=[{id:"t",type:"text",text:"x"},{id:"i",type:"image",url:IMG}];
 assert.equal(flowNeedsMedia(doc),true);
 const legacy=minimal();legacy.nodes[1].data.image=IMG;
 assert.equal(flowNeedsMedia(legacy),true);
 for(const bad of [null,undefined,"x",42,{},{nodes:"x"},{nodes:[null,{data:null},{data:{kind:"trigger",image:IMG}}]}])
  assert.equal(flowNeedsMedia(bad),false,JSON.stringify(bad));
});
test("message:image counts only with FLOW_MEDIA_SEND_ENABLED; pdf stays refused; default set unchanged",()=>{
 const caps=parseCapabilities(" execution-engine, instagram ,trigger:message,message:text,message:image,,");
 assert.deepEqual(caps,["execution-engine","instagram","trigger:message","message:text","message:image"]);
 assert.equal(mediaActivationAllowed(caps,true),true);
 assert.equal(mediaActivationAllowed(caps,false),false,"flag off");
 assert.equal(mediaActivationAllowed(caps.filter(c=>c!=="message:image"),true),false,"capability missing");
 assert.equal(mediaActivationAllowed(["message:pdf","message:text"],true),false,"pdf never implies image");
 const doc=minimal();
 doc.nodes[1].data.contentBlocks=[{id:"i",type:"image",url:IMG}];
 assert.equal(auditFlowPublication(doc,withMediaGate(caps,true)).canPublish,true,"flag on + capability");
 const off=auditFlowPublication(doc,withMediaGate(caps,false));
 assert.equal(off.canPublish,false,"flag off: message:image removed");
 assert.ok(off.issues.some(x=>x.capability==="message:image"&&x.severity==="error"));
 assert.equal(auditFlowPublication(doc,withMediaGate(caps.filter(c=>c!=="message:image"),true)).canPublish,false);
 // PDF is refused even with every media switch on.
 const pdf=minimal();pdf.nodes[1].data.contentBlocks=[{id:"p",type:"pdf",url:IMG}];
 assert.equal(auditFlowPublication(pdf,withMediaGate(caps,true)).canPublish,false);
 assert.ok(auditFlowPublication(pdf,withMediaGate(caps,true)).issues.some(x=>x.capability==="message:pdf"));
 // The non-canary default set (flow-publication) has no media capability.
 const api=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 assert.ok(api.includes(`new Set<FlowCapability>(["execution-engine","instagram","trigger:message","message:text","condition"])`));
});
test("website buttons: message:link capability required; 4 buttons or text over 640 never publishable",()=>{
 const caps=new Set(["execution-engine","instagram","trigger:message","message:text","message:link"] as const);
 const web=(n:number,text="تفضل")=>{
  const doc=minimal();
  doc.nodes[1].data.text=text;
  doc.nodes[1].data.options=Array.from({length:n},(_,i)=>({id:"w"+i,label:"زر "+i,buttonType:"button" as const,action:"website" as const,url:"https://example.com/"+i}));
  return doc;
 };
 assert.equal(auditFlowPublication(web(3),caps as any).canPublish,true);
 const noLink=auditFlowPublication(web(1),new Set(["execution-engine","instagram","trigger:message","message:text"]));
 assert.equal(noLink.canPublish,false);
 assert.ok(noLink.issues.some(x=>x.capability==="message:link"));
 assert.equal(auditFlowPublication(web(4),caps as any).canPublish,false);
 assert.equal(auditFlowPublication(web(1,"ن".repeat(641)),caps as any).canPublish,false);
 assert.equal(auditFlowPublication(web(1,"ن".repeat(640)),caps as any).canPublish,true);
});
