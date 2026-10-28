import {test} from "node:test";
import assert from "node:assert/strict";
import {simpleMessageFromDocument} from "../supabase/functions/milan-api/flowPrepareMessage.ts";

function example(platform="instagram",text="أهلاً بك في متجرنا"){
 return {version:3,name:"Only text",nodes:[
  {id:"in",data:{kind:"trigger",platform,triggerMode:"message",keywords:""}},
  {id:"out",data:{kind:"message",text,options:[],contentBlocks:[],image:""}}
 ],edges:[{source:"in",sourceHandle:"next",target:"out",targetHandle:"in"}]};
}
test("one Instagram trigger and one Arabic text node produce exactly one reply",()=>{
 assert.equal(simpleMessageFromDocument(example(),"instagram"),"أهلاً بك في متجرنا");
 assert.equal(simpleMessageFromDocument(example("messenger"),"facebook"),"أهلاً بك في متجرنا");
});
test("valid text flow runs regardless of node array order",()=>{
 const original=example();
 const reordered={...original,nodes:[...original.nodes].reverse()};
 assert.equal(simpleMessageFromDocument(reordered,"instagram"),"أهلاً بك في متجرنا");
 assert.equal(simpleMessageFromDocument({...reordered,edges:[{...original.edges[0],target:"missing"}]},"instagram"),null);
 assert.equal(simpleMessageFromDocument({...reordered,nodes:[
  {id:"other",data:{kind:"action"}},...reordered.nodes
 ]},"instagram"),null);
});

test("unsupported platform, trigger and extra nodes fail closed",()=>{
 assert.equal(simpleMessageFromDocument(example("messenger"),"instagram"),null);
 const d=example();d.nodes[0].data.triggerMode="keyword";
 assert.equal(simpleMessageFromDocument(d,"instagram"),null);
 const e=example();e.nodes.push({id:"extra",data:{kind:"action",text:"unsafe",options:[],contentBlocks:[],image:""}});
 assert.equal(simpleMessageFromDocument(e,"instagram"),null);
 const noEdge=example();noEdge.edges.length=0;
 assert.equal(simpleMessageFromDocument(noEdge,"instagram"),null);
});
test("buttons, links, images, unbounded text and malformed input fail closed",()=>{
 const buttons=example();buttons.nodes[1].data.options=[{label:"link",url:"https://example.com"}];
 assert.equal(simpleMessageFromDocument(buttons,"instagram"),null);
 const images=example();images.nodes[1].data.image="https://example.com/image";
 assert.equal(simpleMessageFromDocument(images,"instagram"),null);
 const long=example("instagram","م".repeat(600));
 assert.equal(simpleMessageFromDocument(long,"instagram"),null);
 assert.equal(simpleMessageFromDocument(null,"instagram"),null);
 assert.equal(simpleMessageFromDocument({version:3,nodes:[]}, "instagram"),null);
});
test("wrong edge or blank message cannot emit",()=>{
 const d=example();d.edges[0].sourceHandle="unexpected";
 assert.equal(simpleMessageFromDocument(d,"instagram"),null);
 const blank=example("instagram","  ");
 assert.equal(simpleMessageFromDocument(blank,"instagram"),null);
});
