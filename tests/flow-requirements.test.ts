/**
 * src/flow/requirements.ts: per-node capability table, fail-closed input
 * handling, and PARITY with the authoritative server classifiers (milan-api
 * supportedDurableDocument / durableRuntimeNeeds / durableNeedsInternalActions,
 * simpleFlowDocumentSupported, commentFlowPlan; publicationGate flowNeedsMedia;
 * flow-publication documentHasCommentTrigger) over a corpus: repository
 * fixtures/examples, the editor's example flow, handcrafted documents per node
 * kind and channel, and seeded generated graphs.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {deriveRequirements,nodeRequirements,CAPABILITIES,type ProviderPlatform} from "../src/flow/requirements.ts";
import {exampleFlow,importFlow} from "../src/flow/model.ts";
import {flowNeedsMedia} from "../src/flow/publicationGate.ts";
import {supportedDurableDocument,durableRuntimeNeeds,durableNeedsInternalActions}
 from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {simpleFlowDocumentSupported} from "../supabase/functions/milan-api/flowPrepareMessage.ts";
import {commentFlowPlan} from "../supabase/functions/milan-api/commentTrigger.ts";
import {documentHasCommentTrigger} from "../supabase/functions/flow-publication/readiness.ts";

const HOST="https://abcd1234.supabase.co";
const IMG=HOST+"/storage/v1/object/public/flow-media/u1/a.webp";
/** Every server flag ON (the classifiers read Deno.env at call time). */
const FLAGS:Record<string,string>={FLOW_MULTICHANNEL_ENABLED:"true",FLOW_RICH_BUTTONS_ENABLED:"true",
 FLOW_MEDIA_SEND_ENABLED:"true",FLOW_AI_STEP_ENABLED:"true",FLOW_RAG_ENABLED:"true",SUPABASE_URL:HOST};
function server<T>(fn:()=>T):T{
 const old=(globalThis as any).Deno;(globalThis as any).Deno={env:{get:(k:string)=>FLAGS[k]}};
 try{return fn();}finally{(globalThis as any).Deno=old;}
}
const PLATFORMS:ProviderPlatform[]=["instagram","facebook","whatsapp"];
const DOCP:Record<ProviderPlatform,string>={instagram:"instagram",facebook:"messenger",whatsapp:"whatsapp"};

// ------------------------------------------------------------ node templates
type T={data:Record<string,unknown>;ports:string[];terminal?:boolean};
let seq=0;const nid=()=>"n"+(++seq);
const msg=(o:Record<string,unknown>={})=>({kind:"message",text:"Hello",image:"",options:[],contentBlocks:[],...o});
const TEMPLATES:Record<string,(p:string)=>T>={
 text:()=>({data:msg(),ports:["next"]}),
 image:()=>({data:msg({text:"Pic",contentBlocks:[{id:"b1",type:"image",url:IMG}]}),ports:["next"]}),
 stepButtons:()=>({data:msg({options:[{id:"o1",label:"A"},{id:"o2",label:"B"}]}),ports:["o1","o2"]}),
 website:p=>({data:msg({platform:p,text:"Visit",options:[{id:"w1",label:"Site",action:"website",buttonType:"button",url:"https://example.com/x"}]}),ports:["next"]}),
 qButtons:()=>({data:{kind:"question",text:"Pick",image:"",contentBlocks:[],inputMode:"buttons",options:[{id:"q1",label:"Yes"},{id:"q2",label:"No"}]},ports:["q1","q2"]}),
 qEmail:()=>({data:{kind:"question",text:"Email?",image:"",contentBlocks:[],inputMode:"email",inputField:"email_addr",options:[]},ports:["valid"]}),
 qNumber:()=>({data:{kind:"question",text:"How many?",image:"",contentBlocks:[],inputMode:"number",inputField:"n",options:[]},ports:["valid"]}),
 delay:()=>({data:{kind:"delay",delayValue:1,delayUnit:"minutes"},ports:["next"]}),
 condition:()=>({data:{kind:"condition",conditionField:"color",operator:"equals",conditionValue:"red"},ports:["yes","no"]}),
 setField:()=>({data:{kind:"action",actionType:"set_field",actionValue:"color=red"},ports:["next"]}),
 tag:()=>({data:{kind:"action",actionType:"tag",actionValue:"vip"},ports:["next"]}),
 notify:()=>({data:{kind:"action",actionType:"notify",actionValue:"Call back"},ports:["next"]}),
 handoff:()=>({data:{kind:"action",actionType:"handoff",actionValue:""},ports:[],terminal:true}),
 ai:()=>({data:{kind:"action",actionType:"ai",actionValue:""},ports:["next"]}),
 randomizer:()=>({data:{kind:"randomizer",options:[{id:"r1",label:"A",weight:50},{id:"r2",label:"B",weight:50}]},ports:["r1","r2"]}),
 request:()=>({data:{kind:"request",requestMethod:"GET",requestUrl:"https://example.com"},ports:["next"]}),
 pdf:()=>({data:msg({contentBlocks:[{id:"p",type:"pdf",url:"https://example.com/a.pdf"}]}),ports:["next"]}),
 inlineDelay:()=>({data:msg({contentBlocks:[{id:"d",type:"delay",seconds:5}]}),ports:["next"]}),
 flowButton:()=>({data:msg({options:[{id:"f1",label:"Go",action:"flow",targetFlowId:"x"}]}),ports:["f1"]}),
 legacyImage:()=>({data:msg({image:IMG}),ports:["next"]}),
};
const trigger=(p:string,mode="message",extra:Record<string,unknown>={})=>
 ({kind:"trigger",platform:p,triggerMode:mode,keywords:mode==="keyword"?"price":"",...extra});
/** trigger -> templates in a chain; every extra port goes to its own end node. */
function chain(p:string,names:string[],trig:Record<string,unknown>=trigger(p)){
 const nodes:any[]=[],edges:any[]=[];
 const t={id:nid(),data:trig};nodes.push(t);
 let prev=t.id,port="next";
 for(const name of names){
  const tpl=TEMPLATES[name](p),id=nid();
  nodes.push({id,data:tpl.data});edges.push({source:prev,target:id,sourceHandle:port});
  if(tpl.terminal){prev="";break;}
  const [first,...rest]=tpl.ports;
  for(const r of rest){const e=nid();nodes.push({id:e,data:{kind:"end"}});edges.push({source:id,target:e,sourceHandle:r});}
  prev=id;port=first;
  if(!first){prev="";break;}
 }
 if(prev){const e=nid();nodes.push({id:e,data:{kind:"end"}});edges.push({source:prev,target:e,sourceHandle:port});}
 return {version:3,name:names.join("+"),nodes,edges};
}
const simpleLone=(p:string,mode="message")=>({version:3,name:"lone",nodes:[{id:"t",data:trigger(p,mode)},{id:"m",data:msg()}],
 edges:[{source:"t",target:"m",sourceHandle:"next"}]});
const simpleCond=(p:string)=>({version:3,name:"cond",nodes:[{id:"t",data:trigger(p)},
 {id:"c",data:{kind:"condition",conditionField:"message",operator:"contains",conditionValue:"hi"}},{id:"y",data:msg({text:"Y"})},{id:"n",data:msg({text:"N"})}],
 edges:[{source:"t",target:"c",sourceHandle:"next"},{source:"c",target:"y",sourceHandle:"yes"},{source:"c",target:"n",sourceHandle:"no"}]});
const commentDoc=(p:string,end=true)=>({version:3,name:"comment",nodes:[
 {id:"t",data:trigger(p,"comment",{commentScope:"all",commentPostId:"",commentMatchType:"any",publicReplyText:"Check your DMs"})},
 {id:"m",data:msg({text:"Here is the link"})},...(end?[{id:"e",data:{kind:"end"}}]:[])],
 edges:[{source:"t",target:"m"},...(end?[{source:"m",target:"e"}]:[])]});

function corpus():Array<{name:string;doc:unknown}>{
 const out:Array<{name:string;doc:unknown}>=[];
 for(const f of ["examples/flow-instagram-two-choice-v3.json","examples/flow-instagram-one-minute-delay-v3.json"])
  out.push({name:f,doc:JSON.parse(readFileSync(f,"utf8"))});
 const fx=JSON.parse(readFileSync("tests/fixtures/flow-main-compat.json","utf8"));
 for(const c of fx.cases){out.push({name:"fixture:"+c.name,doc:c.expected});const imp=importFlow(c.input);if(imp)out.push({name:"import:"+c.name,doc:imp});}
 out.push({name:"exampleFlow",doc:exampleFlow()});
 for(const p of ["instagram","messenger","whatsapp"]){
  out.push({name:"lone/"+p,doc:simpleLone(p)},{name:"loneKw/"+p,doc:simpleLone(p,"keyword")},{name:"cond/"+p,doc:simpleCond(p)},
   {name:"comment/"+p,doc:commentDoc(p)},{name:"commentNoEnd/"+p,doc:commentDoc(p,false)});
  for(const name of Object.keys(TEMPLATES))out.push({name:"one:"+name+"/"+p,doc:chain(p,[name])});
  out.push({name:"textText/"+p,doc:chain(p,["text","text"])});
 }
 // Seeded generated graphs (2..4 blocks), every channel.
 const names=Object.keys(TEMPLATES);let s=7;
 const rnd=(n:number)=>{s=(s*1103515245+12345)%2147483648;return s%n;};
 for(let i=0;i<600;i++){
  const p=["instagram","messenger","whatsapp"][rnd(3)];
  const k=1+rnd(4),pick=Array.from({length:k},()=>names[rnd(names.length)]);
  out.push({name:"gen"+i+":"+pick.join("+")+"/"+p,doc:chain(p,pick,trigger(p,rnd(4)===0?"keyword":"message"))});
 }
 return out;
}
const has=(r:{required:string[]},c:string)=>r.required.includes(c);

test("PARITY with the server classifiers over the corpus (all server flags on)",()=>{
 const docs=corpus();
 let durable=0,simple=0,comment=0,none=0;
 for(const {name,doc} of docs)for(const p of PLATFORMS){
  const r=deriveRequirements(doc,p);
  const [isDurable,isSimple,isComment,needs,internal]=server(()=>{
   const d=supportedDurableDocument(doc,p);
   return [d,simpleFlowDocumentSupported(doc,p as any),commentFlowPlan(doc,p)!==null,
    d?durableRuntimeNeeds(doc as any):null,d?durableNeedsInternalActions(doc as any):null] as const;
  });
  const tag=name+" @"+p;
  // (i) engine class wherever a server runtime accepts the document.
  if(isDurable){durable++;assert.equal(r.engine,"durable",tag);}
  if(isSimple){simple++;assert.equal(r.engine,"simple",tag);}
  if(isComment){comment++;assert.equal(r.engine,"comment",tag);}
  // Fail-closed direction: an unsupported verdict is never given to a runnable document.
  if(r.engine===null){none++;assert.ok(!isDurable&&!isSimple&&!isComment,tag);}
  // (ii) required capabilities agree with the server's own flag needs.
  if(needs){
   assert.equal(has(r,"buttons")||has(r,"website_buttons"),needs.buttons,tag+" buttons");
   assert.equal(has(r,"delay"),needs.scheduler,tag+" delay");
   assert.equal(has(r,"internal_actions"),internal,tag+" internal");
   const ai=(doc as any).nodes.some((n:any)=>n.data.kind==="action"&&n.data.actionType==="ai");
   assert.equal(has(r,"ai_step"),ai,tag+" ai");
  }
  assert.equal(has(r,"media_image")||r.unsupported.some(u=>u.reason==="legacy_image_not_supported"),flowNeedsMedia(doc),tag+" media");
  assert.equal(has(r,"comment_trigger"),documentHasCommentTrigger(doc),tag+" comment");
  assert.equal(has(r,"multi_step"),r.engine==="durable",tag+" multi_step");
  assert.ok(r.required.every(c=>CAPABILITIES.includes(c)));
 }
 // The corpus really exercises every class (guards against a vacuous parity).
 assert.ok(durable>=150&&simple>=6&&comment>=2&&none>=150,JSON.stringify({durable,simple,comment,none}));
});

test("per node kind table",()=>{
 const caps=(d:unknown)=>nodeRequirements(d).capabilities;
 const why=(d:unknown)=>nodeRequirements(d).unsupported;
 assert.deepEqual(caps(trigger("instagram")),["trigger_message"]);
 assert.deepEqual(caps(trigger("instagram","keyword")),["keyword_trigger"]);
 assert.deepEqual(caps({...trigger("instagram"),messageScope:"conversation_start"}),["trigger_message","message_scope"]);
 assert.deepEqual(caps(commentDoc("instagram").nodes[0].data),["comment_trigger","public_reply"]);
 for(const mode of ["story","ad","live","referral"])assert.deepEqual(why(trigger("instagram",mode)),["trigger_not_supported"]);
 assert.deepEqual(why(trigger("instagram")),[]);
 assert.deepEqual(nodeRequirements(trigger("instagram"),"whatsapp").unsupported,["trigger_channel_mismatch"]);
 assert.deepEqual(caps(TEMPLATES.text("instagram").data),["text"]);
 assert.deepEqual(caps(TEMPLATES.image("instagram").data),["text","media_image"]);
 assert.deepEqual(caps(TEMPLATES.stepButtons("instagram").data),["text","buttons"]);
 assert.deepEqual(caps(TEMPLATES.website("instagram").data),["text","website_buttons"]);
 assert.deepEqual(caps(TEMPLATES.qButtons("instagram").data),["text","buttons"]);
 assert.deepEqual(caps(TEMPLATES.qEmail("instagram").data),["text","typed_question"]);
 assert.deepEqual(caps(TEMPLATES.delay("instagram").data),["delay"]);
 assert.deepEqual(caps(TEMPLATES.condition("instagram").data),["conditions"]);
 assert.deepEqual(caps(TEMPLATES.setField("instagram").data),["variables"]);
 for(const t of ["tag","notify","handoff"])assert.deepEqual(caps(TEMPLATES[t]("instagram").data),["internal_actions"],t);
 assert.deepEqual(caps({kind:"action",actionType:"untag",actionValue:"x"}),["internal_actions"]);
 assert.deepEqual(caps(TEMPLATES.ai("instagram").data),["ai_step"]);
 assert.deepEqual(caps(TEMPLATES.randomizer("instagram").data),["randomizer"]);
 assert.deepEqual(caps({kind:"goto",gotoNode:"x"}),["goto"]);
 assert.deepEqual(caps({kind:"end"}),[]);
 const reasons:Record<string,string>={request:"http_request_not_supported",pdf:"pdf_not_supported",qNumber:"number_question_not_supported",
  inlineDelay:"content_blocks_not_supported",flowButton:"button_action_not_supported",legacyImage:"legacy_image_not_supported"};
 for(const [t,r] of Object.entries(reasons)){
  const n=nodeRequirements(TEMPLATES[t]("instagram").data);
  assert.ok(n.capabilities.includes("unsupported_block")&&n.unsupported.includes(r as any),t);
 }
 assert.deepEqual(why({kind:"teleport"}),["unknown_block"]);
 assert.deepEqual(why(msg({options:[{id:"a",label:"A"},{id:"w",label:"W",action:"website",url:"https://e.com"}]})),["mixed_buttons_not_supported"]);
});

test("document derivation: engine class, comment private reply, node ids, availability -> unavailable",()=>{
 const two=chain("instagram",["stepButtons"]);
 const r=deriveRequirements(two,"instagram",{trigger_message:{available:true,reason:null},text:{available:true,reason:null},
  buttons:{available:false,reason:"advanced_not_enabled"},multi_step:{available:true,reason:null}});
 assert.equal(r.engine,"durable");
 const btn=two.nodes[1].id;
 assert.deepEqual(r.unavailable,[{capability:"buttons",reason:"advanced_not_enabled",nodeIds:[btn]}]);
 const c=deriveRequirements(commentDoc("instagram"),"instagram");
 assert.equal(c.engine,"comment");assert.deepEqual(c.required,["comment_trigger","public_reply","private_reply"]);
 assert.equal(c.unavailable,null,"no availability map -> unknown, not 'available'");
 assert.equal(deriveRequirements(simpleCond("instagram"),"instagram").engine,"simple");
 assert.deepEqual(deriveRequirements(simpleCond("instagram"),"instagram").required,["trigger_message","text"]);
 // Inbound-text condition outside the simple shape: never live.
 const bad=chain("instagram",["text"]);bad.nodes[1].data={kind:"condition",conditionField:"message",operator:"exists"};
 const rb=deriveRequirements(bad,"instagram");
 assert.equal(rb.engine,null);assert.ok(rb.unsupported.some(u=>u.reason==="inbound_message_condition"));
 // Missing map entries are unavailable (fail closed) and unsupported blocks never available.
 const rr=deriveRequirements(chain("instagram",["request"]),"instagram",Object.fromEntries(CAPABILITIES.map(k=>[k,{available:true,reason:null}])));
 assert.deepEqual(rr.unavailable!.map(u=>[u.capability,u.reason]),[["unsupported_block","http_request_not_supported"]]);
 assert.deepEqual(deriveRequirements(chain("instagram",["delay"]),"instagram",{}).unavailable!.map(u=>[u.capability,u.reason]),
  [["trigger_message","unavailable"],["delay","unavailable"],["multi_step","unavailable"]]);
 // Deterministic.
 assert.deepEqual(deriveRequirements(two,"instagram"),deriveRequirements(structuredClone(two),"instagram"));
});

test("unknown / malformed input fails closed without throwing",()=>{
 const hostile=new Proxy({},{get(){throw new Error("boom");}});
 for(const doc of [null,undefined,42,"x",[],{},{nodes:"x",edges:[]},{nodes:[],edges:[]},{nodes:[null],edges:[]},
  {nodes:[{id:1,data:{}}],edges:[]},{nodes:[{id:"a"}],edges:[]},hostile]){
  const r=deriveRequirements(doc,"instagram",{text:{available:true,reason:null}});
  assert.equal(r.ok,false);assert.equal(r.engine,null);assert.deepEqual(r.required,["unsupported_block"]);
  assert.deepEqual(r.unavailable,[{capability:"unsupported_block",reason:"malformed_document",nodeIds:[]}]);
 }
 const noTrigger=deriveRequirements({version:3,nodes:[{id:"m",data:msg()}],edges:[]},"instagram");
 assert.equal(noTrigger.engine,null);assert.ok(noTrigger.unsupported.some(u=>u.reason==="malformed_document"));
 assert.deepEqual(nodeRequirements(null).unsupported,["unknown_block"]);
});
