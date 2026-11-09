// S1: bind_number can never take over another tenant's WhatsApp phone_id
// (supabase/functions/milan-api/waBinding.ts + its call site in index.ts).
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {bindWhatsappNumber, supabaseBindStore, BIND_CONFLICT_BODY, type BindStore} from "../supabase/functions/milan-api/waBinding.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Models wa_bindings(phone_id PK) with INSERT .. ON CONFLICT DO NOTHING; awaits interleave. */
function memStore(seed: Record<string, string> = {}, accounts: Array<{tenant_id: string; channel: string; external_id: string}> = []) {
  const rows = new Map(Object.entries(seed));
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
  const store: BindStore = {
    async foreignWhatsappAccount(p, t) { await tick(); return accounts.some((a) => a.channel === "whatsapp" && a.external_id === p && a.tenant_id !== t); },
    async insertIfAbsent(p, t) { await tick(); if (!rows.has(p)) rows.set(p, t); },
    async ownerOf(p) { await tick(); return rows.get(p) ?? null; },
  };
  return {rows, store};
}

/** The OLD index.ts behaviour: upsert onConflict phone_id (DO UPDATE). */
async function oldBind(rows: Map<string, string>, t: string, p: string) { rows.set(p, t); return {status: "bound"}; }

test("OLD behaviour let tenant B overwrite tenant A's phone_id (proof the test detects it)", async () => {
  const rows = new Map([["1000001", A]]);
  await oldBind(rows, B, "1000001");
  assert.equal(rows.get("1000001"), B);
});

test("tenant B cannot overwrite tenant A's binding: conflict, row unchanged", async () => {
  const {rows, store} = memStore({"1000001": A});
  assert.deepEqual(await bindWhatsappNumber(store, B, "1000001"), {status: "conflict"});
  assert.equal(rows.get("1000001"), A);
});

test("same tenant re-binding the same number is idempotent", async () => {
  const {rows, store} = memStore({"1000001": A});
  assert.deepEqual(await bindWhatsappNumber(store, A, "1000001"), {status: "bound"});
  assert.deepEqual(await bindWhatsappNumber(store, A, "1000001"), {status: "bound"});
  assert.equal(rows.get("1000001"), A);
  const fresh = memStore();
  assert.deepEqual(await bindWhatsappNumber(fresh.store, B, "2000002"), {status: "bound"});
  assert.equal(fresh.rows.get("2000002"), B);
});

test("concurrent binds of one new number by two tenants: exactly one wins", async () => {
  for (let round = 0; round < 50; round++) {
    const {rows, store} = memStore();
    const [ra, rb] = await Promise.all([bindWhatsappNumber(store, A, "3000003"), bindWhatsappNumber(store, B, "3000003")]);
    const wins = [ra, rb].filter((r) => r.status === "bound").length;
    assert.equal(wins, 1, `round ${round}`);
    const winner = ra.status === "bound" ? A : B;
    assert.equal(rows.get("3000003"), winner);
  }
});

test("a WhatsApp channel_accounts row of another tenant blocks the bind (nothing inserted)", async () => {
  const {rows, store} = memStore({}, [{tenant_id: A, channel: "whatsapp", external_id: "4000004"}]);
  assert.deepEqual(await bindWhatsappNumber(store, B, "4000004"), {status: "conflict"});
  assert.equal(rows.has("4000004"), false);
  assert.deepEqual(await bindWhatsappNumber(store, A, "4000004"), {status: "bound"});
});

test("store errors fail closed", async () => {
  const boom: BindStore = {
    foreignWhatsappAccount: async () => { throw new Error("x"); },
    insertIfAbsent: async () => {}, ownerOf: async () => A,
  };
  assert.deepEqual(await bindWhatsappNumber(boom, A, "1"), {status: "error"});
  const vanished = memStore();
  vanished.store.insertIfAbsent = async () => {};
  assert.deepEqual(await bindWhatsappNumber(vanished.store, A, "5"), {status: "error"});
});

test("supabase adapter issues INSERT .. ON CONFLICT DO NOTHING (ignoreDuplicates), never DO UPDATE", async () => {
  const log: any[] = [];
  const builder = (table: string) => {
    const q: any = {table, ops: [] as any[]};
    const chain = (name: string) => (...args: any[]) => { q.ops.push([name, ...args]); return q; };
    for (const m of ["select", "eq", "neq", "limit"]) q[m] = chain(m);
    q.upsert = (row: any, opts: any) => { q.ops.push(["upsert", row, opts]); log.push(q); return Promise.resolve({error: null}); };
    q.maybeSingle = () => { log.push(q); return Promise.resolve({data: {tenant_id: A}, error: null}); };
    q.then = (res: any) => { log.push(q); return Promise.resolve({data: [], error: null}).then(res); };
    return q;
  };
  const r = await bindWhatsappNumber(supabaseBindStore({from: builder}), A, "1000001");
  assert.deepEqual(r, {status: "bound"});
  const up = log.find((q) => q.table === "wa_bindings" && q.ops.some((o: any) => o[0] === "upsert"));
  const opts = up.ops.find((o: any) => o[0] === "upsert")[2];
  assert.deepEqual(opts, {onConflict: "phone_id", ignoreDuplicates: true});
  const ca = log.find((q) => q.table === "channel_accounts");
  assert.deepEqual(ca.ops.filter((o: any) => o[0] !== "select"),
    [["eq", "channel", "whatsapp"], ["eq", "external_id", "1000001"], ["neq", "tenant_id", A], ["limit", 1]]);
});

test("index.ts bind_number: uses the guarded bind, 409 body leaks nothing about the other tenant", () => {
  const s = readFileSync("supabase/functions/milan-api/index.ts", "utf8");
  const a = s.indexOf('case "bind_number": {');
  const b = s.slice(a, s.indexOf('case "wa_status": {', a));
  assert.match(b, /bindWhatsappNumber\(\n\s+supabaseBindStore\(sb\), tenant\.id, phoneId\n\s+\)/);
  assert.match(b, /return json\(BIND_CONFLICT_BODY, 409\);/);
  assert.doesNotMatch(b, /\.upsert\(/);
  assert.doesNotMatch(b, /onConflict/);
  assert.deepEqual(Object.keys(BIND_CONFLICT_BODY).sort(), ["code", "error"]);
  assert.match(BIND_CONFLICT_BODY.error, /الدعم/);
  assert.match(BIND_CONFLICT_BODY.error, /manual support/);
});
