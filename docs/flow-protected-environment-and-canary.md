# Protected combined release & one-tenant canary — not executable yet

Only review-source branch. NO GitHub workflow has been dispatched. NO Supabase SQL/Edge deployed by this branch.

## Current release workflow source

- .github/workflows/flow-protected-manual-release.yml has ONLY workflow_dispatch and required input.
- Required job Environment name: protected-supabase-flow-release; GitHub owner MUST create the Environment and add themselves (or a distinct reviewer) as REQUIRED REVIEWER. Select Wait for approval; ensure only an authorized reviewer approves. If self-review prevention is enabled, reviewer must differ from workflow actor.
- Checkout must retain only commit fd4f3cb3f252e9e367b0963ef37d1c8e84daee85 for milan-api (reviewed PR #141) and reviewed commit f37a8be7800e1c47d7e3c0db4ab69e612e3f4cc9 for flow-publication. Both are pinned in release shell; branch HEAD is never deployed.
- Supabase milan-api v101 verify_jwt=false must exist BEFORE the job starts. Backup: supabase functions download milan-api; save complete current source and SHA256 in protected runner; one-day GitHub artifact. If CLI download returns more than the verified one-source-file v101, fail before deployment.
- Candidate milan-api with Widget billing and delivery tracking OFF. flow-publication gateway verify_jwt=true and canary OFF. All other functions unchanged.
- Live smoke: baseline 10 tenants, 4 accounts, 4 conversations, 12 Widget messages, 3 reply_ledger, 5 historic Widget answers; 0 newly charged/active flows/outbox. Auth A/B created with disposable email + password; inactive stores and channels plus one real Widget. The old v101 and candidate are each invoked through real Widget HTTP. The test compares real disabled-store reply shape, expects zero billing on both. This is NOT an active AI/paid-answer test, since those feature switches are OFF. B accounts and list HTTP 200; A->B publish/activate/deactivate 403; absent/expired JWT 401; 30/min per-tenant limiter 429 for A and B remains 200; Canary OFF.
- **Actual B publication intentionally NOT executed:** publication revision is immutable under BEFORE DELETE trigger. A live successful publish would prevent zero-residue cleanup. Synthetic PG17 and Deno HTTP tests already exercise B publish 200. Independent disposable-project or nonproduction test-only publication rollback design is required for real B publish 200.
- Always cleanup all disposable rows by ID (including counters and auth.users), then compare baseline counts byte-for-byte. On post-deploy failure, delete only newly deployed flow-publication, redeploy backed up exact milan-api v101 SOURCE, re-download and compare source, verify jwt=false; version number becomes newer, **not literally 101**.
- A GitHub runner hard-kill, platform failure or missing credentials cannot guarantee rollback. Separate operator runbook/verified backup is still necessary before actual owner GO. Any inconsistency must STOP release.

## IMPORTANT GitHub platform blocker

GitHub workflow_dispatch only becomes triggerable if the workflow file exists on the DEFAULT branch. It is now only on a feature branch by explicit owner restriction, therefore it is **NOT runnable from the Actions tab today**, regardless of secrets. GitHub existing main deploy-functions.yml IS manually triggerable but deploys many other functions and has no protected Environment; **DO NOT USE IT for this release**. A later, separate owner GO must authorize a minimal protected dispatch entry on main OR a platform-approved alternate bootstrap. Not done here.

## GitHub Environment secrets — NAMES ONLY

- SUPABASE_ACCESS_TOKEN
- SUPABASE_SERVICE_ROLE_KEY
- SUPABASE_ANON_KEY
- SUPABASE_JWT_SECRET

These four are referenced only within protected workflow. JWT_SECRET is needed to mint a **properly signed expired JWT** for the 401 test. Verify the current project's Auth JWT signing algorithm; modern asymmetric Auth signing may require a different test harness. Never paste any value in chat or commit.

Supabase Edge secrets (verify existing names in Dashboard, do not copy values to GitHub):
- SUPABASE_URL (platform-injected; no manual secret creation)
- SUPABASE_SERVICE_ROLE_KEY (platform-injected; never browser)
- FIELD_ENCRYPTION_KEY
- EMBED_API_KEY
- LLM_API_KEY
- LLM_MODEL
- EMBED_MODEL
- WA_ACCESS_TOKEN
- INSTAGRAM_APP_SECRET
- META_APP_SECRET
- FLOW_PUBLICATION_CANARY_READY = false (not enabled)
- WIDGET_BILLING_V2_ENABLED = false
- DELIVERY_TRACKING_V1_ENABLED = false
- FLOW_OUTBOX_SEND_ENABLED = false
- FLOW_ATOMIC_CONSUME_READY = false
- FLOW_RAG_ENABLED = false

The last three are proposal-only defaults; not set or activated by this workflow. SUPABASE_ names are system reserved and are provided automatically by Supabase runtime; do not attempt to recreate them as new custom secrets.

## Steps user can prepare WITHOUT starting a release

1. Open GitHub repository Settings -> Environments -> New environment. Name protected-supabase-flow-release.
2. Enable Required reviewers. Select your authorized GitHub account/independent reviewer; note self-review option. Restrict deployment branches/tags to the approved source branch if supported by your plan, and verify GitHub Environment rules actually apply.
3. In the Environment add the four GitHub secret NAMES above via Add secret; they are not yet requested in chat and should never be pasted in PR comments.
4. In Supabase Dashboard -> Edge Functions -> Secrets inspect the names above and confirm OFF status; no secrets printed. Never turn on Canary, publication activation or outbox send for this release.
5. Check the real Origin is https://hsnq2022022-cyber.github.io and website path /milanochat/. For Android WebView verify actual Origin separately.
6. Leave the workflow unrun. A later separate approval is needed to bootstrap manual dispatch from DEFAULT branch and to actually execute it. Owner's GO must explicitly cover both functions, test-data creation, automatic rollback source redeploy and cleanup.
7. Before live owner GO, verify Supabase CLI download actually retrieves full v101 source and rollback works on a disposable separate project; branch CI alone cannot prove real rollback.

## One-store, one-channel launch — distinct future approvals

- Round 0: global OFF, all test tenants inactive; all actions shadow/simulation only.
- Round 1: only ONE test tenant and ONE Instagram test account, direct message test with provider-verified acknowledgment, separate GO for database global/tenant switches and flow activation; no public customers.
- Round 2: prove single inbound claim -> single outbound effect, single charge, duplicate and concurrent delivery, human takeover and no-credit. Confirm Meta recipient test-only.
- Round 3: 30 minutes (or configured approved window) observe 0 unknown/outbox uncertain, no unbilled delivered messages and no customer impact. Stop, no ramp unless manually approved.
- Fallback: global/tenant switches OFF, outbox worker OFF, no retries for uncertain, preserve ledgers, claims, review records.
- RAG only after tenant-owned source approval and quote validation. Staff roles must be reviewed separately under docs/flow-employee-permissions-proposal.md.


## Additional release blockers found in final code review

- GitHub default-branch deploy.yml listens on every main push and deploys GitHub Pages. A future main-only dispatcher bootstrap would itself trigger that workflow unless the owner ALSO authorizes/controls this deployment. No main push is authorized in this session.
- A protected Environment name in YAML is NOT proof that required reviewers are actually configured; the repository owner must manually verify the protection rule and reviewer eligibility.
- The signed expired-JWT HTTP test currently requires the legacy HS256 SUPABASE_JWT_SECRET. If Auth uses asymmetric keys, do not invent a signing secret; replace this test with a supported short-lifetime test token flow on a separate auth environment before GO.
- The live Widget smoke deliberately uses an inactive test tenant. It verifies the historical safe refusal and unchanged zero debit with flags OFF, NOT an active RAG answer or a successful paid Widget debit. The latter requires a separate test after enabling approved billing and an authorized test-only LLM source.
- The protected A/B smoke never creates an immutable publication; B returns 200 for its own accounts/list, while synthetic HTTP tests cover a successful publish. Full real B publishing needs a disposable project or separately approved publication cleanup mechanism.
- New Outbox message dispatcher only supports plain text, and the RAG adapter currently requires an OpenAI-compatible embedding/chat endpoint. Existing custom Gemini setup and rich platform buttons require explicit compatibility tests. Staff notification/tag executors and delivered receipts are NOT complete. Do not enable any sender merely because source CI passes.
- An ambiguous provider 2xx where persistence or charging fails is NOT auto retried, and remains a billing/manual-review exception. Production monitoring and ownership required.
- Scheduler exists on the feature branch with its repository gate default OFF; even after an eventual main merge it must never run until separate, explicit owner approval, supported Edge worker deployments, and reviewer/secret validation.
