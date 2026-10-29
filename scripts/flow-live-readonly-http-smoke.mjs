#!/usr/bin/env node
import assert from "node:assert/strict";

const base="https://nmhefwvhoholcjrbbila.supabase.co/functions/v1";
async function check(path,expected){
 const res=await fetch(base+path,{
  method:"GET",redirect:"manual",signal:AbortSignal.timeout(15000),
  headers:{"cache-control":"no-cache"}
 });
 const text=await res.text();
 assert.equal(res.status,expected, "Unexpected HTTP status from "+path);
 if(path.startsWith("/milan-api"))
  assert.equal(text,"Forbidden","Webhook verification must not accept a missing token");
 console.log("PASS: live "+path.split("?")[0]+" rejected unauthenticated GET with "+res.status);
}
await check("/milan-api?action=instagram_webhook",403);
// Gateway JWT enforcement rejects unauthenticated access before FlowPublication;
// depending on Supabase gateway version the explicit origin gate may yield 403.
const pub=await fetch(base+"/flow-publication",{
 method:"GET",redirect:"manual",signal:AbortSignal.timeout(15000),
 headers:{"cache-control":"no-cache"}
});
assert([401,403].includes(pub.status),"Publication endpoint should reject anonymous GET, received "+pub.status);
console.log("PASS: live flow-publication rejected anonymous GET with "+pub.status);

for(const fn of ["flow-runtime-worker","flow-outbox-worker"]){
 const resp=await fetch(base+"/"+fn,{
  method:"POST",redirect:"manual",signal:AbortSignal.timeout(15000),
  headers:{"content-type":"application/json"},
  body:JSON.stringify({mode:"tick"})
 });
 assert.equal(resp.status,401,fn+" must reject an anonymous tick");
 console.log("PASS: "+fn+" rejects anonymous tick with HTTP 401");
}
