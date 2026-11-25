/**
 * Supersession of an unsent Flow message by a newer AI reply needs DELIVERY EVIDENCE, never a claim alone
 * (automation_message_claims 'legacy_ai' is inserted before the answer is generated or sent and survives
 * an empty answer or a failed send). Pure policy + the evidence reader with an in-memory table double;
 * the real SQL / worker behaviour is covered by tests/flow-lifecycle-integration.test.ts (PostgreSQL).
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {supersessionVerdict,type NewerClaim} from "../supabase/functions/flow-outbox-worker/skipPolicy.ts";
import {readSupersession,NEWER_CLAIM_SCAN} from "../supabase/functions/flow-outbox-worker/supersession.ts";

const T="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",C="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const claim=(n:number):NewerClaim=>({id:"00000000-0000-4000-8000-00000000000"+n,outgoingMessageId:"11111111-1111-4111-8111-11111111111"+n});
const v=(claims:NewerClaim[],o:{out?:string[];att?:Record<string,string>;truncated?:boolean}={})=>
 supersessionVerdict({claims,truncated:o.truncated===true,persistedOutIds:new Set(o.out??[]),attempts:new Map(Object.entries(o.att??{}))});

test("policy: no claims or a claim without any evidence proceeds (never cancels)",()=>{
 assert.equal(v([]),"proceed");
 assert.equal(v([claim(1)]),"proceed","claim only: AI route selected, no reply known to be delivered");
});
test("policy: persisted outbound message OR confirmed attempt supersedes",()=>{
 const c=claim(1);
 assert.equal(v([c],{out:[c.outgoingMessageId]}),"supersede");
 assert.equal(v([c],{att:{[c.id]:"confirmed"}}),"supersede");
 // evidence for ANY newer claim is enough; other claims without evidence do not matter
 assert.equal(v([claim(1),claim(2)],{att:{[claim(2).id]:"confirmed"}}),"supersede");
 // a persisted message of ANOTHER outgoing id is not evidence for this claim
 assert.equal(v([c],{out:[claim(2).outgoingMessageId]}),"proceed");
});
test("policy: attempting holds; uncertain (send_failed / sent_unconfirmed / timeout) proceeds; unknown status holds",()=>{
 const c=claim(1);
 assert.equal(v([c],{att:{[c.id]:"attempting"}}),"hold");
 assert.equal(v([c],{att:{[c.id]:"uncertain"}}),"proceed");
 assert.equal(v([c],{att:{[c.id]:"weird"}}),"hold");
 assert.equal(v([c],{att:{[c.id]:"attempting"},out:[c.outgoingMessageId]}),"supersede","delivery evidence beats an in-flight marker");
 assert.equal(v([c],{truncated:true}),"hold","list truncated = unknown");
 assert.equal(v([claim(1),claim(2)],{att:{[claim(1).id]:"uncertain",[claim(2).id]:"attempting"}}),"hold");
});

// ---- reader against a tiny table double (filters tenant/conversation/route/time/ids, records reads)
type Row=Record<string,unknown>;
function db(tables:Record<string,Row[]>,fail:string[]=[],reads:string[]=[]){
 return {from:(t:string)=>{
  const f:Array<(r:Row)=>boolean>=[];reads.push(t);
  const q:any={select:()=>q,order:()=>q,
   eq:(k:string,x:unknown)=>{f.push(r=>r[k]===x);return q;},
   gt:(k:string,x:string)=>{f.push(r=>String(r[k])>x);return q;},
   in:(k:string,xs:unknown[])=>{f.push(r=>xs.includes(r[k]));return q;},
   limit:async(n:number)=>fail.includes(t)?{data:null,error:{code:"XX000"}}:
    {data:(tables[t]??[]).filter(r=>f.every(p=>p(r))).slice(0,n),error:null}};
  return q;}};
}
const in1={tenantId:T,conversationId:C,effectCreatedAt:"2026-11-24T10:00:00+00:00"};
const cl=(n:number,over:Row={})=>({id:"00000000-0000-4000-8000-00000000000"+n,tenant_id:T,conversation_id:C,route:"legacy_ai",
 claimed_at:"2026-11-24T10:05:00+00:00",outgoing_message_id:"11111111-1111-4111-8111-11111111111"+n,...over});

test("reader: claim only -> proceed; with outbound message -> supersede; with confirmed attempt -> supersede",async()=>{
 assert.equal(await readSupersession(db({automation_message_claims:[cl(1)]}),in1),"proceed");
 assert.equal(await readSupersession(db({automation_message_claims:[cl(1)],
  messages:[{id:cl(1).outgoing_message_id,tenant_id:T,conversation_id:C,direction:"out"}]}),in1),"supersede");
 assert.equal(await readSupersession(db({automation_message_claims:[cl(1)],
  automation_delivery_attempts:[{claim_id:cl(1).id,tenant_id:T,status:"confirmed"}]}),in1),"supersede");
});
test("reader: attempting holds; uncertain proceeds; inbound-direction or other-conversation messages are not evidence",async()=>{
 const claims=[cl(1)];
 assert.equal(await readSupersession(db({automation_message_claims:claims,
  automation_delivery_attempts:[{claim_id:cl(1).id,tenant_id:T,status:"attempting"}]}),in1),"hold");
 assert.equal(await readSupersession(db({automation_message_claims:claims,
  automation_delivery_attempts:[{claim_id:cl(1).id,tenant_id:T,status:"uncertain"}]}),in1),"proceed");
 assert.equal(await readSupersession(db({automation_message_claims:claims,
  messages:[{id:cl(1).outgoing_message_id,tenant_id:T,conversation_id:C,direction:"in"}]}),in1),"proceed");
 assert.equal(await readSupersession(db({automation_message_claims:claims,
  messages:[{id:cl(1).outgoing_message_id,tenant_id:T,conversation_id:"other",direction:"out"}]}),in1),"proceed");
});
test("reader: scope and time filters (route, tenant, conversation, claimed after the effect)",async()=>{
 const reads:string[]=[];
 const d=db({automation_message_claims:[cl(1,{route:"flow"}),cl(2,{tenant_id:"other"}),cl(3,{conversation_id:"other"}),
  cl(4,{claimed_at:"2026-11-24T09:00:00+00:00"})],messages:[],automation_delivery_attempts:[]},[],reads);
 assert.equal(await readSupersession(d,in1),"proceed");
 assert.deepEqual(reads,["automation_message_claims"],"no claim in scope: no evidence reads");
});
test("reader: ANY read failure or malformed row is 'error' (the worker holds), never delivery",async()=>{
 const base={automation_message_claims:[cl(1)],
  messages:[{id:cl(1).outgoing_message_id,tenant_id:T,conversation_id:C,direction:"out"}],
  automation_delivery_attempts:[{claim_id:cl(1).id,tenant_id:T,status:"confirmed"}]};
 for(const table of ["automation_message_claims","messages","automation_delivery_attempts"])
  assert.equal(await readSupersession(db(base,[table]),in1),"error",table);
 assert.equal(await readSupersession(db({automation_message_claims:[{...cl(1),outgoing_message_id:null}]}),in1),"error");
 assert.equal(await readSupersession(db({...base,automation_delivery_attempts:[{claim_id:cl(1).id,tenant_id:T,status:7}]}),in1),"error");
});
test("reader: a saturated claim scan is unknown (hold), not 'no evidence'",async()=>{
 const many=Array.from({length:NEWER_CLAIM_SCAN},(_,i)=>cl(1,{id:"00000000-0000-4000-8000-0000000"+String(10000+i),
  outgoing_message_id:"22222222-2222-4222-8222-2222222"+String(10000+i)}));
 assert.equal(await readSupersession(db({automation_message_claims:many}),in1),"hold");
});
