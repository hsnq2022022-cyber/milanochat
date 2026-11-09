/**
 * Pure, local-only traversal for the chat simulator. No network, no timers,
 * no store: given the document(s) and a cursor, it returns the transcript
 * events to play and the next cursor. The component adds typing/delay timing.
 */
import type { Choice, FlowData, FlowDocument, FlowNode } from "./model.ts";
import { chooseWeightedPort, MAX_SIMULATOR_STEPS, normalizeArabicDigits, validCustomerInput } from "./simulation.ts";
import { FIRST_NAME_FALLBACK, replacePlaceholders } from "./placeholders.ts";

export type SimEvent =
  | { type: "bot"; text: string; image?: string; file?: string; retry?: boolean }
  | { type: "user"; text: string }
  | { type: "system"; text: string; tone?: "info" | "success" | "warn"; link?: string }
  | { type: "delay"; text: string; ms: number };
export type InputMode = "text" | "email" | "phone" | "number";
export type SimWait =
  | { type: "choice"; nodeId: string; options: Choice[]; textEdge: boolean }
  | { type: "input"; nodeId: string; inputMode: InputMode; field: string; blockIndex?: number };
export type SimStatus = "waiting" | "end" | "deadend" | "stopped";
export type SimCursor = {
  flowId: string; status: SimStatus; wait?: SimWait;
  variables: Record<string, string>; stepCount: number; visited: string[];
};
export type SimContext = {
  doc: FlowDocument; flowId: string;
  flows?: ReadonlyArray<{ id: string; doc: FlowDocument }>;
  seed?: number;
};
export type SimInput = { type: "choice"; optionId: string } | { type: "text"; text: string };
export type SimResult = { events: SimEvent[]; cursor: SimCursor };

export const COMPLETED_TEXT = "✅ اكتملت المحاكاة";
export const DEAD_END_TEXT = "انتهى المسار هنا بدون خطوة تالية";
export const CHOOSE_OPTION_TEXT = "من فضلك اختر أحد الخيارات الظاهرة 👇";
const NAME_KEYS = new Set(["first_name", "name", "full_name", "الاسم"]);
const UNIT_MS: Record<FlowData["delayUnit"], number> = { seconds: 1e3, minutes: 6e4, hours: 36e5, days: 864e5 };
const UNIT_WORDS: Record<FlowData["delayUnit"], [string, string, string]> = {
  seconds: ["ثانية", "ثانيتين", "ثوانٍ"], minutes: ["دقيقة", "دقيقتين", "دقائق"],
  hours: ["ساعة", "ساعتين", "ساعات"], days: ["يوم", "يومين", "أيام"],
};

/** Arabic duration phrase using the node's real unit, e.g. «4 دقائق», «دقيقتين». */
export function durationLabel(value: number, unit: FlowData["delayUnit"]): string {
  const words = UNIT_WORDS[unit] || UNIT_WORDS.seconds;
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  if (n === 1) return words[0];
  if (n === 2) return words[1];
  if (Number.isInteger(n) && n >= 3 && n <= 10) return n + " " + words[2];
  return n + " " + words[0];
}
export const delayText = (value: number, unit: FlowData["delayUnit"]) => "⏳ ينتظر " + durationLabel(value, unit) + "…";

/** `{{name}}` placeholders (shared syntax). Names fall back politely; others become empty, never raw braces. */
export function interpolate(text: string, vars: Record<string, string>): string {
  return replacePlaceholders(text || "", name => {
    const value = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : "";
    if (value && value.trim()) return value;
    return NAME_KEYS.has(name) ? FIRST_NAME_FALLBACK : "";
  });
}

export function evaluateCondition(n: FlowNode, vars: Record<string, string>): boolean {
  const value = vars[n.data.conditionField] || "", test = n.data.conditionValue || "";
  if (n.data.operator === "exists") return !!value.trim();
  if (n.data.operator === "equals") return value.trim().toLocaleLowerCase() === test.trim().toLocaleLowerCase();
  if (n.data.operator === "not_equals") return value.trim().toLocaleLowerCase() !== test.trim().toLocaleLowerCase();
  return !!test && value.toLocaleLowerCase().includes(test.toLocaleLowerCase());
}

export const nextFor = (doc: FlowDocument, source: string, port: string): string | undefined =>
  doc.edges.find(e => e.source === source && (e.sourceHandle || "next") === port)?.target;

const RETRY: Record<InputMode, string> = {
  email: "يبدو أن البريد الإلكتروني غير صحيح 🙏 أرسله بهذا الشكل: name@example.com",
  phone: "رقم الهاتف غير صحيح 🙏 أرسله بالأرقام فقط (من 7 إلى 15 رقمًا).",
  number: "من فضلك أرسل رقمًا فقط، مثل 25.",
  text: "من فضلك اكتب إجابتك.",
};
const PROMPT: Record<InputMode, string> = {
  email: "أرسل بريدك الإلكتروني", phone: "أرسل رقم هاتفك", number: "أرسل رقمًا", text: "أرسل البيانات المطلوبة",
};
const ACTION_NOTE: Record<FlowData["actionType"], (v: string) => string> = {
  tag: v => "تم تنفيذ إجراء: إضافة وسم «" + v + "»",
  untag: v => "تم تنفيذ إجراء: إزالة وسم «" + v + "»",
  set_field: v => "تم تنفيذ إجراء: تعيين " + v,
  handoff: () => "تم تنفيذ إجراء: تحويل المحادثة إلى موظف",
  notify: () => "تم تنفيذ إجراء: إشعار الفريق",
  ai: () => "AI Step يتطلب ربط الذكاء الاصطناعي بالخادم. لم يُستدعَ نموذج حقيقي.",
};

const docFor = (ctx: SimContext, flowId: string): FlowDocument | undefined =>
  flowId === ctx.flowId ? ctx.doc : ctx.flows?.find(f => f.id === flowId)?.doc;
const asMode = (m: unknown): InputMode => (m === "email" || m === "phone" || m === "number" ? m : "text");

/** Walks from `start` until the flow waits for the customer, reaches End, dead-ends or hits the step cap. */
function run(ctx: SimContext, base: SimCursor, start: string | undefined, events: SimEvent[], resumeBlock?: number): SimCursor {
  const doc = docFor(ctx, base.flowId);
  const variables = { ...base.variables }, visited = [...base.visited];
  let stepCount = base.stepCount, at = start, resume = resumeBlock;
  const done = (status: SimStatus, wait?: SimWait): SimCursor => ({ flowId: base.flowId, status, wait, variables, stepCount, visited });
  const deadEnd = (hint?: string) => {
    if (hint) events.push({ type: "system", text: hint, tone: "warn" });
    events.push({ type: "system", text: DEAD_END_TEXT, tone: "warn" });
    return done("deadend");
  };
  if (!doc) { events.push({ type: "system", text: "التدفق المستهدف غير موجود.", tone: "warn" }); return done("stopped"); }
  while (true) {
    if (!at) return deadEnd();
    if (stepCount >= MAX_SIMULATOR_STEPS) {
      events.push({ type: "system", text: "توقف التنفيذ بعد " + MAX_SIMULATOR_STEPS + " خطوة لمنع حلقة لا نهائية.", tone: "warn" });
      return done("stopped");
    }
    const n = doc.nodes.find(item => item.id === at);
    if (!n) return deadEnd("خطوة غير موجودة في هذا التدفق.");
    stepCount++; visited.push(n.id);
    const d = n.data, follow = (port: string) => { at = nextFor(doc, n.id, port); };
    switch (d.kind) {
      case "trigger": follow("next"); continue;
      case "end": events.push({ type: "system", text: COMPLETED_TEXT, tone: "success" }); return done("end");
      case "condition": follow(evaluateCondition(n, variables) ? "yes" : "no"); continue;
      case "goto":
        if (!d.gotoNode || !doc.nodes.some(x => x.id === d.gotoNode)) return deadEnd("خطوة الانتقال غير موجودة.");
        at = d.gotoNode; continue;
      case "delay": {
        const value = Number(d.delayValue) || 0;
        events.push({ type: "delay", text: delayText(value, d.delayUnit), ms: Math.max(0, value * (UNIT_MS[d.delayUnit] || 1e3)) });
        follow("next"); continue;
      }
      case "action": {
        const value = (d.actionValue || "").trim();
        if (d.actionType === "set_field") {
          const [name, ...rest] = value.split("=");
          if (name.trim()) variables[name.trim()] = rest.join("=").trim();
        }
        events.push({ type: "system", text: (ACTION_NOTE[d.actionType] || ACTION_NOTE.tag)(value) });
        follow("next"); continue;
      }
      case "request": {
        // Never executed from the browser; the honest outcome is "not succeeded".
        events.push({ type: "system", text: "طلب " + (d.requestMethod || "GET") + " لم يُنفَّذ: لم يُنفذ HTTP من المتصفح. اختير مسار الخطأ التجريبي.", tone: "warn" });
        at = nextFor(doc, n.id, "error") ?? nextFor(doc, n.id, "success"); continue;
      }
      case "randomizer": {
        const port = chooseWeightedPort(d.options || [], ctx.seed ?? 42, stepCount);
        const label = d.options?.find(o => o.id === port)?.label;
        if (label) events.push({ type: "system", text: "توزيع عشوائي: المسار «" + label + "»" });
        follow(port); continue;
      }
      case "message": case "question": {
        if (resume === undefined && (d.text?.trim() || d.image))
          events.push({ type: "bot", text: interpolate(d.text || "", variables), image: d.image || undefined });
        const blocks = d.contentBlocks || [];
        for (let i = resume ?? 0; i < blocks.length; i++) {
          const b = blocks[i];
          if (b.type === "text" && b.text?.trim()) events.push({ type: "bot", text: interpolate(b.text, variables) });
          else if (b.type === "image" && b.url) events.push({ type: "bot", text: "", image: b.url });
          else if (b.type === "pdf" && b.url) events.push({ type: "bot", text: "ملف PDF مرفق", file: b.url });
          else if (b.type === "delay") {
            const s = Number(b.seconds) || 3;
            events.push({ type: "delay", text: delayText(s, "seconds"), ms: s * 1e3 });
          } else if (b.type === "collection") {
            const mode = asMode(b.inputMode);
            events.push({ type: "bot", text: interpolate(b.text?.trim() ? b.text : PROMPT[mode], variables) });
            return done("waiting", { type: "input", nodeId: n.id, inputMode: mode, field: (b.field || "response").trim() || "response", blockIndex: i });
          }
        }
        const collected = resume !== undefined || blocks.some(b => b.type === "collection");
        resume = undefined;
        if (d.kind === "question" && d.inputMode !== "buttons") {
          // A collection block already obtained the answer: never ask twice.
          if (collected) { follow("valid"); continue; }
          return done("waiting", { type: "input", nodeId: n.id, inputMode: asMode(d.inputMode), field: (d.inputField || "response").trim() || "response" });
        }
        if (d.kind === "question" || (d.options || []).length > 0) {
          if (!(d.options || []).length) return deadEnd("لا توجد خيارات في هذا السؤال.");
          return done("waiting", { type: "choice", nodeId: n.id, options: d.options, textEdge: d.kind === "message" && !!nextFor(doc, n.id, "next") });
        }
        follow("next"); continue;
      }
      default: return deadEnd();
    }
  }
}

/** Begins a fresh conversation; `triggerMessage` is the customer's opening message. */
export function startSimulation(ctx: SimContext, triggerMessage = ""): SimResult {
  const events: SimEvent[] = [];
  const msg = triggerMessage.trim();
  if (msg) events.push({ type: "user", text: msg });
  const base: SimCursor = { flowId: ctx.flowId, status: "stopped", variables: { message: msg }, stepCount: 0, visited: [] };
  const trigger = ctx.doc.nodes.find(n => n.data.kind === "trigger");
  if (!trigger) {
    events.push({ type: "system", text: "أضف خطوة بداية لتجربة التدفق.", tone: "warn" });
    return { events, cursor: base };
  }
  return { events, cursor: run(ctx, base, trigger.id, events) };
}

/** Applies one customer reply. Outside a waiting state nothing happens (never a fake completion). */
export function respond(ctx: SimContext, cursor: SimCursor, input: SimInput): SimResult {
  const events: SimEvent[] = [];
  const wait = cursor.wait;
  if (cursor.status !== "waiting" || !wait) return { events, cursor };
  const doc = docFor(ctx, cursor.flowId);
  const node = doc?.nodes.find(n => n.id === wait.nodeId);
  if (!doc || !node) return { events, cursor };
  const variables = { ...cursor.variables };

  if (wait.type === "choice") {
    let option: Choice | undefined;
    if (input.type === "choice") option = wait.options.find(o => o.id === input.optionId);
    else {
      const typed = input.text.trim();
      if (!typed) return { events, cursor };
      option = wait.options.find(o => o.label.trim().toLocaleLowerCase() === typed.toLocaleLowerCase());
      if (!option) {
        events.push({ type: "user", text: typed });
        variables.message = typed;
        if (wait.textEdge) return { events, cursor: run(ctx, { ...cursor, variables }, nextFor(doc, node.id, "next"), events) };
        events.push({ type: "bot", text: CHOOSE_OPTION_TEXT, retry: true });
        return { events, cursor: { ...cursor, variables } };
      }
    }
    if (!option) return { events, cursor };
    events.push({ type: "user", text: interpolate(option.label, variables) });
    if (node.data.kind === "question") variables[(node.data.inputField || "response").trim() || "response"] = option.label;
    variables.message = option.label;
    const action = option.action || "step";
    if (action === "website") {
      const url = option.url || "";
      if (!/^https:\/\/\S+$/i.test(url)) events.push({ type: "system", text: "رابط الموقع غير صالح.", tone: "warn" });
      else events.push({ type: "system", text: "اضغط الرابط لفتح الموقع:", link: url });
      return { events, cursor: { ...cursor, variables } };
    }
    if (action === "flow") {
      const target = ctx.flows?.find(f => f.id === option!.targetFlowId);
      const trigger = target?.doc.nodes.find(n => n.data.kind === "trigger");
      if (!target || !trigger) {
        events.push({ type: "system", text: "التدفق المستهدف غير موجود. اختر تدفقًا صالحًا في إعداد الزر.", tone: "warn" });
        return { events, cursor: { ...cursor, variables, status: "stopped", wait: undefined } };
      }
      events.push({ type: "system", text: "انتقال إلى التدفق: " + target.doc.name });
      return { events, cursor: run(ctx, { ...cursor, variables, flowId: target.id }, trigger.id, events) };
    }
    if (action !== "step") {
      events.push({ type: "system", text: "إجراء " + action + " يحتاج تنفيذ الخادم؛ لا يُنفذ داخل المحاكاة.", tone: "warn" });
      return { events, cursor: { ...cursor, variables, status: "stopped", wait: undefined } };
    }
    const next = nextFor(doc, node.id, option.id);
    if (!next) {
      events.push({ type: "system", text: "هذا الزر غير مرتبط بخطوة. اختر وجهته من إعداد الزر.", tone: "warn" });
      events.push({ type: "system", text: DEAD_END_TEXT, tone: "warn" });
      return { events, cursor: { ...cursor, variables, status: "deadend", wait: undefined } };
    }
    return { events, cursor: run(ctx, { ...cursor, variables }, next, events) };
  }

  // Typed input (question or collection block).
  const answer = input.type === "text" ? input.text.trim() : "";
  if (!answer) return { events, cursor };
  events.push({ type: "user", text: answer });
  if (!validCustomerInput(wait.inputMode, answer)) {
    events.push({ type: "bot", text: RETRY[wait.inputMode], retry: true });
    return { events, cursor };
  }
  const stored = wait.inputMode === "number" || wait.inputMode === "phone" ? normalizeArabicDigits(answer) : answer;
  variables[wait.field] = stored;
  variables.message = stored;
  const base = { ...cursor, variables };
  if (wait.blockIndex !== undefined) return { events, cursor: run(ctx, base, node.id, events, wait.blockIndex + 1) };
  return { events, cursor: run(ctx, base, nextFor(doc, node.id, "valid"), events) };
}
