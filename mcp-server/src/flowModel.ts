/**
 * Node/edge JSON shape used by the Milanochat Flow Builder.
 *
 * Mirrors (read-only port, no import) src/flow/model.ts: makeNode/makeNodeBase defaults, LABELS,
 * outputs(), edgeFor()/upsertConnection() labels, and the clamps applied by cleanImported()
 * (which importFlow() runs on every load). Anything built here must survive
 * importFlow({version:3,name,nodes,edges}) unchanged; test/frontend-compat.test.mjs checks that
 * against the real frontend module.
 */
import { randomUUID } from "node:crypto";

export type Kind =
  | "trigger" | "message" | "question" | "condition" | "delay"
  | "action" | "randomizer" | "goto" | "request" | "end";

/** Node kinds this server can create (brief's node_type values map 1:1 onto data.kind). */
export const CREATABLE_KINDS = ["message", "question", "delay", "condition", "end"] as const;
export type CreatableKind = (typeof CREATABLE_KINDS)[number];

export const LIMITS = {
  nodes: 100, edges: 250, position: 1e5, title: 120, text: 2000, options: 12, optionLabel: 100,
  name: 100, conditionField: 100, conditionValue: 250, inputField: 64,
} as const;

/** Copied verbatim from src/flow/model.ts LABELS. */
export const LABELS: Record<Kind, string> = {
  trigger: "بداية الأتمتة", message: "إرسال رسالة", question: "سؤال وجمع بيانات",
  condition: "شرط", delay: "انتظار ذكي", action: "إجراء",
  randomizer: "توزيع عشوائي", goto: "الانتقال لخطوة", request: "طلب خارجي", end: "نهاية",
};

export type Choice = {
  id: string; label: string; weight?: number;
  buttonType?: "button" | "quick_reply"; action?: string; targetFlowId?: string; url?: string;
};
export type FlowData = Record<string, unknown> & { kind: Kind; title: string; text: string; options: Choice[]; inputMode?: string };
export type FlowNode = { id: string; type: "flowNode"; position: { x: number; y: number }; data: FlowData };
export type FlowEdge = {
  id: string; type: "flowEdge"; source: string; target: string;
  sourceHandle: string; targetHandle: "in"; data: { label: string };
};

export const newId = (): string => randomUUID();

/** Option in exactly the form cleanImported() produces for a plain "go to step" button. */
export function makeOption(label: string, id: string = newId()): Choice {
  return { id, label: label.slice(0, LIMITS.optionLabel), buttonType: "button", action: "step", targetFlowId: "", url: "" };
}

/** Equivalent of makeNode(kind, position, opts) from the frontend, normalized like cleanImported(). */
export function makeNode(kind: Kind, position: { x: number; y: number }, opts: Partial<FlowData> = {}): FlowNode {
  const data: FlowData = {
    kind, title: LABELS[kind],
    text: kind === "message" ? "أهلاً بيك! شلون نكدر نساعدك؟" : kind === "question" ? "اختار شتحتاج" : "",
    image: "",
    options: kind === "question" ? [makeOption("الأسعار"), makeOption("موظف")] : [],
    contentBlocks: [], platform: "instagram", keywords: "", triggerMode: "keyword",
    commentScope: "all", commentPostId: "", commentMatchType: "any", publicReplyText: "",
    inputMode: "buttons", inputField: "response",
    conditionField: "message", operator: "contains", conditionValue: "",
    delayValue: 1, delayUnit: "minutes", actionType: "tag", actionValue: "",
    gotoNode: "", requestMethod: "GET", requestUrl: "",
    ...opts,
  };
  if (!("commentMatchType" in opts) || (opts.commentMatchType !== "any" && opts.commentMatchType !== "keyword"))
    data.commentMatchType = String(data.keywords || "").trim() ? "keyword" : "any";
  return { id: newId(), type: "flowNode", position: { x: position.x, y: position.y }, data };
}

/** Same seed as blankFlow(name, fromScratch=true) in src/flow/library.ts; importFlow rejects empty node lists. */
export function makeTriggerNode(): FlowNode {
  return makeNode("trigger", { x: 420, y: 60 }, { title: "بداية المحادثة", triggerMode: "message", keywords: "" });
}

/** Port of outputs() from src/flow/model.ts: the valid source handles of a node. */
export function outputs(node: FlowNode): Array<{ id: string; label: string }> {
  const d = node.data;
  const options = Array.isArray(d.options) ? d.options : [];
  const step = options.filter(o => !o.action || o.action === "step");
  if (d.kind === "end" || d.kind === "goto") return [];
  if (d.kind === "question") return d.inputMode === "buttons" ? step : [{ id: "valid", label: "التالي" }, { id: "invalid", label: "مسار قديم غير مستخدم" }];
  if (d.kind === "message") return [{ id: "next", label: "التالي" }, ...step];
  if (d.kind === "condition") return [{ id: "yes", label: "نعم" }, { id: "no", label: "لا" }];
  if (d.kind === "request") return [{ id: "success", label: "نجاح" }, { id: "error", label: "خطأ" }];
  if (d.kind === "randomizer") return options;
  return [{ id: "next", label: "التالي" }];
}

/** Handles this server allows when connecting ('invalid' is a legacy port the live engine ignores). */
export function connectableOutputs(node: FlowNode): Array<{ id: string; label: string }> {
  return outputs(node).filter(o => !(node.data.kind === "question" && o.id === "invalid"));
}

export function makeEdge(source: string, target: string, sourceHandle: string, label: string): FlowEdge {
  return { id: newId(), type: "flowEdge", source, target, sourceHandle, targetHandle: "in", data: { label: label.slice(0, 100) } };
}

/** Field-name rule the live engine applies to collected answers (liveFieldNameProblem in model.ts). */
export function fieldNameProblem(name: string): string {
  if (name.toLowerCase() === "message") return "the name 'message' is reserved";
  if (name.startsWith("__")) return "must not start with __";
  if (name === "constructor" || name === "prototype") return "reserved word";
  if (name.length > 64) return "longer than 64 characters";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return "use English letters, digits and _ only, not starting with a digit";
  return "";
}
