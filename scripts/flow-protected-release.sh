#!/usr/bin/env bash
# Future owner-approved, protected workflow_dispatch ONLY. Never called by CI.
set -Eeuo pipefail
umask 077
PROJECT="nmhefwvhoholcjrbbila"
PIN_MILAN="da3275e968d62f628043dcabe407f2e1eaf89287"
PIN_PUB="f37a8be7800e1c47d7e3c0db4ab69e612e3f4cc9"
MODE="$1"
if [[ "$MODE" != "dry-run" && "$MODE" != "release" ]];then
 echo "ERROR: expected dry-run or release";exit 2
fi
WORK="$RUNNER_TEMP/flow-protected"
mkdir -p "$WORK/backup/supabase/functions" "$WORK/verify/supabase/functions"
export FLOW_TEST_STATE="$WORK/$MODE-state.json"
export SUPABASE_URL="https://$PROJECT.supabase.co"
DEPLOYED_MILAN=false
DEPLOYED_PUB=false
BASELINED=false
cleanup(){
 # A fixture can be partially created before setup completes. The fixture
 # journal is written before any Auth/DB insert; cleanup MUST inspect it.
 if [[ -f "$FLOW_TEST_STATE" ]];then
  node scripts/flow-protected-live-smoke.mjs cleanup || { echo "CRITICAL: fixture cleanup failed"; return 1; }
 else
  echo "CLEANUP: no fixture journal; no fixture creation was attempted"
 fi
}
get_functions(){ supabase functions list --project-ref "$PROJECT" --output json > "$WORK/functions.json"; }
check_remote(){
 node --input-type=module - "$1" "$2" "$3" "$WORK/functions.json" <<'NODE'
import fs from "node:fs";import assert from "node:assert/strict";
const [name,version,verify,path]=process.argv.slice(2);
const obj=JSON.parse(fs.readFileSync(path,"utf8")),list=Array.isArray(obj)?obj:obj.functions;
assert(Array.isArray(list),"Unexpected CLI list schema");
const fn=list.find(x=>x.slug===name||x.name===name);
if(version==="absent")assert.equal(fn,undefined,"Must not replace existing "+name);
else{
 assert(fn,"Function missing: "+name);
 if(version!=="any")assert.equal(Number(fn.version),Number(version),"Version mismatch");
 assert.equal(Boolean(fn.verify_jwt),verify==="true","JWT policy mismatch "+name);
}
NODE
}
restore(){
 local failed=0
 if [[ "$DEPLOYED_PUB" == true ]];then
  supabase functions delete flow-publication --project-ref "$PROJECT" ||
    { echo "CRITICAL: cleanup new flow-publication failed";failed=1; }
 fi
 if [[ "$DEPLOYED_MILAN" == true ]];then
  echo "Restoring saved v101 SOURCE as new deployment version"
  supabase secrets set WIDGET_BILLING_V2_ENABLED=false DELIVERY_TRACKING_V1_ENABLED=false \
    FLOW_PUBLICATION_CANARY_READY=false --project-ref "$PROJECT" >/dev/null ||
    { echo "CRITICAL: could not verify recovery feature flags OFF";failed=1; }
  (cd "$WORK/backup" && supabase functions deploy milan-api --no-verify-jwt --project-ref "$PROJECT") ||
   { echo "CRITICAL: restoring saved v101 source failed";return 1;}
  (cd "$WORK/verify" && supabase functions download milan-api --project-ref "$PROJECT") ||
   { echo "CRITICAL: cannot verify restored source";return 1;}
  cmp -s "$WORK/backup/supabase/functions/milan-api/index.ts" \
   "$WORK/verify/supabase/functions/milan-api/index.ts" ||
   { echo "CRITICAL: rollback source differs from v101";return 1;}
  get_functions
  check_remote milan-api any false
  echo "PASS: rollback source identical to saved v101; version number is new"
  # Source-byte parity is necessary but NOT sufficient: re-run the same
  # live Widget behavior test before deleting its isolated fixtures.
  if [[ "$BASELINED" == true && -f "$FLOW_TEST_STATE" ]] &&
     node --input-type=module - "$FLOW_TEST_STATE" <<'NODE'
import fs from "node:fs";
const s=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
process.exit(s.widgets?.length&&s.oldBehavior?0:1);
NODE
  then
   node scripts/flow-protected-live-smoke.mjs after ||
     { echo "CRITICAL: restored v101 Widget behavior parity FAILED";failed=1; }
  fi
 fi
 [[ "$failed" == 0 ]]
}
finish(){
 local code=$?
 trap - EXIT ERR INT TERM
 if [[ "$code" != 0 ]];then
  echo "FAIL release: restoring before teardown"
  restore || code=1
 fi
 if ! cleanup;then
  code=1
  echo "FAIL release: cleanup is part of the verified release contract"
  # A cleanup failure is a post-deploy test failure as well.
  restore || code=1
  cleanup || code=1
 fi
 if [[ "$code" == 0 ]];then echo "PASS: $MODE, cleanup and exact database counts verified";fi
 exit "$code"
}
trap finish EXIT
trap 'exit 1' ERR INT TERM
for n in SUPABASE_ACCESS_TOKEN SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY SUPABASE_JWT_SECRET;do
 [[ -n "$(printenv "$n" 2>/dev/null)" ]] || { echo "Missing GitHub Environment secret: $n";exit 1;}
done
[[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]]
[[ "$GITHUB_REPOSITORY" == "hsnq2022022-cyber/milanochat" ]]
[[ "$FLOW_RELEASE_CONFIRM" == deploy-two-test-only ]]
[[ "$GITHUB_REF" == "refs/heads/main" ]] || { echo "BLOCKED: only main dispatch";exit 1; }
npm ci --ignore-scripts --no-audit --no-fund
git fetch --no-tags origin "$PIN_MILAN" "$PIN_PUB"
git cat-file -e "$PIN_MILAN^{commit}"
git cat-file -e "$PIN_PUB^{commit}"
get_functions
check_remote milan-api 101 false
check_remote flow-publication absent false
# STEP ONE: production dry-run does not deploy, publish or alter secrets.
# It creates disposable Auth/tenant/Widget fixtures and guarantees teardown.
# This mode is executed as its own protected GitHub Actions step.
if [[ "$MODE" == "dry-run" ]];then
 node scripts/flow-protected-live-smoke.mjs preflight
 BASELINED=true
 node scripts/flow-protected-live-smoke.mjs setup
 node scripts/flow-protected-live-smoke.mjs before
 echo "DRY-RUN: fixture HTTP/SQL succeeded; awaiting EXIT cleanup and count comparison"
 exit 0  # EXIT trap verifies and prints before/after counts
fi

# CLI downloads code to current working directory. Use private runner temp.
(cd "$WORK/backup" && supabase functions download milan-api --project-ref "$PROJECT")
test -s "$WORK/backup/supabase/functions/milan-api/index.ts"
# Production v101 currently consists of a single index.ts, confirmed before GO.
test "$(find "$WORK/backup/supabase/functions/milan-api" -type f | wc -l)" -eq 1
sha256sum "$WORK/backup/supabase/functions/milan-api/index.ts" > "$WORK/source101.sha256"
tar -C "$WORK/backup" -czf "$WORK/complete-v101-source.tar.gz" supabase/functions/milan-api
echo "PASS: complete source101 privately captured; no source printed"
# Exact immutable reviewed commits, not this branch HEAD.
git restore --source="$PIN_MILAN" --worktree -- supabase/functions/milan-api
mkdir -p supabase/functions/flow-publication
git show "$PIN_PUB:supabase/functions/flow-publication/index.ts" \
 > supabase/functions/flow-publication/index.ts
test -s supabase/functions/milan-api/index.ts
test -s supabase/functions/flow-publication/index.ts
cat > supabase/config.toml <<'TOML'
[functions.milan-api]
verify_jwt = false
[functions.flow-publication]
verify_jwt = true
TOML
node scripts/flow-protected-live-smoke.mjs preflight
BASELINED=true
node scripts/flow-protected-live-smoke.mjs setup
node scripts/flow-protected-live-smoke.mjs before
# False flags only; neither Canary nor new sending is activated.
supabase secrets set WIDGET_BILLING_V2_ENABLED=false DELIVERY_TRACKING_V1_ENABLED=false \
 FLOW_PUBLICATION_CANARY_READY=false --project-ref "$PROJECT" >/dev/null
DEPLOYED_MILAN=true # ambiguous deploy timeout must still trigger rollback
supabase functions deploy milan-api --no-verify-jwt --project-ref "$PROJECT"
get_functions
node --input-type=module - "$WORK/functions.json" <<'NODE'
import fs from "node:fs";import assert from "node:assert/strict";
const r=JSON.parse(fs.readFileSync(process.argv[2],"utf8")),list=Array.isArray(r)?r:r.functions;
const f=list.find(x=>x.slug==="milan-api"||x.name==="milan-api");
assert(f&&Number(f.version)>101&&f.verify_jwt===false,"milan-api version/JWT mismatch");
NODE
node scripts/flow-protected-live-smoke.mjs after
DEPLOYED_PUB=true
supabase functions deploy flow-publication --project-ref "$PROJECT"
get_functions
check_remote flow-publication any true
node scripts/flow-protected-live-smoke.mjs ab
# EXIT trap always cleans fixtures and compares post-test production counts.
