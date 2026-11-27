# channel-token-lifecycle: Supabase Dashboard deployment package

This directory is a **Dashboard-specific, flattened copy** of the `channel-token-lifecycle` Edge Function. It is **not** the canonical source and nothing in the repository imports it.

- **Prepared from base commit:** `7f0a74b1d049c9bb990fc7e4332d3d1926cf6e47`.
- **Why flattened:** the Dashboard editor deploys a single function folder, so imports that pointed outside the function folder were rewritten to local `./` paths. Exactly 7 import specifiers differ from the canonical sources (in `index.ts`, `lifecycle.ts` and `deliveryCore.ts`); the other 6 files are byte-identical copies.
- **Canonical sources (copied from):** `supabase/functions/channel-token-lifecycle/{index,lifecycle}.ts`, `supabase/functions/_shared/channelReauth.ts`, `supabase/functions/flowWorkerAuth.ts`, `supabase/functions/flow-outbox-worker/{deliveryCore,flowRichActions,mediaPolicy}.ts`, `src/flow/placeholders.ts`, `src/lib/channelTokenState.ts`.
- **Function name:** exactly `channel-token-lifecycle`. **Entrypoint:** `index.ts`.
- **`verify_jwt` must be `false`.** The function authenticates callers itself with a Bearer key (not a JWT); with JWT verification on, the gateway rejects them.
- **Required Edge Function secrets (must already exist):** `FIELD_ENCRYPTION_KEY`, `META_APP_ID`, `META_APP_SECRET`, `flow_worker_service_role_key`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are expected to be platform-injected.
- **Keep in sync:** this package is separate from the canonical files. If any of the canonical sources above change, regenerate this package; do not edit it by hand.

Post-deploy checks (unauthenticated, no Bearer, no tick): `GET` must return JSON `405 {"error":"Method not allowed"}`; `POST` must return JSON `401 {"error":"Unauthorized"}`. A platform-style 401 ("Missing authorization header") means `verify_jwt` is still on.

No credentials or secret values belong in this directory.
