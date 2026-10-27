import { test } from "node:test";
import assert from "node:assert/strict";
import { arrangeFlow, cardSize, findOpenPosition } from "./layout.ts";
import { exampleFlow, makeNode } from "./model.ts";

test("Dagre produces a readable top-to-bottom welcome flow", () => {
  const doc=arrangeFlow(exampleFlow());
  const first=doc.nodes[0],welcome=doc.nodes[1],question=doc.nodes[2];
  assert.ok(first.position.y < welcome.position.y,"Trigger must appear above message");
  assert.ok(welcome.position.y < question.position.y,"Message must appear above question");
  for(const node of doc.nodes.slice(3))assert.ok(node.position.y>question.position.y,"Branch targets should appear under question");
});

test("Dagre never overlaps cards or destroys links and settings", () => {
  const source=exampleFlow();
  const arranged=arrangeFlow(source);
  assert.deepEqual(arranged.edges,source.edges);
  assert.deepEqual(arranged.nodes.map(n=>n.id),source.nodes.map(n=>n.id));
  assert.deepEqual(arranged.nodes.map(n=>n.data),source.nodes.map(n=>n.data));
  for(let i=0;i<arranged.nodes.length;i++){
    const a=arranged.nodes[i],as=cardSize(a);
    for(let j=i+1;j<arranged.nodes.length;j++){
      const b=arranged.nodes[j],bs=cardSize(b);
      const overlaps=a.position.x<b.position.x+bs.width&&a.position.x+as.width>b.position.x&&a.position.y<b.position.y+bs.height&&a.position.y+as.height>b.position.y;
      assert.equal(overlaps,false,`Overlapping cards: ${a.data.title} / ${b.data.title}`);
    }
  }
});

test("content-heavy cards reserve extra space without mutating node data", () => {
  const base=makeNode("message",{x:10,y:20});
  const rich=makeNode("message",{x:10,y:20},{image:"https://example.com/a.png",text:"This is a much longer message. ".repeat(12)});
  assert.ok(cardSize(rich).height>cardSize(base).height);
});

test("measured React Flow dimensions take precedence",()=>{
 const candidate=makeNode("message",{x:0,y:0},{text:"Very long content ".repeat(100)});
 candidate.measured={width:310,height:565};
 assert.deepEqual(cardSize(candidate),{width:310,height:565});
 const arranged=arrangeFlow({version:3,name:"measured",nodes:[candidate],edges:[]});
 assert.ok(Number.isFinite(arranged.nodes[0].position.x));
});
test("fallback height reserves additional image, PDF and collection content",()=>{
 const plain=makeNode("message",{x:0,y:0});
 const rich=makeNode("message",{x:0,y:0},{image:"https://example.com/banner.jpg",contentBlocks:[
  {id:"image",type:"image",url:"https://example.com/second.png"},
  {id:"pdf",type:"pdf",url:"https://example.com/manual.pdf"},
  {id:"collection",type:"collection",field:"email",text:"Email",inputMode:"email"},
  {id:"delay",type:"delay",seconds:3}
 ]});
 assert.ok(cardSize(rich).height>cardSize(plain).height+200);
});
test("12 repeated copies avoid existing content-rich measured cards",()=>{
 const existing=[makeNode("message",{x:100,y:100})];
 existing[0].measured={width:280,height:450};
 for(let i=0;i<12;i++){
   const copy=makeNode("message",{x:100,y:100});
   copy.position=findOpenPosition(existing,copy,{x:100,y:100});
   const a=cardSize(copy);
   for(const n of existing){
     const b=cardSize(n);
     assert.ok(copy.position.x>=n.position.x+b.width+40||
       copy.position.x+a.width+40<=n.position.x||
       copy.position.y>=n.position.y+b.height+40||
       copy.position.y+a.height+40<=n.position.y,"duplicate overlaps an existing node");
   }
   existing.push(copy);
 }
});
test("inserting onto occupied mid-edge coordinates finds a different location",()=>{
 const doc=exampleFlow();
 const fresh=makeNode("message",{x:400,y:250});
 const p=findOpenPosition(doc.nodes,fresh,fresh.position);
 assert.notDeepEqual(p,{x:400,y:250});
 assert.equal(doc.nodes.length,6);
 assert.equal(doc.edges.length,5);
});
