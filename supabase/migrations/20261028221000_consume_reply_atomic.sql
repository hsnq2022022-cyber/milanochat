-- REVIEW-ONLY: exact live schema inspected 2026-10-28 on nmhefwvhoholcjrbbila.
-- NEVER deploy without a dedicated GO, snapshot of currently deployed RPC
-- definition, staging test and verification of every milan-api/widget caller.
-- Return compatibility: >=0 balance, -1 no credits, -2 already billed.
-- New -3 means an invalid tenant/message/ownership association.
BEGIN;

DO $guard$
BEGIN
  IF to_regprocedure('public.consume_reply(uuid,uuid)') IS NULL OR
     to_regclass('public.reply_ledger') IS NULL OR
     to_regclass('public.messages') IS NULL OR
     to_regclass('public.tenants') IS NULL
  THEN
    RAISE EXCEPTION 'Expected live billing objects missing; refusing blind migration';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.consume_reply(
  p_tenant_id uuid, p_message_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $consume$
DECLARE
  v_remaining integer;
BEGIN
  IF p_tenant_id IS NULL OR p_message_id IS NULL THEN
    RETURN -3;
  END IF;

  -- One row lock serializes all concurrent debit attempts for a tenant.
  -- Keep the lock until the ledger insert and credit update both commit.
  SELECT t.credits_remaining INTO v_remaining
  FROM public.tenants AS t
  WHERE t.id = p_tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN -3;
  END IF;

  -- A provider message UUID must identify an already-persisted outgoing
  -- message that belongs to THIS tenant and one of THIS tenant's chats.
  IF NOT EXISTS (
    SELECT 1 FROM public.messages AS m
      JOIN public.conversations AS c
        ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id
    WHERE m.id = p_message_id
      AND m.tenant_id = p_tenant_id
      AND m.direction = 'out'
  ) THEN
    RETURN -3;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.reply_ledger AS l
    WHERE l.message_id = p_message_id
      AND l.tenant_id = p_tenant_id
  ) THEN
    RETURN -2;
  END IF;

  -- Critical: do not create an idempotency ledger row if the tenant cannot
  -- pay. The old live implementation inserted FIRST and left ghost rows.
  IF v_remaining <= 0 THEN
    RETURN -1;
  END IF;

  UPDATE public.tenants
    SET credits_remaining = credits_remaining - 1
    WHERE id = p_tenant_id AND credits_remaining > 0
    RETURNING credits_remaining INTO v_remaining;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credits vanished while tenant row is locked';
  END IF;

  -- If this fails, PostgreSQL rolls back the credit update as well.
  INSERT INTO public.reply_ledger(tenant_id,message_id)
    VALUES (p_tenant_id,p_message_id);
  RETURN v_remaining;
END
$consume$;

REVOKE ALL ON FUNCTION public.consume_reply(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_reply(uuid,uuid)
  TO service_role;

COMMIT;
