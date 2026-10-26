import { test } from "node:test";
import assert from "node:assert/strict";
import { arrangeFlow, cardSize } from "./layout.ts";
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
