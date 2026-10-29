import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {acceptsFlowWorkerBearer} from "../supabase/functions/flowWorkerAuth.ts";

test("only original service Bearer or exact independent Cron token is accepted",()=>{
 const service="service-key";
 const cron="another-long-cron-key";
 assert.equal(acceptsFlowWorkerBearer("Bearer "+service,service,cron),true);
 assert.equal(acceptsFlowWorkerBearer("Bearer "+cron,service,cron),true);
 for(const candidate of [
  null,"","Bearer ","Bearer invalid","Bearer "+cron+"x",
  "bearer "+cron,"Basic "+cron,"Bearer "+cron+" ",
  "Bearer "+cron+"\n"
 ]){
  assert.equal(acceptsFlowWorkerBearer(candidate,service,cron),false);
 }
 assert.equal(acceptsFlowWorkerBearer("Bearer "+cron,service,""),false);
 assert.equal(acceptsFlowWorkerBearer("Bearer "+cron,"",cron),false);
});
test("both installed workers explicitly require independent secret authentication before any DB/send",()=>{
 for(const name of ["flow-runtime-worker","flow-outbox-worker"]){
  const s=readFileSync("supabase/functions/"+name+"/index.ts","utf8");
  assert.match(s,/import \{acceptsFlowWorkerBearer\} from "\.\.\/flowWorkerAuth\.ts"/);
  assert.match(s,/flow_worker_service_role_key/);
  const guard=s.indexOf("acceptsFlowWorkerBearer(");
  const database=s.indexOf("createClient(base,");
  assert(guard>0&&database>guard);
  assert.match(s,/return (?:answer\("unauthorized",401\)|json\(\{error:"Unauthorized"\},401\))/);
  if(name==="flow-runtime-worker"){
   assert(s.indexOf("FLOW_DURABLE_SCHEDULER_ENABLED")>guard);
  }else{
   assert(s.indexOf('FLOW_OUTBOX_SEND_ENABLED")!=="true"')>guard);
   assert(s.indexOf('FLOW_ATOMIC_CONSUME_READY")!=="true"')>guard);
  }
 }
});
