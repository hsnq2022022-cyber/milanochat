// Shared in-memory fakes for wayl-webhook / create-payment tests. No network, no real DB.
// The fake mimics PostgREST semantics used by the handlers: each UPDATE evaluates its
// filters and mutates matching rows atomically (as a row-locked Postgres UPDATE would),
// after a few awaited ticks so concurrent handler calls genuinely interleave.
// rpc("wayl_grant_topup_once") models migration 20261115130000: the whole call runs
// synchronously after the awaited ticks (= one row-locked transaction), so it is
// atomic with respect to concurrent callers; on an error result nothing changed.
// The SQL itself is proven against real Postgres in tests/wayl-topup-atomic-sql.test.mjs.

type Row = Record<string, unknown>;
type Filter = { kind: "eq" | "neq" | "in"; col: string; val: unknown };

export type FakeDb = {
  tables: Record<string, Row[]>;
  rpcCalls: { name: string; args: Row }[];
  updates: { table: string; patch: Row; matched: number }[];
  /** RPC returns an error and changes nothing (transaction rolled back). */
  failRpc: boolean;
  /** How rpc("wayl_grant_topup_once") misbehaves:
   *  "missing"   → PGRST202 (migration not applied), nothing changes;
   *  "lost"      → commits the grant, then the response is lost (error returned);
   *  "bad"       → commits nothing and returns a malformed result. */
  topupRpcMode: "ok" | "missing" | "lost" | "bad";
  failOn: { table: string; op: string } | null;
  /** When set, the first `count` SELECTs on `table` are held until all have arrived,
   *  forcing concurrent callers to read the same pre-state (worst-case race). */
  barrier: { table: string; count: number } | null;
  from: (table: string) => unknown;
  rpc: (name: string, args: Row) => Promise<{ data: unknown; error: unknown }>;
};

/** Live CHECK on public.payments.status; any other value fails with SQLSTATE 23514. */
export const PAYMENTS_STATUS_CHECK = ["created", "paid", "failed", "refunded"];

const tick = async (n = 3) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind === "eq") return row[f.col] === f.val;
    if (f.kind === "neq") return row[f.col] !== f.val;
    return (f.val as unknown[]).includes(row[f.col]);
  });
}

export function makeFakeDb(tables: Record<string, Row[]>): FakeDb {
  let arrived = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const db: FakeDb = {
    tables,
    rpcCalls: [],
    updates: [],
    failRpc: false,
    topupRpcMode: "ok",
    failOn: null,
    barrier: null,
    from(table: string) {
      let op: "select" | "update" | "insert" | null = null;
      let patch: Row = {};
      let inserted: Row[] = [];
      let returning = false;
      const filters: Filter[] = [];
      const exec = async () => {
        await tick();
        if (op === "select" && db.barrier && db.barrier.table === table && arrived < db.barrier.count) {
          arrived++;
          if (arrived === db.barrier.count) release();
          await gate;
        }
        if (db.failOn && db.failOn.table === table && db.failOn.op === op) {
          return { data: null, error: { code: "XX000", message: "secret internal db detail" } };
        }
        const rows = (db.tables[table] ??= []);
        if (
          op === "update" && table === "payments" && "status" in patch &&
          !PAYMENTS_STATUS_CHECK.includes(String(patch.status)) && rows.some((r) => matches(r, filters))
        ) {
          // Mirrors the live CHECK constraint (checked per updated row, so a zero-row
          // UPDATE succeeds as in Postgres): the statement fails, nothing changes.
          return { data: null, error: { code: "23514", message: "violates check constraint payments_status_check" } };
        }
        if (op === "insert") {
          if (table === "payments" && inserted.some((r) => !PAYMENTS_STATUS_CHECK.includes(String(r.status)))) {
            return { data: null, error: { code: "23514", message: "violates check constraint payments_status_check" } };
          }
          const copies = inserted.map((r) => structuredClone(r));
          rows.push(...copies);
          return { data: returning ? copies.map((r) => ({ id: r.id })) : null, error: null };
        }
        const hit = rows.filter((r) => matches(r, filters));
        if (op === "update") {
          for (const r of hit) Object.assign(r, structuredClone(patch));
          db.updates.push({ table, patch: structuredClone(patch), matched: hit.length });
          return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
        }
        return { data: hit.map((r) => structuredClone(r)), error: null };
      };
      const b = {
        select(_cols?: string) {
          if (op === null) op = "select";
          else returning = true;
          return b;
        },
        update(p: Row) {
          op = "update";
          patch = p;
          return b;
        },
        insert(r: Row | Row[]) {
          op = "insert";
          inserted = Array.isArray(r) ? r : [r];
          return b;
        },
        eq(col: string, val: unknown) {
          filters.push({ kind: "eq", col, val });
          return b;
        },
        neq(col: string, val: unknown) {
          filters.push({ kind: "neq", col, val });
          return b;
        },
        in(col: string, val: unknown[]) {
          filters.push({ kind: "in", col, val });
          return b;
        },
        async maybeSingle() {
          const r = await exec();
          if (r.error) return r;
          const arr = r.data as Row[];
          return { data: arr[0] ?? null, error: null };
        },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          return exec().then(res, rej);
        },
      };
      return b;
    },
    async rpc(name: string, args: Row) {
      await tick();
      db.rpcCalls.push({ name, args: structuredClone(args) });
      if (db.failRpc) return { data: null, error: { code: "XX000", message: "rpc failure" } };
      if (name === "wayl_grant_topup_once") {
        if (db.topupRpcMode === "missing") {
          return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
        }
        if (db.topupRpcMode === "bad") return { data: "applied", error: null };
        const data = waylGrantTopupOnce(db.tables, args);
        if (db.topupRpcMode === "lost") return { data: null, error: { code: "08006", message: "connection lost" } };
        return { data, error: null };
      }
      if (name === "grant_credits") {
        const t = (db.tables.tenants ?? []).find((r) => r.id === args.p_tenant_id);
        if (t) t.credits_remaining = Number(t.credits_remaining) + Number(args.p_credits);
      }
      return { data: null, error: null };
    },
  };
  return db;
}

const PRE_PAYMENT = ["created", "creating", "pending", "pending_payment", "creation_uncertain"];
const PACKAGE_CREDITS: Record<number, number> = { 35000: 1000, 85000: 3000, 225000: 10000 };

/** In-memory model of public.wayl_grant_topup_once (same checks, same order, same reasons).
 *  Runs synchronously: all-or-nothing, like the single SQL transaction. */
function waylGrantTopupOnce(tables: Record<string, Row[]>, a: Row): Row {
  const no = (reason: string) => ({ granted: false, reason, credits: 0 });
  const id = a.p_payment_id, amt = a.p_expected_amount, cur = a.p_currency, ev = a.p_event;
  if (
    typeof id !== "string" || typeof amt !== "number" || !Number.isInteger(amt) || amt <= 0 ||
    typeof cur !== "string" || !ev || typeof ev !== "object" || Array.isArray(ev)
  ) return no("invalid_arguments");
  const p = (tables.payments ?? []).find((r) => r.id === id);
  if (!p) return no("not_found");
  if (p.provider !== "wayl") return no("not_wayl");
  if (p.status === "paid") return no("already_paid");
  if (!PRE_PAYMENT.includes(String(p.status))) return no("not_payable");
  if (p.currency !== "IQD" || cur.trim().toUpperCase() !== p.currency) return no("currency_mismatch");
  if (p.amount !== amt) return no("amount_mismatch");
  if (p.credits_granted !== 0) return no("manual_review");
  const prev = (p.webhook_event && typeof p.webhook_event === "object" && !Array.isArray(p.webhook_event))
    ? p.webhook_event as Row
    : {};
  let credits: number;
  if (prev.credits !== undefined && prev.credits !== null) {
    const raw = prev.credits;
    credits = (typeof raw === "number" || typeof raw === "string") && /^[0-9]{1,7}$/.test(String(raw))
      ? Number(raw)
      : 0;
  } else credits = PACKAGE_CREDITS[Number(p.amount)] ?? 0;
  if (!(credits > 0 && credits <= 1_000_000)) return no("credits_unknown");
  const t = (tables.tenants ?? []).find((r) => r.id === p.tenant_id);
  if (!t) throw new Error("tenant of payment not found");
  const before = Number(t.credits_remaining);
  if (before > 2147483647 - credits) return no("credit_overflow");
  p.status = "paid";
  p.paid_at = "db-now";
  p.credits_granted = credits;
  p.webhook_event = { ...prev, wayl: structuredClone(ev) };
  t.credits_remaining = before + credits;
  t.is_active = true;
  return { granted: true, reason: "granted", credits };
}

export const silentLog = () => {
  const lines: string[] = [];
  const rec = (...a: unknown[]) => {
    lines.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  };
  return { lines, log: { log: rec, warn: rec, error: rec } };
};

export async function hmacHexOf(secret: string, body: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const sig = await crypto.subtle.sign("HMAC", key, bytes);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
