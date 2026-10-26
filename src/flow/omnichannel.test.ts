import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleFlow, importFlow, makeNode, outputs, validateDocument } from "./model.ts";
import { blankFlow, snapshotLibrary } from "./library.ts";

test("new flow starts with usable trigger and message",()=>{
  const doc=blankFlow("اختبار");
  assert.equal(doc.nodes.length,2);
  assert.equal(doc.edges.length,1);
  assert.deepEqual(validateDocument(doc),[]);
});
test("WhatsApp and Messenger channel triggers survive export and import",()=>{
  const doc=exampleFlow();
  doc.nodes[0].data.platform="whatsapp";
  doc.nodes[0].data.triggerMode="message";
  const restored=importFlow(JSON.parse(JSON.stringify(doc)));
  assert.ok(restored);
  assert.equal(restored.nodes[0].data.platform,"whatsapp");
  assert.deepEqual(validateDocument(restored),[]);
  restored.nodes[0].data.platform="messenger";
  restored.nodes[0].data.triggerMode="referral";
  assert.deepEqual(validateDocument(restored),[]);
});
test("button linked to another flow has no outgoing handle",()=>{
  const q=makeNode("question",{x:0,y:0},{options:[
    {id:"iraq",label:"العراق",action:"flow",targetFlowId:"second"},
    {id:"oman",label:"عمان",action:"step"}
  ]});
  assert.deepEqual(outputs(q).map(x=>x.id),["oman"]);
  const doc=exampleFlow();const qIn=doc.nodes.find(x=>x.data.kind==="question")!;
  qIn.data.options=[{id:"flow",label:"الأسعار",action:"flow",targetFlowId:"secondary"}];
  doc.edges=doc.edges.filter(e=>e.source!==qIn.id);
  assert.deepEqual(validateDocument(doc),[]);
});
test("rich PDF, delay and collection content is imported without losing existing text",()=>{
  const doc=blankFlow("محتوى");const msg=doc.nodes[1];
  msg.data.contentBlocks=[
    {id:"p",type:"pdf",url:"https://example.com/price.pdf"},
    {id:"d",type:"delay",seconds:2},
    {id:"c",type:"collection",text:"اكتب هاتفك",inputMode:"phone",field:"phone"}
  ];
  msg.data.options=[{id:"web",label:"فتح الأسعار",action:"website",url:"https://example.com"}];
  const out=importFlow(JSON.parse(JSON.stringify(doc)));
  assert.ok(out);
  assert.equal(out.nodes[1].data.contentBlocks.length,3);
  assert.equal(out.nodes[1].data.options[0].action,"website");
  assert.deepEqual(validateDocument(out),[]);
});
test("invalid URL and missing target flow are flagged before publishing",()=>{
  const doc=blankFlow("مراجعة");doc.nodes[1].data.options=[{id:"x",label:"فتح",action:"website",url:"javascript:alert(1)"}];
  assert.ok(validateDocument(doc).some(x=>x.includes("HTTPS")));
  doc.nodes[1].data.options=[{id:"x",label:"انتقال",action:"flow"}];
  assert.ok(validateDocument(doc).some(x=>x.includes("التدفق")));
});
test("library snapshot saves current document without changing other flows",()=>{
  const a=blankFlow("A"),b=blankFlow("B");
  a.name="مُعدّل";
  const state=snapshotLibrary("a",a,[{id:"a",doc:blankFlow("A")},{id:"b",doc:b}]);
  assert.equal(state.flows[0].doc.name,"مُعدّل");
  assert.equal(state.flows[1].doc.name,"B");
});
