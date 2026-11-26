// Advanced (durable) Flow rollout: FLOW_DURABLE_CANARY_ACCOUNT_ID is one account id (unchanged) OR a strict
// comma-separated allowlist (_shared/durableAccounts.ts). Tenant-aware rollout = this allowlist AND the
// operator-only SQL registry AND the switches AND the per-feature flags, all failing closed.
// Behavioural gates + a source pin that no raw single-account comparison is left in any Edge Function.
// Run: node --experimental-strip-types --test tests/flow-durable-accounts.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,statSync} from "node:fs";
import {join} from "node:path";
import {parseDurableAccountAllowlist,durableAccountAllowed,DURABLE_ACCOUNT_ALLOWLIST_MAX}
 from "../supabase/functions/_shared/durableAccounts.ts";
import {canDispatchOutbox} from "../supabase/functions/flow-outbox-worker/productionGate.ts";
import {canWakeDurableRun,type WakeEligibility} from "../supabase/functions/flow-runtime-worker/eligibility.ts";
import {durableIngressConfigured} from "../supabase/functions/milan-api/flowDurableIngress.ts";

const A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222",C="33333333-3333-4333-8333-333333333333";

test("one account id behaves exactly like the old equality gate",()=>{
 assert.equal(durableAccountAllowed(A,A),true);
 assert.equal(durableAccountAllowed(A,B),false);
 assert.equal(durableAccountAllowed(" "+A+" ",A),true); // surrounding whitespace is trimmed
 const L="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
 assert.equal(durableAccountAllowed(L,L),true);
 assert.equal(durableAccountAllowed(L,L.toUpperCase()),false); // exact, case-sensitive
});
test("a comma-separated allowlist admits exactly its members",()=>{
 const raw=[A,B].join(", ");
 assert.equal(durableAccountAllowed(raw,A),true);
 assert.equal(durableAccountAllowed(raw,B),true);
 assert.equal(durableAccountAllowed(raw,C),false);
 assert.deepEqual([...parseDurableAccountAllowlist(raw)!],[A,B]);
});
test("fail closed: missing, empty or ANY malformed entry invalidates the whole list",()=>{
 for(const raw of [undefined,null,"",", ",A+",",","+A,A+",,"+B,A+" "+B,A+";"+B,"*",A+",*",A+",b a d",42,{},[A]]){
  assert.equal(parseDurableAccountAllowlist(raw),null,JSON.stringify(raw));
  assert.equal(durableAccountAllowed(raw,A),false,JSON.stringify(raw));
 }
});
test("the account id being checked must be a non-empty string",()=>{
 for(const id of [undefined,null,"",0,{},[A]])assert.equal(durableAccountAllowed(A,id),false);
});
test("the allowlist ceiling covers the first-100-customer rollout (200 real account ids) and stays fail-closed above it",()=>{
 assert.equal(DURABLE_ACCOUNT_ALLOWLIST_MAX,200);
 const uuid=(i:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12,"0")}`;
 const list=Array.from({length:200},(_,i)=>uuid(i)).join(",");
 assert.ok(list.length<8000,"fits comfortably in one secret value");
 assert.equal(parseDurableAccountAllowlist(list)?.size,200);
 assert.equal(durableAccountAllowed(list,uuid(199)),true);
 assert.equal(durableAccountAllowed(list,uuid(200)),false,"an account outside the list is never admitted");
 assert.equal(parseDurableAccountAllowlist(list+","+uuid(200)),null,"201 entries invalidate the whole list");
});
test("the allowlist is bounded",()=>{
 const ok=Array.from({length:DURABLE_ACCOUNT_ALLOWLIST_MAX},(_,i)=>"acct-"+i).join(",");
 const tooMany=ok+",acct-extra";
 assert.notEqual(parseDurableAccountAllowlist(ok),null);
 assert.equal(parseDurableAccountAllowlist(tooMany),null);
 assert.equal(durableAccountAllowed(tooMany,"acct-0"),false,"an oversized list admits nobody");
});

/* ───────── gates that consume it ───────── */
const outbox={
 globalEnabled:true,tenantEnabled:true,testOnly:false,productionApproved:true,platform:"instagram",
 accountId:A,canaryAccountId:[A,B].join(","),accountActive:true,agentEnabled:true,autoReply:true,
 tenantActive:true,credits:3,revisionActive:true,humanTakeover:false,registryRegistered:true,
} as const;
test("Outbox dispatch: every allowlisted account may send, nobody else, and all other gates still apply",()=>{
 assert.equal(canDispatchOutbox(outbox),true);
 assert.equal(canDispatchOutbox({...outbox,accountId:B}),true);
 assert.equal(canDispatchOutbox({...outbox,accountId:C}),false,"not in the list");
 assert.equal(canDispatchOutbox({...outbox,canaryAccountId:[A,"bad entry"].join(",")}),false,"malformed list");
 assert.equal(canDispatchOutbox({...outbox,canaryAccountId:undefined}),false,"unset secret");
 for(const [k,v] of [["productionApproved",false],["tenantEnabled",false],["globalEnabled",false],["humanTakeover",true],["credits",0],["revisionActive",false]] as const)
  assert.equal(canDispatchOutbox({...outbox,[k]:v}),false,"still gated by "+k);
});
const now=Date.parse("2026-11-24T10:00:00Z");
const wake:WakeEligibility={
 runPlatform:"instagram",runStatus:"sleeping",runRevision:4,tenantActive:true,tenantSwitchEnabled:true,
 tenantTestOnly:false,tenantProductionApproved:true,globalEnabled:true,accountId:B,canaryAccountId:[A,B].join(","),
 accountTenantMatches:true,accountActive:true,agentEnabled:true,autoReply:true,conversationTenantMatches:true,
 conversationAccountMatches:true,humanTransferred:false,humanAgentExpiresAt:null,humanPausedReason:null,
 activeRevision:4,revisionIsActive:true,registryRegistered:true,
};
test("scheduled wake: an allowlisted account's sleeping run wakes; others and malformed lists never",()=>{
 assert.equal(canWakeDurableRun(wake,now),true);
 assert.equal(canWakeDurableRun({...wake,accountId:C},now),false);
 assert.equal(canWakeDurableRun({...wake,canaryAccountId:"x,,y"},now),false);
 assert.equal(canWakeDurableRun({...wake,accountTenantMatches:false},now),false,"tenant/account binding still enforced");
 assert.equal(canWakeDurableRun({...wake,humanTransferred:true,humanPausedReason:"manual_takeover",humanAgentExpiresAt:"2026-11-24T11:00:00Z"},now),false);
});
function withEnv<T>(env:Record<string,string|undefined>,fn:()=>T):T{
 const g=globalThis as unknown as {Deno?:unknown};const prev=g.Deno;
 g.Deno={env:{get:(k:string)=>env[k]}};
 try{return fn();}finally{g.Deno=prev;}
}
test("ingress static gate: allowlisted accounts only, platform rule and master switch unchanged",()=>{
 const env={FLOW_DURABLE_INGRESS_ENABLED:"true",FLOW_DURABLE_CANARY_ACCOUNT_ID:[A,B].join(",")};
 withEnv(env,()=>{
  assert.equal(durableIngressConfigured(A,"instagram"),true);
  assert.equal(durableIngressConfigured(B,"instagram"),true);
  assert.equal(durableIngressConfigured(C,"instagram"),false);
  assert.equal(durableIngressConfigured(A,"facebook"),false,"multichannel flag OFF");
 });
 withEnv({...env,FLOW_MULTICHANNEL_ENABLED:"true"},()=>assert.equal(durableIngressConfigured(A,"facebook"),true));
 withEnv({...env,FLOW_DURABLE_INGRESS_ENABLED:"false"},()=>assert.equal(durableIngressConfigured(A,"instagram"),false,"master switch OFF = everyone OFF"));
 withEnv({...env,FLOW_DURABLE_CANARY_ACCOUNT_ID:undefined},()=>assert.equal(durableIngressConfigured(A,"instagram"),false));
 withEnv({...env,FLOW_DURABLE_CANARY_ACCOUNT_ID:A+",not valid"},()=>assert.equal(durableIngressConfigured(A,"instagram"),false,"typo disables the rollout, never half-applies it"));
 // single legacy value: exactly the old behaviour
 withEnv({...env,FLOW_DURABLE_CANARY_ACCOUNT_ID:A},()=>{
  assert.equal(durableIngressConfigured(A,"instagram"),true);
  assert.equal(durableIngressConfigured(B,"instagram"),false);
 });
});

/* ───────── no raw single-account comparison left anywhere ───────── */
function walk(dir:string,out:string[]=[]):string[]{
 for(const n of readdirSync(dir)){
  const p=join(dir,n);
  if(statSync(p).isDirectory())walk(p,out);else if(p.endsWith(".ts"))out.push(p);
 }
 return out;
}
test("source pin: every Edge Function use of the canary secret goes through durableAccountAllowed",()=>{
 const offenders:string[]=[];let guarded=0;
 for(const file of walk("supabase/functions")){
  const lines=readFileSync(file,"utf8").split("\n");
  lines.forEach((line,i)=>{
   if(!line.includes("FLOW_DURABLE_CANARY_ACCOUNT_ID"))return;
   const t=line.trim();
   if(t.startsWith("*")||t.startsWith("//")||t.startsWith("/*"))return; // documentation
   if(line.includes("durableAccountAllowed(")){guarded++;return;}
   if(/canaryAccountId\s*:\s*(Deno\.)?env(\.get)?\(["']FLOW_DURABLE_CANARY_ACCOUNT_ID["']\)/.test(line)){guarded++;return;} // handed to a guarded consumer
   // The WhatsApp inbound-button site is outside this rollout (single account, unchanged on purpose).
   if(file.endsWith("milan-api/index.ts")&&/account\.id\s*===\s*env\(/.test(line)&&
      lines.slice(Math.max(0,i-12),i+14).some(l=>l.includes("whatsapp_business_account")||l.includes("WhatsApp")))return;
   offenders.push(file+":"+(i+1)+": "+t);
  });
 }
 assert.deepEqual(offenders,[]);
 assert.ok(guarded>=12,"all known sites are guarded ("+guarded+")");
});
test("source pin: consumers import the shared helper (one implementation, no local copies)",()=>{
 for(const f of [
  "supabase/functions/milan-api/flowDurableIngress.ts","supabase/functions/milan-api/commentIngress.ts",
  "supabase/functions/milan-api/index.ts","supabase/functions/flow-publication/index.ts",
  "supabase/functions/flow-publication/activationGates.ts","supabase/functions/flow-outbox-worker/productionGate.ts",
  "supabase/functions/flow-runtime-worker/eligibility.ts","supabase/functions/flow-internal-worker/internalEffects.ts",
 ])assert.match(readFileSync(f,"utf8"),/from "\.\.\/_shared\/durableAccounts\.ts"/,f);
});
