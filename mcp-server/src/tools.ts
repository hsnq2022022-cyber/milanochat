import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CREATABLE_KINDS, LIMITS, type CreatableKind, type FlowData, type FlowEdge, type FlowNode,
  connectableOutputs, fieldNameProblem, makeEdge, makeNode, makeOption, makeTriggerNode, newId,
} from "./flowModel.js";
import { StoreError, type FlowRecord, type FlowStore } from "./store.js";

export type ToolDeps = {
  store: FlowStore;
  /** When set, every tool refuses any other tenant. */
  allowedTenantId: string | null;
  /** Optional sink for unexpected errors (stderr in production). Never receives secrets. */
  logError?: (msg: string) => void;
};

class ToolError extends Error {}

const ok = (summary: string, payload: unknown): CallToolResult => ({
  content: [{ type: "text", text: summary + "\n" + JSON.stringify(payload, null, 2) }],
});
const err = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

const tenantIdSchema = z.string().trim().uuid("tenant_id must be a uuid (the tenants.id of the workspace)");
const flowIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/, "flow_id must be the id returned by create_flow or list_flows");
const nodeIdSchema = z.string().trim().min(1).max(128);
const coord = (axis: string) => z.number({ error: `${axis} is required and must be a number` })
  .finite().min(-LIMITS.position).max(LIMITS.position).describe(`Canvas ${axis} in pixels (required, between -100000 and 100000). Space nodes ~300px apart.`);

const optionInput = z.union([
  z.string().trim().min(1).max(LIMITS.optionLabel),
  z.object({ id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), label: z.string().trim().min(1).max(LIMITS.optionLabel) }).strict(),
]);

/** Accepted `data` keys. Aliases: label -> title, message -> text, buttons -> options. */
export const nodeDataSchema = z.object({
  title: z.string().max(LIMITS.title).optional().describe("Node title shown on the canvas (data.title)."),
  label: z.string().max(LIMITS.title).optional().describe("Alias of title."),
  text: z.string().max(LIMITS.text).optional().describe("Message/question text sent to the customer (data.text)."),
  message: z.string().max(LIMITS.text).optional().describe("Alias of text."),
  options: z.array(optionInput).max(LIMITS.options).optional()
    .describe("message/question buttons: strings or {id?,label}. Each button's id becomes a source_handle for connect_nodes."),
  buttons: z.array(optionInput).max(LIMITS.options).optional().describe("Alias of options."),
  input_mode: z.enum(["buttons", "text", "email", "phone"]).optional()
    .describe("question only: 'buttons' (default, branch per button) or a typed answer (single output handle 'valid')."),
  input_field: z.string().max(LIMITS.inputField).optional().describe("question with typed answer: variable name to store the answer (default 'response')."),
  delay_value: z.number().finite().positive().max(1e6).optional().describe("delay only: amount (> 0, default 1)."),
  delay_unit: z.enum(["seconds", "minutes", "hours", "days"]).optional().describe("delay only (default 'minutes')."),
  condition_field: z.string().max(LIMITS.conditionField).optional().describe("condition only: field to test (default 'message')."),
  operator: z.enum(["contains", "equals", "not_equals", "exists"]).optional().describe("condition only (default 'contains')."),
  condition_value: z.string().max(LIMITS.conditionValue).optional().describe("condition only: value to compare (required unless operator is 'exists')."),
}).strict();
export type NodeDataInput = z.infer<typeof nodeDataSchema>;

export const createFlowShape = {
  tenant_id: tenantIdSchema.describe("Workspace (tenant) uuid that will own the flow."),
  name: z.string().trim().min(1).max(LIMITS.name).describe("Flow name (1-100 characters)."),
};
export const addNodeShape = {
  flow_id: flowIdSchema.describe("Flow id from create_flow / list_flows."),
  node_type: z.enum(CREATABLE_KINDS).describe("Step kind; stored as data.kind."),
  position_x: coord("position_x"),
  position_y: coord("position_y"),
  data: nodeDataSchema.optional().describe("Step content. Unknown keys are rejected."),
  tenant_id: tenantIdSchema.optional().describe("Optional. If given, the flow must belong to this tenant."),
};
export const connectNodesShape = {
  flow_id: flowIdSchema.describe("Flow id from create_flow / list_flows."),
  source_node_id: nodeIdSchema.describe("Node the arrow starts from."),
  target_node_id: nodeIdSchema.describe("Node the arrow points to (cannot be the trigger)."),
  source_handle: z.string().trim().min(1).max(128).optional().describe(
    "Output port of the source node. trigger/message/delay: 'next' (default); message/question buttons: the button id; " +
    "question with typed answer: 'valid' (default); condition: 'yes' or 'no' (required). end has no outputs."),
  tenant_id: tenantIdSchema.optional().describe("Optional. If given, the flow must belong to this tenant."),
};
export const listFlowsShape = {
  tenant_id: tenantIdSchema.describe("Workspace (tenant) uuid."),
};

const zCreate = z.object(createFlowShape), zAdd = z.object(addNodeShape), zConnect = z.object(connectNodesShape), zList = z.object(listFlowsShape);

function buildNodeData(kind: CreatableKind, d: NodeDataInput): Partial<FlowData> {
  const out: Partial<FlowData> = {};
  const title = d.title ?? d.label, text = d.text ?? d.message, opts = d.options ?? d.buttons;
  if (d.title !== undefined && d.label !== undefined && d.title !== d.label) throw new ToolError("Give either data.title or data.label, not both.");
  if (d.text !== undefined && d.message !== undefined && d.text !== d.message) throw new ToolError("Give either data.text or data.message, not both.");
  if (d.options && d.buttons) throw new ToolError("Give either data.options or data.buttons, not both.");
  if (title !== undefined) out.title = title.slice(0, LIMITS.title);
  const allowed: Record<CreatableKind, string[]> = {
    message: ["text", "options"], question: ["text", "options", "input_mode", "input_field"],
    delay: ["delay_value", "delay_unit"], condition: ["condition_field", "operator", "condition_value"], end: [],
  };
  const given = new Set<string>();
  if (text !== undefined) given.add("text");
  if (opts !== undefined) given.add("options");
  for (const k of ["input_mode", "input_field", "delay_value", "delay_unit", "condition_field", "operator", "condition_value"] as const)
    if (d[k] !== undefined) given.add(k);
  const bad = [...given].filter(k => !allowed[kind].includes(k));
  if (bad.length) throw new ToolError(`data.${bad.join(", data.")} is not valid for a ${kind} node. Allowed: title${allowed[kind].map(k => ", " + k).join("")}.`);

  if (text !== undefined) out.text = text.slice(0, LIMITS.text);
  if (opts !== undefined) {
    const seen = new Set<string>();
    out.options = opts.map(o => {
      const opt = typeof o === "string" ? makeOption(o) : makeOption(o.label, o.id ?? newId());
      if (["next", "valid", "invalid", "yes", "no", "in"].includes(opt.id) || seen.has(opt.id))
        throw new ToolError(`Button id '${opt.id}' is reserved or duplicated.`);
      seen.add(opt.id);
      return opt;
    });
  }
  if (kind === "question") {
    if (d.input_mode) out.inputMode = d.input_mode;
    if (d.input_field !== undefined) {
      const p = fieldNameProblem(d.input_field.trim());
      if (p) throw new ToolError(`data.input_field: ${p}.`);
      out.inputField = d.input_field.trim();
    }
    if ((d.input_mode ?? "buttons") === "buttons" && opts !== undefined && opts.length === 0)
      throw new ToolError("A question in buttons mode needs at least one button (or use input_mode 'text').");
    if (d.input_mode && d.input_mode !== "buttons" && opts?.length)
      throw new ToolError("Buttons are only used when input_mode is 'buttons'.");
    if (d.input_mode && d.input_mode !== "buttons" && opts === undefined) out.options = [];
  }
  if (kind === "delay") {
    if (d.delay_value !== undefined) out.delayValue = d.delay_value;
    if (d.delay_unit) out.delayUnit = d.delay_unit;
  }
  if (kind === "condition") {
    if (d.condition_field !== undefined) {
      if (!d.condition_field.trim()) throw new ToolError("data.condition_field must not be empty.");
      out.conditionField = d.condition_field.trim();
    }
    if (d.operator) out.operator = d.operator;
    if (d.condition_value !== undefined) out.conditionValue = d.condition_value;
  }
  return out;
}

export function createFlowTools(deps: ToolDeps) {
  const { store, allowedTenantId } = deps;

  function checkTenantArg(tenantId: string | undefined): string | null {
    const t = tenantId?.toLowerCase() ?? null;
    if (allowedTenantId && t && t !== allowedTenantId)
      throw new ToolError("This server is restricted to a different tenant (MILANO_ALLOWED_TENANT_ID); refusing the request.");
    return t ?? allowedTenantId;
  }

  async function loadFlow(flowId: string, tenantArg: string | undefined): Promise<FlowRecord> {
    const tenant = checkTenantArg(tenantArg);
    const rec = await store.get(flowId, tenant);
    if (!rec) throw new ToolError(`Flow '${flowId}' was not found${tenant ? " for this tenant" : ""}. Use list_flows to see available flows.`);
    // Defense in depth: never touch a row of another tenant even if the query layer misbehaved.
    if ((tenant && rec.tenantId !== tenant) || (allowedTenantId && rec.tenantId !== allowedTenantId))
      throw new ToolError(`Flow '${flowId}' was not found for this tenant.`);
    return rec;
  }

  /** Load, apply, conditional update; on a concurrent change reload and retry once. */
  async function mutate<T>(flowId: string, tenantArg: string | undefined,
    apply: (rec: FlowRecord) => { nodes: FlowNode[]; edges: FlowEdge[]; result: T }): Promise<{ rec: FlowRecord; result: T }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const rec = await loadFlow(flowId, tenantArg);
      const next = apply(rec);
      const saved = await store.update(rec, next.nodes, next.edges);
      if (saved) return { rec: saved, result: next.result };
    }
    throw new ToolError("Conflict: the flow was changed by someone else (e.g. in the Flow Builder) while saving, twice in a row. Nothing was written by this call; please retry.");
  }

  async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
    try { return await fn(); }
    catch (e) {
      if (e instanceof ToolError || e instanceof StoreError) return err(e.message);
      if (e instanceof z.ZodError) return err("Invalid arguments: " + e.issues.map(i => (i.path.join(".") || "input") + ": " + i.message).join("; "));
      deps.logError?.("unexpected tool error: " + (e instanceof Error ? e.name : typeof e));
      return err("Unexpected server error (no data was changed by this call unless reported otherwise). Check the MCP server stderr log.");
    }
  }

  const nodeView = (n: FlowNode) => ({
    id: n.id, kind: n.data.kind, title: n.data.title, position: n.position,
    output_handles: connectableOutputs(n).map(o => ({ handle: o.id, label: o.label })),
  });

  return {
    create_flow: (raw: unknown) => guard(async () => {
      const a = zCreate.parse(raw);
      const tenantId = checkTenantArg(a.tenant_id)!;
      const trigger = makeTriggerNode();
      const rec = await store.create({ id: newId(), tenantId, name: a.name, nodes: [trigger], edges: [] });
      return ok(`Created flow '${rec.name}'. It starts with a trigger node; connect it to your first step with connect_nodes.`,
        { flow_id: rec.id, tenant_id: rec.tenantId, name: rec.name, trigger_node: nodeView(trigger), storage: store.description });
    }),

    add_node: (raw: unknown) => guard(async () => {
      const a = zAdd.parse(raw);
      const opts = buildNodeData(a.node_type, a.data ?? {});
      const { rec, result: node } = await mutate(a.flow_id, a.tenant_id, cur => {
        if (cur.nodes.length >= LIMITS.nodes) throw new ToolError(`A flow can have at most ${LIMITS.nodes} nodes.`);
        const node = makeNode(a.node_type, { x: a.position_x, y: a.position_y }, opts);
        return { nodes: [...cur.nodes, node], edges: cur.edges, result: node };
      });
      return ok(`Added ${a.node_type} node to flow '${rec.name}'.`, { flow_id: rec.id, node: nodeView(node), node_count: rec.nodes.length });
    }),

    connect_nodes: (raw: unknown) => guard(async () => {
      const a = zConnect.parse(raw);
      const { rec, result: edge } = await mutate(a.flow_id, a.tenant_id, cur => {
        if (a.source_node_id === a.target_node_id) throw new ToolError("A node cannot be connected to itself.");
        const from = cur.nodes.find(n => n.id === a.source_node_id), to = cur.nodes.find(n => n.id === a.target_node_id);
        if (!from) throw new ToolError(`Source node '${a.source_node_id}' does not exist in this flow.`);
        if (!to) throw new ToolError(`Target node '${a.target_node_id}' does not exist in this flow.`);
        if (to.data.kind === "trigger") throw new ToolError("The trigger node cannot be a connection target.");
        const outs = connectableOutputs(from);
        if (!outs.length) throw new ToolError(`A ${from.data.kind} node has no outputs and cannot be a connection source.`);
        const list = outs.map(o => `'${o.id}' (${o.label})`).join(", ");
        let handle = a.source_handle;
        if (!handle) {
          const def = outs.find(o => o.id === "next" || o.id === "valid") ?? (outs.length === 1 ? outs[0] : undefined);
          if (!def) throw new ToolError(`source_handle is required for this ${from.data.kind} node. Valid handles: ${list}.`);
          handle = def.id;
        }
        const port = outs.find(o => o.id === handle);
        if (!port) throw new ToolError(`Invalid source_handle '${handle}' for this ${from.data.kind} node. Valid handles: ${list}.`);
        const same = cur.edges.find(e => e.source === from.id && (e.sourceHandle || "next") === port.id);
        if (same?.target === to.id) throw new ToolError("This connection already exists.");
        if (same) throw new ToolError(`Output '${port.id}' of this node is already connected to node '${same.target}'. Each output can have only one connection.`);
        if (cur.edges.length >= LIMITS.edges) throw new ToolError(`A flow can have at most ${LIMITS.edges} connections.`);
        const edge = makeEdge(from.id, to.id, port.id, port.label);
        return { nodes: cur.nodes, edges: [...cur.edges, edge], result: edge };
      });
      return ok(`Connected nodes in flow '${rec.name}'.`, { flow_id: rec.id, edge, edge_count: rec.edges.length });
    }),

    list_flows: (raw: unknown) => guard(async () => {
      const a = zList.parse(raw);
      const tenantId = checkTenantArg(a.tenant_id)!;
      const flows = await store.list(tenantId, 100);
      return ok(`${flows.length} flow(s) for tenant ${tenantId}.`, { tenant_id: tenantId, flows });
    }),
  };
}

export const TOOL_DESCRIPTIONS = {
  create_flow: "Create a new Milanochat automation flow for a tenant. The flow is created with one trigger node (start); " +
    "returns flow_id and the trigger node id. Example: 'Create a flow named Welcome'.",
  add_node: "Append a step to a flow at a canvas position (position_x and position_y are REQUIRED). node_type: message | question | delay | condition | end. " +
    "data: title (alias label), text (alias message), options/buttons (message/question), input_mode/input_field (question), " +
    "delay_value/delay_unit (delay), condition_field/operator/condition_value (condition). Returns the new node id and its output handles. " +
    "Nodes are not connected automatically; call connect_nodes.",
  connect_nodes: "Connect an output of one node to another node. source_handle: 'next' for trigger/message/delay (default), " +
    "a button id for message/question buttons (ids are returned by add_node), 'valid' for a typed-answer question, 'yes'/'no' for condition. " +
    "Rejects self-loops, duplicates, outputs that are already connected, end nodes as source and the trigger as target.",
  list_flows: "List a tenant's flows (id, name, node/edge counts, timestamps), most recently updated first.",
} as const;

export function registerFlowTools(server: McpServer, deps: ToolDeps): void {
  const t = createFlowTools(deps);
  server.registerTool("create_flow", { title: "Create flow", description: TOOL_DESCRIPTIONS.create_flow, inputSchema: createFlowShape }, a => t.create_flow(a));
  server.registerTool("add_node", { title: "Add node", description: TOOL_DESCRIPTIONS.add_node, inputSchema: addNodeShape }, a => t.add_node(a));
  server.registerTool("connect_nodes", { title: "Connect nodes", description: TOOL_DESCRIPTIONS.connect_nodes, inputSchema: connectNodesShape }, a => t.connect_nodes(a));
  server.registerTool("list_flows", { title: "List flows", description: TOOL_DESCRIPTIONS.list_flows, inputSchema: listFlowsShape }, a => t.list_flows(a));
}

/* ------------------------------------------------------------------------------------------------
 * Remote (HTTP) mode. Tool schemas contain NO tenant_id: the tenant comes only from the
 * authenticated request context. Schemas are strict, so a client-supplied tenant_id is rejected.
 * The context tenant is injected into the stdio handlers with allowedTenantId set to the same value,
 * so every store call is tenant-filtered and every loaded flow is re-checked (not-found otherwise).
 * ---------------------------------------------------------------------------------------------- */

export type RemoteToolDeps = {
  store: FlowStore;
  /** Tenant resolved from the verified request (JWT or testing header). */
  tenantId: string;
  logError?: (msg: string) => void;
};

const { tenant_id: _a, ...remoteAddNodeShape } = addNodeShape;
const { tenant_id: _c, ...remoteConnectNodesShape } = connectNodesShape;
export const remoteSchemas = {
  create_flow: z.object({ name: createFlowShape.name }).strict(),
  add_node: z.object(remoteAddNodeShape).strict(),
  connect_nodes: z.object(remoteConnectNodesShape).strict(),
  list_flows: z.object({}).strict(),
};
type RemoteName = keyof typeof remoteSchemas;

export function createRemoteFlowTools(deps: RemoteToolDeps) {
  const tenantId = deps.tenantId.trim().toLowerCase();
  if (!z.string().uuid().safeParse(tenantId).success) throw new Error("remote tools require a uuid tenant context");
  const inner = createFlowTools({ store: deps.store, allowedTenantId: tenantId, logError: deps.logError });
  const wrap = (name: RemoteName) => async (raw: unknown): Promise<CallToolResult> => {
    const parsed = remoteSchemas[name].safeParse(raw ?? {});
    if (!parsed.success)
      return err("Invalid arguments: " + parsed.error.issues.map(i => (i.path.join(".") || "input") + ": " + i.message).join("; "));
    return inner[name]({ ...parsed.data, tenant_id: tenantId });
  };
  return { create_flow: wrap("create_flow"), add_node: wrap("add_node"), connect_nodes: wrap("connect_nodes"), list_flows: wrap("list_flows") };
}

export function registerRemoteFlowTools(server: McpServer, deps: RemoteToolDeps): void {
  const t = createRemoteFlowTools(deps);
  const note = " The workspace (tenant) is taken from your authenticated connection.";
  server.registerTool("create_flow", { title: "Create flow", description: TOOL_DESCRIPTIONS.create_flow + note, inputSchema: remoteSchemas.create_flow }, a => t.create_flow(a));
  server.registerTool("add_node", { title: "Add node", description: TOOL_DESCRIPTIONS.add_node, inputSchema: remoteSchemas.add_node }, a => t.add_node(a));
  server.registerTool("connect_nodes", { title: "Connect nodes", description: TOOL_DESCRIPTIONS.connect_nodes, inputSchema: remoteSchemas.connect_nodes }, a => t.connect_nodes(a));
  server.registerTool("list_flows", { title: "List flows", description: TOOL_DESCRIPTIONS.list_flows + note, inputSchema: remoteSchemas.list_flows }, a => t.list_flows(a));
}
