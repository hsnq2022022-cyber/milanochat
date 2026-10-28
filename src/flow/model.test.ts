import { test } from "node:test";
import assert from "node:assert/strict";
import { canConnect, exampleFlow, importFlow, makeNode, outputs, upsertConnection, validateDocument } from "./model.ts";

test("example keeps three pricing messages as natural terminal branches",()=>{
  const doc=exampleFlow();
  assert.equal(validateDocument(doc).filter(issue=>issue.severity==="warning"&&issue.message.includes("نهاية ضمنية")).length,3);
  assert.equal(validateDocument(doc).filter(issue=>issue.severity==="error").length,0);
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
test("v2 condition import preserves its comparison value without losing the original node id",()=>{
  const old={version:2,name:"legacy-condition",nodes:[
    {id:"start",type:"trigger",x:0,y:0,keyword:"hello",choices:[]},
    {id:"condition",type:"condition",x:0,y:120,keyword:"premium",choices:[]}
  ],edges:[{id:"route",from:"start",port:"next",to:"condition"}]};
  const restored=importFlow(old);
  assert.ok(restored);
  const condition=restored.nodes.find(n=>n.id==="condition");
  assert.ok(condition);
  assert.equal(condition.data.conditionValue,"premium");
  assert.equal(restored.edges[0].id,"route");
  assert.equal(restored.edges[0].target,"condition");
});

test("v2 condition import prefers an explicit comparison value and leaves non-condition nodes unchanged",()=>{
  const old={version:2,name:"legacy",nodes:[
    {id:"c",type:"condition",x:0,y:0,keyword:"old",conditionValue:"new",choices:[]},
    {id:"m",type:"message",x:0,y:100,text:"Hi",keyword:"unrelated",choices:[]}
  ],edges:[]};
  const restored=importFlow(old);
  assert.ok(restored);
  assert.equal(restored.nodes.find(n=>n.id==="c")?.data.conditionValue,"new");
  assert.equal(restored.nodes.find(n=>n.id==="m")?.data.conditionValue,"");
});

test("rejects invalid oversized and dangling imports",()=>{
  assert.equal(importFlow({version:3,name:"evil",nodes:[],edges:[]}),null);
  assert.equal(importFlow({version:3,name:"evil",nodes:exampleFlow().nodes,edges:[{source:"missing",target:"absent"}]}),null);
});

test("v3 export and import preserve stable graph identifiers and data",()=>{
  const before=exampleFlow();
  const result=importFlow(JSON.parse(JSON.stringify(before)));
  assert.ok(result);
  assert.deepEqual(result.nodes.map(n=>n.id),before.nodes.map(n=>n.id));
  assert.deepEqual(result.edges.map(e=>e.id),before.edges.map(e=>e.id));
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

test("reports distinct orphan nodes with clickable identities",()=>{
  const doc=exampleFlow();
  const a=makeNode("message",{x:100,y:140},{title:"منعزلة",text:"X"});
  const b=makeNode("message",{x:150,y:190},{title:"منعزلة",text:"Y"});
  doc.nodes.push(a,b);
  const issues=validateDocument(doc);
  assert.ok(issues.some(issue=>issue.nodeId===a.id&&issue.message.includes("غير قابلة للوصول")));
  assert.ok(issues.some(issue=>issue.nodeId===b.id&&issue.message.includes("غير قابلة للوصول")));
  assert.notEqual(a.id,b.id);
});
test("detects missing question exits and closed cycles",()=>{
  const doc=exampleFlow();
  const question=doc.nodes.find(n=>n.data.kind==="question")!;
  const selected=question.data.options[0];
  doc.edges=doc.edges.filter(e=>!(e.source===question.id&&e.sourceHandle===selected.id));
  assert.ok(validateDocument(doc).some(issue=>issue.nodeId===question.id&&issue.message.includes("بلا وجهة")));
  const start=doc.nodes[0],reply=doc.nodes[1];
  doc.edges=doc.edges.filter(e=>e.source!==reply.id);
  doc.edges.push({id:crypto.randomUUID(),type:"flowEdge",source:reply.id,sourceHandle:"next",target:reply.id,targetHandle:"in",data:{}});
  assert.ok(validateDocument(doc).some(issue=>issue.message.includes("دورة مغلقة")));
});

test("terminal messages and actions are warnings, but not activation errors",()=>{
  const doc=exampleFlow();
  const issues=validateDocument(doc);
  assert.equal(issues.filter(x=>x.severity==="error").length,0);
  assert.equal(issues.filter(x=>x.severity==="warning").length,3);
  assert.ok(issues.every(x=>x.nodeId&&x.message.includes("نهاية ضمنية")));
});
test("a detached message and a dangling question button remain blocking errors",()=>{
  const doc=exampleFlow();
  const orphan=makeNode("message",{x:600,y:600},{title:"معزولة",text:"مهم"});
  doc.nodes.push(orphan);
  const question=doc.nodes.find(n=>n.data.kind==="question")!;
  doc.edges=doc.edges.filter(e=>e.source!==question.id||e.sourceHandle!==question.data.options[0].id);
  const issues=validateDocument(doc);
  assert.ok(issues.some(x=>x.nodeId===orphan.id&&x.severity==="error"&&x.message.includes("غير قابلة للوصول")));
  assert.ok(issues.some(x=>x.nodeId===question.id&&x.severity==="error"&&x.message.includes("بلا وجهة")));
});

test("audit: required options reject incomplete flows before local activation",()=>{
 const scenarios:Array<{kind:string;patch:Record<string,unknown>;expected:string}>=[
  {kind:"trigger",patch:{triggerMode:"keyword",keywords:""},expected:"كلمة مفتاحية"},
  {kind:"question",patch:{inputMode:"email",inputField:""},expected:"اسم حقل الإجابة"},
  {kind:"condition",patch:{conditionField:""},expected:"حقل الشرط"},
  {kind:"condition",patch:{conditionValue:""},expected:"قيمة المقارنة"},
  {kind:"action",patch:{actionType:"tag",actionValue:""},expected:"قيمة الإجراء"},
  {kind:"action",patch:{actionType:"set_field",actionValue:"without-equals"},expected:"field=value"},
  {kind:"request",patch:{requestUrl:""},expected:"رابط HTTPS مطلوب"}
 ];
 for(const scenario of scenarios){
  const doc=exampleFlow();
  if(scenario.kind==="trigger"){
   Object.assign(doc.nodes[0].data,scenario.patch);
  }else if(scenario.kind==="question"){
   Object.assign(doc.nodes[2].data,scenario.patch);
  }else{
   const n=makeNode(scenario.kind as import("./model.ts").Kind,{x:1200,y:100},scenario.patch);
   doc.nodes.push(n);
  }
  assert.ok(validateDocument(doc).some(i=>i.severity==="error"&&i.message.includes(scenario.expected)),scenario.kind+":"+scenario.expected);
 }
});

test("typed question may be a valid terminal collection step without a next route",()=>{
 const doc=exampleFlow(),q=doc.nodes.find(n=>n.data.kind==="question")!;
 q.data={...q.data,inputMode:"email",inputField:"email"};
 doc.edges=doc.edges.filter(e=>e.source!==q.id);
 doc.nodes=doc.nodes.filter(n=>n.id===q.id||n.data.kind==="trigger"||n.data.title==="الترحيب");
 const findings=validateDocument(doc);
 assert.equal(findings.filter(i=>i.severity==="error").length,0);
 assert.ok(findings.some(i=>i.nodeId===q.id&&i.severity==="warning"&&i.message.includes("نهاية ضمنية")));
});
