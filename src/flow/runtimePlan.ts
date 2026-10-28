import type { FlowDocument, FlowNode } from "./model";
import { chooseWeightedPort, validCustomerInput } from "./simulation.ts";

export const MAX_RUNTIME_STEPS = 150;
export const MAX_TRANSITIONS_PER_TICK = 24;

export type RuntimeStatus = "ready" | "awaiting_input" | "sleeping" | "handoff" | "completed" | "blocked";
export type RuntimeState = {
  flowId: string;
  revision: number;
  nodeId: string;
  status: RuntimeStatus;
  stepCount: number;
  variables: Record<string, string>;
  wakeAt: number | null;
};
export type PlannedEffect =
  | { kind: "message"; idempotencyKey: string; nodeId: string; text: string }
  | { kind: "question"; idempotencyKey: string; nodeId: string; text: string; inputMode: string; choices: string[]; choiceIds: string[] }
  | { kind: "delay"; idempotencyKey: string; nodeId: string; wakeAt: number }
  | { kind: "handoff"; idempotencyKey: string; nodeId: string }
  | { kind: "tag" | "untag"; idempotencyKey: string; nodeId: string; tag: string }
  | { kind: "staff_notification"; idempotencyKey: string; nodeId: string; text: string }
  | { kind: "message"; idempotencyKey: string; nodeId: string; source: "knowledge_ai"; text: "" };
export type RuntimeInput = {
  eventKey: string;
  nowMs: number;
  seed: number;
  answer?: string;
};
export type RuntimePlan = {
  state: RuntimeState;
  effects: PlannedEffect[];
  error?: string;
};

/**
 * Pure execution planner. It must ONLY run after server-side publication, tenant,
 * platform permission and webhook signature checks. This module NEVER sends.
 * Persist the new state and an idempotent outbox entry in ONE database transaction.
 */
export function createRuntimeState(
  doc: FlowDocument, flowId: string, revision: number
): RuntimeState {
  const starts = doc.nodes.filter(node => node.data.kind === "trigger");
  if (doc.version !== 3 || starts.length !== 1 || !flowId ||
      !Number.isSafeInteger(revision) || revision < 1)
    throw new Error("invalid published flow or revision");
  return {
    flowId, revision, nodeId: starts[0].id, status: "ready", stepCount: 0,
    variables: {}, wakeAt: null
  };
}

function nextNode(doc: FlowDocument, node: FlowNode, port: string): string | null {
  return doc.edges.find(edge =>
    edge.source === node.id && (edge.sourceHandle || "next") === port
  )?.target ?? null;
}
function fail(state: RuntimeState, message: string): RuntimePlan {
  return { state: { ...state, status: "blocked" }, effects: [], error: message };
}
function proceed(state: RuntimeState, nodeId: string | null): RuntimeState {
  return { ...state, nodeId: nodeId ?? state.nodeId,
    status: nodeId ? "ready" : "completed", wakeAt: null };
}
function key(state: RuntimeState, input: RuntimeInput, nodeId: string): string {
  // لا يجوز اعتبار هذا المفتاح قفلاً في الذاكرة؛ قاعدة البيانات تطبّق UNIQUE.
  return JSON.stringify([state.flowId, state.revision, input.eventKey, state.stepCount, nodeId]);
}
function safeInput(input: RuntimeInput): boolean {
  return typeof input.eventKey === "string" && input.eventKey.length > 0 &&
    input.eventKey.length <= 256 && Number.isSafeInteger(input.nowMs) &&
    input.nowMs >= 0 && Number.isSafeInteger(input.seed);
}
function safeValue(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}
function validFieldName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(name) &&
    !name.startsWith("__") && name !== "constructor" && name !== "prototype";
}
function variablesFit(variables: Record<string,string>): boolean {
  return new TextEncoder().encode(JSON.stringify(variables)).length <= 32768;
}

/** Process a bounded amount of logic. Never perform IO or mutate input state/doc. */
export function planRuntimeTransition(
  doc: FlowDocument,
  previous: RuntimeState,
  input: RuntimeInput
): RuntimePlan {
  if (!safeInput(input) || doc.version !== 3 ||
      !Number.isSafeInteger(previous.revision) || previous.revision < 1 ||
      !Number.isSafeInteger(previous.stepCount) || previous.stepCount < 0)
    return fail(previous, "invalid runtime state or event");
  if (previous.status === "blocked" || previous.status === "completed" ||
      previous.status === "handoff") return { state: previous, effects: [] };
  let state: RuntimeState = { ...previous, variables: { ...previous.variables } };
  if (state.status === "sleeping") {
    if (state.wakeAt === null || !Number.isSafeInteger(state.wakeAt))
      return fail(state, "invalid wake-up timestamp");
    if (input.nowMs < state.wakeAt) return { state, effects: [] };
    const node = doc.nodes.find(n => n.id === state.nodeId);
    if (!node || node.data.kind !== "delay") return fail(state, "missing delay node");
    state = proceed(state, nextNode(doc, node, "next"));
    if (state.status === "completed") return { state, effects: [] };
  }
  if (state.status === "awaiting_input") {
    const node = doc.nodes.find(n => n.id === state.nodeId);
    if (!node || (node.data.kind !== "question" && node.data.kind !== "message"))
      return fail(state, "missing interactive node");
    if (node.data.kind === "message" && node.data.options.length===0)
      return fail(state, "missing buttons");
    if (typeof input.answer !== "string" || input.answer.length > 4096)
      return { state, effects: [], error: "customer answer required" };
    const mode = node.data.kind === "message" ? "buttons" : node.data.inputMode;
    let port: string;
    if (mode === "buttons") {
      const selected = node.data.options.find(o => o.id === input.answer || o.label === input.answer);
      if (!selected || (selected.action && selected.action !== "step"))
        return { state, effects: [], error: "unsupported button response" };
      port = selected.id;
    } else {
      if (!validCustomerInput(mode, input.answer))
        return { state, effects: [], error: "invalid customer answer" };
      if (!validFieldName(node.data.inputField))
        return fail(state, "invalid input field");
      const nextVars = {...state.variables,[node.data.inputField]:input.answer.trim()};
      if (!variablesFit(nextVars)) return fail(state,"runtime variables exceed storage limit");
      state = {...state,variables:nextVars};
      port = nextNode(doc, node, "valid") ? "valid" : "next";
    }
    const target = nextNode(doc, node, port);
    if (!target) return fail(state, "question has no supported destination");
    state = proceed(state, target);
  }

  for (let hops = 0; hops < MAX_TRANSITIONS_PER_TICK; hops++) {
    if (state.stepCount >= MAX_RUNTIME_STEPS) return fail(state, "execution step limit");
    const node = doc.nodes.find(n => n.id === state.nodeId);
    if (!node) return fail(state, "missing execution node");
    state = { ...state, stepCount: state.stepCount + 1 };
    const data = node.data;
    switch (data.kind) {
      case "trigger": {
        const next = nextNode(doc, node, "next");
        if (!next) return fail(state, "trigger not connected");
        state = proceed(state, next);
        break;
      }
      case "end":
        return { state: { ...state, status: "completed" }, effects: [] };
      case "message": {
        // الصور والأزرار وما شابهها تتطلب مرسلاً يدعمها؛ لا نتظاهر بأنها نُفذت.
        if (data.image || data.contentBlocks.length)
          return fail(state, "rich message requires a verified sender");
        if (data.options.some(o => (o.action && o.action!=="step") || !o.label.trim() || o.label.length>20 || o.id.length>128) ||
            data.options.length>13 || new Set(data.options.map(o=>o.id)).size!==data.options.length)
          return fail(state, "unsupported button action or blank label");
        const text = safeValue(data.text).trim();
        if (!text) return fail(state, "empty message");
        if(data.options.length>0){
          const effect: PlannedEffect = {kind:"question",
            idempotencyKey:key(state,input,node.id),nodeId:node.id,text,
            inputMode:"buttons",choices:data.options.map(o=>o.label),choiceIds:data.options.map(o=>o.id)};
          return {state:{...state,status:"awaiting_input"},effects:[effect]};
        }
        const effect: PlannedEffect = { kind: "message",
          idempotencyKey: key(state, input, node.id), nodeId: node.id, text };
        return { state: proceed(state, nextNode(doc, node, "next")), effects: [effect] };
      }
      case "question": {
        if (data.image || data.contentBlocks.length)
          return fail(state, "rich question is not supported");
        if (data.inputMode === "buttons" &&
            (data.options.length>13 || data.options.length<1 ||
             new Set(data.options.map(o=>o.id)).size!==data.options.length ||
             data.options.some(o => (o.action && o.action !== "step") || !o.label.trim() || o.label.length>20 || o.id.length>128)))
          return fail(state, "external button actions not yet supported");
        const effect: PlannedEffect = {
          kind: "question", idempotencyKey: key(state, input, node.id),
          nodeId: node.id, text: data.text,
          inputMode: data.inputMode,
          choices: data.inputMode === "buttons" ? data.options.map(o => o.label) : [],
          choiceIds: data.inputMode === "buttons" ? data.options.map(o => o.id) : []
        };
        return { state: { ...state, status: "awaiting_input" }, effects: [effect] };
      }
      case "condition": {
        const actual = safeValue(state.variables[data.conditionField]);
        const expected = safeValue(data.conditionValue);
        const yes = data.operator === "exists" ? Boolean(actual)
          : data.operator === "equals" ? actual === expected
          : data.operator === "not_equals" ? actual !== expected
          : data.operator === "contains" ? actual.includes(expected) : false;
        const next = nextNode(doc, node, yes ? "yes" : "no");
        if (!next) return fail(state, "condition branch not connected");
        state = proceed(state, next);
        break;
      }
      case "randomizer": {
        const port = chooseWeightedPort(data.options, input.seed, state.stepCount);
        const next = nextNode(doc, node, port);
        if (!next) return fail(state, "randomizer branch not connected");
        state = proceed(state, next);
        break;
      }
      case "goto": {
        const next = data.gotoNode;
        if (!next || !doc.nodes.some(n => n.id === next))
          return fail(state, "invalid goto destination");
        state = proceed(state, next);
        break;
      }
      case "delay": {
        const multipliers = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 };
        const ms = data.delayValue * multipliers[data.delayUnit];
        if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 30 * 86400000 ||
            !Number.isSafeInteger(input.nowMs + ms))
          return fail(state, "unsupported delay duration");
        const wakeAt = input.nowMs + ms;
        const effect: PlannedEffect = {
          kind: "delay", idempotencyKey: key(state, input, node.id),
          nodeId: node.id, wakeAt
        };
        return { state: { ...state, status: "sleeping", wakeAt }, effects: [effect] };
      }
      case "action": {
        if (data.actionType === "set_field") {
          // تخزين متغير محلي داخل سياق التنفيذ فقط، دون تعديل ملف العميل.
          const equalsAt = data.actionValue.indexOf("=");
          const field = data.actionValue.slice(0, equalsAt).trim();
          const value = data.actionValue.slice(equalsAt + 1).trim();
          if (equalsAt < 1 || !validFieldName(field) || value.length > 500)
            return fail(state, "invalid custom field assignment");
          const variables = { ...state.variables, [field]: value };
          if (!variablesFit(variables))
            return fail(state, "runtime variables exceed storage limit");
          state = proceed({ ...state, variables }, nextNode(doc, node, "next"));
          if (state.status === "completed") return { state, effects: [] };
          break;
        }
        if (data.actionType === "tag" || data.actionType === "untag") {
          const tag = data.actionValue.trim();
          if (!/^[\p{L}\p{N}_ -]{1,64}$/u.test(tag)) return fail(state,"invalid tag");
          const effect: PlannedEffect = {kind:data.actionType,
            idempotencyKey:key(state,input,node.id),nodeId:node.id,tag};
          return {state:proceed(state,nextNode(doc,node,"next")),effects:[effect]};
        }
        if (data.actionType === "notify") {
          const text = data.actionValue.trim();
          if (!text || text.length>500) return fail(state,"invalid notification");
          const effect: PlannedEffect = {kind:"staff_notification",
            idempotencyKey:key(state,input,node.id),nodeId:node.id,text};
          return {state:proceed(state,nextNode(doc,node,"next")),effects:[effect]};
        }
        if (data.actionType === "ai") {
          // A trusted server checks tenant, credit and evidence; the planner
          // does not invent a reply or call a model.
          const effect: PlannedEffect = {kind:"message",source:"knowledge_ai",text:"",
            idempotencyKey:key(state,input,node.id),nodeId:node.id};
          return {state:proceed(state,nextNode(doc,node,"next")),effects:[effect]};
        }
        if (data.actionType !== "handoff")
          return fail(state, "action needs explicit trusted server implementation");
        const effect: PlannedEffect = {
          kind: "handoff", idempotencyKey: key(state, input, node.id), nodeId: node.id
        };
        return { state: { ...state, status: "handoff" }, effects: [effect] };
      }
      case "request":
        return fail(state, "external request is disabled until allowlist and SSRF tests");
      default:
        return fail(state, "unsupported node kind");
    }
  }
  return fail(state, "too many synchronous transitions");
}
