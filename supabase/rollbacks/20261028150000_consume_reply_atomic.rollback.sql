-- DANGEROUS ROLLBACK: restores confirmed 2026-10-28 live function, including
-- the ghost-ledger-on-no-credit defect. Never run this automatically or on
-- production without a dedicated incident GO. Prefer server kill switch and
-- a corrected forward migration over reinstating an exploitable billing bug.
-- It intentionally does NOT delete any ledger/credit/customer data.
BEGIN;
CREATE OR REPLACE FUNCTION public.consume_reply(
  p_tenant_id uuid, p_message_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_remaining integer;
begin
  insert into public.reply_ledger (tenant_id, message_id)
  values (p_tenant_id, p_message_id)
  on conflict (message_id) do nothing;

  if not found then
    return -2;
  end if;

  update public.tenants
     set credits_remaining = credits_remaining - 1
   where id = p_tenant_id and credits_remaining > 0
  returning credits_remaining into v_remaining;

  if not found then
    return -1;
  end if;

  return v_remaining;
end;
$function$;
REVOKE ALL ON FUNCTION public.consume_reply(uuid,uuid)
 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_reply(uuid,uuid)
 TO service_role;
COMMIT;
