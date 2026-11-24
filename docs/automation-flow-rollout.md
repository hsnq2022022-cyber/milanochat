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

### Comment automation: Meta configuration checklist (REQUIRES META DASHBOARD VERIFICATION)

The repository cannot set app-level webhook subscriptions. Everything below is
documented knowledge that was NOT verified against Meta in the session that
wrote it; verify each item in the Meta App Dashboard before enabling.

1. Callback URL (both objects): `<SUPABASE_URL>/functions/v1/milan-api?action=instagram_webhook`
   (the `instagram_webhook` action handles object `instagram` and `page`).
   Verify token: the value of `INSTAGRAM_VERIFY_TOKEN` (fallback `META_WEBHOOK_VERIFY_TOKEN`).
   Signature secret: `INSTAGRAM_APP_SECRET` and/or `META_APP_SECRET` (X-Hub-Signature-256).
2. Instagram product -> Webhooks, object `instagram`: subscribe `messages`, `messaging_postbacks`,
   `messaging_seen`, `comments`. Do not add `live_comments` / `mentions` (no consumer).
3. Page object (Messenger / Webhooks), object `page`: subscribe `messages`, `messaging_postbacks`, `feed`.
4. Permissions (app review / access level for non-test users): Instagram `instagram_business_basic`,
   `instagram_business_manage_messages` (private reply DM), `instagram_business_manage_comments`
   (comment webhooks + public reply); Facebook `pages_show_list`, `pages_messaging` (private reply),
   `pages_manage_metadata` + `pages_read_engagement` (Page subscription / feed), `pages_manage_engagement`
   (public reply). App mode: Live for real customers; in Development only app roles/testers trigger webhooks.
5. Per-account subscription is done at connect time (meta-auth): Instagram
   `messages,messaging_postbacks,messaging_seen,comments`, Page `messages,messaging_postbacks,feed`;
   if Meta refuses the list with `comments` / `feed`, the DM-only list is subscribed instead (logged as
   `DM-only fallback`). Accounts linked before this change keep the old list: the owner must
   reconnect the account (Instagram / Facebook connect again) to receive comment events.
6. Server gates (all default OFF, exact value `true`): `FLOW_COMMENT_AUTOMATION_ENABLED` (milan-api,
   flow-outbox-worker, flow-publication), `FLOW_DURABLE_INGRESS_ENABLED`, `FLOW_MULTICHANNEL_ENABLED`
   (Facebook Page comments), `FLOW_DURABLE_CANARY_ACCOUNT_ID` (one account id, or a strict comma-separated allowlist),
   worker `FLOW_WORKERS_OPERATOR_RELEASE`, `FLOW_OUTBOX_SEND_ENABLED`, `FLOW_ATOMIC_CONSUME_READY`; SQL:
   migration 20261029300000 applied, global switch on, tenant switch enabled + production_approved,
   the account registered in `automation_flow_canary_accounts`, a published + activated comment flow.

   **Allowlist and registry must agree.** An account runs durable flows only when it is in
   `FLOW_DURABLE_CANARY_ACCOUNT_ID` AND (production tenants, i.e. not `test_only`) registered in
   `automation_flow_canary_accounts`. The registry key is `(tenant_id, platform)`: **at most one durable
   account per tenant and platform** (different tenants are independent). Publication reads the same registry
   and refuses to report a durable flow as live: `activate`/`rollback` answer HTTP 409 with `code`
   `FLOW_DURABLE_REGISTRY_MISSING` / `FLOW_DURABLE_REGISTRY_OTHER_ACCOUNT` (503 `..._UNAVAILABLE` on a read
   failure) and an Arabic reason; `publish_live` keeps the revision saved, answers `saved_not_live` with the
   matching `reason`, Arabic `message` and the same `code`.

   **Lifecycle when a registry row (or allowlist entry) is removed.** Rollout of a customer: register the row
   (operator, SQL) AND add the id to the allowlist. Rollback: delete the row and/or remove the id.
   - New durable claims stop at once (`flow_claim_inbound_durable` returns no row; V2 / the AI answer).
   - Work already delivered is never touched.
   - Pending work is HELD, not cancelled and not sent (proven by the local PostgreSQL lifecycle test):
     - **Due wake:** `flow_lease_due_runs` never leases a registry-blocked production run
       (`flow_registry_blocks_run`, migration `20261115160000`, review-only, NOT applied anywhere), so it keeps
       its retry budget across any number of ticks and wakes on the first tick after re-registration. If the
       row disappears between the lease and the worker's check, or the registry cannot be read, the worker
       releases that lease (still no attempt consumed). Genuine execution failures still end in
       `lease_exhausted` after 4 leases. A removed ALLOWLIST entry is different and unchanged: that wake still
       fails its lease and ends as `lease_exhausted` after about 6 minutes.
     - **Outbox message:** stays `pending` (reported `blocked`) and resumes exactly once (the delivery attempt is unique per effect).
     - **Delivered but not yet recorded/billed (`charge_pending`):** the registry does NOT hold this recovery. The
       provider already accepted the message, and the recovery only persists and bills (never sends), so it
       completes exactly once with the registry present, removed or unreadable.
     - **Internal effect:** stays pending (`blocked_registry`).
   - **Stale replies:** a still-unsent Flow message (production tenants) is cancelled `superseded` (audited) only when
     a newer AI reply was actually DELIVERED in the same conversation. An `automation_message_claims` row with route
     `legacy_ai` is NOT proof: it is written before the answer is generated or sent and stays after an empty answer
     or a failed send. Evidence for a claim claimed after the effect was created is either a persisted outbound
     message whose id is the claim's `outgoing_message_id`, or its `automation_delivery_attempts` row with status
     `confirmed`. An `attempting` attempt (send in flight), an unrecognised status, a truncated scan or any read
     error HOLDS the message; a claim without evidence, or an `uncertain` attempt (send failed or unconfirmed),
     does not stop it and it is sent. Messages created after the claim (for example the follow-up after a delay),
     public comment replies and `test_only` tenants are not affected. V2 flow replies in production-approved
     tenants are claimed with route `flow` per the pinned production definition of `flow_claim_inbound` (not verified live), so only AI replies supersede.
   - The existing stale sweeps bound the hold and audit it: `flow_skip_blocked_outbox` cancels held messages as
     `stale` 60 minutes (`OUTBOX_STALE_MINUTES`) after they were created; `flow_end_stale_paused_runs` ends a held
     run as `stale` 24 hours past its `wake_at`; internal effects are cancelled `stale` 1,440 minutes
     (`INTERNAL_STALE_MINUTES`) after creation. Re-registering before those limits resumes the work.
   - A customer message to a conversation whose session was waiting for a button tap or a typed answer falls to
     V2/the AI while the row is missing (the claim is refused before any state change; the run keeps waiting
     until it expires). A free-text message to a non-typed question ends the run as it always does.
   - The activation row stays `is_active`. The operator `catalog` reply adds an additive `runtime` object
     (`status:"not_running"`, `reason`, Arabic `message`) on every ACTIVE durable/comment flow the runtime will
     not start (`registry_missing`, `registry_other_account`, `not_allowlisted`); the editor shows that
     message instead of presenting the flow as fully live. `test_only` tenants never needed the registry.

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
