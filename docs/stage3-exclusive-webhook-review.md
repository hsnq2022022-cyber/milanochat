# Stage 3 — exclusive Webhook claim (REVIEW ONLY)

Project: existing Supabase nmhefwvhoholcjrbbila. Source: PR #140 stacked on PR #137. No production migration, Edge deployment, main merge, or Meta send is authorized.

## Exact current path

`milan-api/index.ts` receives GET verification and signed POST for WhatsApp and Instagram/Facebook. For inbound events it resolves channel_accounts -> tenant and conversation, persists `messages` with `wa_message_id`, checks human handoff/account flags/credits, invokes RAG+LLM, sends via Meta/WhatsApp, inserts outbound `messages`, and calls `consume_reply`.

The earliest exclusive decision point is **after the inbound message INSERT commits** and all existing human/account/credit checks, and **before the first AI or flow send**. Provider IDs are required. A missing provider ID or failed claim blocks automatic sending rather than risking a duplicate.

PR #137 candidate adds fail-closed signature verification and checks PostgREST INSERT `error`; the live milan-api v101 does not yet contain the new changes. The production `consume_reply(uuid,uuid)` has an existing no-credit ghost-ledger bug and the legacy webhook/widget caller omits `p_message_id`; do not deploy only that migration.

## Design and actual behavior

- `automation_message_claims`: private service-only, RLS-on table, unique (tenant, account, provider platform, provider event ID), and UNIQUE inbound message. `outgoing_message_id` is generated once and stable.
- `flow_claim_inbound`: SECURITY INVOKER service-only RPC validates the already-persisted inbound message, its tenant and account, and the provider event ID. An INSERT with a unique constraint serializes concurrent webhook requests and returns `acquired=true` to exactly one. Redelivery gets `acquired=false`; it NEVER sends or charges.
- SQL gate chooses `legacy_ai` by default. `flow` is possible only if the *server* prepared a supported message-only flow and global/tenant test-only flags and an active matching publication are enabled. `FLOW_RUNTIME_MODE` is absent by default, so **legacy AI owns all events**.
- Preflight engine exceptions => `null` => the claim is allocated to legacy AI. After claim, the route is not switched or released, avoiding double sends.
- `processExclusiveEvent`: exactly one outbound provider send attempt, fixed `messages.id`, then call `consume_reply(p_tenant_id,p_message_id)` once. `-2` means already billed.
- The prepared flow subset is intentionally limited to one trigger(message) -> one plain text message. Other graphs, multiple active flows, actions, requests, delays, buttons and malformed publications fall back to legacy AI. No automatic flow activation.
- This gives **at-most-once attempts** per committed provider event, NOT guaranteed end-to-end exactly-once Meta delivery. If the provider accepted a send then timed out, the event is not blindly retried; it can need reconciliation.
- If outgoing storage or billing fails after an external send, the event remains claimed and no duplicate is sent. An alert/reconciliation procedure is still required. Two different incoming messages competing for the last credit may cause an already-sent reply to be blocked from billing; production activation must plan reservation/reconciliation before promising exact-once charging under arbitrary workloads.
- Widget uses a separate `widget_messages` table and still calls the old RPC with the wrong arguments. The proposed corrected `consume_reply` handles `public.messages` outbound messages only. **Widget billing remains out-of-scope and must be reviewed separately before deployment**.

## Tests

`.github/workflows/flow-exclusive-claim-ci.yml` runs disposable PG17, two separate racing clients, a unique winner/duplicate, owner spoof rejection, OFF and broken engine legacy fallback, simulated one outbound + one ledger/credit, and Node tests for one-send/one-debit, redelivery, parallel handling and ambiguous provider send errors. It also Deno-checks the actual milan-api candidate and builds the website.

This is a code + local synthetic DB harness, NOT a real signed Meta/provider-send E2E test. Never claim otherwise.

## Approval requests — distinct production operations

**A. SQL claim migration** — file `supabase/migrations/20261028220000_webhook_exclusive_claim.sql` only. Risk: table/unique/index FK and new RPC, permissions. Applies with all switches OFF and no worker changes. Verify RLS, service-only privileges, 0 new rows, global OFF, tenant enabled=0, outbox=0, milan-api 101. Rollback `supabase/rollbacks/20261028220000_webhook_exclusive_claim.rollback.sql` refuses if any real claims exist; do not drop history.

**B. SQL billing fix** — file `supabase/migrations/20261028221000_consume_reply_atomic.sql` only, based on PR #131. Risk: changes current function behavior, old Webhook and Widget callers omit outgoing UUID, so **needs coordinated deployment window with C**. Preserve exact existing function definition for emergency rollback, but the rollback reintroduces the ghost-ledger bug. Verify RLS, grants, valid/invalid/duplicate message checks and no new ledger entries before live send.

**C. Edge `milan-api` deployment** — replace the current version 101 with reviewed consolidated source from PR #140, all imported helper files and existing secrets; must be a separate explicit GO. Failure cases: missing claim RPC causes fail-closed suppression of all automatic webhook replies, unmatched provider event ID suppresses replies, unexpected billing errors may leave uncharged outbound sends. Run signed-provider test-owned replay and 0/1-send + ledger assertions before any traffic switchover; never deploy before A and B. Verify exact new version, old Widget/UI behavior, Meta signatures, OFF legacy ownership, no duplicate sends and billing. Roll back by temporarily halting incoming provider processing, restoring version 101, and reconciling claims; a blind rollback without coordinating provider retries can reintroduce duplicate sends.

**D. Activate test-only flow engine** — NOT in the above three approvals. Requires separate GO to set `FLOW_RUNTIME_MODE=message_only` and any relevant DB test-only switches with explicit test tenant/account. All flags currently OFF. A more complete runtime worker/outbox and delivery retry reconciliation require later scoped work.

**Deferred until end:** `flow-publication` remains un-deployed on PR #139; manual workflow remains on its branch; no new secrets or main changes.

## Verification and rollback notes

- PR #140 depends on PR #137 and needs a coordinated review before any production merge/deploy.
- Default old AI when **flow engine** unavailable is verified. If **DB claim** is unavailable, Webhook sends are blocked rather than bypassing exclusivity (this protects against duplicate sends).
- Because Meta sends and PostgreSQL cannot share a transaction, exactly-once *external delivery* cannot be promised without provider-side idempotency/reconciliation.
