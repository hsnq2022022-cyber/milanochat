import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleFlow, makeNode, importFlow } from "./model.ts";
import { prepareCloudDraft, decodeCloudDraftRows, MAX_CLOUD_DRAFTS, saveCloudDraft, fetchCloudDrafts, validCloudTimestamp } from "./cloudDraft.ts";

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
 assert.equal(Object.hasOwn(captured[1].data as object,"updated_at"),false); // Timestamp is server-owned.
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

test("cloud read rejects oversized payloads and malformed timestamps without modifying inputs",()=>{
 const valid=exampleFlow();
 const huge={...valid,nodes:valid.nodes.map((n,i)=>i===0?{...n,data:{...n.data,text:"a".repeat(4*1024*1024)}}:n)};
 const rows=[
  {flow_key:"valid",document:valid,draft_revision:1,updated_at:"2026-10-27T19:00:00Z"},
  {flow_key:"oversized",document:huge,draft_revision:1,updated_at:"2026-10-27T19:00:00Z"},
  {flow_key:"bad-date",document:valid,draft_revision:1,updated_at:"not-a-timestamp"}
 ];
 const before=rows[0].document;
 const result=decodeCloudDraftRows(rows);
 assert.deepEqual(result.drafts.map(d=>d.flow.id),["valid"]);
 assert.equal(result.skipped,2);
 assert.equal(rows[0].document,before);
});

test("strict cloud timestamps accept valid Postgres offsets, reject rolled dates and date-only strings",()=>{
 const ok=["2026-10-27T19:00:00Z","2026-10-27T19:00:00.123+00:00","2026-10-27T22:30:59-03:00"];
 const bad=["2026-10-27","2026","2026-02-31T12:00:00Z","2026-13-01T12:00:00Z",
  "2026-10-27 19:00:00+00:00","2026-10-27T25:00:00Z","2026-10-27T14:00:00+14:30",""];
 for(const v of ok)assert.equal(validCloudTimestamp(v),true,v);
 for(const v of bad)assert.equal(validCloudTimestamp(v),false,v);
});

test("blank identifiers and overflowing PostgreSQL integer revision are rejected before any network write",async()=>{
 const d=exampleFlow();
 assert.throws(()=>prepareCloudDraft({id:"   ",doc:d}),/identifier/);
 const fake={from:()=>{throw new Error("must not send request");}} as unknown as Parameters<typeof saveCloudDraft>[0];
 await assert.rejects(saveCloudDraft(fake,"tenant",{id:"valid",doc:d},2147483647),/invalid expected revision/);
});

test("cloud fetch checks 31st row and fails closed before silently truncating server drafts",async()=>{
 const d=exampleFlow();
 let count=0,limit=0;
 const fake={
  from:(table:string)=>{
   assert.equal(table,"automation_flow_drafts");
   const query={
    select:()=>query,
    eq:()=>query,
    order:()=>query,
    limit:(n:number)=>{
      limit=n;
      return Promise.resolve({data:Array.from({length:n},(_,i)=>({
        flow_key:"cloud-"+i,document:d,draft_revision:1,updated_at:"2026-10-27T14:00:00Z"
      })),error:null});
    }
   };
   count++;return query;
  }
 } as unknown as Parameters<typeof fetchCloudDrafts>[0];
 await assert.rejects(fetchCloudDrafts(fake,"tenant"),/exceeds supported limit/);
 assert.equal(limit,MAX_CLOUD_DRAFTS+1);
 assert.equal(count,1);
});

test("cloud decoder rejects all forms of malformed timestamp and blank flow key",()=>{
 const d=exampleFlow();
 const result=decodeCloudDraftRows([
  {flow_key:"good",document:d,draft_revision:1,updated_at:"2026-10-27T12:00:00+00:00"},
  {flow_key:"blank",document:d,draft_revision:1,updated_at:"2026-02-31T12:00:00Z"},
  {flow_key:"  ",document:d,draft_revision:1,updated_at:"2026-10-27T12:00:00Z"},
  {flow_key:"date-only",document:d,draft_revision:1,updated_at:"2026-10-27"}
 ]);
 assert.equal(result.drafts.length,1);
 assert.equal(result.skipped,3);
});

test("PGRST116 row cardinality error must not claim the draft table is unprovisioned",async()=>{
 const fake={
  from:()=>({
   insert:()=>({select:()=>({maybeSingle:async()=>({
    data:null,error:{code:"PGRST116"}
   })})})
  })
 } as unknown as Parameters<typeof saveCloudDraft>[0];
 const result=await saveCloudDraft(fake,"tenant",{id:"new",doc:exampleFlow()},null);
 assert.deepEqual(result,{status:"error",code:"PGRST116"});
});
