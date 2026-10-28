# Meta signed-webhook security review — PR staging only

## Confirmed root cause

`supabase/functions/milan-api/index.ts` originally contained `if (secrets.length === 0) return true;` inside `verifyMetaSignature`. When both `INSTAGRAM_APP_SECRET` and `META_APP_SECRET` were empty, **any unsigned Instagram/Facebook webhook payload could bypass the signature check**. This is a confirmed code-level defect, not evidence of actual exploitation.

## Minimal patch

- A strict standalone `metaSignature.ts` verifies raw-byte HMAC SHA256 and compares the 64-character header digest without early return across candidate app secrets.
- Missing/blank secrets now reject verification, **never pass**.
- Missing server signing configuration returns HTTP **503**, rather than silently acknowledging legitimate Meta events with 200. Confirmed invalid signatures still follow the existing ignore/ack behavior.
- Both previously supported secret candidates remain valid. No OAuth permissions, provider tokens, customer data, credits or other webhook semantics are intentionally changed.

## Tests

`tests/meta-signature.test.ts`: independent fixed HMAC vectors, wrong/missing app secrets, malformed headers, altered raw body, uppercase digest, and source-call-configuration assertion.

CI workflow `.github/workflows/meta-signature-safety-ci.yml`: Node tests, standalone WebCrypto verifier TypeScript check, caller wiring, frontend build.

## NO-GO and owner approval required

This branch changes **live `milan-api` code** and MUST NOT be merged/deployed without an explicit GO for that exact function revision. Verify that the appropriate production Meta App secrets are configured through approved secret metadata (do NOT paste secrets into ChatGPT or GitHub), and perform an authorized staging signed-webhook replay.

Risk: 503 responses will cause valid events to be retried during missing-secret configuration, and can expose a prolonged webhook outage until the secret is repaired. The current code accepts any *configured* IG/Meta app secret for both Instagram/Facebook as before. Subscriptions and channel mapping must be verified before tightening that further.

**Rollback:** store the currently deployed Edge Function version/commit before deployment; if unexpected failures occur, stop new flow sends, revert only the named function revision after owner GO, and restore secret configuration. Do not revert to fail-open verification without a separate security exception and explicit risk sign-off.

Verification before GO: valid signed IG, valid signed Facebook page message, malformed signature, missing secret 503, Meta retry, and a credit/AI regression on staging with test-owned accounts. **No production deployment has occurred.**
