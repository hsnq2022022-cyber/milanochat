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
