# Stage 2 — Immutable publishing and guarded activation (review only)

Target: owner-confirmed Supabase project nmhefwvhoholcjrbbila. No stage-2 SQL or Edge Function has been applied/deployed.

## Implementation

- New SQL migration: supabase/migrations/20261028190000_flow_publication_server_rpcs.sql (requires the separately reviewed runtime schema migration in PR #136).
- Service-only SECURITY INVOKER functions: flow_publish_revision, flow_activate_revision and flow_deactivate_revision. They validate tenant ownership against tenants.user_id, require real tenant/account/platform binding, and serialize revision allocation with a locked tenant row.
- Publication revisions are immutable. Activating or rolling back only changes a pointer; deactivation remains available after global kill or account disconnection.
- A dedicated future Edge endpoint supabase/functions/flow-publication/index.ts checks bearer token using Supabase auth.getUser, resolves the tenant and account from trusted records, and supports accounts/publish/list/activate/rollback/deactivate. Never trusts browser-submitted tenant IDs or capability claims.
- Publishing does not activate messages. Activation requires an independently armed server-only exact test tenant+account allowlist, backend runtime capability audit and both database kill switches. It is OFF by default.
- Flow Builder gets an RTL revision-management panel behind VITE_ENABLE_FLOW_PUBLICATION_PREVIEW=true (default OFF). Test activation controls have their own disabled-by-default UI flag, which is NOT an authorization boundary.
- Deployed milan-api, old AI responder, Meta subscriptions, billing RPC, customer conversations, tenant credits and current site remain unchanged.

## Verification

- GitHub Actions CI: https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40723124465 — BOTH jobs SUCCESS on the exact tested stage-2 code prior to this documentation-only commit.
- Node tests: v3 graph validation, account platform mapping, invalid/oversized documents, capability spoofing and canary guards.
- Disposable PostgreSQL 17: owner/cross-tenant denial, first/second immutable revisions, activation OFF, allowed canary test, rollback to older revision, account-disabled deactivation, service-only RPC privileges, two parallel publishers allocating 1 and 2, rollback retaining all four historical revisions.
- TypeScript scoped flow check, Vite build and full Deno typecheck for the new Edge Function all passed.
- NO real authenticated HTTP call to a deployed Edge endpoint and NO real Meta messages were performed.

## Next separate owner GO

Action: PR #136, file supabase/migrations/20261028180000_flow_runtime_tenant_bound.sql, apply to existing project after confirming metadata. Adds six isolated tenant-bound RLS runtime tables and two composite UNIQUE indexes on existing channel_accounts and conversations (without changing their rows). Global and tenant flow switches remain OFF, no runtime sender exists.
Risk: schema/index name collision or unexpected existing duplicates/FK constraints; migration is transactional and should abort without partial changes. Rollback: supabase/rollbacks/20261028180000_flow_runtime_tenant_bound.rollback.sql, only when newly created runtime tables contain no data; otherwise preserve records and leave global flag OFF.
Verification: supabase/verification/20261028180000_flow_runtime_tenant_bound.readonly.sql, check six tables RLS, no client writes, no active flows, zero outbox and correct indexes.

NOT included in this approval: migration 20261028190000 publication RPCs, Edge Function deploy, merge to main, Meta changes, customer messaging or canary activation. Each requires its own approval.