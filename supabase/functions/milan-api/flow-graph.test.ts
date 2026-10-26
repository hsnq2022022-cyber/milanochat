// Run on Node 22+: node --experimental-strip-types --test flow-graph.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFlowGraph, type FlowGraphDraft } from "./flow-graph.ts";

const basic = (): FlowGraphDraft => ({
  nodes: [
    { id: "hello", type: "message", is_entry: true, config: { text: "أهلاً" } },
    { id: "bye", type: "end" },
  ],
  edges: [{ from_node_id: "hello", to_node_id: "bye" }],
});

test("valid acyclic graph with an entry", () => {
  assert.equal(validateFlowGraph(basic()).valid, true);
});

test("missing entry is rejected", () => {
  const g = basic();
  delete g.nodes[0].is_entry;
  assert.equal(validateFlowGraph(g).valid, false);
});

test("dangling edges are rejected", () => {
  const g = basic();
  g.edges[0].to_node_id = "absent";
  assert.equal(validateFlowGraph(g).valid, false);
});

test("self-loop is rejected", () => {
  const g = basic();
  g.edges[0].to_node_id = "hello";
  assert.match(validateFlowGraph(g).errors.join(" | "), /Cycle detected/);
});

test("unreachable nodes and their cycles are rejected", () => {
  const g = basic();
  g.nodes.push({ id: "island", type: "message", config: { text: "hello" } });
  g.edges.push({ from_node_id: "island", to_node_id: "island" });
  const result = validateFlowGraph(g);
  assert.match(result.errors.join(" | "), /Unreachable node/);
  assert.match(result.errors.join(" | "), /Cycle detected/);
});

test("buttons require explicit keyword fallback", () => {
  const g = basic();
  g.nodes[0] = { id: "hello", type: "buttons", is_entry: true, config: { text: "اختر" } };
  assert.equal(validateFlowGraph(g).valid, false);
  g.edges[0].match_type = "keyword";
  g.edges[0].match_value = "1";
  assert.equal(validateFlowGraph(g).valid, true);
});

test("terminal nodes may not send users onward", () => {
  const g = basic();
  g.edges.push({ from_node_id: "bye", to_node_id: "hello" });
  assert.match(validateFlowGraph(g).errors.join(" | "), /Terminal node/);
});

test("duplicate node IDs are rejected", () => {
  const g = basic();
  g.nodes.push({ id: "bye", type: "end" });
  assert.match(validateFlowGraph(g).errors.join(" | "), /Duplicate node ID/);
});

test("requires HTTPS image URLs", () => {
  const g = basic();
  g.nodes[0] = { id: "hello", type: "image", is_entry: true, config: { image_url: "http://example.com/a.png" } };
  assert.equal(validateFlowGraph(g).valid, false);
  g.nodes[0].config = { image_url: "https://example.com/a.png" };
  assert.equal(validateFlowGraph(g).valid, true);
});
