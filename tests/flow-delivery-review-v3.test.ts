import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {loadFlowReview,mapAttempt,mapOutbox,mapRun,mapInternal,RUN_STATUSES,INTERNAL_EFFECT_KINDS,INTERNAL_VIEW_STATUSES} from "../supabase/functions/flow-delivery-review/review.ts";

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

// Filtering fake: applies select projection, eq, in, order and limit like PostgREST would,
// so tenant isolation and payload exclusion are checked by behaviour, not only by call shape.
const B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function storeClient(tables:Record<string,Record<string,unknown>[]>){
 const calls:Call[]=[];
 return {calls,client:{from(table:string){
  const call:Call={table,ops:[]};calls.push(call);
  const b:any={};
  for(const op of ["select","eq","in","or","order","limit"])
   b[op]=(...args:unknown[])=>{call.ops.push([op,args]);return b;};
  b.then=(ok:(v:unknown)=>unknown,bad:(e:unknown)=>unknown)=>Promise.resolve().then(()=>{
   const head=call.ops.some(([o,a])=>o==="select"&&(a[1] as any)?.head);
   let rows=[...(tables[table]??[])];
   for(const [o,a] of call.ops){
    if(o==="eq")rows=rows.filter(r=>r[a[0] as string]===a[1]);
    if(o==="in")rows=rows.filter(r=>(a[1] as unknown[]).includes(r[a[0] as string]));
   }
   const orders=call.ops.filter(([o])=>o==="order").map(([,a])=>a as [string,{ascending:boolean}]);
   rows.sort((x,y)=>{for(const [k,{ascending}] of orders){const c=String(x[k]).localeCompare(String(y[k]));if(c)return ascending?c:-c;}return 0;});
   const lim=call.ops.find(([o])=>o==="limit");if(lim)rows=rows.slice(0,Number(lim[1][0]));
   if(head)return {count:rows.length};
   const cols=String(call.ops.find(([o])=>o==="select")![1][0]).split(",");
   return {data:rows.map(r=>Object.fromEntries(cols.filter(c=>c in r).map(c=>[c,r[c]])))};
  }).then(ok,bad);
  return b;
 }}};
}
const ob=(tenant_id:string,id:string,effect_kind:string,delivery_status:string,extra:Record<string,unknown>={})=>({
 tenant_id,id,run_id:"r-"+tenant_id.slice(0,1),effect_kind,delivery_status,attempts:1,retry_at:null,
 created_at:"2026-11-0"+(1+id.length%5)+"T00:00:00Z",cancel_reason:null,cancelled_at:null,...extra});

test("internal kinds match the internal worker's INTERNAL_KINDS",()=>{
 const src=readFileSync("supabase/functions/flow-internal-worker/internalEffects.ts","utf8");
 const m=src.match(/export const INTERNAL_KINDS=\[([^\]]*)\]/);
 assert.ok(m);
 assert.deepEqual(JSON.parse("["+m![1]+"]"),[...INTERNAL_EFFECT_KINDS]);
 assert.deepEqual([...INTERNAL_VIEW_STATUSES],["pending","leased","retry_wait","settled","cancelled"]);
});

test("owner view returns internal actions in pending/leased/retry_wait/settled/cancelled, tenant-scoped, no bodies",async()=>{
 const rows=[
  ob(T,"a1","tag","pending",{payload:{kind:"tag",tag:"vip-secret-tag"}}),
  ob(T,"a2","untag","leased",{payload:{kind:"untag",tag:"old-secret-tag"},lease_token:"tok-secret"}),
  ob(T,"a3","staff_notification","retry_wait",{payload:{kind:"staff_notification",text:"call +9647700000001 secret note"}}),
  ob(T,"a4","handoff","settled",{payload:{kind:"handoff"}}),
  ob(T,"a5","staff_notification","cancelled",{cancel_reason:"human_takeover",cancelled_at:"2026-11-03T00:00:00Z",payload:{text:"cancelled body secret"}}),
  ob(T,"a6","tag","dead_letter",{attempts:3,payload:{tag:"dl-secret-tag"}}),
  ob(T,"a7","message","pending",{payload:{text:"customer message secret"}}),
  ob(T,"a8","message","dead_letter",{payload:{text:"failed message secret"}}),
  // other tenant: same kinds and states must never appear
  ob(B,"b1","tag","pending",{payload:{tag:"tenant-b-tag"}}),
  ob(B,"b2","staff_notification","settled",{payload:{text:"tenant-b note"}}),
  ob(B,"b3","handoff","dead_letter"),
 ];
 const {calls,client}=storeClient({automation_flow_outbox:rows,automation_flow_delivery_attempts:[],automation_flow_runs:[]});
 const out=await loadFlowReview(client,T);
 assert.equal(out.flowAvailable,true);assert.equal(out.flowInternalAvailable,true);
 const byId=Object.fromEntries(out.flowInternal.map(f=>[f.id,f]));
 assert.deepEqual(Object.keys(byId).sort(),["a1","a2","a3","a4","a5"]);
 assert.deepEqual(["a1","a2","a3","a4","a5"].map(id=>[byId[id].effect_kind,byId[id].delivery_status]),
  [["tag","pending"],["untag","leased"],["staff_notification","retry_wait"],["handoff","settled"],["staff_notification","cancelled"]]);
 assert.equal(byId.a5.cancel_reason,"human_takeover");assert.equal(byId.a5.cancelled_at,"2026-11-03T00:00:00Z");
 assert.equal(byId.a3.attempts,1);
 for(const f of out.flowInternal)assert.deepEqual(Object.keys(f).sort(),
  ["attempts","cancel_reason","cancelled_at","created_at","delivery_status","effect_kind","id","retry_at","run_id"]);
 // Existing failures view is unchanged: only failure states, any kind, same tenant.
 assert.deepEqual(out.flowFailures.map(f=>f.id).sort(),["a6","a8"]);
 const shown=JSON.stringify(out);
 for(const secret of ["secret","tenant-b","+9647700000001","tok-","payload","b1","b2","b3"])
  assert.equal(shown.includes(secret),false,secret);
 const internalCall=calls.find(c=>c.table==="automation_flow_outbox"&&c.ops.some(([o,a])=>o==="in"&&a[0]==="effect_kind"))!;
 assert.ok(eqs(internalCall).some(([k,v])=>k==="tenant_id"&&v===T));
 assert.deepEqual(internalCall.ops.filter(([o])=>o==="order").map(([,a])=>a[0]),["created_at","id"]);
 assert.deepEqual(internalCall.ops.find(([o])=>o==="limit")?.[1],[100]);
 // And from tenant B's side only B's rows are visible.
 const outB=await loadFlowReview(storeClient({automation_flow_outbox:rows,automation_flow_delivery_attempts:[],automation_flow_runs:[]}).client,B);
 assert.deepEqual(outB.flowInternal.map(f=>f.id).sort(),["b1","b2"]);
 assert.deepEqual(outB.flowFailures.map(f=>f.id),["b3"]);
});

test("internal view is bounded, deterministically ordered, and degrades without breaking failures",async()=>{
 const many=Array.from({length:150},(_,i)=>ob(T,"i"+String(i).padStart(3,"0"),"tag","settled",{created_at:"2026-11-01T00:00:00Z"}));
 const out=await loadFlowReview(storeClient({automation_flow_outbox:many}).client,T);
 assert.equal(out.flowInternal.length,100);
 assert.equal(out.flowInternal[0].id,"i149");assert.equal(out.flowInternal[99].id,"i050");
 const {client}=fakeClient(c=>c.ops.some(([o,a])=>o==="in"&&a[0]==="effect_kind")?{error:{message:"boom"}}:
  c.table==="automation_flow_outbox"?{data:[{id:"x1",effect_kind:"message",delivery_status:"dead_letter",attempts:3}]}:{data:[],count:0});
 const deg=await loadFlowReview(client,T);
 assert.deepEqual(deg.flowInternal,[]);assert.equal(deg.flowInternalAvailable,false);
 assert.equal(deg.flowFailures.length,1);assert.equal(deg.flowAvailable,true);
});

test("mapInternal rejects provider kinds, failure states and unknown values",()=>{
 assert.equal(mapInternal({id:"o",effect_kind:"message",delivery_status:"pending"}),null);
 assert.equal(mapInternal({id:"o",effect_kind:"tag",delivery_status:"dead_letter"}),null);
 assert.equal(mapInternal({id:"o",effect_kind:"notify",delivery_status:"pending"}),null);
 assert.equal(mapInternal({id:"o",effect_kind:"tag",delivery_status:"charge_pending"}),null);
 assert.equal((mapInternal({id:"o",effect_kind:"handoff",delivery_status:"leased",payload:{x:1}}) as any)?.payload,undefined);
 assert.equal(mapInternal({id:"o",effect_kind:"handoff",delivery_status:"leased"})?.delivery_status,"leased");
});
