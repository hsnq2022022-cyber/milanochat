/**
 * Facebook Page linking for the meta-auth callback (platform "facebook").
 *
 * Called ONLY after the signed OAuth state was verified and its nonce claimed
 * (index.ts, consumeOAuthState with expectedPlatform "facebook"); the tenant
 * passed here is the one carried by that verified state, never a query param.
 *
 *   code -> user token -> long-lived user token -> /me/accounts (Pages +
 *   Page Access Tokens) -> channel_accounts upsert (tenant-scoped, encrypted,
 *   idempotent on tenant_id,channel,external_id) -> Page webhook subscription.
 *
 * Security:
 *  - fixed Graph host only; a pagination "next" URL is followed only when it
 *    is on that host (no SSRF through Meta-supplied URLs), bounded loops
 *  - tokens are never logged, never returned; logs carry codes/counts only
 *  - a Page already active for ANOTHER tenant is skipped (the webhook ignores
 *    a page id that matches several accounts, so it must never be shared)
 *
 * Pure module (no Deno globals, no npm imports): fetch, db and crypto are
 * injected so node tests can exercise it.
 */

import { RECONNECT_CLEARS } from "../_shared/channelReauth.ts";
import { graphUrlWithoutToken, metaAuthHeaders } from "../_shared/metaGraph.ts";

export const FB_GRAPH_HOST = "https://graph.facebook.com";
export const FB_GRAPH_V = `${FB_GRAPH_HOST}/v21.0`;
/**
 * Fields this app's webhook processes for object "page": messages and
 * messaging_postbacks (milan-api DM path) + feed (Page post comments,
 * milan-api/commentIngress.ts: changes[].field "feed", item "comment",
 * verb "add"; other feed items are dropped before any DB access).
 */
export const FB_PAGE_SUBSCRIBED_FIELDS = "messages,messaging_postbacks,feed";
/** The pre-comment-automation list: fallback when Meta refuses `feed`. */
export const FB_PAGE_DM_SUBSCRIBED_FIELDS = "messages,messaging_postbacks";
/** Required Meta permissions (Facebook Login dialog scope). */
export const FB_REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "pages_manage_metadata",
  "pages_read_engagement",
  // Comment automation: public reply to a Page post comment (POST /{comment-id}/comments).
  "pages_manage_engagement",
] as const;
export const MAX_ACCOUNT_PAGES = 5;
export const MAX_LINKED_PAGES = 100;

const PAGE_ID = /^[0-9]{1,32}$/;
const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** appsecret_proof = hex(HMAC-SHA256(app_secret, access_token)). */
export async function appSecretProof(appSecret: string, token: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(token))));
}

export type FbPageRow = {
  tenant_id: string;
  channel: "facebook";
  platform: "facebook";
  external_id: string;
  display_name: string | null;
  avatar_url: string | null;
  status: "active";
  is_active: true;
  access_token_encrypted: string;
  token_expires_at: string | null;
  connected_at: string;
  updated_at: string;
};

/** Name of the global unique index (migration 20261115120000). */
export const ACCOUNT_GLOBAL_UNIQUE_INDEX = "channel_accounts_channel_external_id_global_uq";

/**
 * true ONLY for the Postgres unique violation (23505) of the global
 * (channel, external_id) channel_accounts index, identified by its NAME in the
 * error message or details: the id is held by ANOTHER tenant's
 * non-disconnected row. The upserts conflict on tenant_id,channel,external_id,
 * so a same-tenant re-link is an UPDATE of the same row and never raises this
 * unless another tenant holds the id. Any other 23505 (e.g. the per-tenant
 * unique constraints) is NOT matched and keeps its previous handling
 * (db_save_failed). Callers map a match to the existing
 * "account_already_linked" result; the error text (which carries the id) is
 * never logged.
 */
export function isAccountTakenViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown; details?: unknown };
  if (e.code !== "23505") return false;
  const text = `${typeof e.message === "string" ? e.message : ""} ${typeof e.details === "string" ? e.details : ""}`;
  return text.includes(ACCOUNT_GLOBAL_UNIQUE_INDEX);
}

export type FbDb = {
  /**
   * true when another tenant holds the page in a row that is NOT
   * 'disconnected' (active, needs_reauth, ... — the same rows the global
   * unique index counts); "error" fails closed.
   */
  pageOwnedElsewhere: (pageId: string) => Promise<boolean | "error">;
  /** "owned": the unique index refused the row (linked to another tenant). */
  upsertPage: (row: FbPageRow) => Promise<boolean | "owned">;
};

/** Supabase wiring; every query is scoped by the verified state's tenant. */
export function facebookDb(sb: any, tenantId: string): FbDb {
  return {
    pageOwnedElsewhere: async (pageId) => {
      const { data, error } = await sb
        .from("channel_accounts")
        .select("tenant_id")
        .eq("channel", "facebook")
        .eq("external_id", pageId)
        .neq("tenant_id", tenantId)
        // status IS DISTINCT FROM 'disconnected' (NULL counts), like the index.
        .or("status.is.null,status.neq.disconnected")
        .limit(1);
      if (error) return "error";
      return Array.isArray(data) && data.length > 0;
    },
    upsertPage: async (row) => {
      if (row.tenant_id !== tenantId) return false;
      const { error } = await sb
        .from("channel_accounts")
        .upsert(row, { onConflict: "tenant_id,channel,external_id" });
      if (error && isAccountTakenViolation(error)) return "owned";
      if (error) console.error("[meta-auth] facebook upsert failed", { code: error.code ?? "unknown" });
      return !error;
    },
  };
}

export type FbLinkDeps = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  appId: string;
  appSecret: string;
  redirectUri: string;
  tenantId: string;
  encryptField: (plain: string) => Promise<string>;
  db: FbDb;
  nowMs: () => number;
};

export type FbLinkResult =
  | { ok: true; saved: number; name: string }
  | { ok: false; code: "oauth_token_exchange" | "no_pages" | "account_already_linked" | "db_save_failed" | "graph_error" };

const errCode = (j: any) => ({ code: j?.error?.code ?? null, type: j?.error?.type ?? null });

/** `url` with this token's appsecret_proof (kept on every /me/accounts page). */
function withProof(url: string, proof: string): string {
  const u = new URL(url);
  u.searchParams.set("appsecret_proof", proof);
  return u.toString();
}

async function getJson(deps: FbLinkDeps, url: string, init?: RequestInit): Promise<any> {
  const r = await deps.fetch(url, init);
  return await r.json().catch(() => ({}));
}

export async function linkFacebookPages(code: string, deps: FbLinkDeps): Promise<FbLinkResult> {
  // 1) code -> short-lived user token (same redirect_uri as the dialog)
  // T5-S5 documented exception: Meta documents this exchange (and the
  // fb_exchange_token one below) only as GET with client_id / client_secret /
  // code query params; left unchanged rather than guessing a POST/header form.
  // Errors from these calls are never logged with the URL (codes only here;
  // index.ts logs e.name only).
  const t = await getJson(
    deps,
    `${FB_GRAPH_V}/oauth/access_token?client_id=${encodeURIComponent(deps.appId)}` +
      `&client_secret=${encodeURIComponent(deps.appSecret)}` +
      `&redirect_uri=${encodeURIComponent(deps.redirectUri)}&code=${encodeURIComponent(code)}`,
  );
  const shortToken = typeof t?.access_token === "string" ? t.access_token : "";
  if (!shortToken) {
    console.error("[meta-auth] facebook token exchange failed", errCode(t));
    return { ok: false, code: "oauth_token_exchange" };
  }

  // 2) -> long-lived user token. Page tokens derived from it do not expire;
  // otherwise they expire with the short-lived user token.
  let userToken = shortToken;
  let pageTokenExpiresAt: string | null = new Date(
    deps.nowMs() + Math.max(60, Number(t.expires_in) || 3600) * 1000,
  ).toISOString();
  const l = await getJson(
    deps,
    `${FB_GRAPH_V}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(deps.appId)}` +
      `&client_secret=${encodeURIComponent(deps.appSecret)}&fb_exchange_token=${encodeURIComponent(shortToken)}`,
  ).catch(() => ({}));
  if (typeof l?.access_token === "string" && l.access_token) {
    userToken = l.access_token;
    pageTokenExpiresAt = null;
  } else {
    console.warn("[meta-auth] facebook long-lived exchange failed", errCode(l));
  }

  // 3) Pages + Page Access Tokens (bounded, fixed host only). T5-S5: the user
  // token goes in the Authorization header, never in the URL; a paging.next
  // link (Meta echoes access_token= into it) is followed without its token.
  const pages: any[] = [];
  const proof = await appSecretProof(deps.appSecret, userToken);
  let next: string | null =
    `${FB_GRAPH_V}/me/accounts?fields=id,name,access_token,tasks,picture%7Burl%7D&limit=100` +
    `&appsecret_proof=${proof}`;
  for (let i = 0; next && i < MAX_ACCOUNT_PAGES && pages.length < MAX_LINKED_PAGES; i++) {
    const j = await getJson(deps, next, { headers: metaAuthHeaders(userToken) });
    if (j?.error) {
      console.error("[meta-auth] facebook /me/accounts failed", errCode(j));
      if (pages.length === 0) return { ok: false, code: "graph_error" };
      break;
    }
    if (Array.isArray(j?.data)) pages.push(...j.data);
    const n = j?.paging?.next;
    const nextUrl = typeof n === "string" && n.startsWith(`${FB_GRAPH_HOST}/`) ? graphUrlWithoutToken(n) : null;
    next = nextUrl ? withProof(nextUrl, proof) : null;
  }

  let saved = 0;
  let skippedOwned = 0;
  let dbFailed = 0;
  let name = "";
  const seen = new Set<string>();
  const now = new Date(deps.nowMs()).toISOString();

  for (const p of pages.slice(0, MAX_LINKED_PAGES)) {
    const pageId = String(p?.id ?? "");
    const pageToken = typeof p?.access_token === "string" ? p.access_token : "";
    if (!PAGE_ID.test(pageId) || !pageToken || seen.has(pageId)) continue;
    seen.add(pageId);
    // A Page the user cannot message from is useless for an inbox.
    if (Array.isArray(p?.tasks) && !p.tasks.includes("MESSAGING")) continue;

    const owned = await deps.db.pageOwnedElsewhere(pageId);
    if (owned === "error") { dbFailed++; continue; }
    if (owned) { skippedOwned++; continue; }

    const pic = p?.picture?.data?.url;
    const ok = await deps.db.upsertPage({
      tenant_id: deps.tenantId,
      channel: "facebook",
      platform: "facebook",
      external_id: pageId,
      display_name: typeof p?.name === "string" && p.name ? p.name : null,
      avatar_url: typeof pic === "string" && /^https:\/\//i.test(pic) ? pic : null,
      status: "active",
      ...RECONNECT_CLEARS, // reconnecting clears a previous needs_reauth reason
      is_active: true,
      access_token_encrypted: await deps.encryptField(pageToken),
      token_expires_at: pageTokenExpiresAt,
      connected_at: now,
      updated_at: now,
    });
    if (ok === "owned") { skippedOwned++; continue; }
    if (!ok) { dbFailed++; continue; }
    saved++;
    if (!name && typeof p?.name === "string") name = p.name;

    // 4) Page webhooks (object "page"). Failure does not undo the link.
    // An explicit Graph error for the list with `feed` (e.g. the app has no
    // feed webhook / permission yet) falls back to the DM-only list so DM
    // webhooks are never lost; a network error does not (outcome unknown).
    const subscribe = async (fields: string): Promise<"ok" | "refused" | "error"> => {
      try {
        const s = await getJson(deps, `${FB_GRAPH_V}/${pageId}/subscribed_apps`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            subscribed_fields: fields,
            access_token: pageToken,
            appsecret_proof: await appSecretProof(deps.appSecret, pageToken),
          }).toString(),
        });
        if (s?.success === true) return "ok";
        console.error("[meta-auth] facebook subscribed_apps failed", errCode(s));
        return s?.error && typeof s.error === "object" ? "refused" : "error";
      } catch (e) {
        console.error("[meta-auth] facebook subscribed_apps error", e instanceof Error ? e.name : "unknown");
        return "error";
      }
    };
    if (await subscribe(FB_PAGE_SUBSCRIBED_FIELDS) === "refused") {
      console.warn("[meta-auth] facebook subscribed_apps with feed refused — DM-only fallback");
      await subscribe(FB_PAGE_DM_SUBSCRIBED_FIELDS);
    }
  }

  console.log("[meta-auth] facebook linked pages", { saved, skippedOwned, dbFailed });
  if (saved > 0) return { ok: true, saved, name };
  if (dbFailed > 0) return { ok: false, code: "db_save_failed" };
  if (skippedOwned > 0) return { ok: false, code: "account_already_linked" };
  return { ok: false, code: "no_pages" };
}
