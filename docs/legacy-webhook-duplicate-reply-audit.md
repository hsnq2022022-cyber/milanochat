# Legacy Meta webhook: PostgREST insert response handling

## Confirmed root cause

The existing `handleIncomingWebhookMessage` in `milan-api/index.ts` awaited `sb.from("messages").insert(...)` inside a `try/catch` but **ignored the Supabase result's `error` field**. PostgREST returns SQL constraint/permission failures via `{data,error}` without throwing. Therefore the handler continued to RAG+AI even after a failed incoming message insert. This can cause a duplicate AI reply on a Meta retry.

Read-only live schema verification on Supabase `nmhefwvhoholcjrbbila` found partial UNIQUE index `idx_messages_wa_message_id` on `messages(wa_message_id)` WHERE not NULL. A replay with the same provider message id can hit SQL 23505. The old handler ignored it.

## Minimal targeted fix

- Added a small Deno/Node-compatible `persistInboundOnce` helper that accepts the existing promise-based `insert` call and returns `saved`, `duplicate`, or `failed`.
- Existing webhook handler now returns before RAG/AI on any insert failure, including SQL 23505. It logs no raw message text or IDs.
- The original flow for successful inbound inserts is unchanged, including human takeover, agent flags, credits, LLM selection, provider sending and the existing billing RPC.
- No new tables, indexes, external dependencies or frontend changes.

## Evidence

- [CI #40692057267](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40692057267): 5 new tests (valid insert, duplicate constraint, PostgREST permission/errors, transport rejection, static integration check); Node and Deno checks and Vite build succeeded.

## Remaining limitations / GO

- Provider events with a NULL external message ID cannot be deduplicated by the existing UNIQUE partial index. A future signed webhook receipt table is needed.
- The existing **post-send** outbound insert and `consume_reply` still have unsafe failure semantics. This patch does not claim to fix charging or exactly-once provider sending.
- This PR modifies `milan-api`: requires a specific owner GO, test-owned Meta replay and previous Edge revision recorded before deployment. Rollback is restore the old function revision; this would reintroduce the duplicate-reply risk.
- No production deployment, customer message or database writes performed by this PR.
