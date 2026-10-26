import {
  validateFlowGraph,
  type FlowGraphDraft,
  type FlowGraphNode,
  type FlowGraphEdge,
} from "./flow-graph.ts";

export type FlowDecision =
  | { status: "send"; nodeId: string; text: string; nextNodeId: string | null }
  | { status: "handoff"; nodeId: string; mode: "ai" | "human" }
  | { status: "finished"; nodeId: string }
  | { status: "waiting"; nodeId: string }
  | { status: "error"; reason: string };

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

/**
 * Pure interpreter: calculates ONE safe step without side effects.
 * It does not send, persist, or charge a tenant.
 * This deliberately requires an external transactional session/outbox executor.
 */
export function decideFlowStep(
  graph: FlowGraphDraft,
  currentNodeId: string | null,
  input: { text?: string; payload?: string } = {},
): FlowDecision {
  const check = validateFlowGraph(graph);
  if (!check.valid) return { status: "error", reason: check.errors.join("; ") };
  const id = currentNodeId ?? check.entryNodeId;
  if (!id) return { status: "error", reason: "Missing entry node" };
  const node: FlowGraphNode | undefined = graph.nodes.find((n) => n.id === id);
  if (!node) return { status: "error", reason: "Unknown current node" };
  const edges: FlowGraphEdge[] = graph.edges.filter((e) => e.from_node_id === id);

  if (node.type === "end") return { status: "finished", nodeId: id };
  if (node.type === "ai_handoff") return { status: "handoff", nodeId: id, mode: "ai" };
  if (node.type === "transfer_human") return { status: "handoff", nodeId: id, mode: "human" };

  if (node.type === "buttons" || node.type === "condition") {
    const userInput = normalized(input.payload || input.text || "");
    if (!userInput) return { status: "waiting", nodeId: id };
    const matched = edges.find((e) => e.match_type === "keyword" && normalized(e.match_value ?? "") === userInput);
    const fallback = edges.find((e) => e.match_type === "default");
    const next = matched ?? fallback;
    if (!next) return { status: "waiting", nodeId: id };
    return decideFlowStep(graph, next.to_node_id, {});
  }

  if (node.type === "image") {
    // Media is excluded until a Meta API-compatible payload/outbox is implemented.
    return { status: "error", reason: "Image delivery not enabled" };
  }

  if (node.type === "message") {
    const text = node.config?.text;
    if (typeof text !== "string" || !text.trim()) return { status: "error", reason: "Missing message text" };
    if (edges.length !== 1) return { status: "error", reason: "Message node requires exactly one next edge" };
    return { status: "send", nodeId: id, text, nextNodeId: edges[0].to_node_id };
  }

  return { status: "error", reason: "Unsupported node" };
}
