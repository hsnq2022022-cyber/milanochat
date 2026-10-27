import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleFlow, makeNode } from "./model.ts";
import { prepareCloudDraft, decodeCloudDraftRows, MAX_CLOUD_DRAFTS } from "./cloudDraft.ts";

test("stage 7 cloud preparation roundtrips all content without changing original or activation",()=>{
 const doc=exampleFlow(),before=JSON.stringify(doc);
 const richer=makeNode("message",{x:600,y:1400},{
  title:"صور ومحتويات",text:"تجربة العميل",
  image:"https://example.com/legacy.jpg",
  contentBlocks:[
   {id:"img",type:"image",url:"https://example.com/new.png"},
   {id:"collect",type:"collection",field:"email",inputMode:"email",text:"بريدك"}
  ],
  options:[{id:"yes",label:"نعم",action:"step",buttonType:"quick_reply"}]
 });
 doc.nodes.push(richer);
 const flow={id:"flow-test",doc,enabled:true},snapshot=JSON.stringify(doc);
 const prepared=prepareCloudDraft(flow);
 assert.equal(prepared.flow_key,"flow-test");
 assert.equal(JSON.stringify(doc),snapshot);
 assert.deepEqual(prepared.document,JSON.parse(snapshot));
 const restored=decodeCloudDraftRows([{
  flow_key:"flow-test",name:doc.name,document:prepared.document,draft_revision:5,
  updated_at:"2026-10-27T14:00:00Z"
 }]);
 assert.equal(restored.skipped,0);
 assert.equal(restored.drafts.length,1);
 assert.equal(restored.drafts[0].revision,5);
 assert.equal(restored.drafts[0].flow.enabled,false); // No published or live activation.
 assert.equal(JSON.stringify(restored.drafts[0].flow.doc),snapshot);
 assert.notEqual(before,snapshot);
});

test("cloud read does not replace or discard local library when rows are invalid",()=>{
 const flow=exampleFlow();
 const rows=[
  {flow_key:"safe",document:flow,draft_revision:2,updated_at:"2026-10-27T14:00:00Z"},
  {flow_key:"safe",document:flow,draft_revision:3,updated_at:"2026-10-27T14:01:00Z"},
  {flow_key:"bad",document:{version:7},draft_revision:1,updated_at:"2026-10-27T14:00:00Z"},
  {flow_key:"oops",document:flow,draft_revision:-1,updated_at:"2026-10-27T14:00:00Z"}
 ];
 const orig=JSON.stringify(rows);
 const result=decodeCloudDraftRows(rows);
 assert.deepEqual(result.drafts.map(x=>x.flow.id),["safe"]);
 assert.equal(result.skipped,3);
 assert.equal(JSON.stringify(rows),orig);
});

test("cloud preparation rejects invalid keys and oversized documents",()=>{
 const doc=exampleFlow();
 assert.throws(()=>prepareCloudDraft({id:"",doc}),/identifier/);
 assert.throws(()=>prepareCloudDraft({id:"x".repeat(129),doc}),/identifier/);
 assert.throws(()=>prepareCloudDraft({id:"one",doc:{...doc,name:""}}),/name/);
 assert.throws(()=>prepareCloudDraft({id:"large",doc:{...doc,name:"oversized",nodes:[
  {...doc.nodes[0],data:{...doc.nodes[0].data,text:"x".repeat(4*1024*1024)}}
 ]}}),/4 MiB/);
});

test("maximum cloud decode is bounded and rejects unexpected extras",()=>{
 const doc=exampleFlow();
 const rows=Array.from({length:MAX_CLOUD_DRAFTS+3},(_,i)=>({
  flow_key:"flow-"+i,document:doc,draft_revision:1,updated_at:"2026-10-27T14:00:00Z"
 }));
 const result=decodeCloudDraftRows(rows);
 assert.equal(result.drafts.length,MAX_CLOUD_DRAFTS);
 assert.equal(result.skipped,3);
});
