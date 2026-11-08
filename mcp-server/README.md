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
npm run dev:http      # tsx src/http-server.ts  (needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET)
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

- CORS allowlist: `https://claude.ai`, `https://chat.openai.com`, `https://cursor.com`, `http://localhost:6274`
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
it), `TRUST_PROXY=1`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`; leave
`MCP_ALLOW_SECRET_HEADER` unset/false. Serve only over HTTPS (the platform's TLS terminator). Health check: `GET /health`.
No deployment configuration is included in this package.

### Limitation: OAuth is not implemented

Many web connector UIs (for example Claude custom connectors, ChatGPT connectors) expect **OAuth 2.1** with
discovery (`/.well-known/oauth-protected-resource`, authorization server metadata, dynamic client registration)
rather than a static bearer token. This server only validates Supabase-style bearer JWTs. Clients that let you
set an `Authorization` header (MCP Inspector, Cursor, custom/SDK clients, curl) work today; connectors that
require OAuth discovery will not connect until an OAuth layer is added.

## Not verified

No live Supabase project, Claude Desktop, Cursor, claude.ai or ChatGPT session was used in testing (stdio or HTTP). The tests use the real MCP
client over stdio, an in-memory fake of the supabase-js query builder, and the frontend's real `importFlow`,
`validateDocument` and `decodeCloudDraftRows`, all imported read-only.
