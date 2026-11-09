import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/**
 * OAuth persistence. Secrets (client secrets, authorization codes, refresh tokens) are passed in
 * and stored ONLY as SHA-256 hex hashes (see sha256Hex); nothing here ever sees a plaintext secret
 * except the hashing helper. Every method takes `now` (ms) so tests can drive the clock.
 * Tables: supabase/migrations/20261029320000_oauth_tables.sql.
 */
export type StoredClient = {
  clientId: string;
  clientSecretHash: string | null;
  clientSecretExpiresAt: number | null; // epoch seconds, null = never
  clientName: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post";
  grantTypes: string[];
  responseTypes: string[];
  scope: string;
  createdAt: number; // epoch seconds
};

export type CodeRecord = {
  codeHash: string; clientId: string; userId: string; redirectUri: string;
  codeChallenge: string; scope: string; resource: string; expiresAt: number; // ms
};

export type ConsumeCodeResult =
  | { status: "ok"; code: CodeRecord }
  | { status: "reused" } // already exchanged once: its grant family has been revoked
  | { status: "invalid" };

export type RotateResult =
  | { status: "ok"; familyId: string; userId: string; scope: string }
  | { status: "reused" } // a rotated (old) refresh token was presented: whole family revoked
  | { status: "invalid" };

export interface OAuthStore {
  readonly kind: "memory" | "postgres";
  /** Inserts unless more than `maxPerHour` clients were registered in the last hour. */
  registerClient(c: StoredClient, maxPerHour: number, now: number): Promise<"ok" | "cap">;
  getClient(clientId: string): Promise<StoredClient | null>;
  saveCode(c: CodeRecord, now: number): Promise<void>;
  /** Atomically marks the code consumed (single use) when it exists, belongs to clientId and is unexpired. */
  consumeCode(codeHash: string, clientId: string, now: number): Promise<ConsumeCodeResult>;
  /** New grant family + first refresh token; links the consumed code to the family (code-reuse revocation). */
  createGrant(g: { familyId: string; codeHash: string; clientId: string; userId: string; scope: string; refreshHash: string; refreshExpiresAt: number }, now: number): Promise<void>;
  rotateRefreshToken(oldHash: string, clientId: string, newHash: string, newExpiresAt: number, now: number): Promise<RotateResult>;
  /** Revokes the family of a refresh token when it belongs to clientId. */
  revokeRefreshToken(hash: string, clientId: string, now: number): Promise<void>;
  revokeAccessToken(jti: string, expiresAt: number): Promise<void>;
  /** true when the jti is denylisted or the token's grant family is revoked / gone. */
  isAccessTokenRevoked(jti: string, familyId: string, now: number): Promise<boolean>;
  cleanup(now: number): Promise<number>;
  close(): Promise<void>;
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const HOUR = 3_600_000;

/** In-memory store: LOCAL DEVELOPMENT AND TESTS ONLY (lost on restart, single process). */
export function createMemoryOAuthStore(): OAuthStore & { dump(): Record<string, number> } {
  const clients = new Map<string, StoredClient & { lastUsedAt: number | null }>();
  const codes = new Map<string, CodeRecord & { consumedAt: number | null; familyId: string | null; createdAt: number }>();
  const families = new Map<string, { clientId: string; userId: string; scope: string; expiresAt: number; revokedAt: number | null; revokedReason: string | null }>();
  const refresh = new Map<string, { familyId: string; expiresAt: number; usedAt: number | null }>();
  const denylist = new Map<string, number>();

  const revokeFamily = (id: string | null, reason: string, now: number) => {
    const f = id ? families.get(id) : undefined;
    if (f && f.revokedAt === null) { f.revokedAt = now; f.revokedReason = reason; }
  };

  return {
    kind: "memory",
    async registerClient(c, maxPerHour, now) {
      let recent = 0;
      for (const k of clients.values()) if (k.createdAt * 1000 > now - HOUR) recent++;
      if (recent >= maxPerHour) return "cap";
      clients.set(c.clientId, { ...structuredClone(c), lastUsedAt: null });
      return "ok";
    },
    async getClient(id) {
      const c = clients.get(id);
      if (!c) return null;
      const { lastUsedAt: _l, ...rest } = c;
      return structuredClone(rest);
    },
    async saveCode(c, now) {
      codes.set(c.codeHash, { ...c, consumedAt: null, familyId: null, createdAt: now });
      const k = clients.get(c.clientId);
      if (k) k.lastUsedAt = now;
    },
    async consumeCode(hash, clientId, now) {
      const c = codes.get(hash);
      if (!c || c.clientId !== clientId) return { status: "invalid" };
      if (c.consumedAt !== null) { revokeFamily(c.familyId, "code_reuse", now); return { status: "reused" }; }
      if (c.expiresAt <= now) return { status: "invalid" };
      c.consumedAt = now;
      const { consumedAt: _a, familyId: _b, createdAt: _c, ...rec } = c;
      return { status: "ok", code: rec };
    },
    async createGrant(g, _now) {
      families.set(g.familyId, { clientId: g.clientId, userId: g.userId, scope: g.scope, expiresAt: g.refreshExpiresAt, revokedAt: null, revokedReason: null });
      refresh.set(g.refreshHash, { familyId: g.familyId, expiresAt: g.refreshExpiresAt, usedAt: null });
      const c = codes.get(g.codeHash);
      if (c) c.familyId = g.familyId;
    },
    async rotateRefreshToken(oldHash, clientId, newHash, newExpiresAt, now) {
      const r = refresh.get(oldHash);
      if (!r) return { status: "invalid" };
      const f = families.get(r.familyId);
      if (!f || f.clientId !== clientId || f.revokedAt !== null || f.expiresAt <= now) return { status: "invalid" };
      if (r.usedAt !== null) { revokeFamily(r.familyId, "refresh_reuse", now); return { status: "reused" }; }
      if (r.expiresAt <= now) return { status: "invalid" };
      r.usedAt = now;
      refresh.set(newHash, { familyId: r.familyId, expiresAt: newExpiresAt, usedAt: null });
      f.expiresAt = Math.max(f.expiresAt, newExpiresAt);
      return { status: "ok", familyId: r.familyId, userId: f.userId, scope: f.scope };
    },
    async revokeRefreshToken(hash, clientId, now) {
      const r = refresh.get(hash);
      const f = r ? families.get(r.familyId) : undefined;
      if (r && f && f.clientId === clientId) revokeFamily(r.familyId, "revoked", now);
    },
    async revokeAccessToken(jti, expiresAt) { denylist.set(jti, expiresAt); },
    async isAccessTokenRevoked(jti, familyId, now) {
      const d = denylist.get(jti);
      if (d !== undefined && d > now) return true;
      const f = families.get(familyId);
      return !f || f.revokedAt !== null;
    },
    async cleanup(now) {
      let n = 0;
      for (const [k, c] of codes) if (c.expiresAt < now - HOUR) { codes.delete(k); n++; }
      for (const [k, r] of refresh) if (r.expiresAt < now) { refresh.delete(k); n++; }
      for (const [k, f] of families) if (f.expiresAt < now || (f.revokedAt !== null && f.revokedAt < now - 24 * HOUR)) {
        families.delete(k); n++;
        for (const [h, r] of refresh) if (r.familyId === k) refresh.delete(h);
      }
      for (const [k, e] of denylist) if (e < now) { denylist.delete(k); n++; }
      for (const [k, c] of clients) {
        const hasGrant = [...families.values()].some(f => f.clientId === k);
        if ((c.lastUsedAt === null && c.createdAt * 1000 < now - 7 * 24 * HOUR) ||
            (c.lastUsedAt !== null && c.lastUsedAt < now - 180 * 24 * HOUR && !hasGrant)) { clients.delete(k); n++; }
      }
      return n;
    },
    async close() {},
    dump: () => ({ clients: clients.size, codes: codes.size, families: families.size, refresh: refresh.size, denylist: denylist.size }),
  };
}

type Queryable = Pick<Pool, "query" | "connect" | "end">;
const ts = (ms: number) => new Date(ms).toISOString();

/**
 * Postgres store (DATABASE_URL, owner connection). Uses only parameterized SQL; the
 * multi-step operations run in one transaction with row locks.
 */
export function createPgOAuthStore(pool: Queryable): OAuthStore {
  async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch { /* connection already broken */ }
      throw e;
    } finally { c.release(); }
  }
  const revokeFamilySql = "UPDATE public.mcp_oauth_grant_families SET revoked_at = $2, revoked_reason = $3 WHERE family_id = $1 AND revoked_at IS NULL";

  return {
    kind: "postgres",
    registerClient: (c, maxPerHour, now) => tx(async db => {
      // Serialise registrations so the per-hour cap cannot be raced past.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('public.mcp_oauth_clients'))");
      const { rows } = await db.query("SELECT count(*)::int AS n FROM public.mcp_oauth_clients WHERE created_at > $1", [ts(now - HOUR)]);
      if ((rows[0]?.n ?? 0) >= maxPerHour) return "cap" as const;
      await db.query(
        `INSERT INTO public.mcp_oauth_clients (client_id, client_secret_hash, client_secret_expires_at, client_name, redirect_uris,
           token_endpoint_auth_method, grant_types, response_types, scope, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [c.clientId, c.clientSecretHash, c.clientSecretExpiresAt === null ? null : ts(c.clientSecretExpiresAt * 1000), c.clientName,
          c.redirectUris, c.tokenEndpointAuthMethod, c.grantTypes, c.responseTypes, c.scope, ts(c.createdAt * 1000)]);
      return "ok" as const;
    }),
    async getClient(id) {
      const { rows } = await pool.query(
        `SELECT client_id, client_secret_hash, extract(epoch from client_secret_expires_at)::bigint AS secret_exp, client_name, redirect_uris,
                token_endpoint_auth_method, grant_types, response_types, scope, extract(epoch from created_at)::bigint AS created
           FROM public.mcp_oauth_clients WHERE client_id = $1`, [id]);
      const r = rows[0];
      if (!r) return null;
      return {
        clientId: r.client_id, clientSecretHash: r.client_secret_hash, clientSecretExpiresAt: r.secret_exp === null ? null : Number(r.secret_exp),
        clientName: r.client_name, redirectUris: r.redirect_uris, tokenEndpointAuthMethod: r.token_endpoint_auth_method,
        grantTypes: r.grant_types, responseTypes: r.response_types, scope: r.scope, createdAt: Number(r.created),
      };
    },
    saveCode: (c, now) => tx(async db => {
      await db.query(
        `INSERT INTO public.mcp_oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [c.codeHash, c.clientId, c.userId, c.redirectUri, c.codeChallenge, c.scope, c.resource, ts(now), ts(c.expiresAt)]);
      await db.query("UPDATE public.mcp_oauth_clients SET last_used_at = $2 WHERE client_id = $1", [c.clientId, ts(now)]);
    }),
    consumeCode: (hash, clientId, now) => tx(async db => {
      const { rows } = await db.query(
        `SELECT client_id, user_id, redirect_uri, code_challenge, scope, resource, consumed_at, family_id,
                (extract(epoch from expires_at) * 1000)::bigint AS exp_ms
           FROM public.mcp_oauth_codes WHERE code_hash = $1 FOR UPDATE`, [hash]);
      const r = rows[0];
      if (!r || r.client_id !== clientId) return { status: "invalid" } as const;
      if (r.consumed_at !== null) {
        if (r.family_id) await db.query(revokeFamilySql, [r.family_id, ts(now), "code_reuse"]);
        return { status: "reused" } as const;
      }
      if (Number(r.exp_ms) <= now) return { status: "invalid" } as const;
      await db.query("UPDATE public.mcp_oauth_codes SET consumed_at = $2 WHERE code_hash = $1", [hash, ts(now)]);
      return { status: "ok", code: {
        codeHash: hash, clientId: r.client_id, userId: r.user_id, redirectUri: r.redirect_uri, codeChallenge: r.code_challenge,
        scope: r.scope, resource: r.resource, expiresAt: Number(r.exp_ms),
      } } as const;
    }),
    createGrant: (g, now) => tx(async db => {
      await db.query(
        `INSERT INTO public.mcp_oauth_grant_families (family_id, client_id, user_id, scope, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [g.familyId, g.clientId, g.userId, g.scope, ts(now), ts(g.refreshExpiresAt)]);
      await db.query(`INSERT INTO public.mcp_oauth_refresh_tokens (token_hash, family_id, created_at, expires_at) VALUES ($1,$2,$3,$4)`,
        [g.refreshHash, g.familyId, ts(now), ts(g.refreshExpiresAt)]);
      await db.query("UPDATE public.mcp_oauth_codes SET family_id = $2 WHERE code_hash = $1", [g.codeHash, g.familyId]);
    }),
    rotateRefreshToken: (oldHash, clientId, newHash, newExpiresAt, now) => tx(async db => {
      const { rows } = await db.query(
        `SELECT r.family_id, r.used_at, (extract(epoch from r.expires_at) * 1000)::bigint AS exp_ms,
                f.client_id, f.user_id, f.scope, f.revoked_at, (extract(epoch from f.expires_at) * 1000)::bigint AS fexp_ms
           FROM public.mcp_oauth_refresh_tokens r JOIN public.mcp_oauth_grant_families f USING (family_id)
          WHERE r.token_hash = $1 FOR UPDATE OF r, f`, [oldHash]);
      const r = rows[0];
      if (!r || r.client_id !== clientId || r.revoked_at !== null || Number(r.fexp_ms) <= now) return { status: "invalid" } as const;
      if (r.used_at !== null) {
        await db.query(revokeFamilySql, [r.family_id, ts(now), "refresh_reuse"]);
        return { status: "reused" } as const;
      }
      if (Number(r.exp_ms) <= now) return { status: "invalid" } as const;
      await db.query("UPDATE public.mcp_oauth_refresh_tokens SET used_at = $2 WHERE token_hash = $1", [oldHash, ts(now)]);
      await db.query(`INSERT INTO public.mcp_oauth_refresh_tokens (token_hash, family_id, created_at, expires_at) VALUES ($1,$2,$3,$4)`,
        [newHash, r.family_id, ts(now), ts(newExpiresAt)]);
      await db.query("UPDATE public.mcp_oauth_grant_families SET expires_at = greatest(expires_at, $2) WHERE family_id = $1", [r.family_id, ts(newExpiresAt)]);
      return { status: "ok", familyId: r.family_id, userId: r.user_id, scope: r.scope } as const;
    }),
    async revokeRefreshToken(hash, clientId, now) {
      await pool.query(
        `UPDATE public.mcp_oauth_grant_families f SET revoked_at = $3, revoked_reason = 'revoked'
           FROM public.mcp_oauth_refresh_tokens r
          WHERE r.token_hash = $1 AND r.family_id = f.family_id AND f.client_id = $2 AND f.revoked_at IS NULL`, [hash, clientId, ts(now)]);
    },
    async revokeAccessToken(jti, expiresAt) {
      await pool.query(
        `INSERT INTO public.mcp_oauth_revoked_access_tokens (jti, expires_at) VALUES ($1,$2) ON CONFLICT (jti) DO NOTHING`, [jti, ts(expiresAt)]);
    },
    async isAccessTokenRevoked(jti, familyId, now) {
      const { rows } = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM public.mcp_oauth_revoked_access_tokens WHERE jti = $1 AND expires_at > $3)
             OR NOT EXISTS (SELECT 1 FROM public.mcp_oauth_grant_families WHERE family_id = $2 AND revoked_at IS NULL) AS revoked`,
        [jti, familyId, ts(now)]);
      return rows[0]?.revoked !== false;
    },
    async cleanup(now) {
      const { rows } = await pool.query("SELECT public.mcp_oauth_cleanup($1) AS n", [ts(now)]);
      return Number(rows[0]?.n ?? 0);
    },
    async close() { await pool.end(); },
  };
}

export const newId = () => randomUUID();
