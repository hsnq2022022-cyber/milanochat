import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {loadFlowReview,mapAttempt,mapOutbox,mapRun,RUN_STATUSES} from "../supabase/functions/flow-delivery-review/review.ts";

const T="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
type Call={table:string;ops:[string,unknown[]][]};
// Fake PostgREST builder: records every chained call; resolves via responder.
function fakeClient(respond:(c:Call)=>{data?:unknown;error?:unknown;count?:number|null}){
 const calls:Call[]=[];
 return {calls,client:{from(table:string){
  const call:Call={table,ops:[]};calls.push(call);
  const b:any={};
  for(const op of ["select","eq","in","or","order","limit"])
   b[op]=(...args:unknown[])=>{call.ops.push([op,args]);return b;};
  b.then=(ok:(v:unknown)=>unknown,bad:(e:unknown)=>unknown)=>Promise.resolve(respond(call)).then(ok,bad);
  return b;
 }}};
}
const eqs=(c:Call)=>c.ops.filter(([o])=>o==="eq").map(([,a])=>a);
const sel=(c:Call)=>String(c.ops.find(([o])=>o==="select")?.[1][0]);

test("every V3/V4 review query is scoped to the verified tenant",async()=>{
 const {calls,client}=fakeClient(()=>({data:[],count:0}));
 await loadFlowReview(client,T);
 const tables=new Set(calls.map(c=>c.table));
 assert.deepEqual([...tables].sort(),["automation_flow_delivery_attempts","automation_flow_outbox","automation_flow_runs"]);
 for(const c of calls)assert.ok(eqs(c).some(([k,v])=>k==="tenant_id"&&v===T),`${c.table} not tenant-scoped`);
 // read-only: no mutation verbs are ever used
 for(const c of calls)for(const [op] of c.ops)assert.ok(["select","eq","in","or","order","limit"].includes(op));
 for(const c of calls)assert.doesNotMatch(sel(c),/payload|variables|lease_token|\*/);
});

test("queue shaping: uncertain/queued attempts, failed outbox, status counts",async()=>{
 const {calls,client}=fakeClient(c=>{
  if(c.table==="automation_flow_runs"&&c.ops.some(([o,a])=>o==="select"&&(a[1] as any)?.head))
   return {count:(RUN_STATUSES as readonly string[]).indexOf(String(eqs(c).find(([k])=>k==="run_status")?.[1]))+1};
  if(c.table==="automation_flow_delivery_attempts")
   return {data:[{outbox_id:"o1",claim_id:"c1",status:"uncertain",attempted_at:"2026-11-01T00:00:00Z",review_status:"queued",extra:"x"},{bad:true}]};
  if(c.table==="automation_flow_outbox")
   return {data:[{id:"x1",run_id:"r1",effect_kind:"message",delivery_status:"dead_letter",attempts:3,payload:{t:"secret"}}]};
  return {data:[{id:"r1",flow_key:"f",platform:"instagram",run_status:"sleeping",wake_at:"2026-11-05T00:00:00Z"}]};
 });
 const out=await loadFlowReview(client,T);
 assert.equal(out.flowAvailable,true);
 assert.deepEqual(out.runCounts,{ready:1,awaiting_input:2,sleeping:3,handoff:4,completed:5,blocked:6});
 assert.equal(out.flowItems.length,1);
 assert.equal((out.flowItems[0] as any).extra,undefined);
 assert.equal(out.flowFailures[0].delivery_status,"dead_letter");
 assert.equal((out.flowFailures[0] as any).payload,undefined);
 assert.equal(out.flowRuns[0].run_status,"sleeping");
 const att=calls.find(c=>c.table==="automation_flow_delivery_attempts")!;
 assert.deepEqual(att.ops.find(([o])=>o==="or")?.[1],["status.eq.uncertain,review_status.eq.queued"]);
 const ob=calls.find(c=>c.table==="automation_flow_outbox")!;
 assert.deepEqual(ob.ops.find(([o])=>o==="in")?.[1],["delivery_status",["uncertain","dead_letter","billing_blocked"]]);
});

test("missing lifecycle columns fall back to base columns; errors degrade, never throw",async()=>{
 const {calls,client}=fakeClient(c=>{
  if(/ended_reason|cancel_reason/.test(sel(c)))return {error:{message:"column does not exist"}};
  if(c.table==="automation_flow_delivery_attempts")return {error:{message:"relation missing"}};
  return {data:[],count:0};
 });
 const out=await loadFlowReview(client,T);
 assert.ok(calls.some(c=>c.table==="automation_flow_runs"&&sel(c)==="id,flow_key,platform,run_status,wake_at,updated_at"));
 assert.ok(calls.some(c=>c.table==="automation_flow_outbox"&&!/cancel_reason/.test(sel(c))));
 assert.equal(out.flowAvailable,false);
 assert.deepEqual(out.flowItems,[]);
});

test("row mappers whitelist fields and reject unknown statuses",()=>{
 assert.equal(mapAttempt({outbox_id:"o",status:"hacked"}),null);
 assert.equal(mapOutbox({id:"o",delivery_status:"weird"}),null);
 assert.equal(mapRun({id:"r",run_status:"x"}),null);
 assert.equal(mapRun({id:"r",run_status:"blocked",platform:"evil",ended_reason:"timeout"})?.platform,"unknown");
});

test("endpoint keeps owner/tenant checks before the additive flow queue",()=>{
 const src=readFileSync("supabase/functions/flow-delivery-review/index.ts","utf8");
 const owner=src.indexOf("tenant.user_id!==user.user.id");
 const v2=src.indexOf('.from("automation_delivery_attempts")');
 const flow=src.indexOf("loadFlowReview(sb,tenant.id)");
 assert.ok(owner>0&&v2>owner&&flow>v2);
 assert.match(src,/json\(\{items:rows\?\?\[\],readOnly:true,\.\.\.flow\}\)/);
});
