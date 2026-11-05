import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeFor, makeNode } from "./model.ts";
import type { FlowDocument, FlowNode } from "./model.ts";
import { createRuntimeState } from "./runtimePlan.ts";
import {
  planUntilWait, seedFromEventKey, randomizerField, MAX_CHAIN_EFFECTS,
  collectedFields, renderCollectedTemplate, MAX_RENDERED_BYTES
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
  const thanks = text("Thanks {{email}}, {{first_name}} stays literal");
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
    [["Thanks sara@vip.example, {{first_name}} stays literal", 0], ["VIP for sara@vip.example", 1]]);
  const other = planUntilWait(flow, start.state, { ...input, eventKey: "answer2", answer: "ali@shop.example" });
  assert.deepEqual(other.effects.map(e => (e as { text: string }).text),
    ["Thanks ali@shop.example, {{first_name}} stays literal", "Standard"]);
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
    "Hi Ali {{age}} {{menu}}");
  assert.equal(renderCollectedTemplate("Hi {{name}}!", {}, fields), "Hi !", "missing value = empty, like the simulator");
  assert.equal(renderCollectedTemplate("{{name}}", { name: "{{name}}{{name}}" }, fields), "{{name}}{{name}}", "no recursion");
  const long = renderCollectedTemplate("س {{name}}", { name: "ع".repeat(600) }, fields);
  assert.ok(new TextEncoder().encode(long).byteLength <= MAX_RENDERED_BYTES);
  assert.ok(long.startsWith("س ع"));
  // A document without typed questions keeps placeholders verbatim (old behaviour).
  const t = trigger(), m = text("Hello {{name}}");
  const plain = doc([t, m], [[t, "next", m]]);
  assert.equal((planUntilWait(plain, createRuntimeState(plain, "f", 1), input).effects[0] as { text: string }).text, "Hello {{name}}");
});
