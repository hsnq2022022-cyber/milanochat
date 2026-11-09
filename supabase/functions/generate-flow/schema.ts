/**
 * generate-flow: LLM output schema + strict validator.
 *
 * The model output is UNTRUSTED. Nothing here trusts ids, handles, sizes or
 * text from the model: every field is re-read into a fresh object (unknown
 * fields dropped), bounded, sanitized and cross-checked. Pure module, no
 * Deno/Node APIs, so it runs under Deno (Edge) and node --test alike.
 */

export const LLM_MAX_NODES = 30;
export const LLM_MAX_EDGES = 60;
export const LLM_MAX_OPTIONS = 10;
export const LLM_MAX_RAW_CHARS = 200_000;
export const TEXT_MAX = 1000;
export const LABEL_MAX = 20;
export const VALUE_MAX = 100;
export const DELAY_MAX_SECONDS = 7 * 86400;

export type LlmChannel = "instagram" | "messenger" | "whatsapp";
export type LlmOperator = "equals" | "contains" | "not_equals" | "exists";
export type LlmOption = { id: string; label: string };
export type LlmNode =
  | { id: string; type: "trigger"; data: { channel: LlmChannel } }
  | { id: string; type: "message"; data: { text: string } }
  | { id: string; type: "question"; data: { text: string; options: LlmOption[] } }
  | { id: string; type: "delay"; data: { seconds: number } }
  | { id: string; type: "condition"; data: { variable: string; operator: LlmOperator; value: string } }
  | { id: string; type: "end" };
export type LlmEdge = { source: string; target: string; sourceHandle: string };
export type LlmFlow = { nodes: LlmNode[]; edges: LlmEdge[] };

/** First sentence is mandated verbatim by the product brief; schema appended. */
export const SYSTEM_PROMPT_HEAD =
  "You are an expert flow builder. Return ONLY a valid JSON object with `{ nodes: [], edges: [] }`. Do not use markdown.";

export const SCHEMA_DESCRIPTION = `
Schema:
- nodes: array (1..${LLM_MAX_NODES}) of objects { "id": string (letters, digits, _ or -, max 64), "type": one of the kinds below, "data": object }.
  - { "type": "trigger", "data": { "channel": "instagram" | "messenger" | "whatsapp" } } exactly ONE, the root of the flow.
  - { "type": "message", "data": { "text": string (max ${TEXT_MAX} chars) } }
  - { "type": "question", "data": { "text": string (max ${TEXT_MAX}), "options": [ { "id": string, "label": string (max ${LABEL_MAX} chars) } ] (1..${LLM_MAX_OPTIONS}) } }
  - { "type": "delay", "data": { "seconds": integer 1..${DELAY_MAX_SECONDS} } }
  - { "type": "condition", "data": { "variable": string (letters, digits, _; e.g. "message"), "operator": "equals" | "contains" | "not_equals" | "exists", "value": string (max ${VALUE_MAX}; "" for exists) } }
  - { "type": "end" } (no data, no outgoing edges)
- edges: array (0..${LLM_MAX_EDGES}) of { "source": node id, "target": node id, "sourceHandle": string }.
  - trigger, message and delay use sourceHandle "next".
  - question uses the option id as sourceHandle; every option needs exactly one edge.
  - condition uses "true" and "false"; both need an edge.
  - Never an edge into the trigger, never a self-loop, at most one edge per (source, sourceHandle).
  - Every node must be reachable from the trigger and every path must end in an "end" node.
- Write all user-facing text in the same language as the description. Plain text only: no HTML, no markdown, no links in labels or values.
- Do not add positions or any other fields.`;

export const SYSTEM_PROMPT = SYSTEM_PROMPT_HEAD + "\n" + SCHEMA_DESCRIPTION;

export type ValidationResult = { ok: true; flow: LlmFlow } | { ok: false; reason: string };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// C0/C1 controls (except \n and \t in text), plus bidi overrides/isolates and zero-width marks.
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
const CONTROL_ALL_RE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
const HTML_RE = /<\s*\/?\s*[A-Za-z!?][^>]*>|<\s*script|&lt;|&#/i;
const SCRIPT_URL_RE = /\b(?:javascript|vbscript|data)\s*:/i;
const TEXT_SCRIPT_RE = /\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*[a-z]+\/[a-z0-9.+-]+[;,]/i;
const URL_RE = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|me|ly|co|app|xyz)\b)/i;

const len = (s: string) => [...s].length;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

class Reject extends Error {}
const fail = (reason: string): never => { throw new Reject(reason); };

/** Free text (message/question body): controls stripped, no HTML/script URLs, bounded. */
function cleanText(v: unknown, field: string): string {
  if (typeof v !== "string") fail(field + ":type");
  const s = (v as string).replace(CONTROL_TEXT_RE, "").replace(/\r\n?/g, "\n").trim();
  if (!s) fail(field + ":empty");
  if (len(s) > TEXT_MAX) fail(field + ":too_long");
  if (HTML_RE.test(s) || TEXT_SCRIPT_RE.test(s)) fail(field + ":markup");
  return s;
}

/** Short fields (labels, values): single line, no markup, no URLs at all. */
function cleanShort(v: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof v !== "string") fail(field + ":type");
  const s = (v as string).replace(CONTROL_ALL_RE, "").replace(/\s+/g, " ").trim();
  if (!s && !allowEmpty) fail(field + ":empty");
  if (len(s) > max) fail(field + ":too_long");
  if (/[<>]/.test(s) || SCRIPT_URL_RE.test(s) || URL_RE.test(s)) fail(field + ":markup");
  return s;
}

function cleanId(v: unknown, field: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) fail(field + ":id");
  return v as string;
}

const RESERVED_HANDLES = new Set(["next", "true", "false", "yes", "no", "in", "valid", "invalid", "success", "error"]);

function readNode(raw: unknown, index: number): LlmNode {
  if (!isObj(raw)) fail(`node${index}:type`);
  const n = raw as Record<string, unknown>;
  const id = cleanId(n.id, `node${index}`);
  const d = n.data === undefined ? {} : n.data;
  if (!isObj(d)) fail(`node${index}:data`);
  const data = d as Record<string, unknown>;
  switch (n.type) {
    case "trigger": {
      const c = data.channel;
      if (c !== "instagram" && c !== "messenger" && c !== "whatsapp") fail(`node${index}:channel`);
      return { id, type: "trigger", data: { channel: c as LlmChannel } };
    }
    case "message":
      return { id, type: "message", data: { text: cleanText(data.text, `node${index}.text`) } };
    case "question": {
      const text = cleanText(data.text, `node${index}.text`);
      if (!Array.isArray(data.options) || data.options.length < 1 || data.options.length > LLM_MAX_OPTIONS)
        fail(`node${index}:options`);
      const seen = new Set<string>();
      const options = (data.options as unknown[]).map((o, i) => {
        if (!isObj(o)) fail(`node${index}.option${i}`);
        const oo = o as Record<string, unknown>;
        const oid = cleanId(oo.id, `node${index}.option${i}`);
        if (seen.has(oid) || RESERVED_HANDLES.has(oid)) fail(`node${index}.option${i}:dup`);
        seen.add(oid);
        return { id: oid, label: cleanShort(oo.label, `node${index}.option${i}.label`, LABEL_MAX) };
      });
      return { id, type: "question", data: { text, options } };
    }
    case "delay": {
      const s = data.seconds;
      if (typeof s !== "number" || !Number.isInteger(s) || s < 1 || s > DELAY_MAX_SECONDS) fail(`node${index}:seconds`);
      return { id, type: "delay", data: { seconds: s as number } };
    }
    case "condition": {
      const variable = data.variable;
      if (typeof variable !== "string" || !VARIABLE_RE.test(variable) || variable.startsWith("__") ||
          variable === "constructor" || variable === "prototype") fail(`node${index}:variable`);
      const op = data.operator;
      if (op !== "equals" && op !== "contains" && op !== "not_equals" && op !== "exists") fail(`node${index}:operator`);
      const value = op === "exists"
        ? (data.value === undefined || data.value === null ? "" : cleanShort(data.value, `node${index}.value`, VALUE_MAX, true))
        : cleanShort(data.value, `node${index}.value`, VALUE_MAX);
      return { id, type: "condition", data: { variable: variable as string, operator: op as LlmOperator, value } };
    }
    case "end":
      return { id, type: "end" };
    default:
      return fail(`node${index}:kind`);
  }
}

function handlesOf(n: LlmNode): Set<string> {
  switch (n.type) {
    case "trigger": case "message": case "delay": return new Set(["next"]);
    case "question": return new Set(n.data.options.map(o => o.id));
    case "condition": return new Set(["true", "false"]);
    case "end": return new Set();
  }
}

/** Strict structural validation of an already-parsed value. */
export function validateLlmFlow(raw: unknown): ValidationResult {
  try {
    if (!isObj(raw)) fail("root:type");
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.nodes) || !Array.isArray(r.edges)) fail("root:arrays");
    const rawNodes = r.nodes as unknown[], rawEdges = r.edges as unknown[];
    if (rawNodes.length < 1 || rawNodes.length > LLM_MAX_NODES) fail("nodes:count");
    if (rawEdges.length > LLM_MAX_EDGES) fail("edges:count");
    const nodes = rawNodes.map(readNode);
    const byId = new Map<string, LlmNode>();
    for (const n of nodes) {
      if (byId.has(n.id)) fail("nodes:duplicate_id");
      byId.set(n.id, n);
    }
    const triggers = nodes.filter(n => n.type === "trigger");
    if (triggers.length !== 1) fail("nodes:trigger_count");
    const used = new Set<string>();
    const edges: LlmEdge[] = rawEdges.map((e, i) => {
      if (!isObj(e)) fail(`edge${i}:type`);
      const ee = e as Record<string, unknown>;
      const source = cleanId(ee.source, `edge${i}.source`), target = cleanId(ee.target, `edge${i}.target`);
      const from = byId.get(source), to = byId.get(target);
      if (!from || !to) fail(`edge${i}:dangling`);
      if (source === target) fail(`edge${i}:self_loop`);
      if (to!.type === "trigger") fail(`edge${i}:into_trigger`);
      const handle = ee.sourceHandle === undefined || ee.sourceHandle === null ? "next" : ee.sourceHandle;
      if (typeof handle !== "string" || !handlesOf(from!).has(handle)) fail(`edge${i}:handle`);
      const sig = source + "\u0000" + handle;
      if (used.has(sig)) fail(`edge${i}:duplicate_handle`);
      used.add(sig);
      return { source, target, sourceHandle: handle as string };
    });
    // The trigger is the root: every node is reachable from it.
    const adj = new Map<string, string[]>();
    for (const e of edges) adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
    const seen = new Set<string>();
    const stack = [triggers[0].id];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const t of adj.get(id) ?? []) stack.push(t);
    }
    if (seen.size !== nodes.length) fail("graph:unreachable");
    return { ok: true, flow: { nodes, edges } };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, reason: e.message };
    return { ok: false, reason: "internal" };
  }
}

/** Defensive parse of raw model text: optional code fence stripped, strict JSON.parse. */
export function parseLlmText(text: unknown): ValidationResult {
  if (typeof text !== "string") return { ok: false, reason: "text:type" };
  if (text.length > LLM_MAX_RAW_CHARS) return { ok: false, reason: "text:too_long" };
  let s = text.trim();
  const fence = /^```[A-Za-z]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(s);
  if (fence) s = fence[1].trim();
  let parsed: unknown;
  try { parsed = JSON.parse(s); } catch { return { ok: false, reason: "text:json" }; }
  return validateLlmFlow(parsed);
}
