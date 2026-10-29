import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source=(name:string)=>readFileSync(
 "supabase/functions/"+name+"/index.ts","utf8");

test("durable wake Cron requires distinct operator release after authentication, before leasing",()=>{
 const code=source("flow-runtime-worker");
 const auth=code.indexOf("acceptsFlowWorkerBearer(authorization,service,cronKey)");
 const gate=code.indexOf('Deno.env.get("FLOW_WORKERS_OPERATOR_RELEASE")!=="production-canary-approved"');
 const existing=code.indexOf('Deno.env.get("FLOW_DURABLE_SCHEDULER_ENABLED")!=="true"');
 const db=code.indexOf("const sb=createClient(base,service)");
 const lease=code.indexOf('sb.rpc("flow_lease_due_runs"');
 assert(auth>0 && gate>auth && existing>gate && db>existing && lease>db);
 assert.match(code,/return answer\("worker rollout not approved",423\)/);
});

test("outbox Cron requires same distinct operator release before any DB or provider send",()=>{
 const code=source("flow-outbox-worker");
 const auth=code.indexOf("acceptsFlowWorkerBearer(req.headers.get");
 const gate=code.indexOf('env("FLOW_WORKERS_OPERATOR_RELEASE")!=="production-canary-approved"');
 const existing=code.indexOf('env("FLOW_OUTBOX_SEND_ENABLED")!=="true"');
 const db=code.indexOf("const sb=createClient(base,secret");
 const send=code.indexOf("send:()=>sendProviderMessage(");
 assert(auth>0 && gate>auth && existing>gate && db>existing && send>db);
 assert.match(code,/return blocked\(\);/);
});

test("default-off operator release cannot be bypassed by an unrelated worker switch",()=>{
 for(const name of ["flow-runtime-worker","flow-outbox-worker"]){
  const code=source(name);
  assert.equal((code.match(/FLOW_WORKERS_OPERATOR_RELEASE/g)??[]).length,1);
  assert.equal((code.match(/production-canary-approved/g)??[]).length,1);
 }
});
