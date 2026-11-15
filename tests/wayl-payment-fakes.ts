// Shared in-memory fakes for wayl-webhook / create-payment tests. No network, no real DB.
// The fake mimics PostgREST semantics used by the handlers: each UPDATE evaluates its
// filters and mutates matching rows atomically (as a row-locked Postgres UPDATE would),
// after a few awaited ticks so concurrent handler calls genuinely interleave.

type Row = Record<string, unknown>;
type Filter = { kind: "eq" | "neq" | "in"; col: string; val: unknown };

export type FakeDb = {
  tables: Record<string, Row[]>;
  rpcCalls: { name: string; args: Row }[];
  updates: { table: string; patch: Row; matched: number }[];
  failRpc: boolean;
  failOn: { table: string; op: string } | null;
  /** When set, the first `count` SELECTs on `table` are held until all have arrived,
   *  forcing concurrent callers to read the same pre-state (worst-case race). */
  barrier: { table: string; count: number } | null;
  from: (table: string) => unknown;
  rpc: (name: string, args: Row) => Promise<{ data: unknown; error: unknown }>;
};

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
    failOn: null,
    barrier: null,
    from(table: string) {
      let op: "select" | "update" | null = null;
      let patch: Row = {};
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
      if (name === "grant_credits") {
        const t = (db.tables.tenants ?? []).find((r) => r.id === args.p_tenant_id);
        if (t) t.credits_remaining = Number(t.credits_remaining) + Number(args.p_credits);
      }
      return { data: null, error: null };
    },
  };
  return db;
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
