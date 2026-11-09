// Minimal in-memory stand-in for the parts of supabase-js used by src/store.ts. No network.
const ALLOWED_COLUMNS = {
  columns: new Set(["id", "tenant_id", "name", "nodes", "edges", "created_at", "updated_at"]),
  drafts: new Set(["tenant_id", "flow_key", "name", "document", "draft_revision", "created_at", "updated_at"]),
};

export function createFakeSupabase({ layout = "columns", table = layout === "drafts" ? "automation_flow_drafts" : "automation_flows" } = {}) {
  const rows = [];
  const fake = {
    rows, table, calls: [],
    /** Called before each update executes; tests use it to simulate a concurrent writer. */
    beforeUpdate: null,
    /** Force the next query to fail with this PostgREST error. */
    failNext: null,
    from(name) { return new Query(fake, name); },
  };
  return fake;

  function Query(f, name) {
    let op = "select", payload = null, filters = [], order = null, limit = null, mode = "many";
    const q = {
      select() { return q; },
      insert(row) { op = "insert"; payload = row; return q; },
      update(patch) { op = "update"; payload = patch; return q; },
      eq(col, val) { filters.push(r => r[col] !== undefined && r[col] !== null && String(r[col]) === String(val)); return q; },
      is(col, val) { filters.push(r => (r[col] ?? null) === val); return q; },
      order(col, o) { order = { col, asc: o?.ascending !== false }; return q; },
      limit(n) { limit = n; return q; },
      single() { mode = "single"; return q; },
      maybeSingle() { mode = "maybe"; return q; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    return q;

    function run() {
      f.calls.push({ table: name, op, filters: filters.length });
      if (f.failNext) { const e = f.failNext; f.failNext = null; return { data: null, error: e }; }
      if (name !== table) return { data: null, error: { code: "PGRST205", message: "relation secret-detail" } };
      const cols = ALLOWED_COLUMNS[layout];
      if (payload && Object.keys(payload).some(k => !cols.has(k))) return { data: null, error: { code: "PGRST204" } };
      let out;
      if (op === "insert") {
        const now = new Date().toISOString();
        const row = structuredClone(payload);
        if (layout === "drafts") { row.draft_revision ??= 1; row.created_at ??= now; row.updated_at ??= now; }
        const dup = layout === "drafts"
          ? rows.some(r => r.tenant_id === row.tenant_id && r.flow_key === row.flow_key)
          : rows.some(r => r.id === row.id);
        if (dup) return { data: null, error: { code: "23505" } };
        rows.push(row);
        out = [row];
      } else {
        if (op === "update" && f.beforeUpdate) { const h = f.beforeUpdate; f.beforeUpdate = null; h(rows); }
        out = rows.filter(r => filters.every(fn => fn(r)));
        if (op === "update") for (const r of out) Object.assign(r, structuredClone(payload));
        if (order) out = [...out].sort((a, b) => (a[order.col] < b[order.col] ? -1 : 1) * (order.asc ? 1 : -1));
        if (limit !== null) out = out.slice(0, limit);
      }
      out = structuredClone(out);
      if (mode === "single") return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { code: "PGRST116" } };
      if (mode === "maybe") return out.length > 1 ? { data: null, error: { code: "PGRST116" } } : { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    }
  }
}
