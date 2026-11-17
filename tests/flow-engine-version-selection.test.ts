/**
 * Flow engine "V3" (durable buttons revision) / "V4" (durable delay revision)
 * selection and the flow-publication readiness contract. Offline: fake
 * clients only, real handleFlowPublication.
 *
 * Reported response (copied safe report of FlowPublicationPanel):
 *   {revision:null,kind:"unsupported",configured:false,missing:["activeRevision","supportedCandidate"]}
 * is produced when NO revision is requested and the flow has NO active
 * revision (e.g. after the owner-authorized deactivation of revision 4): no
 * document is examined at all. The checks stay exactly as before (fail-closed);
 * the additive readiness.candidate diagnostics now say what was (not) examined
 * and why.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {readinessCandidate} from "../supabase/functions/flow-publication/readiness.ts";
import {readinessBlockers,readinessCandidateSummary,readinessTargetKind}
 from "../src/flow/activationAccount.ts";

import {withEnv,buttonsDoc,delayDoc,v2Doc,malformedDoc,T,A,KEY,pub,act,server,PROD_ENV,prodState,panelMissing,activeOf,type Act}
 from "./flowPublicationDouble.ts";
// ============================================ 1. the exact reported response
test("reported readiness: no revision requested + no active revision -> exact legacy report, now explained",async()=>{
 const s=prodState();
 for(const flowKey of [KEY,"default"]){ // the server flow, and an unpublished local editor key
  const r=await s.call({action:"readiness",accountId:A.a,flowKey});
  assert.equal(r.status,200);
  const rd=r.body.readiness;
  // Unchanged legacy contract: byte-for-byte the reported copied report.
  assert.deepEqual({revision:r.body.candidateRevision,kind:rd.candidateKind,configured:rd.configured,missing:panelMissing(rd)},
   {revision:null,kind:"unsupported",configured:false,missing:["activeRevision","supportedCandidate"]});
  // New: nothing was examined, and why.
  assert.deepEqual(rd.candidate,{flowKey,revision:null,source:"none",found:false,activeRevision:null,engine:null,
   reasons:{activeRevision:"no_active_revision",supportedCandidate:"no_candidate_revision"}});
  // No document read at all (no fallback to the latest or the deactivated revision 4).
  assert.ok(!s.log.some(l=>l.table==="automation_flow_publications"));
  // Activation is never offered on a report that examined nothing.
  assert.deepEqual(readinessBlockers(rd,{currentlyActive:false}),["candidateNotFound"]);
 }
 assert.equal(s.mutations().length,0,"readiness never activates or deactivates");
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[]);
});

test("readiness for the exact revision: V3 = buttons, V4 = delay, r2 = V2; missing r9 is not found (no fallback)",async()=>{
 const s=prodState();
 const want:Record<number,{kind:string;engine:string|null;missing:string[];reason:string|null}>={
  3:{kind:"buttons",engine:"durable",missing:["activeRevision"],reason:null},
  4:{kind:"delay",engine:"durable",missing:["activeRevision"],reason:null},
  2:{kind:"unsupported",engine:"v2",missing:["activeRevision","supportedCandidate"],reason:"not_durable_v2"},
  9:{kind:"unsupported",engine:null,missing:["activeRevision","supportedCandidate"],reason:"revision_not_found"}};
 for(const [rev,w] of Object.entries(want).map(([k,v])=>[Number(k),v] as const)){
  const r=await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:rev});
  assert.equal(r.status,200);assert.equal(r.body.candidateRevision,rev);
  const rd=r.body.readiness;
  assert.equal(rd.candidateKind,w.kind,String(rev));
  assert.deepEqual(panelMissing(rd),w.missing,String(rev));
  assert.equal(rd.candidate.revision,rev);assert.equal(rd.candidate.source,"requested");
  assert.equal(rd.candidate.found,rev!==9);assert.equal(rd.candidate.engine,w.engine);
  assert.equal(rd.candidate.activeRevision,null);
  assert.deepEqual(rd.candidate.reasons,{activeRevision:"no_active_revision",supportedCandidate:w.reason});
  // The publication read targets exactly that revision.
  const reads=s.log.filter(l=>l.table==="automation_flow_publications");
  assert.equal(reads.at(-1)!.filters!.revision,rev);
 }
 const nf=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:9})).body.readiness;
 assert.deepEqual(readinessBlockers(nf,{currentlyActive:false}),["candidateNotFound"]);
 // V2 revision: simple target, no advanced blockers (server still authorizes).
 const v2=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:2})).body.readiness;
 assert.equal(readinessTargetKind(v2),"simple");assert.deepEqual(readinessBlockers(v2,{currentlyActive:false}),[]);
 assert.equal(s.mutations().length,0);
});

// ============================================ 2. V3 / V4 explicit switching
test("V3 then V4: explicit activation of the exact revision; one active revision per flow; never a fallback",async()=>{
 const s=prodState();
 const v3=await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:3});
 assert.equal(v3.status,200);assert.deepEqual(v3.body,{ok:true,active:true,revision:3});
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@3"]);
 // Readiness without a revision now examines the flow's own ACTIVE revision.
 let r=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY})).body;
 assert.equal(r.candidateRevision,3);
 assert.deepEqual(r.readiness.candidate,{flowKey:KEY,revision:3,source:"active",found:true,activeRevision:3,engine:"durable",
  reasons:{activeRevision:null,supportedCandidate:null}});
 assert.equal(r.readiness.configured,true);assert.deepEqual(panelMissing(r.readiness),[]);
 // Checking V4 while V3 is live: examined = 4, active = 3 (explicitly different).
 r=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:4})).body;
 assert.equal(r.readiness.candidate.revision,4);assert.equal(r.readiness.candidate.activeRevision,3);
 assert.equal(r.readiness.candidateKind,"delay");
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@3"],"readiness switched nothing");
 // Explicit switch to V4 (rollback action = same RPC, exact revision).
 const v4=await s.call({action:"rollback",accountId:A.a,flowKey:KEY,revision:4});
 assert.equal(v4.status,200);assert.equal(v4.body.revision,4);
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@4"],"V3 replaced, never both on one flow_key");
 // A missing revision is refused and the live V4 stays (no fallback to latest/other).
 const miss=await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:9});
 assert.equal(miss.status,404);
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@4"]);
 for(const m of s.mutations().filter(l=>l.rpc==="flow_activate_revision"))
  assert.ok([3,4].includes(m.args.p_revision),"only explicitly requested revisions");
 // Deactivate -> the reported state again.
 assert.equal((await s.call({action:"deactivate",accountId:A.a,flowKey:KEY})).status,200);
 r=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY})).body;
 assert.equal(r.readiness.candidate.source,"none");assert.equal(r.candidateRevision,null);
});

test("V3 and V4 can run side by side only as separate flow keys (per account), each with its own revision",async()=>{
 const s=server({pubs:[pub(T.a,A.a,"menu_v3",1,buttonsDoc),pub(T.a,A.a,"later_v4",1,delayDoc)]});
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:"menu_v3",revision:1})).status,200);
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:"later_v4",revision:1})).status,200);
 assert.deepEqual(activeOf(s.acts,T.a,A.a).sort(),["later_v4@1","menu_v3@1"]);
 const a=(await s.call({action:"readiness",accountId:A.a,flowKey:"menu_v3"})).body.readiness;
 const b=(await s.call({action:"readiness",accountId:A.a,flowKey:"later_v4"})).body.readiness;
 assert.equal(a.candidateKind,"buttons");assert.equal(a.candidate.flowKey,"menu_v3");
 assert.equal(b.candidateKind,"delay");assert.equal(b.candidate.flowKey,"later_v4");
});

// ============================================ 3. isolation
test("two tenants / two accounts: readiness and activation never cross scopes",async()=>{
 const s=server({
  pubs:[pub(T.a,A.a,KEY,3,buttonsDoc),pub(T.a,A.a,KEY,4,delayDoc),pub(T.a,A.a2,KEY,1,v2Doc("A2")),pub(T.a,A.a2,KEY,2,delayDoc),
   pub(T.b,A.b,KEY,3,buttonsDoc),pub(T.b,A.b,KEY,4,delayDoc)],
  acts:[act(T.b,A.b,KEY,3,true)]});
 // Tenant B has V3 live: tenant A still reports nothing active and examined nothing.
 const ra=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY})).body.readiness;
 assert.equal(ra.candidate.source,"none");assert.equal(ra.candidate.activeRevision,null);
 // Tenant B sees its own V3 (B's account is not the canary: canary check false there only).
 const rb=(await s.call({action:"readiness",accountId:A.b,flowKey:KEY},"jwt-b")).body.readiness;
 assert.equal(rb.candidate.source,"active");assert.equal(rb.candidate.revision,3);assert.equal(rb.checks.canary,false);
 assert.equal(ra.checks.canary,true);
 // Cross-tenant requests are refused (403) for every action, nothing changes.
 const before=JSON.stringify(s.acts);
 for(const action of ["readiness","activate","rollback","deactivate"]){
  assert.equal((await s.call({action,accountId:A.b,flowKey:KEY,revision:4,tenantId:T.b})).status,403,action);
  assert.equal((await s.call({action,accountId:A.a,flowKey:KEY,revision:4},"jwt-b")).status,403,action);
 }
 assert.equal(JSON.stringify(s.acts),before);
 // A activates V4 on its canary account: B's V3 and A's second account untouched.
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:4})).status,200);
 assert.deepEqual(activeOf(s.acts,T.b,A.b),[KEY+"@3"]);
 assert.deepEqual(activeOf(s.acts,T.a,A.a2),[]);
 // Second account of tenant A: its own flow and engine only (V2 revision 1 there).
 const r2=(await s.call({action:"readiness",accountId:A.a2,flowKey:KEY,revision:1})).body.readiness;
 assert.equal(r2.candidate.engine,"v2");assert.equal(r2.candidate.activeRevision,null);assert.equal(r2.checks.canary,false);
 // Durable V4 on a non-canary account is refused (the durable canary is ONE account); V2 is allowed there.
 assert.equal((await s.call({action:"activate",accountId:A.a2,flowKey:KEY,revision:2})).status,422,"V4 off-canary");
 assert.deepEqual(activeOf(s.acts,T.a,A.a2),[]);
 assert.equal((await s.call({action:"activate",accountId:A.a2,flowKey:KEY,revision:1})).status,200,"V2 allowed");
 assert.deepEqual(activeOf(s.acts,T.a,A.a2),[KEY+"@1"]);
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@4"]);
 for(const l of s.log.filter(l=>l.filters&&"tenant_id" in l.filters&&l.table!=="channel_accounts"&&l.table!=="automation_flow_tenant_switches"))
  assert.ok(l.filters!.tenant_id===T.a||l.filters!.tenant_id===T.b);
});

// ============================================ 4. fail closed
test("malformed or unsupported configurations fail closed",async()=>{
 const s=server({pubs:[pub(T.a,A.a,"bad",1,malformedDoc),pub(T.a,A.a,KEY,4,delayDoc)]});
 for(const revision of ["4",0,-1,1.5,Number.MAX_SAFE_INTEGER+1])
  assert.equal((await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision})).status,400,String(revision));
 const bad=(await s.call({action:"readiness",accountId:A.a,flowKey:"bad",revision:1})).body.readiness;
 assert.equal(bad.candidateKind,"unsupported");assert.equal(bad.configured,false);
 assert.deepEqual(bad.candidate.reasons,{activeRevision:"no_active_revision",supportedCandidate:"not_durable"});
 assert.equal(bad.candidate.found,true);assert.equal(bad.candidate.engine,null);
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:"bad",revision:1})).status,422);
 // V4 without the scheduler flag: readiness says so and activation is refused.
 const noSched={...PROD_ENV,FLOW_DURABLE_SCHEDULER_ENABLED:undefined};
 const r=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:4},"jwt-a",noSched)).body.readiness;
 assert.equal(r.configured,false);assert.ok(panelMissing(r).includes("scheduler"));
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:4},"jwt-a",noSched)).status,422);
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[]);
});

// ============================================ 5. pure helpers / UI contract
test("readinessCandidate / readinessCandidateSummary: exact, validated, backward compatible",()=>{
 const base={flowKey:"k",requested:false,revision:null,activeRevision:null,activeCheck:false,found:false,
  durable:false,v2:false,commentDocument:false,candidateKind:"unsupported"};
 assert.equal(readinessCandidate(base).source,"none");
 assert.equal(readinessCandidate({...base,found:true}).found,false,"nothing examined is never 'found'");
 assert.equal(readinessCandidate({...base,revision:5,found:true,commentDocument:true}).reasons.supportedCandidate,"unsupported_comment_flow");
 assert.equal(readinessCandidate({...base,revision:5,found:true,candidateKind:"comment"}).engine,"comment");
 assert.equal(readinessCandidate({...base,revision:5,activeRevision:5,activeCheck:true,found:true,durable:true,candidateKind:"text"}).reasons.activeRevision,null);
 // Older server: no candidate -> previous blockers exactly.
 const old={checks:{activeRevision:false,supportedCandidate:false},candidateKind:"unsupported"};
 assert.equal(readinessCandidateSummary(old),null);
 assert.deepEqual(readinessBlockers(old,{currentlyActive:false}),[]);
 for(const candidate of [null,"x",[],{source:"other",flowKey:"k",found:true},{source:"none",flowKey:"",found:false},
  {source:"active",flowKey:"k"}])
  assert.equal(readinessCandidateSummary({...old,candidate}),null,JSON.stringify(candidate));
 const s=readinessCandidateSummary({...old,candidate:{source:"active",flowKey:"k",found:true,revision:3,activeRevision:3,
  engine:"weird",reasons:{activeRevision:"<script>",supportedCandidate:"not_durable"}}})!;
 assert.equal(s.engine,null);assert.deepEqual(s.reasons,{activeRevision:null,supportedCandidate:"not_durable"});
});

test("panel shows the examined candidate and copies it in the safe report (legacy keys unchanged)",()=>{
 const ui=readFileSync("src/flow/FlowPublicationPanel.tsx","utf8");
 assert.match(ui,/const report=\{revision:checkedRevision,kind:readiness\.candidateKind,configured,missing\};/);
 assert.match(ui,/if\(examined\)Object\.assign\(report,\{flowKey:examined\.flowKey,source:examined\.source,found:examined\.found,\n\s+activeRevision:examined\.activeRevision,engine:examined\.engine,reasons:examined\.reasons\}\);/);
 assert.match(ui,/data-testid="flow-readiness-candidate"/);
 assert.match(ui,/readinessCandidateSummary\(readiness\)\?\.source==="none"&&<p data-testid="flow-readiness-no-candidate"/);
 const flow=readFileSync("src/flow/useFlowActivation.ts","utf8");
 // The activation preflight still targets exactly one revision and checks the echoed one.
 assert.match(flow,/action:"readiness",accountId,flowKey:key,revision:target/);
 assert.match(flow,/checked!==target\?\["candidateRevision"\]:\n\s+row&&\(row\.status==="unsupported"\|\|row\.status==="missing"\)\?row\.reasons:readinessBlockers\(r\.readiness/);
});
