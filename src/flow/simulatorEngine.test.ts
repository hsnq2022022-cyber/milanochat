import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeFor, exampleFlow, makeNode } from "./model.ts";
import type { FlowDocument, FlowNode } from "./model.ts";
import { COMPLETED_TEXT, DEAD_END_TEXT, delayText, interpolate, respond, startSimulation } from "./simulatorEngine.ts";
import type { SimEvent } from "./simulatorEngine.ts";
import { MAX_SIMULATOR_STEPS } from "./simulation.ts";

const node=(kind:FlowNode["data"]["kind"],data:Partial<FlowNode["data"]>={},id?:string)=>{
  const n=makeNode(kind,{x:0,y:0},data);if(id)n.id=id;return n;
};
const link=(a:FlowNode,port:string,b:FlowNode)=>edgeFor({source:a.id,sourceHandle:port,target:b.id,targetHandle:"in"});
const ctx=(doc:FlowDocument)=>({doc,flowId:"f1",flows:[{id:"f1",doc}]});
const texts=(events:SimEvent[])=>events.map(e=>e.text);
const doc=(nodes:FlowNode[],edges:ReturnType<typeof link>[]):FlowDocument=>({version:3,name:"t",nodes,edges});

test("dead end after the last message is NOT a completion (old bug)",()=>{
  const d=exampleFlow(),c=ctx(d);
  const s=startSimulation(c,"اشتراكات");
  assert.equal(s.cursor.status,"waiting");
  assert.ok(!texts(s.events).includes(COMPLETED_TEXT));
  const q=d.nodes[2];
  const r=respond(c,s.cursor,{type:"choice",optionId:q.data.options[1].id});
  assert.deepEqual(texts(r.events).slice(0,2),["عمان","تواصل ويانا لمعرفة الأسعار الحالية لخدمتك في عمان."]);
  assert.equal(r.cursor.status,"deadend");
  assert.ok(texts(r.events).includes(DEAD_END_TEXT));
  assert.ok(!texts(r.events).includes(COMPLETED_TEXT));
  // Further input after the dead end does nothing.
  assert.deepEqual(respond(c,r.cursor,{type:"text",text:"مرحبا"}).events,[]);
});

test("completion only at End; arbitrary text mid-flow asks to choose",()=>{
  const t=node("trigger"),q=node("question",{text:"اختر",options:[{id:"a",label:"أ"},{id:"b",label:"ب"}]}),e=node("end");
  const d=doc([t,q,e],[link(t,"next",q),link(q,"a",e),link(q,"b",e)]),c=ctx(d);
  const s=startSimulation(c);
  const mid=respond(c,s.cursor,{type:"text",text:"كلام عشوائي"});
  assert.equal(mid.cursor.status,"waiting");
  assert.ok(!texts(mid.events).includes(COMPLETED_TEXT));
  assert.equal(mid.events.at(-1)?.type,"bot");
  const typedLabel=respond(c,mid.cursor,{type:"text",text:"ب"});
  assert.equal(typedLabel.cursor.status,"end");
  assert.equal(typedLabel.events.at(-1)?.text,COMPLETED_TEXT);
});

test("buttons route by option id (sourceHandle), not by edge label",()=>{
  const t=node("trigger"),q=node("question",{text:"اختر",options:[{id:"o1",label:"ذهب"},{id:"o2",label:"فضة"}]});
  const gold=node("message",{text:"فرع الذهب"}),silver=node("message",{text:"فرع الفضة"});
  const e1=link(q,"o1",gold),e2=link(q,"o2",silver);
  e1.data={label:"فضة"};e2.data={label:"ذهب"};
  const c=ctx(doc([t,q,gold,silver],[link(t,"next",q),e1,e2]));
  const r=respond(c,startSimulation(c).cursor,{type:"choice",optionId:"o2"});
  assert.ok(texts(r.events).includes("فرع الفضة"));
  assert.ok(!texts(r.events).includes("فرع الذهب"));
});

test("typed question validates, stores the variable and interpolates it",()=>{
  const t=node("trigger"),q=node("question",{text:"بريدك؟",inputMode:"email",inputField:"email"});
  const m=node("message",{text:"شكرًا {{ first_name }}، سنراسلك على {{email}} {{unknown}}."}),e=node("end");
  const c=ctx(doc([t,q,m,e],[link(t,"next",q),link(q,"valid",m),link(m,"next",e)]));
  const s=startSimulation(c);
  assert.deepEqual(s.cursor.wait&&{type:s.cursor.wait.type,field:(s.cursor.wait as {field:string}).field},{type:"input",field:"email"});
  const bad=respond(c,s.cursor,{type:"text",text:"not-mail"});
  assert.equal(bad.cursor.status,"waiting");
  assert.equal((bad.events[1] as {retry?:boolean}).retry,true);
  const ok=respond(c,bad.cursor,{type:"text",text:"a@b.co"});
  assert.equal(ok.cursor.variables.email,"a@b.co");
  assert.ok(texts(ok.events).includes("شكرًا عميلنا العزيز، سنراسلك على a@b.co ."));
  assert.equal(ok.cursor.status,"end");
});

test("condition yes/no, delay note with real unit, action and request are local",()=>{
  const t=node("trigger"),a=node("action",{actionType:"set_field",actionValue:"tier=gold"});
  const cond=node("condition",{conditionField:"tier",operator:"equals",conditionValue:"GOLD"});
  const dl=node("delay",{delayValue:4,delayUnit:"minutes"}),req=node("request",{requestUrl:"https://x.test"});
  const yes=node("message",{text:"نعم"}),no=node("message",{text:"لا"}),e=node("end");
  const c=ctx(doc([t,a,cond,dl,req,yes,no,e],[link(t,"next",a),link(a,"next",cond),link(cond,"yes",dl),link(cond,"no",no),
    link(dl,"next",req),link(req,"error",yes),link(yes,"next",e)]));
  const s=startSimulation(c);
  const delay=s.events.find(x=>x.type==="delay")!;
  assert.equal(delay.text,"⏳ ينتظر 4 دقائق…");
  assert.equal((delay as {ms:number}).ms,240000);
  assert.ok(texts(s.events).includes("نعم"));
  assert.ok(!texts(s.events).includes("لا"));
  assert.equal(s.cursor.status,"end");
  assert.equal(delayText(1,"hours"),"⏳ ينتظر ساعة…");
  assert.equal(delayText(2,"days"),"⏳ ينتظر يومين…");
});

test("goto cycles stop at the step cap without claiming completion",()=>{
  const t=node("trigger"),g=node("goto",{},"g");g.data.gotoNode="g";
  const c=ctx(doc([t,g],[link(t,"next",g)]));
  const s=startSimulation(c);
  assert.equal(s.cursor.status,"stopped");
  assert.equal(s.cursor.stepCount,MAX_SIMULATOR_STEPS);
  assert.ok(!texts(s.events).includes(COMPLETED_TEXT));
});

test("collection blocks collect typed answers and resume the remaining blocks",()=>{
  const t=node("trigger"),m=node("message",{text:"أهلًا",contentBlocks:[
    {id:"b1",type:"collection",text:"رقمك؟",field:"phone",inputMode:"phone"},
    {id:"b2",type:"text",text:"تم حفظ {{phone}}"}]}),e=node("end");
  const c=ctx(doc([t,m,e],[link(t,"next",m),link(m,"next",e)]));
  const s=startSimulation(c);
  assert.deepEqual(texts(s.events),["أهلًا","رقمك؟"]);
  const r=respond(c,s.cursor,{type:"text",text:"٠٧٧٠١٢٣٤٥٦٧"});
  assert.deepEqual(texts(r.events),["٠٧٧٠١٢٣٤٥٦٧","تم حفظ 07701234567",COMPLETED_TEXT]);
});

test("interpolate never leaves raw braces",()=>{
  assert.equal(interpolate("مرحبا {{first_name}} {{x}}!",{}),"مرحبا عميلنا العزيز !");
  assert.equal(interpolate("{{name}}",{name:"سارة"}),"سارة");
});
