# إدارة سوشيال — Flow Builder release evidence and production blockers

Status: **Flow editor and opt-in cloud drafts released**; **real customer automation NOT RELEASED**, 2026-10-28.

## Single canonical implementation

- Flow editor stack: #93 → #94 → #95 → #96 → #97 → #98 → #103 → #104 → #105 → #106 → #108 → #109.
- The independent #99–#102 branch **must not** be merged on top of this stack: UI/storage changes overlap. Pure Stage 8/9 contracts were selectively incorporated into #110.
- #107 is a parallel cloud-recovery experiment, not part of the canonical branch. Compare its safety scenarios before any final merge; do not merge both recovery implementations blindly.
- PR #110 contains Stage 8 publication auditing, Stage 9 Meta event contract, Stage 10 pure runtime transition plan, Stage 11 tenant/evidence gate and privacy-minimal metrics, and review-only SQL.
- No new runtime files should be wired into live Meta webhooks until server-side validation, state/outbox transactions and approvals are proven.

## Confirmed deployment architecture

- GitHub repository: hsnq2022022-cyber/milanochat, main → GitHub Pages /milanochat/ via .github/workflows/deploy.yml.
- Actual social inbox auto-responses currently go through Supabase Edge Function supabase/functions/milan-api/index.ts.
- The existing webhook handler calls answerFromKnowledge and sends a provider response when agent_enabled/auto_reply allow it; a new flow handler that also sends would cause duplicate replies.
- The existing webhook path respects human transfer and low-credit states. The flow engine must preserve those checks and own the exclusive responder decision before sending.
- Stage 7 drafts table is deployed with owner RLS in production, checked using two real tenant owners and ROLLBACK. Stage 8–11 runtime SQL remains review-only.
- The live Pages build has `VITE_ENABLE_CLOUD_FLOW_DRAFTS=true` for opt-in draft visibility; that frontend flag is **not** a sending authorization. Runtime has no server activation flag or outgoing sender connected.

## Unified staging candidate (review only)

- [PR #126](https://github.com/hsnq2022022-cyber/milanochat/pull/126) integrates editor/CI fixes, default-OFF routing, runtime action plans, safe delivery decisions and disposable Postgres atomic reservation tests.
- `src/flow/flowPipeline.ts` composes selection, capability-based publication audit and initial pure runtime planning, with no provider I/O. It is **not connected to live `milan-api`**.
- Synthetic concurrency, replay and RLS checks do **not** establish real Meta exactly-once sends, actual credit correctness, authenticated live publishing or production migration compatibility.
- Detailed evidence and GO dependencies: [flows-integrated-release-candidate.md](./flows-integrated-release-candidate.md). **No release gate is marked passed by these isolated tests.**

## Mandatory release blockers: all must be independently verified

| Gate | Status | Evidence required |
| --- | --- | --- |
| Stage 7: real cloud schema | PROVISIONED | Real owner impersonation RLS verified; full end-to-end browser sessions still pending |
| Stage 7: client sync | PREVIEW ONLY | Offline/local conflicts, mobile testing, account switching and sign-out, invalid cloud data never destroys local drafts |
| Stage 8: publish and rollback | BLOCKED | Authenticated server-side create immutable revision, validate doc, confirm channel permissions, activate/disable/rollback safely |
| Stage 9: verified inbound routing | BLOCKED | Signed raw Meta payload, server-resolved tenant/account, supported subscribed fields, replay protection, one matching flow or no send |
| Stage 10: durable runner | BLOCKED | Server invokes typed runtime transitions with persisted state + outbox in same DB transaction, queue wakeups and bounded retries |
| Stage 10: single responder | BLOCKED | Integrate with existing milan-api AI responder so exactly one system owns each message; human handoff always wins |
| Stage 10: provider delivery | BLOCKED | Validate Meta send windows, token expiration, 429/5xx retry, delivery receipts, charge credits once, no double-send on worker crash |
| Stage 11: AI and telemetry | CONTRACT ONLY | Live tenant-scoped approved RAG retrieval, constrained evidence-only answer, safe fallback, privacy/reconciliation verification |
| Stage 12: canary and rollback | BLOCKED | Two real test-owned accounts, Instagram/Facebook/WhatsApp supported permissions, replay/failure drills, Android viewport and rollback verification |
| Final GitHub Pages deployment | BLOCKED | All above, full PR stack review, CI green and explicit go/no-go with verified artifacts |

## Launch sequencing

1. Treat the normalized pure contracts as **non-authoritative client-side/library code** until imported by a trusted backend.
2. Provision a disposable staging instance and repeat authenticated RLS operations for tenant A, tenant B and anon.
3. Review the SQL files under supabase/proposals; generate official timestamped migrations with the Supabase CLI, not by copying proposal files into production.
4. Back up production first. Do not alter live milan-api, Meta subscriptions or channel settings while CI-only work is under review.
5. Add a separate, authenticated publish API and executor, using server-calculated capability flags. Never accept client-provided capability sets, tenant ownership or activation decisions.
6. Make the runner **exclusive** with existing AI/human paths, using atomic receipt+state+outbox writes before provider send; test Meta retry and delivery acknowledgement carefully.
7. Enable one test-owned account after a signed provider webhook E2E, not all tenants. Default opt-in=false.
8. Only after acceptance and reliable rollback, merge reviewed source to main to deploy the site automatically through GitHub Pages. Deploy new Edge Functions and SQL separately using controlled environment-specific release steps. Do not activate flows merely because the browser UI was deployed.

## Current implementation limits

- Stage 10 runtimePlan.ts produces **plans**, not outgoing provider API requests and not committed durable execution.
- The SQL proposal establishes immutable publications, tenant-aware run references and uniqueness keys, but does NOT yet prove channel-account↔tenant/conversation association; check actual live schema before production migrations.
- AI authorization and metrics are pure checks; they do NOT prove production retrieval quality, provider delivery, billable credits or comprehensive conversational analytics.
- Feature flag on frontend is visibility only, **not a security control**. Server-side authorization is mandatory.
