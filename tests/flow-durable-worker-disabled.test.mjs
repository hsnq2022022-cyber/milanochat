import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

test("durable worker requires service bearer and independent kill switch",()=>{
 const worker=readFileSync("supabase/functions/flow-runtime-worker/index.ts","utf8");
 const serviceCheck=worker.indexOf('acceptsFlowWorkerBearer(authorization,service,cronKey)');
 const gate=worker.indexOf('Deno.env.get("FLOW_DURABLE_SCHEDULER_ENABLED")!=="true"');
 const dataAccess=worker.indexOf('const sb=createClient(base,service);');
 assert(serviceCheck>=0&&gate>serviceCheck&&dataAccess>gate);
 assert.match(worker,/return answer\("durable scheduler disabled",423\)/);
 assert.match(worker,/sb\.rpc\("flow_lease_due_runs"/);
});
