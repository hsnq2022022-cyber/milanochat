import {test} from "node:test";
import assert from "node:assert/strict";
import {makeNode,edgeFor} from "./model.ts";
import type {FlowDocument} from "./model.ts";
import {
 providerPlatform,preparePublishedDocument,publicationCanActivate,testCanaryArmed,productionActivationAuthorized,
 commentTriggerProviderPlatform
} from "./serverPublicationValidation.ts";
import type {FlowCapability} from "./publicationGate.ts";

function doc(platform:"instagram"|"messenger"|"whatsapp"="instagram"):FlowDocument{
 const trigger=makeNode("trigger",{x:0,y:0},
  {platform,triggerMode:"message",keywords:""});
 const msg=makeNode("message",{x:0,y:200},{text:"أهلًا بك",options:[]});
 return {version:3,name:"Test",nodes:[trigger,msg],edges:[
  edgeFor({source:trigger.id,sourceHandle:"next",
   target:msg.id,targetHandle:"in"})
 ]};
}
test("backend platform alias maps Messenger to facebook",()=>{
 assert.equal(providerPlatform("messenger"),"facebook");
 assert.equal(providerPlatform("instagram"),"instagram");
 assert.equal(providerPlatform("whatsapp"),"whatsapp");
});
test("valid document publishes only to its own account's platform",()=>{
 assert.ok(preparePublishedDocument(doc(),"instagram"));
 assert.equal(preparePublishedDocument(doc(),"facebook"),null);
 assert.ok(preparePublishedDocument(doc("messenger"),"facebook"));
 assert.equal(preparePublishedDocument(doc("messenger"),"instagram"),null);
 assert.ok(preparePublishedDocument(doc("whatsapp"),"whatsapp"));
});
test("malformed version, no graph, oversized document and invalid edges cannot publish",()=>{
 assert.equal(preparePublishedDocument({...doc(),version:2},"instagram"),null);
 assert.equal(preparePublishedDocument({version:3,nodes:[],edges:[]},"instagram"),null);
 assert.equal(preparePublishedDocument({version:3,nodes:[],edges:[],name:"x".repeat(5*1024*1024)},"instagram"),null);
 const invalid=doc();invalid.nodes[1].data.text="";
 assert.equal(preparePublishedDocument(invalid,"instagram"),null);
 const wrong=doc();wrong.edges[0].target="absent";
 assert.equal(preparePublishedDocument(wrong,"instagram"),null);
});
test("client-injected capability claims are ignored by activation validator",()=>{
 const d={...doc(),capabilities:["execution-engine","instagram"]};
 const caps=new Set<FlowCapability>();
 assert.equal(publicationCanActivate(d,"instagram",caps,true),false);
});
test("server capability audit and canary both required to activate",()=>{
 const caps=new Set<FlowCapability>([
  "execution-engine","instagram","trigger:message","message:text"
 ]);
 assert.equal(publicationCanActivate(doc(),"instagram",caps,false),false);
 assert.equal(publicationCanActivate(doc(),"instagram",caps,true),true);
 assert.equal(publicationCanActivate(doc("messenger"),"instagram",caps,true),false);
 caps.delete("message:text");
 assert.equal(publicationCanActivate(doc(),"instagram",caps,true),false);
});
test("only exact server-owned canary tenant and account can arm activation",()=>{
 const tenant="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
 const account="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 assert.equal(testCanaryArmed("true",tenant,account,tenant,account),true);
 assert.equal(testCanaryArmed(undefined,tenant,account,tenant,account),false);
 assert.equal(testCanaryArmed("false",tenant,account,tenant,account),false);
 assert.equal(testCanaryArmed("true",tenant,account,tenant,"cccccccc-cccc-4ccc-8ccc-cccccccccccc"),false);
 assert.equal(testCanaryArmed("true","spoofed",account,tenant,account),false);
});

test("production activation requires operator-approved and enabled tenant plus global ON",()=>{
 assert.equal(productionActivationAuthorized("instagram",true,true,true),true);
 for(const flags of [
  [false,true,true],[true,false,true],[true,true,false],
  [null,true,true],[true,null,true],[true,true,"true"],
  [undefined,true,true]
 ] as const){
  assert.equal(productionActivationAuthorized("instagram",...flags),false);
 }
 assert.equal(productionActivationAuthorized("facebook",true,true,true),false);
 assert.equal(productionActivationAuthorized("whatsapp",true,true,true),false);
});

const COMMENT_ON={commentTrigger:true,commentAutomationEnabled:true,multichannelEnabled:true};
test("facebook comment flows: authorized only with comment automation AND multichannel flags ON",()=>{
 assert.equal(productionActivationAuthorized("facebook",true,true,true,COMMENT_ON),true);
 // Flag off / unset (fail-closed): exactly the previous result (false).
 assert.equal(productionActivationAuthorized("facebook",true,true,true,{...COMMENT_ON,commentAutomationEnabled:false}),false);
 assert.equal(productionActivationAuthorized("facebook",true,true,true,{...COMMENT_ON,multichannelEnabled:false}),false);
 assert.equal(productionActivationAuthorized("facebook",true,true,true),false);
 // Not exactly true is OFF.
 assert.equal(productionActivationAuthorized("facebook",true,true,true,
  {...COMMENT_ON,commentAutomationEnabled:"true" as unknown as boolean}),false);
 // DB switches and operator approval are still required.
 for(const flags of [[false,true,true],[true,false,true],[true,true,false],[undefined,true,true]] as const)
  assert.equal(productionActivationAuthorized("facebook",...flags,COMMENT_ON),false);
});
test("facebook DM flows stay unauthorized even with every flag ON",()=>{
 assert.equal(productionActivationAuthorized("facebook",true,true,true,{...COMMENT_ON,commentTrigger:false}),false);
});
test("whatsapp is never authorized: no comment surface in Meta's API, DM unchanged",()=>{
 assert.equal(productionActivationAuthorized("whatsapp",true,true,true,COMMENT_ON),false);
 assert.equal(productionActivationAuthorized("whatsapp",true,true,true,{...COMMENT_ON,commentTrigger:false}),false);
});
test("instagram unchanged by the comment context",()=>{
 for(const ctx of [undefined,COMMENT_ON,{...COMMENT_ON,commentTrigger:false},
  {commentTrigger:true,commentAutomationEnabled:false,multichannelEnabled:false}]){
  assert.equal(productionActivationAuthorized("instagram",true,true,true,ctx),true);
  assert.equal(productionActivationAuthorized("instagram",true,true,false,ctx),false);
  assert.equal(productionActivationAuthorized("instagram",false,true,true,ctx),false);
 }
});
test("commentTriggerProviderPlatform: comment triggers only, messenger -> facebook",()=>{
 const withTrigger=(platform:"instagram"|"messenger"|"whatsapp",triggerMode:string)=>{
  const d=doc(platform);d.nodes[0].data.triggerMode=triggerMode as never;return d;
 };
 assert.equal(commentTriggerProviderPlatform(withTrigger("messenger","comment")),"facebook");
 assert.equal(commentTriggerProviderPlatform(withTrigger("instagram","comment")),"instagram");
 assert.equal(commentTriggerProviderPlatform(withTrigger("whatsapp","comment")),null);
 assert.equal(commentTriggerProviderPlatform(withTrigger("messenger","message")),null);
 assert.equal(commentTriggerProviderPlatform(null),null);
 assert.equal(commentTriggerProviderPlatform({nodes:"x"}),null);
});
