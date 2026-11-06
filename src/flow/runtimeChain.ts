import type { FlowDocument, FlowNode } from "./model.ts";
import { planRuntimeTransition, type PlannedEffect, type RuntimeInput, type RuntimeState } from "./runtimePlan.ts";
import { chooseWeightedPort } from "./simulation.ts";

/**
 * Pure multi-step planner for the durable engine. Never performs IO.
 *
 * planRuntimeTransition stops with status "ready" after every message, so a
 * chain (welcome -> menu, message -> delay, ...) needs repeated planning. This
 * wrapper repeats it until the run waits (sleeping / awaiting_input) or ends
 * (completed), and returns ONE combined plan that a single database commit
 * stores atomically. Fail closed:
 *  - at most MAX_CHAIN_EFFECTS effects (flow_commit_run_step accepts 5); a
 *    6th needed effect returns an error plan with NO effects;
 *  - a goto/branch loop is detected (same node with the same variables seen
 *    twice in one chain) and bounded by MAX_CHAIN_CALLS planner calls;
 *  - any planner error is returned as-is with NO effects.
 * Each effect is tagged with `seq` 0..4 (its order inside this commit) so the
 * Outbox can dispatch effects of one run strictly in order. A text+image
 * message node yields several effects (node text, then its blocks in order:
 * "message" / "message_image"); each counts toward MAX_CHAIN_EFFECTS. Image
 * URLs are never rendered. Sending images stays gated server-side
 * (FLOW_MEDIA_SEND_ENABLED in milan-api and flow-outbox-worker); this planner
 * reads no environment.
 *
 * State that must stay stable across resumes and retries is stored in the
 * run variables (never inbound customer text):
 *  - randomizer outcome: variables[randomizerField(node.id)] = option id,
 *    chosen from the per-event seed and reused on every later pass;
 *  - tapped step button: variables[node.inputField] = option id (only when
 *    inputField is a valid, non-"message" field name);
 *  - text/email/phone question: variables[node.inputField] = the answer the
 *    caller already validated and normalized (planRuntimeTransition stores it).
 * Message/question texts and staff notification texts get {{field}}
 * rendering for those collected fields only (renderCollectedTemplate); the
 * simulator is not affected. Tag names are never rendered.
 * A handoff ends the chain (status "handoff"); it is always the last effect.
 */
export const MAX_CHAIN_EFFECTS = 5;
export const MAX_CHAIN_CALLS = MAX_CHAIN_EFFECTS + 1;

export type ChainEffect = PlannedEffect & { seq: number };
export type ChainPlan = { state: RuntimeState; effects: ChainEffect[]; error?: string };

const FIELD = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const reservedField = (name: string) =>
  !FIELD.test(name) || name.startsWith("__") || name.toLowerCase() === "message" ||
  name === "constructor" || name === "prototype";

/** 32-bit FNV-1a: deterministic, dependency-free, non-negative safe integer. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** Randomizer seed derived from the provider event (or scheduled wake) key. */
export function seedFromEventKey(eventKey: string): number {
  return hash32("flow-seed:" + eventKey);
}
/** Run variable that pins a randomizer's chosen branch for this run. */
export function randomizerField(nodeId: string): string {
  return "random_" + hash32(nodeId).toString(16).padStart(8, "0");
}

function blocked(state: RuntimeState, error: string): ChainPlan {
  return { state: { ...state, status: "blocked" }, effects: [], error };
}

/**
 * Returns a copy of the document in which every randomizer is replaced by an
 * equivalent set_field step that records the chosen option id and continues
 * to that option's target. The choice is the stored one when present, else a
 * deterministic roll from (seed, node id). null = invalid stored choice.
 */
function pinRandomizers(doc: FlowDocument, variables: Record<string, string>, seed: number): FlowDocument | null {
  const randomizers = doc.nodes.filter(n => n.data.kind === "randomizer");
  if (!randomizers.length) return doc;
  const replaced = new Map<string, { node: FlowNode; target: string | null }>();
  for (const node of randomizers) {
    const field = randomizerField(node.id);
    const options = node.data.options;
    const stored = Object.prototype.hasOwnProperty.call(variables, field) ? variables[field] : undefined;
    if (stored !== undefined && !options.some(o => o.id === stored)) return null;
    const port = stored ?? chooseWeightedPort(options, seed, hash32(node.id) & 0x7fffffff);
    const target = doc.edges.find(e => e.source === node.id && (e.sourceHandle || "next") === port)?.target ?? null;
    replaced.set(node.id, {
      target,
      node: target ? {
        ...node,
        data: { ...node.data, kind: "action", actionType: "set_field", actionValue: field + "=" + port }
      } : {
        // No destination: keep a randomizer that the planner rejects
        // ("randomizer branch not connected"): fail closed.
        ...node, data: { ...node.data, options: [] }
      }
    });
  }
  return {
    ...doc,
    nodes: doc.nodes.map(n => replaced.get(n.id)?.node ?? n),
    edges: [
      ...doc.edges.filter(e => !replaced.has(e.source)),
      ...[...replaced].filter(([, r]) => r.target).map(([id, r]) => ({
        id: "pinned-" + id, source: id, target: r.target!, sourceHandle: "next"
      }))
    ]
  } as FlowDocument;
}

/** Records the tapped step button id under the node's input field (never inbound text). */
function withButtonChoice(doc: FlowDocument, state: RuntimeState, answer: string | undefined): RuntimeState {
  if (state.status !== "awaiting_input" || typeof answer !== "string") return state;
  const node = doc.nodes.find(n => n.id === state.nodeId);
  if (!node) return state;
  const buttons = node.data.kind === "message" ? node.data.options.length > 0 :
    node.data.kind === "question" && node.data.inputMode === "buttons";
  if (!buttons) return state;
  const selected = node.data.options.find(o => o.id === answer || o.label === answer);
  const field = typeof node.data.inputField === "string" ? node.data.inputField : "";
  if (!selected || (selected.action && selected.action !== "step") || reservedField(field)) return state;
  return { ...state, variables: { ...state.variables, [field]: selected.id } };
}

/** Typed-answer question modes the durable engine collects (never number/buttons). */
export const COLLECTED_INPUT_MODES = ["text", "email", "phone"] as const;
/** Max UTF-8 bytes of one rendered message/question text (Instagram text limit). */
export const MAX_RENDERED_BYTES = 1000;
/** Field names written by text/email/phone questions of this document (valid names only). */
export function collectedFields(doc: FlowDocument): Set<string> {
  const out = new Set<string>();
  for (const n of doc.nodes) {
    const d = n.data;
    if (d.kind === "question" && (COLLECTED_INPUT_MODES as readonly string[]).includes(d.inputMode) &&
        typeof d.inputField === "string" && !reservedField(d.inputField)) out.add(d.inputField);
  }
  return out;
}
/** Cuts to at most `max` UTF-8 bytes on a code point boundary. */
function clipBytes(text: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).byteLength <= max) return text;
  let out = "", used = 0;
  for (const ch of text) {
    const n = enc.encode(ch).byteLength;
    if (used + n > max) break;
    out += ch; used += n;
  }
  return out;
}
/**
 * Durable-only template rendering, same placeholder syntax as the simulator
 * ({{field}}). ONLY fields collected by this document's text/email/phone
 * questions are replaced (missing value = empty, like the simulator); any
 * other placeholder (e.g. {{first_name}}) stays literal exactly as before.
 * Single pass (a value containing "{{x}}" is never expanded) and bounded.
 */
export function renderCollectedTemplate(text: string, variables: Record<string, string>, fields: Set<string>): string {
  if (!fields.size || !text.includes("{{")) return text;
  const rendered = text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    if (!fields.has(name)) return whole;
    const v = Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : "";
    return typeof v === "string" ? v : "";
  });
  return clipBytes(rendered, MAX_RENDERED_BYTES);
}
/** Max characters of a staff notification body (flow_staff_notifications CHECK 1..500). */
export const MAX_NOTIFICATION_CHARS = 500;
function rendered(effect: PlannedEffect, variables: Record<string, string>, fields: Set<string>): PlannedEffect {
  if (effect.kind === "staff_notification") {
    // Same collected-field rule as messages; bounded to the stored body limit
    // (code points, like PostgreSQL length()).
    const r = renderCollectedTemplate(effect.text, variables, fields);
    const text = Array.from(r).slice(0, MAX_NOTIFICATION_CHARS).join("");
    return text === effect.text ? effect : { ...effect, text };
  }
  if ((effect.kind !== "message" && effect.kind !== "question") || "source" in effect) return effect;
  const text = renderCollectedTemplate(effect.text, variables, fields);
  return text === effect.text ? effect : { ...effect, text };
}

/** Plans until the run waits or ends. Pure: never mutates doc, state or input. */
export function planUntilWait(doc: FlowDocument, previous: RuntimeState, input: RuntimeInput): ChainPlan {
  const effects: ChainEffect[] = [];
  const seen = new Set<string>();
  const fields = collectedFields(doc);
  let state = withButtonChoice(doc, previous, input.answer);
  for (let call = 0; call < MAX_CHAIN_CALLS; call++) {
    const pinned = pinRandomizers(doc, state.variables, input.seed);
    if (!pinned) return blocked(previous, "invalid stored randomizer branch");
    const plan = planRuntimeTransition(pinned, state,
      call === 0 ? input : { eventKey: input.eventKey, nowMs: input.nowMs, seed: input.seed });
    if (plan.error) {
      // First call: keep the planner's own result (callers map e.g. a stale
      // button to free text); later calls: never commit a partial chain.
      if (call === 0) return { state: plan.state.status === "blocked" ? plan.state : previous, effects: [], error: plan.error };
      return { state: plan.state, effects: [], error: plan.error };
    }
    for (const effect of plan.effects) {
      if (effects.length >= MAX_CHAIN_EFFECTS)
        return blocked(previous, "flow chain exceeds " + MAX_CHAIN_EFFECTS + " effects");
      // Variables at this effect = the state the call returned (message and
      // question nodes end the call right after emitting their effect).
      effects.push({ ...rendered(effect, plan.state.variables, fields), seq: effects.length } as ChainEffect);
    }
    state = plan.state;
    if (state.status !== "ready") return { state, effects };
    const marker = state.nodeId + "|" + JSON.stringify(Object.entries(state.variables).sort());
    if (seen.has(marker)) return blocked(previous, "flow loop detected");
    seen.add(marker);
  }
  return blocked(previous, "flow chain step bound reached");
}
