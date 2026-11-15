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
test("worker auth matrix: cron bearer, service bearer, empty/missing keys and schemes",()=>{
 const service="service-role-value",cron="independent-cron-value";
 // correct Vault/cron bearer accepted; correct service-role bearer accepted
 assert.equal(acceptsFlowWorkerBearer("Bearer "+cron,service,cron),true);
 assert.equal(acceptsFlowWorkerBearer("Bearer "+service,service,cron),true);
 assert.equal(acceptsFlowWorkerBearer("Bearer "+service,service,""),true,"service bearer needs no cron key");
 // missing/empty cronBearerKey never grants access (not even "Bearer " / "Bearer")
 for(const h of ["Bearer ","Bearer","Bearer  ","Bearer "+cron])
  assert.equal(acceptsFlowWorkerBearer(h,service,""),false,JSON.stringify(h));
 // wrong bearer rejected
 for(const h of ["Bearer wrong","Bearer "+service.toUpperCase(),"Bearer "+cron.slice(0,-1),
  "Bearer "+service+cron,"Bearer  "+cron," Bearer "+cron])
  assert.equal(acceptsFlowWorkerBearer(h,service,cron),false,JSON.stringify(h));
 // missing Authorization header rejected
 assert.equal(acceptsFlowWorkerBearer(null,service,cron),false);
 assert.equal(acceptsFlowWorkerBearer("",service,cron),false);
 // non-Bearer schemes rejected even with a correct secret
 for(const h of ["Basic "+cron,"Token "+service,"bearer "+service,"BEARER "+cron,cron,service])
  assert.equal(acceptsFlowWorkerBearer(h,service,cron),false,JSON.stringify(h));
 // empty service key rejected (fail closed: the worker cannot build its DB client)
 assert.equal(acceptsFlowWorkerBearer("Bearer "+cron,"",cron),false);
 assert.equal(acceptsFlowWorkerBearer("Bearer ","",""),false);
 assert.equal(acceptsFlowWorkerBearer("Bearer","",""),false);
});
test("both workers call the same function with the same lowercase Edge secret name",()=>{
 const runtime=readFileSync("supabase/functions/flow-runtime-worker/index.ts","utf8");
 const outbox=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.match(runtime,/const cronKey=Deno\.env\.get\("flow_worker_service_role_key"\)\?\?"";/);
 assert.match(runtime,/if\(!acceptsFlowWorkerBearer\(authorization,service,cronKey\)\)\n\s*return answer\("unauthorized",401\);/);
 assert.match(outbox,/const cronKey=env\("flow_worker_service_role_key"\);/);
 assert.match(outbox,/if\(!acceptsFlowWorkerBearer\(req\.headers\.get\("authorization"\),secret,cronKey\)\)\n\s*return json\(\{error:"Unauthorized"\},401\);/);
 // The scheduler proposal sends exactly the Vault secret of the same name as Bearer.
 const cronSql=readFileSync("supabase/proposals/flow_scheduler_vault_jobs.review.sql","utf8");
 assert.equal((cronSql.match(/'Authorization','Bearer '\|\|\(SELECT decrypted_secret\s+FROM vault\.decrypted_secrets\s+WHERE name='flow_worker_service_role_key'\)\)/g)??[]).length,2);
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
