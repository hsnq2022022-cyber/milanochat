import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { SignJWT, jwtVerify, decodeProtectedHeader } from "jose";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError,
  InvalidTokenError, ServerError, TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { UUID_RE } from "./config.js";
import { newId, sha256Hex, type OAuthStore, type StoredClient } from "./oauthStore.js";

export const MCP_SCOPE = "mcp:tools";
export const ACCESS_TOKEN_TTL_SEC = 3600;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const MAX_CLIENT_NAME = 100;
const ACCESS_TOKEN_TYP = "at+jwt"; // RFC 9068; also keeps these tokens apart from Supabase JWTs

/** Authorization request parked in the browser session until login + consent. */
export type PendingAuthorization = {
  clientId: string; redirectUri: string; codeChallenge: string; scope: string; state: string | null;
  resource: string; createdAt: number;
};

declare module "express-session" {
  interface SessionData {
    userId?: string;
    csrf?: string;
    pending?: Record<string, PendingAuthorization>;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);
/** https, or http only for localhost / 127.0.0.1; no fragment, no credentials. */
export function isAllowedRedirectUri(raw: string): boolean {
  if (typeof raw !== "string" || raw.length > 2000) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash || raw.includes("#") || u.username || u.password) return false;
  if (u.protocol === "https:") return u.hostname.length > 0;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/** Strips control / bidi-override characters and caps the length. Output still needs HTML escaping. */
export function sanitizeClientName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "").trim();
  if (!s) return null;
  return [...s].slice(0, MAX_CLIENT_NAME).join("");
}

const b64url = (b: Buffer) => b.toString("base64url");
export const randomToken = () => b64url(randomBytes(32));
export function s256(verifier: string): string { return b64url(createHash("sha256").update(verifier, "ascii").digest()); }
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The SDK's error responses must never echo values; these messages are fixed strings. */
function toPublicClient(c: StoredClient): OAuthClientInformationFull {
  return {
    client_id: c.clientId,
    client_id_issued_at: c.createdAt,
    redirect_uris: [...c.redirectUris],
    token_endpoint_auth_method: c.tokenEndpointAuthMethod,
    grant_types: [...c.grantTypes],
    response_types: [...c.responseTypes],
    scope: c.scope,
    ...(c.clientName ? { client_name: c.clientName } : {}),
    // client_secret is deliberately absent: the SDK compares secrets in plaintext, ours are hashed.
    // Confidential clients are authenticated by verifyClientSecret() before the SDK token/revoke handlers.
  };
}

export type ProviderOptions = {
  store: OAuthStore;
  issuer: string;      // metadata issuer + JWT iss
  resource: string;    // <origin>/mcp + JWT aud
  signingSecret: string;
  maxClientsPerHour: number;
  now?: () => number;
};

export type VerifiedAccess = { sub: string; clientId: string; scopes: string[]; jti: string; familyId: string; exp: number };

export function createOAuthProvider(opts: ProviderOptions) {
  const now = opts.now ?? Date.now;
  const key = new TextEncoder().encode(opts.signingSecret);
  const { store } = opts;

  const clientsStore: OAuthRegisteredClientsStore = {
    async getClient(id) {
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return undefined;
      const c = await store.getClient(id);
      return c ? toPublicClient(c) : undefined;
    },
    async registerClient(info) {
      const uris = info.redirect_uris;
      if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5) throw new InvalidClientMetadataError("redirect_uris must contain 1 to 5 URIs");
      if (new Set(uris).size !== uris.length) throw new InvalidClientMetadataError("redirect_uris must be unique");
      for (const u of uris) if (!isAllowedRedirectUri(String(u)))
        throw new InvalidClientMetadataError("redirect_uris must be https URLs (http only for localhost / 127.0.0.1), without fragment");
      const method = info.token_endpoint_auth_method ?? "client_secret_post";
      if (method !== "none" && method !== "client_secret_post")
        throw new InvalidClientMetadataError("token_endpoint_auth_method must be 'none' or 'client_secret_post'");
      const grants = info.grant_types ?? ["authorization_code", "refresh_token"];
      if (!grants.includes("authorization_code") || grants.some(g => g !== "authorization_code" && g !== "refresh_token"))
        throw new InvalidClientMetadataError("grant_types must be authorization_code (+ refresh_token)");
      const responses = info.response_types ?? ["code"];
      if (responses.length !== 1 || responses[0] !== "code") throw new InvalidClientMetadataError("response_types must be ['code']");
      if (info.scope !== undefined && info.scope.split(" ").some(s => s !== MCP_SCOPE))
        throw new InvalidClientMetadataError(`scope must be '${MCP_SCOPE}'`);
      if (typeof info.client_name === "string" && info.client_name.length > 1000) throw new InvalidClientMetadataError("client_name too long");
      const clientId = randomToken().slice(0, 32);
      const secret = method === "client_secret_post" ? randomToken() : null;
      const createdAt = Math.floor(now() / 1000);
      const stored: StoredClient = {
        clientId, clientSecretHash: secret ? sha256Hex(secret) : null, clientSecretExpiresAt: null,
        clientName: sanitizeClientName(info.client_name), redirectUris: uris.map(String), tokenEndpointAuthMethod: method,
        grantTypes: grants, responseTypes: ["code"], scope: MCP_SCOPE, createdAt,
      };
      let r: "ok" | "cap";
      try { r = await store.registerClient(stored, opts.maxClientsPerHour, now()); } catch { throw new ServerError("Registration failed"); }
      if (r === "cap") throw new TooManyRequestsError("Too many client registrations, try again later");
      // The plaintext secret is returned exactly once, here.
      return { ...toPublicClient(stored), ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) };
    },
  };

  function checkResource(resource?: URL) {
    if (resource === undefined) return;
    const s = resource.href.replace(/#.*$/, "").replace(/\/$/, "");
    if (s !== opts.resource) throw new InvalidTargetError("Unknown resource");
  }

  async function issueAccessToken(sub: string, clientId: string, scope: string, familyId: string): Promise<{ token: string; exp: number }> {
    const iat = Math.floor(now() / 1000), exp = iat + ACCESS_TOKEN_TTL_SEC;
    const token = await new SignJWT({ client_id: clientId, scope, fam: familyId })
      .setProtectedHeader({ alg: "HS256", typ: ACCESS_TOKEN_TYP })
      .setIssuer(opts.issuer).setAudience(opts.resource).setSubject(sub)
      .setIssuedAt(iat).setNotBefore(iat).setExpirationTime(exp).setJti(newId())
      .sign(key);
    return { token, exp };
  }

  /** Signature, typ, exp/nbf, iss, aud (this resource only: no token passthrough), claims shape, revocation. */
  async function verifyAccess(token: string): Promise<VerifiedAccess | "revoked" | "invalid"> {
    let p;
    try {
      const h = decodeProtectedHeader(token);
      if (h.typ !== ACCESS_TOKEN_TYP || h.alg !== "HS256") return "invalid";
      ({ payload: p } = await jwtVerify(token, key, {
        algorithms: ["HS256"], issuer: opts.issuer, audience: opts.resource, typ: ACCESS_TOKEN_TYP,
        requiredClaims: ["exp", "iat", "sub", "jti"], currentDate: new Date(now()), clockTolerance: 5,
      }));
    } catch { return "invalid"; }
    if (typeof p.sub !== "string" || !UUID_RE.test(p.sub) || typeof p.jti !== "string" || !UUID_RE.test(p.jti)) return "invalid";
    if (typeof p.client_id !== "string" || typeof p.scope !== "string" || typeof p.fam !== "string" || !UUID_RE.test(p.fam)) return "invalid";
    // Store errors propagate (the caller answers 503, never "valid").
    if (await store.isAccessTokenRevoked(p.jti, p.fam, now())) return "revoked";
    return { sub: p.sub.toLowerCase(), clientId: p.client_id, scopes: p.scope.split(" ").filter(Boolean), jti: p.jti, familyId: p.fam, exp: p.exp as number };
  }

  const provider: OAuthServerProvider = {
    get clientsStore() { return clientsStore; },
    // PKCE is verified in exchangeAuthorizationCode AFTER the code is consumed, so a wrong verifier burns the code.
    skipLocalPkceValidation: true,

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
      if (!CHALLENGE_RE.test(params.codeChallenge)) throw new InvalidRequestError("code_challenge must be a base64url S256 challenge");
      const scopes = (params.scopes ?? []).filter(Boolean);
      if (scopes.some(s => s !== MCP_SCOPE)) throw new InvalidScopeError(`Only '${MCP_SCOPE}' is supported`);
      checkResource(params.resource);
      if (params.state !== undefined && params.state.length > 1000) throw new InvalidRequestError("state too long");
      const req = res.req as Request;
      if (!req.session) throw new ServerError("Session unavailable");
      const id = randomToken();
      const pending = { ...(req.session.pending ?? {}) };
      const t = now();
      for (const [k, v] of Object.entries(pending)) if (v.createdAt + PENDING_TTL_MS < t) delete pending[k];
      const keys = Object.keys(pending);
      while (keys.length >= 5) delete pending[keys.shift() as string];
      pending[id] = {
        clientId: client.client_id, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge,
        scope: MCP_SCOPE, state: params.state ?? null, resource: opts.resource, createdAt: t,
      };
      req.session.pending = pending;
      if (!req.session.csrf) req.session.csrf = randomToken();
      res.redirect(302, "/consent?req=" + encodeURIComponent(id));
    },

    async challengeForAuthorizationCode() {
      // Not called (skipLocalPkceValidation); never reveal a stored challenge.
      throw new InvalidGrantError("Invalid authorization code");
    },

    async exchangeAuthorizationCode(client, code, codeVerifier, redirectUri, resource): Promise<OAuthTokens> {
      checkResource(resource);
      if (typeof code !== "string" || code.length > 200) throw new InvalidGrantError("Invalid authorization code");
      let r;
      try { r = await store.consumeCode(sha256Hex(code), client.client_id, now()); } catch { throw new ServerError("Token exchange failed"); }
      if (r.status !== "ok") throw new InvalidGrantError("Invalid authorization code");
      const c = r.code;
      // Bound to client (checked by the store), redirect_uri, PKCE challenge and user.
      if (typeof redirectUri !== "string" || redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
      if (typeof codeVerifier !== "string" || !VERIFIER_RE.test(codeVerifier) || !safeEqual(s256(codeVerifier), c.codeChallenge))
        throw new InvalidGrantError("code_verifier does not match the challenge");
      const familyId = newId();
      const refresh = randomToken();
      try {
        await store.createGrant({ familyId, codeHash: c.codeHash, clientId: client.client_id, userId: c.userId, scope: c.scope,
          refreshHash: sha256Hex(refresh), refreshExpiresAt: now() + REFRESH_TOKEN_TTL_MS }, now());
      } catch { throw new ServerError("Token exchange failed"); }
      const at = await issueAccessToken(c.userId, client.client_id, c.scope, familyId);
      return { access_token: at.token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SEC, refresh_token: refresh, scope: c.scope };
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource): Promise<OAuthTokens> {
      checkResource(resource);
      if (typeof refreshToken !== "string" || refreshToken.length > 200) throw new InvalidGrantError("Invalid refresh token");
      const next = randomToken();
      let r;
      try { r = await store.rotateRefreshToken(sha256Hex(refreshToken), client.client_id, sha256Hex(next), now() + REFRESH_TOKEN_TTL_MS, now()); }
      catch { throw new ServerError("Token refresh failed"); }
      if (r.status !== "ok") throw new InvalidGrantError("Invalid refresh token");
      const granted = r.scope.split(" ");
      const want = (scopes ?? []).filter(Boolean);
      if (want.some(s => !granted.includes(s))) throw new InvalidScopeError("Requested scope exceeds the grant");
      const scope = want.length ? want.join(" ") : r.scope;
      const at = await issueAccessToken(r.userId, client.client_id, scope, r.familyId);
      return { access_token: at.token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SEC, refresh_token: next, scope };
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const v = await verifyAccess(token);
      if (typeof v === "string") throw new InvalidTokenError("Invalid access token");
      return { token, clientId: v.clientId, scopes: v.scopes, expiresAt: v.exp, resource: new URL(opts.resource), extra: { sub: v.sub } };
    },

    async revokeToken(client, request: OAuthTokenRevocationRequest) {
      const t = request.token;
      if (typeof t !== "string" || t.length > 4096) return;
      try {
        if (t.split(".").length === 3) {
          const v = await verifyAccess(t);
          if (typeof v !== "string" && v.clientId === client.client_id) {
            await store.revokeAccessToken(v.jti, v.exp * 1000);
            // Revoking an access token does not end the grant; revoking a refresh token does.
          }
          return;
        }
        await store.revokeRefreshToken(sha256Hex(t), client.client_id, now());
      } catch { throw new ServerError("Revocation failed"); }
    },
  };

  /** Creates the authorization code after consent. Returns the plaintext code (stored hashed). */
  async function createAuthorizationCode(p: PendingAuthorization, userId: string): Promise<string> {
    const code = randomToken();
    await store.saveCode({
      codeHash: sha256Hex(code), clientId: p.clientId, userId, redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge, scope: p.scope, resource: p.resource, expiresAt: now() + AUTH_CODE_TTL_MS,
    }, now());
    return code;
  }

  /** Client authentication for /token and /revoke (hash comparison, constant time). */
  async function verifyClientSecret(clientId: unknown, secret: unknown): Promise<"ok" | "invalid"> {
    if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(clientId)) return "invalid";
    const c = await store.getClient(clientId);
    if (!c) return "invalid";
    if (c.tokenEndpointAuthMethod === "none") return secret === undefined || secret === "" ? "ok" : "invalid";
    if (typeof secret !== "string" || secret.length > 200 || !c.clientSecretHash) return "invalid";
    if (!safeEqual(sha256Hex(secret), c.clientSecretHash)) return "invalid";
    if (c.clientSecretExpiresAt && c.clientSecretExpiresAt < Math.floor(now() / 1000)) return "invalid";
    return "ok";
  }

  return { provider, verifyAccess, createAuthorizationCode, verifyClientSecret, getClient: (id: string) => store.getClient(id), now };
}

export type OAuthProviderBundle = ReturnType<typeof createOAuthProvider>;
