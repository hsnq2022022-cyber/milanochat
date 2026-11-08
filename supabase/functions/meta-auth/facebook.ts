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

export const FB_GRAPH_HOST = "https://graph.facebook.com";
export const FB_GRAPH_V = `${FB_GRAPH_HOST}/v21.0`;
/** Fields this app's webhook processes for object "page". */
export const FB_PAGE_SUBSCRIBED_FIELDS = "messages,messaging_postbacks";
/** Required Meta permissions (Facebook Login dialog scope). */
export const FB_REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "pages_manage_metadata",
  "pages_read_engagement",
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

export type FbDb = {
  /** true when the page is ACTIVE for another tenant; "error" fails closed. */
  pageOwnedElsewhere: (pageId: string) => Promise<boolean | "error">;
  upsertPage: (row: FbPageRow) => Promise<boolean>;
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
        .eq("status", "active")
        .limit(1);
      if (error) return "error";
      return Array.isArray(data) && data.length > 0;
    },
    upsertPage: async (row) => {
      if (row.tenant_id !== tenantId) return false;
      const { error } = await sb
        .from("channel_accounts")
        .upsert(row, { onConflict: "tenant_id,channel,external_id" });
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

async function getJson(deps: FbLinkDeps, url: string, init?: RequestInit): Promise<any> {
  const r = await deps.fetch(url, init);
  return await r.json().catch(() => ({}));
}

export async function linkFacebookPages(code: string, deps: FbLinkDeps): Promise<FbLinkResult> {
  // 1) code -> short-lived user token (same redirect_uri as the dialog)
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

  // 3) Pages + Page Access Tokens (bounded, fixed host only)
  const pages: any[] = [];
  let next: string | null =
    `${FB_GRAPH_V}/me/accounts?fields=id,name,access_token,tasks,picture%7Burl%7D&limit=100` +
    `&access_token=${encodeURIComponent(userToken)}` +
    `&appsecret_proof=${await appSecretProof(deps.appSecret, userToken)}`;
  for (let i = 0; next && i < MAX_ACCOUNT_PAGES && pages.length < MAX_LINKED_PAGES; i++) {
    const j = await getJson(deps, next);
    if (j?.error) {
      console.error("[meta-auth] facebook /me/accounts failed", errCode(j));
      if (pages.length === 0) return { ok: false, code: "graph_error" };
      break;
    }
    if (Array.isArray(j?.data)) pages.push(...j.data);
    const n = j?.paging?.next;
    next = typeof n === "string" && n.startsWith(`${FB_GRAPH_HOST}/`) ? n : null;
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
      is_active: true,
      access_token_encrypted: await deps.encryptField(pageToken),
      token_expires_at: pageTokenExpiresAt,
      connected_at: now,
      updated_at: now,
    });
    if (!ok) { dbFailed++; continue; }
    saved++;
    if (!name && typeof p?.name === "string") name = p.name;

    // 4) Page webhooks (object "page"). Failure does not undo the link.
    try {
      const s = await getJson(deps, `${FB_GRAPH_V}/${pageId}/subscribed_apps`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          subscribed_fields: FB_PAGE_SUBSCRIBED_FIELDS,
          access_token: pageToken,
          appsecret_proof: await appSecretProof(deps.appSecret, pageToken),
        }).toString(),
      });
      if (s?.success !== true) console.error("[meta-auth] facebook subscribed_apps failed", errCode(s));
    } catch (e) {
      console.error("[meta-auth] facebook subscribed_apps error", e instanceof Error ? e.name : "unknown");
    }
  }

  console.log("[meta-auth] facebook linked pages", { saved, skippedOwned, dbFailed });
  if (saved > 0) return { ok: true, saved, name };
  if (dbFailed > 0) return { ok: false, code: "db_save_failed" };
  if (skippedOwned > 0) return { ok: false, code: "account_already_linked" };
  return { ok: false, code: "no_pages" };
}
