# WhatsApp webhook signature security review

**Confirmed on repository main:** the `whatsapp_webhook` POST case in `supabase/functions/milan-api/index.ts` entered the inbound customer-message loop without verifying `X-Hub-Signature-256`. This permits spoofed inbound text if the endpoint is reachable and the tenant/account binding can be guessed. This is a code-level risk, **not evidence of an actual attack**.

## Review patch (not deployed)

- New check is placed before `for (const entry of body.entry ?? [])`.
- Verify the original UTF-8 raw request body using the `verifyMetaWebhookSignature` helper from parent PR #129, with either `WHATSAPP_APP_SECRET` (new optional server secret name) or existing `META_APP_SECRET`.
- Missing configuration returns HTTP 503 to permit provider retry until the owner fixes the app secret. Invalid signatures return HTTP 401. The GET hub.verify_token handshake remains unchanged; it is NOT a substitute for verifying POST HMAC.
- Parent PR #129 also fixes Instagram/Facebook's fail-open behavior when app secrets are missing.

## Verified tests

[CI #40684131072](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40684131072): signed UTF-8 WhatsApp test vector, modified text/message ID, missing secret/signature, source check for signature BEFORE message processing, Meta signature regression tests, TS check and Vite build.

## Owner GO / rollout required

This PR changes `milan-api`, which currently serves live WhatsApp clients. **Do not merge or deploy** until the owner designates staging, confirms the correct WhatsApp Meta App Secret is set in Supabase secure config (never paste secret values), runs a signed WhatsApp test-message replay, verifies Meta subscription GET and POST, tests invalid/missing signature responses, confirms original AI and credits behavior, records the previous deployed Edge Function revision and gives an exact GO.

Risk: if the secret is missing or wrong, all legitimate WA webhook POST deliveries return 503/401 and may be repeatedly retried. If the provider's retry window expires, clients may miss messages. Roll back only the approved Edge Function revision after GO, **not** to unsigned acceptance by default. Meta app permissions, webhook subscriptions and customer data remain unchanged in this review branch.
