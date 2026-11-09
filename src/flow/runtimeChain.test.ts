import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeFor, makeNode } from "./model.ts";
import type { FlowDocument, FlowNode } from "./model.ts";
import { createRuntimeState } from "./runtimePlan.ts";
import {
  planUntilWait, seedFromEventKey, randomizerField, MAX_CHAIN_EFFECTS,
  collectedFields, renderCollectedTemplate, MAX_RENDERED_BYTES, FIRST_NAME_FALLBACK, MISSING_VALUE_FALLBACK
} from "./runtimeChain.ts";

const input = { eventKey: "mid.event.1", nowMs: 1750000000000, seed: seedFromEventKey("mid.event.1") };
function doc(nodes: FlowNode[], wires: Array<[FlowNode, string, FlowNode]>): FlowDocument {
  return { version: 3, name: "chain", nodes, edges: wires.map(([a, port, b]) =>
    edgeFor({ source: a.id, sourceHandle: port, target: b.id, targetHandle: "in" })) };
}
const trigger = () => makeNode("trigger", { x: 0, y: 0 }, { triggerMode: "message" });
const text = (t: string) => makeNode("message", { x: 0, y: 0 }, { text: t, options: [] });

test("welcome -> menu chain is planned in order, tagged seq 0..n, and waits for the tap", () => {
  const t = trigger(), hi = text("Welcome");
  const menu = makeNode("message", { x: 0, y: 0 }, { text: "Pick", inputField: "menu",
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
  const ansA = text("You chose A"), ansB = text("You chose B");
  const wait = makeNode("delay", { x: 0, y: 0 }, { delayValue: 2, delayUnit: "days" });
  const follow = text("Follow-up"), end = makeNode("end", { x: 0, y: 0 });
  const flow = doc([t, hi, menu, ansA, ansB, wait, follow, end],
    [[t, "next", hi], [hi, "next", menu], [menu, "a", ansA], [menu, "b", ansB],
     [ansA, "next", wait], [ansB, "next", wait], [wait, "next", follow], [follow, "next", end]]);
  const original = JSON.stringify(flow);
  const start = planUntilWait(flow, createRuntimeState(flow, "f", 1), input);
  assert.equal(start.error, undefined);
  assert.equal(start.state.status, "awaiting_input");
  assert.deepEqual(start.effects.map(e => [e.kind, e.seq]), [["message", 0], ["question", 1]]);
  assert.equal((start.effects[0] as { text: string }).text, "Welcome");
  assert.equal(new Set(start.effects.map(e => e.idempotencyKey)).size, 2);
  // Tap: answer message and delay in ONE plan; the chosen button id is stored.
  const tap = planUntilWait(flow, start.state, { ...input, eventKey: "mid.tap", answer: "b" });
  assert.equal(tap.state.status, "sleeping");
  assert.deepEqual(tap.effects.map(e => [e.kind, e.seq]), [["message", 0], ["delay", 1]]);
  assert.equal((tap.effects[0] as { text: string }).text, "You chose B");
  assert.deepEqual(tap.state.variables, { menu: "b" });
  // Wake: follow-up then end.
  const woke = planUntilWait(flow, tap.state, { ...input, eventKey: "scheduled:r", nowMs: tap.state.wakeAt! });
  assert.equal(woke.state.status, "completed");
  assert.deepEqual(woke.effects.map(e => [e.kind, e.seq, (e as { text?: string }).text]), [["message", 0, "Follow-up"]]);
  assert.equal(JSON.stringify(flow), original, "document never mutated");
  // Stale button keeps the planner's error and changes nothing.
  const stale = planUntilWait(flow, start.state, { ...input, answer: "zzz" });
  assert.equal(stale.error, "unsupported button response");
  assert.deepEqual(stale.effects, []);
  assert.deepEqual(stale.state, start.state);
});

test("five effects are allowed; a sixth fails closed with no effects", () => {
  const t = trigger();
  const msgs = [1, 2, 3, 4, 5, 6].map(i => text("m" + i));
  const five = doc([t, ...msgs.slice(0, 5)], [[t, "next", msgs[0]], ...msgs.slice(0, 4).map((m, i) =>
    [m, "next", msgs[i + 1]] as [FlowNode, string, FlowNode])]);
  const ok = planUntilWait(five, createRuntimeState(five, "f", 1), input);
  assert.equal(ok.state.status, "completed");
  assert.deepEqual(ok.effects.map(e => e.seq), [0, 1, 2, 3, 4]);
  assert.equal(ok.effects.length, MAX_CHAIN_EFFECTS);
  const six = doc([t, ...msgs], [[t, "next", msgs[0]], ...msgs.slice(0, 5).map((m, i) =>
    [m, "next", msgs[i + 1]] as [FlowNode, string, FlowNode])]);
  const over = planUntilWait(six, createRuntimeState(six, "f", 1), input);
  assert.equal(over.state.status, "blocked");
  assert.match(over.error ?? "", /exceeds 5 effects/);
  assert.deepEqual(over.effects, []);
});

test("goto loops fail closed (message loop and control-only loop)", () => {
  const t = trigger(), m = text("again");
  const back = makeNode("goto", { x: 0, y: 0 }, { gotoNode: "" });
  back.data.gotoNode = m.id;
  const loop = doc([t, m, back], [[t, "next", m], [m, "next", back]]);
  const r = planUntilWait(loop, createRuntimeState(loop, "f", 1), input);
  assert.equal(r.state.status, "blocked");
  assert.equal(r.error, "flow loop detected");
  assert.deepEqual(r.effects, []);
  const g1 = makeNode("goto", { x: 0, y: 0 }), g2 = makeNode("goto", { x: 0, y: 0 });
  g1.data.gotoNode = g2.id; g2.data.gotoNode = g1.id;
  const spin = doc([t, g1, g2], [[t, "next", g1]]);
  const s = planUntilWait(spin, createRuntimeState(spin, "f", 1), input);
  assert.equal(s.state.status, "blocked");
  assert.ok(s.error);
  assert.deepEqual(s.effects, []);
});

test("randomizer is deterministic per event, varies across events, and is pinned in state", () => {
  const t = trigger();
  const rnd = makeNode("randomizer", { x: 0, y: 0 }, {
    options: [{ id: "left", label: "A", weight: 50 }, { id: "right", label: "B", weight: 50 }] });
  const l = text("L"), r = text("R");
  const wait = makeNode("delay", { x: 0, y: 0 }, { delayValue: 1, delayUnit: "minutes" });
  const cond = makeNode("condition", { x: 0, y: 0 }, { conditionField: randomizerField(rnd.id),
    operator: "equals", conditionValue: "left" });
  const yes = text("was left"), no = text("was right");
  const flow = doc([t, rnd, l, r, wait, cond, yes, no], [[t, "next", rnd], [rnd, "left", l], [rnd, "right", r],
    [l, "next", wait], [r, "next", wait], [wait, "next", cond], [cond, "yes", yes], [cond, "no", no]]);
  const run = (key: string) => planUntilWait(flow, createRuntimeState(flow, "f", 1),
    { eventKey: key, nowMs: input.nowMs, seed: seedFromEventKey(key) });
  const a = run("mid.same"), b = run("mid.same");
  assert.deepEqual(a, b, "same event -> same branch (retries are stable)");
  const branches = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const p = run("mid." + i);
    branches.add(p.state.variables[randomizerField(rnd.id)]);
    assert.equal((p.effects[0] as { text: string }).text,
      p.state.variables[randomizerField(rnd.id)] === "left" ? "L" : "R");
  }
  assert.deepEqual([...branches].sort(), ["left", "right"], "seed is not constant");
  // Resume after the wake uses the STORED branch, whatever the new seed is.
  const woke = planUntilWait(flow, a.state, { eventKey: "scheduled:x", nowMs: a.state.wakeAt!, seed: 1 });
  assert.equal((woke.effects[0] as { text: string }).text,
    a.state.variables[randomizerField(rnd.id)] === "left" ? "was left" : "was right");
  // A tampered stored value fails closed.
  const bad = planUntilWait(flow, { ...a.state, variables: { [randomizerField(rnd.id)]: "nope" } },
    { eventKey: "scheduled:x", nowMs: a.state.wakeAt!, seed: 1 });
  assert.equal(bad.state.status, "blocked");
  assert.deepEqual(bad.effects, []);
});

test("set_field drives a condition; inbound text never enters variables", () => {
  const t = trigger();
  const set = makeNode("action", { x: 0, y: 0 }, { actionType: "set_field", actionValue: "tier=gold" });
  const cond = makeNode("condition", { x: 0, y: 0 }, { conditionField: "tier", operator: "equals", conditionValue: "gold" });
  const yes = text("gold"), no = text("other");
  const flow = doc([t, set, cond, yes, no], [[t, "next", set], [set, "next", cond], [cond, "yes", yes], [cond, "no", no]]);
  const p = planUntilWait(flow, createRuntimeState(flow, "f", 1), input);
  assert.deepEqual(p.effects.map(e => (e as { text: string }).text), ["gold"]);
  assert.deepEqual(p.state.variables, { tier: "gold" });
  // A button input field named "message" is never written.
  const q = makeNode("question", { x: 0, y: 0 }, { text: "?", inputMode: "buttons", inputField: "message",
    options: [{ id: "x", label: "X" }] });
  const after = text("ok");
  const f2 = doc([t, q, after], [[t, "next", q], [q, "x", after]]);
  const s = planUntilWait(f2, createRuntimeState(f2, "f", 1), input);
  const tap = planUntilWait(f2, s.state, { ...input, eventKey: "tap", answer: "x" });
  assert.deepEqual(tap.state.variables, {});
  assert.equal(tap.state.status, "completed");
});

test("typed answer is stored under inputField, renders {{field}} in later texts and drives a condition", () => {
  const t = trigger();
  const ask = makeNode("question", { x: 0, y: 0 }, { text: "Your email?", inputMode: "email", inputField: "email", options: [] });
  const thanks = text("Thanks {{email}}, {{first_name}} gets the fallback");
  const cond = makeNode("condition", { x: 0, y: 0 }, { conditionField: "email", operator: "contains", conditionValue: "@vip." });
  const vip = text("VIP for {{email}}"), std = text("Standard");
  const flow = doc([t, ask, thanks, cond, vip, std],
    [[t, "next", ask], [ask, "valid", thanks], [thanks, "next", cond], [cond, "yes", vip], [cond, "no", std]]);
  const original = JSON.stringify(flow);
  const start = planUntilWait(flow, createRuntimeState(flow, "f", 1), input);
  assert.equal(start.state.status, "awaiting_input");
  assert.deepEqual(start.effects.map(e => [e.kind, (e as { inputMode?: string }).inputMode, e.seq]), [["question", "email", 0]]);
  const answered = planUntilWait(flow, start.state, { ...input, eventKey: "answer", answer: "sara@vip.example" });
  assert.equal(answered.state.status, "completed");
  assert.deepEqual(answered.state.variables, { email: "sara@vip.example" });
  assert.deepEqual(answered.effects.map(e => [(e as { text: string }).text, e.seq]),
    [["Thanks sara@vip.example, عميلنا العزيز gets the fallback", 0], ["VIP for sara@vip.example", 1]]);
  const other = planUntilWait(flow, start.state, { ...input, eventKey: "answer2", answer: "ali@shop.example" });
  assert.deepEqual(other.effects.map(e => (e as { text: string }).text),
    ["Thanks ali@shop.example, عميلنا العزيز gets the fallback", "Standard"]);
  assert.equal(JSON.stringify(flow), original, "document not mutated");
  // Planner refusal of an empty answer keeps the run waiting (no effects).
  const empty = planUntilWait(flow, start.state, { ...input, eventKey: "e", answer: "   " });
  assert.equal(empty.error, "invalid customer answer");
  assert.equal(empty.state.status, "awaiting_input");
  assert.deepEqual(empty.effects, []);
});

test("template rendering is limited to collected fields, single pass and bounded", () => {
  const fields = collectedFields({ version: 3, name: "x", edges: [], nodes: [
    makeNode("question", { x: 0, y: 0 }, { inputMode: "text", inputField: "name" }),
    makeNode("question", { x: 0, y: 0 }, { inputMode: "number", inputField: "age" }),
    makeNode("question", { x: 0, y: 0 }, { inputMode: "buttons", inputField: "menu" }),
    makeNode("question", { x: 0, y: 0 }, { inputMode: "phone", inputField: "message" })
  ] });
  assert.deepEqual([...fields], ["name"], "number/buttons/'message' fields are never rendered");
  assert.equal(renderCollectedTemplate("Hi {{name}} {{age}} {{menu}}", { name: "Ali", age: "3", menu: "a" }, fields),
    "Hi Ali [غير متوفر] [غير متوفر]", "uncollected placeholders never stay literal");
  assert.equal(renderCollectedTemplate("Hi {{name}}!", {}, fields), "Hi !", "missing value = empty, like the simulator");
  assert.equal(renderCollectedTemplate("{{name}}", { name: "{{name}}{{name}}" }, fields), "{{name}}{{name}}", "no recursion");
  const long = renderCollectedTemplate("س {{name}}", { name: "ع".repeat(600) }, fields);
  assert.ok(new TextEncoder().encode(long).byteLength <= MAX_RENDERED_BYTES);
  assert.ok(long.startsWith("س ع"));
  // A document without typed questions: no placeholder is sent literally.
  const t = trigger(), m = text("Hello {{name}}");
  const plain = doc([t, m], [[t, "next", m]]);
  assert.equal((planUntilWait(plain, createRuntimeState(plain, "f", 1), input).effects[0] as { text: string }).text, "Hello [غير متوفر]");
});

test("internal actions: tag/untag/notify are chained in seq order, notify renders collected fields, handoff ends the run", () => {
  const t = trigger(), hi = text("Welcome");
  const ask = makeNode("question", { x: 0, y: 0 }, { text: "Email?", inputMode: "email", inputField: "email", options: [] });
  const tag = makeNode("action", { x: 0, y: 0 }, { actionType: "tag", actionValue: " lead " });
  const untag = makeNode("action", { x: 0, y: 0 }, { actionType: "untag", actionValue: "cold" });
  const notify = makeNode("action", { x: 0, y: 0 }, { actionType: "notify", actionValue: "New lead {{email}} {{first_name}}" });
  const bye = text("A human will reply");
  const human = makeNode("action", { x: 0, y: 0 }, { actionType: "handoff", actionValue: "" });
  const after = text("never planned");
  const flow = doc([t, hi, ask, tag, untag, notify, bye, human, after],
    [[t, "next", hi], [hi, "next", ask], [ask, "valid", tag], [tag, "next", untag], [untag, "next", notify],
     [notify, "next", bye], [bye, "next", human], [human, "next", after]]);
  const start = planUntilWait(flow, createRuntimeState(flow, "f", 1), input);
  assert.equal(start.state.status, "awaiting_input");
  const r = planUntilWait(flow, start.state, { ...input, eventKey: "mid.answer", answer: "ali@shop.example" });
  assert.equal(r.error, undefined);
  assert.equal(r.state.status, "handoff");
  assert.equal(r.state.nodeId, human.id, "the run stops AT the handoff; nothing after it is planned");
  assert.deepEqual(r.effects.map(e => [e.kind, e.seq]),
    [["tag", 0], ["untag", 1], ["staff_notification", 2], ["message", 3], ["handoff", 4]]);
  assert.equal((r.effects[0] as { tag: string }).tag, "lead");
  assert.equal((r.effects[2] as { text: string }).text, "New lead ali@shop.example {{first_name}}");
  assert.equal(new Set(r.effects.map(e => e.idempotencyKey)).size, 5);
  // A handoff run is terminal for the planner.
  assert.deepEqual(planUntilWait(flow, r.state, { ...input, eventKey: "mid.later" }).effects, []);
  // A sixth effect still fails closed (handoff counts towards the cap).
  const extra = text("one more");
  const six = doc([t, hi, ask, extra, tag, untag, notify, bye, human],
    [[t, "next", hi], [hi, "next", ask], [ask, "valid", extra], [extra, "next", tag], [tag, "next", untag],
     [untag, "next", notify], [notify, "next", bye], [bye, "next", human]]);
  const s6 = planUntilWait(six, start.state, { ...input, eventKey: "mid.answer", answer: "ali@shop.example" });
  assert.equal(s6.effects.length, 0);
  assert.match(String(s6.error), /exceeds 5 effects/);
});

test("internal actions: rendered notification text is bounded to 500 characters", () => {
  const t = trigger();
  const ask = makeNode("question", { x: 0, y: 0 }, { text: "Name?", inputMode: "text", inputField: "name", options: [] });
  const notify = makeNode("action", { x: 0, y: 0 }, { actionType: "notify", actionValue: "x".repeat(490) + "{{name}}" });
  const flow = doc([t, ask, notify], [[t, "next", ask], [ask, "valid", notify]]);
  const start = planUntilWait(flow, createRuntimeState(flow, "f", 1), input);
  const r = planUntilWait(flow, start.state, { ...input, eventKey: "mid.n", answer: "علي".repeat(20) });
  assert.equal(r.state.status, "completed");
  const body = (r.effects[0] as { text: string }).text;
  assert.equal(Array.from(body).length, 500);
  assert.ok(body.startsWith("x".repeat(490) + "علي"));
});

// ---- Text + image message nodes in a chain (message_image effects).
const IMG = "https://abcd1234.supabase.co/storage/v1/object/public/flow-media/u1/0f8c2b1e-1111-4222-8333-444455556666.webp";
const pic = (blocks: unknown[], t = "Our product {{name}}") =>
  makeNode("message", { x: 0, y: 0 }, { text: t, options: [], contentBlocks: blocks as never });
test("image message in a chain: block order kept, seq 0..n, each block counts toward the 5-effect limit", () => {
  const t = trigger(), hi = text("Welcome");
  const p = pic([{ id: "b1", type: "image", url: IMG }, { id: "b2", type: "text", text: "Price {{name}}" }]);
  const end = makeNode("end", { x: 0, y: 0 });
  const flow = doc([t, hi, p, end], [[t, "next", hi], [hi, "next", p], [p, "next", end]]);
  const plan = planUntilWait(flow, createRuntimeState(flow, "f", 1), input);
  assert.equal(plan.error, undefined);
  assert.equal(plan.state.status, "completed");
  assert.deepEqual(plan.effects.map(e => [e.kind, e.seq]),
    [["message", 0], ["message", 1], ["message_image", 2], ["message", 3]]);
  assert.deepEqual(plan.effects[2], { kind: "message_image", idempotencyKey: plan.effects[2].idempotencyKey,
    nodeId: p.id, url: IMG, seq: 2 }, "payload {url}, never rendered");
  assert.equal(new Set(plan.effects.map(e => e.idempotencyKey)).size, 4);
  // Over the limit: one more text before the image node -> 6 effects -> fail closed, no effects.
  const hi2 = text("Second"), hi3 = text("Third");
  const over = doc([t, hi, hi2, hi3, p, end],
    [[t, "next", hi], [hi, "next", hi2], [hi2, "next", hi3], [hi3, "next", p], [p, "next", end]]);
  const blocked = planUntilWait(over, createRuntimeState(over, "f", 1), input);
  assert.deepEqual(blocked.effects, []);
  assert.equal(blocked.error, "flow chain exceeds " + MAX_CHAIN_EFFECTS + " effects");
});
test("image message: collected fields render only in texts; a rich shape still fails the whole chain", () => {
  const t = trigger();
  const ask = makeNode("question", { x: 0, y: 0 }, { text: "Name?", inputMode: "text", inputField: "name", options: [] });
  const p = pic([{ id: "b1", type: "image", url: IMG }, { id: "b2", type: "text", text: "Hi {{name}}" }]);
  const flow = doc([t, ask, p], [[t, "next", ask], [ask, "valid", p]]);
  const first = planUntilWait(flow, createRuntimeState(flow, "f", 1), input);
  assert.equal(first.state.status, "awaiting_input");
  const reply = planUntilWait(flow, first.state, { ...input, eventKey: "mid.answer", answer: "Sara" });
  assert.equal(reply.error, undefined);
  assert.deepEqual(reply.effects.map(e => [e.kind, "text" in e ? e.text : (e as { url: string }).url, e.seq]),
    [["message", "Our product Sara", 0], ["message_image", IMG, 1], ["message", "Hi Sara", 2]]);
  // pdf in the same node: the chain fails with no effects (as before).
  const bad = pic([{ id: "b1", type: "pdf", url: IMG }, { id: "b2", type: "image", url: IMG }]);
  const hi = text("Welcome");
  const f2 = doc([t, hi, bad], [[t, "next", hi], [hi, "next", bad]]);
  const r = planUntilWait(f2, createRuntimeState(f2, "f", 1), input);
  assert.deepEqual(r.effects, []);
  assert.equal(r.error, "rich message requires a verified sender");
});

// ---- {{first_name}} (editor button "+ اسم العميل") is never sent literally.
const texts = (p: { effects: unknown[] }) =>
  p.effects.filter(e => typeof (e as { text?: unknown }).text === "string").map(e => (e as { text: string }).text);
const noLiteralFirstName = (p: { effects: unknown[] }) =>
  texts(p).forEach(t => assert.doesNotMatch(t, /\{\{\s*first_name\s*\}\}/));
test("first_name: uncollected -> fallback in message and question effects; other placeholders -> generic fallback", () => {
  assert.equal(FIRST_NAME_FALLBACK, "عميلنا العزيز");
  const t = trigger(), hi = text("أهلاً {{first_name}}، {{ first_name }} {{name}} {{رقم الهاتف}}");
  const plainNode = text("بدون متغيرات");
  const ask = makeNode("question", { x: 0, y: 0 }, { text: "كيف نخدمك يا {{first_name}}؟", inputMode: "text", inputField: "need", options: [] });
  const flow = doc([t, hi, plainNode, ask], [[t, "next", hi], [hi, "next", plainNode], [plainNode, "next", ask]]);
  const p = planUntilWait(flow, createRuntimeState(flow, "f", 1), input);
  assert.equal(p.error, undefined);
  assert.deepEqual(texts(p), [
    "أهلاً عميلنا العزيز، عميلنا العزيز [غير متوفر] [غير متوفر]", "بدون متغيرات", "كيف نخدمك يا عميلنا العزيز؟"]);
  noLiteralFirstName(p);
  // Button message (question effect) and a doc with NO collected fields at all.
  const menu = makeNode("message", { x: 0, y: 0 }, { text: "اختر يا {{first_name}}", inputField: "menu",
    options: [{ id: "a", label: "A" }] });
  const f2 = doc([t, menu], [[t, "next", menu]]);
  const q = planUntilWait(f2, createRuntimeState(f2, "f", 1), input);
  assert.deepEqual(q.effects.map(e => [e.kind, (e as { text: string }).text]), [["question", "اختر يا عميلنا العزيز"]]);
  // set_field first_name is not a collected answer: fallback (never the raw set value).
  const set = makeNode("action", { x: 0, y: 0 }, { actionType: "set_field", actionValue: "first_name=Ali" });
  const m = text("Hi {{first_name}}");
  const f3 = doc([t, set, m], [[t, "next", set], [set, "next", m]]);
  assert.deepEqual(texts(planUntilWait(f3, createRuntimeState(f3, "f", 1), input)), ["Hi عميلنا العزيز"]);
});
test("first_name: collected answer is used; before the answer the fallback is used", () => {
  const t = trigger(), before = text("مرحباً {{first_name}}");
  const ask = makeNode("question", { x: 0, y: 0 }, { text: "ما اسمك؟", inputMode: "text", inputField: "first_name", options: [] });
  const after = text("شكراً {{first_name}} و {{ first_name }}");
  const flow = doc([t, before, ask, after], [[t, "next", before], [before, "next", ask], [ask, "valid", after]]);
  const start = planUntilWait(flow, createRuntimeState(flow, "f", 1), input);
  assert.deepEqual(texts(start), ["مرحباً عميلنا العزيز", "ما اسمك؟"]);
  const answered = planUntilWait(flow, start.state, { ...input, eventKey: "a", answer: "  سارة " });
  assert.deepEqual(answered.state.variables, { first_name: "سارة" });
  assert.deepEqual(texts(answered), ["شكراً سارة و سارة"]);
  noLiteralFirstName(start); noLiteralFirstName(answered);
  // Direct: collected but empty value -> fallback; text without "{{" is returned as-is.
  const fields = new Set(["first_name", "email"]);
  assert.equal(renderCollectedTemplate("Hi {{first_name}} {{email}}", { first_name: "" }, fields), "Hi عميلنا العزيز ");
  assert.equal(renderCollectedTemplate("Hi {{first_name}}", { first_name: "Ali" }, fields), "Hi Ali");
  const same = "نص عادي بلا متغيرات";
  assert.equal(renderCollectedTemplate(same, {}, fields), same);
  // Collected names also render with inner whitespace (never literal).
  assert.equal(renderCollectedTemplate("{{ email }} {{email}}", { email: "a@b.co" }, fields), "a@b.co a@b.co");
  // Staff opt-out keeps the previous behaviour.
  assert.equal(renderCollectedTemplate("New {{first_name}}", {}, new Set(), { firstNameFallback: false }), "New {{first_name}}");
});
test("first_name: website-button text and image-message texts get the fallback; notify stays as before", () => {
  const t = trigger();
  const card = makeNode("message", { x: 0, y: 0 }, { text: "تفضل يا {{first_name}}", platform: "instagram",
    options: [{ id: "w", label: "متجرنا", buttonType: "button", action: "website", url: "https://example.org/p" }] });
  const f1 = doc([t, card], [[t, "next", card]]);
  const w = planUntilWait(f1, createRuntimeState(f1, "f", 1), input);
  assert.equal(w.error, undefined);
  assert.deepEqual(texts(w), ["تفضل يا عميلنا العزيز"]);
  assert.ok((w.effects[0] as { websiteButtons?: unknown }).websiteButtons);
  const p = pic([{ id: "b1", type: "image", url: IMG }, { id: "b2", type: "text", text: "سعر خاص لـ {{first_name}}" }],
    "منتجنا يا {{first_name}}");
  const notify = makeNode("action", { x: 0, y: 0 }, { actionType: "notify", actionValue: "عميل {{first_name}}" });
  const f2 = doc([t, p, notify], [[t, "next", p], [p, "next", notify]]);
  const r = planUntilWait(f2, createRuntimeState(f2, "f", 1), input);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.effects.map(e => [e.kind, "text" in e ? e.text : (e as { url: string }).url]),
    [["message", "منتجنا يا عميلنا العزيز"], ["message_image", IMG], ["message", "سعر خاص لـ عميلنا العزيز"],
     ["staff_notification", "عميل {{first_name}}"]]);
});
test("first_name: fallback growth is clamped to MAX_RENDERED_BYTES like collected values", () => {
  const enc = new TextEncoder();
  const raw = "ع".repeat(493) + "{{first_name}}";
  assert.equal(enc.encode(raw).byteLength, 1000, "raw text is exactly at the stored limit");
  const t = trigger(), m = text(raw);
  const flow = doc([t, m], [[t, "next", m]]);
  const out = texts(planUntilWait(flow, createRuntimeState(flow, "f", 1), input))[0];
  assert.ok(enc.encode(out).byteLength <= MAX_RENDERED_BYTES);
  assert.equal(out, "ع".repeat(493) + "عميلنا ", "cut on a code point boundary, never a literal placeholder");
  assert.doesNotMatch(out, /\{\{/);
});
// ---- No placeholder of any kind ({{first_name}}, ASCII, Arabic) reaches a customer (V3).
const LEAK = /\{\{[^{}\r\n]*\}\}/;
test("placeholders: collected values win, every other placeholder gets a fallback (texts)", () => {
  assert.equal(MISSING_VALUE_FALLBACK, "[غير متوفر]");
  const t = trigger();
  const ask = makeNode("question", { x: 0, y: 0 }, { text: "عمرك؟", inputMode: "text", inputField: "age", options: [] });
  const after = text("أهلاً {{first_name}}، عمرك {{ age }}، {{رقم الهاتف}} {{اسم العميل}} {{name}}");
  const flow = doc([t, ask, after], [[t, "next", ask], [ask, "valid", after]]);
  const start = planUntilWait(flow, createRuntimeState(flow, "f", 1), input);
  const done = planUntilWait(flow, start.state, { ...input, eventKey: "b", answer: "٣٠" });
  assert.deepEqual(texts(done), ["أهلاً عميلنا العزيز، عمرك ٣٠، [غير متوفر] [غير متوفر] [غير متوفر]"]);
  // Uncollected (no answer yet / not collected): never literal.
  const fields = new Set(["age"]);
  assert.equal(renderCollectedTemplate("{{age}} {{first_name}} {{رقم الهاتف}}", {}, fields),
    " عميلنا العزيز [غير متوفر]");
  for (const out of [...texts(start), ...texts(done)]) assert.doesNotMatch(out, LEAK);
  // Arabic collected field names are impossible: model.ts liveFieldNameProblem allows [a-zA-Z_][a-zA-Z0-9_]*;
  // an Arabic name in the fields set would still be resolved by its trimmed name.
  assert.equal(renderCollectedTemplate("{{ الاسم }}", { "الاسم": "سارة" }, new Set(["الاسم"])), "سارة");
});
test("placeholders: quick-reply choices and website-button titles are rendered, clipped to 20, URLs untouched", () => {
  const t = trigger();
  const ask = makeNode("question", { x: 0, y: 0 }, { text: "اسمك؟", inputMode: "text", inputField: "first_name", options: [] });
  const menu = makeNode("message", { x: 0, y: 0 }, { text: "اختر", inputField: "menu", options: [
    { id: "a", label: "{{first_name}}" }, { id: "b", label: "{{رقم الهاتف}} {{a}}" }, { id: "c", label: "عادي" }] });
  const flow = doc([t, ask, menu], [[t, "next", ask], [ask, "valid", menu]]);
  const start = planUntilWait(flow, createRuntimeState(flow, "f", 1), input);
  const q = planUntilWait(flow, start.state, { ...input, eventKey: "c", answer: "سارة" });
  const choices = (q.effects[0] as { choices: string[]; choiceIds: string[] });
  assert.deepEqual(choices.choices, ["سارة", "[غير متوفر] [غير متو", "عادي"]);
  assert.deepEqual(choices.choiceIds, ["a", "b", "c"]);
  for (const c of choices.choices) { assert.ok([...c].length <= 20 && c.length <= 20); assert.doesNotMatch(c, LEAK); }
  // Without placeholders the effect object is the planner's (identity on labels).
  const plainMenu = makeNode("message", { x: 0, y: 0 }, { text: "اختر", inputField: "menu", options: [{ id: "a", label: "A" }] });
  const f0 = doc([t, plainMenu], [[t, "next", plainMenu]]);
  assert.deepEqual((planUntilWait(f0, createRuntimeState(f0, "f", 1), input).effects[0] as { choices: string[] }).choices, ["A"]);
  // Website buttons (Instagram): text <= 640 code points after rendering, label rendered, url unchanged.
  const url = "https://example.org/p?x={{age}}";
  const card = makeNode("message", { x: 0, y: 0 }, { text: "n".repeat(633) + "{{age}}", platform: "instagram",
    options: [{ id: "w", label: "{{age}}", buttonType: "button", action: "website", url }] });
  const f1 = doc([t, card], [[t, "next", card]]);
  const w = planUntilWait(f1, createRuntimeState(f1, "f", 1), input);
  assert.equal(w.error, undefined);
  const e = w.effects[0] as { text: string; websiteButtons: { label: string; url: string }[] };
  assert.equal([...e.text].length, 640);
  assert.equal(e.text, "n".repeat(633) + "[غير مت", "1000-byte cut first, then the 640 card limit");
  assert.deepEqual(e.websiteButtons, [{ label: "[غير متوفر]", url }]);
  // Messenger generic card: title <= 80.
  const fb = makeNode("message", { x: 0, y: 0 }, { text: "م".repeat(75) + "{{x}}", platform: "messenger",
    options: [{ id: "w", label: "متجر", buttonType: "button", action: "website", url: "https://example.org" }] });
  const f2 = doc([t, fb], [[t, "next", fb]]);
  const m = planUntilWait(f2, createRuntimeState(f2, "f", 1), input);
  assert.equal(m.error, undefined);
  const me = m.effects[0] as { text: string; websiteButtons: { label: string }[] };
  assert.equal(me.text, "م".repeat(75) + "[غير ");
  assert.equal(me.websiteButtons[0].label, "متجر");
});
