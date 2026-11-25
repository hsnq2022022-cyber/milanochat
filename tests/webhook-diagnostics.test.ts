import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {invalidSignatureDiagnostics} from "../supabase/functions/milan-api/webhookDiagnostics.ts";

const SIG="sha256="+"ab".repeat(32);
const body={object:"instagram",entry:[
 {id:"17841400000000001",messaging:[
  {sender:{id:"90000000000001"},recipient:{id:"17841400000000001"},message:{mid:"mid-SECRET-1",text:"hello SECRET text"}},
  {sender:{id:"90000000000001"},read:{mid:"mid-SECRET-2"}},
 ]},
 {id:"17841400000000001",changes:[{field:"comments",value:{text:"SECRET comment"}},{field:"weird_field",value:{}}]},
 "junk",
]};

test("reports only fixed fields: counts and closed-set labels",()=>{
 const raw=JSON.stringify(body);
 const d=invalidSignatureDiagnostics(raw,body,SIG);
 assert.equal(d.object,"instagram");
 assert.equal(d.signature_header,"wellformed");
 assert.equal(d.entries,3);
 assert.equal(d.entry_with_messaging,1);
 assert.equal(d.entry_with_changes,1);
 assert.equal(d.entry_other,1);
 assert.deepEqual(d.events,{message:1,read:1});
 assert.deepEqual(d.change_fields,{comments:1,other:1});
 assert.equal(d.bytes,new TextEncoder().encode(raw).length);
});
test("never leaks the signature, ids, message ids or text",()=>{
 const out=JSON.stringify(invalidSignatureDiagnostics(JSON.stringify(body),body,SIG));
 for(const secret of [SIG,"abababab","17841400000000001","90000000000001","SECRET","mid-","hello","weird_field"])
  assert.ok(!out.includes(secret),"must not contain "+secret);
});
test("signature header is classified, never echoed",()=>{
 assert.equal(invalidSignatureDiagnostics("{}",{},"").signature_header,"absent");
 assert.equal(invalidSignatureDiagnostics("{}",{},null).signature_header,"absent");
 assert.equal(invalidSignatureDiagnostics("{}",{},undefined).signature_header,"absent");
 assert.equal(invalidSignatureDiagnostics("{}",{},"sha1=abc").signature_header,"malformed");
 assert.equal(invalidSignatureDiagnostics("{}",{},"sha256=zz").signature_header,"malformed");
});
test("total: garbage input never throws and unknown object maps to other",()=>{
 for(const b of [null,undefined,42,"x",[],{object:"evil\nobject"},{object:"page",entry:"x"},{entry:[null,1,{messaging:"x"}]}]){
  const d=invalidSignatureDiagnostics("{}",b,"x");
  assert.ok(["instagram","page","other"].includes(d.object));
 }
 assert.equal(invalidSignatureDiagnostics("{}",{object:"evil\nobject"},null).object,"other");
});
test("bounded: entries and scanned items are capped",()=>{
 const many={object:"instagram",entry:Array.from({length:500},()=>({messaging:Array.from({length:500},()=>({message:{}}))}))};
 const d=invalidSignatureDiagnostics("{}",many,null);
 assert.equal(d.entries,20);
 assert.ok(d.events.message<=50);
});
test("wiring: diagnostics run only in the ignored invalid-signature branch, before the unchanged log and 200",()=>{
 const ig=readFileSync(new URL("../supabase/functions/milan-api/index.ts",import.meta.url),"utf8");
 const diag=ig.indexOf("invalidSignatureDiagnostics(\n                raw,");
 const ignored=ig.indexOf('"[instagram_webhook] invalid signature — ignored"');
 const page401=ig.indexOf('return json({ error: "Invalid webhook signature" }, 401);');
 assert.ok(page401>0&&page401<diag&&diag<ignored,"after the page 401, before the ignored log");
 const ret=ig.indexOf("return json({\n            received: true,\n          });",ignored);
 assert.ok(ret>ignored,"ignored branch still answers 200 {received:true}");
 assert.ok(!ig.slice(diag,ret).includes(".from("),"no DB access between the diagnostics and the 200");
 assert.equal(ig.split("invalidSignatureDiagnostics(").length-1,1,"exactly one call site");
});
