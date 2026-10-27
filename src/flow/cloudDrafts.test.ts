import {test} from "node:test";
import assert from "node:assert/strict";
import {exampleFlow} from "./model.ts";
import {CloudDraftError,CLOUD_DRAFT_MAX_BYTES,prepareCloudDocument,saveCloudDraft} from "./cloudDrafts.ts";

test("cloud proposal preserves v3 identifiers, connections and option payloads",()=>{
 const original=exampleFlow();
 const stored=prepareCloudDocument(original);
 assert.equal(stored.version,3);
 assert.equal(stored.nodes.length,original.nodes.length);
 assert.deepEqual(stored.nodes.map(n=>n.id),original.nodes.map(n=>n.id));
 assert.deepEqual(stored.edges.map(e=>[e.source,e.sourceHandle,e.target]),original.edges.map(e=>[e.source,e.sourceHandle,e.target]));
});
test("cloud proposal refuses unknown format rather than corrupting local drafts",()=>{
 assert.throws(()=>prepareCloudDocument({version:900,nodes:[],edges:[]}),
  (e:unknown)=>e instanceof CloudDraftError&&e.code==="invalid_document");
});
test("oversized embedded image is detected before attempting any network request",()=>{
 const doc=exampleFlow();
 doc.nodes[1].data.image="data:image/webp;base64,"+"x".repeat(CLOUD_DRAFT_MAX_BYTES+100);
 assert.throws(()=>prepareCloudDocument(doc),
  (e:unknown)=>e instanceof CloudDraftError&&e.code==="oversized");
});
test("invalid cloud key fails before Supabase is contacted",async()=>{
 await assert.rejects(()=>saveCloudDraft("",exampleFlow(),null),
  (e:unknown)=>e instanceof CloudDraftError&&e.code==="invalid_document");
});
