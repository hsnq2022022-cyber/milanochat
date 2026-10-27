import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleFlow, makeNode } from "./model.ts";
import { decodeCloudDraftRows, MAX_CLOUD_DRAFTS } from "./cloudDraft.ts";
import { previewCloudRecovery, prepareSelectedCloudRecovery, prepareIndependentCloudCopy } from "./cloudRecovery.ts";
import type { FlowLibrary } from "./library.ts";

const doc=()=>exampleFlow();
const row=(flow_key:string,document=doc())=>({
 flow_key, document, draft_revision:1, updated_at:"2026-10-27T12:00:00.000+00:00"
});
const local=():FlowLibrary=>({
 activeFlowId:"local",
 flows:[{id:"local",doc:doc(),enabled:true}]
});

test("cloud recovery identifies new and conflicting IDs without mutating any local or cloud data",()=>{
 const mine=local();
 const other=doc();other.nodes.push(makeNode("message",{x:50,y:50},{text:"different"}));
 const remote=decodeCloudDraftRows([row("local",other),row("new-one")]);
 const before=JSON.stringify({mine,remote});
 const preview=previewCloudRecovery(mine,remote);
 assert.deepEqual(preview.entries.map(x=>[x.id,x.decision]),[
  ["local","conflict"],["new-one","new"]
 ]);
 assert.equal(preview.safeToSelect,true);
 assert.equal(JSON.stringify({mine,remote}),before);
});

test("explicit import only adds chosen new drafts, preserves active and enabled local flows",()=>{
 const mine=local(),remote=decodeCloudDraftRows([row("new-one"),row("new-two")]);
 const result=prepareSelectedCloudRecovery(mine,remote,["new-two"]);
 assert.equal(result.status,"ready");
 if(result.status!=="ready")return;
 assert.equal(result.library.activeFlowId,"local");
 assert.equal(result.library.flows.length,2);
 assert.equal(result.library.flows[0].enabled,true);
 assert.equal(result.library.flows[1].enabled,false);
 assert.deepEqual(result.importedIds,["new-two"]);
 assert.deepEqual(mine.flows.map(x=>x.id),["local"]);
 assert.equal(remote.drafts[1].flow.enabled,false);
 assert.notEqual(result.library.flows[1].doc,remote.drafts[1].flow.doc);
 result.library.flows[1].doc.name="modified candidate";
 assert.notEqual(remote.drafts[1].flow.doc.name,"modified candidate");
});

test("conflicts, duplicate and unknown selections block whole import, never partially apply",()=>{
 const mine=local(),changed=doc();changed.name="different local";
 const remote=decodeCloudDraftRows([row("new-one"),row("local",changed)]);
 assert.deepEqual(prepareSelectedCloudRecovery(mine,remote,["new-one","local"]),
  {status:"blocked",reason:"local_conflict"});
 assert.deepEqual(prepareSelectedCloudRecovery(mine,remote,["not-on-server"]),
  {status:"blocked",reason:"unknown_selection"});
 assert.deepEqual(prepareSelectedCloudRecovery(mine,remote,["new-one","new-one"]),
  {status:"blocked",reason:"unknown_selection"});
 assert.equal(mine.flows.length,1);
});

test("fail closed when any server row is malformed, even if other rows are valid",()=>{
 const mine=local(),remote=decodeCloudDraftRows([
  row("good"),{...row("bad"),draft_revision:-42}
 ]);
 assert.equal(remote.skipped,1);
 assert.equal(previewCloudRecovery(mine,remote).safeToSelect,false);
 assert.deepEqual(prepareSelectedCloudRecovery(mine,remote,["good"]),
  {status:"blocked",reason:"invalid_cloud_rows"});
});

test("maximum library capacity blocks new recovery without deleting local records",()=>{
 const mine=local();
 for(let i=1;i<MAX_CLOUD_DRAFTS;i++)mine.flows.push({id:"local-"+i,doc:doc(),enabled:false});
 const cloud=decodeCloudDraftRows([row("cloud-new")]);
 assert.equal(previewCloudRecovery(mine,cloud).entries[0].decision,"capacity_exceeded");
 assert.deepEqual(prepareSelectedCloudRecovery(mine,cloud,["cloud-new"]),
  {status:"blocked",reason:"capacity_exceeded"});
 assert.equal(mine.flows.length,MAX_CLOUD_DRAFTS);
});

test("identical cloud and local IDs do not replace existing, even when activation differs",()=>{
 const mine=local(),remote=decodeCloudDraftRows([row("local",mine.flows[0].doc)]);
 assert.equal(previewCloudRecovery(mine,remote).entries[0].decision,"already_local");
 assert.deepEqual(prepareSelectedCloudRecovery(mine,remote,["local"]),
  {status:"blocked",reason:"local_conflict"});
 assert.equal(mine.flows[0].enabled,true);
});

test("selecting nothing yields independent in-memory candidate with no local changes",()=>{
 const mine=local(),remote=decodeCloudDraftRows([row("new-one")]);
 const result=prepareSelectedCloudRecovery(mine,remote,[]);
 assert.equal(result.status,"ready");
 if(result.status==="ready"){
  assert.equal(result.library.flows.length,1);
  assert.equal(result.library.activeFlowId,mine.activeFlowId);
 }
});

test("with one remaining slot, selecting second remote item works while selecting two is rejected",()=>{
 const mine=local();
 for(let i=1;i<MAX_CLOUD_DRAFTS-1;i++)mine.flows.push({id:"local-"+i,doc:doc()});
 const cloud=decodeCloudDraftRows([row("cloud-a"),row("cloud-b")]);
 const preview=previewCloudRecovery(mine,cloud);
 assert.deepEqual(preview.entries.map(e=>e.decision),["new","new"]);
 const secondOnly=prepareSelectedCloudRecovery(mine,cloud,["cloud-b"]);
 assert.equal(secondOnly.status,"ready");
 if(secondOnly.status==="ready")assert.deepEqual(secondOnly.importedIds,["cloud-b"]);
 assert.deepEqual(prepareSelectedCloudRecovery(mine,cloud,["cloud-a","cloud-b"]),
   {status:"blocked",reason:"capacity_exceeded"});
 assert.equal(mine.flows.length,MAX_CLOUD_DRAFTS-1);
});

test("preview identifies local-only flows and staged cloud copy never overwrites collision",()=>{
 const mine=local(),changed=doc();
 changed.name="Cloud variant";
 const remote=decodeCloudDraftRows([row("local",changed)]);
 const preview=previewCloudRecovery(mine,remote);
 assert.deepEqual(preview.localOnlyIds,[]);
 assert.equal(preview.entries[0].decision,"conflict");
 const before=JSON.stringify({mine,remote});
 const staged=prepareIndependentCloudCopy(mine,remote.drafts[0],"restored-local-01");
 assert.equal(staged.status,"ready");
 if(staged.status==="ready"){
  assert.deepEqual(staged.library.flows.map(x=>x.id),["local","restored-local-01"]);
  assert.equal(staged.library.flows[0].enabled,true);
  assert.equal(staged.library.flows[1].enabled,false);
  assert.equal(staged.library.activeFlowId,"local");
  assert.equal(staged.library.flows[1].doc.name,"Cloud variant");
 }
 assert.equal(JSON.stringify({mine,remote}),before);
});

test("copy staging refuses collisions, malformed IDs and exhausted capacity",()=>{
 const mine=local(),remote=decodeCloudDraftRows([row("cloud-copy")]).drafts[0];
 for(const [id,reason] of [
  ["local","already_exists"],
  ["bad name!","invalid_copy_id"],
  ["","invalid_copy_id"]
 ] as const){
  assert.deepEqual(prepareIndependentCloudCopy(mine,remote,id),{status:"blocked",reason});
 }
 for(let i=1;i<MAX_CLOUD_DRAFTS;i++)mine.flows.push({id:"existing-"+i,doc:doc()});
 assert.deepEqual(prepareIndependentCloudCopy(mine,remote,"available-id"),
  {status:"blocked",reason:"capacity_exceeded"});
});

test("preview explicitly lists browser-only flows",()=>{
 const mine=local(),remote=decodeCloudDraftRows([row("cloud-only")]);
 assert.deepEqual(previewCloudRecovery(mine,remote).localOnlyIds,["local"]);
});
