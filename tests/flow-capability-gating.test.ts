/**
 * Editor capability gating (src/flow/capabilityReasons.ts blockGate /
 * accountNotice, src/flow/useFlowCapabilities.ts parseCapabilities) and the
 * customer-facing reason catalogue.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {REASON_TEXT,UNAVAILABLE_BADGE,blockGate,accountNotice,reasonText,type CapabilityState}
 from "../src/flow/capabilityReasons.ts";
import {parseCapabilities} from "../src/flow/capabilityReasons.ts";
import {CAPABILITIES} from "../src/flow/requirements.ts";
import {capabilityAvailability} from "../supabase/functions/flow-publication/capabilities.ts";
import {makeNode,KIND_LIST} from "../src/flow/model.ts";

const ACC="11111111-1111-4111-8111-111111111111",OTHER="33333333-3333-4333-8333-333333333333";
const base={platform:"instagram" as const,tenantActive:true,accountActive:true,agentEnabled:true,autoReply:true,
 globalEnabled:true,tenantEnabled:true,productionApproved:true,activationReady:true,durableIngress:true,canaryMatched:false,
 operatorReleased:true,outboxEnabled:true,atomicDebitReady:true,encryptionConfigured:true,richButtons:true,scheduler:true,
 internalActions:true,mediaAllowed:true,aiStep:true,commentAutomation:true,multichannel:true};
const ready=(inputs:Partial<typeof base>={},accountId=ACC):CapabilityState=>
 parseCapabilities(accountId,{ok:true,platform:inputs.platform??"instagram",capabilities:capabilityAvailability({...base,...inputs}).capabilities})!;
const at=(kind:any,opts?:any)=>makeNode(kind,{x:0,y:0},opts).data;

test("non-canary account: advanced blocks gated with plain reasons, basic blocks never",()=>{
 const s=ready();
 for(const k of ["delay","randomizer","goto"] as const)assert.equal(blockGate(at(k),s,ACC)?.reason,"advanced_not_enabled",k);
 assert.equal(blockGate(at("question"),s,ACC)?.reason,"advanced_not_enabled","button question");
 for(const t of ["tag","notify","handoff","ai","set_field"])assert.equal(blockGate(at("action",{actionType:t}),s,ACC)?.reason,"advanced_not_enabled",t);
 assert.equal(blockGate(at("request"),s,ACC)?.reason,"http_request_not_supported");
 assert.equal(blockGate(at("message"),s,ACC),null);assert.equal(blockGate(at("condition"),s,ACC),null);
 assert.equal(blockGate(at("trigger"),s,ACC),null);assert.equal(blockGate(at("end"),s,ACC),null);
 assert.match(blockGate(at("delay"),s,ACC)!.text,/غير متاحة لحسابك حاليًا/);
});

test("canary account: only the specific missing flag gates; everything else open",()=>{
 const s=ready({canaryMatched:true,scheduler:false,internalActions:false});
 assert.equal(blockGate(at("delay"),s,ACC)?.reason,"delay_not_enabled");
 assert.equal(blockGate(at("action",{actionType:"tag"}),s,ACC)?.reason,"internal_actions_not_enabled");
 assert.equal(blockGate(at("question"),s,ACC),null);
 assert.equal(blockGate(at("action",{actionType:"ai"}),s,ACC),null);
 const all=ready({canaryMatched:true});
 for(const k of KIND_LIST)if(k!=="request")assert.equal(blockGate(at(k),all,ACC),null,k);
});

test("not loaded / failed / demo / other account: never gate, never claim",()=>{
 const s=ready();
 assert.equal(blockGate(at("delay"),null,ACC),null);
 for(const status of ["idle","loading","failed"] as const)
  assert.equal(blockGate(at("delay"),{status,accountId:ACC,platform:null,capabilities:null},ACC),null,status);
 assert.equal(blockGate(at("delay"),s,null),null,"no account (demo)");
 assert.equal(blockGate(at("delay"),s,OTHER),null,"another account's report never applies");
 assert.equal(blockGate(at("delay"),ready({canaryMatched:true},OTHER),ACC),null);
 assert.equal(accountNotice(ready({productionApproved:false}),OTHER),null);
 // Malformed server replies are failures (no gating), never partial availability.
 for(const r of [null,{ok:false},{ok:true},{ok:true,platform:"x",capabilities:{}},{ok:true,platform:"instagram",capabilities:[]}])
  assert.equal(parseCapabilities(ACC,r as any),null,JSON.stringify(r));
 const p=parseCapabilities(ACC,{ok:true,platform:"instagram",capabilities:{delay:{available:"yes",reason:"<b>"}}})!;
 assert.deepEqual(p.capabilities.delay,{available:false,reason:null});
 assert.equal(p.capabilities.text,undefined);
 // missing entry -> unknown, treated as not gating account-wide
 assert.equal(blockGate(at("message"),p,ACC),null);
});

test("account-wide reasons are one notice, not per-block disabling",()=>{
 for(const [inputs,code] of [[{productionApproved:false},"account_not_approved"],[{autoReply:false},"account_paused"],
  [{platform:"whatsapp"},"channel_not_supported"]] as const){
  const s=ready(inputs as any);
  assert.equal(accountNotice(s,ACC),reasonText(code));
  for(const k of KIND_LIST)if(k!=="request")assert.equal(blockGate(at(k),s,ACC),null,code+" "+k);
 }
 assert.equal(accountNotice(ready(),ACC),null);
});

test("reason catalogue: plain Arabic for every code, no technical words",()=>{
 const codes=new Set(Object.keys(REASON_TEXT));
 for(const c of ["account_paused","account_not_approved","channel_not_supported","advanced_not_enabled","buttons_not_enabled",
  "delay_not_enabled","internal_actions_not_enabled","media_not_enabled","ai_not_enabled","comments_not_enabled","not_supported","unavailable",
  "malformed_document","unknown_block","trigger_not_supported","trigger_channel_mismatch","pdf_not_supported","number_question_not_supported",
  "http_request_not_supported","content_blocks_not_supported","legacy_image_not_supported","button_action_not_supported",
  "mixed_buttons_not_supported","inbound_message_condition","action_not_supported"])assert.ok(codes.has(c),c);
 // every reason the server can emit has a text
 const emitted=new Set<string>();
 for(const v of [base,{...base,canaryMatched:true,scheduler:false,richButtons:false,internalActions:false,mediaAllowed:false,aiStep:false,commentAutomation:false},
  {...base,autoReply:false},{...base,productionApproved:false},{...base,platform:"whatsapp"}])
  for(const e of Object.values(capabilityAvailability(v as any).capabilities))if(e.reason)emitted.add(e.reason);
 for(const r of emitted)assert.ok(codes.has(r),r);
 const FORBIDDEN=/engine|revision|canary|operator|flag|worker|durable|runtime|readiness|\bv[2-4]\b|محرك|إصدار|الإصدار|تجريبي|مشغّل|العامل|العمال|كناري|Outbox|ingress/i;
 for(const [code,t] of Object.entries(REASON_TEXT)){
  assert.match(t.ar,/[؀-ۿ]/,code);assert.doesNotMatch(t.ar,FORBIDDEN,code);
 }
 assert.doesNotMatch(UNAVAILABLE_BADGE.ar,FORBIDDEN);
 // New customer-facing strings in the editor wiring carry no technical words either.
 const ui=readFileSync("src/pages/FlowBuilder.tsx","utf8"),panel=readFileSync("src/flow/NodeEditor.tsx","utf8");
 const notice=panel.slice(panel.indexOf("step-capability-notice"),panel.indexOf("step-capability-notice")+400);
 assert.doesNotMatch(notice,FORBIDDEN);
 const palette=ui.slice(ui.indexOf("Unavailable for this account"),ui.indexOf("ACTION_PRESETS.map"));
 assert.match(palette,/aria-disabled=\{gate\?true:undefined\}/);
 assert.match(palette,/if\(gate\)\{setNotice\(gate\.text\);return;\}/,"a disabled block is never added");
 assert.doesNotMatch(palette,/\.filter\([^)]*gate/,"disabled, not hidden");
 assert.ok(CAPABILITIES.length>0);
});
