// Failure isolation of the outbox tick between tenants (pure functions + wiring). The end-to-end proof on a real
// PostgreSQL (a paused tenant's 60 pending effects cannot starve another tenant; measured capacity) is in
// flow-lifecycle-integration.test.ts. Run: node --experimental-strip-types --test tests/flow-outbox-fairness.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {interleaveByTenant,tenantsDominatingWindow,OUTBOX_TENANT_WINDOW_CAP,OUTBOX_SCAN_ROUNDS} from "../supabase/functions/flow-outbox-worker/fairness.ts";
import {OUTBOX_DISPATCH_LIMIT,OUTBOX_SCAN_LIMIT} from "../supabase/functions/flow-outbox-worker/skipPolicy.ts";

const row=(t:string,n:number)=>({tenant_id:t,id:`${t}${n}`});
test("interleaveByTenant: round-robin, each tenant keeps its own order, nothing lost or duplicated",()=>{
 const rows=[row("A",1),row("A",2),row("A",3),row("A",4),row("B",1),row("C",1),row("C",2)];
 assert.deepEqual(interleaveByTenant(rows).map(r=>r.id),["A1","B1","C1","A2","C2","A3","A4"]);
 assert.deepEqual(interleaveByTenant([]),[]);
 assert.deepEqual(interleaveByTenant([row("A",1),row("A",2)]).map(r=>r.id),["A1","A2"]);
 const big=Array.from({length:300},(_,i)=>row("T"+(i%7),i));
 const out=interleaveByTenant(big);
 assert.equal(out.length,300);assert.equal(new Set(out.map(r=>r.id)).size,300);
 for(const t of new Set(big.map(r=>r.tenant_id)))
  assert.deepEqual(out.filter(r=>r.tenant_id===t).map(r=>r.id),big.filter(r=>r.tenant_id===t).map(r=>r.id),"per-tenant order kept");
});
test("a tenant cannot take more than its round-robin share of the dispatch cap while others wait",()=>{
 const rows=[...Array.from({length:50},(_,i)=>row("X",i)),row("Y",1),row("Z",1)];
 const first=interleaveByTenant(rows).slice(0,6).map(r=>r.tenant_id);
 assert.deepEqual(first.slice(0,3).sort(),["X","Y","Z"],"Y and Z are in the first three slots, not behind 50 X rows");
});
test("tenantsDominatingWindow: only tenants above the cap, sorted, tenant ids as strings",()=>{
 const rows=[...Array.from({length:OUTBOX_TENANT_WINDOW_CAP+1},(_,i)=>row("B",i)),...Array.from({length:OUTBOX_TENANT_WINDOW_CAP},(_,i)=>row("A",i)),row("C",1)];
 assert.deepEqual(tenantsDominatingWindow(rows),["B"]);
 assert.deepEqual(tenantsDominatingWindow([]),[]);
 assert.deepEqual(tenantsDominatingWindow(rows,0),["A","B","C"]);
});
test("limits: scan window larger than the dispatch cap; bounded follow-up rounds",()=>{
 assert.ok(OUTBOX_SCAN_LIMIT>=OUTBOX_DISPATCH_LIMIT);
 assert.ok(OUTBOX_SCAN_ROUNDS>=2&&OUTBOX_SCAN_ROUNDS<=5,"a fixed small number of extra queries per tick");
});
test("wiring: the worker tops up a saturated window only for non-dominating tenants and dispatches round-robin; gates are untouched",()=>{
 const src=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.match(src,/tenantsDominatingWindow\(scanned\)/);
 assert.match(src,/moreQuery=moreQuery\.neq\("tenant_id",t\)/);
 assert.match(src,/const items=interleaveByTenant\(\[\.\.\.scanned,/);
 assert.match(src,/\.limit\(OUTBOX_SCAN_LIMIT\)/);
 assert.match(src,/if\(dispatched>=OUTBOX_DISPATCH_LIMIT\)break;/);
 // the follow-up scan reads the same statuses and kinds as the primary scan (it can only ADD candidates)
 const primary=src.match(/\.in\("delivery_status",\["pending","charge_pending"\]\)\.in\("effect_kind",\["message","question","message_image"\]\)/g)??[];
 assert.equal(primary.length,2);
});
