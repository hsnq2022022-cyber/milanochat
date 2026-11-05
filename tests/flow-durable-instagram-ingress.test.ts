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
   inboundId:id.inbound,eventId:"meta-event",platform:"instagram",providerEventIdGenuine:true
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
  automation_flow_tenant_switches:{enabled:true,test_only:true,production_approved:true},
  automation_flow_publications:{document:doc}
 };
 const db={
  from:(table:string)=>{
   const q={
    select:()=>q,eq:()=>q,in:()=>q,
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
    eventId:"meta-new",platform:"instagram",providerEventIdGenuine:true};
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

// ---- Lifecycle: waiting runs never silence the conversation; one active run.
const canaryEnv={env:{get:(k:string)=>k==="FLOW_DURABLE_INGRESS_ENABLED"?"true":
 k==="FLOW_DURABLE_CANARY_ACCOUNT_ID"?id.account:undefined}};
const waitingRun=(over:Record<string,unknown>={})=>({id:id.run,tenant_id:id.tenant,
 channel_account_id:id.account,platform:"instagram",conversation_id:id.conversation,
 flow_key:"flow",publication_revision:1,current_node_id:"choose",
 run_status:"awaiting_input",step_count:2,variables:{},wake_at:null,...over});
type Opts={awaiting?:any[];active?:any[];activations?:any[];document?:unknown;
 rpc?:Record<string,(args:any)=>any>;switches?:Record<string,unknown>|null;
 claims?:any[];inbound?:any[];priorError?:boolean;
 outbox?:any[];outboxError?:boolean;runsById?:any[]};
function lifecycleDb(o:Opts){
 const calls:Array<{name:string;args:any}>=[];
 const reads:Array<{table:string;filters:Record<string,unknown>}>=[];
 const db={
  from:(table:string)=>{
   const filters:Record<string,unknown>={};
   const q:any={
    select:()=>q,
    eq:(k:string,v:unknown)=>{filters[k]=v;return q;},
    in:(k:string,v:unknown)=>{filters[k]=v;return q;},
    maybeSingle:async()=>{reads.push({table,filters});return {data:
     table==="automation_flow_global_switch"?{enabled:true}:
     table==="automation_flow_tenant_switches"?
      ("switches" in o?o.switches:{enabled:true,test_only:true,production_approved:true}):
     table==="automation_flow_publications"?
      ("document" in o?(o.document===undefined?null:{document:o.document}):{document:doc}):null,
     error:null};},
    limit:async()=>{reads.push({table,filters});
     if(table==="automation_flow_runs")
      return {data:Array.isArray(filters.id)?(o.runsById??[]):
       Array.isArray(filters.run_status)?(o.active??[]):(o.awaiting??[]),error:null};
     if(table==="automation_flow_outbox")
      return o.outboxError?{data:null,error:{code:"XX000",message:"db down"}}:{data:o.outbox??[],error:null};
     if(table==="automation_flow_activations")
      return {data:o.activations??[{flow_key:"flow",revision:1,is_active:true}],error:null};
     if(table==="automation_message_claims")
      return o.priorError?{data:null,error:{code:"XX000",message:"db down"}}:{data:o.claims??[],error:null};
     if(table==="messages")return {data:o.inbound??[],error:null};
     return {data:[],error:null};}
   };return q;
  },
  rpc:async(name:string,args:any)=>{
   calls.push({name,args});
   if(o.rpc?.[name])return o.rpc[name](args);
   if(name==="flow_claim_inbound")return {data:[{acquired:true,route:"flow"}],error:null};
   if(name==="flow_claim_inbound_durable")return {data:[{acquired:true,route:"flow"}],error:null};
   if(name==="flow_cancel_run")return {data:true,error:null};
   if(name==="flow_begin_durable_run")return {data:"88888888-8888-4888-8888-888888888888",error:null};
   if(name==="flow_resume_button_run")return {data:true,error:null};
   throw Error("Unexpected RPC "+name);
  }
 };
 return {db,calls,reads};
}
const baseEvent={tenantId:id.tenant,accountId:id.account,
 conversationId:id.conversation,inboundId:id.inbound,eventId:"meta-x",platform:"instagram",
 providerEventIdGenuine:true};
async function withCanary<T>(fn:()=>Promise<T>):Promise<T>{
 const old=(globalThis as any).Deno;(globalThis as any).Deno=canaryEnv;
 try{return await fn();}finally{(globalThis as any).Deno=old;}
}
const names=(calls:Array<{name:string}>)=>calls.map(c=>c.name);

test("free text while awaiting a button cancels the run and falls back to the reply path",async()=>{
 await withCanary(async()=>{
  const {db,calls}=lifecycleDb({awaiting:[waitingRun()]});
  assert.equal(await attemptDurableInstagram(db,{...baseEvent,selectedChoiceId:null}),"fallback");
  assert.deepEqual(names(calls),["flow_cancel_run"]);
  assert.deepEqual(calls[0].args,{p_tenant:id.tenant,p_run:id.run,
   p_reason:"free_text",p_expect_status:"awaiting_input"});
 });
});
test("missing quick-reply payload (undefined choice) is treated as free text",async()=>{
 await withCanary(async()=>{
  const {db,calls}=lifecycleDb({awaiting:[waitingRun()]});
  assert.equal(await attemptDurableInstagram(db,baseEvent),"fallback");
  assert.equal(calls.find(c=>c.name==="flow_cancel_run")?.args.p_reason,"free_text");
  assert.equal(names(calls).includes("flow_claim_inbound"),false);
 });
});
test("unknown/stale button id for the waiting question cancels as free text",async()=>{
 await withCanary(async()=>{
  const {db,calls}=lifecycleDb({awaiting:[waitingRun()]});
  assert.equal(await attemptDurableInstagram(db,{...baseEvent,selectedChoiceId:"old_option"}),"fallback");
  assert.deepEqual(names(calls),["flow_cancel_run"]);
  assert.equal(calls[0].args.p_reason,"free_text");
 });
});
test("inactive revision of the waiting run cancels it and falls back",async()=>{
 await withCanary(async()=>{
  const {db,calls}=lifecycleDb({awaiting:[waitingRun()],activations:[]});
  assert.equal(await attemptDurableInstagram(db,{...baseEvent,selectedChoiceId:"prices"}),"fallback");
  assert.deepEqual(names(calls),["flow_cancel_run"]);
  assert.equal(calls[0].args.p_reason,"revision_inactive");
  // newer revision active for same flow_key is still inactive for this run
  const b=lifecycleDb({awaiting:[waitingRun()],activations:[{flow_key:"flow",revision:2,is_active:true}]});
  assert.equal(await attemptDurableInstagram(b.db,{...baseEvent,selectedChoiceId:"prices"}),"fallback");
  assert.equal(b.calls[0].args.p_reason,"revision_inactive");
  // missing/unsupported publication document is treated the same way
  const c=lifecycleDb({awaiting:[waitingRun()],document:undefined});
  assert.equal(await attemptDurableInstagram(c.db,{...baseEvent,selectedChoiceId:"prices"}),"fallback");
  assert.equal(c.calls[0].args.p_reason,"revision_inactive");
 });
});
test("cancel RPC failure fails closed; already-ended run (false) still falls back",async()=>{
 await withCanary(async()=>{
  const err=lifecycleDb({awaiting:[waitingRun()],
   rpc:{flow_cancel_run:()=>({data:null,error:{code:"XX000",message:"db down"}})}});
  assert.equal(await attemptDurableInstagram(err.db,baseEvent),"handled");
  const gone=lifecycleDb({awaiting:[waitingRun()],
   rpc:{flow_cancel_run:()=>({data:false,error:null})}});
  assert.equal(await attemptDurableInstagram(gone.db,baseEvent),"fallback");
 });
});
test("waiting row from another tenant/account/conversation is never cancelled",async()=>{
 await withCanary(async()=>{
  for(const over of [{tenant_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},
    {channel_account_id:"22222222-2222-4222-8222-222222222222"},
    {conversation_id:"55555555-5555-4555-8555-555555555555"}]){
   const {db,calls}=lifecycleDb({awaiting:[waitingRun(over)]});
   assert.equal(await attemptDurableInstagram(db,baseEvent),"handled");
   assert.deepEqual(calls,[]);
  }
 });
});
test("valid button tap still resumes the same run without any cancel",async()=>{
 await withCanary(async()=>{
  const {db,calls}=lifecycleDb({awaiting:[waitingRun()]});
  assert.equal(await attemptDurableInstagram(db,{...baseEvent,selectedChoiceId:"prices"}),"handled");
  assert.deepEqual(names(calls),["flow_claim_inbound","flow_resume_button_run"]);
 });
});
test("new run supersedes an existing sleeping run only after the exclusive claim",async()=>{
 await withCanary(async()=>{
  const sleeping={id:"99999999-9999-4999-8999-999999999999",tenant_id:id.tenant,
   conversation_id:id.conversation,run_status:"sleeping"};
  const {db,calls,reads}=lifecycleDb({active:[sleeping]});
  assert.equal(await attemptDurableInstagram(db,baseEvent),"handled");
  assert.deepEqual(names(calls),["flow_claim_inbound","flow_cancel_run","flow_begin_durable_run"]);
  assert.deepEqual(calls[1].args,{p_tenant:id.tenant,p_run:sleeping.id,
   p_reason:"superseded",p_expect_status:"sleeping"});
  const q=reads.find(r=>r.table==="automation_flow_runs"&&Array.isArray(r.filters.run_status))!;
  assert.equal(q.filters.tenant_id,id.tenant);
  assert.equal(q.filters.conversation_id,id.conversation);
  assert.deepEqual(q.filters.run_status,["ready","awaiting_input","sleeping"]);
 });
});
test("duplicate delivery (claim not acquired) never supersedes the run it created",async()=>{
 await withCanary(async()=>{
  const {db,calls}=lifecycleDb({active:[{id:id.run,tenant_id:id.tenant,
   conversation_id:id.conversation,run_status:"sleeping"}],
   rpc:{flow_claim_inbound:()=>({data:[{acquired:false,route:"flow"}],error:null})}});
  assert.equal(await attemptDurableInstagram(db,baseEvent),"handled");
  assert.deepEqual(names(calls),["flow_claim_inbound"]);
 });
});
test("supersede fails closed on foreign rows or cancel errors (no begin)",async()=>{
 await withCanary(async()=>{
  const foreign=lifecycleDb({active:[{id:id.run,tenant_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
   conversation_id:id.conversation,run_status:"sleeping"}]});
  assert.equal(await attemptDurableInstagram(foreign.db,baseEvent),"handled");
  assert.deepEqual(names(foreign.calls),["flow_claim_inbound"]);
  const broken=lifecycleDb({active:[{id:id.run,tenant_id:id.tenant,
   conversation_id:id.conversation,run_status:"sleeping"}],
   rpc:{flow_cancel_run:()=>({data:null,error:{code:"XX000",message:"x"}})}});
  assert.equal(await attemptDurableInstagram(broken.db,baseEvent),"handled");
  assert.equal(names(broken.calls).includes("flow_begin_durable_run"),false);
 });
});
test("23505 flow_active_run_exists from begin is handled without crash or retry",async()=>{
 await withCanary(async()=>{
  const warn=console.warn;const warned:string[]=[];
  console.warn=(m:string)=>{warned.push(String(m));};
  try{
   const {db,calls}=lifecycleDb({rpc:{flow_begin_durable_run:()=>({data:null,
    error:{code:"23505",message:"flow_active_run_exists",details:"x"}})}});
   assert.equal(await attemptDurableInstagram(db,baseEvent),"handled");
   assert.equal(names(calls).filter(n=>n==="flow_begin_durable_run").length,1);
   assert.ok(warned.some(w=>w.includes("active run exists")));
  }finally{console.warn=warn;}
 });
});

// ---- Production canary mode (20261029170000): separate SQL claim function.
const PROD={enabled:true,test_only:false,production_approved:true};
const canaryClaimArgs={p_tenant_id:id.tenant,p_account_id:id.account,p_platform:"instagram",
 p_provider_event_id:"meta-x",p_conversation_id:id.conversation,p_inbound_message_id:id.inbound};
test("production canary: new run claims through flow_claim_inbound_durable only (never the V2 function)",async()=>{
 await withCanary(async()=>{
  const {db,calls}=lifecycleDb({switches:PROD});
  assert.equal(await attemptDurableInstagram(db,baseEvent),"handled");
  assert.deepEqual(names(calls),["flow_claim_inbound_durable","flow_begin_durable_run"]);
  assert.deepEqual(calls[0].args,canaryClaimArgs,"no caller-asserted canary/engine flag is sent");
  assert.equal(names(calls).includes("flow_claim_inbound"),false);
 });
});
test("production canary: button tap resumes the same run through the durable claim",async()=>{
 await withCanary(async()=>{
  const {db,calls}=lifecycleDb({switches:PROD,awaiting:[waitingRun()]});
  assert.equal(await attemptDurableInstagram(db,{...baseEvent,selectedChoiceId:"prices"}),"handled");
  assert.deepEqual(names(calls),["flow_claim_inbound_durable","flow_resume_button_run"]);
  assert.equal(calls[1].args.p_run,id.run);assert.equal(calls[1].args.p_status,"completed");
 });
});
test("production canary: not eligible in SQL (no row) falls back BEFORE any run change",async()=>{
 await withCanary(async()=>{
  const none={flow_claim_inbound_durable:()=>({data:[],error:null})};
  const begin=lifecycleDb({switches:PROD,rpc:none,active:[{id:id.run,tenant_id:id.tenant,
   conversation_id:id.conversation,run_status:"sleeping"}]});
  assert.equal(await attemptDurableInstagram(begin.db,baseEvent),"fallback");
  assert.deepEqual(names(begin.calls),["flow_claim_inbound_durable"],"no supersede, no begin");
  const tap=lifecycleDb({switches:PROD,rpc:none,awaiting:[waitingRun()]});
  assert.equal(await attemptDurableInstagram(tap.db,{...baseEvent,selectedChoiceId:"prices"}),"fallback");
  assert.deepEqual(names(tap.calls),["flow_claim_inbound_durable"],"no resume");
 });
});
test("production canary: RPC error writes no claim and falls back; duplicate (acquired=false) is handled",async()=>{
 await withCanary(async()=>{
  const err=lifecycleDb({switches:PROD,rpc:{flow_claim_inbound_durable:()=>({data:null,
   error:{code:"PGRST202",message:"function not found"}})}});
  assert.equal(await attemptDurableInstagram(err.db,baseEvent),"fallback");
  assert.deepEqual(names(err.calls),["flow_claim_inbound_durable"]);
  for(const route of ["flow","legacy_ai"]){
   const dup=lifecycleDb({switches:PROD,active:[{id:id.run,tenant_id:id.tenant,
    conversation_id:id.conversation,run_status:"sleeping"}],
    rpc:{flow_claim_inbound_durable:()=>({data:[{acquired:false,route}],error:null})}});
   assert.equal(await attemptDurableInstagram(dup.db,baseEvent),"handled",route);
   assert.deepEqual(names(dup.calls),["flow_claim_inbound_durable"],"winner owns it; nothing superseded");
  }
 });
});
test("test_only mode keeps flow_claim_inbound; undecided/unapproved switches never claim",async()=>{
 await withCanary(async()=>{
  const t=lifecycleDb({switches:{enabled:true,test_only:true,production_approved:true}});
  assert.equal(await attemptDurableInstagram(t.db,baseEvent),"handled");
  assert.deepEqual(names(t.calls),["flow_claim_inbound","flow_begin_durable_run"]);
  assert.equal(t.calls[0].args.p_engine_ready,true);
  // Old test-mode semantics unchanged: a non-acquired/legacy claim fails closed.
  const legacy=lifecycleDb({switches:{enabled:true,test_only:true,production_approved:true},
   rpc:{flow_claim_inbound:()=>({data:[],error:null})}});
  assert.equal(await attemptDurableInstagram(legacy.db,baseEvent),"handled");
  for(const sw of [{enabled:true,test_only:null,production_approved:true},
    {enabled:true,test_only:false,production_approved:false},
    {enabled:false,test_only:false,production_approved:true},null]){
   const x=lifecycleDb({switches:sw});
   assert.equal(await attemptDurableInstagram(x.db,baseEvent),"fallback",JSON.stringify(sw));
   assert.deepEqual(x.calls,[],"no RPC at all");
  }
 });
});
test("production canary: env canary mismatch falls back before any database access",async()=>{
 const old=(globalThis as any).Deno;
 (globalThis as any).Deno={env:{get:(k:string)=>k==="FLOW_DURABLE_INGRESS_ENABLED"?"true":
  k==="FLOW_DURABLE_CANARY_ACCOUNT_ID"?"22222222-2222-4222-8222-222222222222":undefined}};
 try{
  const db={from:()=>{throw Error("Unexpected DB access");},rpc:async()=>{throw Error("Unexpected claim");}};
  assert.equal(await attemptDurableInstagram(db as any,baseEvent),"fallback");
 }finally{(globalThis as any).Deno=old;}
});
// ---- B1: duplicate / previously processed events never touch a (newer) run.
const sleepingRun={id:"99999999-9999-4999-8999-999999999999",tenant_id:id.tenant,
 conversation_id:id.conversation,run_status:"sleeping"};
const everyRoute=[["free text",null],["old valid tap","prices"],["stale tap","old_option"]] as const;
test("B1: an already-claimed event (old free text / tap / trigger) never cancels, resumes or supersedes",async()=>{
 await withCanary(async()=>{
  for(const switches of [undefined,PROD]){
   const claims=[{id:"66666666-6666-4666-8666-666666666666"}];
   for(const [label,choice] of everyRoute){
    const {db,calls,reads}=lifecycleDb({claims,awaiting:[waitingRun()],...(switches?{switches}:{})});
    assert.equal(await attemptDurableInstagram(db,{...baseEvent,selectedChoiceId:choice}),"handled",label);
    assert.deepEqual(calls,[],label+": no cancel, claim or resume");
    assert.equal(reads.some(r=>r.table==="automation_flow_runs"),false,label+": runs never read");
   }
   const begin=lifecycleDb({claims,active:[sleepingRun],...(switches?{switches}:{})});
   assert.equal(await attemptDurableInstagram(begin.db,baseEvent),"handled");
   assert.deepEqual(begin.calls,[],"replayed trigger: no claim, supersede or begin");
  }
 });
});
test("B1: a repeat delivery (second inbound row, no claim yet) leaves every run alone and falls back to V2's claim",async()=>{
 await withCanary(async()=>{
  const inbound=[{id:id.inbound},{id:"77777777-7777-4777-8777-777777777772"}];
  for(const [label,choice] of everyRoute){
   const {db,calls}=lifecycleDb({inbound,awaiting:[waitingRun()]});
   assert.equal(await attemptDurableInstagram(db,{...baseEvent,selectedChoiceId:choice}),"fallback",label);
   assert.deepEqual(calls,[],label);
  }
  const begin=lifecycleDb({inbound:[{id:"77777777-7777-4777-8777-777777777772"}],active:[sleepingRun]});
  assert.equal(await attemptDurableInstagram(begin.db,baseEvent),"fallback");
  assert.deepEqual(begin.calls,[],"no claim, supersede or begin");
 });
});
test("B1: a new event (only its own inbound row) is still processed: free text cancels, tap resumes",async()=>{
 await withCanary(async()=>{
  const own=lifecycleDb({inbound:[{id:id.inbound}],awaiting:[waitingRun()]});
  assert.equal(await attemptDurableInstagram(own.db,baseEvent),"fallback");
  assert.deepEqual(names(own.calls),["flow_cancel_run"]);
  assert.equal(own.calls[0].args.p_reason,"free_text");
  const tap=lifecycleDb({inbound:[{id:id.inbound}],awaiting:[waitingRun()]});
  assert.equal(await attemptDurableInstagram(tap.db,{...baseEvent,selectedChoiceId:"prices"}),"handled");
  assert.deepEqual(names(tap.calls),["flow_claim_inbound","flow_resume_button_run"]);
 });
});
test("B1: the duplicate check is scoped (claim key and tenant conversation), read-only, first, and fails closed",async()=>{
 await withCanary(async()=>{
  const {db,calls,reads}=lifecycleDb({awaiting:[waitingRun()]});
  assert.equal(await attemptDurableInstagram(db,baseEvent),"fallback");
  const claim=reads.find(r=>r.table==="automation_message_claims")!;
  assert.deepEqual(claim.filters,{tenant_id:id.tenant,channel_account_id:id.account,
   platform:"instagram",provider_event_id:"meta-x"});
  const msg=reads.find(r=>r.table==="messages")!;
  assert.deepEqual(msg.filters,{tenant_id:id.tenant,conversation_id:id.conversation,
   direction:"in",wa_message_id:"meta-x"});
  const order=reads.map(r=>r.table);
  assert.ok(order.indexOf("automation_message_claims")<order.indexOf("automation_flow_runs"));
  assert.ok(order.indexOf("messages")<order.indexOf("automation_flow_runs"));
  assert.deepEqual(names(calls),["flow_cancel_run"],"the check itself makes no RPC");
  const broken=lifecycleDb({priorError:true,awaiting:[waitingRun()]});
  assert.equal(await attemptDurableInstagram(broken.db,baseEvent),"handled");
  assert.deepEqual(broken.calls,[]);
 });
});
test("B1: provenance is the explicit flag; synthetic events (no Meta mid) never reach the database",async()=>{
 await withCanary(async()=>{
  // (b)/(c) absent, false or any non-true flag -> fallback with ZERO DB/RPC
  // calls, whatever the id looks like (old ig_<ms> shape or anything else).
  const touched:string[]=[];
  const db={from:(t:string)=>{touched.push("from:"+t);throw Error("Unexpected DB access");},
   rpc:async(n:string)=>{touched.push("rpc:"+n);throw Error("Unexpected RPC");}};
  const {providerEventIdGenuine:_,...unflagged}=baseEvent;
  for(const eventId of ["ig_"+Date.now(),"ig_1730000000000","meta-x","aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOjE3ODQx"])
   for(const flag of [undefined,false,"true",1,null])
    for(const choice of [null,"prices"]){
     const event=flag===undefined?{...unflagged,eventId,selectedChoiceId:choice}:
      {...baseEvent,eventId,selectedChoiceId:choice,providerEventIdGenuine:flag};
     assert.equal(await attemptDurableInstagram(db as any,event as any),"fallback",`${eventId}/${String(flag)}`);
    }
  // Missing id with the flag set is still refused before any DB access.
  for(const eventId of [undefined,null,""])
   assert.equal(await attemptDurableInstagram(db as any,{...baseEvent,eventId} as any),"fallback");
  assert.deepEqual(touched,[],"no read, write or rpc for any synthetic event");
  // (a)/(d) a GENUINE mid shaped like the old synthetic pattern takes the full
  // durable path: B1 prior-delivery check, claim, run creation.
  const g=lifecycleDb({});
  assert.equal(await attemptDurableInstagram(g.db,{...baseEvent,eventId:"ig_1730000000000"}),"handled");
  assert.deepEqual(g.reads.find(r=>r.table==="automation_message_claims")!.filters,
   {tenant_id:id.tenant,channel_account_id:id.account,platform:"instagram",provider_event_id:"ig_1730000000000"});
  assert.deepEqual(names(g.calls),["flow_claim_inbound","flow_begin_durable_run"]);
  assert.equal(g.calls[0].args.p_provider_event_id,"ig_1730000000000");
  // ...and B1 duplicate protection still applies to it.
  const dup=lifecycleDb({claims:[{id:"c"}],awaiting:[waitingRun()]});
  assert.equal(await attemptDurableInstagram(dup.db,{...baseEvent,eventId:"ig_1730000000000"}),"handled");
  assert.deepEqual(dup.calls,[]);
 });
 // Pinned to the real derivation in milan-api/index.ts: the same synthetic id
 // string for V2, plus a flag derived only from the presence of Meta's mid.
 const server=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 assert.equal((server.match(/msg\.mid \|\| `ig_\$\{Date\.now\(\)\}`/g)??[]).length,1);
 assert.equal((server.match(/const providerEventIdGenuine =\n\s+typeof msg\.mid === "string" && msg\.mid\.length > 0;/g)??[]).length,1);
 assert.match(server,/msg\.choiceId,\n\s+providerEventIdGenuine\n\s+\);/);
 assert.match(server,/selectedChoiceId,providerEventIdGenuine:providerEventIdGenuine===true\n/);
 const ing=readFileSync("supabase/functions/milan-api/flowDurableIngress.ts","utf8");
 assert.match(ing,/e\.providerEventIdGenuine===true&&/);
 assert.doesNotMatch(ing,/ig_\\d|syntheticInstagramEventId/,"no format-based provenance");
});
test("ingress source: production canary uses only the separate claim function; V2 call site untouched",()=>{
 const src=readFileSync("supabase/functions/milan-api/flowDurableIngress.ts","utf8");
 assert.equal((src.match(/rpc\("flow_claim_inbound_durable"/g)??[]).length,1);
 assert.equal((src.match(/rpc\("flow_claim_inbound"/g)??[]).length,1);
 assert.match(src,/Deno\.env\.get\("FLOW_DURABLE_CANARY_ACCOUNT_ID"\)!==event\.accountId/);
 const server=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 assert.doesNotMatch(server,/flow_claim_inbound_durable/);
});

// ---- Multi-step durable chains (whitelisted node subset, planUntilWait).
import {durableCandidateKind,durableRuntimeNeeds} from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {simpleMessageFromDocument} from "../supabase/functions/milan-api/flowPrepareMessage.ts";
import {seedFromEventKey,randomizerField} from "../src/flow/runtimeChain.ts";
const T={id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}};
const txt=(nid:string,text:string)=>({id:nid,data:{kind:"message",text,image:"",options:[],contentBlocks:[]}});
const E=(source:string,target:string,sourceHandle="next")=>({source,target,sourceHandle});
// trigger -> welcome -> button menu -> answers -> delay -> follow-up -> end
const chainDoc={version:3,name:"chain",nodes:[T,txt("welcome","أهلاً بك"),
 {id:"menu",data:{kind:"message",text:"اختر",image:"",contentBlocks:[],inputField:"menu",options:[
  {id:"prices",label:"الأسعار",action:"step",buttonType:"quick_reply",url:"",targetFlowId:""},
  {id:"support",label:"المساعدة"}]}},
 txt("ans_prices","هذه الأسعار"),txt("ans_support","تواصل معنا"),
 {id:"wait",data:{kind:"delay",delayValue:1,delayUnit:"days"}},
 txt("follow","هل تحتاج شيئاً آخر؟"),{id:"done",data:{kind:"end"}}
],edges:[E("start","welcome"),E("welcome","menu"),E("menu","ans_prices","prices"),
 E("menu","ans_support","support"),E("ans_prices","wait"),E("ans_support","wait"),
 E("wait","follow"),E("follow","done")]};
// set_field, condition (on a run variable), randomizer and goto.
const logicDoc={version:3,nodes:[T,
 {id:"tier",data:{kind:"action",actionType:"set_field",actionValue:"tier=gold"}},
 {id:"isGold",data:{kind:"condition",conditionField:"tier",operator:"equals",conditionValue:"gold"}},
 {id:"ab",data:{kind:"randomizer",options:[{id:"a",label:"A",weight:50},{id:"b",label:"B",weight:50}]}},
 txt("ma","نسخة أ"),txt("mb","نسخة ب"),{id:"jump",data:{kind:"goto",gotoNode:"bye"}},
 txt("other","عرض عام"),txt("bye","شكراً"),{id:"q",data:{kind:"question",inputMode:"buttons",text:"قيّمنا",
  image:"",contentBlocks:[],options:[{id:"good",label:"جيد"}]}},{id:"fin",data:{kind:"end"}}
],edges:[E("start","tier"),E("tier","isGold"),E("isGold","ab","yes"),E("isGold","other","no"),
 E("ab","ma","a"),E("ab","mb","b"),E("ma","jump"),E("mb","jump"),E("other","q"),E("q","fin","good")]};
const node=(d:any,nid:string,patch:Record<string,unknown>)=>({...d,nodes:d.nodes.map((n:any)=>
 n.id===nid?{...n,data:{...n.data,...patch}}:n)});
test("chain whitelist accepts multi-step graphs and classifies the operator flags they need",()=>{
 assert.equal(supportedDurableDocument(chainDoc),true);
 assert.equal(supportedDurableDocument(logicDoc),true);
 assert.deepEqual(durableRuntimeNeeds(chainDoc as any),{buttons:true,scheduler:true});
 assert.equal(durableCandidateKind(chainDoc),"mixed");
 assert.equal(durableCandidateKind(logicDoc),"buttons");
 const texts={version:3,nodes:[T,txt("a","one"),txt("b","two"),{id:"z",data:{kind:"end"}}],
  edges:[E("start","a"),E("a","b"),E("b","z")]};
 assert.equal(durableCandidateKind(texts),"text");
 // The two original shapes keep their exact classification.
 assert.equal(durableCandidateKind(doc),"buttons");
 assert.equal(durableCandidateKind({version:3,nodes:[T,{id:"sleep",data:{kind:"delay",delayValue:1,delayUnit:"minutes"}},txt("yes","x")],
  edges:[E("start","sleep"),E("sleep","yes")]}),"delay");
 assert.equal(durableCandidateKind({version:3,nodes:[],edges:[]}),"unsupported");
 // 13 buttons with 20-char labels are the limit.
 const many=Array.from({length:13},(_,i)=>({id:"o"+i,label:"x".repeat(20)}));
 const wide={version:3,nodes:[T,{id:"m",data:{kind:"message",text:"pick",image:"",contentBlocks:[],options:many}},
  ...many.map(o=>txt("t"+o.id,"ok"))],edges:[E("start","m"),...many.map(o=>E("m","t"+o.id,o.id))]};
 assert.equal(supportedDurableDocument(wide),true);
});
test("chain whitelist rejects every unsupported feature (fail closed)",()=>{
 const bad:Array<[string,unknown]>=[
  ["http request",{...chainDoc,nodes:[...chainDoc.nodes,{id:"http",data:{kind:"request",requestUrl:"https://x"}}],
   edges:[...chainDoc.edges.filter(e=>e.source!=="follow"),E("follow","http")]}],
  // tag/untag/notify/handoff are live now (internal executor); AI is not.
  ["action ai",node(logicDoc,"tier",{actionType:"ai",actionValue:"vip"})],
  ["handoff with text",node(logicDoc,"tier",{actionType:"handoff",actionValue:"vip"})],
  ["set_field writes inbound field",node(logicDoc,"tier",{actionValue:"message=hi"})],
  ["condition on inbound message",node(logicDoc,"isGold",{conditionField:"message"})],
  ["condition on Message",node(logicDoc,"isGold",{conditionField:"Message"})],
  ["free-text question",node(logicDoc,"q",{inputMode:"text",inputField:"answer"})],
  ["email question",node(logicDoc,"q",{inputMode:"email"})],
  ["phone question",node(logicDoc,"q",{inputMode:"phone"})],
  ["website button",node(chainDoc,"menu",{options:[{id:"prices",label:"site",action:"website",url:"https://x.example"},{id:"support",label:"b"}]})],
  ["flow button",node(chainDoc,"menu",{options:[{id:"prices",label:"f",action:"flow"},{id:"support",label:"b"}]})],
  ["AI button",node(chainDoc,"menu",{options:[{id:"prices",label:"f",action:"ai"},{id:"support",label:"b"}]})],
  ["image",node(chainDoc,"welcome",{image:"https://img.example/a.png"})],
  ["content blocks",node(chainDoc,"welcome",{contentBlocks:[{id:"b",type:"image",url:"https://x"}]})],
  ["delay 31",node(chainDoc,"wait",{delayValue:31})],
  ["delay 0",node(chainDoc,"wait",{delayValue:0})],
  ["label 21 chars",node(chainDoc,"menu",{options:[{id:"prices",label:"x".repeat(21)},{id:"support",label:"b"}]})],
  ["14 buttons",node(chainDoc,"menu",{options:Array.from({length:14},(_,i)=>({id:"o"+i,label:"o"}))})],
  ["blank text",node(chainDoc,"follow",{text:"  "})],
  ["comment trigger",node(chainDoc,"start",{triggerMode:"comment"})],
  ["messenger trigger",node(chainDoc,"start",{platform:"messenger"})],
  ["unknown kind",{...chainDoc,nodes:[...chainDoc.nodes,{id:"x",data:{kind:"teleport"}}],edges:[...chainDoc.edges.filter(e=>e.source!=="follow"),E("follow","x")]}],
  ["unreachable node",{...chainDoc,nodes:[...chainDoc.nodes,txt("orphan","lost")]}],
  ["missing button branch",{...chainDoc,edges:chainDoc.edges.filter(e=>e.sourceHandle!=="support")}],
  ["duplicate branch",{...chainDoc,edges:[...chainDoc.edges,E("welcome","follow")]}],
  ["next from a button message",{...chainDoc,edges:[...chainDoc.edges,E("menu","follow")]}],
  ["delay without next",{...chainDoc,edges:chainDoc.edges.filter(e=>e.source!=="wait")}],
  ["edge into trigger",{...chainDoc,edges:[...chainDoc.edges.filter(e=>e.source!=="follow"),E("follow","start")]}],
  ["goto to missing node",node(logicDoc,"jump",{gotoNode:"nowhere"})],
  ["second trigger",{...chainDoc,nodes:[...chainDoc.nodes,{...T,id:"start2"}]}],
 ];
 for(const [label,d] of bad)assert.equal(supportedDurableDocument(d),false,label);
});
// V2 shapes (flowPrepareMessage.ts) must keep falling back to V2.
const v2Lone={version:3,nodes:[T,txt("hi","أهلاً")],edges:[E("start","hi")]};
const v2Cond={version:3,nodes:[T,{id:"c",data:{kind:"condition",conditionField:"message",operator:"contains",conditionValue:"سعر"}},
 txt("y","الأسعار"),txt("n","مرحباً")],edges:[E("start","c"),E("c","y","yes"),E("c","n","no")]};
test("V2 shapes are never durable: lone trigger->text and trigger->condition(message)->2 texts fall back",async()=>{
 for(const d of [v2Lone,v2Cond]){
  assert.notEqual(simpleMessageFromDocument(d,"instagram","سعر"),null,"V2 still handles it");
  assert.equal(supportedDurableDocument(d),false);
  assert.equal(durableCandidateKind(d),"unsupported");
 }
 await withCanary(async()=>{
  for(const d of [v2Lone,v2Cond]){
   const {db,calls}=lifecycleDb({document:d});
   assert.equal(await attemptDurableInstagram(db,baseEvent),"fallback");
   assert.deepEqual(calls,[],"no claim, supersede or run: V2 claims as before");
  }
 });
});
test("start path plans the whole chain until the first wait, one begin with seq-ordered effects",async()=>{
 await withCanary(async()=>{
  const {db,calls}=lifecycleDb({document:chainDoc});
  assert.equal(await attemptDurableInstagram(db,baseEvent),"handled");
  assert.deepEqual(names(calls),["flow_claim_inbound","flow_begin_durable_run"]);
  const b=calls[1].args;
  assert.equal(b.p_status,"awaiting_input");assert.equal(b.p_next,"menu");assert.equal(b.p_wake,null);
  assert.deepEqual(b.p_effects.map((e:any)=>[e.kind,e.payload.seq,e.payload.text]),
   [["message",0,"أهلاً بك"],["question",1,"اختر"]]);
  assert.deepEqual(b.p_effects[1].payload.choiceIds,["prices","support"]);
  assert.deepEqual(b.p_variables,{});
 });
});
test("button resume chains answer -> delay in one commit; stale buttons still behave like free text",async()=>{
 await withCanary(async()=>{
  const run=waitingRun({current_node_id:"menu",step_count:3});
  const {db,calls}=lifecycleDb({document:chainDoc,awaiting:[run]});
  assert.equal(await attemptDurableInstagram(db,{...baseEvent,eventId:"meta-tap",selectedChoiceId:"support"}),"handled");
  assert.deepEqual(names(calls),["flow_claim_inbound","flow_resume_button_run"]);
  const r=calls[1].args;
  assert.equal(r.p_expect_node,"menu");assert.equal(r.p_status,"sleeping");assert.equal(r.p_next,"wait");
  assert.ok(typeof r.p_wake==="string"&&Date.parse(r.p_wake)>Date.now()+86000000);
  assert.deepEqual(r.p_effects.map((e:any)=>[e.kind,e.payload.seq]),[["message",0],["delay",1]]);
  assert.equal(r.p_effects[0].payload.text,"تواصل معنا");
  // Only the tapped button id is stored; never any inbound customer text.
  assert.deepEqual(r.p_variables,{menu:"support"});
  for(const stale of ["old_option","prices-old"]){
   const s=lifecycleDb({document:chainDoc,awaiting:[run]});
   assert.equal(await attemptDurableInstagram(s.db,{...baseEvent,selectedChoiceId:stale}),"fallback");
   assert.deepEqual(names(s.calls),["flow_cancel_run"]);assert.equal(s.calls[0].args.p_reason,"free_text");
  }
 });
});
test("randomizer seed comes from the event id (deterministic, not constant); no inbound text in variables",async()=>{
 const src=readFileSync("supabase/functions/milan-api/flowDurableIngress.ts","utf8");
 assert.doesNotMatch(src,/seed:0/);
 // start, button resume and typed-answer resume.
 assert.equal((src.match(/seed:seedFromEventKey\(event\.eventId\)/g)??[]).length,3);
 assert.doesNotMatch(src,/customerText|incomingText|variables:\{[^}]*message/);
 const worker=readFileSync("supabase/functions/flow-runtime-worker/index.ts","utf8");
 assert.doesNotMatch(worker,/seed:0/);
 await withCanary(async()=>{
  const field=randomizerField("ab");
  const begin=async(eventId:string)=>{
   const {db,calls}=lifecycleDb({document:logicDoc});
   assert.equal(await attemptDurableInstagram(db,{...baseEvent,eventId}),"handled");
   return calls.find(c=>c.name==="flow_begin_durable_run")!.args;
  };
  const a=await begin("meta-seed-1"),again=await begin("meta-seed-1");
  assert.deepEqual(again.p_variables,a.p_variables,"same event id -> same branch");
  assert.equal(a.p_effects[0].payload.text,a.p_variables[field]==="a"?"نسخة أ":"نسخة ب");
  const seen=new Set<string>();
  for(let i=0;i<24;i++){
   const p=await begin("meta-seed-v"+i);
   seen.add(p.p_variables[field]);
   assert.deepEqual(Object.keys(p.p_variables).sort(),[field,"tier"].sort(),"only set_field/randomizer values");
   assert.equal("message" in p.p_variables,false);
  }
  assert.deepEqual([...seen].sort(),["a","b"],"seed varies with the event id");
  assert.notEqual(seedFromEventKey("meta-seed-1"),seedFromEventKey("meta-seed-2"));
 });
});
test("a chain needing a 6th effect fails closed before any claim",async()=>{
 const six={version:3,nodes:[T,...[1,2,3,4,5,6].map(i=>txt("m"+i,"رسالة "+i))],
  edges:[E("start","m1"),...[1,2,3,4,5].map(i=>E("m"+i,"m"+(i+1)))]};
 assert.equal(supportedDurableDocument(six),true);
 await withCanary(async()=>{
  const {db,calls}=lifecycleDb({document:six});
  assert.equal(await attemptDurableInstagram(db,baseEvent),"handled");
  assert.deepEqual(calls,[],"no claim, no run, no effect");
  const five={...six,nodes:six.nodes.slice(0,6),edges:six.edges.slice(0,5)};
  const ok=lifecycleDb({document:five});
  assert.equal(await attemptDurableInstagram(ok.db,baseEvent),"handled");
  const b=ok.calls.find(c=>c.name==="flow_begin_durable_run")!.args;
  assert.deepEqual(b.p_effects.map((e:any)=>e.payload.seq),[0,1,2,3,4]);
  assert.equal(b.p_status,"completed");
 });
});
test("index.ts is untouched by the chain feature",()=>{
 const server=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 assert.doesNotMatch(server,/planUntilWait|runtimeChain|durableCandidateKind/);
});

// ---- Typed-answer questions (text/email/phone): collect, validate, re-ask.
import {reaskField,MAX_REASKS} from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {normalizeDurableAnswer,reaskText} from "../supabase/functions/milan-api/flowDurableAnswer.ts";
const ask=(nid:string,inputMode:string,inputField:string,text:string)=>
 ({id:nid,data:{kind:"question",inputMode,inputField,text,image:"",contentBlocks:[],options:[]}});
// trigger -> ask email -> thanks {{email}} -> condition(email contains @vip.) -> vip | std
const collectDoc={version:3,name:"collect",nodes:[T,ask("askEmail","email","email","ما بريدك الإلكتروني؟"),
 txt("thanks","شكراً، سجلنا {{email}}"),
 {id:"isVip",data:{kind:"condition",conditionField:"email",operator:"contains",conditionValue:"@vip."}},
 txt("vip","عرض VIP"),txt("std","عرض عادي")],
 edges:[E("start","askEmail"),E("askEmail","thanks","valid"),E("thanks","isVip"),
  E("isVip","vip","yes"),E("isVip","std","no")]};
const asMode=(mode:string,field:string)=>({...collectDoc,nodes:collectDoc.nodes.map((n:any)=>n.id==="askEmail"?
 {...n,data:{...n.data,inputMode:mode,inputField:field}}:n.id==="thanks"?
 {...n,data:{...n.data,text:"شكراً، سجلنا {{"+field+"}}"}}:n)});
const atAsk=(over:Record<string,unknown>={})=>waitingRun({current_node_id:"askEmail",step_count:2,...over});
const typedEvent=(text:unknown,over:Record<string,unknown>={})=>({...baseEvent,eventId:"meta-answer",text,...over}) as any;
const resumeArgs=(calls:Array<{name:string;args:any}>)=>calls.find(c=>c.name==="flow_resume_button_run")!.args;

test("typed questions: whitelist accepts text/email/phone with a safe inputField and exactly one destination",()=>{
 assert.equal(supportedDurableDocument(collectDoc),true);
 for(const m of ["text","email","phone"])assert.equal(supportedDurableDocument(asMode(m,"answer_1")),true,m);
 // "next" (planner fallback port) is accepted instead of "valid", never both.
 const viaNext={...collectDoc,edges:collectDoc.edges.map(e=>e.source==="askEmail"?E("askEmail","thanks","next"):e)};
 assert.equal(supportedDurableDocument(viaNext),true);
 const noHandle={...collectDoc,edges:collectDoc.edges.map(e=>e.source==="askEmail"?{source:"askEmail",target:"thanks"}:e)};
 assert.equal(supportedDurableDocument(noHandle),true,"missing sourceHandle means next");
 // Needs neither buttons nor scheduler: a pure text candidate.
 assert.deepEqual(durableRuntimeNeeds(collectDoc as any),{buttons:false,scheduler:false});
 assert.equal(durableCandidateKind(collectDoc),"text");
 const withDelay={...collectDoc,nodes:[...collectDoc.nodes,{id:"w",data:{kind:"delay",delayValue:1,delayUnit:"minutes"}}],
  edges:[...collectDoc.edges.filter(e=>e.source!=="askEmail"),E("askEmail","w","valid"),E("w","thanks")]};
 assert.equal(durableCandidateKind(withDelay),"delay");
 // Combined with a button question it still needs the buttons sender.
 assert.equal(durableCandidateKind({...logicDoc,nodes:[...logicDoc.nodes,ask("collect","text","note","ملاحظة؟")],
  edges:[...logicDoc.edges.filter(e=>e.source!=="q"),E("q","collect","good"),E("collect","fin","valid")]}),"buttons");
});
test("typed questions: whitelist rejects unsafe fields, other modes, buttons and ambiguous branches",()=>{
 const patch=(p:Record<string,unknown>)=>node(collectDoc,"askEmail",p);
 const bad:Array<[string,unknown]>=[
  ["field message",patch({inputField:"message"})],["field Message",patch({inputField:"Message"})],
  ["field MESSAGE",patch({inputField:"MESSAGE"})],["reserved __ field",patch({inputField:"__reask_x"})],
  ["field constructor",patch({inputField:"constructor"})],["empty field",patch({inputField:""})],
  ["missing field",patch({inputField:undefined})],["field with dash",patch({inputField:"e-mail"})],
  ["field starting with digit",patch({inputField:"1email"})],["65-char field",patch({inputField:"a".repeat(65)})],
  ["number mode",patch({inputMode:"number"})],["unknown mode",patch({inputMode:"date"})],
  ["buttons on a typed question",patch({options:[{id:"x",label:"x"}]})],
  ["blank question",patch({text:"  "})],["oversize question",patch({text:"س".repeat(501)})],
  ["image",patch({image:"https://img.example/a.png"})],
  ["no destination",{...collectDoc,edges:collectDoc.edges.filter(e=>e.source!=="askEmail"),
   nodes:collectDoc.nodes}],
  ["valid and next both connected",{...collectDoc,edges:[...collectDoc.edges,E("askEmail","std","next")]}],
  ["legacy invalid port",{...collectDoc,edges:[...collectDoc.edges,E("askEmail","std","invalid")]}],
  ["condition on message",node(collectDoc,"isVip",{conditionField:"message"})],
 ];
 for(const [label,d] of bad)assert.equal(supportedDurableDocument(d),false,label);
});
test("typed answers: validation and normalization rules per type",()=>{
 const ok:Array<[any,string,string]>=[
  ["text","  مرحبا بكم  ","مرحبا بكم"],["text","line1\nline2\tend","line1 line2 end"],
  ["email","  Ali.Hassan+shop@Example.CO.uk ","ali.hassan+shop@example.co.uk"],
  ["phone","+964 770-123-4567","+9647701234567"],["phone","(0770) 123 4567","07701234567"],
  ["phone","٠٧٧٠١٢٣٤٥٦٧","07701234567"],["phone","00964 770 123 4567","+9647701234567"],
  ["phone","1234567","1234567"]];
 for(const [m,raw,want] of ok)assert.equal(normalizeDurableAnswer(m,raw),want,m+":"+raw);
 const bad:Array<[any,unknown]>=[
  ["text",""],["text","   "],["text","abc\u0007"],["text","x\u202Ey"],["text","a".repeat(501)],
  ["text","a".repeat(1001)],["text",null],["text",undefined],["text",42],
  ["email","not-an-email"],["email","a@b"],["email","a@@b.com"],["email","a..b@x.com"],
  ["email",".a@x.com"],["email","a@-x.com"],["email","a@x.c0m"],["email","a b@x.com"],
  ["email","a".repeat(65)+"@x.com"],["email","a@"+"b".repeat(250)+".com"],["email","ali@مثال.com"],
  ["phone","12345"],["phone","1234567890123456"],["phone","+964+770"],["phone","770-abc-1234"],
  ["phone","9647701234567+"],["phone",""]];
 for(const [m,raw] of bad)assert.equal(normalizeDurableAnswer(m,raw),null,m+":"+String(raw).slice(0,30));
 assert.match(reaskText("email","ما بريدك؟"),/^يرجى إرسال بريد إلكتروني صحيح.*\nما بريدك؟$/);
 assert.match(reaskText("phone","What is your phone number?"),/^Please send a valid phone number/);
 assert.ok(new TextEncoder().encode(reaskText("text","س".repeat(499))).byteLength<=1000);
});
test("typed answer: valid email resumes the SAME run, stores the normalized value, renders it and branches on it",async()=>{
 await withCanary(async()=>{
  for(const [raw,stored,branch] of [[" Sara@VIP.Example.com ","sara@vip.example.com","عرض VIP"],
    ["ali@shop.example","ali@shop.example","عرض عادي"]]){
   const {db,calls}=lifecycleDb({document:collectDoc,awaiting:[atAsk()]});
   assert.equal(await attemptDurableInstagram(db,typedEvent(raw)),"handled");
   assert.deepEqual(names(calls),["flow_claim_inbound","flow_resume_button_run"],"no cancel");
   const r=resumeArgs(calls);
   assert.equal(r.p_run,id.run);assert.equal(r.p_expect_node,"askEmail");assert.equal(r.p_expect_step,2);
   assert.equal(r.p_status,"completed");assert.equal(r.p_wake,null);
   assert.deepEqual(r.p_variables,{email:stored});
   assert.deepEqual(r.p_effects.map((e:any)=>[e.kind,e.payload.seq,e.payload.text]),
    [["message",0,"شكراً، سجلنا "+stored],["message",1,branch]]);
   assert.equal("message" in r.p_variables,false);
  }
 });
});
test("typed answer: text and phone questions store the normalized value under their own field",async()=>{
 await withCanary(async()=>{
  for(const [mode,field,raw,stored] of [["text","full_name","  أحمد علي ","أحمد علي"],
    ["phone","phone","+964 770-123-4567","+9647701234567"],["phone","phone","٠٧٧٠١٢٣٤٥٦٧","07701234567"]]){
   const {db,calls}=lifecycleDb({document:asMode(mode,field),awaiting:[atAsk()]});
   assert.equal(await attemptDurableInstagram(db,typedEvent(raw)),"handled",mode);
   const r=resumeArgs(calls);
   assert.deepEqual(r.p_variables,{[field]:stored});
   assert.equal(r.p_effects[0].payload.text,"شكراً، سجلنا "+stored);
  }
 });
});
test("typed answer: the answer -> end path completes without effects",async()=>{
 await withCanary(async()=>{
  const ends={version:3,nodes:[T,ask("askEmail","text","note","ملاحظة؟"),{id:"z",data:{kind:"end"}}],
   edges:[E("start","askEmail"),E("askEmail","z","valid")]};
  assert.equal(supportedDurableDocument(ends),true);
  const {db,calls}=lifecycleDb({document:ends,awaiting:[atAsk()]});
  assert.equal(await attemptDurableInstagram(db,typedEvent("شكرا")),"handled");
  const r=resumeArgs(calls);
  assert.equal(r.p_status,"completed");assert.deepEqual(r.p_effects,[]);assert.deepEqual(r.p_variables,{note:"شكرا"});
 });
});
test("typed answer: invalid answer re-asks on the SAME node, keeps the run, counts attempts; bound hands over to V2 without cancel",async()=>{
 await withCanary(async()=>{
  const key=reaskField("askEmail");
  assert.ok(key.startsWith("__reask_"));
  for(const raw of ["not-an-email","   ","a".repeat(1001),undefined,null,"x\u0000@y.com"]){
   const {db,calls}=lifecycleDb({document:collectDoc,awaiting:[atAsk()]});
   assert.equal(await attemptDurableInstagram(db,typedEvent(raw)),"handled",String(raw).slice(0,20));
   assert.deepEqual(names(calls),["flow_claim_inbound","flow_resume_button_run"],"claimed + committed, never cancelled");
   const r=resumeArgs(calls);
   assert.equal(r.p_next,"askEmail");assert.equal(r.p_expect_node,"askEmail");
   assert.equal(r.p_status,"awaiting_input");assert.equal(r.p_wake,null);
   assert.equal(r.p_expect_step,2);assert.equal(r.p_next_step,3);
   assert.deepEqual(r.p_variables,{[key]:"1"},"no answer stored");
   assert.equal(r.p_effects.length,1);
   assert.equal(r.p_effects[0].kind,"message");assert.equal(r.p_effects[0].payload.seq,0);
   assert.equal(r.p_effects[0].payload.text,"يرجى إرسال بريد إلكتروني صحيح، مثل name@example.com\nما بريدك الإلكتروني؟");
   assert.ok(!JSON.stringify(r).includes("not-an-email"),"invalid text is never stored or sent");
  }
  // Counter increases up to the bound...
  const two=lifecycleDb({document:collectDoc,awaiting:[atAsk({variables:{[key]:"2"},step_count:4})]});
  assert.equal(await attemptDurableInstagram(two.db,typedEvent("bad")),"handled");
  assert.deepEqual(resumeArgs(two.calls).p_variables,{[key]:String(MAX_REASKS)});
  // ...then no re-prompt: V2 answers, run untouched (no claim, no cancel, no commit).
  for(const c of [String(MAX_REASKS),"9","x"]){
   const done=lifecycleDb({document:collectDoc,awaiting:[atAsk({variables:{[key]:c},step_count:5})]});
   assert.equal(await attemptDurableInstagram(done.db,typedEvent("still bad")),"fallback");
   assert.deepEqual(done.calls,[],"no claim, cancel or commit at the bound");
  }
  // A valid answer after re-asks resumes and drops the counter.
  const later=lifecycleDb({document:collectDoc,awaiting:[atAsk({variables:{[key]:String(MAX_REASKS),keep:"x"},step_count:5})]});
  assert.equal(await attemptDurableInstagram(later.db,typedEvent("ok@shop.example")),"handled");
  const r=resumeArgs(later.calls);
  assert.deepEqual(r.p_variables,{keep:"x",email:"ok@shop.example"});
  assert.equal(r.p_expect_step,5);assert.equal(r.p_status,"completed");
  // English question -> English re-ask.
  const en=lifecycleDb({document:node(collectDoc,"askEmail",{text:"What is your email?"}),awaiting:[atAsk()]});
  assert.equal(await attemptDurableInstagram(en.db,typedEvent("nope")),"handled");
  assert.equal(resumeArgs(en.calls).p_effects[0].payload.text,"Please send a valid email address, e.g. name@example.com\nWhat is your email?");
 });
});
test("typed answer: a tap (current or stale) while a typed question waits keeps the run and falls back to V2",async()=>{
 await withCanary(async()=>{
  for(const choice of ["prices","old_option"]){
   const {db,calls}=lifecycleDb({document:collectDoc,awaiting:[atAsk()]});
   assert.equal(await attemptDurableInstagram(db,typedEvent("الأسعار",{selectedChoiceId:choice})),"fallback");
   assert.deepEqual(calls,[],"no cancel, claim or variable change");
  }
  // Free text while a BUTTON question waits: unchanged (cancel free_text + V2).
  const btn=lifecycleDb({awaiting:[waitingRun()]});
  assert.equal(await attemptDurableInstagram(btn.db,typedEvent("ali@x.com")),"fallback");
  assert.deepEqual(names(btn.calls),["flow_cancel_run"]);assert.equal(btn.calls[0].args.p_reason,"free_text");
 });
});
test("typed answer: duplicates, foreign rows, inactive revision and synthetic ids never resume twice or change state",async()=>{
 await withCanary(async()=>{
  // Already claimed (redelivery after the first copy committed): inert.
  for(const raw of ["ok@shop.example","bad"]){
   const dup=lifecycleDb({document:collectDoc,awaiting:[atAsk()],claims:[{id:"c"}]});
   assert.equal(await attemptDurableInstagram(dup.db,typedEvent(raw)),"handled");
   assert.deepEqual(dup.calls,[],"no second re-ask or resume");
   // Concurrent copy that loses the exclusive claim: no commit.
   const lost=lifecycleDb({document:collectDoc,awaiting:[atAsk()],
    rpc:{flow_claim_inbound:()=>({data:[{acquired:false,route:"flow"}],error:null})}});
   assert.equal(await attemptDurableInstagram(lost.db,typedEvent(raw)),"handled");
   assert.deepEqual(names(lost.calls),["flow_claim_inbound"]);
   // Second inbound row with the same provider id (no claim yet): V2, run untouched.
   const rep=lifecycleDb({document:collectDoc,awaiting:[atAsk()],
    inbound:[{id:id.inbound},{id:"77777777-7777-4777-8777-777777777772"}]});
   assert.equal(await attemptDurableInstagram(rep.db,typedEvent(raw)),"fallback");
   assert.deepEqual(rep.calls,[]);
  }
  for(const over of [{tenant_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},
    {channel_account_id:"22222222-2222-4222-8222-222222222222"},
    {conversation_id:"55555555-5555-4555-8555-555555555555"}]){
   const f=lifecycleDb({document:collectDoc,awaiting:[atAsk(over)]});
   assert.equal(await attemptDurableInstagram(f.db,typedEvent("ok@shop.example")),"handled");
   assert.deepEqual(f.calls,[]);
  }
  const off=lifecycleDb({document:collectDoc,awaiting:[atAsk()],activations:[]});
  assert.equal(await attemptDurableInstagram(off.db,typedEvent("ok@shop.example")),"fallback");
  assert.deepEqual(names(off.calls),["flow_cancel_run"]);assert.equal(off.calls[0].args.p_reason,"revision_inactive");
  // A publication read error fails closed without touching the run.
  const touched:string[]=[];
  const db={from:(t:string)=>{touched.push("from:"+t);throw Error("Unexpected DB access");},
   rpc:async(n:string)=>{touched.push("rpc:"+n);throw Error("Unexpected RPC");}};
  for(const flag of [false,undefined,"true"])
   assert.equal(await attemptDurableInstagram(db as any,typedEvent("ok@shop.example",{providerEventIdGenuine:flag})),"fallback");
  assert.deepEqual(touched,[],"synthetic events never reach the database");
 });
});
test("typed answer: production canary resumes through flow_claim_inbound_durable",async()=>{
 await withCanary(async()=>{
  const {db,calls}=lifecycleDb({switches:PROD,document:collectDoc,awaiting:[atAsk()]});
  assert.equal(await attemptDurableInstagram(db,typedEvent("ok@shop.example")),"handled");
  assert.deepEqual(names(calls),["flow_claim_inbound_durable","flow_resume_button_run"]);
  const none=lifecycleDb({switches:PROD,document:collectDoc,awaiting:[atAsk()],
   rpc:{flow_claim_inbound_durable:()=>({data:[],error:null})}});
  assert.equal(await attemptDurableInstagram(none.db,typedEvent("bad")),"fallback");
  assert.deepEqual(names(none.calls),["flow_claim_inbound_durable"],"not eligible: no re-ask, no change");
 });
});
test("typed answer: the customer's answer is never logged, even when the commit fails",async()=>{
 await withCanary(async()=>{
  const logs:string[]=[];const saved={warn:console.warn,error:console.error,log:console.log,info:console.info};
  const cap=(...a:unknown[])=>{logs.push(a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" "));};
  console.warn=cap;console.error=cap;console.log=cap;console.info=cap;
  try{
   for(const raw of ["secret.person@shop.example","+964 770 999 8888","bad-secret-text"]){
    const fail=lifecycleDb({document:raw.startsWith("+")?asMode("phone","phone"):collectDoc,awaiting:[atAsk()],
     rpc:{flow_resume_button_run:()=>({data:null,error:{code:"XX000",message:"db down"}})}});
    assert.equal(await attemptDurableInstagram(fail.db,typedEvent(raw)),"handled");
   }
  }finally{Object.assign(console,saved);}
  assert.ok(logs.length>0);
  for(const l of logs)assert.doesNotMatch(l,/secret|9998888|999 8888|shop\.example/);
 });
 const src=readFileSync("supabase/functions/milan-api/flowDurableIngress.ts","utf8");
 assert.doesNotMatch(src,/console\.[a-z]+\([^)]*(event\.text|[,(]\s*answer\b)/);
});
test("index.ts passes the inbound text to the durable path only (V2 call site keeps its own arguments)",()=>{
 const server=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 assert.equal((server.match(/text:customerText,\n\s+selectedChoiceId,providerEventIdGenuine/g)??[]).length,1);
 assert.match(server,/prepareFlow: \(\) => prepareSimpleFlowReply\(\n\s+sb, tenantId, String\(account\.id\), channel, customerText\n\s+\)/);
});

// ---- Internal actions: tag / untag / notify / handoff (Instagram durable only).
import {durableNeedsInternalActions,safePlan,tagOk,notifyOk} from "../supabase/functions/milan-api/flowDurableIngress.ts";
const act=(nid:string,actionType:string,actionValue="")=>({id:nid,data:{kind:"action",actionType,actionValue}});
// welcome -> email question -> tag -> notify {{email}} -> handoff message -> handoff
const handoffDoc={version:3,name:"lead handoff",nodes:[T,txt("welcome","أهلاً بك"),
 ask("askEmail","email","email","ما بريدك؟"),act("tagLead","tag","lead"),
 act("notify","notify","عميل جديد {{email}}"),txt("bye","سيتواصل معك موظف الآن"),act("human","handoff")],
 edges:[E("start","welcome"),E("welcome","askEmail"),E("askEmail","tagLead","valid"),
  E("tagLead","notify"),E("notify","bye"),E("bye","human")]};
test("internal actions: whitelist accepts tag/untag/notify/handoff with valid fields and flags the operator need",()=>{
 assert.equal(supportedDurableDocument(handoffDoc),true);
 assert.equal(durableNeedsInternalActions(handoffDoc as any),true);
 // Not a new candidate kind: buttons/scheduler classification is unchanged.
 assert.equal(durableCandidateKind(handoffDoc),"text");
 assert.deepEqual(durableRuntimeNeeds(handoffDoc as any),{buttons:false,scheduler:false});
 for(const d of [chainDoc,logicDoc,collectDoc])assert.equal(durableNeedsInternalActions(d as any),false);
 const untag={version:3,nodes:[T,act("u","untag","vip"),txt("m","تم")],edges:[E("start","u"),E("u","m")]};
 assert.equal(supportedDurableDocument(untag),true);
 // tag/notify may end the flow (no next); handoff alone after the trigger.
 assert.equal(supportedDurableDocument({version:3,nodes:[T,txt("a","x"),act("t","tag","عميل_مميز 2")],
  edges:[E("start","a"),E("a","t")]}),true);
 assert.equal(supportedDurableDocument({version:3,nodes:[T,act("h","handoff")],edges:[E("start","h")]}),true);
 assert.equal(supportedDurableDocument({version:3,nodes:[T,{id:"h",data:{kind:"action",actionType:"handoff"}}],
  edges:[E("start","h")]}),true,"absent actionValue");
 assert.equal(tagOk("VIP lead-1"),true);assert.equal(notifyOk("سطر\nثاني"),true);
});
test("internal actions: invalid fields, edges after a handoff and AI stay rejected (fail closed)",()=>{
 const withAct=(a:any,extra:any[]=[],edges=[E("start","x")])=>({version:3,nodes:[T,a,...extra],edges});
 const bad:Array<[string,unknown]>=[
  ["empty tag",withAct(act("x","tag","  "))],
  ["65-char tag",withAct(act("x","tag","a".repeat(65)))],
  ["tag with markup",withAct(act("x","untag","<b>vip</b>"))],
  ["tag with control char",withAct(act("x","tag","vip\u0007"))],
  ["tag with placeholder",withAct(act("x","tag","{{email}}"))],
  ["empty notify",withAct(act("x","notify","   "))],
  ["notify 501 chars",withAct(act("x","notify","n".repeat(501)))],
  ["notify control char",withAct(act("x","notify","hi\u0000"))],
  ["non-string value",withAct({id:"x",data:{kind:"action",actionType:"notify",actionValue:5}})],
  ["handoff text (never sent)",withAct(act("x","handoff","سيتواصل معك موظف"))],
  ["edge out of a handoff",withAct(act("x","handoff"),[txt("after","x")],[E("start","x"),E("x","after")])],
  ["ai action",withAct(act("x","ai","prompt"))],
  ["unknown action",withAct(act("x","webhook","https://x.example"))],
 ];
 for(const [label,d] of bad)assert.equal(supportedDurableDocument(d),false,label);
 assert.equal(durableCandidateKind(withAct(act("x","ai","p"))),"unsupported");
 // V2 shapes still fall back (unchanged), even next to the new kinds.
 assert.equal(supportedDurableDocument(v2Lone),false);assert.equal(supportedDurableDocument(v2Cond),false);
});
test("internal actions: safePlan accepts them within the cap; handoff only last and only with status handoff",()=>{
 const e=(kind:string,seq:number,extra:Record<string,unknown>={})=>({kind,seq,idempotencyKey:"k"+seq,nodeId:"n"+seq,...extra}) as any;
 const st=(status:string)=>({flowId:"f",revision:1,nodeId:"n",status,stepCount:3,variables:{},wakeAt:null}) as any;
 assert.equal(safePlan({state:st("handoff"),effects:[e("message",0,{text:"a"}),e("tag",1,{tag:"x"}),
  e("staff_notification",2,{text:"t"}),e("untag",3,{tag:"y"}),e("handoff",4)]}),true);
 assert.equal(safePlan({state:st("completed"),effects:[e("tag",0,{tag:"x"})]}),true);
 assert.equal(safePlan({state:st("handoff"),effects:[e("handoff",0)]}),true);
 assert.equal(safePlan({state:st("completed"),effects:[e("handoff",0)]}),false,"handoff effect needs status handoff");
 assert.equal(safePlan({state:st("handoff"),effects:[e("message",0,{text:"a"})]}),false,"status handoff needs the effect");
 assert.equal(safePlan({state:st("handoff"),effects:[e("handoff",0),e("handoff",1)]}),false,"handoff not last");
 assert.equal(safePlan({state:st("completed"),effects:[e("message",0,{source:"knowledge_ai",text:""})]}),false);
 assert.equal(safePlan({state:st("completed"),effects:[e("tag",1,{tag:"x"})]}),false,"seq must match order");
 assert.equal(safePlan({state:st("blocked"),effects:[e("tag",0,{tag:"x"})]}),false);
 assert.equal(safePlan({state:st("handoff"),effects:[]}),false);
});
test("internal actions: start and typed-answer resume commit tag/notify/handoff in seq order; run ends in handoff",async()=>{
 await withCanary(async()=>{
  const start=lifecycleDb({document:handoffDoc});
  assert.equal(await attemptDurableInstagram(start.db,baseEvent),"handled");
  const b=start.calls.find(c=>c.name==="flow_begin_durable_run")!.args;
  assert.equal(b.p_status,"awaiting_input");
  assert.deepEqual(b.p_effects.map((x:any)=>[x.kind,x.payload.seq]),[["message",0],["question",1]]);
  const run=waitingRun({current_node_id:"askEmail",step_count:3});
  const r=lifecycleDb({document:handoffDoc,awaiting:[run]});
  assert.equal(await attemptDurableInstagram(r.db,typedEvent("Ali@Shop.Example")),"handled");
  assert.deepEqual(names(r.calls),["flow_claim_inbound","flow_resume_button_run"]);
  const a=resumeArgs(r.calls);
  assert.equal(a.p_status,"handoff");assert.equal(a.p_next,"human");assert.equal(a.p_wake,null);
  assert.deepEqual(a.p_effects.map((x:any)=>[x.kind,x.payload.seq]),
   [["tag",0],["staff_notification",1],["message",2],["handoff",3]]);
  assert.equal(a.p_effects[0].payload.tag,"lead");
  assert.equal(a.p_effects[1].payload.text,"عميل جديد ali@shop.example","collected field rendered");
  assert.equal(a.p_effects[2].payload.text,"سيتواصل معك موظف الآن");
  assert.equal(new Set(a.p_effects.map((x:any)=>x.idempotencyKey)).size,4);
 });
});
test("internal actions: a queued handoff keeps the conversation silent; scoped to tenant+conversation; fails closed",async()=>{
 await withCanary(async()=>{
  const queued=[{run_id:"r-h",tenant_id:id.tenant}];
  const mine=lifecycleDb({document:chainDoc,outbox:queued,runsById:[{id:"r-h",tenant_id:id.tenant,
   channel_account_id:id.account,conversation_id:id.conversation}]});
  assert.equal(await attemptDurableInstagram(mine.db,baseEvent),"handled");
  assert.deepEqual(mine.calls,[],"no claim, no run: neither durable nor V2 answers");
  const q=mine.reads.find(r=>r.table==="automation_flow_outbox")!;
  assert.deepEqual(q.filters,{tenant_id:id.tenant,effect_kind:"handoff",delivery_status:["pending","leased"]});
  const rr=mine.reads.find(r=>r.table==="automation_flow_runs"&&Array.isArray(r.filters.id))!;
  assert.deepEqual(rr.filters,{tenant_id:id.tenant,conversation_id:id.conversation,id:["r-h"]});
  // A queued handoff of ANOTHER conversation (or a foreign row) changes nothing.
  for(const runsById of [[],[{id:"r-h",tenant_id:id.tenant,conversation_id:"99999999-9999-4999-8999-999999999999"}],
   [{id:"r-h",tenant_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",conversation_id:id.conversation}]]){
   const other=lifecycleDb({document:chainDoc,outbox:queued,runsById});
   assert.equal(await attemptDurableInstagram(other.db,baseEvent),"handled");
   assert.deepEqual(names(other.calls),["flow_claim_inbound","flow_begin_durable_run"]);
  }
  const foreignOutbox=lifecycleDb({document:chainDoc,outbox:[{run_id:"r-h",tenant_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]});
  assert.equal(await attemptDurableInstagram(foreignOutbox.db,baseEvent),"handled");
  assert.deepEqual(names(foreignOutbox.calls),["flow_claim_inbound","flow_begin_durable_run"]);
  const broken=lifecycleDb({document:chainDoc,outboxError:true});
  assert.equal(await attemptDurableInstagram(broken.db,baseEvent),"handled");
  assert.deepEqual(broken.calls,[]);
  const full=lifecycleDb({document:chainDoc,outbox:Array.from({length:100},(_,i)=>({run_id:"r"+i,tenant_id:id.tenant}))});
  assert.equal(await attemptDurableInstagram(full.db,baseEvent),"handled");
  assert.deepEqual(full.calls,[],"a full page fails closed");
  // The check precedes the flow lookup: even a V2-shaped active flow stays silent.
  const v2=lifecycleDb({document:v2Lone,outbox:queued,runsById:[{id:"r-h",tenant_id:id.tenant,conversation_id:id.conversation}]});
  assert.equal(await attemptDurableInstagram(v2.db,baseEvent),"handled","queued handoff also silences a V2-shaped flow");
 });
});
