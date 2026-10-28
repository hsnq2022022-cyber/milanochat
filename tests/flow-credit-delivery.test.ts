import {test} from "node:test";
import {strict as assert} from "node:assert";
import {processExclusiveEvent} from "../supabase/functions/milan-api/exclusiveMessageClaim.ts";
import {chargeWidgetReply} from "../supabase/functions/milan-api/widgetCredit.ts";

function mockCharge(result,error=null){
 return {rpc:async(name,params)=>{
  assert.equal(name,"consume_widget_reply");
  assert.equal(params.p_tenant_id,"tenant-A");
  assert.equal(params.p_widget_message_id,"widget-message-A");
  return {data:result,error};
 }};
}
test("Widget charge verifies result, duplicate and credit errors",async()=>{
 assert.equal((await chargeWidgetReply(mockCharge(4),"tenant-A","widget-message-A")).status,"charged");
 assert.equal((await chargeWidgetReply(mockCharge(-2),"tenant-A","widget-message-A")).status,"already_charged");
 assert.equal((await chargeWidgetReply(mockCharge(-1),"tenant-A","widget-message-A")).status,"no_credit");
 assert.equal((await chargeWidgetReply(mockCharge(-3),"tenant-A","widget-message-A")).status,"invalid");
 assert.equal((await chargeWidgetReply(mockCharge(null,{code:"PGRST",message:"rpc failed"}),"tenant-A","widget-message-A")).status,"error");
});
function sender({sendError=false,finish=false,begin=true}={}){
 const events=[];let sent=0,billed=0;
 return {
  dependencies:{
   prepareFlow:async()=>null,
   claim:async()=>({acquired:true,route:"legacy_ai",claim_id:"claim-A",
    outgoing_message_id:"outgoing-A"}),
   legacyAnswer:async()=>"hello",
   send:async()=>{sent++;if(sendError)throw Error("provider response ambiguous");return {providerMessageId:"mid-1"};},
   persistSent:async()=>{events.push("persist");return true;},
   debit:async()=>{billed++;return 4;},
   delivery:{
    begin:async(id,out,text)=>{assert.equal(id,"claim-A");assert.equal(text,"hello");events.push("begin");return begin;},
    finish:async(id,status,providerId)=>{events.push(status+":"+providerId);return finish||status==="uncertain";}
   }
  },
  get:()=>({events,sent,billed})
 };
}
test("Delivery reservation prevents provider call on duplicate/reservation failure",async()=>{
 const d=sender({begin:false});
 assert.equal(await processExclusiveEvent(d.dependencies),"delivery_unavailable");
 assert.equal(d.get().sent,0);
 assert.equal(d.get().billed,0);
});
test("Confirmed provider response retains ID and bills after confirmation",async()=>{
 const d=sender({finish:true});
 assert.equal(await processExclusiveEvent(d.dependencies),"sent_and_billed");
 assert.deepEqual(d.get(),{events:["begin","confirmed:mid-1","persist"],sent:1,billed:1});
});
test("Timeout becomes uncertain, no DB outgoing/credit and never retries",async()=>{
 const d=sender({sendError:true});
 assert.equal(await processExclusiveEvent(d.dependencies),"send_failed");
 assert.deepEqual(d.get(),{events:["begin","uncertain:null"],sent:1,billed:0});
});
test("Failed DB confirmation never charges or retries provider automatically",async()=>{
 const d=sender({finish:false});
 assert.equal(await processExclusiveEvent(d.dependencies),"sent_unconfirmed");
 assert.equal(d.get().sent,1);
 assert.equal(d.get().billed,0);
});
