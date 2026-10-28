# MilanoChat — live Flow rollout evidence (29 October 2026)

**Scope:** core flow publishing and Instagram message-only responder; payment/Wayl is OUT OF SCOPE.

## Verified source and deployment

- GitHub `main` at start of this report: `335c51c4607b67d431b8e432bc2aaf8094c2ba9d`.
- Supabase project `nmhefwvhoholcjrbbila` is healthy.
- `milan-api` v105, JWT gateway deliberately FALSE for Meta/WhatsApp signed webhooks; its code independently checks Meta HMAC where appropriate.
- `flow-publication` v3, `verify_jwt=true`, tenant owner Auth and operator production approval.
- `flow-delivery-review` v1, `verify_jwt=true`, owner-scoped read-only queue and metrics.
- Pages workflow `40785413911` succeeded for `1867a497c50ddfae9cb0e2c91af96086e69b62e1`.
- Isolated PostgreSQL, browser, TypeScript, Deno checks passed: `40785200100` (last dashboard ops PR). Real read-only GET HTTP smoke run `40784484007` passed before later source changes. These do NOT prove Meta outbound behavior.
- Recovery: exact older v101 source recipe `scripts/recover-milan-api-v101.mjs`; for any new rollback, take a fresh complete backup of currently deployed v105 (all 8 files) first. NEVER re-deploy the old v101 blindly.
- Versioned `public.consume_flow_reply(uuid,uuid)` installed in addition to unchanged legacy `consume_reply` with service-role-only EXECUTE. No checkout/payment code changed.
- Four public invoker functions had `search_path` pinned in migration `harden_four_public_function_search_paths`; Supabase advisor `function_search_path_mutable` now reports zero.

## Exact production database counts at final read-only audit

| Check | Value |
|---|---:|
| Global Flow switch enabled | false |
| Tenant switches enabled | 0 |
| Operator production approvals | 0 |
| Activated flow revisions | 0 |
| Published flow revisions | 0 |
| Flow Outbox items | 0 |
| Reply ledger rows | 3 |
| Sum of existing tenant credits | 49,901 |

No existing customer tenant was automatically armed. Payment and original ledger/balances preserved.

## Branch triage

106 branches listed, 55 PRs open when originally inventoried, 24 selected code-bearing branches compared. Do not merge large overlapping historical stacks `integration/advanced-flows-after-text-pilot` (#146) and `integration/flow-full-features-post-canary` (#145) wholesale, because they diverge across dozens of files and include advanced unverified worker, staff and rich action SQL. #151's missing-provider-MID Outbox fix is ALREADY in current main. Latest direct webhook sender fix #175 is different and deployed in v105.

## Outstanding real release gates

1. Obtain/verify actual Meta App Review approval for required Instagram message permission and token access; database account state alone does not prove it.
2. Use a separately owned test recipient and an operator-approved single Instagram store. Save a new snapshot of live v105 plus a tested rollback before enabling any store.
3. Publish one immutable supported graph: `trigger(message) -> message(text)`. Approve that one store (global + tenant + production_approved), then exercise a **real signed incoming message** and provider accepted outbound, verify exactly one MID, persisted outgoing, and one atomic credit after replay/concurrent delivery. If provider 2xx returns no MID, do not bill or replay automatically.
4. Verify operator-controlled emergency switch OFF and active Stop control and the old Inbox/Widget behavior. Roll back/reconcile uncertain events if needed.
5. Only after the above pass, separately review staged delay/condition/action/outbox/staff/WhatsApp/Facebook features and SQL with their own provider integration tests. These are NOT currently end-to-end deployed.

## Remaining security advisory findings

- 22 `rls_enabled_no_policy` INFO notices: many intentionally private service-role-only automation tables; independently check intended ACL per table, do not create broad public RLS policies to silence alerts.
- `extension_in_public` WARN: review extension relocation compatibility before migration.
- `auth_leaked_password_protection` WARN: configure under Supabase Auth settings if plan supports it.

**Do not state 100% launch readiness or full ManyChat parity until external signed Meta delivery and advanced actions are verified.**
