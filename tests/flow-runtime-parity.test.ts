// Editor palette/validation/publication/simulator/runtime must AGREE on what can run.
// For every shape the editor offers: structurally unsupported => validation error, publication refused
// (Arabic reason), simulator stops (never "completed"), palette/trigger list mark it unavailable.
// Supported => none of those flag it AND the real durable engine plans and executes it.
// Server-side validation stays authoritative (preparePublishedDocument / runtimeUnsupportedRejection);
// the UI layers only mirror it. Account-level availability (buttons, delays, images, ...) is a separate
// per-account capability (flow-publication/capabilities.ts) and is not asserted here.
// Run: node --experimental-strip-types --test tests/flow-runtime-parity.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {edgeFor,makeNode,outputs,validateDocument,TRIGGER_OPTIONS,KIND_LIST,exampleFlow}
 from "../src/flow/model.ts";
import type {FlowDocument,FlowData,FlowNode,Kind,Platform} from "../src/flow/model.ts";
import {deriveRequirements,nodeRequirements} from "../src/flow/requirements.ts";
import {RUNTIME_TRIGGER_MODES,isRuntimeTriggerMode,runtimeUnsupportedIssues,staticUnsupportedReasons,
 unsupportedByNode,UNSUPPORTED_TEXT,unsupportedText,validateForRuntime} from "../src/flow/runtimeSupport.ts";
import {preparePublishedDocument,runtimeUnsupportedRejection,providerPlatform}
 from "../src/flow/serverPublicationValidation.ts";
import {startSimulation,COMPLETED_TEXT} from "../src/flow/simulatorEngine.ts";
import {createRuntimeState} from "../src/flow/runtimePlan.ts";
import {planUntilWait,seedFromEventKey} from "../src/flow/runtimeChain.ts";
import {supportedDurableDocument,durableNeedsInternalActions} from "../supabase/functions/milan-api/flowDurableIngress.ts";

const ARABIC=/[؀-ۿ]/;
/** trigger -> node -> end, wired through the node's first output port. */
function chain(platform:Platform,trigger:Partial<FlowData>,node?:{kind:Kind;data?:Partial<FlowData>}):FlowDocument{
 const t=makeNode("trigger",{x:0,y:0},{platform,triggerMode:"message",...trigger});
 const nodes:FlowNode[]=[t];
 const edges=[] as FlowDocument["edges"];
 let prev=t;
 if(node){
  const n=makeNode(node.kind,{x:0,y:150},node.data);
  nodes.push(n);
  edges.push(edgeFor({source:prev.id,sourceHandle:"next",target:n.id,targetHandle:"in"}));
  prev=n;
 }
 const e=makeNode("end",{x:0,y:300});
 nodes.push(e);
 const port=outputs(prev)[0]?.id??"next";
 edges.push(edgeFor({source:prev.id,sourceHandle:port,target:e.id,targetHandle:"in"}));
 return {version:3,name:"parity",nodes,edges};
}

/* name, document, expected structural reason */
const UNSUPPORTED:Array<[string,FlowDocument,string]>=[
 ["story-reply trigger",chain("instagram",{triggerMode:"story"}),"trigger_not_supported"],
 ["ad-click trigger",chain("instagram",{triggerMode:"ad"}),"trigger_not_supported"],
 ["live-comment trigger",chain("instagram",{triggerMode:"live"}),"trigger_not_supported"],
 ["messenger referral trigger",chain("messenger",{triggerMode:"referral"}),"trigger_not_supported"],
 ["HTTP request",chain("instagram",{},{kind:"request",data:{requestUrl:"https://example.com/x"}}),"http_request_not_supported"],
 ["number question",chain("instagram",{},{kind:"question",data:{text:"كم؟",inputMode:"number",inputField:"n"}}),"number_question_not_supported"],
 ["PDF block",chain("instagram",{},{kind:"message",data:{text:"ملف",contentBlocks:[{id:"b1",type:"pdf",url:"https://example.com/a.pdf"} as never]}}),"pdf_not_supported"],
 ["data-collection block",chain("instagram",{},{kind:"message",data:{text:"س",contentBlocks:[{id:"b1",type:"collection",text:"?",field:"p",inputMode:"phone"} as never]}}),"content_blocks_not_supported"],
 ["inline delay block",chain("instagram",{},{kind:"message",data:{text:"س",contentBlocks:[{id:"b1",type:"delay"} as never]}}),"content_blocks_not_supported"],
 ["legacy node image",chain("instagram",{},{kind:"message",data:{text:"صورة",image:"https://example.com/a.png"}}),"legacy_image_not_supported"],
 ["website + reply buttons mixed",chain("instagram",{},{kind:"message",data:{text:"اختر",options:[
   {id:"a",label:"موقع",action:"website",url:"https://example.com"} as never,{id:"b",label:"خيار"}]}}),"mixed_buttons_not_supported"],
 ["button that jumps to another flow",chain("instagram",{},{kind:"message",data:{text:"اختر",options:[{id:"a",label:"تدفق",action:"flow",flowId:"x"} as never]}}),"button_action_not_supported"],
];

for(const [name,doc,reason] of UNSUPPORTED){
 test("unsupported: "+name+" is refused consistently by every layer",()=>{
  const platform=providerPlatform(doc.nodes.find(n=>n.data.kind==="trigger")!.data.platform);
  // derivation (shared source)
  const req=deriveRequirements(doc,null);
  assert.equal(req.engine,null,"no engine runs it");
  assert.ok([...unsupportedByNode(doc).values()].flat().includes(reason as never),"reason "+reason);
  // editor check list / publication validation: an ERROR (drafts are still editable: see the draft test below)
  assert.ok(validateForRuntime(doc).some(i=>i.severity==="error"),"validation error");
  // server authority: never publishable, with plain Arabic reasons and no technical words
  assert.equal(preparePublishedDocument(doc,platform),null);
  const rej=runtimeUnsupportedRejection(doc);
  assert.ok(rej,"Arabic rejection");
  assert.equal(rej!.code,"FLOW_RUNTIME_UNSUPPORTED");
  assert.match(rej!.message,ARABIC);
  assert.doesNotMatch(rej!.message,/FLOW_|engine|worker|revision|JSON|canary|[A-Za-z]{4,}/,"no technical vocabulary");
  assert.ok(runtimeUnsupportedIssues(doc,{includeReported:true}).length>0);
  // simulator: stops, never claims completion or plays later steps
  const sim=startSimulation({doc,flowId:"f"});
  assert.equal(sim.cursor.status,"stopped");
  assert.ok(!sim.events.some(e=>e.type==="system"&&e.text===COMPLETED_TEXT));
  assert.ok(sim.events.some(e=>e.type==="system"&&e.tone==="warn"&&e.text.includes("توقفت المحاكاة")));
 });
}

test("drafts stay creatable and editable: plain validateDocument is unchanged, only the runtime check refuses",()=>{
 // The AI generator and local drafts use validateDocument (structure only); an unrunnable draft must still
 // validate structurally so it can be saved and fixed. Only validateForRuntime (editor check list +
 // server publication) reports the unsupported steps.
 for(const [name,doc] of UNSUPPORTED){
  if(name==="PDF block")continue; // PDF blocks were already a structural error before
  assert.equal(validateDocument(doc).some(i=>String(i.code).startsWith("FLOW_RUNTIME_UNSUPPORTED")),false,name);
  assert.equal(validateForRuntime(doc).some(i=>String(i.code).startsWith("FLOW_RUNTIME_UNSUPPORTED")),true,name);
 }
 // a supported flow is reported identically by both
 const ok=exampleFlow();
 assert.deepEqual(validateForRuntime(ok),validateDocument(ok));
});

test("inbound-text condition outside the short shape is unsupported everywhere (shape rule)",()=>{
 const t=makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:"message"});
 const m=makeNode("message",{x:0,y:0},{text:"أهلًا"});
 const c=makeNode("condition",{x:0,y:0},{conditionField:"message",operator:"contains",conditionValue:"سعر"});
 const y=makeNode("message",{x:0,y:0},{text:"نعم"}),n=makeNode("message",{x:0,y:0},{text:"لا"});
 const e=makeNode("end",{x:0,y:0});
 const w=(a:FlowNode,p:string,b:FlowNode)=>edgeFor({source:a.id,sourceHandle:p,target:b.id,targetHandle:"in"});
 const long:FlowDocument={version:3,name:"long",nodes:[t,m,c,y,n,e],
  edges:[w(t,"next",m),w(m,"next",c),w(c,"yes",y),w(c,"no",n),w(y,"next",e),w(n,"next",e)]};
 assert.ok(runtimeUnsupportedIssues(long).some(i=>i.code==="FLOW_RUNTIME_UNSUPPORTED:inbound_message_condition"));
 assert.equal(preparePublishedDocument(long,"instagram"),null);
 // the SHORT shape (trigger, condition, two messages) is the one the simple engine answers
 const short:FlowDocument={version:3,name:"short",nodes:[t,c,y,n],edges:[w(t,"next",c),w(c,"yes",y),w(c,"no",n)]};
 assert.equal(runtimeUnsupportedIssues(short).length,0);
 assert.equal(deriveRequirements(short,"instagram").engine,"simple");
});

/* ───────── editor option lists mirror the derivation (no drift) ───────── */
test("trigger option list: selectable iff the derivation says the runtime executes it",()=>{
 for(const platform of Object.keys(TRIGGER_OPTIONS) as Platform[]){
  for(const {id} of TRIGGER_OPTIONS[platform]){
   const structural=nodeRequirements({...makeNode("trigger",{x:0,y:0},{platform,triggerMode:id}).data},null).unsupported;
   assert.equal(isRuntimeTriggerMode(id),!structural.includes("trigger_not_supported"),platform+":"+id);
  }
 }
 assert.deepEqual([...RUNTIME_TRIGGER_MODES],["message","keyword","comment"]);
});
test("palette: only the HTTP request step is structurally unavailable among default new steps",()=>{
 const blocked=KIND_LIST.filter(k=>staticUnsupportedReasons(makeNode(k,{x:0,y:0}).data).length>0);
 assert.deepEqual(blocked,["request"]);
 assert.deepEqual(staticUnsupportedReasons(makeNode("request",{x:0,y:0}).data),["http_request_not_supported"]);
 // the AI / tag / notify / handoff shortcuts are supported steps (account availability is separate)
 for(const actionType of ["ai","tag","notify","handoff","untag","set_field"] as const)
  assert.deepEqual(staticUnsupportedReasons(makeNode("action",{x:0,y:0},{actionType}).data),[],actionType);
});
test("every structural reason has a plain Arabic sentence (customer text, no jargon)",()=>{
 for(const [reason,text] of Object.entries(UNSUPPORTED_TEXT)){
  assert.match(text.ar,ARABIC,reason);
  assert.doesNotMatch(text.ar,/FLOW_|JSON|worker|engine|revision|canary/i,reason);
  assert.ok(text.en.length>3);
 }
 assert.equal(unsupportedText("no_such_reason"),"هذه الخطوة غير مدعومة بعد، ولن تعمل بعد النشر.");
});
test("the bundled example flow has no structural errors (new customers can publish it)",()=>{
 assert.deepEqual(runtimeUnsupportedIssues(exampleFlow(),{includeReported:true}),[]);
});

/* ───────── supported shapes: nothing flags them AND the real engine executes them ───────── */
const input=(eventKey:string,extra:{answer?:string;nowMs?:number}={})=>
 ({eventKey,nowMs:extra.nowMs??1_750_000_000_000,seed:seedFromEventKey(eventKey),...(extra.answer!==undefined?{answer:extra.answer}:{})});
const wire=(a:FlowNode,p:string,b:FlowNode)=>edgeFor({source:a.id,sourceHandle:p,target:b.id,targetHandle:"in"});
const trig=(mode:"message"|"keyword"="message")=>makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:mode,
 ...(mode==="keyword"?{keywords:"سعر"}:{})});
const msg=(text:string,opts:Partial<FlowData>={})=>makeNode("message",{x:0,y:0},{text,...opts});
const flowOf=(nodes:FlowNode[],edges:FlowDocument["edges"]):FlowDocument=>({version:3,name:"ok",nodes,edges});

test("execution: text message, completed, one message effect",()=>{
 const t=trig(),m=msg("أهلًا"),e=makeNode("end",{x:0,y:0});
 const f=flowOf([t,m,e],[wire(t,"next",m),wire(m,"next",e)]);
 assert.equal(unsupportedByNode(f).size,0);
 const p=planUntilWait(f,createRuntimeState(f,"f",1),input("evt-1"));
 assert.equal(p.state.status,"completed");
 assert.deepEqual(p.effects.map(x=>x.kind),["message"]);
});
test("execution: button question waits, then a tap routes to the chosen branch",()=>{
 const t=trig(),q=makeNode("question",{x:0,y:0},{text:"اختر",inputMode:"buttons",options:[{id:"a",label:"أ"},{id:"b",label:"ب"}]});
 const a=msg("اخترت أ"),b=msg("اخترت ب"),e=makeNode("end",{x:0,y:0});
 const f=flowOf([t,q,a,b,e],[wire(t,"next",q),wire(q,"a",a),wire(q,"b",b),wire(a,"next",e),wire(b,"next",e)]);
 assert.equal(unsupportedByNode(f).size,0);
 assert.equal(supportedDurableDocument(f,"instagram"),true);
 const ask=planUntilWait(f,createRuntimeState(f,"f",1),input("evt-1"));
 assert.equal(ask.state.status,"awaiting_input");
 const tap=planUntilWait(f,ask.state,input("evt-2",{answer:"b"}));
 assert.equal((tap.effects.find(x=>x.kind==="message") as {text:string}).text,"اخترت ب");
 assert.equal(tap.state.status,"completed");
});
test("execution: typed email question stores the answer and continues; invalid answer keeps waiting",()=>{
 const t=trig(),q=makeNode("question",{x:0,y:0},{text:"بريدك؟",inputMode:"email",inputField:"email"});
 const ok=msg("شكرًا"),e=makeNode("end",{x:0,y:0});
 const f=flowOf([t,q,ok,e],[wire(t,"next",q),wire(q,"valid",ok),wire(ok,"next",e)]);
 assert.equal(unsupportedByNode(f).size,0);
 const ask=planUntilWait(f,createRuntimeState(f,"f",1),input("evt-1"));
 assert.equal(ask.state.status,"awaiting_input");
 const bad=planUntilWait(f,ask.state,input("evt-2",{answer:"nope"}));
 assert.equal(bad.state.status,"awaiting_input");
 const good=planUntilWait(f,ask.state,input("evt-3",{answer:"a@example.com"}));
 assert.equal(good.state.variables.email,"a@example.com");
 assert.equal(good.state.status,"completed");
});
test("execution: a delay persists a wake time and the message is emitted only when due",()=>{
 const t=trig(),d=makeNode("delay",{x:0,y:0},{delayValue:2,delayUnit:"minutes"}),m=msg("بعد دقيقتين"),e=makeNode("end",{x:0,y:0});
 const f=flowOf([t,d,m,e],[wire(t,"next",d),wire(d,"next",m),wire(m,"next",e)]);
 assert.equal(unsupportedByNode(f).size,0);
 const start=planUntilWait(f,createRuntimeState(f,"f",1),input("evt-1"));
 assert.equal(start.state.status,"sleeping");
 assert.equal(start.effects.some(x=>x.kind==="message"),false,"nothing is sent before the wake time");
 assert.ok(typeof start.state.wakeAt==="number"&&start.state.wakeAt>1_750_000_000_000);
 const early=planUntilWait(f,start.state,input("evt-1",{nowMs:1_750_000_000_000+30_000}));
 assert.equal(early.effects.length,0);
 const due=planUntilWait(f,start.state,input("evt-1",{nowMs:start.state.wakeAt!+1}));
 assert.deepEqual(due.effects.map(x=>x.kind),["message"]);
 assert.equal(due.state.status,"completed");
});
test("execution: set_field then a condition on that variable takes the matching branch",()=>{
 const t=trig(),s=makeNode("action",{x:0,y:0},{actionType:"set_field",actionValue:"tier=gold"});
 const c=makeNode("condition",{x:0,y:0},{conditionField:"tier",operator:"equals",conditionValue:"gold"});
 const yes=msg("ذهبي"),no=msg("عادي"),e=makeNode("end",{x:0,y:0});
 const f=flowOf([t,s,c,yes,no,e],[wire(t,"next",s),wire(s,"next",c),wire(c,"yes",yes),wire(c,"no",no),wire(yes,"next",e),wire(no,"next",e)]);
 assert.equal(unsupportedByNode(f).size,0);
 const p=planUntilWait(f,createRuntimeState(f,"f",1),input("evt-1"));
 assert.equal((p.effects.find(x=>x.kind==="message") as {text:string}).text,"ذهبي");
});
test("execution: randomizer is deterministic per event and always picks a configured branch",()=>{
 const t=trig(),r=makeNode("randomizer",{x:0,y:0},{options:[{id:"x",label:"س",weight:50},{id:"y",label:"ص",weight:50}]});
 const a=msg("A"),b=msg("B"),e=makeNode("end",{x:0,y:0});
 const f=flowOf([t,r,a,b,e],[wire(t,"next",r),wire(r,"x",a),wire(r,"y",b),wire(a,"next",e),wire(b,"next",e)]);
 assert.equal(unsupportedByNode(f).size,0);
 const run=(k:string)=>planUntilWait(f,createRuntimeState(f,"f",1),input(k));
 const seen=new Set<string>();
 for(let i=0;i<40;i++){
  const p=run("evt-"+i),again=run("evt-"+i);
  const text=(p.effects.find(x=>x.kind==="message") as {text:string}).text;
  assert.ok(text==="A"||text==="B");
  assert.equal((again.effects.find(x=>x.kind==="message") as {text:string}).text,text,"same event, same branch");
  seen.add(text);
 }
 assert.equal(seen.size,2,"both branches are reachable");
});
test("execution: goto jumps to the target step; internal actions become queued effects (worker-executed)",()=>{
 const t=trig(),tag=makeNode("action",{x:0,y:0},{actionType:"tag",actionValue:"vip"}),
  hand=makeNode("action",{x:0,y:0},{actionType:"handoff",actionValue:""});
 const m=msg("سيتواصل معك موظف"),g=makeNode("goto",{x:0,y:0},{}),e=makeNode("end",{x:0,y:0});
 g.data.gotoNode=m.id;
 const f=flowOf([t,tag,g,m,hand,e],[wire(t,"next",tag),wire(tag,"next",g),wire(m,"next",hand),wire(hand,"next",e)]);
 assert.equal(unsupportedByNode(f).size,0);
 assert.equal(durableNeedsInternalActions(f),true,"operator must enable internal actions for this flow");
 const p=planUntilWait(f,createRuntimeState(f,"f",1),input("evt-1"));
 const kinds=p.effects.map(x=>x.kind);
 assert.ok(kinds.includes("message"),"goto reached the message");
 assert.ok(kinds.some(k=>k!=="message"),"internal actions are planned as separate effects, never executed in the planner: "+kinds);
});
test("execution: a website button message plans a link-button effect (account capability decides availability)",()=>{
 const t=trig(),m=msg("زر الموقع",{options:[{id:"w",label:"زيارة",action:"website",url:"https://example.com/shop"} as never]}),e=makeNode("end",{x:0,y:0});
 const f=flowOf([t,m,e],[wire(t,"next",m),wire(m,"w",e)]);
 assert.equal(unsupportedByNode(f).size,0);
 assert.ok(deriveRequirements(f,"instagram").required.includes("website_buttons"));
});
test("keyword and message triggers are supported; the simulator runs them to completion",()=>{
 for(const mode of ["message","keyword"] as const){
  const t=trig(mode),m=msg("أهلًا"),e=makeNode("end",{x:0,y:0});
  const f=flowOf([t,m,e],[wire(t,"next",m),wire(m,"next",e)]);
  assert.equal(unsupportedByNode(f).size,0,mode);
  assert.equal(startSimulation({doc:f,flowId:"f"}).cursor.status,"end",mode);
 }
});
