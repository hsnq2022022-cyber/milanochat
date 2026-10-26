/**
 * Pure graph validation for the flow-engine draft.
 * No database writes, Graph API calls, or dependencies.
 * A persisted schema and runtime executor must be reviewed together before activation.
 */
export type FlowNodeType =
  | "message" | "buttons" | "image" | "condition"
  | "ai_handoff" | "transfer_human" | "end";

export interface FlowGraphNode {
  id: string;
  type: FlowNodeType;
  is_entry?: boolean;
  config?: Record<string, unknown>;
}

export interface FlowGraphEdge {
  from_node_id: string;
  to_node_id: string;
  match_type?: string | null;
  match_value?: string | null;
}

export interface FlowGraphDraft {
  entry_node_id?: string | null;
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}

export interface FlowGraphValidation {
  valid: boolean;
  errors: string[];
  entryNodeId: string | null;
}

const NODE_TYPES = new Set<FlowNodeType>([
  "message", "buttons", "image", "condition",
  "ai_handoff", "transfer_human", "end",
]);

const TERMINAL_TYPES = new Set<FlowNodeType>([
  "ai_handoff", "transfer_human", "end",
]);

const keyword = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase();

export function validateFlowGraph(graph: FlowGraphDraft): FlowGraphValidation {
  const errors: string[] = [];
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { valid: false, errors: ["Graph requires nodes and edges arrays"], entryNodeId: null };
  }

  const { nodes, edges } = graph;
  if (nodes.length < 1 || nodes.length > 100) {
    errors.push("Graph must contain 1 to 100 nodes");
  }
  if (edges.length > 200) {
    errors.push("Graph cannot exceed 200 edges");
  }

  const byId = new Map<string, FlowGraphNode>();
  for (const node of nodes) {
    if (!node || typeof node.id !== "string" || !node.id.trim()) {
      errors.push("Every node requires a nonempty ID");
      continue;
    }
    if (byId.has(node.id)) errors.push(`Duplicate node ID: ${node.id}`);
    byId.set(node.id, node);
    if (!NODE_TYPES.has(node.type)) errors.push(`Unsupported node type: ${node.type}`);
    if (node.type === "message" || node.type === "buttons") {
      if (typeof node.config?.text !== "string" || !node.config.text.trim()) {
        errors.push(`Node ${node.id} needs nonempty config.text`);
      }
    }
    if (node.type === "image") {
      const url = node.config?.image_url;
      if (typeof url !== "string" || !/^https:\/\//i.test(url) || url.length > 2048) {
        errors.push(`Node ${node.id} needs an HTTPS image_url`);
      }
    }
  }

  const designated = nodes.filter((n) => n?.is_entry === true);
  const explicit = graph.entry_node_id;
  let entryNodeId: string | null = null;
  if (typeof explicit === "string" && explicit.length) {
    entryNodeId = explicit;
    if (!byId.has(explicit)) errors.push("entry_node_id must refer to a node");
    if (designated.length && (designated.length !== 1 || designated[0].id !== explicit)) {
      errors.push("Conflicting entry node declarations");
    }
  } else if (designated.length === 1) {
    entryNodeId = designated[0].id;
  } else {
    errors.push("Exactly one entry node is required");
  }

  const links = new Map<string, string[]>();
  const keywords = new Map<string, Set<string>>();
  for (const node of nodes) if (node?.id) links.set(node.id, []);
  for (const edge of edges) {
    if (!edge || !byId.has(edge.from_node_id) || !byId.has(edge.to_node_id)) {
      errors.push("Edge references an unknown node");
      continue;
    }
    links.get(edge.from_node_id)?.push(edge.to_node_id);
    const source = byId.get(edge.from_node_id)!;
    if (TERMINAL_TYPES.has(source.type)) {
      errors.push(`Terminal node ${source.id} cannot have outgoing edges`);
    }
    if (source.type === "buttons") {
      if (!["keyword", "default"].includes(edge.match_type ?? "")) {
        errors.push(`Buttons node ${source.id} requires keyword or default edges`);
      }
      if (edge.match_type === "keyword") {
        if (typeof edge.match_value !== "string" || !keyword(edge.match_value)) {
          errors.push(`Buttons node ${source.id} needs a nonempty keyword fallback`);
        } else {
          const seen = keywords.get(source.id) ?? new Set<string>();
          const normalized = keyword(edge.match_value);
          if (seen.has(normalized)) errors.push(`Repeated keyword at ${source.id}: ${normalized}`);
          seen.add(normalized);
          keywords.set(source.id, seen);
        }
      }
    }
  }

  for (const node of nodes) {
    if (!node || !byId.has(node.id)) continue;
    if (!TERMINAL_TYPES.has(node.type) && !(links.get(node.id)?.length)) {
      errors.push(`Nonterminal node ${node.id} requires an outgoing edge`);
    }
    if (node.type === "buttons" && !(keywords.get(node.id)?.size)) {
      errors.push(`Buttons node ${node.id} must have a keyword fallback`);
    }
  }

  // Reject cycles anywhere, not only in the portion reachable from the entry.
  const state = new Map<string, 0 | 1 | 2>();
  const dfs = (id: string): void => {
    const st = state.get(id) ?? 0;
    if (st === 1) { errors.push(`Cycle detected at ${id}`); return; }
    if (st === 2) return;
    state.set(id, 1);
    for (const next of links.get(id) ?? []) dfs(next);
    state.set(id, 2);
  };
  for (const id of byId.keys()) if (!state.has(id)) dfs(id);

  if (entryNodeId && byId.has(entryNodeId)) {
    const visited = new Set<string>();
    const stack = [entryNodeId];
    while (stack.length) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      stack.push(...(links.get(id) ?? []));
    }
    for (const id of byId.keys()) {
      if (!visited.has(id)) errors.push(`Unreachable node: ${id}`);
    }
  }

  return { valid: errors.length === 0, errors, entryNodeId };
}
