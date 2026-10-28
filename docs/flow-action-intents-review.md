# Flow runtime action intents — review only

Pure action planning was extended without connecting to a live backend.

## Supported plans
- `tag` and `untag` produce one idempotent tag intent, with bounded Unicode tag names.
- `notify` produces an internal staff-notification intent with bounded message body.
- `set_field` rejects missing/non-string input instead of throwing.
- `handoff` still stops further AI/automation in the planner.
- AI and external HTTP requests remain blocked until the trusted backend exists.

## Evidence
- GitHub Actions checks Node action-intent, runtime and simulation tests, TypeScript and Vite build.
- These tests do not write to Supabase, invoke Meta or charge a customer.

## Production integration blockers
- The runtime outbox schema currently allows only message/question/delay/handoff effects. It must be reconciled against real tenant schema before adding tag/untag/notify columns or dispatcher handlers.
- A trusted service must enforce tenant/account/conversation ownership when applying tag changes.
- Staff recipient must be resolved by server-side role/tenant permissions; do not send `notify` to a client-provided address.
- Every action must be durably reserved and idempotent across retries before the planner may be used in production.
- No activation of real flows, no production migration and no change to `milan-api` occurred.
- Requires staging tests and explicit per-action owner GO.
