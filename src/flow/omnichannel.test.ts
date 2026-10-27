import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleFlow, importFlow, makeNode, outputs, validateDocument } from "./model.ts";
import { blankFlow, snapshotLibrary, loadLibrary, getLibraryRecoveryReport, FLOW_LIBRARY_KEY } from "./library.ts";

test("new flow starts with usable trigger and message",()=>{
  const doc=blankFlow("اختبار");
  assert.equal(doc.nodes.length,2);
  assert.equal(doc.edges.length,1);
  assert.ok(validateDocument(doc).every(issue=>!issue.message.includes("غير صالح")));
});
test("WhatsApp and Messenger channel triggers survive export and import",()=>{
  const doc=exampleFlow();
  doc.nodes[0].data.platform="whatsapp";
  doc.nodes[0].data.triggerMode="message";
  const restored=importFlow(JSON.parse(JSON.stringify(doc)));
  assert.ok(restored);
  assert.equal(restored.nodes[0].data.platform,"whatsapp");
  assert.ok(validateDocument(restored).every(issue=>!issue.message.includes("حدث البداية غير متاح")));
  restored.nodes[0].data.platform="messenger";
  restored.nodes[0].data.triggerMode="referral";
  assert.ok(validateDocument(restored).every(issue=>!issue.message.includes("حدث البداية غير متاح")));
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
  assert.ok(validateDocument(doc).every(issue=>!issue.message.includes("غير صالح")));
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
  assert.ok(validateDocument(out).every(issue=>!issue.message.includes("رابط PDF غير صالح")));
});
test("invalid URL and missing target flow are flagged before publishing",()=>{
  const doc=blankFlow("مراجعة");doc.nodes[1].data.options=[{id:"x",label:"فتح",action:"website",url:"javascript:alert(1)"}];
  assert.ok(validateDocument(doc).some(x=>x.message.includes("HTTPS")));
  doc.nodes[1].data.options=[{id:"x",label:"انتقال",action:"flow"}];
  assert.ok(validateDocument(doc).some(x=>x.message.includes("التدفق")));
});
test("library snapshot saves current document without changing other flows",()=>{
  const a=blankFlow("A"),b=blankFlow("B");
  a.name="مُعدّل";
  const state=snapshotLibrary("a",a,[{id:"a",doc:blankFlow("A")},{id:"b",doc:b}]);
  assert.equal(state.flows[0].doc.name,"مُعدّل");
  assert.equal(state.flows[1].doc.name,"B");
});

test("existing library preserves documents and enables after JSON roundtrip",()=>{
 const a=blankFlow("تدفق أول"),b=blankFlow("تدفق ثان");
 const first={activeFlowId:"first",flows:[{id:"first",doc:a,enabled:true},{id:"second",doc:b,enabled:false}]};
 const raw=JSON.parse(JSON.stringify(first));
 assert.equal(raw.flows[0].doc.version,3);
 assert.deepEqual(raw.flows[0].doc,a);
});
test("corrupt library JSON returns a fallback without overwriting stored bytes",()=>{
 const old=(globalThis as any).window, prev=(globalThis as any).localStorage;
 const data=new Map([[FLOW_LIBRARY_KEY,"{invalid-json"]]);
 (globalThis as any).window={};
 (globalThis as any).localStorage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)};
 try{
   const recovered=loadLibrary();
   assert.equal(recovered.flows.length,1);
   assert.equal(data.get(FLOW_LIBRARY_KEY),"{invalid-json");
   assert.ok(getLibraryRecoveryReport().messages.some(message=>message.includes("JSON")));
 }finally{(globalThis as any).window=old;(globalThis as any).localStorage=prev;}
});

test("cross-flow targets must exist in supplied library",()=>{
 const doc=blankFlow("الأسعار");
 doc.nodes[1].data.options=[{id:"jump",label:"اشترك",action:"flow",targetFlowId:"missing"}];
 assert.ok(validateDocument(doc,[{id:"current",doc}]).some(issue=>issue.nodeId===doc.nodes[1].id&&issue.message.includes("غير موجود")));
 assert.equal(validateDocument(doc,[{id:"current",doc},{id:"missing",doc}]).some(issue=>issue.message.includes("التدفق المستهدف")),false);
});
test("partial recovery reports skipped library items without erasing valid ones",()=>{
 const previousWindow=(globalThis as any).window,previousStorage=(globalThis as any).localStorage;
 const store=new Map([[FLOW_LIBRARY_KEY,JSON.stringify({activeFlowId:"ok",flows:[{id:"ok",doc:blankFlow("موجود")},{id:"corrupt",doc:{version:3,nodes:[],edges:[]}}]})]]);
 (globalThis as any).window={};
 (globalThis as any).localStorage={getItem:(key:string)=>store.get(key)??null,setItem:(key:string,value:string)=>store.set(key,value)};
 try{
  const restored=loadLibrary();
  assert.equal(restored.flows.length,1);
  assert.equal(restored.flows[0].id,"ok");
  assert.equal(getLibraryRecoveryReport().skipped,1);
  assert.equal(JSON.parse(store.get(FLOW_LIBRARY_KEY)!).flows.length,2);
 }finally{(globalThis as any).window=previousWindow;(globalThis as any).localStorage=previousStorage;}
});
