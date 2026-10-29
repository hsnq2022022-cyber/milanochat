import {test} from "node:test";
import assert from "node:assert/strict";
import {supportedDurableDocument,selectedFlowChoice,attemptDurableInstagram}
 from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {readFileSync} from "node:fs";

const id={tenant:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 account:"11111111-1111-4111-8111-111111111111",
 conversation:"44444444-4444-4444-8444-444444444444",
 inbound:"77777777-7777-4777-8777-777777777771",
 run:"77777777-7777-4777-8777-7777777777a4"};
const doc={
 version:3,name:"Interactive Instagram",nodes:[
  {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
  {id:"choose",data:{kind:"question",inputMode:"buttons",text:"اختر",image:"",contentBlocks:[],options:[
   {id:"prices",label:"الأسعار"},{id:"support",label:"المساعدة"}]}},
  {id:"yes",data:{kind:"message",text:"هذه الأسعار",image:"",options:[],contentBlocks:[]}},
  {id:"no",data:{kind:"message",text:"تواصل معنا",image:"",options:[],contentBlocks:[]}}
 ],edges:[
  {source:"start",target:"choose",sourceHandle:"next"},
  {source:"choose",target:"yes",sourceHandle:"prices"},
  {source:"choose",target:"no",sourceHandle:"support"}
 ]
};
test("supported advanced graph accepts two stable button choices and one delay",()=>{
 assert.equal(supportedDurableDocument(doc),true);
 const delay={version:3,nodes:[
  doc.nodes[0],{id:"sleep",data:{kind:"delay",delayValue:1,delayUnit:"minutes"}},
  doc.nodes[2]
 ],edges:[{source:"start",target:"sleep",sourceHandle:"next"},
          {source:"sleep",target:"yes",sourceHandle:"next"}]};
 assert.equal(supportedDurableDocument(delay),true);
 assert.equal(supportedDurableDocument({...delay,edges:[]}),false);
 assert.equal(supportedDurableDocument({...delay,nodes:[...delay.nodes,{id:"action",data:{kind:"action"}}]}),false);
 assert.equal(supportedDurableDocument({...doc,nodes:doc.nodes.map(n=>
  n.id==="start"?{...n,data:{...n.data,platform:"facebook"}}:n)}),false);
 assert.equal(supportedDurableDocument({...doc,nodes:doc.nodes.map(n=>
  n.id==="yes"?{...n,data:{...n.data,image:"https://example.org"}}:n)}),false);
});
test("quick reply candidates require the exact provider prefix and safe option ID",()=>{
 assert.equal(selectedFlowChoice({quick_reply:{payload:"flow-choice:prices"}}),"prices");
 assert.equal(selectedFlowChoice({quick_reply:{payload:"flow-choice:<script>"}}),null);
 assert.equal(selectedFlowChoice({quick_reply:{payload:"website:https://example.com"}}),null);
 assert.equal(selectedFlowChoice({quick_reply:{payload:"flow-choice:"}}),null);
 assert.equal(selectedFlowChoice(null),null);
});
test("without exact secret canary the signed webhook continues its existing text-only route",async()=>{
 const D=(globalThis as any).Deno;
 (globalThis as any).Deno={env:{get:()=>undefined}};
 try{
  const db={from:()=>{throw Error("Unexpected DB access");},
    rpc:async()=>{throw Error("Unexpected claim");}};
  const result=await attemptDurableInstagram(db,{
   tenantId:id.tenant,accountId:id.account,conversationId:id.conversation,
   inboundId:id.inbound,eventId:"meta-event",platform:"instagram"
  });
  assert.equal(result,"fallback");
 }finally{(globalThis as any).Deno=D;}
});
test("opted-in event creates one durable question; later selection resumes SAME run",async()=>{
 const old=(globalThis as any).Deno;
 (globalThis as any).Deno={env:{get:(k:string)=>k==="FLOW_DURABLE_INGRESS_ENABLED"?"true":
  k==="FLOW_DURABLE_CANARY_ACCOUNT_ID"?id.account:undefined}};
 let waiting=false;
 const calls:Array<{name:string;args:any}>=[];
 const rows:Record<string,any>={
  automation_flow_global_switch:{enabled:true},
  automation_flow_tenant_switches:{enabled:true,production_approved:true},
  automation_flow_publications:{document:doc}
 };
 const db={
  from:(table:string)=>{
   const q={
    select:()=>q,eq:()=>q,
    maybeSingle:async()=>({data:rows[table]??null,error:null}),
    limit:async()=>({data:table==="automation_flow_runs"?
      (waiting?[{id:id.run,tenant_id:id.tenant,channel_account_id:id.account,
       platform:"instagram",conversation_id:id.conversation,flow_key:"flow",
       publication_revision:1,current_node_id:"choose",run_status:"awaiting_input",
       step_count:2,variables:{},wake_at:null}]:[]):
      table==="automation_flow_activations"?
        [{flow_key:"flow",revision:1,is_active:true}]:[],error:null})
   };return q;
  },
  rpc:async(name:string,args:any)=>{
   calls.push({name,args});
   if(name==="flow_claim_inbound")return {data:[{acquired:true,route:"flow"}],error:null};
   if(name==="flow_begin_durable_run"){waiting=true;return {data:id.run,error:null};}
   if(name==="flow_resume_button_run"){waiting=false;return {data:true,error:null};}
   throw Error("Unexpected RPC "+name);
  }
 };
 try{
  const event={tenantId:id.tenant,accountId:id.account,
    conversationId:id.conversation,inboundId:id.inbound,
    eventId:"meta-new",platform:"instagram"};
  assert.equal(await attemptDurableInstagram(db,event),"handled");
  assert.equal(calls.filter(c=>c.name==="flow_begin_durable_run").length,1);
  assert.equal(calls.find(c=>c.name==="flow_begin_durable_run")?.args.p_status,"awaiting_input");
  assert.equal(await attemptDurableInstagram(db,{
   ...event,eventId:"meta-click",selectedChoiceId:"prices"
  }),"handled");
  assert.equal(calls.filter(c=>c.name==="flow_resume_button_run").length,1);
  const resume=calls.find(c=>c.name==="flow_resume_button_run")!.args;
  assert.equal(resume.p_run,id.run);
  assert.equal(resume.p_status,"completed");
  assert.equal(resume.p_effects[0].payload.text,"هذه الأسعار");
  assert.equal(calls.filter(c=>c.name==="flow_claim_inbound").length,2);
 }finally{(globalThis as any).Deno=old;}
});
test("the actual HMAC-verified Instagram extractor passes button identity only to opt-in server",()=>{
 const server=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 assert.match(server,/choiceId:selectedFlowChoice\(ev\.message\)/);
 assert.match(server,/choiceId:selectedFlowChoice\(value\.message\)/);
 assert.match(server,/selectedChoiceId/);
 assert.match(server,/attemptDurableInstagram\(sb/);
 assert.match(server,/if\(durable==="handled"\)return/);
});
