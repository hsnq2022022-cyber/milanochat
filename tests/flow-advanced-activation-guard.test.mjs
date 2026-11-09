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
test("facebook comment flows: server-owned flags, stored comment graph, DM gating unchanged",()=>{
 const p=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 // Both flags come from the Edge env only, fail-closed.
 assert.match(p,/commentAutomationEnabled:env\("FLOW_COMMENT_AUTOMATION_ENABLED"\)==="true",\n\s*multichannelEnabled:env\("FLOW_MULTICHANNEL_ENABLED"\)==="true"/);
 const start=p.indexOf('if(action==="activate"||action==="rollback")');
 const block=p.slice(start,p.indexOf('return error("Unknown action",400)'));
 assert.match(block,/if\(!canary&&!production&&!commentPlatformAuthorized\)\n\s*return error\("Publication activation is disabled",423\);/);
 // Comment branch needs the stored document's comment plan; no instagram hardcode.
 const cStart=block.indexOf("const commentGraph=");
 const comment=block.slice(cStart,block.indexOf("if(commentFlow){",cStart));
 assert.match(comment,/commentFlowPlan\(rawDocument,scope\.platform\)!==null/);
 assert.match(comment,/switches\.commentAutomationEnabled/);
 assert.match(comment,/commentGraph&&commentPlatformAuthorized&&/);
 assert.doesNotMatch(comment,/platform==="instagram"/);
 // Any non-comment flow: exactly the previous DM rule before the simple/durable path.
 const after=block.slice(block.indexOf("if(commentFlow){"));
 assert.ok(after.indexOf("if(!canary&&!production)\n    return error(\"Publication activation is disabled\",423);")<after.indexOf("if(!durable){"));
 assert.ok(after.includes("if(!canary&&!production)\n    return error(\"Publication activation is disabled\",423);"));
 // Accounts: canActivate keeps the DM rule; comments are a separate hint.
 assert.match(p,/canActivate:accountReady&&\n\s*productionActivationAuthorized\(a\.platform,globalSwitch\.data\?\.enabled,\n\s*tenantSwitch\.data\?\.enabled,tenantSwitch\.data\?\.production_approved\),/);
 assert.match(p,/canActivateComments:accountReady&&/);
});
