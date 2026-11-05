import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {canWakeDurableRun,wakeEndReason,humanTakeoverActive,type WakeEligibility}
 from "../supabase/functions/flow-runtime-worker/eligibility.ts";

const now=Date.parse("2026-10-29T18:00:00Z");
const safe:WakeEligibility={
 runPlatform:"instagram",runStatus:"sleeping",runRevision:4,
 tenantActive:true,tenantSwitchEnabled:true,tenantTestOnly:false,
 tenantProductionApproved:true,globalEnabled:true,
 accountId:"same-account",canaryAccountId:"same-account",
 accountTenantMatches:true,accountActive:true,agentEnabled:true,
 autoReply:true,conversationTenantMatches:true,conversationAccountMatches:true,
 humanTransferred:false,humanAgentExpiresAt:null,humanPausedReason:null,
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
// Canonical columns: transferred + human_agent_expires_at (+ auto_paused_reason),
// same rule as milan-api's lazy expiry and flow_conversation_human_takeover.
const takeover=(at:unknown,reason:unknown="manual_takeover")=>
 ({...safe,humanTransferred:true,humanAgentExpiresAt:at,humanPausedReason:reason});
test("human takeover follows milan-api expiry; corrupt values fail closed",()=>{
 assert.equal(canWakeDurableRun(takeover("2026-10-29T19:00:00Z"),now),false,"live takeover");
 assert.equal(canWakeDurableRun(takeover(null),now),false,"no expiry = active");
 assert.equal(canWakeDurableRun(takeover("not a date"),now),false,"corrupt date");
 assert.equal(canWakeDurableRun(takeover(42),now),false,"non-string date");
 assert.equal(canWakeDurableRun(takeover("2026-10-29T17:00:00Z"),now),true,"expired manual takeover");
 // milan-api only auto-releases manual_takeover; ai_handoff stays a takeover.
 assert.equal(canWakeDurableRun(takeover("2026-10-29T17:00:00Z","ai_handoff"),now),false);
 assert.equal(canWakeDurableRun(takeover("2026-10-29T17:00:00Z",null),now),false);
 // transferred=false is not a takeover even with a stale future timestamp.
 assert.equal(canWakeDurableRun({...safe,humanAgentExpiresAt:"2026-10-29T19:00:00Z"},now),true);
 assert.equal(canWakeDurableRun({...safe,humanTransferred:"yes"},now),false,"malformed transferred");
 assert.equal(canWakeDurableRun(safe,Number.NaN),false);
 assert.equal(humanTakeoverActive(true,"2026-10-29T17:00:00Z","manual_takeover",Number.NaN),true);
});
test("workers select only the canonical takeover columns",()=>{
 for(const f of ["supabase/functions/flow-runtime-worker/index.ts",
  "supabase/functions/flow-outbox-worker/index.ts"]){
  const src=readFileSync(f,"utf8");
  assert.doesNotMatch(src,/human_agent_until/,f);
  assert.match(src,/\.select\("[^"]*\btransferred,auto_paused_reason,human_agent_expires_at"\)/,f);
 }
});
test("worker performs eligibility check after lease but before planning or commit",()=>{
 const src=readFileSync("supabase/functions/flow-runtime-worker/index.ts","utf8");
 const claimed=src.indexOf('sb.rpc("flow_lease_due_runs"');
 const guard=src.indexOf("if(!canWakeDurableRun(wake,nowMs)){");
 const planner=src.indexOf("const plan=planUntilWait(");
 const commit=src.indexOf('sb.rpc("flow_commit_run_step"');
 assert(claimed>0&&guard>claimed&&planner>guard&&commit>planner);
 assert.match(src,/FLOW_DURABLE_CANARY_ACCOUNT_ID/);
 assert.match(src,/wake not eligible for current canary activation/);
});

const workerSrc=readFileSync("supabase/functions/flow-runtime-worker/index.ts","utf8");
test("permanent ineligibility ends the run with a lifecycle reason",()=>{
 assert.equal(wakeEndReason(safe,now),null);
 for(const [field,value,reason] of [
  ["revisionIsActive",false,"revision_inactive"],["activeRevision",null,"revision_inactive"],
  ["activeRevision",5,"revision_inactive"],
  ["humanTransferred",true,"human_takeover"],["humanTransferred","yes","human_takeover"],
  ["tenantFound",false,"ineligible"],["accountTenantMatches",false,"ineligible"],
  ["conversationTenantMatches",false,"ineligible"],["conversationAccountMatches",false,"ineligible"]
 ] as const){
  assert.equal(canWakeDurableRun({...safe,[field]:value},now),false,field);
  assert.equal(wakeEndReason({...safe,[field]:value},now),reason,field+"="+String(value));
 }
 for(const [at,reason] of [["2026-10-29T19:00:00Z","manual_takeover"],[null,"manual_takeover"],
  ["not a date","manual_takeover"],[42,"manual_takeover"],["2026-10-29T17:00:00Z","ai_handoff"]] as const)
  assert.equal(wakeEndReason(takeover(at,reason),now),"human_takeover",String(at)+"/"+reason);
 // Expired manual takeover: not a takeover, the run proceeds (not ended).
 assert.equal(wakeEndReason(takeover("2026-10-29T17:00:00Z"),now),null);
});
// Old behaviour (130000-era worker) ENDED these runs as 'ineligible'; a
// temporary pause must leave them sleeping so they resume when re-enabled.
test("temporary pauses never end a sleeping run",()=>{
 for(const [field,value] of [
  ["tenantActive",false],["tenantActive",undefined],["accountActive",false],
  ["agentEnabled",false],["agentEnabled",null],["autoReply",false],["autoReply",undefined]
 ] as const){
  assert.equal(canWakeDurableRun({...safe,[field]:value},now),false,field);
  assert.equal(wakeEndReason({...safe,[field]:value},now),null,field+"="+String(value));
 }
});
test("operator rollout gates never end a sleeping run",()=>{
 for(const [field,value] of [
  ["globalEnabled",false],["tenantSwitchEnabled",false],
  ["tenantProductionApproved",false],["canaryAccountId","another-account"],
  ["canaryAccountId",undefined],["runPlatform","facebook"],["runStatus","completed"]
 ] as const){
  assert.equal(canWakeDurableRun({...safe,[field]:value},now),false,field);
  assert.equal(wakeEndReason({...safe,[field]:value},now),null,field);
 }
});
test("ineligible wake is cancelled tenant-scoped before planning; expiry sweep is best-effort",()=>{
 const guard=workerSrc.indexOf("if(!canWakeDurableRun(wake,nowMs)){");
 const cancel=workerSrc.indexOf('sb.rpc("flow_cancel_run"');
 const planner=workerSrc.indexOf("const plan=planUntilWait(");
 assert(guard>0&&cancel>guard&&planner>cancel);
 assert.match(workerSrc,/p_tenant:tenantId,p_run:runId,p_reason:reason,p_expect_status:"sleeping"/);
 assert.match(workerSrc,/if\(!ee&&ended===true\)\{\s*cancelled\+\+;/);
 const gateOff=workerSrc.indexOf('return answer("flow global switch OFF",423)');
 const sweep=workerSrc.indexOf('sb.rpc("flow_expire_waiting_runs"');
 const lease=workerSrc.indexOf('sb.rpc("flow_lease_due_runs"');
 assert(gateOff>0&&sweep>gateOff&&lease>sweep);
 // A failed sweep logs only; it never returns early or blocks the lease.
 assert.match(workerSrc,/if\(xe\)console\.error\("\[flow-worker\] expiry sweep failed"/);
 assert.match(workerSrc,/sends:0/);
});
