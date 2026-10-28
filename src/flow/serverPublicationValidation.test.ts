import {test} from "node:test";
import assert from "node:assert/strict";
import {makeNode,edgeFor} from "./model.ts";
import type {FlowDocument} from "./model.ts";
import {
 providerPlatform,preparePublishedDocument,publicationCanActivate,testCanaryArmed
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
