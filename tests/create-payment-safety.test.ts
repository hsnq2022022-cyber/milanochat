// create-payment: ownership, server-controlled amount/currency, generic errors, CORS.
// Fakes only: the Wayl API is a local stub; no network, no real payments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVED_ORIGIN, handleCreatePayment } from "../supabase/functions/create-payment/handler.ts";
import { makeFakeDb, silentLog, type FakeDb } from "./wayl-payment-fakes.ts";

const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const OWNER = "owner-user-id";
const SECRET = "unit-test-wayl-webhook-secret-0123456789abcdef";

const envOf = (over: Record<string, string | undefined> = {}) => {
  const e: Record<string, string | undefined> = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "disposable-test-only",
    WAYL_TOKEN: "disposable-wayl-token",
    WAYL_WEBHOOK_SECRET: SECRET,
    ...over,
  };
  return (k: string) => e[k];
};

const world = (over: Record<string, unknown> = {}) => makeFakeDb({
  orders: [{ id: ORDER_ID, user_id: OWNER, total: 50000, status: "pending", wayl_code: null, wayl_url: null, ...over }],
});

type Stub = { calls: { url: string; body: Record<string, unknown> }[]; reply: () => Response };

function waylStub(reply?: () => Response): Stub {
  return {
    calls: [],
    reply: reply ?? (() =>
      new Response(JSON.stringify({ data: { url: "https://link.thewayl.com/pay/abc", code: "C1" } }), { status: 200 })),
  };
}

async function call(db: FakeDb, opts: {
  body?: unknown; user?: string | null; origin?: string | null; method?: string; stub?: Stub;
  env?: Record<string, string | undefined>; authThrows?: boolean; dbThrows?: boolean;
} = {}) {
  const stub = opts.stub ?? waylStub();
  const headers: Record<string, string> = { authorization: "Bearer header.payload.sig", "content-type": "application/json" };
  const origin = opts.origin === undefined ? APPROVED_ORIGIN : opts.origin;
  if (origin) headers.origin = origin;
  const { log, lines } = silentLog();
  const method = opts.method ?? "POST";
  const res = await handleCreatePayment(
    new Request("https://example.com/create-payment", {
      method, headers, body: method === "POST" ? JSON.stringify(opts.body ?? { orderId: ORDER_ID }) : undefined,
    }),
    {
      env: envOf({ SITE_URL: "https://hsnq2022022-cyber.github.io/milanochat", ...opts.env }),
      db: () => {
        if (opts.dbThrows) throw new Error("db init failed: secret internal detail");
        return db;
      },
      authUser: async () => {
        if (opts.authThrows) throw new Error("auth backend down: secret detail");
        const u = opts.user === undefined ? OWNER : opts.user;
        return u ? { id: u } : null;
      },
      fetch: (async (url: string, init: RequestInit) => {
        stub.calls.push({ url, body: JSON.parse(String(init.body)) });
        return stub.reply();
      }) as unknown as typeof fetch,
      log,
    },
  );
  const txt = await res.text();
  return { res, status: res.status, json: txt ? JSON.parse(txt === "ok" ? "\"ok\"" : txt) : null, lines, stub };
}

test("owner gets a link; amount and currency come from the DB, not the client", async () => {
  const db = world();
  const r = await call(db, {
    body: { orderId: ORDER_ID, total: 1, amount: 1, currency: "USD", items: [{ name: "cheap", price: 1 }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.checkoutUrl, "https://link.thewayl.com/pay/abc");
  const sent = r.stub.calls[0].body;
  assert.equal(sent.total, 50000);
  assert.equal(sent.currency, "IQD");
  assert.equal(sent.referenceId, ORDER_ID);
  assert.deepEqual(sent.lineItem, [{ label: "طلب #33333333", amount: 50000, type: "increase" }]);
  assert.equal(db.tables.orders[0].status, "pending_payment");
  assert.equal(r.res.headers.get("access-control-allow-origin"), APPROVED_ORIGIN);
});

test("non-owner and unknown order → 404 with no provider call", async () => {
  const r = await call(world(), { user: "someone-else" });
  assert.equal(r.status, 404);
  assert.equal(r.stub.calls.length, 0);
  const r2 = await call(world({ user_id: null }), { user: "someone-else" });
  assert.equal(r2.status, 404);
  const r3 = await call(world(), { body: { orderId: "44444444-4444-4444-8444-444444444444" } });
  assert.equal(r3.status, 404);
});

test("unauthenticated / invalid session → 401", async () => {
  assert.equal((await call(world(), { user: null })).status, 401);
  const t = await call(world(), { authThrows: true });
  assert.equal(t.status, 401);
  assert.ok(!JSON.stringify(t.json).includes("secret detail"));
});

test("errors are generic: DB error, provider error body, thrown exceptions", async () => {
  const db = world();
  db.failOn = { table: "orders", op: "select" };
  const a = await call(db);
  assert.equal(a.status, 500);
  assert.ok(!JSON.stringify(a.json).includes("secret internal db detail"));

  const leaky = waylStub(() => new Response("provider says token=disposable-wayl-token invalid", { status: 401 }));
  const b = await call(world(), { stub: leaky });
  assert.equal(b.status, 502);
  assert.ok(!JSON.stringify(b.json).includes("provider says"));
  assert.ok(!b.lines.join("\n").includes("disposable-wayl-token"));

  const thrower = waylStub(() => { throw new TypeError("boom internal stack detail"); });
  const c = await call(world(), { stub: thrower });
  assert.equal(c.status, 502);
  assert.ok(!JSON.stringify(c.json).includes("boom"));

  const d = await call(world(), { dbThrows: true });
  assert.equal(d.status, 500);
  assert.ok(!JSON.stringify(d.json).includes("secret internal detail"));
  assert.ok(!d.lines.join("\n").includes("secret internal detail"));

  const st = await call(world({ status: "paid" }));
  assert.equal(st.status, 409);
  assert.ok(!JSON.stringify(st.json).includes("paid"));
});

test("provider link must be https on thewayl.com", async () => {
  for (const url of ["http://link.thewayl.com/x", "https://thewayl.com.evil.test/x", "https://u:p@link.thewayl.com/x", "javascript:alert(1)"]) {
    const s = waylStub(() => new Response(JSON.stringify({ data: { url, code: "C" } }), { status: 200 }));
    const r = await call(world(), { stub: s });
    assert.equal(r.status, 502, url);
  }
});

test("CORS: foreign origin refused (no ACAO); approved origin echoed; no wildcard", async () => {
  const bad = await call(world(), { origin: "https://evil.example" });
  assert.equal(bad.status, 403);
  assert.equal(bad.res.headers.get("access-control-allow-origin"), null);
  assert.equal(bad.stub.calls.length, 0);
  const pre = await call(world(), { method: "OPTIONS" });
  assert.equal(pre.status, 200);
  assert.equal(pre.res.headers.get("access-control-allow-origin"), APPROVED_ORIGIN);
  const preBad = await call(world(), { method: "OPTIONS", origin: "https://evil.example" });
  assert.equal(preBad.status, 403);
  const site = await call(world(), { origin: "https://shop.example.com", env: { SITE_URL: "https://shop.example.com" } });
  assert.equal(site.status, 200);
  assert.equal(site.res.headers.get("access-control-allow-origin"), "https://shop.example.com");
});

test("existing link reused; concurrent second creation returns the stored link", async () => {
  const db = world({ status: "pending_payment", wayl_url: "https://link.thewayl.com/pay/old", wayl_code: "OLD" });
  const r = await call(db);
  assert.equal(r.json.checkoutUrl, "https://link.thewayl.com/pay/old");
  assert.equal(r.stub.calls.length, 0);

  const db2 = world();
  let n = 0;
  const s = waylStub(() =>
    new Response(JSON.stringify({ data: { url: `https://link.thewayl.com/pay/${++n}`, code: `C${n}` } }), { status: 200 }));
  const [x, y] = await Promise.all([call(db2, { stub: s }), call(db2, { stub: s })]);
  assert.equal(x.status, 200);
  assert.equal(y.status, 200);
  assert.equal(x.json.checkoutUrl, y.json.checkoutUrl);
  assert.equal(db2.tables.orders[0].wayl_url, x.json.checkoutUrl);
});

test("invalid orderId / non-integer DB amount → 400", async () => {
  assert.equal((await call(world(), { body: { orderId: 5 } })).status, 400);
  assert.equal((await call(world(), { body: ["x"] })).status, 400);
  assert.equal((await call(world({ total: 10.5 }))).status, 400);
  assert.equal((await call(world({ total: null }))).status, 400);
});
