# تدقيق فروع إدارة سوشيال وخطة إنهاء الإطلاق — 2026-10-28

## مصدر الحقيقة: ثلاثة مستويات منفصلة

1. **Production:** Supabase project `nmhefwvhoholcjrbbila`, `milan-api` v101, `flow-publication` وworkers غير منشورة، global flow OFF، enabled tenants 0، activations 0، publications 0، outbox 0. البيانات الموجودة لم تُعدّل.
2. **MVP code:** Draft PR #144 (`release/instagram-text-integration-20261028`, base `main`). محرر التدفقات، النشر المحمي، مراجع Webhook وتوقيع Meta، claim واحدة لكل رسالة، الرجوع للرد القديم عند OFF، تدفق message-only آمن، واختبارات CI ناجحة. غير مدموج أو منشور.
3. **Post-canary advanced code:** THIS branch `integration/flow-full-features-post-canary` stacked above PR #144، فيه runtime متعدد العقد، تأخير دائم، Outbox/Meta sender، RAG، رسائل تفاعلية، وسوم، إشعارات داخلية، RBAC RLS، إيصالات التسليم، شاشة مراجعة بشرية مخفية افتراضياً. ALL worker switches OFF. القيم الجديدة هي **مقترحات برمجية**؛ لا يوجد إثبات live Meta end-to-end.

## الفروع التي راجعناها

- 85+ فرع ضمن GitHub، وطلبات مراجعة متعددة غير مدموجة.
- main يحتوي واجهة الهاتف وFlow Builder والحفظ/المحاكاة؛ التفعيل الحقيقي غير منشور.
- PR #137: Webhook HMAC/dedupe؛ PR #140: unique claim؛ PR #141: Widget/delivery hooks؛ PR #142: stage4 runtime/metrics؛ PR #143: Outbox/RAG/protected release؛ PR #139: security hardened publication؛ `feature/flow-employee-rbac-rich-actions-receipts`: Meta rich actions + staff and receipts؛ `review/flow-release-dryrun-fixture-reliability`: verified source-only fixes to release harness.
- DO NOT merge these PRs independently in arbitrary order, or overwrite production with an older code version. The stacked branches form a review graph, not independently production-ready releases.

## Implementation inventory

| Capability | Candidate source | Live readiness |
|---|---|---|
| Flow Editor / mobile RTL / local draft and simulation | main + #144 | browser CI; needs real device smoke |
| Auth/tenant-bound publication (publish !== activation) | #144 | requires separate GO to deploy flow-publication |
| Signed IG/FB inbound HMAC | #144 | requires GO-R+real Meta App Review |
| Duplicate-safe exclusive claim + old AI OFF fallback | #144 | claim SQL live, new Edge not deployed |
| Exact 2-node IG text message | #144 | requires GO-T, one tested channel |
| Atomic credit decrement for Meta replies | #144 SQL | SQL GO-D NOT approved; first drain old v101 |
| Multi-node flow interpreter/variables/conditions/delay | this branch | PG17+Node only, runtime worker OFF |
| Durable due-wake and scheduled worker | this branch | new migration, deployment and scheduler GO required |
| Outbox atomic reservation and Meta/WA sender | this branch | provider sends NOT live tested; OFF |
| Tenant-owned indexed RAG | this branch | model provider compatibility and evidence review outstanding |
| Quick reply and Messenger HTTPS buttons | this branch | signed choice reconciliation E2E not yet proven; OFF |
| Tags, untag and staff notices | this branch | private SQL/worker off; no push/email |
| Owner/admin/agent/auditor + assignment RLS | this branch | SQL only, no live staff invites |
| Provider delivered/read receipt MID correlation | this branch | requires signed Meta subscriptions, OFF |
| Review queue for uncertain delivery | this branch | Dashboard VITE_ENABLE_DELIVERY_REVIEW OFF |
| Widget | existing, parked | user prioritization: no new Widget work |
| WhatsApp, Salla, payments | existing services | no real verified checkout/channel E2E in this review |

## Emergency safe launch sequence (separate GO required for every production step)

**Gate 0**: Confirm GitHub Environment required reviewers and restricted `main` deployment branch. Confirm backup, restore and in-flight old request drain plan. **Do not** click Run workflow until gates are checked.

**GO-S**: Protect `.github/workflows/deploy-functions.yml` on `main` from automatic `supabase/functions/**` deployment (bulk legacy workflow). Apply only a reviewed Workflow-only commit, verify no Pages/Edge workflow starts. This branch's guard is staged, not live. Avoid merging the full PR to main before this protection.

**GO-M3**: Separately stage corrected `scripts/flow-protected-release.sh`, `scripts/flow-protected-live-smoke.mjs` and pinned `.github/workflows/flow-protected-manual-release.yml` to main after verifying the immutable checkout SHA. The workflow dry-run creates temporary test Auth/tenant/widget rows in REAL production before cleanup; it is NOT a read-only preflight and must be independently authorized for actual execution. User currently considers Widget out of launch scope, so its old parity smoke must be explicitly scoped to safe regression only or replaced with an equivalent isolated Inbox smoke.

**GO-R**: One reviewed protected deployment only `milan-api`+ `flow-publication`, feature flags OFF, source101 backup and automatic *best-effort* rollback, verify jwt settings, clean test fixture, post-deploy HTTP Auth/A-B, no Meta sends.

**GO-D**: Apply `20261028221000_consume_reply_atomic.sql` separately ONLY after ensuring no v101 invocations are in-flight (drain or a separately approved ingress-buffer maintenance plan). Confirm RPC interface matches all callers and preserve old charge ledgers.

**GO-T**: Only ONE test tenant + ONE signed Instagram business account and one recipient. FlowDocument v3 trigger(message) -> message(text), `FLOW_RUNTIME_MODE=message_only`, narrow tenant and channel Canary flags. Verify one signed inbound, one provider response, one credit ledger, replay and concurrent callback, old AI fallback OFF, no-charge behavior, and manual review of uncertain sends. Disable again after experiment. App Review `instagram_business_basic` and `instagram_business_manage_messages` must be approved and the outbound message screencast evidence supplied.

**Gate AFTER pilot**: only then consider deploying migrations `20261028225000` through `20261028229000` in dependency order, service-only workers and scheduler separately, richer UI controls per tenant after RLS/ACL and delivery receipt tests.

## Rollback and safety

- Feature off: global + test tenant switch OFF; separately sender/Canary switches OFF; no automatic retry of uncertain provider results.
- Edge rollback: redeploy a complete backed-up v101 source, SHA-match, and re-test old HTTP behavior; version number will be new.
- DB rollback: do NOT delete nonempty claims, ledgers, attempts or publications; guarded rollback should reject history. Older `consume_reply` reintroduces phantom/ghost ledger risk and is not an automatic recovery option.
- Preserve all customer data and signed webhook evidence; do not send real messages until GO-T.

## Verification boundary

CI in GitHub Actions uses disposable PostgreSQL 17 and Node/Deno/Chromium. No production SQL migration, Edge deploy, release workflow dispatch, main merge or Meta provider send. A green CI establishes only isolated behavior; full production readiness and exact-one delivery cannot be proved without signed real Meta tests.
