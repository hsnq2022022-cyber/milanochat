# Flow branch audit — 2026-10-29

This is a **source review and release triage**, not proof that all functions are deployed. GitHub lists 106 branches and 55 open PRs (including historical stacked drafts); 24 selected technical branches were compared to `main` using commit-diff metadata, and key PR patches/source files were inspected. Do not mass-merge historical stacks.

## Production facts (Supabase nmhefwvhoholcjrbbila)

- `milan-api` is still deployed at v101; the exact live source is **not identical** to `supabase/functions/milan-api/index.ts.bak`. Always capture the live function first for recovery.
- `flow-publication` is deployed at v2 with JWT verification enabled. It can publish immutable revisions but has no active flow.
- SQL has `production_approved boolean NOT NULL DEFAULT false` on tenant switches, and server activation is additionally gated. No tenant has production approval and global flow switch remains OFF.
- `consume_reply` legacy RPC still exists. Legacy v101 uses an incompatible one-argument call. Do not replace it during in-flight v101 requests. A separate `consume_flow_reply` RPC is proposed for the new engine.
- Meta app review, real provider send/receive and genuine production rollback remain unverified.

## Which stranded branch work is already covered?

| Branch / PR | Finding | Decision |
|---|---|---|
| `feature/flows-release-runtime-contracts` | Git comparison: fully behind main | Do not merge |
| `feature/flows-batch5-deep-functional-audit` | Fully behind main | Do not merge |
| `feature/flows-batch6-mobile-accessibility` | Fully behind main | Do not merge |
| `fix/outbox-missing-provider-id-no-charge-20261029` / #151 | `executeOnce` on current main already rejects null/blank provider ID without billing, with tests | Do not duplicate |
| `fix/legacy-webhook-inbound-insert-errors` / #135 | The `persistInboundOnce` helper and exclusive event claim are already present in main | Keep review branch only |
| `review/protected-release-pin-current-scripts-20261029` | Old workflow pin; main contains newer immutable pin | Do not merge |
| `release/instagram-text-integration-20261028` | Old integration source; main contains more recent tested fixes | Do not wholesale merge |
| `fix/consume-reply-transactional-ledger` / #131 | Correctly isolates a ghost-ledger bug, but replacing the legacy RPC before v101 drain is unsafe | Adapt into a **separate versioned RPC**, test and deploy independently |
| `fix/flow-editor-defects` / #119 | Clipboard, multi-select, undo and recovery improvements exist but diverge across 12 files from the latest editor; a version-2 condition import fix is already in main | Cherry-pick individually with current Playwright/unit tests; no bulk merge |
| `feature/flow-omnichannel-buttons` | Divergent 13-file editor change; needs Meta compatibility and current React Flow state review | Isolate into independent PR before adopting |
| `integration/advanced-flows-after-text-pilot` / #146 | 72-file difference includes RAG, durable scheduler, rich actions, internal effects, outbox and new SQL with flags default OFF | Stage only after basic real Meta end-to-end is proven; SQL and workers not deployed |
| `integration/flow-full-features-post-canary` / #145 | 78-file divergent alternative stack, overlaps #146 | Do not combine both overlapping trees |
| `feature/flow-employee-rbac-rich-actions-receipts` | 94-file divergent staff-RBAC and rich-action stack | Test scoped memberships separately; never expose role changes by blanket merge |
| `feature/flow-protected-release-and-dispatcher` / #143 | Older rollout script/dispatcher stack that predates latest corrected baseline and pins | Keep current protected script; cherry-pick worker only after a separate review |
| `feature/flows-staging-durable-worker` and `feature/flows-staging-publisher` | Staging-only historical stacks with 55 changed files each | Do not publish as production |
| `integration/main-advanced-payment-consolidation` | Mixed advanced runtime and payment updates | Excluded per owner instruction: payment is handled separately |

## Release sequence and stop gates

1. Versioned, server-only credit RPC: isolated PG tests; apply additive migration without modifying v101 RPC or customer data.
2. Capture complete **live** v101 source and ensure a verified recovery path. Do not substitute the unrelated `.bak` file.
3. Release tested `milan-api` source with new billing call while global and every tenant flow switch stay OFF. Verify authenticated HTTP, legacy/widget compatibility and cleanup. If any step fails, restore from exact live source.
4. Prove real Instagram account permission and signed Webhook, one inbound event, one outbound provider MID, one unique credit ledger row; replay and concurrency. Only then enable a specifically approved production tenant and account.
5. Stage durable worker and advanced actions as separate migrations/functions with isolated tenant-RLS and provider idempotency validation. Never enable untested rich features.
6. Payment and external checkout intentionally excluded from this release.

The existence of 106 remote branches does not imply 106 ready product features. No stored source review by itself is a successful live delivery test.
