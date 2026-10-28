import {test} from "node:test";
import assert from "node:assert/strict";
import {flowShadowMayObserve} from "../supabase/functions/milan-api/flowShadowGate.ts";

const tenant="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const account="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeReader(
 global={enabled:true},tenantFlag={enabled:true,test_only:true}
){
 const calls:string[]=[];
 return {
  calls,
  reader:{
   async readGlobal(){calls.push("global");return global;},
   async readTenant(id:string){calls.push("tenant:"+id);return tenantFlag;}
  }
 };
}
test("no env flag: no Supabase reads or extra side effects",async()=>{
 const r=makeReader();
 for(const value of [undefined,"","off","true","on","OBSERVE"]){
  assert.equal(await flowShadowMayObserve(value,tenant,account,r.reader),false);
 }
 assert.deepEqual(r.calls,[]);
});
test("global OFF requires no tenant read",async()=>{
 const r=makeReader({enabled:false});
 assert.equal(await flowShadowMayObserve("observe",tenant,account,r.reader),false);
 assert.deepEqual(r.calls,["global"]);
});
test("per-tenant OFF, absent row, or non-canary cannot enable observation",async()=>{
 for(const flag of [
   {enabled:false,test_only:true},{enabled:true,test_only:false}
 ]){
  const r=makeReader({enabled:true},flag);
  assert.equal(await flowShadowMayObserve("observe",tenant,account,r.reader),false);
 }
 const noRow=makeReader();
 const absent=await flowShadowMayObserve("observe",tenant,account,{
  ...noRow.reader,async readTenant(){return null;}
 });
 assert.equal(absent,false);
});
test("both server switches and test-only are required",async()=>{
 const r=makeReader();
 assert.equal(await flowShadowMayObserve("observe",tenant,account,r.reader),true);
 assert.deepEqual(r.calls,["global","tenant:"+tenant]);
});
test("missing or unverified server account/tenant never triggers database reads",async()=>{
 const r=makeReader();
 for(const [t,a] of [
   ["",account],[tenant,""],["not-a-uuid",account],[tenant,"bad"],
   [tenant,"  "+account],["another-tenant",account]
 ]){
  assert.equal(await flowShadowMayObserve("observe",t,a,r.reader),false);
 }
 assert.deepEqual(r.calls,[]);
});
test("database failure is observational only and cannot interrupt legacy AI",async()=>{
 for(const failure of ["global","tenant"]){
  const r=makeReader();
  const fail={
   async readGlobal(){
    if(failure==="global")throw Error("42P01: no relation");
    return {enabled:true};
   },
   async readTenant(){
    if(failure==="tenant")throw Error("network unavailable");
    return {enabled:true,test_only:true};
   }
  };
  assert.equal(await flowShadowMayObserve("observe",tenant,account,fail),false);
 }
});
test("whitespace and malformed IDs never grant a shadow mode",async()=>{
 const r=makeReader();
 for(const value of [" "+tenant,tenant+"\n",tenant.toUpperCase()+"\u0000"]){
  assert.equal(await flowShadowMayObserve("observe",value,account,r.reader),false);
 }
 assert.deepEqual(r.calls,[]);
});
