# Batch 9 — inbound Meta event routing (review only)

This branch implements **only a pure event-to-flow matcher**. It does not change Supabase tables, deployed Edge Functions, `milan-api`, OAuth, subscriptions, message sending, or the production website.

## Required trust boundary

The future backend (not implemented in this branch) MUST, before calling `matchInboundEvent`:

1. Verify Meta's request signature using the exact app secret and the raw body.
2. Validate the event's product and field against currently approved app permissions, subscriptions and API documentation. **Do not infer support from the editor's trigger dropdown.**
3. Resolve `tenantId` and `accountId` from a server-owned connected-account mapping, never from webhook fields or a browser-provided value.
4. Ignore outgoing/echo messages, self-events and malformed payloads; use the platform's stable event ID. Do not invent an event ID from text or timestamp.
5. Persist a unique idempotency record scoped to tenant, platform, account, event ID and flow ID **atomically before** execution. The `idempotencyKey` returned here is a candidate key, not an actual database lock.
6. Apply per-tenant and per-account rate limits, queueing and retry rules. Require a **server-published**, validated and capability-authorized flow revision; a browser-local `enabled` flag is not sufficient.
7. Ensure each sender's conversation state and Meta messaging-window restrictions are enforced before sending.

## Contract scope

- `message`: direct incoming message.
- `keyword`: direct incoming message containing one of the configured words; Arabic comma, English comma and newline separate keywords. Arabic diacritics, hamza and whitespace are normalized.
- `comment`: comment event; keyword filter is optional. Support is platform-dependent and must be authorized upstream.
- `story`, `ad`, `live`, `referral`: **unsupported and rejected** until separate, evidence-backed adapters are implemented.
- WhatsApp comments: rejected.
- Keyword matching is **substring matching**, not exact-word matching; this may cause false positives. Configure precise phrases or add a reviewed matching mode before live launch.
- The matcher returns zero or more candidate flows; it **never sends messages**.

## Gate before live rollout

Keep `auditFlowPublication` fail-closed until an authenticated server supplies deployed capabilities. Build and test trusted webhook adapters and atomic event deduplication on an isolated branch, with explicit Meta permissions verified for each channel. No deployment or merge is authorized by this document.
