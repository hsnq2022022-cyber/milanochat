# Instagram single-account advanced canary — production recovery

Status: **planned, not armed**. This is a manual, operator-run recovery procedure. Do not execute during normal browsing, and do not run while messages are in flight.

## Confirmed baseline (2026-10-29)

- Account: the only active Instagram channel account in this project.
- Flow key: `ig_live_welcome_20261029`.
- Live revision: **2**, four nodes (`trigger -> condition -> two text replies`).
- Immutable revision 2 is present. Document MD5 from PostgreSQL `document::text`: `49e2fa89a91bb1774b30cff4d3ee13d1`.
- Revision 3: two-choice question; revision 4: one-minute delay. Both are **published but inactive**.
- Baseline at inspection: zero durable runs and zero Outbox rows.
- A successful basic Instagram message reply does **not** prove durable ingress, Outbox, rich buttons, scheduling or operator rollout secrets.

## Before the first canary

1. In the live Flow Builder select Instagram, choose the existing published flow, and run **Check readiness** separately on revision 3 (buttons) and revision 4 (delay).
2. Do not activate anything if either selected candidate is unconfigured. The readiness probe returns booleans, not secret values, and is not a delivery test.
3. Ensure no live customer conversation is in progress. A test on the single customer-facing Instagram account can change replies for other users.
4. Verify revision 2 remains active and that **no** durable runs or Outbox messages are queued. Never delete queues, receipts or customer messages to make a canary pass.
5. Do one change and one test at a time. Obtain a **fresh inbound message from a separate Instagram sender** after changing the active revision. For v3, tap one quick reply and check exactly one resulting response. For v4, verify a single reply arrives after the intended delay. Inspect Supabase logs and counts, not only the Instagram UI.
6. **Immediately restore revision 2** after each canary using the authenticated published revision UI. Recheck that revision 2 is active and the Outbox has no unsettled items. Stop testing on unexpected sends, duplicates, credit discrepancies, unanswered callbacks, or uncertain deliveries.

## Read-only SQL to verify the original version

```sql
SELECT a.platform,a.flow_key,a.revision,a.is_active,
       md5(p.document::text) AS document_md5
FROM public.automation_flow_activations a
JOIN public.automation_flow_publications p
  ON p.tenant_id=a.tenant_id AND p.channel_account_id=a.channel_account_id
 AND p.flow_key=a.flow_key AND p.platform=a.platform AND p.revision=a.revision
WHERE a.platform='instagram' AND a.flow_key='ig_live_welcome_20261029'
  AND a.is_active=true;
```

Expected after rollback: `revision=2`, `is_active=true`, digest `49e2fa89a91bb1774b30cff4d3ee13d1`.

## Emergency manual rollback (not executed)

Only an authorized operator with an authenticated database session should execute this block. It restores **only the known canary revisions (3 or 4)**, and refuses to run if queued/unsettled effects exist. Unsettled effects require individual human reconciliation before switching; changing the activation alone does not cancel queued sends. All writes are transactional; an exception rolls back the transaction.

```sql
BEGIN;
DO $rollback$
DECLARE
  target RECORD;
BEGIN
  IF (
    SELECT count(*) FROM public.automation_flow_activations
    WHERE platform='instagram' AND flow_key='ig_live_welcome_20261029'
      AND is_active=true
  )<>1 THEN
    RAISE EXCEPTION 'Expected exactly one active Instagram canary';
  END IF;

  SELECT a.tenant_id,a.channel_account_id,a.platform,a.flow_key,a.revision,
         t.user_id
    INTO target
    FROM public.automation_flow_activations a
    JOIN public.tenants t ON t.id=a.tenant_id
   WHERE a.platform='instagram' AND a.flow_key='ig_live_welcome_20261029'
     AND a.is_active=true
   FOR UPDATE OF a;

  IF target.revision=2 THEN
    RAISE NOTICE 'Revision 2 is already active';
    RETURN;
  END IF;
  IF target.revision NOT IN (3,4) THEN
    RAISE EXCEPTION 'Unexpected active revision: %',target.revision;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.automation_flow_publications p
    WHERE p.tenant_id=target.tenant_id
      AND p.channel_account_id=target.channel_account_id
      AND p.platform=target.platform AND p.flow_key=target.flow_key
      AND p.revision=2
      AND md5(p.document::text)='49e2fa89a91bb1774b30cff4d3ee13d1'
  ) THEN
    RAISE EXCEPTION 'Original immutable revision does not match baseline';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.automation_flow_runs r
    WHERE r.tenant_id=target.tenant_id
      AND r.channel_account_id=target.channel_account_id
      AND r.run_status IN ('sleeping','awaiting_input')
  ) OR EXISTS (
    SELECT 1 FROM public.automation_flow_outbox o
    JOIN public.automation_flow_runs r ON r.tenant_id=o.tenant_id AND r.id=o.run_id
    WHERE r.tenant_id=target.tenant_id
      AND r.channel_account_id=target.channel_account_id
      AND o.delivery_status<>'settled'
  ) THEN
    RAISE EXCEPTION 'Unresolved durable effects: reconcile before rollback';
  END IF;

  IF NOT public.flow_activate_revision(
    target.tenant_id,target.channel_account_id,target.platform,
    target.flow_key,2,target.user_id
  ) THEN
    RAISE EXCEPTION 'Server rejected revision 2 restoration';
  END IF;
END;
$rollback$;
COMMIT;
```

Never run this script as a general data cleanup. It is **not** a substitute for disabling sending and reconciling pending Outbox work when a canary fails.
