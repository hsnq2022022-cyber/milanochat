import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlowEdge, FlowNode } from "./flowModel.js";
import type { StorageMode } from "./config.js";

/** One flow, independent of the storage layout. `version` is the optimistic-concurrency token. */
export type FlowRecord = {
  id: string; tenantId: string; name: string;
  nodes: FlowNode[]; edges: FlowEdge[];
  createdAt: string | null; updatedAt: string | null;
  version: string | number;
};
export type FlowSummary = { id: string; name: string; nodeCount: number; edgeCount: number; createdAt: string | null; updatedAt: string | null };

export interface FlowStore {
  readonly description: string;
  create(input: { id: string; tenantId: string; name: string; nodes: FlowNode[]; edges: FlowEdge[] }): Promise<FlowRecord>;
  /** Always tenant-filtered when tenantId is given. */
  get(id: string, tenantId: string | null): Promise<FlowRecord | null>;
  list(tenantId: string, limit: number): Promise<FlowSummary[]>;
  /** Conditional update on (id, tenant_id, version). Returns null when the row changed meanwhile. */
  update(current: FlowRecord, nodes: FlowNode[], edges: FlowEdge[]): Promise<FlowRecord | null>;
}

/** Safe error: message never contains DB detail text, keys, or row data. */
export class StoreError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

type PgError = { code?: string } | null | undefined;
function fail(table: string, error: PgError, op: string): never {
  const code = error?.code || "unknown";
  if (code === "42P01" || code === "PGRST205")
    throw new StoreError(`Table '${table}' was not found. Check MILANO_FLOWS_TABLE / MILANO_FLOWS_STORAGE (see README "Storage").`, code);
  if (code === "42703" || code === "PGRST204")
    throw new StoreError(`Table '${table}' does not have the expected columns for this storage mode (see README "Storage").`, code);
  if (code === "42501" || code === "PGRST301")
    throw new StoreError("Permission denied by the database. Is SUPABASE_SERVICE_ROLE_KEY a service-role key?", code);
  if (code === "23505") throw new StoreError("A flow with this id already exists.", code);
  if (code === "23503") throw new StoreError("tenant_id does not reference an existing tenant.", code);
  if (code === "23514") throw new StoreError("The database rejected the flow (check constraint).", code);
  if (code === "22P02") throw new StoreError("An id has an invalid format for this table.", code);
  throw new StoreError(`Database ${op} failed (code ${code}).`, code);
}

const MAX_DOC_BYTES = 4 * 1024 * 1024;
const arr = <T>(v: unknown): T[] | null => (Array.isArray(v) ? (v as T[]) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Next updated_at; strictly later than the previous one so it always works as a version token. */
function nextTimestamp(prev: string | null): string {
  let now = Date.now();
  const p = prev ? Date.parse(prev) : NaN;
  if (Number.isFinite(p) && now <= p) now = p + 1;
  return new Date(now).toISOString();
}

/**
 * Brief layout: columns id, tenant_id, name, nodes (jsonb array), edges (jsonb array), created_at, updated_at.
 * Writes only those columns. Version token = updated_at.
 */
class ColumnsStore implements FlowStore {
  readonly description: string;
  private readonly cols = "id,tenant_id,name,nodes,edges,created_at,updated_at";
  constructor(private readonly db: Pick<SupabaseClient, "from">, private readonly table: string) {
    this.description = `columns layout, table public.${table}`;
  }
  private toRecord(r: Record<string, unknown>): FlowRecord {
    const nodes = arr<FlowNode>(r.nodes), edges = arr<FlowEdge>(r.edges);
    const id = str(r.id), tenantId = str(r.tenant_id);
    if (!nodes || !edges || !id || !tenantId)
      throw new StoreError("Stored flow row is malformed (nodes/edges are not arrays); refusing to edit it.", "malformed");
    return { id, tenantId: tenantId.toLowerCase(), name: str(r.name) ?? "", nodes, edges,
      createdAt: str(r.created_at), updatedAt: str(r.updated_at), version: str(r.updated_at) ?? "" };
  }
  async create(i: { id: string; tenantId: string; name: string; nodes: FlowNode[]; edges: FlowEdge[] }) {
    const now = new Date().toISOString();
    const { data, error } = await this.db.from(this.table)
      .insert({ id: i.id, tenant_id: i.tenantId, name: i.name, nodes: i.nodes, edges: i.edges, created_at: now, updated_at: now })
      .select(this.cols).single();
    if (error || !data) fail(this.table, error, "insert");
    return this.toRecord(data as Record<string, unknown>);
  }
  async get(id: string, tenantId: string | null) {
    let q = this.db.from(this.table).select(this.cols).eq("id", id);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    const { data, error } = await q.maybeSingle();
    if (error) fail(this.table, error, "read");
    return data ? this.toRecord(data as Record<string, unknown>) : null;
  }
  async list(tenantId: string, limit: number) {
    const { data, error } = await this.db.from(this.table).select(this.cols)
      .eq("tenant_id", tenantId).order("updated_at", { ascending: false }).limit(limit);
    if (error) fail(this.table, error, "read");
    return ((data ?? []) as Record<string, unknown>[]).map(r => ({
      id: String(r.id), name: str(r.name) ?? "", nodeCount: arr(r.nodes)?.length ?? 0, edgeCount: arr(r.edges)?.length ?? 0,
      createdAt: str(r.created_at), updatedAt: str(r.updated_at),
    }));
  }
  async update(cur: FlowRecord, nodes: FlowNode[], edges: FlowEdge[]) {
    let q = this.db.from(this.table)
      .update({ nodes, edges, updated_at: nextTimestamp(cur.updatedAt) })
      .eq("id", cur.id).eq("tenant_id", cur.tenantId);
    q = cur.updatedAt === null ? q.is("updated_at", null) : q.eq("updated_at", cur.updatedAt);
    const { data, error } = await q.select(this.cols).maybeSingle();
    if (error) fail(this.table, error, "update");
    return data ? this.toRecord(data as Record<string, unknown>) : null;
  }
}

/**
 * Verified Flow Builder cloud-draft layout (supabase/proposals/automation_flow_drafts.review.sql,
 * src/flow/cloudDraft.ts): tenant_id, flow_key, name, document {version:3,name,nodes,edges},
 * draft_revision, created_at, updated_at. Version token = draft_revision (same lock the UI uses).
 */
class DraftsStore implements FlowStore {
  readonly description: string;
  private readonly cols = "tenant_id,flow_key,name,document,draft_revision,created_at,updated_at";
  constructor(private readonly db: Pick<SupabaseClient, "from">, private readonly table: string) {
    this.description = `Flow Builder cloud drafts, table public.${table}`;
  }
  private toRecord(r: Record<string, unknown>): FlowRecord {
    const doc = r.document as Record<string, unknown> | null;
    const nodes = arr<FlowNode>(doc?.nodes), edges = arr<FlowEdge>(doc?.edges);
    const id = str(r.flow_key), tenantId = str(r.tenant_id), rev = r.draft_revision;
    if (!doc || doc.version !== 3 || !nodes || !edges || !id || !tenantId || typeof rev !== "number")
      throw new StoreError("Stored draft is malformed (document is not a version 3 flow); refusing to edit it.", "malformed");
    return { id, tenantId: tenantId.toLowerCase(), name: str(r.name) ?? "", nodes, edges,
      createdAt: str(r.created_at), updatedAt: str(r.updated_at), version: rev };
  }
  private doc(name: string, nodes: FlowNode[], edges: FlowEdge[]) {
    const document = { version: 3 as const, name, nodes, edges };
    if (Buffer.byteLength(JSON.stringify(document), "utf8") > MAX_DOC_BYTES)
      throw new StoreError("Flow document would exceed the 4 MiB cloud-draft limit.", "too_large");
    return document;
  }
  async create(i: { id: string; tenantId: string; name: string; nodes: FlowNode[]; edges: FlowEdge[] }) {
    const { data, error } = await this.db.from(this.table)
      .insert({ tenant_id: i.tenantId, flow_key: i.id, name: i.name, document: this.doc(i.name, i.nodes, i.edges) })
      .select(this.cols).single();
    if (error || !data) fail(this.table, error, "insert");
    return this.toRecord(data as Record<string, unknown>);
  }
  async get(id: string, tenantId: string | null) {
    let q = this.db.from(this.table).select(this.cols).eq("flow_key", id);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    // flow_key is only unique per tenant; without a tenant filter refuse ambiguous matches.
    const { data, error } = await q.limit(2);
    if (error) fail(this.table, error, "read");
    const rows = (data ?? []) as Record<string, unknown>[];
    if (rows.length > 1) throw new StoreError("This flow id exists in more than one tenant; pass tenant_id.", "ambiguous");
    return rows[0] ? this.toRecord(rows[0]) : null;
  }
  async list(tenantId: string, limit: number) {
    const { data, error } = await this.db.from(this.table).select(this.cols)
      .eq("tenant_id", tenantId).order("updated_at", { ascending: false }).limit(limit);
    if (error) fail(this.table, error, "read");
    return ((data ?? []) as Record<string, unknown>[]).map(r => {
      const d = r.document as Record<string, unknown> | null;
      return { id: String(r.flow_key), name: str(r.name) ?? "", nodeCount: arr(d?.nodes)?.length ?? 0, edgeCount: arr(d?.edges)?.length ?? 0,
        createdAt: str(r.created_at), updatedAt: str(r.updated_at) };
    });
  }
  async update(cur: FlowRecord, nodes: FlowNode[], edges: FlowEdge[]) {
    const rev = Number(cur.version);
    const { data, error } = await this.db.from(this.table)
      .update({ document: this.doc(cur.name, nodes, edges), draft_revision: rev + 1, updated_at: nextTimestamp(cur.updatedAt) })
      .eq("tenant_id", cur.tenantId).eq("flow_key", cur.id).eq("draft_revision", rev)
      .select(this.cols).maybeSingle();
    if (error) fail(this.table, error, "update");
    return data ? this.toRecord(data as Record<string, unknown>) : null;
  }
}

export function createFlowStore(db: Pick<SupabaseClient, "from">, mode: StorageMode, table: string): FlowStore {
  return mode === "drafts" ? new DraftsStore(db, table) : new ColumnsStore(db, table);
}
