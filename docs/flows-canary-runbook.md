# Flow automation — staging and canary release runbook

**Status:** Documentation only. No staging project supplied, no live customer flows enabled.
**Production default:** server-side per-tenant automation flag OFF; frontend visibility flags never authorize sending.
**Release controller:** owner issues a separate GO for each production SQL, Edge deployment, Meta subscription, tenant canary activation and Pages merge/deploy. GO must name a commit, backup, test account, rollback and cutoff condition.

## Preflight — owner supplies

- A dedicated Supabase staging project and access approved for that project.
- Two test-owned authenticated tenant accounts per channel (Instagram, Facebook Messenger, WhatsApp), with explicitly approved Meta scopes and sandbox recipients. Never use existing paying customer accounts for the first canary.
- Project-specific Meta webhook secret, known signed webhook fixtures, page/phone ID mapping, test sender/recipient accounts, and a fake-provider endpoint.
- A production backup/restore plan and previously deployed Edge Function version, obtained without exposing secret values in GitHub logs.
- Agreed global and per-tenant kill-switch design, error/latency thresholds, credit reconciliation owner, rotation/stop on-call.

## Environment and strict rollback ownership

1. Confirm `main` SHA, PR check run URLs and test artifact SHA; no pending incompatible database migration.
2. On staging only, provision timestamped migrations from `supabase/migrations/` and RLS tests with authenticated owner A, owner B, anon and service_role.
3. Deploy Edge Functions to staging separately. Record function version, run log ID and rollback target. **No production deployment**.
4. With the flag OFF, replay every incoming webhook fixture (signature valid/invalid, known/unknown account, echo, multi-page, duplicate IDs). Compare with current AI responder; no routing/sends/credits difference.
5. Verify publication and activation in staging: tenant A cannot publish/activate/revert B; unsupported document and client-supplied capabilities ignored; immutable revision/rollback.
6. With a fake provider and flag ON for one test-owned staging tenant, confirm exactly one of AI/flow/human responds. Human takeover and depleted credits must result in zero sends.
7. Kill-switch tests: toggle global/tenant OFF before next tick, ensure no queued send leaks. Rollback/migration reversal must preserve drafts and customer data.
8. Test 429/5xx/timeout, worker restart between outbox reservation and provider send, duplicate webhook deliveries, token expiry and DLQ; record deterministic send/debit counts. **Exactly-once provider delivery cannot be asserted without provider acknowledgement or dedupe contract.**
9. Verify actual messaging windows by checking fresh official Meta documentation and account-approved messaging modes. Untested or expired windows must block scheduling and sending.
10. Once all evidence is signed off, seek a **separate GO** for an explicitly named canary tenant and channel, with immediate rollback and monitored budget.

## Gate-by-gate evidence matrix (mirrors automation-flow-release-evidence.md)

| Release gate | Must attach evidence | Accept / stop criterion | Current |
| --- | --- | --- | --- |
| Stage 7: real cloud schema | Production catalog query, migration/rollback link, 2-user signed-in browser screenshots | Only owner data accessible; invalid cloud rows never clobber local | NOT PASSED |
| Stage 7: client sync | Offline/reconnect and account-switch test log/screenshots, Android viewport | No silent overwrite, backup recoverable | NOT PASSED |
| Stage 8: publish and rollback | Authenticated staging API tests + immutable history + version rollback | No cross-tenant action or client capability bypass | NOT PASSED |
| Stage 9: verified inbound routing | Raw signed payload fixture, provider ID mapping, receipt replay log | At most one flow chosen; unknown/ambiguous goes to documented AI path | NOT PASSED |
| Stage 10: durable runner | DB transaction and outbox rollback test, scheduled wakeup replay | No partial state/outbox writes; durable delay | NOT PASSED |
| Stage 10: single responder | Flag-off equivalence, human takeover, 0 credits and overlap drills | Exactly one owner of a customer event; takeover wins | NOT PASSED |
| Stage 10: provider delivery | 429/5xx/backoff/DLQ, crash-after-send, token expiry, provider delivery IDs | No duplicate provider sends/debits; unresolved sends quarantined | NOT PASSED |
| Stage 11: AI and telemetry | Tenant-scoped evidence retrieval + fallback, SQL privacy query, metrics reconciliation | No unverified prices, no cross-tenant knowledge, no raw PII metrics | NOT PASSED |
| Stage 12: canary and rollback | 2 test-owned accounts/channel, Android screenshot, signed Meta E2E, rollback rehearsal | Success criteria met and rollback rehearsed; no paying tenant affected | NOT PASSED |
| Final GitHub Pages deployment | All preceding gates green, owner GO for exact main merge + release run | Deploy only tested SHA; postdeploy acceptance + rollback plan | NOT PASSED |

## Canary go/no-go and monitoring

**GO** only when every row above has a linked test, log, screenshot, reviewed commit and named approver. Otherwise **NO-GO**. Recording a passing unit suite cannot substitute for a real signed Meta webhook in staging.

Monitoring queries must be read-only and tailored to approved schema before execution. Suggested measurements: inbound receipts grouped by tenant/channel/provider_event_id, unique outbox idempotency keys, pending/sending age, delivery receipts vs outbound messages, `reply_ledger` message ID uniqueness, charges vs successful provider sends, human handoff bypass violations, activation changes and per-tenant credit balance changes. Never log plaintext customer messages, credentials, or encryption keys.

**Kill and rollback sequence:** server-side per-tenant flag OFF immediately; stop worker claiming new jobs; quarantine in-flight sends; revert named Edge version; restore previous activation revision; verify no further outbox sends, validate credit ledger without modifying history, preserve all cloud drafts; only then consider data-safe schema rollback with separate owner GO. Reverting Pages visibility alone never stops server-side sends.

## Exact commands to use after staging access and owner approval

These are templates, not executed. Inspect installed Supabase CLI `--help` for actual supported options before using it:

```bash
npm ci
npm run typecheck
npm run test:unit
npm run build
npm run test:browser
supabase --version
supabase migration --help
supabase functions --help
```

Attach resulting CI URL, PostgreSQL RLS output, Edge staging test logs, and desktop/mobile screenshots to the release evidence document. Owner GO is required for every production action even after staging success.
