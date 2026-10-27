# Flow Builder production release record — 2026-10-28

Repository: hsnq2022022-cyber/milanochat
Release: PR #113 merged, main commit f19075324a7fbe674a0a590991fa31d0451dbf94
GitHub Pages deployment: https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40590494948 (success)
Site: https://hsnq2022022-cyber.github.io/milanochat/

## Live today

- Flow editor, touch-optimized UI, preview simulator, manual cloud draft list/save/recover interface.
- Build flag VITE_ENABLE_CLOUD_FLOW_DRAFTS=true; no automatic overwrite/restore and no activation.
- Supabase public.automation_flow_drafts installed with owner RLS; anonymous SELECT denied and DELETE not granted.
- Role-based testing under two distinct real tenant-owner IDs: own INSERT/SELECT allowed, cross-tenant INSERT/SELECT/UPDATE denied, anon SELECT denied. The test transaction ended with ROLLBACK and zero persisted test rows.

## Not live

- No trusted flow publication or activation service.
- No signed Meta flow-event webhook integration or exclusive AI-vs-flow responder selection.
- No durable scheduler/outbox provider-delivery worker, advanced AI flow actions or production run metrics.
- No end-to-end Supabase browser sign-in acceptance test with two distinct users; PostgreSQL RLS role impersonation is not identical to a full auth-session test.
- PRs #111, #112, #114 retain Webhook/billing/runtime proposals; none deployed to live milan-api.

## Rollback / caution

- Disable the Pages flag VITE_ENABLE_CLOUD_FLOW_DRAFTS and rebuild if cloud UI causes issues.
- Keep database drafts for recovery; never DROP a table holding user flows to roll back a UI release.
- The database was provisioned through reviewed SQL execution rather than migration history. Reconcile with an official migration before any future schema pipeline; re-running CREATE TABLE will fail.
- A successful GitHub Pages deploy does not prove a real authenticated cloud save. Do not claim full rollout until browser-session E2E is verified.