import {test} from "node:test";
import assert from "node:assert/strict";
import {StagingFlowPublisher} from "./stagingPublisher.ts";
import type {PublisherAuth,PublicationStore,ServerAccount,PublishedRevision,Activation} from "./stagingPublisher.ts";
import {makeNode,edgeFor} from "./model.ts";
import type {FlowDocument} from "./model.ts";
import type {FlowCapability} from "./publicationGate.ts";

function doc():FlowDocument{
 const a=makeNode("trigger",{x:0,y:0},{triggerMode:"message",platform:"instagram"});
 const b=makeNode("message",{x:0,y:240},{text:"Welcome",options:[]});
 return {version:3,name:"Welcome",nodes:[a,b],edges:[
  edgeFor({source:a.id,sourceHandle:"next",target:b.id,targetHandle:"in"})
 ]};
}
const capabilities=new Set<FlowCapability>([
 "execution-engine","instagram","trigger:message","message:text"
]);
const key=(...parts:string[])=>parts.join("::");
class FakeStore implements PublicationStore{
 revisions:PublishedRevision[]=[];
 activations=new Map<string,Activation>();
 enabledForCanary=false;
 accounts:ServerAccount[]=[
  {id:"account-A",tenantId:"tenant-A",enabled:true,capabilities:new Set(capabilities)},
  {id:"account-B",tenantId:"tenant-B",enabled:true,capabilities:new Set(capabilities)}
 ];
 async account(tenantId:string,accountId:string){
  return this.accounts.find(a=>a.tenantId===tenantId&&a.id===accountId)??null;
 }
 async appendImmutable(input:{
  tenantId:string;accountId:string;flowKey:string;actorId:string;document:FlowDocument
 }):Promise<PublishedRevision>{
  const current=this.revisions.filter(r=>r.tenantId===input.tenantId&&r.flowKey===input.flowKey);
  const rev={tenantId:input.tenantId,accountId:input.accountId,flowKey:input.flowKey,
    revision:current.length+1,document:structuredClone(input.document)};
  this.revisions.push(rev);
  return structuredClone(rev);
 }
 async publication(t:string,k:string,revision:number){
  const x=this.revisions.find(r=>r.tenantId===t&&r.flowKey===k&&r.revision===revision);
  return x?structuredClone(x):null;
 }
 async activation(t:string,a:string,k:string){
  const x=this.activations.get(key(t,a,k));return x?{...x}:null;
 }
 async setActivation(value:Activation){
  this.activations.set(key(value.tenantId,value.accountId,value.flowKey),{...value});
  return {...value};
 }
 async canActivateTestAccount(t:string,a:string){
  return this.enabledForCanary&&t==="tenant-A"&&a==="account-A";
 }
}
function setup(){
 const store=new FakeStore();
 const auth:PublisherAuth={identify:async bearer=>{
  if(bearer==="session-A")return {userId:"owner-A",tenantId:"tenant-A"};
  if(bearer==="session-B")return {userId:"owner-B",tenantId:"tenant-B"};
  return null;
 }};
 return {store,service:new StagingFlowPublisher(auth,store)};
}
test("a real verified tenant can publish immutable v3 revisions with server-derived capabilities",async()=>{
 const {store,service}=setup();
 const source=doc(),original=JSON.stringify(source);
 const first=await service.publish("session-A","account-A","welcome",source);
 assert.equal(first.ok,true);
 if(!first.ok)throw Error("publish failed");
 assert.equal(first.value.revision,1);
 source.nodes[1].data.text="Changed";
 const second=await service.publish("session-A","account-A","welcome",source);
 assert.equal(second.ok,true);
 if(!second.ok)throw Error("second failed");
 assert.equal(second.value.revision,2);
 assert.equal(store.revisions.length,2);
 assert.equal(store.revisions[0].document.nodes[1].data.text,"Welcome");
 assert.equal(store.revisions[1].document.nodes[1].data.text,"Changed");
 assert.notEqual(JSON.stringify(source),original);
});
test("activation defaults OFF and canary approval is required; rollback keeps original revisions",async()=>{
 const {store,service}=setup();
 const d=doc();
 assert.equal((await service.publish("session-A","account-A","welcome",d)).ok,true);
 d.nodes[1].data.text="Revision two";
 assert.equal((await service.publish("session-A","account-A","welcome",d)).ok,true);
 assert.deepEqual(await service.activate("session-A","account-A","welcome",2),
  {ok:false,reason:"activation_disabled"});
 assert.equal(store.activations.size,0);
 store.enabledForCanary=true;
 assert.equal((await service.activate("session-A","account-A","welcome",2)).ok,true);
 let a=await store.activation("tenant-A","account-A","welcome");
 assert.equal(a?.revision,2);
 assert.equal(a?.active,true);
 assert.equal((await service.rollback("session-A","account-A","welcome",1)).ok,true);
 a=await store.activation("tenant-A","account-A","welcome");
 assert.equal(a?.revision,1);
 assert.equal(store.revisions.length,2);
 assert.equal((await service.deactivate("session-A","account-A","welcome")).ok,true);
 assert.equal((await store.activation("tenant-A","account-A","welcome"))?.active,false);
});
test("tenant B cannot publish or activate tenant A's account",async()=>{
 const {store,service}=setup();
 assert.deepEqual(await service.publish("session-B","account-A","welcome",doc()),
  {ok:false,reason:"unauthenticated"});
 assert.deepEqual(await service.activate("session-B","account-A","welcome",1),
  {ok:false,reason:"unauthenticated"});
 assert.deepEqual(await service.deactivate("session-B","account-A","welcome"),
  {ok:false,reason:"unauthenticated"});
 assert.equal(store.revisions.length,0);
});
test("the browser cannot grant itself capabilities, bypass invalid graphs or spoof tenancy",async()=>{
 const {store,service}=setup();
 const fake={...doc(),tenantId:"tenant-B",capabilities:["execution-engine"]} as unknown;
 let result=await service.publish("session-A","account-A","welcome",fake);
 assert.equal(result.ok,true);
 // Even if browser advertises capabilities, only the account's server set counts.
 store.accounts[0].capabilities=new Set();
 result=await service.publish("session-A","account-A","welcome",fake);
 assert.deepEqual(result,{ok:false,reason:"invalid_document"});
 const invalid=doc();invalid.edges=[];
 result=await service.publish("session-A","account-A","welcome",invalid);
 assert.deepEqual(result,{ok:false,reason:"invalid_document"});
 const bad=doc();bad.nodes.push(makeNode("trigger",{x:80,y:80}));
 result=await service.publish("session-A","account-A","welcome",bad);
 assert.deepEqual(result,{ok:false,reason:"invalid_document"});
});
test("unsupported drafts, malformed revisions and huge documents fail closed",async()=>{
 const {store,service}=setup();
 const d=doc();
 const invalids:[string,unknown][]=[
  ["",d],["../../../private",d],
  ["welcome",{...d,version:2}],["welcome",null],
  ["welcome","invalid"],["welcome",{...d,name:"x".repeat(5*1024*1024)}]
 ];
 for(const [name,payload] of invalids){
  const r=await service.publish("session-A","account-A",name,payload);
  assert.equal(r.ok,false,name);
 }
 assert.equal(store.revisions.length,0);
 assert.deepEqual(await service.activate("session-A","account-A","welcome",0),
  {ok:false,reason:"invalid_request"});
});
test("only published revision can activate and disabled account still permits deactivation",async()=>{
 const {store,service}=setup();
 store.enabledForCanary=true;
 assert.equal((await service.activate("session-A","account-A","welcome",3)).ok,false);
 await service.publish("session-A","account-A","welcome",doc());
 assert.equal((await service.activate("session-A","account-A","welcome",1)).ok,true);
 store.accounts[0].enabled=false;
 assert.deepEqual(await service.activate("session-A","account-A","welcome",1),
  {ok:false,reason:"unauthenticated"});
 assert.equal((await service.deactivate("session-A","account-A","welcome")).ok,true);
});
test("missing identity cannot publish, activate or rollback",async()=>{
 const {service}=setup();
 assert.deepEqual(await service.publish("bad-token","account-A","welcome",doc()),
  {ok:false,reason:"unauthenticated"});
 assert.deepEqual(await service.activate("bad-token","account-A","welcome",1),
  {ok:false,reason:"unauthenticated"});
 assert.deepEqual(await service.rollback("bad-token","account-A","welcome",1),
  {ok:false,reason:"unauthenticated"});
});
