-- Synthetic database integration after both atomic reservation fixtures.
-- No real users, credits, Meta accounts or Supabase project are accessed.
\set ON_ERROR_STOP on
set role service_role;
do $tests$
declare
 ta uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 aa uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 ca uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 r1 uuid:='20000000-0000-4000-8000-000000000201';
 r2 uuid:='20000000-0000-4000-8000-000000000202';
 r3 uuid:='20000000-0000-4000-8000-000000000203';
 r4 uuid:='20000000-0000-4000-8000-000000000204';
 tk uuid:='99999999-9999-4999-8999-999999999999';
 approved boolean;
 debited text;
 before_credit integer;
begin
 select credits into before_credit from flow_ci.tenants where id=ta;
 -- Reserve a real PostgreSQL receipt, run and outbox, then give its test
 -- message a verified, non-expired fake window.
 approved:=flow_ci.reserve_inbound(ta,aa,'instagram',ca,'welcome',1,
   'evt-staging-worker-1',
   '10000000-0000-4000-8000-000000000201',r1,
   '30000000-0000-4000-8000-000000000201',
   'effect-worker-1','start','{"text":"test"}',true);
 if not approved then raise exception 'RESERVATION_FAILED';end if;
 update flow_ci.outbox set messaging_window_closes_at=clock_timestamp()+interval '1 hour'
  where tenant_id=ta and id=r1;

 if not flow_ci.claim_outbox(ta,r1,tk) then raise exception 'FIRST_CLAIM_FAILED';end if;
 if flow_ci.claim_outbox(ta,r1,'88888888-8888-4888-8888-888888888888')
   then raise exception 'SECOND_CLAIM_SUCCEEDED';end if;
 if flow_ci.dispatch_allowed(ta,r1,'88888888-8888-4888-8888-888888888888')
   then raise exception 'WRONG_LEASE_TOKEN_ALLOWED';end if;
 if not flow_ci.dispatch_allowed(ta,r1,tk)
   then raise exception 'CORRECT_LEASE_REJECTED';end if;

 update flow_ci.conversations set human_takeover=true where tenant_id=ta and id=ca;
 if flow_ci.dispatch_allowed(ta,r1,tk) then raise exception 'HUMAN_TAKEOVER_IGNORED';end if;
 update flow_ci.conversations set human_takeover=false where tenant_id=ta and id=ca;
 update flow_ci.global_switch set flows_enabled=false;
 if flow_ci.dispatch_allowed(ta,r1,tk) then raise exception 'GLOBAL_KILL_IGNORED';end if;
 update flow_ci.global_switch set flows_enabled=true;

 if flow_ci.record_provider(ta,r1,'88888888-8888-4888-8888-888888888888','accepted','x')
   then raise exception 'WRONG_TOKEN_CONFIRMED_SEND';end if;
 if not flow_ci.record_provider(ta,r1,tk,'accepted','provider-accepted-id')
   then raise exception 'ACCEPTED_PROVIDER_NOT_SAVED';end if;
 if flow_ci.record_provider(ta,r1,tk,'accepted','new-provider-id')
   then raise exception 'SECOND_PROVIDER_ACCEPTED';end if;
 debited:=flow_ci.debit_once(ta,r1);
 if debited<>'charged' then raise exception 'FIRST_DEBIT_FAILED: %',debited;end if;
 debited:=flow_ci.debit_once(ta,r1);
 if debited<>'already_charged' then raise exception 'SECOND_DEBIT_NOT_IDEMPOTENT: %',debited;end if;
 if (select credits from flow_ci.tenants where id=ta)<>before_credit-1
    or (select count(*) from flow_ci.reply_ledger where tenant_id=ta)<>1
   then raise exception 'DUPLICATE_DEBIT_OR_GHOST_LEDGER';end if;

 -- Ambiguous provider outcome never becomes billable or retryable.
 approved:=flow_ci.reserve_inbound(ta,aa,'instagram',ca,'welcome',1,
   'evt-staging-worker-2','10000000-0000-4000-8000-000000000202',r2,
   '30000000-0000-4000-8000-000000000202','effect-worker-2','start',
   '{"text":"ambiguous"}',true);
 if not approved then raise exception 'SECOND_RESERVATION_FAILED';end if;
 update flow_ci.outbox set messaging_window_closes_at=clock_timestamp()+interval '1 hour'
 where tenant_id=ta and id=r2;
 if not flow_ci.claim_outbox(ta,r2,tk) then raise exception 'SECOND_CLAIM_FAILED';end if;
 if not flow_ci.record_provider(ta,r2,tk,'unknown',null)
  then raise exception 'UNKNOWN_NOT_QUARANTINED';end if;
 if (select state from flow_ci.outbox where tenant_id=ta and id=r2)<>'uncertain'
  or flow_ci.claim_outbox(ta,r2,tk)
  or flow_ci.debit_once(ta,r2)<>'not_accepted'
 then raise exception 'UNKNOWN_SENT_OR_CHARGED_TWICE';end if;

 -- Crash after provider send, before its result is committed: expiry
 -- becomes uncertain, not a second claim.
 approved:=flow_ci.reserve_inbound(ta,aa,'instagram',ca,'welcome',1,
   'evt-staging-worker-3','10000000-0000-4000-8000-000000000203',r3,
   '30000000-0000-4000-8000-000000000203','effect-worker-3','start',
   '{"text":"crash"}',true);
 if not approved then raise exception 'THIRD_RESERVATION_FAILED';end if;
 update flow_ci.outbox set messaging_window_closes_at=clock_timestamp()+interval '1 hour'
 where tenant_id=ta and id=r3;
 if not flow_ci.claim_outbox(ta,r3,tk) then raise exception 'THIRD_CLAIM_FAILED';end if;
 update flow_ci.outbox set lease_expires_at=clock_timestamp()-interval '1 second'
 where tenant_id=ta and id=r3;
 if not flow_ci.quarantine_expired(ta,r3)
  or flow_ci.claim_outbox(ta,r3,tk)
 then raise exception 'EXPIRED_LEASE_REDELIVERED';end if;

 -- Window expired BEFORE first claim: no Meta send is authorized.
 approved:=flow_ci.reserve_inbound(ta,aa,'instagram',ca,'welcome',1,
   'evt-staging-worker-4','10000000-0000-4000-8000-000000000204',r4,
   '30000000-0000-4000-8000-000000000204','effect-worker-4','start',
   '{"text":"late"}',true);
 if not approved then raise exception 'FOURTH_RESERVATION_FAILED';end if;
 update flow_ci.outbox set messaging_window_closes_at=clock_timestamp()-interval '1 second'
 where tenant_id=ta and id=r4;
 if flow_ci.claim_outbox(ta,r4,tk)
  or flow_ci.claim_outbox('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',r4,tk)
 then raise exception 'EXPIRED_WINDOW_OR_CROSS_TENANT_CLAIM';end if;
 if (select count(*) from flow_ci.reply_ledger where tenant_id=ta)<>1
 then raise exception 'UNEXPECTED_CREDIT_LEDGER_ENTRY';end if;
end
$tests$;
reset role;

do $permissions$
declare fn text;
begin
 foreach fn in array array[
   'claim_outbox(uuid,uuid,uuid)',
   'dispatch_allowed(uuid,uuid,uuid)',
   'record_provider(uuid,uuid,uuid,text,text)',
   'quarantine_expired(uuid,uuid)',
   'debit_once(uuid,uuid)'
 ] loop
   if has_function_privilege('anon','flow_ci.'||fn,'EXECUTE')
     or has_function_privilege('authenticated','flow_ci.'||fn,'EXECUTE')
     then raise exception 'PUBLIC_WORKER_RPC: %',fn;end if;
   if not has_function_privilege('service_role','flow_ci.'||fn,'EXECUTE')
     then raise exception 'SERVICE_ROLE_CANNOT_EXECUTE: %',fn;end if;
 end loop;
 if has_table_privilege('anon','flow_ci.reply_ledger','SELECT')
   then raise exception 'LEDGER_EXPOSED';end if;
end
$permissions$;
select 'PASS: CAS lease, takeover, kill switch, provider ambiguity, credit debit once, expiry, windows, RLS grants' as result;
