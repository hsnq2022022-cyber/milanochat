# Passive flow shadow gate — existing Supabase project

## Backward compatibility
- Existing `milan-api` AI responder and Meta/WhatsApp sender are unchanged.
- With `FLOW_SHADOW_MODE` **unset**, the new branch does not perform database reads, route to flows, debit credits or log customer data. This is the production default.
- Even when `FLOW_SHADOW_MODE=observe` and both database switches are ON, it **only logs eligibility**; it never sends messages or alters the legacy AI reply path.
- It reads verified `tenantId` and `account.id` already obtained inside the signed-webhook handler. If the account lacks a valid UUID (such as some wa_bindings), observation is declined.
- All missing tables, deny-by-default values and PostgREST errors return false and keep the legacy reply path unchanged.
- No customer raw text, message IDs or tokens are written to shadow logs.

## Evidence
- [CI #40691749672](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40691749672) — 7 pure gate tests + 2 integration/order tests; scoped flow TypeScript, Deno module check and Vite build.
- The first run failed on **known pre-existing** `npm run typecheck` errors from `main` (missing `@types/node`, `API`/Dashboard undefined references). These are addressed in PR #117 but not silently modified in this security-focused patch. Do not interpret the scoped green build as a full green frontend typecheck.
- Separate [PR #133](https://github.com/hsnq2022022-cyber/milanochat/pull/133) adds OFF-by-default per-tenant + global tables. Not deployed.

## Risks and GO
- This patch touches the existing `milan-api` function and must NOT deploy without its own GO, a verified previous function revision and flag-OFF regression using test-owned Meta accounts.
- Running as `observe` adds up to two read-only queries per eligible inbound event; Free-tier limits may be affected. Keep it OFF unless needed during test-only canary.
- Actual responder ownership/transactional outbox, signed webhooks and real billing remain separate release blockers.
- Rollback: leave `FLOW_SHADOW_MODE` unset (instant no-op for new logic); for any function regression, restore the previous approved Edge Function revision.
