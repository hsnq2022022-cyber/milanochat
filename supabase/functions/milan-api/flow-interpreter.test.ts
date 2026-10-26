import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFlowStep } from "./flow-interpreter.ts";
import type { FlowGraphDraft } from "./flow-graph.ts";
const graph: FlowGraphDraft = {
  nodes: [
    { id: "a", type: "message", is_entry: true, config: { text: "مرحباً" } },
    { id: "b", type: "end" }
  ],
  edges: [{from_node_id:"a",to_node_id:"b"}]
};
test("message is a decision, not a send", () => {
  assert.deepEqual(decideFlowStep(graph,null), {status:"send",nodeId:"a",text:"مرحباً",nextNodeId:"b"});
});
test("does not execute if graph invalid", () => {
  const invalid: FlowGraphDraft = {...graph, edges:[{from_node_id:"a",to_node_id:"unknown"}]};
  assert.equal(decideFlowStep(invalid,null).status,"error");
});
test("end is terminal", () => {
  assert.deepEqual(decideFlowStep(graph,"b"),{status:"finished",nodeId:"b"});
});
test("branch cannot generate arbitrary AI messages", () => {
  const decision: FlowGraphDraft = {
    nodes:[{id:"a",type:"buttons",is_entry:true,config:{text:"اختر"}},{id:"b",type:"end"}],
    edges:[{from_node_id:"a",to_node_id:"b",match_type:"keyword",match_value:"yes"}]
  };
  assert.equal(decideFlowStep(decision,"a",{text:"unmatched"}).status,"waiting");
  assert.equal(decideFlowStep(decision,"a",{payload:"yes"}).status,"finished");
});
