import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {importFlow} from "../src/flow/model.ts";
const api=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
const ui=readFileSync("src/flow/FlowPublicationPanel.tsx","utf8");
const editor=readFileSync("src/pages/FlowBuilder.tsx","utf8");

test("catalog and immutable read are behind authenticated tenant and account scoping",()=>{
 assert.match(api,/auth\.getUser\(rawBearer\.slice\(7\)\)/);
 assert.match(api,/\.eq\("user_id",auth\.user\.id\)\.maybeSingle\(\)/);
 const accountCheck=api.indexOf('const {data:account,error:accountError}');
 const catalog=api.indexOf('if(action==="catalog")');
 const read=api.indexOf('if(action==="read")');
 assert(accountCheck>0&&catalog>accountCheck&&read>catalog);
 const catalogBody=api.slice(catalog,read);
 assert.match(catalogBody,/\.eq\("tenant_id",scope\.tenantId\)\.eq\("channel_account_id",scope\.accountId\)/);
 assert.match(catalogBody,/\.eq\("platform",scope\.platform\)/);
 assert.match(catalogBody,/\.eq\("is_active",true\)/);
 assert.match(catalogBody,/\.limit\(500\)/);
 const readBody=api.slice(read,api.indexOf('if(action==="publish")'));
 assert.match(readBody,/Number\.isSafeInteger\(revision\)/);
 assert.match(readBody,/\.eq\("tenant_id",scope\.tenantId\)\.eq\("channel_account_id",scope\.accountId\)/);
 assert.match(readBody,/\.eq\("flow_key",flowKey\)/);
 assert.match(readBody,/\.eq\("revision",revision\)\.maybeSingle\(\)/);
});
test("existing live flow can be stopped even when it has a different local flow key",()=>{
 assert.match(ui,/setManagedFlowKey\(r\.active\.flow_key\)/);
 assert.match(ui,/call\(\{action,accountId,flowKey:managedFlowKey/);
 assert.match(ui,/\{activation\?\.is_active&&<button/);
 assert.match(ui,/const isEditingLocalFlow=managedFlowKey===flowKey/);
 assert.match(ui,/disabled=\{!accountId\|\|busy\|\|!isEditingLocalFlow\}/);
});
test("immutable revisions restore only as separate validated local copies",()=>{
 assert.match(ui,/onImportRevision\(r\.document\)/);
 assert.match(editor,/const parsed=importFlow\(raw\)/);
 assert.match(editor,/const newId=store\(\)\.createFlow\(parsed\.name,true\)/);
 assert.match(editor,/store\(\)\.replace\(parsed\)/);
 assert.match(editor,/if\(protectStoredLibrary\)/);
 const published=JSON.parse(readFileSync("examples/flow-instagram-two-choice-v3.json","utf8"));
 const parsed=importFlow(published);
 assert(parsed);
 assert.equal(parsed.version,3);
 assert.equal(parsed.nodes.length,4);
 assert.equal(parsed.edges.length,3);
 assert.equal(importFlow({version:3,nodes:[],edges:[]}),null);
});

test("active server publication is visible and account changes clear stale state",()=>{
 assert.match(ui,/data-testid="flow-active-server-status"/);
 assert.match(ui,/accountId&&activeServerFlow/);
 assert.match(ui,/activeServerFlow\.flow_key\+" · v"\+activeServerFlow\.revision/);
 assert.match(ui,/setCatalog\(\[\]\);setActiveServerFlow\(null\);setCatalogTruncated\(false\)/);
});
