# Flow Builder branch & schema reconciliation — review only

> **No production migration, no main merge and no real Meta automation.**
> Findings checked against GitHub draft PRs #93–#105 and read-only metadata from the connected
> active Supabase project. This document is a release gate, not deployment authority.

## Two independent development stacks

| Stack | Dependency order | Overlapping or unique contents |
| --- | --- | --- |
| A (older) | #93 → #94 → #95 → #96 → #97 → #98 → #99 → #100 → #101 → #102 | #99 mobile; #100 draft adapter `cloudDrafts.ts` and 1 MiB SQL; #101 publication capability guard; #102 normalized Meta event matcher |
| B (later) | #93 → #94 → #95 → #96 → #97 → #98 → #103 → #104 → #105 → this stage-7 recovery PR | #103 mobile/AR-EN; #104 draft adapter `cloudDraft.ts` and 4 MiB SQL; #105 fail-closed reads; this PR adds explicit recovery planning |

**DO NOT sequentially merge the two stacks as-is**: #99/#103 both touch `FlowBuilder.tsx`, `NodeEditor.tsx`, and the same CI workflow path. The SQL designs differ, and the cloud adapters are **not interchangeable**.

### SQL differences verified from repository

| Property | #100 review-only SQL | #104/this PR review-only SQL |
| --- | --- | --- |
| Document maximum | 1 MiB | 4 MiB |
| Revision field | `revision bigint` | `draft_revision integer` |
| Stable primary ID | `id uuid` | Originally composite ID; **this proposal now adds `id uuid`** |
| Draft deletion | Authorized for owner | **Not granted** (data recovery safety) |
| Extra tables | `automation_flow_versions` proposal | Draft table only; publication is a separate gate |
| Node/edge limits | 100/350 | **100/250**, aligned to `importFlow` |
| Revision enforcement | Trigger increments | **This proposal now includes trigger and server-owned timestamp** |

**Proposed canonical direction for review:** prefer the stronger stage-7 fail-closed adapter
(`cloudDraft.ts`) and its current draft-only no-DELETE policy, but retain the stable
`id uuid` for a future immutable publications foreign key. No live SQL has been
applied. A separate stage-8 migration must reconcile the publication schema with
the approved draft structure; never run both proposal files.

### PR #106 overlap (also a draft from #105)

PR #106 independently adds `compareCloudDrafts` and `stageCloudDraftCopy`
directly to `src/flow/cloudDraft.ts`. The present reconciliation branch addresses
the same safe-import intention through **`src/flow/cloudRecovery.ts`**, with a
complete no-write recovery plan, normalized document comparisons, and
`prepareIndependentCloudCopy` for explicit inactive copies.
It also adopts the independently verified **PGRST116** error-classification fix.

**Integration decision for review:** keep one canonical recovery API instead of
merging two separate implementations. #106 and this PR are sibling branches from
#105; merging both blindly would duplicate preview/copy APIs. Retain #106 open
until one implementation has been explicitly reviewed and selected; do not
silently delete or force-update either branch.

## Stage 7 safeguards now represented in code

- Cloud rows have a strict 4 MiB payload boundary, full timestamp syntax check,
  positive bounded integer revision and bounded row counts.
- Browser-owned local drafts are **never automatically overwritten**, erased,
  enabled or replaced with cloud data.
- `previewCloudRecovery` shows new, identical, conflicting and capacity-exceeded
  results in memory only; `prepareSelectedCloudRecovery` requires explicit IDs,
  rejects corrupted responses and conflicts atomically, and returns only an
  **unpersisted candidate library**, never a write.
- `saveCloudDraft` requires revision equality and no longer submits `updated_at`,
  which must be written by the DB trigger.
- The proposed SQL limits Data API grants and enforces owner-scoped RLS,
  server-controlled increment-by-one revision and timestamps.

These are **unit-tested design safeguards, not end-to-end Supabase authorization evidence.**
The browser UI is NOT yet connected to this adapter.

## Mandatory gates before production stage 7

1. Pick ONE mobile/editor branch based on manual phone testing; integrate the
   non-overlapping work by reviewed commits, not a blind merge.
2. Settle one canonical SQL document and matching adapter for all references
   (`revision` vs `draft_revision`, size cap, UUID relationships, grants).
3. Provision a separate development or disposable test database using an
   official CLI-generated migration; never run these SQL proposals directly
   on the connected active database.
4. Test roles **anon, tenant A owner, tenant B owner** for read/insert/update;
   owner A may not read or modify B; anon can access none. Direct API calls
   attempting to rewrite `tenant_id`, `flow_key`, `updated_at` and revision
   must fail. Check grants and policies independently.
5. Enforce at most 30 drafts per tenant **at the server** (the client cap alone
   is not an authorization or quota boundary). Review concurrent creation
   behavior; do not claim this gate is complete.
6. Run simulated simultaneous-device updates and lost-response retry;
   conflicts cannot silently overwrite newer drafts. Confirm recovery
   after a network drop and with malformed/missing cloud rows.
7. Add an explicit signed-in UI with **preview → choose IDs → download local
   backup → confirm import**. Never auto-import or auto-save on page load.
8. Confirm schema migration history, database advisor output, rollback and
   isolated staging smoke tests; request approval before deploying live.

## Stage 8 / 9 integration (deferred)

- #101 `publicationGate.ts` and #102 `eventRouting.ts` are **pure review-only
  modules** on stack A. They are not a publishing engine, webhook verifier,
  deduplicator or real Meta connector.
- Only after canonical stage-7 schema and stage-6 UI are integrated, port
  these modules into a new reviewed branch and re-run their own tests plus
  all 8 frozen importer compatibility fixtures.
- Do not activate live flows or change `milan-api`, Meta webhooks, payments
  or credits as part of an editor/adapter merge.
