# Credit RPC caller inventory — review only

No production query or deployment was executed in this review session.
The live role privileges require the owner to run
`supabase/verification/20261026_restrict_credit_rpcs.readonly.sql`.

| Caller | RPC | Client privilege / location | Risk |
|---|---|---|---|
| `supabase/functions/milan-api/index.ts:2152` | `grant_credits` | `sbAdmin()`, service-role key at :55–60 | Confirm webhook authentication/payment idempotency separately |
| `supabase/functions/milan-api/index.ts:1879` | `consume_reply` | Same service-role | Missing `p_message_id` on current main; #114 unmerged |
| `supabase/functions/milan-api/index.ts:3087` | `consume_reply` | Same service-role | Widget caller still missing message ID |
| `supabase/functions/wayl-webhook/index.ts:121` | `grant_credits` | `createClient(supaUrl,srvKey)` at :201 with secret from :159 | Signed payment hook must be checked after lockdown |
| `server/src/routes/payments.ts:437` | `grant_credits` | Legacy `db` service client from `server/src/db.ts:25` | Railway legacy server deployment status **unknown** |
| `server/src/rag/reply.ts:528` | `consume_reply` | Same `db` service client | Legacy server, already passes outgoing message ID |

Review results: the checked repository code has no direct browser invocation
of either RPC. The service-role key MUST remain server-only. Even if permissions
are locked down, this is NOT evidence that billing is idempotent or that the
legacy Express server is offline. No live financial operation was tested.

Rollback: `supabase/migrations/rollback/20261026_restrict_credit_rpcs.rollback.sql`
restores public execution and is intentionally unsafe; execute only with
documented owner GO after investigating caller failures.
