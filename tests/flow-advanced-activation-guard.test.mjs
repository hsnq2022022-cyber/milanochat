import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
test("published advanced buttons and delays require separate, exact-account, real sender release",()=>{
 const p=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 assert.match(p,/env\("FLOW_DURABLE_ACTIVATION_READY"\)==="true"/);
 assert.match(p,/env\("FLOW_DURABLE_INGRESS_ENABLED"\)==="true"/);
 assert.match(p,/env\("FLOW_DURABLE_CANARY_ACCOUNT_ID"\)===scope\.accountId/);
 assert.match(p,/const rawDocument:unknown=publication\.document/);
 assert.match(p,/supportedDurableDocument\(rawDocument\)/);
 assert.match(p,/if\(!durable\)\{/);
 assert.match(p,/simpleMessageFromDocument\(publication\.document,scope\.platform\)===null/);
 assert.match(p,/production&&scope\.platform==="instagram"/);
});
test("activation guard derives the buttons/scheduler requirement from the same durable whitelist",()=>{
 const p=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const start=p.indexOf("const rawDocument:unknown=publication.document");
 const guard=p.slice(start,p.indexOf("if(!durable){",start));
 assert.match(guard,/const needs=durableGraph\?durableRuntimeNeeds\(rawDocument\):\{buttons:true,scheduler:true\};/);
 assert.match(guard,/\(!needs\.buttons\|\|env\("FLOW_RICH_BUTTONS_ENABLED"\)==="true"\)&&/);
 assert.match(guard,/\(!needs\.scheduler\|\|env\("FLOW_DURABLE_SCHEDULER_ENABLED"\)==="true"\);/);
 assert.doesNotMatch(guard,/n\.data\.kind==="question"/,"no shape-specific shortcut");
});
