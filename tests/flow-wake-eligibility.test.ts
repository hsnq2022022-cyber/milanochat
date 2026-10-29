import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {canWakeDurableRun,type WakeEligibility}
 from "../supabase/functions/flow-runtime-worker/eligibility.ts";

const now=Date.parse("2026-10-29T18:00:00Z");
const safe:WakeEligibility={
 runPlatform:"instagram",runStatus:"sleeping",runRevision:4,
 tenantActive:true,tenantSwitchEnabled:true,tenantTestOnly:false,
 tenantProductionApproved:true,globalEnabled:true,
 accountId:"same-account",canaryAccountId:"same-account",
 accountTenantMatches:true,accountActive:true,agentEnabled:true,
 autoReply:true,conversationTenantMatches:true,conversationAccountMatches:true,
 humanTransferred:false,humanAgentUntil:null,
 activeRevision:4,revisionIsActive:true
};
test("wake permitted only for the still-active canary revision",()=>{
 assert.equal(canWakeDurableRun(safe,now),true);
 for(const [field,value] of [
  ["runRevision",2],["activeRevision",2],["revisionIsActive",false],
  ["runPlatform","facebook"],["runStatus","completed"],
  ["canaryAccountId","another-account"],["accountTenantMatches",false],
  ["conversationTenantMatches",false],["conversationAccountMatches",false],
  ["globalEnabled",false],["tenantActive",false],["tenantSwitchEnabled",false],
  ["accountActive",false],["agentEnabled",false],["autoReply",false],
  ["humanTransferred",true]
 ] as const){
  assert.equal(canWakeDurableRun({...safe,[field]:value},now),false,field);
 }
 assert.equal(canWakeDurableRun({...safe,tenantProductionApproved:false},now),false);
 assert.equal(canWakeDurableRun({...safe,tenantTestOnly:true,tenantProductionApproved:false},now),true);
});
test("human takeover expiry and corrupt dates must never resume automatically",()=>{
 assert.equal(canWakeDurableRun({...safe,humanAgentUntil:"2026-10-29T19:00:00Z"},now),false);
 assert.equal(canWakeDurableRun({...safe,humanAgentUntil:"not a date"},now),false);
 assert.equal(canWakeDurableRun({...safe,humanAgentUntil:"2026-10-29T17:00:00Z"},now),true);
 assert.equal(canWakeDurableRun(safe,Number.NaN),false);
});
test("worker performs eligibility check after lease but before planning or commit",()=>{
 const src=readFileSync("supabase/functions/flow-runtime-worker/index.ts","utf8");
 const claimed=src.indexOf('sb.rpc("flow_lease_due_runs"');
 const guard=src.indexOf("if(!canWakeDurableRun({");
 const planner=src.indexOf("const plan=planRuntimeTransition(");
 const commit=src.indexOf('sb.rpc("flow_commit_run_step"');
 assert(claimed>0&&guard>claimed&&planner>guard&&commit>planner);
 assert.match(src,/FLOW_DURABLE_CANARY_ACCOUNT_ID/);
 assert.match(src,/wake not eligible for current canary activation/);
});
