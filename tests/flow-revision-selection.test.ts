/**
 * Explicit revision selection (src/flow/revisionSelection.ts + the real
 * flow-publication handler through the shared offline double): per-revision
 * status from the server readiness of EXACTLY that revision, no-selection /
 * stale / missing refusals (never the latest, never another flow), V3 <-> V4
 * replacement of the same flow_key, several flow keys per account, isolation.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {classifyRevision,selectionRefusal,activationConfirmText,listedRevisions,listedActive,
 STATUS_LABELS,REASON_LABELS,REFUSAL_TEXT} from "../src/flow/revisionSelection.ts";
import {buttonsDoc,delayDoc,v2Doc,malformedDoc,T,A,KEY,pub,act,server,activeOf}
 from "./flowPublicationDouble.ts";

type S=ReturnType<typeof server>;
/**
 * The client workflow of useFlowActivation.activateRevision / the panel, step
 * by step against the real handler: fresh list -> selectionRefusal ->
 * readiness(selected) -> classifyRevision -> confirm -> activate(selected).
 */
async function selectAndActivate(s:S,o:{accountId:string;flowKey:string;selected:number|null;
 loadedActive:number|null;token?:string;confirm?:(text:string)=>boolean}){
 const token=o.token??"jwt-a";
 if(typeof o.selected!=="number")return {refused:"no_selection"};
 const list=(await s.call({action:"list",accountId:o.accountId,flowKey:o.flowKey},token)).body;
 const refusal=selectionRefusal({selected:o.selected,freshRevisions:listedRevisions(list.items),
  freshActive:listedActive(list.activation),loadedActive:o.loadedActive});
 if(refusal)return {refused:refusal};
 const r=(await s.call({action:"readiness",accountId:o.accountId,flowKey:o.flowKey,revision:o.selected},token)).body;
 const row=classifyRevision({revision:o.selected,activeRevision:o.loadedActive,report:r.readiness,reportRevision:r.candidateRevision});
 if(!row.activatable)return {refused:row.status,reasons:row.reasons};
 const text=activationConfirmText(o.flowKey,o.loadedActive,o.selected);
 if(o.confirm&&!o.confirm(text))return {refused:"cancelled",text};
 const a=await s.call({action:"activate",accountId:o.accountId,flowKey:o.flowKey,revision:o.selected},token);
 return {status:a.status,text};
}
const state=(acts:any[])=>JSON.stringify(acts);
const v3v4=()=>server({pubs:[pub(T.a,A.a,KEY,2,v2Doc("WELCOME")),pub(T.a,A.a,KEY,3,buttonsDoc),pub(T.a,A.a,KEY,4,delayDoc),
 pub(T.a,A.a,KEY,5,malformedDoc)],acts:[act(T.a,A.a,KEY,4,false)]});
const activations=(s:S)=>s.log.filter(l=>l.rpc==="flow_activate_revision").map(l=>l.args);

test("explicit V3: exactly revision 3 is sent, scoped to tenant/account/platform/flow_key",async()=>{
 const s=v3v4();
 const r=await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:3,loadedActive:null});
 assert.equal(r.status,200);
 assert.deepEqual(activations(s).map(a=>({t:a.p_tenant_id,a:a.p_account_id,p:a.p_platform,k:a.p_flow_key,r:a.p_revision})),
  [{t:T.a,a:A.a,p:"instagram",k:KEY,r:3}]);
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@3"]);
 assert.match(r.text!,/v3/);assert.doesNotMatch(r.text!,/replaced/);
});

test("switch V3 -> V4 -> V3: the confirmation names both; the server shows only the new one active",async()=>{
 const s=v3v4();
 await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:3,loadedActive:null});
 const seen:string[]=[];
 const to4=await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:4,loadedActive:3,confirm:t=>{seen.push(t);return true;}});
 assert.equal(to4.status,200);
 assert.match(seen[0],/Revision v3 \(currently active\) of flow "ig_live_welcome_20261029" will be replaced by revision v4/);
 assert.match(seen[0],/الإصدار v3 \(النشط حاليًا\).*سيُستبدل بالإصدار v4/);
 // Reload from the server: 4 active, 3 not (one row per flow_key).
 const list=(await s.call({action:"list",accountId:A.a,flowKey:KEY})).body;
 assert.equal(listedActive(list.activation),4);
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@4"]);
 const back=await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:3,loadedActive:4,confirm:t=>{seen.push(t);return true;}});
 assert.equal(back.status,200);
 assert.match(seen[1],/Revision v4 \(currently active\).*will be replaced by revision v3/);
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@3"]);
 assert.deepEqual(activations(s).map(a=>a.p_revision),[3,4,3]);
 // Cancelled confirm: nothing sent.
 const n=activations(s).length;
 assert.equal((await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:4,loadedActive:3,confirm:()=>false})).refused,"cancelled");
 assert.equal(activations(s).length,n);
});

test("no selection, missing, stale and already-active selections are refused; never the latest",async()=>{
 const s=v3v4();
 const before=state(s.acts);
 assert.equal((await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:null,loadedActive:null})).refused,"no_selection");
 assert.equal((await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:9,loadedActive:null})).refused,"revision_missing");
 // Loaded while V3 was active, but the server now has nothing active: stale.
 assert.equal((await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:4,loadedActive:3})).refused,"active_changed");
 await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:4,loadedActive:null});
 const mid=state(s.acts);
 assert.equal((await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:4,loadedActive:4})).refused,"already_active");
 // Another session switched to V3 meanwhile: selection of 2 loaded with 4 active is stale.
 await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:3});
 assert.equal((await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:2,loadedActive:4})).refused,"active_changed");
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@3"]);
 assert.notEqual(before,mid);
 assert.ok(!activations(s).some(a=>a.p_revision===5||a.p_revision===9),"latest (5) / missing (9) never sent");
 // Pure guard details.
 for(const sel of [undefined,0,-1,1.5,NaN])
  assert.equal(selectionRefusal({selected:sel as any,freshRevisions:[1],freshActive:null,loadedActive:null}),"no_selection");
 assert.equal(selectionRefusal({selected:1,freshRevisions:[2,1],freshActive:null,loadedActive:null}),null);
});

test("unsupported revision: reason shown, no activation call; V2 revision is a candidate",async()=>{
 const s=v3v4();
 const r=await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:5,loadedActive:null});
 assert.deepEqual(r,{refused:"unsupported",reasons:["not_durable"]});
 assert.equal(activations(s).length,0);
 assert.ok(REASON_LABELS.not_durable.en.length>0&&REASON_LABELS.not_durable.ar.length>0);
 const rd=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:2})).body;
 assert.equal(classifyRevision({revision:2,activeRevision:null,report:rd.readiness,reportRevision:2}).status,"candidate");
 const r4=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:4},"jwt-a",{})).body; // flags off
 const row=classifyRevision({revision:4,activeRevision:null,report:r4.readiness,reportRevision:4});
 assert.equal(row.status,"blocked");assert.ok(row.reasons.includes("canary")&&row.reasons.includes("scheduler"));
 assert.equal((await selectAndActivate(s,{accountId:A.a,flowKey:"x_flow",selected:1,loadedActive:null})).refused,"revision_missing");
});

test("classifyRevision: statuses, report for another revision ignored, comment reason, labels",()=>{
 const ok={checks:{a:true},candidateKind:"buttons",needsButtons:true,needsScheduler:false,configured:true,
  candidate:{flowKey:"k",source:"requested",found:true,revision:3,activeRevision:null,engine:"durable",reasons:{activeRevision:"no_active_revision",supportedCandidate:null}}};
 assert.equal(classifyRevision({revision:3,activeRevision:3,report:ok,reportRevision:3}).status,"active");
 assert.equal(classifyRevision({revision:3,activeRevision:null}).status,"unchecked");
 assert.equal(classifyRevision({revision:3,activeRevision:null,report:ok,reportRevision:4}).status,"unchecked");
 assert.equal(classifyRevision({revision:3,activeRevision:null,report:ok,reportRevision:3}).status,"candidate");
 const comment={...ok,candidateKind:"unsupported",candidate:{...ok.candidate,engine:null,reasons:{activeRevision:null,supportedCandidate:"unsupported_comment_flow"}}};
 assert.deepEqual(classifyRevision({revision:3,activeRevision:null,report:comment,reportRevision:3}).reasons,["unsupported_comment_flow"]);
 const missing={...ok,candidate:{...ok.candidate,found:false}};
 assert.equal(classifyRevision({revision:3,activeRevision:null,report:missing,reportRevision:3}).status,"missing");
 for(const k of ["active","candidate","unchecked","unsupported","blocked","missing","draft","stale"] as const)
  assert.ok(STATUS_LABELS[k].ar&&STATUS_LABELS[k].en,k);
 for(const k of Object.keys(REFUSAL_TEXT) as Array<keyof typeof REFUSAL_TEXT>)
  assert.match(REFUSAL_TEXT[k].en,/Nothing was changed/);
 assert.deepEqual(listedRevisions([{revision:4},{revision:"3"},null,{revision:2}]),[4,2]);
 assert.equal(listedActive({revision:4,is_active:false}),null);
});

test("several flow keys on one account: activating/deactivating flow B never touches flow A",async()=>{
 const s=server({pubs:[pub(T.a,A.a,"flow_a",1,v2Doc("A")),pub(T.a,A.a,"flow_b",1,buttonsDoc),pub(T.a,A.a,"flow_b",2,delayDoc)]});
 await selectAndActivate(s,{accountId:A.a,flowKey:"flow_a",selected:1,loadedActive:null});
 const a=JSON.stringify(s.acts.filter(x=>x.flow_key==="flow_a"));
 assert.equal((await selectAndActivate(s,{accountId:A.a,flowKey:"flow_b",selected:2,loadedActive:null})).status,200);
 assert.equal((await selectAndActivate(s,{accountId:A.a,flowKey:"flow_b",selected:1,loadedActive:2})).status,200);
 assert.equal(JSON.stringify(s.acts.filter(x=>x.flow_key==="flow_a")),a);
 assert.equal((await s.call({action:"deactivate",accountId:A.a,flowKey:"flow_b"})).status,200);
 assert.equal(JSON.stringify(s.acts.filter(x=>x.flow_key==="flow_a")),a,"deactivation is per flow key");
 assert.deepEqual(activeOf(s.acts,T.a,A.a),["flow_a@1"]);
 for(const d of s.log.filter(l=>l.rpc==="flow_deactivate_revision"))assert.equal(d.args.p_flow_key,"flow_b");
});

test("two tenants / accounts with the same flow key and revisions never cross",async()=>{
 const s=server({pubs:[pub(T.a,A.a,KEY,3,buttonsDoc),pub(T.a,A.a,KEY,4,delayDoc),pub(T.a,A.a2,KEY,3,v2Doc("A2")),
  pub(T.b,A.b,KEY,3,buttonsDoc),pub(T.b,A.b,KEY,4,delayDoc)],acts:[act(T.b,A.b,KEY,3,true)]});
 // Lists are per scope: A sees no activation although B has v3 active.
 const la=(await s.call({action:"list",accountId:A.a,flowKey:KEY})).body;
 assert.equal(listedActive(la.activation),null);assert.deepEqual(listedRevisions(la.items),[4,3]);
 const lb=(await s.call({action:"list",accountId:A.b,flowKey:KEY},"jwt-b")).body;
 assert.equal(listedActive(lb.activation),3);
 assert.equal((await selectAndActivate(s,{accountId:A.a,flowKey:KEY,selected:4,loadedActive:null})).status,200);
 assert.deepEqual(activeOf(s.acts,T.b,A.b),[KEY+"@3"]);assert.deepEqual(activeOf(s.acts,T.a,A.a2),[]);
 // Cross-tenant: B's session cannot list/select/activate A's account.
 assert.equal((await s.call({action:"list",accountId:A.a,flowKey:KEY},"jwt-b")).status,403);
 const before=state(s.acts);
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:3,tenantId:T.a},"jwt-b")).status,403);
 assert.equal(state(s.acts),before);
 for(const a of activations(s))assert.ok(a.p_tenant_id===T.a&&a.p_account_id===A.a);
 // Every publications/activations read carries tenant+account+platform+flow_key.
 for(const l of s.log.filter(l=>l.table==="automation_flow_publications"||l.table==="automation_flow_activations")){
  if(!("flow_key" in (l.filters??{})))continue; // catalog (account-wide) reads
  for(const k of ["tenant_id","channel_account_id","platform","flow_key"])assert.ok(k in l.filters!,l.table+" "+k);
 }
});

test("list action: additive truncated flag, platform-scoped (server source)",async()=>{
 const src=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const body=src.slice(src.indexOf('if(action==="list")'),src.indexOf('if(action==="deactivate")'));
 assert.match(body,/\.eq\("channel_account_id",scope\.accountId\)\.eq\("platform",scope\.platform\)\n\s+\.eq\("flow_key",flowKey\)\.order\("revision",\{ascending:false\}\)\.limit\(100\)/);
 assert.match(body,/truncated:\(pubs\.data\?\?\[\]\)\.length===100\}\);/);
 assert.doesNotMatch(body,/\.insert\(|\.update\(|\.delete\(|rpc\(/);
 const s=server({pubs:Array.from({length:3},(_,i)=>pub(T.a,A.a,KEY,i+1,v2Doc("x")))});
 const r=(await s.call({action:"list",accountId:A.a,flowKey:KEY})).body;
 assert.equal(r.truncated,false);assert.deepEqual(listedRevisions(r.items),[3,2,1]);
});

test("UI wiring: editor selector + exact activateRevision, panel statuses/draft/stale guard",()=>{
 const hook=readFileSync("src/flow/useFlowActivation.ts","utf8");
 const fn=hook.slice(hook.indexOf("const activateRevision=useCallback"),hook.indexOf("return {state,toggle,updateToLatest,activateRevision};"));
 assert.match(fn,/if\(typeof selected!=="number"\)return refuse\("no_selection"\);/);
 assert.match(fn,/invokeService\(\{action:"list",accountId:acc\.id,flowKey:key\}\)/);
 assert.match(fn,/readinessGuard\(acc\.id,key,selected,loaded\)/);
 assert.match(fn,/window\.confirm\(activationConfirmText\(key,loaded,selected\)\)/);
 assert.match(fn,/invokeService\(\{action:"activate",accountId:acc\.id,flowKey:key,revision:selected\}\)/);
 assert.match(fn,/await load\(\);/);
 assert.doesNotMatch(fn,/latestRevision/,"never the latest");
 const ui=readFileSync("src/pages/FlowBuilder.tsx","utf8");
 assert.match(ui,/data-testid="flow-revision-select"/);
 assert.match(ui,/void activateRevision\(selectedRevision\)/);
 assert.match(ui,/useEffect\(\(\)=>\{setSelectedRevision\(null\);\},\[activation\.serverKey\]\);/);
 const panel=readFileSync("src/flow/FlowPublicationPanel.tsx","utf8");
 assert.match(panel,/data-testid="revision-draft"/);
 assert.match(panel,/data-testid=\{"revision-status-"\+v\.revision\}/);
 assert.match(panel,/const fresh=await call\(\{action:"list",accountId,flowKey:managedFlowKey\}\);/);
 assert.match(panel,/activationConfirmText\(managedFlowKey,loadedActive,revision!\)/);
});
