import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleFlow, makeNode, importFlow } from "./model.ts";
import { prepareCloudDraft, decodeCloudDraftRows, MAX_CLOUD_DRAFTS, saveCloudDraft } from "./cloudDraft.ts";

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
 assert.equal(JSON.stringify(restored.drafts[0].flow.doc),JSON.stringify(importFlow(prepared.document))); // Existing importer fills optional display defaults only.
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

test("cloud adapter creates drafts and updates only with optimistic revision predicate",async()=>{
 const captured:{action:string;data:unknown;filters:Record<string,unknown>}[]=[];
 const fake={
  from:(table:string)=>{
   assert.equal(table,"automation_flow_drafts");
   return {
    insert:(data:unknown)=>{
     captured.push({action:"insert",data,filters:{}});
     return {select:()=>({maybeSingle:async()=>({data:{draft_revision:1},error:null})})};
    },
    update:(data:unknown)=>{
     const call={action:"update",data,filters:{} as Record<string,unknown>};
     captured.push(call);
     const chain={
      eq:(key:string,value:unknown)=>{call.filters[key]=value;return chain;},
      select:()=>({maybeSingle:async()=>({data:{draft_revision:4},error:null})})
     };
     return chain;
    }
   };
  }
 } as unknown as Parameters<typeof saveCloudDraft>[0];
 const flow={id:"default",doc:exampleFlow(),enabled:true};
 const created=await saveCloudDraft(fake,"11111111-1111-1111-1111-111111111111",flow,null);
 const updated=await saveCloudDraft(fake,"11111111-1111-1111-1111-111111111111",flow,3);
 assert.deepEqual(created,{status:"saved",revision:1});
 assert.deepEqual(updated,{status:"saved",revision:4});
 assert.equal(captured[0].action,"insert");
 assert.equal((captured[0].data as {draft_revision?:number}).draft_revision,undefined);
 assert.deepEqual(captured[1].filters,{
  tenant_id:"11111111-1111-1111-1111-111111111111",flow_key:"default",draft_revision:3
 });
 assert.equal((captured[1].data as {draft_revision:number}).draft_revision,4);
});

test("cloud adapter reports a revision conflict rather than replacing newer server document",async()=>{
 const fake={
  from:()=>({
   update:()=>{
    const chain={
     eq:()=>chain,
     select:()=>({maybeSingle:async()=>({data:null,error:null})})
    };
    return chain;
   }
  })
 } as unknown as Parameters<typeof saveCloudDraft>[0];
 const result=await saveCloudDraft(fake,"tenant",{id:"default",doc:exampleFlow()},5);
 assert.deepEqual(result,{status:"conflict"});
});
