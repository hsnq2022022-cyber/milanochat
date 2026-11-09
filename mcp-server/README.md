# Milanochat Flows MCP server

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) that lets
Claude Desktop, Cursor, ChatGPT (MCP-capable clients) create and edit Milanochat automation flows
in natural language. It writes nodes and edges in the **exact JSON shape of the Flow Builder**
(`src/flow/model.ts`), so the Flow Builder's own `importFlow` accepts them unchanged (this is tested).

> ## SECURITY WARNING
> This server uses `SUPABASE_SERVICE_ROLE_KEY`, which **bypasses Row Level Security**. Anyone who can
> talk to this process can edit flows of **any tenant** unless you set `MILANO_ALLOWED_TENANT_ID`.
> - Run the stdio server only locally, for a trusted operator. Never expose it over a network
>   (the separate HTTP server authenticates every request; see "Remote (HTTP) server").
> - **Set `MILANO_ALLOWED_TENANT_ID`** to lock the server to one tenant. With it set, every tool refuses
>   other tenant ids and refuses flows owned by other tenants.
> - Without it, `add_node` / `connect_nodes` (which take only `flow_id`) can edit any tenant's flow
>   whose id is known. Pass the optional `tenant_id` argument to scope them.
> - Every query is explicitly filtered by `tenant_id` (RLS does not protect you here).
> - Keys are read from the environment only and never logged. Do not commit `.env`.

## Storage: read this first (verified mismatch with the original brief)

The brief described a table `automation_flows(id, tenant_id, name, nodes, edges, created_at, updated_at)`.
**No migration or proposal in this repository creates such a table.** What the Flow Builder actually
reads is `public.automation_flow_drafts` (see `supabase/proposals/automation_flow_drafts.review.sql`,
`src/flow/cloudDraft.ts`):

| column | notes |
|---|---|
| `tenant_id uuid` | PK part, FK `tenants.id` |
| `flow_key text` | PK part, 1-128 chars (this server's `flow_id`) |
| `name text` | 1-100 chars |
| `document jsonb` | `{version:3, name, nodes:[...], edges:[...]}`, max 4 MiB |
| `draft_revision int` | optimistic lock used by the UI |
| `created_at`, `updated_at` | timestamps |

So there are two storage adapters, selected with `MILANO_FLOWS_STORAGE`:

- `columns` (**default**, as in the brief): table `MILANO_FLOWS_TABLE` (default `automation_flows`), writes only
  `id, tenant_id, name, nodes, edges, created_at, updated_at`; version token = `updated_at`.
  **The Flow Builder does not read this table today.** The table must exist (this project does not create it).
- `drafts`: table `MILANO_FLOWS_TABLE` (default `automation_flow_drafts`), the real cloud-draft layout;
  version token = `draft_revision` (same lock as the UI, so it never clobbers a browser save).
  Flows show up in the Flow Builder's cloud-draft panel (explicit pull, imported as a disabled copy;
  the panel lists the 30 most recently updated drafts per tenant). Nothing is published or activated.

## Install and run

```bash
cd mcp-server
npm install
cp .env.example .env   # fill it in for local `npm run dev`; MCP clients pass env themselves
npm run build          # -> dist/
npm run dev            # tsx src/index.ts (stdio; waits for an MCP client)
npm start              # node dist/index.js
npm test               # build + node:test (stdio smoke + in-memory tool tests, no network)
```

`npm run dev` does not load `.env` automatically. Export the variables in your shell
(`set -a; . ./.env; set +a`) or use the client's `env` block.

stdout is the MCP protocol channel. All logs go to stderr.

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "milanochat-flows": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/milanochat/mcp-server/dist/index.js"],
      "env": {
        "SUPABASE_URL": "https://YOUR-PROJECT.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "YOUR-SERVICE-ROLE-KEY",
        "MILANO_FLOWS_STORAGE": "drafts",
        "MILANO_ALLOWED_TENANT_ID": "YOUR-TENANT-UUID"
      }
    }
  }
}
```

Run `npm run build` first. Restart Claude Desktop after editing the file.

### Cursor

Use the same block in `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project), under `"mcpServers"`.
Do not put a real key in a project file that is committed. ChatGPT and other clients that support stdio
MCP servers use the same command, args and env.

## Tools

| tool | arguments |
|---|---|
| `create_flow` | `tenant_id` (uuid), `name` (1-100). Seeds one trigger node (needed: the Flow Builder rejects flows with zero nodes). Returns `flow_id` and the trigger node id. |
| `add_node` | `flow_id`, `node_type` (`message`/`question`/`delay`/`condition`/`end`), **`position_x`, `position_y` (required numbers)**, `data`, optional `tenant_id`. Returns the node id and its output handles. |
| `connect_nodes` | `flow_id`, `source_node_id`, `target_node_id`, optional `source_handle`, optional `tenant_id`. |
| `list_flows` | `tenant_id`. |

`data` fields (unknown keys are rejected; aliases in brackets):
`title` [`label`], `text` [`message`], `options` [`buttons`] (strings or `{id?, label}`, message/question),
`input_mode` (`buttons`/`text`/`email`/`phone`) and `input_field` (question),
`delay_value` (> 0) and `delay_unit` (delay), `condition_field`, `operator` (`contains`/`equals`/`not_equals`/`exists`), `condition_value` (condition).
Defaults match the Flow Builder's `makeNode` (for example a question without buttons gets its two default buttons).

### Output handles (`source_handle`)

These are the Flow Builder's real port ids, not `output-0` style indexes:

| source node | handles |
|---|---|
| trigger, delay | `next` (default) |
| message | `next` (default) and the **id of each button** |
| question, buttons mode | the **id of each button** (from `add_node` output) |
| question, typed answer | `valid` (default) |
| condition | `yes`, `no` (required) |
| end | none |

Rules enforced: nodes must exist, no self-loop, no duplicate edge, one connection per output, `end` cannot be
a source, the trigger cannot be a target, at most 100 nodes / 250 edges.

### Written shape

```json
{"id":"<uuid>","type":"flowNode","position":{"x":100,"y":100},
 "data":{"kind":"message","title":"Greeting","text":"Hello","image":"","options":[{"id":"<uuid>","label":"Prices","buttonType":"button","action":"step","targetFlowId":"","url":""}],
         "contentBlocks":[],"platform":"instagram","keywords":"","triggerMode":"keyword", "...": "all other makeNode defaults"}}
{"id":"<uuid>","type":"flowEdge","source":"<node>","target":"<node>","sourceHandle":"next","targetHandle":"in","data":{"label":"التالي"}}
```

### Concurrency

Each edit loads the flow, appends, and updates with a condition on the version token (`updated_at` or
`draft_revision`). If someone else saved in between, it reloads and retries once; if that also races it
returns a clear `Conflict` error and writes nothing.

## Example prompts

- "Create a flow named 'Welcome' for tenant `<uuid>` and add a message node at 100,100 saying 'Hello'."
- "Add a question at 100,400 asking 'What do you need?' with buttons Prices and Staff, then connect the welcome message to it."
- "Connect the 'Prices' button of the question to a new end node at 0,700."
- "List my flows."
- "أنشئ تدفقًا باسم «ترحيب» وأضف رسالة عند 100,100 نصها «أهلاً بك»"
- "أضف سؤالًا عند 100,400 بأزرار «الأسعار» و«موظف» واربط الرسالة به"
- "اعرض قائمة التدفقات"

## Remote (HTTP) server

`src/http-server.ts` serves the same four tools over the MCP **Streamable HTTP** transport, so web
clients can connect by URL. It is **stateless**: every `POST /mcp` gets a fresh `McpServer` + transport
(no `Mcp-Session-Id`), closed when the response closes. `GET /mcp` and `DELETE /mcp` return 405.

| endpoint | |
|---|---|
| `GET /health` | `200 {"status":"ok","transport":"http"}` |
| `POST /mcp` | MCP endpoint (JSON responses) |

```bash
npm run build
npm run dev:http      # tsx src/http-server.ts  (needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET; see OAuth below)
npm run start:http    # node dist/http-server.js
ngrok http 8080       # public https URL for testing; then set TRUST_PROXY=1
```

### Auth and tenant scoping

- `Authorization: Bearer <Supabase access token>`, verified locally with `SUPABASE_JWT_SECRET` (HS256 only):
  `exp` checked (5 s clock tolerance), `sub` required, `aud` must be `authenticated` when present, `role` must be
  `authenticated` when present (so the anon / service-role keys are not accepted as user tokens).
- Tenant: a uuid `tenant_id` claim (top level or `app_metadata.tenant_id`; `user_metadata` is ignored because
  users can edit it). Otherwise `tenants.id` where `tenants.user_id = sub` (same lookup as the Flow Builder's
  `resolveCloudTenant`), via the service-role client, cached 60 s (max 1000 users, positive results only).
  No tenant -> `403`. Lookup failure -> `503`. Missing/invalid/expired token -> `401` + `WWW-Authenticate: Bearer`.
- In remote mode the tool schemas have **no `tenant_id` argument** and are strict: a client-supplied
  `tenant_id` is rejected. The tenant from the request context is used for every store call; `add_node` /
  `connect_nodes` refuse flows of other tenants with the same "not found" error as a missing id.
- If `MILANO_ALLOWED_TENANT_ID` is set it is also enforced here (any other tenant -> 403).

### Try it (test mode, no token)

```bash
MCP_ALLOW_SECRET_HEADER=true npm run start:http   # with the 3 required vars exported; NOT in production

curl -s http://localhost:8080/health

curl -s -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'X-Milano-Tenant: 11111111-1111-4111-8111-111111111111' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'X-Milano-Tenant: 11111111-1111-4111-8111-111111111111' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_flow","arguments":{"name":"Welcome"}}}'
```

Without a token (and with the flag off the header is simply ignored):

```bash
curl -s -i -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer realm="milanochat-mcp"
# {"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized: a valid Bearer token is required."},"id":null}
```

Bearer path with a locally minted test token (run inside `mcp-server/`; uses the same secret as the server):

```bash
TOKEN=$(node -e 'import("jose").then(async({SignJWT})=>console.log(await new SignJWT({role:"authenticated",tenant_id:process.argv[1]}).setProtectedHeader({alg:"HS256"}).setSubject("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").setAudience("authenticated").setIssuedAt().setExpirationTime("15m").sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET))))' 11111111-1111-4111-8111-111111111111)
curl -s -X POST http://localhost:8080/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_flows","arguments":{}}}'
```

Drop the `tenant_id` claim to exercise the `tenants.user_id = sub` lookup (needs a real user id).

### Hardening

- CORS allowlist: `https://claude.ai`, `https://chat.openai.com`, `https://chatgpt.com`, `https://cursor.com`, `http://localhost:6274`
  (MCP Inspector). Requests without `Origin` (server-to-server clients) are allowed; other browser origins get no
  CORS headers and `403` on `/mcp`.
- Rate limit 20 requests/min per IP on `/mcp` (`429`, `RateLimit` headers). Behind ngrok/Railway set
  `TRUST_PROXY=1`, otherwise all clients share the proxy's IP. Never set it higher than the real number of hops.
- Body: `application/json` only (`415`), max 256 kb (`413`), invalid JSON `400` (-32700), non-object bodies `400`.
  No stack traces to clients; `nosniff`, no `X-Powered-By`; request timeout 30 s.
- Tokens, keys and tenant-supplied values are never logged.

> **SECURITY**
> - `X-Milano-Tenant` (`MCP_ALLOW_SECRET_HEADER=true`) is an **unauthenticated testing bypass**: anyone who can
>   reach the port can edit any tenant's flows. It logs a warning at startup and on every request, and the server
>   **refuses to start** with it when `NODE_ENV=production`. Keep it `false` anywhere reachable.
> - The service-role key **bypasses RLS**. Isolation relies on per-request tenant scoping in this server
>   (every query filtered by the tenant from the verified token, every loaded flow re-checked).
> - Treat `SUPABASE_JWT_SECRET` like the service-role key. If the project uses asymmetric JWT signing keys
>   (JWKS) instead of the legacy HS256 secret, this verifier does not support it yet.

### Deployment notes

Run `npm ci && npm run build`, start with `npm run start:http`, set `NODE_ENV=production`, `PORT` (Railway sets
it), `TRUST_PROXY=1`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; for OAuth `MCP_OAUTH_ENABLED=true`,
`MCP_PUBLIC_URL`, `MCP_OAUTH_SIGNING_SECRET`, `SESSION_SECRET`, `SUPABASE_ANON_KEY`, `DATABASE_URL` (+ `DATABASE_SSL_CA_FILE`)
after applying migration 20261029320000; `SUPABASE_JWT_SECRET` only with `MCP_ALLOW_STATIC_BEARER=true` (off by default in
production; with neither OAuth nor static bearer the server refuses to start). Leave `MCP_ALLOW_SECRET_HEADER` unset/false. Serve only over HTTPS (the platform's TLS terminator). Health check: `GET /health`.
No deployment configuration is included in this package.

## OAuth 2.1 (web connectors: Claude.ai, ChatGPT, Cursor)

With `MCP_OAUTH_ENABLED=true` the HTTP server is also an OAuth 2.1 authorization server and
protected resource, as required by the MCP authorization spec: authorization code + **PKCE S256 only**,
refresh tokens with rotation, Dynamic Client Registration (RFC 7591), RFC 8414 / RFC 9728 discovery.
Stdio (`src/index.ts`) is unchanged; with the flag off the HTTP server behaves as before.

### Library decision

- `mcp-oauth-server` (npm) **exists** (v1.0.1, Oct 2026, PKCE + DCR + custom storage advertised), but it is a
  young single-maintainer package (first release Nov 2025) that has not been vetted here. **Not used.**
- Used instead: the **official `@modelcontextprotocol/sdk` (1.32.2) server auth module** already installed:
  `mcpAuthRouter` (metadata, `/authorize`, `/token`, `/register`, `/revoke` handlers) with our own
  `OAuthServerProvider` (`src/oauthProvider.ts`) and storage (`src/oauthStore.ts`). Added dependencies:
  `express-session`, `pg` (+ `@types/*`). Where the SDK is weaker than this brief we add guards in front of it:
  exact `redirect_uri` match (the SDK accepts any port on loopback), hashed client secrets (the SDK compares
  plaintext secrets, so confidential clients are authenticated before its handlers), PKCE verified only
  after the code is consumed (a wrong verifier burns the code), our own per-minute rate limits.

### Endpoints (issuer = `MCP_PUBLIC_URL`)

| endpoint | |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata (`code_challenge_methods_supported: ["S256"]`) |
| `GET /.well-known/oauth-protected-resource` (and `/mcp` suffix) | `resource = <issuer>/mcp`, `authorization_servers`, `scopes_supported: ["mcp:tools"]` |
| `POST /register` | DCR. redirect URIs: https, or http only for `localhost` / `127.0.0.1`; max 5; no fragment. `token_endpoint_auth_method` `none` or `client_secret_post` |
| `GET /authorize` | `response_type=code`, `code_challenge_method=S256` required (missing/plain -> error redirect keeping `state`), exact `redirect_uri` match |
| `GET/POST /consent`, `POST /consent/login` | Arabic (RTL) login + consent pages |
| `POST /token` | `authorization_code` (+ `code_verifier`, `redirect_uri`), `refresh_token` |
| `POST /revoke` | RFC 7009 (access token -> jti denylist; refresh token -> whole grant revoked) |

Unauthenticated `POST /mcp` -> `401` with
`WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource", scope="mcp:tools"`.

### Tokens and grants

- Access token: JWT HS256 (`MCP_OAUTH_SIGNING_SECRET`, >= 32 chars, must differ from `SUPABASE_JWT_SECRET`),
  header `typ: at+jwt`, claims `iss`, `aud = <issuer>/mcp`, `sub` (Supabase user id), `client_id`, `scope`,
  `exp` (1 h), `jti`, `fam` (grant family). `/mcp` checks signature, typ, exp, iss, **aud** (tokens for other
  resources are refused: no token passthrough), scope `mcp:tools` (else 403 `insufficient_scope`), jti
  denylist and family revocation.
- Refresh token: opaque, 30 days, **rotated on every use**. Presenting an already-rotated refresh token
  revokes the whole grant family (every refresh and access token of that consent).
- Authorization code: opaque, single use, 5 min, bound to client_id + redirect_uri + code_challenge + user.
  Replaying a used code revokes the grant issued from it.
- Only SHA-256 hashes of client secrets, codes and refresh tokens are stored.

### Login, consent, tenant

- `/authorize` parks the request in a short session and redirects to `/consent`. If not signed in, an Arabic
  login form posts to `/consent/login`, which calls Supabase Auth server-side
  (`POST {SUPABASE_URL}/auth/v1/token?grant_type=password` with `SUPABASE_ANON_KEY`). The password is never stored
  or logged; only the verified user id is kept in the session, and the session id is regenerated on login.
- Consent page: client name (from DCR, attacker-controlled: control/bidi chars stripped, capped at 100 chars,
  HTML-escaped), the **redirect host shown prominently** (anti-phishing), scope `mcp:tools` =
  «إنشاء وتعديل تدفقات الأتمتة», buttons «سماح» / «رفض». «رفض» -> redirect with `error=access_denied`.
- Hardening: CSRF token bound to the session on every POST, Origin check, `X-Frame-Options: DENY`,
  CSP `default-src 'none'; style-src 'nonce-…'; form-action 'self' <redirect origin>; frame-ancestors 'none'`,
  `Cache-Control: no-store`. Session cookie `milano_mcp_sid`: HttpOnly, SameSite=Lax, Secure (unless
  `MCP_INSECURE_COOKIES=true`, local http dev only, refused in production), 15 min.
- Tenant: from `tenants.user_id = sub` only (same resolver + cache as the static bearer path). No workspace ->
  no code is issued (consent shows an error) and `/mcp` answers 403. Tools still have no `tenant_id` argument
  and `X-Milano-Tenant` is ignored for OAuth tokens.
- Rate limits per IP per minute: `/authorize` 10, `/token` + `/revoke` 10, `/register` 5, login POST 5,
  `/consent` 30, `/mcp` 20. DCR is also capped globally (`MCP_OAUTH_MAX_CLIENTS_PER_HOUR`, default 100).

### Storage

`DATABASE_URL` (Supabase Postgres connection string, owner role; session pooler or direct) -> Postgres store.
Apply `supabase/migrations/20261029320000_oauth_tables.sql` first (rollback:
`supabase/rollbacks/20261029320000_oauth_tables.rollback.sql`, refuses while rows exist unless
`milan.rollback_320000=discard-mcp-oauth-grants`). Tables have RLS enabled with no policies and no
anon/authenticated privileges. Expired rows are removed by `public.mcp_oauth_cleanup()` at startup and every 15 min.
TLS: `DATABASE_SSL=verify` (default; set `DATABASE_SSL_CA_FILE` to Supabase's CA certificate),
`no-verify` (encrypted, certificate not checked), `disable` (local host only). `ssl*` parameters in the URL are ignored.

> **Without `DATABASE_URL` the store is IN-MEMORY: local development only** (lost on restart, single process).
> The server refuses to start with OAuth in `NODE_ENV=production` without `DATABASE_URL`.
> Login/consent sessions are in-process (bounded, 15 min): run one instance, or use sticky sessions.

### Environment

| var | |
|---|---|
| `MCP_OAUTH_ENABLED` | `true` to enable OAuth |
| `MCP_PUBLIC_URL` | issuer origin, https (http only for localhost outside production), no path |
| `MCP_OAUTH_SIGNING_SECRET` | >= 32 random chars (`openssl rand -base64 48`) |
| `SESSION_SECRET` | >= 32 random chars, different from the signing secret |
| `SUPABASE_ANON_KEY` | for the server-side password login |
| `DATABASE_URL` | required in production |
| `MCP_ALLOW_STATIC_BEARER` | Supabase user JWT as Bearer. Default **false in production**, true elsewhere (then `SUPABASE_JWT_SECRET` is required) |
| `MCP_ALLOW_SECRET_HEADER` | testing-only `X-Milano-Tenant`, refused in production (unchanged) |
| `MCP_INSECURE_COOKIES` | local http dev only, refused in production |
| `TRUST_PROXY` | `1` behind ngrok / Railway (needed for Secure cookies and per-IP limits) |

Startup errors list missing variable names only, never values.

### Run locally (http, memory store)

```bash
export SUPABASE_URL=https://YOUR-PROJECT.supabase.co SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=...
export MCP_OAUTH_ENABLED=true MCP_PUBLIC_URL=http://localhost:8080 MCP_INSECURE_COOKIES=true
export MCP_OAUTH_SIGNING_SECRET="$(openssl rand -base64 48)" SESSION_SECRET="$(openssl rand -base64 48)"
export MCP_ALLOW_STATIC_BEARER=false
npm run build && npm run start:http
curl -s http://localhost:8080/.well-known/oauth-authorization-server
curl -s http://localhost:8080/.well-known/oauth-protected-resource
```

### Via ngrok (https)

```bash
ngrok http 8080                                   # copy the https forwarding URL
export MCP_PUBLIC_URL=https://YOUR-ID.ngrok-free.app TRUST_PROXY=1
unset MCP_INSECURE_COOKIES                         # Secure cookies over https
npm run start:http
```

### Add as a connector

- **Claude.ai**: Settings -> Connectors -> Add custom connector -> URL `<MCP_PUBLIC_URL>/mcp`. Claude discovers the
  metadata, registers itself (DCR), opens the login/consent page, then lists the four tools.
  Its callback (`https://claude.ai/api/mcp/auth_callback`) is accepted by the redirect URI rules.
- **ChatGPT** (connectors / developer mode): same URL, OAuth authentication. Callback on `chatgpt.com` (https) is accepted.
- **Cursor**: remote URL `<MCP_PUBLIC_URL>/mcp`. Cursor's desktop OAuth callback uses a custom `cursor://` scheme,
  which this server **rejects** (https / localhost only, by design); use a static bearer
  (`MCP_ALLOW_STATIC_BEARER=true`, header `Authorization`) for Cursor, or a client with an https/localhost callback.
- **MCP Inspector**: `npx @modelcontextprotocol/inspector`, transport Streamable HTTP, URL `<issuer>/mcp`
  (callback `http://localhost:6274/oauth/callback` is accepted).

### PKCE walkthrough with curl

```bash
ISS=http://localhost:8080
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
CLIENT_ID=$(curl -s -X POST $ISS/register -H 'Content-Type: application/json' \
  -d '{"client_name":"curl test","redirect_uris":["http://localhost:9999/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}' \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).client_id))')
echo "$ISS/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=http://localhost:9999/callback&code_challenge=$CHALLENGE&code_challenge_method=S256&scope=mcp:tools&state=xyz"
# Open that URL in a browser, sign in, press «سماح». The browser lands on
# http://localhost:9999/callback?code=...&state=xyz&iss=... (nothing listens there: copy the code from the address bar).
CODE=PASTE_CODE_HERE
curl -s -X POST $ISS/token -d grant_type=authorization_code -d client_id=$CLIENT_ID -d code=$CODE \
  -d code_verifier=$VERIFIER --data-urlencode redirect_uri=http://localhost:9999/callback
# -> {"access_token":"...","token_type":"Bearer","expires_in":3600,"refresh_token":"...","scope":"mcp:tools"}
curl -s -X POST $ISS/mcp -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s -X POST $ISS/token -d grant_type=refresh_token -d client_id=$CLIENT_ID -d refresh_token=$REFRESH
# The old refresh token is now spent: presenting it again revokes the whole grant.
curl -s -X POST $ISS/revoke -d client_id=$CLIENT_ID -d token=$REFRESH_NEW
```

> **OAuth SECURITY**
> - HTTPS is required for any non-local issuer; set `TRUST_PROXY=1` behind ngrok/Railway.
> - Postgres (`DATABASE_URL`) is required in production; the memory store is for development only.
> - The server still uses `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS): isolation relies on the tenant resolved
>   from the verified token on every request. Keep all secrets in the platform's secret store, never in git.
> - Rotating `MCP_OAUTH_SIGNING_SECRET` invalidates all access tokens (clients refresh); rotating
>   `SESSION_SECRET` only ends pending logins.
> - Consent phishing: anyone can register a client with any name. Users must check the **redirect host** shown on
>   the consent page and only approve connections they started themselves.
> - Ngrok free URLs change on restart: the issuer changes, so connectors must be re-added.

## Not verified

No live Supabase project, Claude Desktop, Cursor, claude.ai, ChatGPT or ngrok session was used in testing (stdio, HTTP or OAuth;
the Supabase password grant is faked; the OAuth Postgres store is tested against a throwaway local PostgreSQL 16). The tests use the real MCP
client over stdio, an in-memory fake of the supabase-js query builder, and the frontend's real `importFlow`,
`validateDocument` and `decodeCloudDraftRows`, all imported read-only.
