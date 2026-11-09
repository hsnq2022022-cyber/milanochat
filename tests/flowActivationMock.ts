import type { Page } from "@playwright/test";

/** Shared fake `flow-publication` server for the real activation toggle (page.route only, no network). */
export const MOCK_HOST = (process.env.VITE_SUPABASE_URL ?? "").startsWith("http://mock.");
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;

export type ActivationServer = {
  /** Active revision on the account (null = nothing active). */
  active: number | null;
  /**
   * flow_key of the active publication. Undefined = whatever key the client asks
   * about (legacy behaviour: the local editor flow is the active one).
   */
  activeKey?: string;
  /** Revisions published under the client's LOCAL key (any key not in `flows`). Default [2, 1]. */
  items?: number[];
  /** Revisions published under specific server flow_keys (e.g. ig_live_welcome_20261029: [4,3,2,1]). */
  flows?: Record<string, number[]>;
  canActivate?: boolean;
  accountsFail?: boolean;
  /** HTTP status + error body returned for `catalog`. */
  catalogError?: { status: number; error: string };
  /** Readiness checks reported as false (all others true), for every revision. */
  readinessMissing?: string[];
  /** Per-revision readiness kind (default "buttons"). "unsupported"/"text" mimic a simple text-only flow. */
  readinessKinds?: Record<number, ReadinessKind>;
  /** Per-revision failing checks (added to readinessMissing). */
  readinessMissingByRevision?: Record<number, string[]>;
  /** Reply with a report the client cannot classify (no candidateKind). */
  readinessMalformed?: boolean;
  /** HTTP status + error body returned for activate/deactivate. */
  mutationError?: { status: number; error: string };
  delayMs?: number;
  calls: Array<Record<string, any>>;
};

export type ReadinessKind = "buttons" | "delay" | "mixed" | "text" | "unsupported";
/** Server env/operator checks that only the advanced (durable) runtime needs. */
export const ADVANCED_ONLY_CHECKS = ["ingress", "activation", "canary", "operatorRelease", "outbox", "atomicDebit", "encryption", "scheduler", "buttons", "internalActions", "media"];
const CHECKS = ["instagram", "tenant", "account", "globalSwitch", "tenantSwitch", "credits", "activeRevision",
  "supportedCandidate", "ingress", "activation", "canary", "operatorRelease", "outbox", "atomicDebit", "encryption",
  "scheduler", "buttons", "internalActions", "media"];

export async function mockActivation(page: Page, server: ActivationServer) {
  const ref = new URL(URL_).hostname.split(".")[0];
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    `sb-${ref}-auth-token`,
    JSON.stringify({
      access_token: FAKE_JWT, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
      user: { id: "u1", aud: "authenticated", role: "authenticated", email: "t@example.test", app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" },
    }),
  ]);
  const revisionsOf = (key: string) => server.flows?.[key] ?? server.items ?? [2, 1];
  const activeKeyFor = (askedKey: string) => server.activeKey ?? askedKey;
  const isActive = (key: string) => server.active !== null && activeKeyFor(key) === key;
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    const body = req.postDataJSON?.() ?? {};
    const reply = (status: number, b: unknown) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (!new URL(req.url()).pathname.endsWith("/flow-publication")) return reply(200, {});
    server.calls.push(body);
    const key: string = body.flowKey;
    switch (body.action) {
      case "accounts":
        if (server.accountsFail) return reply(503, { ok: false, error: "Service not configured" });
        return reply(200, { ok: true, accounts: [{ id: ACCOUNT, platform: "instagram", is_active: true, canActivate: server.canActivate ?? true }] });
      case "catalog": {
        if (server.catalogError) return reply(server.catalogError.status, { ok: false, error: server.catalogError.error });
        const flows = Object.entries(server.flows ?? {}).filter(([, revs]) => revs.length).map(([flowKey, revs]) => ({ flowKey, latestRevision: revs[0] }));
        const local = server.items ?? [2, 1];
        if (!(key in (server.flows ?? {})) && local.length) flows.push({ flowKey: key, latestRevision: local[0] });
        return reply(200, { ok: true, flows, active: server.active === null ? null : { flow_key: activeKeyFor(key), revision: server.active }, truncated: false });
      }
      case "list":
        return reply(200, { ok: true, items: revisionsOf(key).map((revision) => ({ revision, created_at: "2025-01-01" })), activation: isActive(key) ? { revision: server.active, is_active: true } : null });
      case "readiness": {
        const revision = body.revision ?? (isActive(key) ? server.active : null);
        const kind: ReadinessKind = server.readinessKinds?.[revision] ?? "buttons";
        const missing = new Set([...(server.readinessMissing ?? []), ...(server.readinessMissingByRevision?.[revision] ?? [])]);
        // Like the server: a non-durable document is "unsupported" and never reports needs.
        if (kind === "unsupported") missing.add("supportedCandidate");
        const checks = Object.fromEntries(CHECKS.map((c) => [c, c === "activeRevision" ? isActive(key) : !missing.has(c)]));
        const needsButtons = kind === "buttons" || kind === "mixed", needsScheduler = kind === "delay" || kind === "mixed";
        const base = Object.entries(checks).filter(([c]) => c !== "scheduler" && c !== "buttons" && c !== "internalActions" && c !== "media").every(([, v]) => v);
        const configured = base && kind !== "unsupported" && (!needsButtons || checks.buttons) && (!needsScheduler || checks.scheduler);
        const readiness = server.readinessMalformed ? { checks } : { checks, candidateKind: kind, needsButtons, needsScheduler, needsInternalActions: false, needsMedia: false,
          buttonsConfigured: configured && kind === "buttons", delayConfigured: configured && kind === "delay", configured };
        return reply(200, { ok: true, candidateRevision: revision, readiness });
      }
      case "activate": case "deactivate":
        if (server.delayMs) await new Promise((r) => setTimeout(r, server.delayMs));
        if (server.mutationError) return reply(server.mutationError.status, { ok: false, error: server.mutationError.error });
        if (body.action === "deactivate" && !isActive(key)) return reply(404, { ok: false, error: "No active publication found" });
        if (body.action === "activate") {
          server.active = body.revision;
          if (server.activeKey !== undefined) server.activeKey = key;
        } else server.active = null;
        return reply(200, body.action === "activate" ? { ok: true, active: true, revision: body.revision } : { ok: true, active: false });
      default: return reply(200, { ok: false, error: "unexpected" });
    }
  });
}

/* ---------- Multi-account / multi-session mode (cross-account isolation tests) ---------- */

/** One channel account's server-side state, as the real tables scope it (tenant + account + platform + flow_key). */
export type MockAccount = {
  id: string;
  platform?: string;
  canActivate?: boolean;
  /** Published revisions per flow_key (newest first). */
  flows: Record<string, number[]>;
  /** The account's single active publication. */
  active: { flow_key: string; revision: number } | null;
};
export type MultiAccountServer = {
  /** Every account in the fake database (all tenants). */
  accounts: Record<string, MockAccount>;
  /** Shared request log across sessions: one entry per flow-publication call. */
  calls: Array<Record<string, any> & { session: string }>;
};
/**
 * One signed-in session (page): `owned` are the account ids of the session's tenant.
 * `listed` (default = owned) is what the `accounts` action returns, so a test can
 * simulate a stale/foreign id reaching the client; every other action answers only
 * from the requested accountId's own state and returns the server's real
 * 403 "Account not authorized" for an account outside the session's tenant
 * (flow-publication index.ts account lookup .eq("id").eq("tenant_id")).
 */
export async function mockAccounts(page: Page, server: MultiAccountServer, session: { name: string; owned: string[]; listed?: string[] }) {
  const ref = new URL(URL_).hostname.split(".")[0];
  const jwt = `${b64({ alg: "none" })}.${b64({ sub: session.name, exp: 4102444800, role: "authenticated" })}.sig`;
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    `sb-${ref}-auth-token`,
    JSON.stringify({
      access_token: jwt, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
      user: { id: session.name, aud: "authenticated", role: "authenticated", email: `${session.name}@example.test`, app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" },
    }),
  ]);
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    const body = req.postDataJSON?.() ?? {};
    const reply = (status: number, b: unknown) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (!new URL(req.url()).pathname.endsWith("/flow-publication")) return reply(200, {});
    server.calls.push({ session: session.name, action: body.action, accountId: body.accountId, flowKey: body.flowKey, revision: body.revision });
    if (body.action === "accounts") {
      const list = (session.listed ?? session.owned).map((id) => server.accounts[id]).filter(Boolean);
      return reply(200, { ok: true, accounts: list.map((a) => ({ id: a.id, platform: a.platform ?? "instagram", is_active: true, canActivate: a.canActivate ?? true })) });
    }
    // Tenant scope: only the session's own accounts are visible.
    if (!session.owned.includes(body.accountId) || !server.accounts[body.accountId]) return reply(403, { ok: false, error: "Account not authorized" });
    const acc = server.accounts[body.accountId];
    const key: string = body.flowKey;
    const isActive = acc.active !== null && acc.active.flow_key === key;
    switch (body.action) {
      case "catalog":
        return reply(200, { ok: true, flows: Object.entries(acc.flows).filter(([, r]) => r.length).map(([flowKey, r]) => ({ flowKey, latestRevision: r[0] })), active: acc.active, truncated: false });
      case "list":
        return reply(200, { ok: true, items: (acc.flows[key] ?? []).map((revision) => ({ revision, created_at: "2025-01-01" })), activation: isActive ? { revision: acc.active!.revision, is_active: true } : null });
      case "readiness": {
        const revision = body.revision ?? (isActive ? acc.active!.revision : null);
        if (!(acc.flows[key] ?? []).includes(revision)) return reply(200, { ok: true, candidateRevision: revision, readiness: { checks: Object.fromEntries(CHECKS.map((c) => [c, false])), candidateKind: "unsupported" } });
        const checks = Object.fromEntries(CHECKS.map((c) => [c, c === "activeRevision" ? isActive : true]));
        return reply(200, { ok: true, candidateRevision: revision, readiness: { checks, candidateKind: "buttons", needsButtons: true, needsScheduler: false,
          needsInternalActions: false, needsMedia: false, buttonsConfigured: isActive, delayConfigured: false, configured: isActive } });
      }
      case "activate":
        if (!(acc.flows[key] ?? []).includes(body.revision)) return reply(404, { ok: false, error: "Publication revision not found" });
        acc.active = { flow_key: key, revision: body.revision };
        return reply(200, { ok: true, active: true, revision: body.revision });
      case "deactivate":
        if (!isActive) return reply(404, { ok: false, error: "No active publication found" });
        acc.active = null;
        return reply(200, { ok: true, active: false });
      default: return reply(400, { ok: false, error: "Unknown action" });
    }
  });
}
