// wayl-webhook: signature, size cap, strict validation, amount/currency fail-closed,
// idempotent single grant and forward-only (replay-safe) state transitions.
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

function world(payStatus = "pending_payment", extraPay: Record<string, unknown> = {}) {
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

test("valid signature + completed grants server-stored credits exactly once to the row's tenant", async () => {
  const db = world();
  const r = await call(db, completed());
  assert.equal(r.status, 200);
  assert.equal(credits(db), 1005);
  assert.equal(pay(db).status, "paid");
  assert.equal(pay(db).credits_granted, 1000);
  assert.deepEqual(db.rpcCalls, [{ name: "grant_credits", args: { p_tenant_id: TENANT, p_credits: 1000 } }]);
});

test("sequential duplicate callbacks grant once", async () => {
  const db = world();
  for (let i = 0; i < 3; i++) assert.equal((await call(db, completed())).status, 200);
  assert.equal(db.rpcCalls.length, 1);
  assert.equal(credits(db), 1005);
});

test("concurrent duplicate callbacks grant exactly once", async () => {
  const db = world();
  db.barrier = { table: "payments", count: 5 }; // all 5 read 'pending_payment' before any claim
  const rs = await Promise.all(Array.from({ length: 5 }, () => call(db, completed())));
  for (const r of rs) assert.equal(r.status, 200);
  assert.equal(db.rpcCalls.length, 1);
  assert.equal(credits(db), 1005);
});

test("client-supplied credits/tenant in the signed body are ignored", async () => {
  const db = world();
  await call(db, completed({ credits: 999999, tenant_id: "attacker", p_credits: 5, webhook_event: { credits: 7 } }));
  assert.deepEqual(db.rpcCalls[0].args, { p_tenant_id: TENANT, p_credits: 1000 });
  assert.equal((pay(db).webhook_event as Record<string, unknown>).credits, 1000);
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
  assert.equal(db.rpcCalls.length, 1);
});

test("missing total, amount mismatch, currency mismatch: no grant, safe 200", async () => {
  for (const ev of [
    completed({ total: undefined }),
    completed({ total: 34999 }),
    completed({ total: 35000.5 }),
    completed({ currency: "USD" }),
  ]) {
    const db = world();
    const r = await call(db, ev);
    assert.equal(r.status, 200);
    assert.equal(r.text, "ok");
    assert.equal(db.rpcCalls.length, 0);
    assert.equal(credits(db), 5);
    assert.equal(pay(db).status, "amount_mismatch");
  }
  // stored row currency not IQD (e.g. foreign provider row) → no grant
  const db2 = world("pending_payment", { currency: "SAR" });
  await call(db2, completed());
  assert.equal(db2.rpcCalls.length, 0);
  // non-Wayl payment row is never touched
  const db3 = world("created", { provider: "moyasar" });
  await call(db3, completed());
  assert.equal(db3.rpcCalls.length, 0);
  assert.equal(pay(db3).status, "created");
});

test("grant failure releases the claim so a retry grants once", async () => {
  const db = world();
  db.failRpc = true;
  const r1 = await call(db, completed());
  assert.equal(r1.status, 500);
  assert.equal(pay(db).status, "pending_payment");
  assert.equal(pay(db).credits_granted, 0);
  db.failRpc = false;
  await call(db, completed());
  await call(db, completed());
  assert.equal(credits(db), 1005);
  assert.equal(db.rpcCalls.filter((c) => c.args.p_credits === 1000).length, 2); // 1 failed + 1 ok
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
