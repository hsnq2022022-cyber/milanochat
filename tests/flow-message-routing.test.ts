// ONE deterministic owner for every inbound customer message (milan-api/messageRouting.ts).
// Precedence: human takeover > automation paused/ineligible > Flow session > Flow trigger > AI.
// Behavioural (pure module, injected stages) + atomic-claim concurrency (processExclusiveEvent over a
// fake that models the UNIQUE(tenant,account,platform,provider_event_id) insert) + a source pin that
// the webhook handler contains no routing logic of its own.
// NOT proof of real provider delivery: nothing here talks to Meta or a database.
// Engine-level session behaviour (waiting runs, free text, stale taps, foreign-tenant rows, duplicates)
// stays covered by tests/flow-durable-instagram-ingress.test.ts; the SQL claim by CI pg suites.
// Run: node --experimental-strip-types --test tests/flow-message-routing.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {routeInbound,conversationGate,ownerOfClaim,
 type ConversationFacts,type RouteInput,type RouteDeps,type FlowStage,type ExclusiveRun}
 from "../supabase/functions/milan-api/messageRouting.ts";
import {processExclusiveEvent,FlowRoutingUnavailableError,type Claimed,type Dependencies}
 from "../supabase/functions/milan-api/exclusiveMessageClaim.ts";

const NOW=Date.parse("2026-11-24T10:00:00Z");
const facts=(o:Partial<ConversationFacts>={}):ConversationFacts=>({
 transferred:false,autoPausedReason:null,humanAgentExpiresAtMs:null,
 agentEnabled:true,autoReply:true,creditsRemaining:5,nowMs:NOW,...o});
const input=(o:Partial<RouteInput>={},c:Partial<ConversationFacts>={}):RouteInput=>({
 conversation:facts(c),accountProven:true,eventClaimable:true,durableApplicable:true,...o});
function spy(o:{durable?:FlowStage|"throw";exclusive?:ExclusiveRun}={}){
 const calls:string[]=[];
 const deps:RouteDeps={
  resumeTakeover:async()=>{calls.push("resume");},
  pauseForCredits:async()=>{calls.push("pause");},
  afterGate:async()=>{calls.push("afterGate");},
  attemptDurable:async()=>{calls.push("durable");if(o.durable==="throw")throw new Error("boom");return o.durable??"fallback";},
  exclusive:async()=>{calls.push("exclusive");return o.exclusive??{outcome:"sent_and_billed",route:"legacy_ai"};},
 };
 return {deps,calls};
}

/* ───────── 1. Human takeover / handoff owns first ───────── */
test("1. a human takeover silences everything: neither Flow nor AI is even consulted",async()=>{
 const {deps,calls}=spy();
 const d=await routeInbound(input({},{transferred:true,autoPausedReason:"manual_takeover",humanAgentExpiresAtMs:NOW+60_000}),deps);
 assert.deepEqual(d,{kind:"no_reply",owner:"human",reason:"live_human_takeover",resolve:true});
 assert.deepEqual(calls,[]);
});
test("1. an AI-handoff takeover never auto-expires here (only a manual takeover does)",async()=>{
 const {deps,calls}=spy();
 const d=await routeInbound(input({},{transferred:true,autoPausedReason:"ai_handoff",humanAgentExpiresAtMs:NOW-1}),deps);
 assert.equal(d.kind==="no_reply"&&d.owner==="human",true);
 assert.deepEqual(calls,[]);
});
test("1. an EXPIRED manual takeover hands the conversation back, then routing continues",async()=>{
 const {deps,calls}=spy({durable:"fallback"});
 const d=await routeInbound(input({},{transferred:true,autoPausedReason:"manual_takeover",humanAgentExpiresAtMs:NOW}),deps);
 assert.equal(d.kind,"claimed");
 assert.deepEqual(calls,["resume","afterGate","durable","exclusive"]);
});
test("1. an unreadable takeover expiry (NaN/null) is never treated as expired",()=>{
 for(const exp of [null,Number.NaN]){
  const g=conversationGate(facts({transferred:true,autoPausedReason:"manual_takeover",humanAgentExpiresAtMs:exp}));
  assert.equal(g.action,"stop");
 }
});
test("1. an expired takeover is cleared even when a later check then silences the reply",async()=>{
 const {deps,calls}=spy();
 const d=await routeInbound(input({},{transferred:true,autoPausedReason:"manual_takeover",humanAgentExpiresAtMs:NOW-5,autoReply:false}),deps);
 assert.equal(d.kind==="no_reply"&&d.reason==="live_auto_reply_off",true);
 assert.deepEqual(calls,["resume"]);
});

/* ───────── 2. Paused / ineligible: nobody answers ───────── */
test("2. gate order: takeover > credits pause > auto-reply off > no credits",()=>{
 const all={transferred:true,autoPausedReason:"credits",agentEnabled:false,autoReply:false,creditsRemaining:0};
 assert.equal((conversationGate(facts(all)) as any).reason,"live_human_takeover");
 assert.equal((conversationGate(facts({...all,transferred:false})) as any).reason,"live_credits_paused");
 assert.equal((conversationGate(facts({...all,transferred:false,autoPausedReason:null})) as any).reason,"live_auto_reply_off");
 assert.equal((conversationGate(facts({...all,transferred:false,autoPausedReason:null,agentEnabled:true,autoReply:true})) as any).reason,"live_no_credits");
});
test("2. agent disabled or auto-reply off: no Flow, no AI; unknown (null) is not 'off'",async()=>{
 for(const c of [{agentEnabled:false},{autoReply:false}]){
  const {deps,calls}=spy();
  const d=await routeInbound(input({},c),deps);
  assert.equal(d.kind==="no_reply"&&d.owner==="none"&&d.reason==="live_auto_reply_off",true);
  assert.deepEqual(calls,[]);
 }
 const {deps}=spy();
 assert.equal((await routeInbound(input({},{agentEnabled:null,autoReply:undefined}),deps)).kind,"claimed");
});
test("2. no credits pauses the conversation once and sends nothing",async()=>{
 const {deps,calls}=spy();
 const d=await routeInbound(input({},{creditsRemaining:0}),deps);
 assert.equal(d.kind==="no_reply"&&d.reason==="live_no_credits",true);
 assert.deepEqual(calls,["pause"]);
 // a conversation ALREADY paused for credits is silent without another write
 const s=spy();
 const p=await routeInbound(input({},{autoPausedReason:"credits"}),s.deps);
 assert.equal(p.kind==="no_reply"&&p.reason==="live_credits_paused",true);
 assert.deepEqual(s.calls,[]);
});
test("2. unproven account / unclaimable event: nobody answers, the Flow engine is never asked",async()=>{
 for(const [o,reason,resolve] of [[{accountProven:false},"account_unproven",true],[{eventClaimable:false},"event_unclaimable",false]] as const){
  const {deps,calls}=spy();
  const d=await routeInbound(input(o),deps);
  assert.deepEqual(d,{kind:"no_reply",owner:"none",reason,resolve});
  assert.deepEqual(calls,["afterGate"]);
 }
});

/* ───────── 3-5. Flow session > Flow trigger > AI ───────── */
test("3. an existing Flow session owns the message: the AI claim path is never entered",async()=>{
 const {deps,calls}=spy({durable:"handled"});
 const d=await routeInbound(input(),deps);
 assert.deepEqual(d,{kind:"flow_session",owner:"flow_session",resolve:true});
 assert.deepEqual(calls,["afterGate","durable"]); // no "exclusive": AI cannot answer
});
test("4. a matching Flow trigger owns the message under the exclusive claim (not the AI)",async()=>{
 const {deps}=spy({durable:"fallback",exclusive:{outcome:"sent_and_billed",route:"flow"}});
 const d=await routeInbound(input(),deps);
 assert.deepEqual(d,{kind:"claimed",owner:"flow",outcome:"sent_and_billed",resolve:true});
});
test("5. no Flow owns the message: the AI answers under the same claim",async()=>{
 const {deps}=spy({durable:"fallback",exclusive:{outcome:"sent_and_billed",route:"legacy_ai"}});
 const d=await routeInbound(input(),deps);
 assert.deepEqual(d,{kind:"claimed",owner:"ai",outcome:"sent_and_billed",resolve:true});
});
test("durable engine not applicable (channel/flag): straight to the exclusive claim, durable never asked",async()=>{
 const {deps,calls}=spy();
 await routeInbound(input({durableApplicable:false}),deps);
 assert.deepEqual(calls,["afterGate","exclusive"]);
});

/* ───────── Flow failure never becomes a conflicting AI reply ───────── */
test("flow eligibility UNKNOWN (retry): nobody answers and the AI claim path is not entered",async()=>{
 const {deps,calls}=spy({durable:"retry"});
 const d=await routeInbound(input(),deps);
 assert.deepEqual(d,{kind:"retry",owner:"unknown",stage:"flow"});
 assert.equal(calls.includes("exclusive"),false);
});
test("an unconfirmed/failed exclusive claim is a retry, never an AI reply",async()=>{
 for(const outcome of ["routing_unavailable","claim_failed"]){
  const {deps}=spy({durable:"fallback",exclusive:{outcome,route:null}});
  assert.deepEqual(await routeInbound(input(),deps),{kind:"retry",owner:"unknown",stage:"claim"});
 }
});
test("a throwing Flow stage fails closed: the error propagates and the AI path is never entered",async()=>{
 const {deps,calls}=spy({durable:"throw"});
 await assert.rejects(()=>routeInbound(input(),deps),/boom/);
 assert.equal(calls.includes("exclusive"),false);
});
test("terminal send failures after an acquired claim are final (owner stays the claimer), never re-routed",async()=>{
 for(const outcome of ["send_failed","empty","sent_unconfirmed","delivery_unavailable","sent_persist_failed","sent_billing_failed"]){
  const {deps,calls}=spy({durable:"fallback",exclusive:{outcome,route:"flow"}});
  const d=await routeInbound(input(),deps);
  assert.equal(d.kind==="claimed"&&d.owner==="flow"&&d.outcome===outcome,true,outcome);
  assert.equal(calls.filter(c=>c==="exclusive").length,1);
 }
});
test("a duplicate (lost the claim) is terminal for this copy and keeps the winner's owner",async()=>{
 const {deps}=spy({durable:"fallback",exclusive:{outcome:"duplicate",route:"flow"}});
 assert.deepEqual(await routeInbound(input(),deps),{kind:"claimed",owner:"flow",outcome:"duplicate",resolve:true});
 assert.equal(ownerOfClaim({outcome:"x",route:null}),"none");
});

/* ───────── Exhaustive invariants over every combination ───────── */
test("invariants over all fact/stage combinations: the AI owns only when nothing else may",async()=>{
 const bools=[true,false];
 let combos=0;
 for(const transferred of bools)for(const paused of [null,"credits","manual_takeover"])
 for(const autoReply of bools)for(const credits of [0,3])for(const proven of bools)for(const claimable of bools)
 for(const applicable of bools)for(const durable of ["handled","retry","fallback"] as FlowStage[])
 for(const route of ["flow","legacy_ai"] as const){
  combos++;
  const {deps,calls}=spy({durable,exclusive:{outcome:"sent_and_billed",route}});
  const d=await routeInbound(input({accountProven:proven,eventClaimable:claimable,durableApplicable:applicable},
   {transferred,autoPausedReason:paused,autoReply,creditsRemaining:credits,humanAgentExpiresAtMs:NOW+1}),deps);
  const aiOwns=d.kind==="claimed"&&d.owner==="ai";
  if(aiOwns){
   assert.equal(transferred,false);assert.notEqual(paused,"credits");assert.equal(autoReply,true);
   assert.ok(credits>0);assert.ok(proven&&claimable);
   assert.notEqual(applicable&&durable==="handled",true);
   assert.notEqual(applicable&&durable==="retry",true);
  }
  if(transferred)assert.equal(calls.includes("durable")||calls.includes("exclusive"),false,"takeover: no engine consulted");
  if(d.kind==="flow_session")assert.equal(calls.includes("exclusive"),false,"session: no claim path");
  if(d.kind==="retry")assert.notEqual((d as any).owner,"ai");
  // never two owners: at most one of the engines produced the decision
  assert.ok(calls.filter(c=>c==="exclusive").length<=1);
 }
 assert.ok(combos>1000);
});

/* ───────── Atomic exclusivity under concurrency / duplicates / tenants ───────── */
function atomicClaims(){
 const rows=new Map<string,{route:"legacy_ai"|"flow";id:string;out:string}>();
 let n=0;
 const claim=async(key:string[],engineReady:boolean):Promise<Claimed>=>{
  await Promise.resolve(); // let concurrent callers interleave BEFORE the atomic check-and-insert
  const k=key.join("|");
  const existing=rows.get(k);
  if(existing)return {acquired:false,route:existing.route,claim_id:existing.id,outgoing_message_id:existing.out};
  const row={route:engineReady?"flow" as const:"legacy_ai" as const,id:"claim-"+(++n),out:"out-"+n};
  rows.set(k,row); // models UNIQUE(tenant,account,platform,provider_event_id) ... ON CONFLICT DO NOTHING
  return {acquired:true,route:row.route,claim_id:row.id,outgoing_message_id:row.out};
 };
 return {rows,claim};
}
function exclusiveDeps(store:ReturnType<typeof atomicClaims>,key:string[],o:{flow?:string|null;ai?:string;sent:string[]}):Dependencies{
 return {
  prepareFlow:async()=>o.flow??null,
  claim:async(ready)=>store.claim(key,ready),
  legacyAnswer:async()=>o.ai??"AI",
  send:async(text)=>{o.sent.push(text);return {providerMessageId:"mid-"+o.sent.length};},
  persistSent:async()=>true,
  debit:async()=>1,
 };
}
const KEY=["tenantA","acct1","instagram","evt-1"];
test("concurrency: two copies of ONE event produce exactly one provider send",async()=>{
 const store=atomicClaims(),sent:string[]=[];
 const [a,b]=await Promise.all([
  processExclusiveEvent(exclusiveDeps(store,KEY,{flow:"FLOW",sent})),
  processExclusiveEvent(exclusiveDeps(store,KEY,{flow:"FLOW",sent})),
 ]);
 assert.deepEqual([a,b].sort(),["duplicate","sent_and_billed"]);
 assert.equal(sent.length,1);
});
test("concurrency: a Flow-ready copy and an AI-only copy of the same event can never both answer",async()=>{
 for(let round=0;round<20;round++){
  const store=atomicClaims(),sent:string[]=[];
  const copies=round%2===0
   ?[exclusiveDeps(store,KEY,{flow:"FLOW",sent}),exclusiveDeps(store,KEY,{flow:null,ai:"AI",sent})]
   :[exclusiveDeps(store,KEY,{flow:null,ai:"AI",sent}),exclusiveDeps(store,KEY,{flow:"FLOW",sent})];
  const out=await Promise.all(copies.map(c=>processExclusiveEvent(c)));
  assert.equal(sent.length,1,"exactly one owner answers");
  assert.equal(out.filter(o=>o==="duplicate").length,1,"the loser is a duplicate");
  const winnerRoute=[...store.rows.values()][0].route;
  assert.equal(sent[0],winnerRoute==="flow"?"FLOW":"AI","the sent text matches the committed owner");
 }
});
test("concurrency: 25 parallel redeliveries of one event send exactly once",async()=>{
 const store=atomicClaims(),sent:string[]=[];
 const out=await Promise.all(Array.from({length:25},()=>processExclusiveEvent(exclusiveDeps(store,KEY,{flow:"FLOW",sent}))));
 assert.equal(sent.length,1);
 assert.equal(out.filter(o=>o==="sent_and_billed").length,1);
 assert.equal(out.filter(o=>o==="duplicate").length,24);
});
test("a redelivery AFTER completion is a duplicate and sends nothing",async()=>{
 const store=atomicClaims(),sent:string[]=[];
 assert.equal(await processExclusiveEvent(exclusiveDeps(store,KEY,{flow:"FLOW",sent})),"sent_and_billed");
 assert.equal(await processExclusiveEvent(exclusiveDeps(store,KEY,{flow:null,ai:"AI",sent})),"duplicate");
 assert.deepEqual(sent,["FLOW"]);
});
test("tenant isolation: the same provider event id under another tenant/account/platform is an independent event",async()=>{
 const store=atomicClaims(),sent:string[]=[];
 const keys=[KEY,["tenantB",...KEY.slice(1)],[KEY[0],"acct2",KEY[2],KEY[3]],[KEY[0],KEY[1],"facebook",KEY[3]]];
 const out=await Promise.all(keys.map(k=>processExclusiveEvent(exclusiveDeps(store,k,{flow:"FLOW",sent}))));
 assert.deepEqual(out,["sent_and_billed","sent_and_billed","sent_and_billed","sent_and_billed"]);
 assert.equal(sent.length,4);
 assert.equal(store.rows.size,4);
});
test("flow routing data unreadable: no claim, no send and the AI is NOT consulted",async()=>{
 const store=atomicClaims(),sent:string[]=[];let aiAsked=false;
 const deps=exclusiveDeps(store,KEY,{sent});
 deps.prepareFlow=async()=>{throw new FlowRoutingUnavailableError();};
 deps.legacyAnswer=async()=>{aiAsked=true;return "AI";};
 assert.equal(await processExclusiveEvent(deps),"routing_unavailable");
 assert.equal(aiAsked,false);assert.equal(store.rows.size,0);assert.equal(sent.length,0);
});
test("flow could not even be PREPARED (unexpected error, nothing claimed or sent): the AI answers once",async()=>{
 // Documented fallback: a poison/unreadable flow document must not silence the whole account.
 const store=atomicClaims(),sent:string[]=[];
 const deps=exclusiveDeps(store,KEY,{sent,ai:"AI"});
 deps.prepareFlow=async()=>{throw new Error("unexpected");};
 assert.equal(await processExclusiveEvent(deps),"sent_and_billed");
 assert.deepEqual(sent,["AI"]);
 assert.equal([...store.rows.values()][0].route,"legacy_ai");
});
test("a send failure after an acquired claim is never re-sent by a redelivery or by the other owner",async()=>{
 const store=atomicClaims(),sent:string[]=[];
 const failing=exclusiveDeps(store,KEY,{flow:"FLOW",sent});
 failing.send=async()=>{throw new Error("network");};
 assert.equal(await processExclusiveEvent(failing),"send_failed");
 assert.equal(await processExclusiveEvent(exclusiveDeps(store,KEY,{flow:null,ai:"AI",sent})),"duplicate");
 assert.equal(sent.length,0);
});
test("onClaim observes the committed route and a throwing observer cannot change the outcome",async()=>{
 const store=atomicClaims(),sent:string[]=[];
 const seen:Array<[string,boolean]>=[];
 const deps=exclusiveDeps(store,KEY,{flow:"FLOW",sent});
 deps.onClaim=(c)=>{seen.push([c.route,c.acquired]);throw new Error("observer bug");};
 assert.equal(await processExclusiveEvent(deps),"sent_and_billed");
 assert.deepEqual(seen,[["flow",true]]);
});

/* ───────── The webhook handler holds no routing logic of its own ───────── */
test("source pin: handleIncomingWebhookMessage routes ONLY through routeInbound",()=>{
 const src=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const start=src.indexOf("async function handleIncomingWebhookMessage(");
 const end=src.indexOf("Deno.serve(async (req)",start);
 const handler=src.slice(start,end);
 assert.ok(handler.includes("await routeInbound("),"uses the central decision");
 assert.equal((handler.match(/await routeInbound\(/g)||[]).length,1);
 // The stage order lives in messageRouting.ts; none of these checks may be re-implemented inline.
 for(const forbidden of [/conv\.transferred\s*&&/,/credits\s*<=\s*0/,/account\.agent_enabled\s*===\s*false/,/if\s*\(\s*durable\s*===/]){
  assert.equal(forbidden.test(handler),false,"inline routing check: "+forbidden);
 }
 // The atomic claim dependencies and the exclusive-claim entry point are still the only senders.
 assert.equal((handler.match(/await processExclusiveEvent\(/g)||[]).length,1);
 assert.equal((handler.match(/await attemptDurableInstagram\(/g)||[]).length,1);
});
