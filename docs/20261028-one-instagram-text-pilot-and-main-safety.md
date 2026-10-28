# One-store Instagram text pilot and staff/rich reviews — 2026-10-28

STRICT SOURCE ONLY. No workflow run, GitHub main edit/merge, Supabase SQL, Edge deploy, feature flag activation or real Meta send was authorized. All source-only commits are [skip ci]. New manual test workflow exists on this branch but was not dispatched.

## Source-only deliverables and ordered future SQL approvals

A. 20261028227000_tenant_staff_memberships.sql: private tenant memberships, assignment table, own-row authenticated SELECT RLS, server-only flow_staff_can(tenant,verified_actor,action,conversation), full tenant/conversation isolation for owner and all staff roles. No browser updates, no browser RPC. Owner remains tenants.user_id. Service-only invitation and assignment until dedicated staff API approval. A guarded rollback refuses nonempty membership history.
B. 20261028228000_flow_internal_actions.sql: private conversation tags, tag/untag, assigned-employee notification inbox with tenant owner fallback; atomic flow_apply_internal_effect; no network send, no debit. Depends on A. Guarded rollback refuses nonempty data.
C. 20261028229000_flow_meta_delivery_receipts.sql: confirmed provider message ID mapped to tenant/channel, explicit delivered/read events, duplicate-safe receipt ledger and one delivered metric; no inference from provider POST 2xx or watermark-only read. Depends on earlier draft 20261028226000_flow_outbox_delivery_attempts.sql. Guarded rollback refuses nonempty receipts.
D. Earlier draft outbox delivery SQL 20261028226000 extended to reserve interactive questions as single provider attempt. Earlier draft 20261028225000 remains prerequisite for multi-node execution. None of A–D is installed on production.
E. Historical Widget 5 answers: user's text "[اكتب قرارك: مجانية / تسوية]" is an unfilled placeholder, NOT an actual choice. No billing retroactivity, writeoff or reconciliation decision recorded.

## New explicit OFF gates

FLOW_RICH_BUTTONS_ENABLED=false; FLOW_INTERNAL_ACTIONS_ENABLED=false; FLOW_META_RECEIPTS_ENABLED=false.
All previously disabled switches remain OFF: FLOW_OUTBOX_SEND_ENABLED, FLOW_ATOMIC_CONSUME_READY, FLOW_RAG_ENABLED, FLOW_PUBLICATION_CANARY_READY, WIDGET_BILLING_V2_ENABLED, DELIVERY_TRACKING_V1_ENABLED; database global and tenant gates OFF.

- Rich: up to 13 Meta quick replies with persistent choice IDs and <=20 char labels for Messenger/Instagram; Messenger HTTPS website cards max 3. Unsupported formats/WhatsApp do not silently fall back. Incoming quick reply payload is only a candidate; must be checked against signed webhook, tenant, active run and allowed option before committing state. Live multi-step inbound processing NOT yet integrated or deployed.
- Internal: future flow-internal-worker only writes tenant-scoped tags/notifications and settles one unique Outbox item, without sending Meta messages or credit deductions. No staff UI access broadening.
- Meta: existing signature-verified milan-api Instagram/Messenger webhook has dormant receipt hook, which uses stable MID/account association; no response resend or billing.
- No real Graph API tests, no staff invitations and no webhook subscriptions were made.

## New manual-only tests (NOT run)

.github/workflows/flow-staff-rich-review-manual-ci.yml has workflow_dispatch ONLY. Includes disposable PG17 tests of roles/RLS, cross-tenant assignments, suspended user, tags, notification one-time event, Meta delivered/read MID matching, idempotency and service-role grants; Node tests quick replies, HTTPS card and signed event candidate mapping; Deno source checks, TypeScript and Vite. No running workflows was permitted. Prior CI from PR #143 does NOT validate this new source. There is no local PostgreSQL server in this session.

## Smallest acceptable pilot: ONE test tenant, ONE Instagram test channel, PLAIN TEXT ONLY

Use the existing simplified prepareSimpleFlowReply runtime: exactly two FlowDocument v3 nodes, trigger(message) -> message(text), no buttons/conditional/delay/action/RAG; FLOW_RUNTIME_MODE=message_only. The existing database flow_claim_inbound is exclusive under duplicate/concurrent events, and legacy AI remains default when global/tenant/canary OFF or engine cannot prepare. Do not include rich action deployment in this pilot.

Required future independent gates, in order:
1. Separate GO-M main-branch workflow bootstrap safety below, then protected Environment reviewer and secrets setup. A later separate GO to RUN the protected dual-function release workflow; exact code SHA, v101 source backup and test rollback; no uncontrolled deployment.
2. Validate compatible milan-api with flags OFF, real isolated Widget HTTP smoke and cleanup; flow-publication JWT verification, origin restriction and A/B 401/403/429/200, Canary OFF. Full successful B publish is not covered in production cleanup-safe test (immutable publication), use separate disposable project or explicitly approved alternative.
3. Separate GO for atomic consume_reply migration 20261028221000, ONLY after verified v101 inflight drain or separately approved durable signed webhook maintenance buffer. Verify one send equals one debit/ledger; never blindly restore ghost-ledger version.
4. Meta App Review permissions, correct signed Instagram webhook, account and recipient both test-only, allowed messaging window, no actual customers.
5. Publish ONLY the simple 2-node text flow under test channel. New distinct GO to enable global switch and ONLY this tenant's test_only switch, activate only its flow, set FLOW_RUNTIME_MODE=message_only. Others keep tenant switch OFF and existing AI.
6. One test inbound event, one confirmed outbound Meta response, one ledger debit, zero duplicate on replay and concurrent callback; record provider message ID and logs, then turn flow gates OFF. Ambiguous provider result remains manual review risk while delivery tracking is OFF.
7. Do not automatically delete claim or financial history; settlement of old Widget answers is separate.

Deferrable after pilot: multi-node runtime SQL, new outbox worker, rich buttons, link cards, staff schema/UI, tags, staff alerts, Meta delivered/read receipts, RAG, WhatsApp, scheduling, broader canary and mass rollout. No need to bundle those unapproved migrations with text-only canary.

## Main branch safety audit and separate GO-M approval

All 18 current default-main workflow YAML files were inspected via GitHub connector:
- .github/workflows/deploy.yml: unfiltered push on main/master; any workflow-only commit to main WOULD trigger GitHub Pages deployment. Therefore direct workflow copy to main is UNSAFE.
- .github/workflows/deploy-functions.yml: push main filtered to supabase/functions/**, so a workflow-YAML-only commit would NOT trigger it, but merging the stacked PR with source files WOULD trigger deployment of several old Edge Functions. Forbidden.
- Remaining 16 main workflows have feature-branch push filters and/or manual dispatch, not main deploy triggers from a workflow-only commit.

Do NOT rely only on a [skip ci] commit message. Separate owner GO-M proposed:
(a) Temporarily DISABLE the existing Pages deployment workflow via GitHub Actions settings/API, confirm disabled;
(b) add a push.paths filter to Pages workflow matching real frontend changes only, and copy ONLY the protected workflow YAML to main in a dedicated workflow-only commit. NO Supabase functions, SQL, app code or other workflow changes.
(c) Verify no Pages or old Edge workflow ran and Pages filter is active; re-enable Pages only after verification. Ensure main branch coordination/no concurrent pushes. The proposed protected dispatcher YAML checks out immutable SHA bdbddd972928f2ee7649abaf14b3bfae52439633, so its release scripts are not loaded from moving main.
(d) NO dispatch in GO-M; deploying milan-api and flow-publication needs a different GO with reviewer approval.

GO-M is REQUESTED FOR FUTURE CONSIDERATION, NOT GRANTED OR EXECUTED. Disabling Pages temporarily affects regular frontend deployment, so requires an agreed maintenance window and owner authorization.
