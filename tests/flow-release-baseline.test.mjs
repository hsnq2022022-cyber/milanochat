import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {assertReleaseSafe,assertReleaseRestored} from "../scripts/flow-release-baseline.mjs";

const baseline={
 tenants:10,accounts:4,conversations:4,widgetMessages:12,
 ledger:3,widgetLedger:0,delivery:0,outbox:0,flows:0,windows:0,claims:0,publications:0,
 historicalAnswers:5,globalOff:true,enabledTenant:0
};
test("existing safe production snapshot is allowed",()=>{
 assert.doesNotThrow(()=>assertReleaseSafe(baseline));
 assert.doesNotThrow(()=>assertReleaseRestored(baseline,{...baseline}));
});
test("legitimate growth never blocks a new safe dry-run",()=>{
 const grew={...baseline,tenants:142,accounts:75,conversations:9000,
  widgetMessages:100,ledger:560,widgetLedger:10,delivery:22,
  windows:17,claims:220,publications:18,historicalAnswers:29};
 assert.doesNotThrow(()=>assertReleaseSafe(grew));
 assert.doesNotThrow(()=>assertReleaseRestored(grew,{...grew}));
});
test("global or tenant enabled and active flow/outbox block preflight",()=>{
 for(const overrides of [{globalOff:false},{enabledTenant:1},
  {flows:1},{outbox:1}]){
  assert.throws(()=>assertReleaseSafe({...baseline,...overrides}));
 }
});
test("missing, negative, unsafe or nonnumeric counts fail closed",()=>{
 for(const value of [-1,NaN,Infinity,"10",1.5,Number.MAX_SAFE_INTEGER+1,null]){
  assert.throws(()=>assertReleaseSafe({...baseline,accounts:value}));
 }
 assert.throws(()=>assertReleaseSafe({...baseline,tenants:undefined}));
 assert.throws(()=>assertReleaseSafe({}));
 assert.throws(()=>assertReleaseSafe(null));
});
test("cleanup must restore every counter, including historical messages and ledger",()=>{
 for(const key of ["tenants","accounts","conversations","widgetMessages",
  "ledger","widgetLedger","delivery","windows","historicalAnswers","claims","publications"]){
  assert.throws(()=>assertReleaseRestored(baseline,{
   ...baseline,[key]:baseline[key]+1
  }),/Production counts changed/);
 }
});
test("after-cleanup state cannot secretly enable flows",()=>{
 assert.throws(()=>assertReleaseRestored(baseline,{
  ...baseline,globalOff:false
 }));
 assert.throws(()=>assertReleaseRestored(baseline,{
  ...baseline,enabledTenant:1
 }));
});

test("live smoke queries exactly one PostgreSQL count for every destructured snapshot field",()=>{
 // Static source contract: importing the production smoke would require secrets.
 // Check the real Promise.all instead of only testing assertReleaseSafe mocks.
 const source=readFileSync(new URL("../scripts/flow-protected-live-smoke.mjs",import.meta.url),"utf8");
 const match=source.match(/async function snapshot\(\)\{\s*const \[([^\]]+)\]=await Promise\.all\(\[([\s\S]*?)\]\);/);
 assert(match,"Unable to locate live snapshot Promise.all");
 const fields=match[1].split(",").map(x=>x.trim());
 const tables=[...match[2].matchAll(/count\("([^"]+)"/g)].map(x=>x[1]);
 assert.deepEqual(fields,[
  "tenants","accounts","conversations","widgetMessages","ledger","widgetLedger",
  "delivery","outbox","flows","windows","claims","publications"
 ]);
 assert.deepEqual(tables,[
  "tenants","channel_accounts","conversations","widget_messages","reply_ledger",
  "widget_reply_ledger","automation_delivery_attempts","automation_flow_outbox",
  "automation_flow_activations","flow_publication_rate_windows",
  "automation_message_claims","automation_flow_publications"
 ]);
});
