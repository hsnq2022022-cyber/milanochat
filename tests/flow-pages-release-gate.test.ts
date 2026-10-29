import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const workflow=readFileSync(".github/workflows/deploy.yml","utf8");

test("Pages publish verifies TypeScript and flow regressions before building",()=>{
 const install=workflow.indexOf("run: npm ci");
 const gate=workflow.indexOf("Verify flow TypeScript and regression tests before publishing");
 const build=workflow.indexOf("run: npm run build");
 const publish=workflow.indexOf("uses: actions/deploy-pages@v4");
 assert(install>0 && gate>install && build>gate && publish>build);
 assert.match(workflow,/npx tsc --noEmit -p tsconfig\.flows\.json/);
 assert.match(workflow,/npm run test:flows/);
 assert.match(workflow,/node --experimental-strip-types --test tests\/flow-manage-existing-publications\.test\.ts/);
 assert.doesNotMatch(workflow,/supabase functions deploy/);
});
