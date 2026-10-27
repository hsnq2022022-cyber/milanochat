# Automation flow launch gates — إدارة سوشيال

**Status:** Work in progress. This file is a design and test checklist, NOT permission to deploy.
**Main site:** Flow designer is still a browser-local draft editor. Existing Meta/AI responses must continue unchanged.

## Verified integration starting point

- Live Supabase project currently has `public.tenants` with `user_id` owner mapping (RLS enabled).
- `public.channel_accounts` stores channel configuration; existing production webhook response code in
  `supabase/functions/milan-api/index.ts` uses `channel_accounts`, `conversations` and
  `credits_remaining`. Flow-runner integration does not exist there yet.
- No `automation_flow_drafts` table exists in the live project as of this review.
- Existing local library stores up to 30 `SavedFlow` items. Draft `enabled` is local-only.

## Stage 7: account-scoped draft storage

1. Review `supabase/proposals/automation_flow_drafts.review.sql`; it is **not applied**.
2. Prepare backup, create tested migration with official Supabase CLI (not by hand-copying a timestamp filename).
3. Test with two distinct owner users and unauthenticated role: cross-tenant read/insert/update all denied.
4. Validate grants as well as RLS policies; `authenticated` can never change `tenant_id` or `flow_key`.
5. Apply only after approval and migration review; check actual Postgres advisories and migration history.
6. Wire cloud sync behind an opt-in control with explicit choice of local vs cloud document.
   **No automatic overwrite, import, deletion or activation.**
7. On save, use revision comparison; a stale device receives a conflict, not a silent last-write-wins.
8. Preserve original JSON bytes, edge/port IDs and assets. Test offline/online recovery.

## Stage 8: immutable publication

- Separate `automation_flow_publications` from mutable drafts; append-only document versions.
- Enforce publish authorization on the server and re-run `validateDocument`-equivalent schema and reachability checks.
- Make enable/disable a separate server operation. Draft creation must NEVER activate a Meta response.
- Record publisher, tenant, channel, revision, activation timestamp and rollback target.
- Test publishing an invalid graph is rejected and that editing draft N+1 leaves active version N unchanged.

## Stage 9: Meta trigger intake (Instagram / Facebook / WhatsApp)

- Audit each existing webhook handler, Meta permission and subscription; do not infer that comment or story
  events work merely because an option appears in the editor.
- Route normalized verified events by tenant, connected account, platform and trigger.
- Prevent duplicate starts using a UNIQUE provider event key and at-least-once processing.
- Respect Meta messaging policies, reply windows, templates and available channels.
- Never let the flow runner and existing AI responder both send replies to the same event.
- Add opt-in test-account traffic only, followed by rollback testing.

## Stage 10: persistent execution engine

- Interpreter for message + media + quick replies, data collection, condition, randomizer, goto and end.
- Durable state with current node, variables, last customer input, event id and execution version.
- A delayed step schedules a persisted wake-up, never a long-running request or unbounded loop.
- External request actions must enforce URL allowlist / deny private IPs, timeouts, no secret interpolation into logs.
- Messages must be idempotent and charge credits exactly once on confirmed billable delivery.
- Retry provider failures with bounded backoff. Keep human handoff ahead of AI/automation.

## Stage 11: AI and metrics

- AI action may only use that tenant's approved knowledge base; don't invent prices or inventory.
- Context limits, per-tenant quotas and handoff stop rules are mandatory.
- Track transitions, button clicks, completions, errors and handoff (avoid storing unnecessary PII).
- Metrics should match provider delivery receipts; don't count preview/test messages as real customers.

## Stage 12: launch acceptance

- Verify tenant A cannot view/edit or run tenant B's flows under direct API calls.
- Simulate webhook replay, late event, expired token, provider 429/5xx, zero credit, network outage.
- Verify 2-platform concurrency, duplicate prevention, publish rollback, state resume and manual takeover.
- Validate mobile and desktop controls with Arabic + English UI on real devices.
- Explicit go/no-go approval, after CI and isolated real-account trial. Rollback and backups documented.

**Forbidden until authorized:** merging stack of draft PRs, modifying `milan-api` live,
deploying SQL or Edge Functions to production, enabling flows for real contacts.
