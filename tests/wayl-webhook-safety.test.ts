// wayl-webhook: signature, size cap, strict validation, amount/currency fail-closed,
// idempotent single grant through the atomic RPC wayl_grant_topup_once (fail closed,
// no non-atomic fallback) and forward-only (replay-safe) state transitions.
// Fakes only: no network, no real DB, no real payments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleWaylWebhook, MAX_BODY_BYTES } from "../supabase/functions/wayl-webhook/handler.ts";
import { hmacHexOf, makeFakeDb, silentLog, type FakeDb } from "./wayl-payment-fakes.ts";

const SECRET = "unit-test-wayl-webhook-secret-0123456789abcdef";
const TENANT = "22222222-2222-4222-8222-222222222222";
const PAY_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";

const envOf = (over: Record<string, string | undefined> = {}) => {
  const e: Record<string, string | undefined> = {
    WAYL_WEBHOOK_SECRET: SECRET,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "disposable-test-only",
    ...over,
  };
  return (k: string) => e[k];
};

function world(payStatus = "created", extraPay: Record<string, unknown> = {}) {
  return makeFakeDb({
    payments: [{
      id: PAY_ID, tenant_id: TENANT, provider: "wayl", amount: 35000, currency: "IQD",
      status: payStatus, credits_granted: 0, paid_at: null,
      webhook_event: { source: "wayl-topup-v2", credits: 1000 }, ...extraPay,
    }],
    orders: [{ id: ORDER_ID, user_id: "u1", total: 50000, status: "pending_payment", paid_at: null }],
    tenants: [{ id: TENANT, credits_remaining: 5 }],
  });
}

async function call(db: FakeDb, body: unknown, opts: { sig?: string; raw?: string; env?: Record<string, string | undefined> } = {}) {
  const raw = opts.raw ?? JSON.stringify(body);
  const sig = opts.sig ?? await hmacHexOf(SECRET, raw);
  const { log, lines } = silentLog();
  const res = await handleWaylWebhook(
    new Request("https://example.com/wayl-webhook", {
      method: "POST", body: raw, headers: { "x-wayl-signature-256": sig },
    }),
    { env: envOf(opts.env), db: () => db, log, now: () => new Date("2026-01-01T00:00:00Z") },
  );
  return { res, status: res.status, text: await res.text(), lines };
}

const completed = (extra: Record<string, unknown> = {}) =>
  ({ referenceId: PAY_ID, paymentStatus: "Complete", total: 35000, ...extra });

const pay = (db: FakeDb) => db.tables.payments[0];
const order = (db: FakeDb) => db.tables.orders[0];
const credits = (db: FakeDb) => db.tables.tenants[0].credits_remaining;

const topupRpcs = (db: FakeDb) => db.rpcCalls.filter((c) => c.name === "wayl_grant_topup_once");
const paymentWrites = (db: FakeDb) => db.updates.filter((u) => u.table === "payments");
/** The old non-atomic path (claim UPDATE, then grant_credits) must never run. */
function assertNoLegacyPath(db: FakeDb) {
  assert.equal(db.rpcCalls.filter((c) => c.name !== "wayl_grant_topup_once").length, 0, "only the atomic RPC");
  assert.deepEqual(paymentWrites(db), [], "no direct payments write on a completed event");
}

test("valid signature + completed grants server-stored credits exactly once via ONE atomic RPC", async () => {
  const db = world();
  const body = completed();
  const r = await call(db, body);
  assert.equal(r.status, 200);
  assert.equal(r.text, "ok");
  assert.equal(credits(db), 1005);
  assert.equal(pay(db).status, "paid");
  assert.equal(pay(db).credits_granted, 1000);
  assert.deepEqual(db.rpcCalls, [{
    name: "wayl_grant_topup_once",
    args: { p_payment_id: PAY_ID, p_expected_amount: 35000, p_currency: "IQD", p_event: body },
  }]);
  assertNoLegacyPath(db);
});

test("sequential duplicate callbacks grant once", async () => {
  const db = world();
  for (let i = 0; i < 3; i++) assert.equal((await call(db, completed())).status, 200);
  assert.equal(topupRpcs(db).length, 1); // later callbacks see 'paid' and stop before the RPC
  assert.equal(credits(db), 1005);
  assertNoLegacyPath(db);
});

test("pre-payment states written by topup-create (creating / pending_payment / creation_uncertain) are payable", async () => {
  for (const st of ["creating", "pending_payment", "creation_uncertain"]) {
    const db = world(st);
    assert.equal((await call(db, completed())).status, 200, st);
    assert.equal(credits(db), 1005, st);
    assert.equal(pay(db).status, "paid", st);
    assertNoLegacyPath(db);
  }
});

test("concurrent duplicate callbacks grant exactly once (the RPC serialises them)", async () => {
  const db = world();
  db.barrier = { table: "payments", count: 5 }; // all 5 read 'created' before any RPC
  const rs = await Promise.all(Array.from({ length: 5 }, () => call(db, completed())));
  for (const r of rs) assert.equal(r.status, 200);
  assert.equal(topupRpcs(db).length, 5, "every racer reached the RPC");
  assert.equal(credits(db), 1005, "exactly one grant");
  assert.equal(pay(db).credits_granted, 1000);
  assert.equal(rs.filter((r) => r.lines.some((l) => l.includes("granted 1000 credits"))).length, 1);
  assertNoLegacyPath(db);
});

test("client-supplied credits/tenant in the signed body are ignored", async () => {
  const db = world();
  const body = completed({ credits: 999999, tenant_id: "attacker", p_credits: 5, webhook_event: { credits: 7 } });
  await call(db, body);
  assert.deepEqual(Object.keys(topupRpcs(db)[0].args).sort(),
    ["p_currency", "p_event", "p_expected_amount", "p_payment_id"], "no tenant / credits argument");
  assert.equal(topupRpcs(db)[0].args.p_expected_amount, 35000);
  assert.equal(credits(db), 1005);
  assert.equal(pay(db).credits_granted, 1000);
  assert.equal((pay(db).webhook_event as Record<string, unknown>).credits, 1000);
  assertNoLegacyPath(db);
});

test("replayed cancelled after paid does not change payment state", async () => {
  const db = world();
  await call(db, completed());
  const before = structuredClone(pay(db));
  const r = await call(db, { referenceId: PAY_ID, paymentStatus: "Cancelled" });
  assert.equal(r.status, 200);
  assert.deepEqual(pay(db), before);
  // and a re-sent completed after that still does not re-grant
  await call(db, completed());
  assert.equal(topupRpcs(db).length, 1);
  assert.equal(credits(db), 1005);
});

test("fake payments table enforces the live status CHECK (23514)", async () => {
  type Q = PromiseLike<{ error: { code: string } | null }> & {
    update(p: Record<string, unknown>): Q;
    insert(r: Record<string, unknown>): Q;
    eq(col: string, val: unknown): Q;
  };
  const db = world();
  const up = await (db.from("payments") as Q).update({ status: "cancelled" }).eq("id", PAY_ID);
  assert.equal(up.error?.code, "23514");
  assert.equal(pay(db).status, "created", "rejected statement changes nothing");
  const ins = await (db.from("payments") as Q).insert({ id: "x", status: "pending" });
  assert.equal(ins.error?.code, "23514");
  assert.equal(db.tables.payments.length, 1);
});

for (const wayl of ["Cancelled", "Rejected"]) {
  test(`${wayl} on a 'created' payment: 200, stored as 'failed', Wayl status kept, no credits; replay idempotent`, async () => {
    const db = world();
    const body = { referenceId: PAY_ID, paymentStatus: wayl };
    const r = await call(db, body);
    assert.equal(r.status, 200);
    assert.equal(r.text, "ok");
    assert.equal(pay(db).status, "failed");
    const ev = pay(db).webhook_event as Record<string, unknown>;
    assert.deepEqual(ev.wayl, body, "original Wayl status recorded");
    assert.equal(ev.credits, 1000, "server keys preserved");
    assert.equal(pay(db).credits_granted, 0);
    assert.equal(pay(db).paid_at, null);
    assert.equal(credits(db), 5);
    assert.equal(db.rpcCalls.length, 0, "never grants");
    const snap = structuredClone(db.tables);
    const r2 = await call(db, body); // replay of the same event
    assert.equal(r2.status, 200);
    assert.deepEqual(db.tables, snap, "replay is a no-op");
    assert.equal(db.rpcCalls.length, 0);
    // a later Complete on the failed row is not granted automatically
    await call(db, completed());
    assert.equal(db.rpcCalls.length, 0);
    assert.equal(credits(db), 5);
  });

  test(`${wayl} on a 'paid' payment: 200, no downgrade, no grant`, async () => {
    const db = world("paid", { credits_granted: 1000, paid_at: "db-now" });
    const snap = structuredClone(db.tables);
    const r = await call(db, { referenceId: PAY_ID, paymentStatus: wayl });
    assert.equal(r.status, 200);
    assert.deepEqual(db.tables, snap, "paid row and tenant credits unchanged");
    assert.equal(db.rpcCalls.length, 0);
  });
}

test("missing total, amount/currency mismatch, non-payable or non-Wayl rows: no grant, row unchanged, safe 200", async () => {
  for (const ev of [
    completed({ total: undefined }),
    completed({ total: 34999 }),
    completed({ total: 35000.5 }),
    completed({ currency: "USD" }),
  ]) {
    const db = world();
    const snap = structuredClone(db.tables);
    const r = await call(db, ev);
    assert.equal(r.status, 200);
    assert.equal(r.text, "ok");
    assert.equal(db.rpcCalls.length, 0);
    assert.deepEqual(db.tables, snap, "nothing written");
  }
  // stored row currency not IQD (e.g. foreign provider row) → no grant
  const db2 = world("created", { currency: "SAR" });
  await call(db2, completed());
  assert.equal(db2.rpcCalls.length, 0);
  assert.equal(credits(db2), 5);
  // non-Wayl payment row is never touched
  const db3 = world("created", { provider: "moyasar" });
  await call(db3, completed());
  assert.equal(db3.rpcCalls.length, 0);
  assert.equal(pay(db3).status, "created");
  // failed / refunded / cancelled rows are never granted automatically
  for (const st of ["failed", "refunded", "cancelled"]) {
    const db4 = world(st);
    const snap = structuredClone(db4.tables);
    const r = await call(db4, completed());
    assert.equal(r.status, 200, st);
    assert.equal(db4.rpcCalls.length, 0, st);
    assert.deepEqual(db4.tables, snap, st);
  }
  // inconsistent row (credits already recorded while unpaid) → manual review, no grant
  const db5 = world("created", { credits_granted: 1000 });
  await call(db5, completed());
  assert.equal(db5.rpcCalls.length, 0);
  assert.equal(credits(db5), 5);
});

test("the RPC is the authority: a non-granted RPC result never grants and never falls back", async () => {
  // The pre-read passes, but the locked row says otherwise (e.g. amount changed concurrently).
  const db = world();
  const realRpc = db.rpc;
  db.rpc = async (name, args) => {
    pay(db).amount = 85000; // changed between the handler's read and the RPC's row lock
    return await realRpc(name, args);
  };
  const r = await call(db, completed());
  assert.equal(r.status, 200);
  assert.equal(credits(db), 5);
  assert.equal(pay(db).status, "created");
  assert.ok(r.lines.some((l) => l.includes("not granted (amount_mismatch)")), r.lines.join("\n"));
  assertNoLegacyPath(db);
});

test("RPC error / missing RPC / malformed result → 500 (fail closed), nothing changed, no fallback; retry grants once", async () => {
  for (const mode of ["error", "missing", "bad"] as const) {
    const db = world();
    if (mode === "error") db.failRpc = true;
    else db.topupRpcMode = mode;
    const snap = structuredClone(db.tables);
    const r1 = await call(db, completed());
    assert.equal(r1.status, 500, mode);
    assert.equal(r1.text, "db error", mode);
    assert.deepEqual(db.tables, snap, `${mode}: payment and balance unchanged`);
    assertNoLegacyPath(db);
    if (mode === "missing") assert.ok(r1.lines.some((l) => l.includes("RPC unavailable")), mode);
    assert.ok(!r1.lines.join("\n").includes("rpc failure"), "no internal detail logged");
    // Wayl retries once the fault is gone: exactly one grant.
    db.failRpc = false;
    db.topupRpcMode = "ok";
    assert.equal((await call(db, completed())).status, 200);
    assert.equal((await call(db, completed())).status, 200);
    assert.equal(credits(db), 1005, mode);
    assert.equal(topupRpcs(db).length, 2, mode); // 1 failed + 1 ok; the 3rd sees 'paid'
    assertNoLegacyPath(db);
  }
});

test("lost RPC response after commit → 500, and Wayl's retry does not grant again", async () => {
  const db = world();
  db.topupRpcMode = "lost";
  const r1 = await call(db, completed());
  assert.equal(r1.status, 500);
  assert.equal(credits(db), 1005); // committed in the DB
  db.topupRpcMode = "ok";
  const r2 = await call(db, completed());
  assert.equal(r2.status, 200);
  assert.equal(credits(db), 1005, "no double grant");
  assert.equal(pay(db).status, "paid");
  assertNoLegacyPath(db);
});

test("handler source: the only top-up grant path is the atomic RPC (no claim + grant_credits fallback)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../supabase/functions/wayl-webhook/handler.ts", import.meta.url), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  assert.doesNotMatch(src, /grant_credits/);
  assert.doesNotMatch(src, /status:\s*["']paid["']/, "handler never writes payments.status='paid' itself");
  assert.equal((src.match(/\.rpc\(/g) ?? []).length, 1);
  assert.match(src, /\.rpc\("wayl_grant_topup_once"/);
});

test("orders: paid only with verified amount; replayed cancel cannot flip paid", async () => {
  const db = world();
  const ok = await call(db, { referenceId: ORDER_ID, paymentStatus: "Completed", total: 50000, paymentMethod: "card" });
  assert.equal(ok.status, 200);
  assert.equal(order(db).status, "paid");
  assert.equal(order(db).paid_at, "2026-01-01T00:00:00.000Z");
  const snap = structuredClone(order(db));
  for (const s of ["Cancelled", "Rejected", "SomethingNew"]) {
    await call(db, { referenceId: ORDER_ID, paymentStatus: s, total: 50000 });
    assert.deepEqual(order(db), snap);
  }
  await call(db, { referenceId: ORDER_ID, paymentStatus: "Completed", total: 50000 });
  assert.deepEqual(order(db), snap);
});

test("orders: missing total or mismatch never marks paid", async () => {
  for (const ev of [{ total: undefined }, { total: 1 }, { currency: "usd" }]) {
    const db = world();
    const r = await call(db, { referenceId: ORDER_ID, paymentStatus: "Completed", total: 50000, ...ev });
    assert.equal(r.status, 200);
    assert.equal(order(db).status, "amount_mismatch");
    assert.equal(order(db).paid_at, null);
  }
  const db = world();
  db.tables.orders[0].total = null;
  await call(db, { referenceId: ORDER_ID, paymentStatus: "Completed", total: 0 });
  assert.notEqual(order(db).status, "paid");
});

test("malformed bodies → 400 without leaking; non-UUID reference → 200 ignored", async () => {
  const db = world();
  for (const body of [
    {}, [], "str", { referenceId: 123 }, { referenceId: PAY_ID, total: { a: 1 } },
    { referenceId: PAY_ID, paymentStatus: 5 }, { referenceId: PAY_ID, total: "35000abc" },
    { referenceId: PAY_ID, currency: ["IQD"] },
  ]) {
    const r = await call(db, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.text, "invalid payload");
  }
  const bad = await call(db, null, { raw: "{not json" });
  assert.equal(bad.status, 400);
  const nonUuid = await call(db, { referenceId: "abc", paymentStatus: "Complete", total: 35000 });
  assert.equal(nonUuid.status, 200);
  assert.equal(db.rpcCalls.length, 0);
  assert.equal(db.updates.length, 0);
});

test("oversize body → 413 before signature/DB", async () => {
  const db = world();
  const raw = JSON.stringify({ referenceId: PAY_ID, pad: "x".repeat(MAX_BODY_BYTES) });
  const r = await call(db, null, { raw, sig: "00" });
  assert.equal(r.status, 413);
  const edge = await call(db, null, { raw: "x".repeat(MAX_BODY_BYTES), sig: "00" });
  assert.equal(edge.status, 401);
  assert.equal(db.updates.length, 0);
});

test("invalid/missing signature → 401; missing secret fails closed; logs never contain secrets/signatures", async () => {
  const db = world();
  const raw = JSON.stringify(completed());
  const good = await hmacHexOf(SECRET, raw);
  const tampered = await call(db, null, { raw: raw.replace("35000", "35001"), sig: good });
  assert.equal(tampered.status, 401);
  const wrong = await call(db, null, { raw, sig: "a".repeat(64) });
  assert.equal(wrong.status, 401);
  const missing = await call(db, null, { raw, sig: "" });
  assert.equal(missing.status, 401);
  const noSecret = await call(db, null, { raw, sig: good, env: { WAYL_WEBHOOK_SECRET: undefined } });
  assert.equal(noSecret.status, 500);
  assert.equal(db.rpcCalls.length, 0);
  const prefixed = await call(db, null, { raw, sig: "sha256=" + good });
  assert.equal(prefixed.status, 200);
  for (const l of [...tampered.lines, ...wrong.lines, ...prefixed.lines]) {
    assert.ok(!l.includes(SECRET) && !l.includes(good) && !l.includes("disposable-test-only"), l);
  }
});

test("db errors → 500 with generic text (no internal detail)", async () => {
  const db = world();
  db.failOn = { table: "payments", op: "select" };
  const r = await call(db, completed());
  assert.equal(r.status, 500);
  assert.equal(r.text, "db error");
  assert.ok(!r.lines.join("\n").includes("secret internal db detail"));
});

test("orders: concurrent completed + cancelled (same pre-state read) always ends paid", async () => {
  const db = world();
  db.barrier = { table: "orders", count: 2 }; // both read 'pending_payment' before writing
  await Promise.all([
    call(db, { referenceId: ORDER_ID, paymentStatus: "Completed", total: 50000 }),
    call(db, { referenceId: ORDER_ID, paymentStatus: "Cancelled" }),
  ]);
  assert.equal(order(db).status, "paid");
});
