import {test} from "node:test";
import assert from "node:assert/strict";
import {accountCanActivate,otherActiveFlowKey,pickActivationAccount,readinessBlockers,readinessTargetKind,resolveServerFlowKey,
 type ActivationAccount} from "./activationAccount.ts";

const ig:ActivationAccount={id:"ig",platform:"instagram",is_active:true,canActivate:true,canActivateComments:true};
const fb:ActivationAccount={id:"fb",platform:"facebook",is_active:true,canActivate:false,canActivateComments:true};
const fbOff:ActivationAccount={...fb,id:"fbOff",canActivateComments:false};
const wa:ActivationAccount={id:"wa",platform:"whatsapp",is_active:true,canActivate:false,canActivateComments:false};

test("non-comment flows: the previous account choice and canActivate rule",()=>{
 assert.equal(pickActivationAccount([fb,ig],null)?.id,"ig");
 assert.equal(pickActivationAccount([fb,wa],null)?.id,"fb");
 assert.equal(pickActivationAccount([],null),null);
 assert.equal(accountCanActivate(fb,null),false,"facebook DM flow stays locked");
 assert.equal(accountCanActivate(ig,null),true);
 assert.equal(accountCanActivate(null,null),false);
});
test("facebook comment flow: picks the Page account the server marked canActivateComments",()=>{
 assert.equal(pickActivationAccount([ig,fb],"facebook")?.id,"fb");
 assert.equal(accountCanActivate(fb,"facebook"),true);
 // Server flags OFF: no canActivateComments -> locked, falls back to the old choice.
 assert.equal(pickActivationAccount([ig,fbOff],"facebook")?.id,"ig");
 assert.equal(accountCanActivate(fbOff,"facebook"),false);
 // Hint never crosses platforms; a missing field is OFF.
 assert.equal(accountCanActivate(fb,"instagram"),false);
 assert.equal(accountCanActivate({id:"x",platform:"facebook",is_active:true},"facebook"),false);
 assert.equal(accountCanActivate(wa,"facebook"),false);
});
test("instagram comment flow keeps the instagram account",()=>{
 assert.equal(pickActivationAccount([fb,ig],"instagram")?.id,"ig");
 assert.equal(accountCanActivate(ig,"instagram"),true);
});

const LIVE="ig_live_welcome_20261029";
const LOCAL="0b6f1b6e-6a3c-4f63-9d1e-3f1b2c4d5e6f";
test("resolveServerFlowKey: the catalog active flow wins over the local editor id",()=>{
 assert.equal(resolveServerFlowKey({localKey:LOCAL,catalog:[{flowKey:LIVE,latestRevision:4}],active:{flow_key:LIVE,revision:2}}),LIVE);
 // Even when the local key is also published, the account's live flow is managed.
 assert.equal(resolveServerFlowKey({localKey:LOCAL,catalog:[{flowKey:LOCAL,latestRevision:1},{flowKey:LIVE,latestRevision:4}],active:{flow_key:LIVE,revision:2}}),LIVE);
 assert.equal(resolveServerFlowKey({localKey:"default",catalog:[],active:{flow_key:LIVE,revision:2}}),LIVE);
});
test("resolveServerFlowKey: local key published under its own key, and fallbacks",()=>{
 assert.equal(resolveServerFlowKey({localKey:LOCAL,catalog:[{flowKey:LIVE,latestRevision:4},{flowKey:LOCAL,latestRevision:3}],active:null}),LOCAL);
 // Not published yet: keep the local key (old behaviour, "No published revision").
 assert.equal(resolveServerFlowKey({localKey:LOCAL,catalog:[{flowKey:LIVE,latestRevision:4}],active:null}),LOCAL);
 assert.equal(resolveServerFlowKey({localKey:"default",catalog:[],active:null}),"default");
 assert.equal(resolveServerFlowKey({localKey:"default"}),"default");
 assert.equal(resolveServerFlowKey({localKey:"default",catalog:null,active:undefined}),"default");
 // Malformed active entries never win.
 assert.equal(resolveServerFlowKey({localKey:"default",active:{flow_key:"",revision:1}}),"default");
 assert.equal(resolveServerFlowKey({localKey:"default",active:{} as never}),"default");
 assert.equal(resolveServerFlowKey({localKey:"default",catalog:[null as never]}),"default");
});
test("otherActiveFlowKey: only a different, non-empty active key conflicts",()=>{
 assert.equal(otherActiveFlowKey(null,LIVE),null);
 assert.equal(otherActiveFlowKey(undefined,LIVE),null);
 assert.equal(otherActiveFlowKey({flow_key:LIVE,revision:2},LIVE),null);
 assert.equal(otherActiveFlowKey({flow_key:LIVE,revision:2},LOCAL),LIVE);
 assert.equal(otherActiveFlowKey({flow_key:"",revision:2},LOCAL),null);
});
const allTrue={instagram:true,tenant:true,account:true,globalSwitch:true,tenantSwitch:true,credits:true,
 activeRevision:true,supportedCandidate:true,ingress:true,activation:true,canary:true,operatorRelease:true,
 outbox:true,atomicDebit:true,encryption:true,scheduler:true,buttons:true,internalActions:true,media:true};
test("readinessBlockers: advanced targets keep the panel interpretation",()=>{
 assert.deepEqual(readinessBlockers({checks:allTrue,candidateKind:"buttons",configured:true},{currentlyActive:true}),[]);
 // Unneeded optional flags never block.
 assert.deepEqual(readinessBlockers({checks:{...allTrue,scheduler:false,media:false,internalActions:false},
  candidateKind:"buttons",needsButtons:true,needsScheduler:false,configured:true},{currentlyActive:true}),[]);
 // Needed flags block (old servers: needs derived from candidateKind).
 assert.deepEqual(readinessBlockers({checks:{...allTrue,scheduler:false},candidateKind:"delay"},{currentlyActive:true}),["scheduler"]);
 assert.deepEqual(readinessBlockers({checks:{...allTrue,scheduler:false,buttons:false},candidateKind:"mixed"},{currentlyActive:false}),["scheduler","buttons"]);
 assert.deepEqual(readinessBlockers({checks:{...allTrue,canary:false,outbox:false},candidateKind:"buttons",needsButtons:true},{currentlyActive:true}),["canary","outbox"]);
 // OFF -> ON: "flow already has an active revision" is not a requirement; ON: it is.
 assert.deepEqual(readinessBlockers({checks:{...allTrue,activeRevision:false},candidateKind:"delay",needsScheduler:true,configured:false},{currentlyActive:false}),[]);
 assert.deepEqual(readinessBlockers({checks:{...allTrue,activeRevision:false},candidateKind:"delay",needsScheduler:true},{currentlyActive:true}),["activeRevision"]);
 assert.deepEqual(readinessBlockers({checks:allTrue,candidateKind:"buttons",needsButtons:true,configured:false},{currentlyActive:true}),["configured"]);
 // A text graph that needs internal actions or media is advanced.
 assert.deepEqual(readinessBlockers({checks:{...allTrue,internalActions:false,canary:false},candidateKind:"text",needsInternalActions:true},{currentlyActive:false}),["canary","internalActions"]);
 assert.deepEqual(readinessBlockers({checks:{...allTrue,media:false},candidateKind:"text",needsMedia:true},{currentlyActive:false}),["media"]);
 // Comment reports (unsupported plan) stay gated, with supportedCandidate.
 assert.deepEqual(readinessBlockers({checks:{...allTrue,commentTrigger:false,supportedCandidate:false},candidateKind:"unsupported",
  commentTrigger:{status:"unsupported"}},{currentlyActive:false}),["supportedCandidate","commentTrigger"]);
 assert.deepEqual(readinessBlockers({checks:{...allTrue,canary:false},candidateKind:"comment"},{currentlyActive:false}),["canary"]);
});
const simpleChecks={...allTrue,supportedCandidate:false,activeRevision:false,ingress:false,activation:false,canary:false,
 operatorRelease:false,outbox:false,atomicDebit:false,encryption:false,scheduler:false,buttons:false,internalActions:false,media:false};
test("readinessBlockers: simple text-only targets keep the legacy server path (no client blockers)",()=>{
 const legacy={checks:simpleChecks,candidateKind:"unsupported",needsButtons:false,needsScheduler:false,
  needsInternalActions:false,needsMedia:false,buttonsConfigured:false,delayConfigured:false,configured:false};
 assert.equal(readinessTargetKind(legacy),"simple");
 assert.deepEqual(readinessBlockers(legacy,{currentlyActive:false}),[]);
 assert.deepEqual(readinessBlockers(legacy,{currentlyActive:true}),[]);
 // Older servers without needs* fields.
 assert.deepEqual(readinessBlockers({checks:simpleChecks,candidateKind:"unsupported"},{currentlyActive:false}),[]);
 const text={checks:{...simpleChecks,supportedCandidate:true},candidateKind:"text",needsButtons:false,needsScheduler:false,configured:false};
 assert.equal(readinessTargetKind(text),"simple");
 assert.deepEqual(readinessBlockers(text,{currentlyActive:true}),[]);
});
test("readinessBlockers: unclassifiable reports fail closed",()=>{
 assert.deepEqual(readinessBlockers(null,{currentlyActive:true}),["readiness_unavailable"]);
 assert.deepEqual(readinessBlockers(undefined,{currentlyActive:false}),["readiness_unavailable"]);
 assert.deepEqual(readinessBlockers({} as never,{currentlyActive:false}),["readiness_unavailable"]);
 // No candidateKind: cannot be shown simple -> blocked even when every check is true.
 assert.equal(readinessTargetKind({checks:allTrue}),"unknown");
 assert.deepEqual(readinessBlockers({checks:allTrue},{currentlyActive:false}),["readiness_unclassified"]);
 assert.deepEqual(readinessBlockers({checks:{...allTrue,canary:false}},{currentlyActive:false}),["canary"]);
 // Unrecognised kind.
 assert.equal(readinessTargetKind({checks:allTrue,candidateKind:"carousel"}),"unknown");
 assert.deepEqual(readinessBlockers({checks:allTrue,candidateKind:"carousel"},{currentlyActive:true}),["readiness_unclassified"]);
 assert.deepEqual(readinessBlockers({checks:allTrue,candidateKind:5 as never},{currentlyActive:true}),["readiness_unclassified"]);
});
test("resolveServerFlowKey is cross-account safe: only the selected account's own active entry counts",()=>{
 const A={flowKey:"flow_a",latestRevision:3},B={flowKey:"flow_b",latestRevision:5};
 // A's own catalog: never B's key, even if B's flows are passed in the catalog input.
 assert.equal(resolveServerFlowKey({localKey:LOCAL,catalog:[A],active:{flow_key:"flow_a",revision:2}}),"flow_a");
 assert.equal(resolveServerFlowKey({localKey:LOCAL,catalog:[A,B],active:{flow_key:"flow_a",revision:2}}),"flow_a");
 // No active publication on the selected account: the local key, never another account's key.
 assert.equal(resolveServerFlowKey({localKey:LOCAL,catalog:[B],active:null}),LOCAL);
 assert.equal(resolveServerFlowKey({localKey:LOCAL,catalog:[A,B]}),LOCAL);
 // Selecting a different active: only another account's catalog reply (a different call) can yield its key.
 assert.equal(resolveServerFlowKey({localKey:LOCAL,catalog:[A],active:{flow_key:"flow_b",revision:4}}),"flow_b");
 assert.equal(otherActiveFlowKey({flow_key:"flow_b",revision:4},"flow_a"),"flow_b");
});
