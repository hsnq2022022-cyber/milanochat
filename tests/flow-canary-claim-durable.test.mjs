// 20261029170000_flow_canary_claim_durable: a SEPARATE claim function for the
// durable Flow V3/V4 Instagram path (production canary), verified against an
// operator-owned canary registration. flow_claim_inbound (V2) is unchanged.
//
// Static checks always run; behavioural checks run against a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only,
// listen_addresses='', removed afterwards) built from the repo fixture chain
// and migrations 20261028220000 .. 20261029170000. Never connects to any
// remote host; inherited PG* variables are stripped from every client.
// Billing is out of scope (no consume_* function is called).
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync,mkdtempSync,rmSync,chownSync} from "node:fs";
import {spawnSync,spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const MIG="supabase/migrations/20261029170000_flow_canary_claim_durable.sql";
const RB="supabase/rollbacks/20261029170000_flow_canary_claim_durable.rollback.sql";
const CLAIM="supabase/migrations/20261028220000_webhook_exclusive_claim.sql";
const LC="supabase/migrations/20261029130000_flow_run_lifecycle.sql";
const AI="supabase/migrations/20261029140000_flow_outbox_ai_retry.sql";
const TK="supabase/migrations/20261029150000_flow_takeover_resume.sql";
const CP="supabase/migrations/20261029160000_flow_credits_pause.sql";
const OLDER_RB=["supabase/rollbacks/20261029160000_flow_credits_pause.rollback.sql",
 "supabase/rollbacks/20261029150000_flow_takeover_resume.rollback.sql",
 "supabase/rollbacks/20261029140000_flow_outbox_ai_retry.rollback.sql",
 "supabase/rollbacks/20261029130000_flow_run_lifecycle.rollback.sql"];
const CHECKS="supabase/proposals/flow_v3_v4_predeploy_checks.review.sql";
const INGRESS="supabase/functions/milan-api/flowDurableIngress.ts";
const MARK="CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE";
const SIG="public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)";
const OLD_SIG="public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)";
const OPT_IN="-c flow.rollback_170000=discard-canary-data";
const src=f=>readFileSync(f,"utf8");
const md5=x=>createHash("md5").update(x).digest("hex");
const body=(f,tag)=>{const s=src(f),o=`AS $${tag}$`,a=s.indexOf(o)+o.length;return s.slice(a,s.indexOf(`$${tag}$`,a));};
const noComments=s=>s.split("\n").map(l=>l.replace(/--.*$/,"")).join("\n");

// ---------------------------------------------------------------- static
test("170000 is the newest migration and follows 130000/140000/150000/160000",()=>{
 const stamps=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql"))
  .map(f=>f.split("_")[0].padEnd(14,"0"));
 // Only 20261029180000_flow_durable_button_run_guards (requires 170000) and
 // 20261029190000_flow_begin_durable_run_superseding (requires 180000) and
 // 20261029200000_flow_media_storage (independent storage bucket) and
 // 20261029210000_flow_media_effects (requires 190000) and
 // 20261029220000_flow_media_stale_sweep (requires 210000) and
 // 20261029230000_flow_multichannel_support (requires 220000) are newer.
 // 20261115120000_channel_accounts_hardening: independent security migration (channel_accounts grants/policies/index; no flow object).
 // 20261115130000_wayl_topup_atomic_grant: independent billing migration (new wayl_grant_topup_once(uuid,integer,text,jsonb) only; no flow object).
 // 20261115150000_flow_delivery_failure_info: additive, newest (nullable failure columns + CHECK on automation_flow_delivery_attempts, new flow_fail_outbox_delivery; redefines no existing function; requires 210000).
 for(const s of stamps)if(!["20261029170000","20261029180000","20261029190000","20261029200000","20261029210000","20261029220000","20261029230000","20261029240000","20261029250000","20261029260000","20261029270000","20261029280000","20261029290000","20261029300000","20261029310000","20261029320000","20261029330000","20261029340000","20261029350000",/* 360000 inbound recovery: additive, new objects only, requires 340000 */"20261029360000","20261115120000","20261115130000","20261115150000","20261115160000","20261115170000","20261126100000"].includes(s))assert.ok(s<"20261029170000",s);
 for(const f of [CLAIM,LC,AI,TK,CP])assert.ok(existsSync(f),f);
});
test("migration: bounded, additive, service_role only, never touches flow_claim_inbound or billing",()=>{
 const m=src(MIG),code=noComments(m);
 assert.match(m,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m);
 assert.equal((code.match(/^BEGIN;$/gm)??[]).length,1);assert.equal((code.match(/^COMMIT;$/gm)??[]).length,1);
 assert.doesNotMatch(code,/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+public\./i);
 assert.doesNotMatch(code,/ALTER\s+TABLE(?![^;]*ENABLE ROW LEVEL SECURITY;)/i,"only ENABLE ROW LEVEL SECURITY");
 assert.doesNotMatch(code,/INSERT\s+INTO\s+public\.automation_flow_canary_accounts/i,"never registers a canary");
 assert.doesNotMatch(code,/SECURITY DEFINER|\bTO\s+(anon|authenticated|PUBLIC)\b|CREATE POLICY/i);
 assert.doesNotMatch(code,/cron\.|vault\.|net\.http_|sb_secret_|eyJ[A-Za-z0-9_-]{30,}|credits_remaining|consume_|wayl|topup/i);
 assert.doesNotMatch(code,/FUNCTION public\.flow_claim_inbound\(/,"V2 function never (re)defined");
 assert.doesNotMatch(code,/CREATE\s+FUNCTION/i,"CREATE OR REPLACE only (idempotent)");
 assert.equal((code.match(/CREATE OR REPLACE FUNCTION/g)??[]).length,1);
 assert.match(code,/CREATE OR REPLACE FUNCTION public\.flow_claim_inbound_durable\(\n p_tenant_id uuid,\n p_account_id uuid,\n p_platform text,\n p_provider_event_id text,\n p_conversation_id uuid,\n p_inbound_message_id uuid\n\) RETURNS TABLE\(acquired boolean,route text,claim_id uuid,outgoing_message_id uuid\)\nLANGUAGE plpgsql SECURITY INVOKER SET search_path=''/);
 assert.match(code,/REVOKE ALL ON FUNCTION public\.flow_claim_inbound_durable\(uuid,uuid,text,text,uuid,uuid\)\n FROM PUBLIC,anon,authenticated;/);
 assert.match(code,/REVOKE ALL ON TABLE public\.automation_flow_canary_accounts,public\.automation_flow_canary_claims\n FROM PUBLIC,anon,authenticated,service_role;/);
 assert.match(code,/GRANT SELECT ON public\.automation_flow_canary_accounts TO service_role;/);
 for(const p of ["apply 20261029130000_flow_run_lifecycle first","apply 20261029140000_flow_outbox_ai_retry first",
  "apply 20261029150000_flow_takeover_resume first","apply 20261029160000_flow_credits_pause first",
  "apply 20261028220000_webhook_exclusive_claim first"])assert.ok(m.includes(p),p);
 // The operator INSERT is documented in the header comment only.
 assert.match(m,/^-- +INSERT INTO public\.automation_flow_canary_accounts$/m);
});
test("rollback: bounded, opt-in data guard; every older rollback refuses while 170000 exists",()=>{
 const r=src(RB);
 assert.match(r,/^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m);
 assert.match(r,/current_setting\('flow\.rollback_170000',true\) IS DISTINCT FROM 'discard-canary-data'/);
 assert.doesNotMatch(noComments(r),/flow_claim_inbound\(|automation_message_claims/,"V2 objects and claims untouched");
 for(const f of OLDER_RB){
  const s=src(f);
  const guard=s.slice(s.indexOf("BEGIN;"),s.indexOf("$g$;")>0?s.indexOf("$g$;"):s.indexOf("$guard$;"));
  assert.match(guard,/roll back 20261029170000_flow_canary_claim_durable first/,f);
  assert.ok(guard.includes("flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)"),f);
 }
});
test("TypeScript: only the durable ingress calls the new function; V2 call site and 220000 are untouched",()=>{
 const ing=src(INGRESS);
 assert.equal((ing.match(/rpc\("flow_claim_inbound_durable"/g)??[]).length,1);
 assert.doesNotMatch(src("supabase/functions/milan-api/index.ts"),/flow_claim_inbound_durable/);
 const g=spawnSync("git",["diff","--quiet","HEAD","--",CLAIM]);
 if(g.status!==null&&g.error===undefined&&existsSync(".git")){
  assert.equal(g.status,0,"20261028220000 has no diff against HEAD");
  // milan-api/index.ts may differ from HEAD ONLY by the explicitly authorized
  // hunks below (the earlier provider-id provenance / typed-answer hunks are
  // part of HEAD): 20261029230000 multichannel ingress behind
  // FLOW_MULTICHANNEL_ENABLED and the object=page webhook hardening (401 on a
  // bad signature, facebook-only account lookup, ambiguous page id ignored).
  // Undoing exactly these hunks must reproduce HEAD byte for byte, so every
  // V2 and Instagram section stays unchanged.
  const IDX="supabase/functions/milan-api/index.ts";
  const head=spawnSync("git",["show","HEAD:"+IDX],{encoding:"utf8",maxBuffer:64<<20});
  assert.equal(head.status,0);
  const allowed=[
   // T5-S5 Meta credentials out of request URLs (fetchSenderProfile: token in
   // the Authorization header, URL without access_token=): exactly this hunk,
   // undone FIRST; covered by tests/meta-graph-credentials.test.ts and
   // tests/milan-profile-fetch-log-safety.test.ts.
   ["      url = `https://graph.instagram.com/v21.0/${senderId}?fields=name,username,profile_pic`;\n    } else if (channel === \"instagram\") {\n      // Facebook Login → Instagram API\n      url = `https://graph.facebook.com/v21.0/${senderId}?fields=name,profile_picture`;\n    } else {\n      // Facebook Messenger\n      url = `https://graph.facebook.com/v21.0/${senderId}?fields=name,picture`;\n    }\n\n    // T5-S5: the token travels in the Authorization header, never in the URL\n    // (same Bearer form as sendMeta / ../_shared/metaGraph.ts).\n    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });\n",
    "      url = `https://graph.instagram.com/v21.0/${senderId}?fields=name,username,profile_pic&access_token=${encodeURIComponent(token)}`;\n    } else if (channel === \"instagram\") {\n      // Facebook Login → Instagram API\n      url = `https://graph.facebook.com/v21.0/${senderId}?fields=name,profile_picture&access_token=${encodeURIComponent(token)}`;\n    } else {\n      // Facebook Messenger\n      url = `https://graph.facebook.com/v21.0/${senderId}?fields=name,picture&access_token=${encodeURIComponent(token)}`;\n    }\n\n    const res = await fetch(url);\n"],
   // T5-D2 CORS hardening (corsPolicy.ts + ../_shared/cors.ts: public `*`
   // only for the website Widget actions, exact trusted-origin echo + Vary:
   // Origin elsewhere, never credentials): exactly these hunks; covered by
   // tests/edge-cors-policy.test.ts.
   ["// T5-D2: CORS by action and request Origin (corsPolicy.ts, ../_shared/cors.ts).\nimport { withMilanCors } from \"./corsPolicy.ts\";\n\nconst enc = new TextEncoder();\n",
    "\nconst enc = new TextEncoder();\n"],
   ["// T5-D2: no Access-Control-Allow-Origin here; every response gets it from\n// withMilanCors (corsPolicy.ts) at the Deno.serve entry point.\nconst CORS = {\n  \"Access-Control-Allow-Headers\":",
    "const CORS = {\n  \"Access-Control-Allow-Origin\": \"*\",\n  \"Access-Control-Allow-Headers\":"],
   ["Deno.serve(async (req) => {\n  // T5-D2: the handler below is unchanged; only the CORS origin headers of its\n  // response (preflight included) are set per action and request Origin.\n  return withMilanCors(req, await milanApiHandler(req), env);\n});\n\n// T5-D2: the former Deno.serve handler, byte-identical from here to its\n// closing \"});\" (only this declaration line is new).\nconst milanApiHandler = (async (req: Request) => {\n",
    "Deno.serve(async (req) => {\n"],
   // Newest first: these hunks are undone BEFORE the older entries below
   // (two of which contain the lines they edit).
   // T5-S4 request body size limits / input boundaries (bodyLimits.ts:
   // per-class raw-body byte limit before JSON.parse and signature checks;
   // ingest_text / knowledge_add / qa_save / sourceUrl field limits):
   // exactly these hunks; covered by tests/milan-body-limits.test.ts.
   ["import { verifyMetaWebhookSignature } from \"./metaSignature.ts\";\n// T5-S4: request body size limits and input boundaries (bodyLimits.ts).\nimport {\n  bodyClassFor, bodyLimitFor, readBodyLimited, BODY_TOO_LARGE_MESSAGE, BODY_TOO_LARGE_LOG_TAG,\n  INGEST_TEXT_MAX_CHARS, TEXT_TOO_LONG_MESSAGE, textWithinLimit, qaPairsWithinLimits,\n  QA_PAIRS_LIMIT_MESSAGE, optionalSourceUrlValid, SOURCE_URL_INVALID_MESSAGE,\n} from \"./bodyLimits.ts\";\n",
    "import { verifyMetaWebhookSignature } from \"./metaSignature.ts\";\n"],
   ["  // T5-S4 (bodyLimits.ts): per-class byte limit on the raw body, enforced on\n  // the declared Content-Length AND the bytes actually received, BEFORE\n  // JSON.parse and BEFORE any signature check. Same text as req.text().\n  const bodyClass = bodyClassFor(action);\n  const limitedBody = await readBodyLimited(req, bodyLimitFor(bodyClass));\n  if (!limitedBody.ok) {\n    console.warn(BODY_TOO_LARGE_LOG_TAG, { class: bodyClass });\n    return err(BODY_TOO_LARGE_MESSAGE, 413);\n  }\n  const raw = limitedBody.text;\n",
    "  const raw = await req.text();\n"],
   ["        if (ctLimited) return ctLimited;\n        // T5-S4 (bodyLimits.ts): optional sourceUrl must be a string <= 2,048 chars.\n        if (!optionalSourceUrlValid(body.sourceUrl)) return err(SOURCE_URL_INVALID_MESSAGE);\n",
    "        if (ctLimited) return ctLimited;\n"],
   ["        case \"qa_save\": {\n          // T5-S4 (bodyLimits.ts): <= 50 pairs, bounded question / answer length,\n          // optional sourceUrl string <= 2,048 chars; before any DB write / embedding.\n          if (!qaPairsWithinLimits(body.pairs)) return err(QA_PAIRS_LIMIT_MESSAGE);\n          if (!optionalSourceUrlValid(body.sourceUrl)) return err(SOURCE_URL_INVALID_MESSAGE);\n",
    "        case \"qa_save\": {\n"],
   ["          // T5-S4 (bodyLimits.ts): bounded text before chunking / embedding.\n          if (!textWithinLimit(text, INGEST_TEXT_MAX_CHARS)) return err(TEXT_TOO_LONG_MESSAGE);\n\n          const chunks =\n            chunkText(text);\n",
    "          const chunks =\n            chunkText(text);\n"],
   ["        // T5-S4 (bodyLimits.ts): bounded text before chunking / embedding.\n        if (!textWithinLimit(t, INGEST_TEXT_MAX_CHARS)) return err(TEXT_TOO_LONG_MESSAGE);\n\n        const chunks =\n          chunkText(t);\n",
    "        const chunks =\n          chunkText(t);\n"],
   // T5-D1 claim-token hardening (claimToken.ts: well-formed + constant-time
   // match + tenant still unclaimed; one conditional, token-rotating claim
   // UPDATE): exactly these hunks; covered by tests/milan-claim-token.test.ts.
   ["import { bindingIsVerified, readBindingVerified, provenWhatsappAccount } from \"./waBinding.ts\";\n// T5-D1: claim token authority ends when the tenant is claimed (claimToken.ts).\nimport { tenantByClaimToken, claimTenantByToken, isClaimTokenFormat } from \"./claimToken.ts\";\n",
    "import { bindingIsVerified, readBindingVerified, provenWhatsappAccount } from \"./waBinding.ts\";\n"],
   ["  tenantId: string\n) {\n  // T5-D1: null (=> the same \"invalid token\" 403) unless the token is\n  // well-formed, matches in constant time AND the tenant is still unclaimed.\n  return await tenantByClaimToken(sb, tenantId, claimOf(req));\n}\n",
    "  tenantId: string\n) {\n  const { data } = await sb\n    .from(\"tenants\")\n    .select(\"*\")\n    .eq(\"id\", tenantId)\n    .maybeSingle();\n\n  if (!data) return null;\n\n  if (data.claim_token !== claimOf(req)) {\n    return null;\n  }\n\n  return data;\n}\n"],
   ["        // T5-D1 (claimToken.ts): a non-string / malformed token is \"invalid or\n        // used\" (404 below) with no DB call; otherwise ONE conditional UPDATE\n        // (claim_token match AND user_id IS NULL, token rotated) so exactly one\n        // concurrent claim wins and user_id is never overwritten.\n        const {\n          data,\n          error,\n        } = isClaimTokenFormat(claimToken)\n          ? await claimTenantByToken(sb, u.id, claimToken)\n          : { data: null, error: null };\n",
    "        const {\n          data,\n          error,\n        } = await sb\n          .from(\"tenants\")\n          .update({\n            user_id:\n              u.id,\n          })\n          .eq(\n            \"claim_token\",\n            claimToken\n          )\n          .is(\n            \"user_id\",\n            null\n          )\n          .select(\"id\")\n          .maybeSingle();\n"],
   // T5-S2 DB/internal error-detail hardening (dbFail / safeDbCode,
   // clientErrorMessage forwards only Arabic plain-Error text): exactly these
   // hunks; covered by tests/milan-db-error-leak.test.ts.
   ["/** Client-facing text: fixed provider messages; our own plain Error texts\n * (Arabic user messages) unchanged; fetch/runtime errors -> fallback.\n * T5-S2: a plain Error without Arabic text (internal English diagnostics,\n * raw Postgres/PostgREST text) is never forwarded -> fallback. */\n",
    "/** Client-facing text: fixed provider messages; our own plain Error texts\n * (Arabic user messages) unchanged; fetch/runtime errors -> fallback. */\n"],
   ["  if (e instanceof Error && e.name === \"SafeFetchError\") return e.message;\n  if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype && e.name === \"Error\" &&\n      /[\\u0600-\\u06FF]/.test(e.message)) {\n",
    "  if (e instanceof Error && e.name === \"SafeFetchError\") return e.message;\n  if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype && e.name === \"Error\") {\n"],
   ["\n/* ── T5-S2: database errors safe for logs and clients ──\n * Postgres/PostgREST message, details and hint can carry SQL, table /\n * column / constraint names and row values (tokens, phone numbers, customer\n * text): they never reach a client or a log line. Clients get a fixed Arabic\n * message (same status and body keys); logs get a fixed tag + coarse code. */\nconst DB_ERROR_MESSAGE = \"تعذر إتمام العملية — حاول مرة أخرى\";\n\n/** Coarse, value-free code: SQLSTATE (5 chars) or PGRSTnnn, else \"unknown\". */\nfunction safeDbCode(error: unknown): string {\n  try {\n    const c = typeof error === \"object\" && error !== null ? (error as { code?: unknown }).code : undefined;\n    if (typeof c === \"string\" && /^(?:[0-9A-Z]{5}|PGRST\\d{3})$/.test(c)) return c;\n  } catch {\n    /* hostile error object */\n  }\n  return \"unknown\";\n}\n\n/** Logs `error` (if any) as tag + code only and returns the fixed client text. */\nfunction dbFail(error: unknown, tag: string, message: string = DB_ERROR_MESSAGE): string {\n  if (error) console.error(\"[milan-api] db error\", { tag, code: safeDbCode(error) });\n  return message;\n}\n\n",
    "\n"],
   ["\n  // T5-S2: fixed text; keeps \"توكن\" so the reply / unresolved 502 branch\n  // (/توكن|token|auth|190/) is unchanged for a failed account read.\n  if (error) throw new Error(dbFail(error, \"account_read\", \"تعذر قراءة توكن حساب القناة — حاول مرة أخرى\"));\n",
    "\n  if (error) throw new Error(`fetchAccountWithToken: ${error.message}`);\n"],
   ["    throw new Error(\n      dbFail(error, \"widget_session_insert\",\n        \"تعذر إنشاء جلسة Widget\")\n",
    "    throw new Error(\n      error?.message ||\n        \"تعذر إنشاء جلسة Widget\"\n"],
   ["    throw new Error(\n      dbFail(error, \"widget_messages_read\", \"تعذر جلب رسائل الجلسة\")\n",
    "    throw new Error(\n      error.message\n"],
   ["    throw new Error(\n      dbFail(error, \"match_knowledge\", \"فشل البحث في قاعدة المعرفة\")\n",
    "    throw new Error(\n      `فشل البحث في قاعدة المعرفة: ${error.message}`\n"],
   ["        console.error(\"[webhook_billing] consume_reply PostgREST error\",{\n          tenantId,messageId:outgoingId,code:safeDbCode(error)\n",
    "        console.error(\"[webhook_billing] consume_reply PostgREST error\",{\n          tenantId,messageId:outgoingId,code:error.code??\"unknown\",\n          message:error.message??\"unknown\"\n"],
   ["        } catch (error) {\n          console.error(\"[widget.js] Error fetching script:\", safeErrorLog(error));\n",
    "        } catch (error) {\n          console.error(\"[widget.js] Error fetching script:\", error);\n"],
   ["          return err(\n            error\n              ? dbFail(error, \"create_tenant\", \"تعذر إنشاء الحساب — حاول مرة أخرى\")\n              : \"خطأ\",\n",
    "          return err(\n            error?.message ??\n              \"خطأ\",\n"],
   ["                      `[instagram_webhook] sender profile update failed | chatId=${chatId}`,\n                      { code: safeDbCode(profUpdErr) }\n",
    "                      `[instagram_webhook] sender profile update failed | chatId=${chatId}`,\n                      profUpdErr.message\n"],
   ["        throw new Error(\n          dbFail(insertInError, \"widget_message_insert\", \"تعذر حفظ الرسالة — حاول مرة أخرى\")\n",
    "        throw new Error(\n          insertInError.message\n"],
   ["          \"[widget_message] AI error\",\n          safeErrorLog(e)\n",
    "          \"[widget_message] AI error\",\n          e\n"],
   ["        console.error(\"[widget_message] answer insert failed\",{\n          tenantId:found.tenant.id,code:widgetSaveError?safeDbCode(widgetSaveError):\"missing_id\"\n",
    "        console.error(\"[widget_message] answer insert failed\",{\n          tenantId:found.tenant.id,code:widgetSaveError?.code??\"unknown\",\n          message:widgetSaveError?.message??\"missing id\"\n"],
   ["            return err(\n              dbFail(srcError, \"qa_save_source_insert\", \"تعذر إنشاء مصدر المعرفة\"),\n",
    "            return err(\n              srcError?.message ??\n                \"تعذر إنشاء مصدر المعرفة\",\n"],
   ["            return err(\n              dbFail(chunksError, \"qa_save_chunks_insert\", \"تعذر حفظ المحتوى في قاعدة المعرفة\"),\n",
    "            return err(\n              chunksError.message,\n"],
   ["            return err(\n              dbFail(srcError, \"ingest_text_source_insert\", \"تعذر إنشاء المصدر\"),\n",
    "            return err(\n              srcError?.message ??\n                \"تعذر إنشاء المصدر\",\n"],
   ["            return err(\n              dbFail(chunksError, \"ingest_text_chunks_insert\", \"تعذر حفظ المحتوى في قاعدة المعرفة\"),\n",
    "            return err(\n              chunksError.message,\n"],
   ["            return err(\n              dbFail(error, \"qa_test\", \"فشل البحث في قاعدة المعرفة\"),\n",
    "            return err(\n              error.message,\n"],
   ["          return err(\n            error\n              ? dbFail(error, \"claim_account\")\n              : \"رمز غير صالح أو مستخدم\",\n",
    "          return err(\n            error?.message ??\n              \"رمز غير صالح أو مستخدم\",\n"],
   ["          return err(\n            dbFail(error, \"widget_dashboard_list\", \"تعذر جلب البيانات — حاول مرة أخرى\"),\n",
    "          return err(\n            error.message,\n"],
   ["          return err(\n            dbFail(error, \"widget_dashboard_create\", \"تعذر إنشاء Widget\"),\n",
    "          return err(\n            error?.message ??\n              \"تعذر إنشاء Widget\",\n"],
   ["          return err(\n            dbFail(error, \"widget_dashboard_update\", \"تعذر تحديث Widget\"),\n",
    "          return err(\n            error?.message ??\n              \"تعذر تحديث Widget\",\n"],
   ["          return err(\n            dbFail(error, \"widget_dashboard_delete\", \"تعذر الحذف — حاول مرة أخرى\"),\n",
    "          return err(\n            error.message,\n"],
   ["          return err(\n            dbFail(error, \"conversations\", \"تعذر جلب البيانات — حاول مرة أخرى\"),\n",
    "          return err(\n            error.message,\n"],
   ["          return err(\n            dbFail(error, \"messages\", \"تعذر جلب البيانات — حاول مرة أخرى\"),\n",
    "          return err(\n            error.message,\n"],
   ["\n        if (upErr) return err(dbFail(upErr, \"agent_prompt_set\", \"تعذر حفظ التغييرات — حاول مرة أخرى\"), 500);\n",
    "\n        if (upErr) return err(upErr.message, 500);\n"],
   ["\n        if (upErr) return err(dbFail(upErr, \"takeover\", \"تعذر حفظ التغييرات — حاول مرة أخرى\"), 500);\n",
    "\n        if (upErr) return err(upErr.message, 500);\n"],
   ["\n        if (upErr) return err(dbFail(upErr, \"release\", \"تعذر حفظ التغييرات — حاول مرة أخرى\"), 500);\n",
    "\n        if (upErr) return err(upErr.message, 500);\n"],
   ["          return err(\n            dbFail(error, \"unresolved\", \"تعذر جلب البيانات — حاول مرة أخرى\"),\n",
    "          return err(\n            error.message,\n"],
   ["          return err(\n            dbFail(error, \"knowledge\", \"تعذر جلب البيانات — حاول مرة أخرى\"),\n",
    "          return err(\n            error.message,\n"],
   ["            return err(\n              dbFail(srcError, \"knowledge_add_url_source_insert\", \"تعذر إنشاء المصدر\"),\n",
    "            return err(\n              srcError?.message ??\n                \"تعذر إنشاء المصدر\",\n"],
   ["            return err(\n              dbFail(chunksError, \"knowledge_add_url_chunks_insert\", \"تعذر حفظ المحتوى في قاعدة المعرفة\"),\n",
    "            return err(\n              chunksError.message,\n"],
   ["          return err(\n            dbFail(srcError, \"knowledge_add_text_source_insert\", \"تعذر إنشاء المصدر\"),\n",
    "          return err(\n            srcError?.message ??\n              \"تعذر إنشاء المصدر\",\n"],
   ["          return err(\n            dbFail(chunksError, \"knowledge_add_text_chunks_insert\", \"تعذر حفظ المحتوى في قاعدة المعرفة\"),\n",
    "          return err(\n            chunksError.message,\n"],
   ["          return err(\n            dbFail(error, \"knowledge_delete\", \"تعذر الحذف — حاول مرة أخرى\"),\n",
    "          return err(\n            error.message,\n"],
   ["          return err(\n            dbFail(error, \"pay_create\", \"تعذر إنشاء الفاتورة — حاول مرة أخرى\"),\n",
    "          return err(\n            error.message,\n"],
   // T5-S1 create_tenant fail-closed DB rate limit (abuseGuards.ts
   // rateGateStrict / createTenantRules): exactly these two hunks; covered by
   // tests/milan-create-tenant-limit.test.ts.
   ["import { rateGate, widgetIpRules, widgetScopeRules, aiActionRules, knowledgeAddRules, CLAIM_AI_ACTIONS, rateGateStrict, createTenantRules } from \"./abuseGuards.ts\";\n",
    "import { rateGate, widgetIpRules, widgetScopeRules, aiActionRules, knowledgeAddRules, CLAIM_AI_ACTIONS } from \"./abuseGuards.ts\";\n"],
   ["      case \"create_tenant\": {\n        // T5-S1 (abuseGuards.ts): DB-backed, FAIL-CLOSED per-IP limit\n        // (5 / 10 min AND 20 / 24 h) BEFORE any body use or tenant insert.\n        // Limiter unavailable => 503, never an in-memory fallback.\n        const ctLimited = await rateGateStrict({\n          rpc: sb, headers: req.headers, salt: env(\"RATE_LIMIT_IP_SALT\"), cors: CORS,\n          rules: createTenantRules,\n        });\n        if (ctLimited) return ctLimited;\n\n        const {\n",
    "      case \"create_tenant\": {\n        const {\n"],
   // T4 S1/S2 messageScope "conversation_start" (conversationStart.ts): the
   // first-DM history read before the inbound row is stored, passed to both
   // engines' NEW-run selection. Exactly these hunks; covered by
   // tests/flow-conversation-start.test.ts.
   ["import { prepareSimpleFlowReply } from \"./flowPrepareMessage.ts\";\nimport { readConversationStart } from \"./conversationStart.ts\";\n",
    "import { prepareSimpleFlowReply } from \"./flowPrepareMessage.ts\";\n"],
   ["    return \"retry\";\n  }\n\n  // messageScope \"conversation_start\" (conversationStart.ts): is this the\n  // conversation's first customer DM? Read BEFORE the inbound row is stored\n  // (a re-drive excludes its own row), only where a flow can be selected:\n  // a proven channel account on Instagram (durable / V2), or any channel\n  // while FLOW_MULTICHANNEL_ENABLED (durable) or FLOW_RUNTIME_MODE\n  // \"message_only\" (V2) is on. Read failure = unknown state: nothing is\n  // persisted, no flow and no AI; the event stays retryable.\n  let conversationStart: boolean | null = null;\n  if (typeof account?.id === \"string\" && account.id.length > 0 &&\n      (channel === \"instagram\" || multichannelEnabled() || env(\"FLOW_RUNTIME_MODE\") === \"message_only\")) {\n    try {\n      conversationStart = await readConversationStart(sb, {\n        tenantId: String(tenantId), accountId: account.id, conversation: conv,\n        excludeInboundId: redrive ? redrive.inboundId : null,\n      });\n    } catch {\n      // ConversationStartUnavailableError (or any unexpected failure): unknown.\n      console.warn(\"[webhook-routing] conversation start unknown\", { code: \"conversation_start_unavailable\" });\n      return await unknownState();\n    }\n  }\n\n  /**\n   * حفظ رسالة العميل الواردة.",
    "    return \"retry\";\n  }\n\n  /**\n   * حفظ رسالة العميل الواردة."],
   ["    const durable=await attemptDurableInstagram(sb,{\n      conversationStart,\n      tenantId,",
    "    const durable=await attemptDurableInstagram(sb,{\n      tenantId,"],
   ["      durableRanked?{durableDocument:(d)=>supportedDurableDocument(d,channel),conversationStart}:{conversationStart}\n",
    "      durableRanked?{durableDocument:(d)=>supportedDurableDocument(d,channel)}:{}\n"],
   // SEC account-resolution hardening (branch sec/channel-accounts-hardening,
   // merged into rc/launch; tests/security-account-resolution.test.ts) plus the
   // review fix that excludes status 'disconnected' rows from the IG / Page
   // lookups (migration 20261115120000 index predicate): exactly these hunks,
   // undone FIRST so every older (flow-part2) entry below matches unchanged.
   // SEC: boundPhone: optional verifiedOnly filter (is_verified = true) for sends
   ["  sb: SupabaseClient,\n  tenantId: string,\n  // SEC (account resolution): true for SENDS — only an operator-VERIFIED\n  // binding may pick the sending phone_number_id. Display reads (wa_status,\n  // me) stay unfiltered so a pending binding still shows.\n  verifiedOnly = false\n): Promise<string | null> {\n  const query = sb\n    .from(\"wa_bindings\")\n    .select(\"phone_id\")\n    .eq(\"tenant_id\", tenantId);\n  const { data } = await (verifiedOnly\n    ? query.eq(\"is_verified\", true)\n    : query\n  ).maybeSingle();\n\n",
    "  sb: SupabaseClient,\n  tenantId: string\n): Promise<string | null> {\n  const { data } = await sb\n    .from(\"wa_bindings\")\n    .select(\"phone_id\")\n    .eq(\"tenant_id\", tenantId)\n    .maybeSingle();\n\n"],
   // SEC: sendToConversation: the wa_bindings phone id fallback must be VERIFIED
   ["  if (!phoneId) {\n    phoneId = await boundPhone(sb, tenantId, true);\n  }\n",
    "  if (!phoneId) {\n    phoneId = await boundPhone(sb, tenantId);\n  }\n"],
   // SEC: whatsapp_webhook fallback: read every candidate row (limit 2) + error
   ["            } else {\n              // SEC (account resolution): the channel_accounts fallback routes\n              // only when EXACTLY ONE active row claims this phone id. A lookup\n              // error or several rows (e.g. several tenants) fail closed, and a\n              // wa_bindings row (verified or not) of ANOTHER tenant blocks it.\n              const { data: chAccs, error: chAccErr } = await sb\n                .from(\"channel_accounts\")\n",
    "            } else {\n              const { data: chAcc } = await sb\n                .from(\"channel_accounts\")\n"],
   // SEC: whatsapp_webhook fallback: exactly one ACTIVE row, no foreign-tenant binding
   ["                .eq(\"channel\", \"whatsapp\")\n                .eq(\"status\", \"active\")\n                .limit(2);\n              const chAcc =\n                !chAccErr && Array.isArray(chAccs) && chAccs.length === 1\n                  ? chAccs[0]\n                  : null;\n\n              if (chAccErr || !Array.isArray(chAccs) || chAccs.length > 1) {\n                console.warn(\"[whatsapp_webhook] fallback account ignored\", { code: \"wa_account_lookup_failed_or_ambiguous\" });\n              } else if (\n                chAcc &&\n                bindingRow &&\n                String(bindingRow.tenant_id) !== String(chAcc.tenant_id)\n              ) {\n                console.warn(\"[whatsapp_webhook] fallback account ignored\", { code: \"wa_binding_tenant_mismatch\" });\n              } else if (chAcc) {\n                account = chAcc;\n",
    "                .eq(\"channel\", \"whatsapp\")\n                .maybeSingle();\n\n              if (chAcc) {\n                account = chAcc;\n"],
   // SEC: instagram_webhook: lookupFailed flag (error / ambiguity stop resolution; disconnected rows are no candidates)
   ["            let ambiguousPage = false;\n            // SEC (account resolution): a lookup error or an ambiguous\n            // Instagram id (2+ rows) stops resolution entirely — the next\n            // candidate is never tried (fail closed; same idea as\n            // commentIngress.ts: exactly one row or nothing). Rows with\n            // status 'disconnected' are not candidates at all; a needs_reauth\n            // (non-active) match still stops at the \"not active\" skip below.\n            let lookupFailed = false;\n\n",
    "            let ambiguousPage = false;\n\n"],
   // SEC: object=page lookup: the query error is read
   ["              if (body.object === \"page\") {\n                const { data: pageAccounts, error: pageLookupError } = await sb\n                  .from(\"channel_accounts\")\n",
    "              if (body.object === \"page\") {\n                const { data: pageAccounts } = await sb\n                  .from(\"channel_accounts\")\n"],
   // SEC: object=page lookup: status IS DISTINCT FROM 'disconnected'; error fails closed (no next candidate)
   ["                  .eq(\"channel\", \"facebook\")\n                  // A disconnected row neither receives nor blocks (it is\n                  // outside the global unique index, 20261115120000).\n                  .or(\"status.is.null,status.neq.disconnected\")\n                  .limit(2);\n\n                if (pageLookupError) {\n                  lookupFailed = true;\n                  break;\n                }\n\n                if (Array.isArray(pageAccounts) && pageAccounts.length > 1) {\n",
    "                  .eq(\"channel\", \"facebook\")\n                  .limit(2);\n\n                if (Array.isArray(pageAccounts) && pageAccounts.length > 1) {\n"],
   // SEC: Instagram lookup: rows + error instead of maybeSingle()
   ["\n              const { data: igAccounts, error: igLookupError } = await sb\n                .from(\"channel_accounts\")\n",
    "\n              const { data } = await sb\n                .from(\"channel_accounts\")\n"],
   // SEC: Instagram lookup: status IS DISTINCT FROM 'disconnected', limit(2), error/2+ rows fail closed, generic log
   ["                ])\n                // A disconnected row neither receives nor blocks (it is\n                // outside the global unique index, 20261115120000).\n                .or(\"status.is.null,status.neq.disconnected\")\n                .limit(2);\n\n              if (igLookupError || (Array.isArray(igAccounts) && igAccounts.length > 1)) {\n                lookupFailed = true;\n                break;\n              }\n\n              if (Array.isArray(igAccounts) && igAccounts.length === 1) {\n                account = igAccounts[0];\n                break;\n              }\n            }\n\n            if (lookupFailed) {\n              console.warn(\n                \"[instagram_webhook] account lookup failed or ambiguous — event ignored\"\n              );\n              continue;\n            }\n",
    "                ])\n                .maybeSingle();\n\n              if (data) {\n                account = data;\n                break;\n              }\n            }\n"],
   // Flow-part2 stage 6 (provider error leak hardening; Gemini key header,
   // no provider bodies / error objects in logs, errors or client text):
   // exactly these hunks, undone FIRST so every older entry below matches
   // unchanged. Covered by tests/milan-provider-error-leak.test.ts.
   // Stage 6 hardening: safeProviderCode / ProviderHttpError / ProviderNetworkError / safeErrorLog / clientErrorMessage helpers (new, additive).
   ["\n/* ── Stage 6 hardening: provider/network errors safe for logs and clients ──\n * Provider response bodies (they can echo API keys, tokens or customer text)\n * and fetch error messages (they embed the request URL) never reach a log\n * line, a thrown message or a client response. Only the provider name, the\n * numeric HTTP status and a validated provider error code are kept. */\n\n/** A provider error code: a finite number or a short [A-Za-z0-9_.-] token. */\nfunction safeProviderCode(x: unknown): number | string | undefined {\n  if (typeof x === \"number\" && Number.isFinite(x)) return x;\n  if (typeof x === \"string\" && /^[A-Za-z0-9_.-]{1,40}$/.test(x)) return x;\n  return undefined;\n}\n\n/** Same pattern the reply/unresolved callers used on the old message text. */\nconst LEGACY_AUTH_HINT = /توكن|token|auth|190/i;\n\n/** Non-2xx provider response. Message is FIXED: provider + status + code. */\nclass ProviderHttpError extends Error {\n  readonly provider: string;\n  readonly status: number;\n  readonly code: number | string | undefined;\n  /** LEGACY_AUTH_HINT on the old `${provider} ${status}: ${body}` message. */\n  readonly authHint: boolean;\n  constructor(provider: string, status: number, code?: unknown, authHint = false) {\n    const p = /^[A-Za-z0-9 _.-]{1,40}$/.test(provider) ? provider : \"provider\";\n    const s = Number.isFinite(status) ? Math.trunc(status) : 0;\n    const c = safeProviderCode(code);\n    super(`${p} ${s}` + (c === undefined ? \"\" : ` (code ${c})`));\n    this.name = \"ProviderHttpError\";\n    this.provider = p;\n    this.status = s;\n    this.code = c;\n    this.authHint = authHint;\n  }\n}\n\n/** Builds a ProviderHttpError from a raw body; the body is then discarded. */\nfunction providerErrorFromBody(provider: string, status: number, raw: string): ProviderHttpError {\n  let code: unknown;\n  try {\n    const j: any = JSON.parse(raw);\n    code = j?.error?.code ?? j?.code ?? j?.error?.type ?? j?.type;\n  } catch {\n    /* not JSON: no code */\n  }\n  return new ProviderHttpError(\n    provider, status, code, LEGACY_AUTH_HINT.test(`${provider} ${status}: ${raw}`)\n  );\n}\n\nasync function providerHttpError(provider: string, res: Response): Promise<ProviderHttpError> {\n  let raw = \"\";\n  try {\n    raw = await res.text();\n  } catch {\n    /* unreadable body: status only */\n  }\n  return providerErrorFromBody(provider, res.status, raw);\n}\n\n/** Fixed category of a thrown fetch/runtime error; never its text. */\nfunction fetchErrorCategory(e: unknown): \"timeout\" | \"network\" | \"bad_response\" | \"unknown\" {\n  try {\n    const n = typeof e === \"object\" && e !== null ? (e as { name?: unknown }).name : undefined;\n    const c = typeof e === \"object\" && e !== null ? (e as { code?: unknown }).code : undefined;\n    if (n === \"AbortError\" || n === \"TimeoutError\" || (typeof c === \"string\" && /TIMEOUT/i.test(c))) {\n      return \"timeout\";\n    }\n    if (n === \"SyntaxError\") return \"bad_response\";\n    if (n === \"TypeError\" || (typeof c === \"string\" && /^E[A-Z]+$/.test(c))) return \"network\";\n  } catch {\n    /* hostile error object */\n  }\n  return \"unknown\";\n}\n\n/** fetch threw (no response). Message is FIXED: provider + category. */\nclass ProviderNetworkError extends Error {\n  readonly provider: string;\n  readonly category: string;\n  constructor(provider: string, category: string) {\n    super(`${provider} network error (${category})`);\n    this.name = \"ProviderNetworkError\";\n    this.provider = provider;\n    this.category = category;\n  }\n}\n\nconst SAFE_ERROR_NAMES = new Set([\n  \"Error\", \"TypeError\", \"SyntaxError\", \"RangeError\", \"ReferenceError\",\n  \"AbortError\", \"TimeoutError\", \"WaAuthError\", \"AccountTokenUnavailableError\",\n  \"SafeFetchError\", \"FlowRoutingUnavailableError\",\n]);\n\n/** Log fields for any caught error: never e.message, stack, cause or the object. */\nfunction safeErrorLog(e: unknown): Record<string, unknown> {\n  if (e instanceof ProviderHttpError) {\n    return { provider: e.provider, status: e.status, code: e.code };\n  }\n  if (e instanceof ProviderNetworkError) {\n    return { provider: e.provider, category: e.category };\n  }\n  let name: string | undefined;\n  try {\n    const n = typeof e === \"object\" && e !== null ? (e as { name?: unknown }).name : undefined;\n    if (typeof n === \"string\" && SAFE_ERROR_NAMES.has(n)) name = n;\n  } catch {\n    /* hostile error object */\n  }\n  return { category: fetchErrorCategory(e), name: name ?? \"unknown\" };\n}\n\n/** Client-facing text: fixed provider messages; our own plain Error texts\n * (Arabic user messages) unchanged; fetch/runtime errors -> fallback. */\nfunction clientErrorMessage(e: unknown, fallback: string): string {\n  if (e instanceof ProviderHttpError || e instanceof ProviderNetworkError) return e.message;\n  if (e instanceof WaAuthError || e instanceof AccountTokenUnavailableError) return e.message;\n  // safeFetch.ts SafeFetchError (URL import): fixed Arabic text + [code] by\n  // construction; matched by name (its import line is pinned unchanged).\n  if (e instanceof Error && e.name === \"SafeFetchError\") return e.message;\n  if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype && e.name === \"Error\") {\n    return e.message;\n  }\n  return fallback;\n}\n\n/**\n",
    "\n/**\n"],
   // Stage 6 hardening: fetchRetry logs a fixed category, throws a fixed-message ProviderNetworkError (never the error object; it embeds the URL).
   ["    } catch (e) {\n      // Stage 6: fixed category only; the error text embeds the request URL.\n      const category = fetchErrorCategory(e);\n      console.warn(\n        `[ai] network error, attempt ${i + 1}/${attempts}`,\n        { category }\n      );\n\n      if (i === attempts - 1) throw new ProviderNetworkError(\"ai\", category);\n    }\n",
    "    } catch (e) {\n      console.warn(\n        `[ai] network error, attempt ${i + 1}/${attempts}`,\n        e\n      );\n\n      if (i === attempts - 1) throw e;\n    }\n"],
   // Stage 6 hardening: Gemini key in the x-goog-api-key header, URL without ?key=.
   ["  if (key.startsWith(\"AIza\")) {\n    // Stage 6: the key travels in the x-goog-api-key header, never in the URL.\n    const res = await fetchRetry(\n      \"https://generativelanguage.googleapis.com/v1/models/text-embedding-004:batchEmbedContents\",\n      {\n        method: \"POST\",\n        headers: { \"content-type\": \"application/json\", \"x-goog-api-key\": key },\n        body: JSON.stringify({\n",
    "  if (key.startsWith(\"AIza\")) {\n    const res = await fetchRetry(\n      `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:batchEmbedContents?key=${key}`,\n      {\n        method: \"POST\",\n        headers: { \"content-type\": \"application/json\" },\n        body: JSON.stringify({\n"],
   // Stage 6 hardening: Gemini embedding error = provider/status/code, no body.
   ["    );\n    if (!res.ok) throw await providerHttpError(\"Gemini embedding\", res);\n    const j = await res.json();\n",
    "    );\n    if (!res.ok) throw new Error(`Gemini embedding ${res.status}: ${await res.text()}`);\n    const j = await res.json();\n"],
   // Stage 6 hardening: OpenAI embedding error = provider/status/code, no body.
   ["  );\n  if (!res.ok) throw await providerHttpError(\"OpenAI embedding\", res);\n  const j = await res.json();\n",
    "  );\n  if (!res.ok) throw new Error(`OpenAI embedding ${res.status}: ${await res.text()}`);\n  const j = await res.json();\n"],
   // Stage 6 hardening: chat (llm) error = provider/status/code, no body.
   ["  if (!res.ok) {\n    throw await providerHttpError(\"llm\", res);\n  }\n",
    "  if (!res.ok) {\n    throw new Error(\n      `llm ${res.status}: ${await res.text()}`\n    );\n  }\n"],
   // Stage 6 hardening: sendWa no longer keeps Meta's free-text message.
   ["    let code: number | undefined;\n\n",
    "    let code: number | undefined;\n    let fbMessage = \"\";\n\n"],
   // Stage 6 hardening: sendWa no longer reads error.message.
   ["      code = parsed?.error?.code;\n    } catch {\n",
    "      code = parsed?.error?.code;\n      fbMessage = parsed?.error?.message ?? \"\";\n    } catch {\n"],
   // Stage 6 hardening: [wa] auth failure log = status + validated code only.
   ["    ) {\n      // Stage 6: status + validated code only, never Meta's free text.\n      console.error(\"[wa] auth failure\", {\n        status: res.status,\n        code: safeProviderCode(code),\n      });\n\n",
    "    ) {\n      console.error(\n        `[wa] auth failure (code ${code}): ${fbMessage}`\n      );\n\n"],
   // Stage 6 hardening: wa send error = provider/status/code, no body.
   ["\n    throw providerErrorFromBody(\"wa send\", res.status, raw);\n  }\n",
    "\n    throw new Error(`wa send ${res.status}: ${raw}`);\n  }\n"],
   // Stage 6 hardening: Meta send error = provider/status/code, no body.
   ["  if (!res.ok) {\n    throw await providerHttpError(`${channel} send`, res);\n  }\n",
    "  if (!res.ok) {\n    throw new Error(\n      `${channel} send ${res.status}: ${await res.text()}`\n    );\n  }\n"],
   // Stage 6 hardening: sender-profile step log = fixed category only.
   ["              }\n            } catch (e: unknown) {\n              // Stage 6: fixed category only (no error text / object).\n              console.warn(\n                \"[instagram_webhook] sender profile step skipped\",\n                { category: fetchErrorCategory(e) }\n              );\n",
    "              }\n            } catch (e: any) {\n              console.warn(\n                `[instagram_webhook] sender profile step skipped: ${e?.message ?? e}`\n              );\n"],
   // Stage 6 hardening: reply caller keeps the 502/400 branch (authHint), safe client text.
   ["\n          // Stage 6: same 502/400 branch as before (provider errors carry the\n          // old body-based hint); the client only sees a safe message.\n          const msg =\n            e instanceof Error ? e.message : \"فشل الإرسال\";\n          const safeMsg = clientErrorMessage(e, \"فشل الإرسال\");\n\n          if (\n            e instanceof ProviderHttpError\n              ? e.authHint\n              : /توكن|token|auth|190/i.test(msg)\n          ) {\n            return err(safeMsg, 502);\n          }\n\n          return err(safeMsg, 400);\n        }\n",
    "\n          const msg =\n            e instanceof Error ? e.message : \"فشل الإرسال\";\n\n          if (/توكن|token|auth|190/i.test(msg)) {\n            return err(msg, 502);\n          }\n\n          return err(msg, 400);\n        }\n"],
   // Stage 6 hardening: [unresolved] send failed logs safe fields, not the error object.
   ["                \"[unresolved] send failed\",\n                safeErrorLog(e)\n              );\n",
    "                \"[unresolved] send failed\",\n                e\n              );\n"],
   // Stage 6 hardening: unresolved caller keeps the 502/400 branch (authHint), safe client text.
   ["\n              // Stage 6: same 502/400 branch as before; safe client message.\n              const msg =\n                e instanceof Error ? e.message : \"فشل الإرسال\";\n              const safeMsg = clientErrorMessage(e, \"فشل الإرسال\");\n\n              if (\n                e instanceof ProviderHttpError\n                  ? e.authHint\n                  : /توكن|token|auth|190/i.test(msg)\n              ) {\n                return err(safeMsg, 502);\n              }\n\n              return err(safeMsg, 400);\n            }\n",
    "\n              const msg =\n                e instanceof Error ? e.message : \"فشل الإرسال\";\n\n              if (/توكن|token|auth|190/i.test(msg)) {\n                return err(msg, 502);\n              }\n\n              return err(msg, 400);\n            }\n"],
   // Stage 6 hardening: Moyasar 502 = provider/status/code, no body.
   ["        if (!res.ok) {\n          // Stage 6: status + validated code only, never Moyasar's body.\n          return err(\n            (await providerHttpError(\"Moyasar\", res)).message,\n            502\n",
    "        if (!res.ok) {\n          return err(\n            `Moyasar ${res.status}: ${await res.text()}`,\n            502\n"],
   // Stage 6 hardening: top-level handler logs safe fields, not the error object.
   ["  } catch (e) {\n    // Stage 6: safe fields only (provider/status/code or a fixed category).\n    console.error(\n      `[milan-api:${action}]`,\n      safeErrorLog(e)\n    );\n",
    "  } catch (e) {\n    console.error(\n      `[milan-api:${action}]`,\n      e\n    );\n"],
   // Stage 6 hardening: top-level 500 text via clientErrorMessage (own Error texts kept; fetch/runtime errors generic).
   ["    return err(\n      clientErrorMessage(e, \"خطأ داخلي\"),\n      500\n",
    "    return err(\n      e instanceof Error\n        ? e.message\n        : \"خطأ داخلي\",\n      500\n"],
   // Flow-part2 stage 5 (fetchSenderProfile log safety; the request URL carries
   // access_token=): exactly these hunks, undone FIRST so every older entry
   // below matches unchanged. Covered by tests/milan-profile-fetch-log-safety.test.ts.
   // Stage 5: !res.ok comment names what is (not) logged; errMsg dropped.
   ["    if (!res.ok) {\n      // سجل آمن: HTTP status + sanitized Meta error code فقط.\n      // No free-text error message (Meta can echo the access token, e.g.\n      // \"Malformed access token ...\"), no senderId (customer identifier),\n      // no URL (it carries access_token=). The code is kept only if it is a\n      // number or a short [A-Za-z0-9_.-] string; anything else is omitted.\n      let errCode: unknown;\n      try {\n",
    "    if (!res.ok) {\n      // سجل آمن: HTTP status + error code + error message فقط.\n      // لا نطبع التوكن (موجود في URL الطلب وليس في الاستجابة).\n      let errCode: unknown;\n      let errMsg: string | undefined;\n      try {\n"],
   // Stage 5: no free-text Meta error message is read any more.
   ["        errCode = ej?.error?.code ?? ej?.code ?? ej?.error_type;\n      } catch {\n",
    "        errCode = ej?.error?.code ?? ej?.code ?? ej?.error_type;\n        errMsg = ej?.error?.message ?? ej?.error_message ?? ej?.message;\n      } catch {\n"],
   // Stage 5: !res.ok log = status + sanitized code only (no senderId/message).
   ["      }\n      const code =\n        typeof errCode === \"number\" && Number.isFinite(errCode)\n          ? errCode\n          : typeof errCode === \"string\" && /^[A-Za-z0-9_.-]{1,40}$/.test(errCode)\n          ? errCode\n          : undefined;\n      console.warn(\"[fetchSenderProfile] http_error\", { status: res.status, code });\n      return { name: null, avatar: null };\n",
    "      }\n      console.warn(\n        `[fetchSenderProfile] HTTP ${res.status} for ${senderId}`,\n        { code: errCode, message: errMsg }\n      );\n      return { name: null, avatar: null };\n"],
   // Stage 5: catch logs a fixed category only (never e.message / the error object).
   ["    return { name, avatar };\n  } catch (e: unknown) {\n    // Fixed category only. Never the error text, stack, cause or object: a\n    // fetch network error embeds the request URL, which carries access_token=.\n    let category = \"unknown\";\n    try {\n      const n = typeof e === \"object\" && e !== null ? (e as { name?: unknown }).name : undefined;\n      const c = typeof e === \"object\" && e !== null ? (e as { code?: unknown }).code : undefined;\n      if (n === \"AbortError\" || n === \"TimeoutError\" || (typeof c === \"string\" && /TIMEOUT/i.test(c))) {\n        category = \"timeout\";\n      } else if (n === \"SyntaxError\") {\n        category = \"bad_response\";\n      } else if (n === \"TypeError\" || (typeof c === \"string\" && /^E[A-Z]+$/.test(c))) {\n        category = \"network\";\n      }\n    } catch {\n      /* hostile error object: keep \"unknown\" */\n    }\n    console.warn(\"[fetchSenderProfile] failed\", { category });\n    return { name: null, avatar: null };\n",
    "    return { name, avatar };\n  } catch (e: any) {\n    console.warn(\"[fetchSenderProfile] error:\", e?.message ?? e);\n    return { name: null, avatar: null };\n"],
   // Flow-part2 stages 3-4 (inbound recovery terminal markers + strict channel
   // token decrypt): exactly these hunks, undone FIRST so every older entry
   // below matches unchanged. Covered by tests/flow-inbound-recovery-terminal.test.ts,
   // tests/flow-inbound-recovery-terminal-sql.test.mjs, tests/milan-token-decrypt-strict.test.ts.
   // Stage 3 (live no-reply markers, inboundRecovery.ts markLiveNoReply): import.
   ["// B-3/B-4 opt-in recovery sweeper (default OFF) and its webhook-side lease check.\nimport { inboundRecoveryEnabled, runInboundRecovery, recoveryLeaseActive, markLiveNoReply, type LiveNoReplyReason } from \"./inboundRecovery.ts\";\nimport { acceptsFlowWorkerBearer } from \"../flowWorkerAuth.ts\";\n",
    "// B-3/B-4 opt-in recovery sweeper (default OFF) and its webhook-side lease check.\nimport { inboundRecoveryEnabled, runInboundRecovery, recoveryLeaseActive } from \"./inboundRecovery.ts\";\nimport { acceptsFlowWorkerBearer } from \"../flowWorkerAuth.ts\";\n"],
   // Stage 4 (token decrypt hardening): decryptField logs a fixed code only
   // (no ciphertext prefix, no error text); still lenient for display fields.
   ["    return dec.decode(pt);\n  } catch {\n    // Fixed reason code only: never any part of the ciphertext, ids or names.\n    // Lenient by design (display fields keep the placeholder); channel access\n    // tokens use decryptAccessTokenStrict instead.\n    console.error(\"[decryptField] decryption_failed\");\n    return \"[رسالة غير قابلة للقراءة]\";\n",
    "    return dec.decode(pt);\n  } catch (e) {\n    console.error(\"[decryptField] Decryption failed for value:\", stored.substring(0, 30), (e as Error)?.message);\n    return \"[رسالة غير قابلة للقراءة]\";\n"],
   // Stage 4: AccountTokenUnavailableError + decryptAccessTokenStrict (new,
   // additive; built on decryptFieldStrict).
   ["\n/**\n * Typed failure of decryptAccessTokenStrict: the channel ACCESS TOKEN is\n * missing, undecryptable or empty. Callers make NO provider request.\n */\nclass AccountTokenUnavailableError extends Error {\n  readonly code = \"token_unavailable\";\n  constructor() {\n    super(\"token_unavailable\");\n    this.name = \"AccountTokenUnavailableError\";\n  }\n}\n\n/**\n * STRICT decryption for channel ACCESS TOKENS sent to Meta (DM send, profile\n * fetch). decryptField is lenient (returns a display placeholder on failure),\n * which must never be sent to Meta as a token. Any decrypt failure or empty\n * result THROWS AccountTokenUnavailableError. A legacy value without the\n * \"enc:v1:\" prefix is returned unchanged, exactly as decryptField did.\n * Logs nothing (callers log the fixed code \"token_unavailable\" only).\n */\nasync function decryptAccessTokenStrict(\n  stored: string | null | undefined\n): Promise<string> {\n  if (typeof stored !== \"string\" || stored.length === 0) {\n    throw new AccountTokenUnavailableError();\n  }\n  let token: string;\n  if (!stored.startsWith(\"enc:v1:\")) {\n    token = stored;\n  } else {\n    try {\n      token = await decryptFieldStrict(stored);\n    } catch {\n      throw new AccountTokenUnavailableError();\n    }\n  }\n  if (!token.trim()) throw new AccountTokenUnavailableError();\n  return token;\n}\n\n/* ═══════════════════════════════════════════════════════════════════════\n",
    "\n/* ═══════════════════════════════════════════════════════════════════════\n"],
   // Stage 4: sendToConversation docstring names the strict token decrypt.
   [" * - instagram / facebook → sendMetaDirectMessage\n *   (توكن الحساب المشفّر في channel_accounts عبر fetchAccountWithToken + decryptAccessTokenStrict)\n */\n",
    " * - instagram / facebook → sendMetaDirectMessage\n *   (توكن الحساب المشفّر في channel_accounts عبر fetchAccountWithToken + decryptField)\n */\n"],
   // Stage 4: sendToConversation WhatsApp-fallback token -> strict decrypt.
   ["      if (account.access_token_encrypted) {\n        // Strict: an undecryptable token is never sent to Meta.\n        token = await decryptAccessTokenStrict(account.access_token_encrypted);\n      }\n    } catch {\n      console.warn(\"[sendToConversation] token_unavailable\");\n    }\n",
    "      if (account.access_token_encrypted) {\n        token = await decryptField(account.access_token_encrypted);\n      }\n    } catch (e) {\n      console.warn(\"[sendToConversation] token decrypt failed\", e);\n    }\n"],
   // Stage 4: sendToConversation Meta DM token -> strict decrypt, clear error.
   ["\n    // Strict: an undecryptable/empty token fails clearly (no request to Meta).\n    let token: string;\n    try {\n      token = await decryptAccessTokenStrict(\n        account.access_token_encrypted\n      );\n    } catch {\n      console.warn(\"[sendToConversation] token_unavailable\");\n      throw new Error(\n        `لا يوجد توكن محفوظ لحساب ${channel} — أعد ربط الحساب`\n      );\n    }\n\n",
    "\n    const token = await decryptField(\n      account.access_token_encrypted\n    );\n\n"],
   // Stage 3: liveNoReply closure (live deliveries only; never a re-drive).
   ["  };\n  // Deliberate no-reply exit of a LIVE delivery (never a re-drive: those are\n  // resolved above / by the sweeper itself): mark the persisted event\n  // terminal so the opt-in recovery sweeper never answers it late\n  // (inboundRecovery.ts markLiveNoReply). Best effort; the result is ignored\n  // and never changes this exit.\n  const liveNoReply = async (reason: LiveNoReplyReason, conversationId: string, inboundId: string | null) => {\n    if (redrive || !inboundId) return;\n    await markLiveNoReply(sb, { ...retryKey, conversationId: String(conversationId), inboundId }, reason);\n  };\n\n",
    "  };\n\n"],
   // Stage 3: marker before the transferred (human takeover) exit.
   ["      `[${channel}_webhook] conversation transferred: ${conv.id}`\n    );\n    await liveNoReply(\"live_human_takeover\", conv.id, inboundMessageId);\n    await resolvedAfterRedrive();\n",
    "      `[${channel}_webhook] conversation transferred: ${conv.id}`\n    );\n    await resolvedAfterRedrive();\n"],
   // Stage 3: marker before the paused (credits) exit.
   ["      `[${channel}_webhook] paused (credits): ${conv.id}`\n    );\n    await liveNoReply(\"live_credits_paused\", conv.id, inboundMessageId);\n    await resolvedAfterRedrive();\n",
    "      `[${channel}_webhook] paused (credits): ${conv.id}`\n    );\n    await resolvedAfterRedrive();\n"],
   // Stage 3: marker before the auto-reply-disabled exit.
   ["      `[${channel}_webhook] auto reply disabled for account ${account?.id}`\n    );\n    await liveNoReply(\"live_auto_reply_off\", conv.id, inboundMessageId);\n    await resolvedAfterRedrive();\n",
    "      `[${channel}_webhook] auto reply disabled for account ${account?.id}`\n    );\n    await resolvedAfterRedrive();\n"],
   // Stage 3: marker before the no-credits exit.
   ["      `[${channel}_webhook] no credits: ${tenantId}`\n    );\n    await liveNoReply(\"live_no_credits\", conv.id, inboundMessageId);\n    await resolvedAfterRedrive();\n",
    "      `[${channel}_webhook] no credits: ${tenantId}`\n    );\n    await resolvedAfterRedrive();\n"],
   // Stage 4: V2 claimed-send token -> strict decrypt BEFORE sendMetaDirectMessage
   // (the send call itself, its arguments and the claim outcome are unchanged).
   ["      if (!account.access_token_encrypted) throw new Error(\"missing account token\");\n      // Strict: an undecryptable/empty token throws BEFORE any request to\n      // Meta (never a placeholder token). Outcome stays \"send_failed\"\n      // (claim semantics unchanged) with the fixed reason code below.\n      let token: string;\n      try {\n        token = await decryptAccessTokenStrict(account.access_token_encrypted);\n      } catch (e) {\n        console.warn(\"[webhook-claim] account token unavailable; no provider request\", { code: \"token_unavailable\" });\n        throw e;\n      }\n      if (!token) throw new Error(\"empty account token\");\n",
    "      if (!account.access_token_encrypted) throw new Error(\"missing account token\");\n      const token = await decryptField(account.access_token_encrypted);\n      if (!token) throw new Error(\"empty account token\");\n"],
   // Stage 4: Instagram profile fetch token -> strict decrypt; log has no account id.
   ["              if (account.access_token_encrypted) {\n                // Strict: an undecryptable token skips the profile fetch\n                // (senderToken stays null -> no request to Meta).\n                try {\n                  senderToken = await decryptAccessTokenStrict(\n                    account.access_token_encrypted\n                  );\n                } catch {\n                  console.warn(\n                    \"[instagram_webhook] token_unavailable; profile fetch skipped\"\n                  );\n",
    "              if (account.access_token_encrypted) {\n                try {\n                  senderToken = await decryptField(\n                    account.access_token_encrypted\n                  );\n                } catch (e: any) {\n                  console.warn(\n                    `[instagram_webhook] token decrypt failed | account=${account.id}`\n                  );\n"],
   // Flow-claim-then-silence / recovery round: E1 proven WhatsApp account
   // (waBinding.ts provenWhatsappAccount + the account_unproven guard), E4
   // per-event batch isolation (runBatchEvent), E5 no plaintext customer name
   // in the fetchSenderProfile log, B-3/B-4 opt-in recovery tick
   // (inboundRecovery.ts, decryptFieldStrict, recovery lease check; migration
   // 20261029360000). Exactly these hunks, undone FIRST so every older entry
   // below matches unchanged. Covered by tests/flow-channel-reliability.test.mjs,
   // tests/flow-inbound-recovery.test.ts, tests/security-wa-unverified-batch.test.mjs.
   ["  isRetryableOutcome, retryAttemptCap, runBatchEvent } from \"./inboundRoutingRetry.ts\";\n// B-3/B-4 opt-in recovery sweeper (default OFF) and its webhook-side lease check.\nimport { inboundRecoveryEnabled, runInboundRecovery, recoveryLeaseActive } from \"./inboundRecovery.ts\";\nimport { acceptsFlowWorkerBearer } from \"../flowWorkerAuth.ts\";\n",
    "  isRetryableOutcome, retryAttemptCap } from \"./inboundRoutingRetry.ts\";\n"],
   ["import { bindingIsVerified, readBindingVerified, provenWhatsappAccount } from \"./waBinding.ts\";\n",
    "import { bindingIsVerified, readBindingVerified } from \"./waBinding.ts\";\n"],
   ["/**\n * STRICT field decryption for the inbound recovery sweeper only: THROWS on a\n * legacy plaintext value or any decryption failure (decryptField returns a\n * placeholder instead, which must never be replayed as customer text). Logs\n * nothing; the result lives in memory only.\n */\nasync function decryptFieldStrict(stored: string): Promise<string> {\n  if (typeof stored !== \"string\" || !stored.startsWith(\"enc:v1:\")) {\n    throw new Error(\"not an encrypted field\");\n  }\n  const [, , ivH, tagH, dataH] = stored.split(\":\");\n  const fromHex = (h: string) => {\n    if (typeof h !== \"string\" || !/^(?:[0-9a-f]{2})+$/i.test(h)) throw new Error(\"bad hex\");\n    return Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));\n  };\n  const data = fromHex(dataH);\n  const tag = fromHex(tagH);\n  const buf = new Uint8Array(data.length + 16);\n  buf.set(data, 0);\n  buf.set(tag, data.length);\n  const pt = await crypto.subtle.decrypt(\n    { name: \"AES-GCM\", iv: fromHex(ivH) as BufferSource },\n    await aesKey(\"decrypt\"),\n    buf as BufferSource\n  );\n  return dec.decode(pt);\n}\n\n",
    ""],
   ["    // Privacy: the customer's name is never logged (present/missing only).\n    console.log(\"[fetchSenderProfile]\", {\n      senderId,\n      name: name ? \"present\" : \"missing\",\n",
    "    console.log(\"[fetchSenderProfile]\", {\n      senderId,\n      name,\n"],
   ["  // No PROVEN channel account (e.g. a verified WhatsApp binding whose\n  // channel_accounts row could not be proven, see provenWhatsappAccount):\n  // flow_claim_inbound refuses a NULL account, so no claim and no reply are\n  // possible. Known terminal state, logged with a code (not a retry loop).\n  if (typeof account?.id !== \"string\" || account.id.length === 0) {\n    console.warn(\"[webhook-claim] no proven channel account; no auto-send\", { code: \"account_unproven\" });\n    await resolvedAfterRedrive();\n    return;\n  }\n\n",
    ""],
   ["            if (binding) {\n              // E1 (waBinding.ts provenWhatsappAccount): the binding proves\n              // the tenant only. Its channel_accounts row (and so the account\n              // id the exclusive claim needs) is used ONLY when proven: same\n              // tenant, whatsapp, external_id == this phone number id, active,\n              // exactly one row. Otherwise the event is stored without an\n              // automatic reply (code logged), never assigned to a guess.\n              const proven = await provenWhatsappAccount(sb, String(binding.tenant_id), phoneId);\n              if (proven.status === \"proven\" && proven.account.tenant_id === binding.tenant_id) {\n                account = proven.account;\n              } else {\n                console.warn(\"[whatsapp_webhook] binding account unproven\", { code: \"wa_account_\" + proven.status });\n                account = {\n                  tenant_id: binding.tenant_id,\n                  external_id: phoneId,\n                  channel: \"whatsapp\",\n                };\n              }\n            } else {",
    "            if (binding) {\n              account = {\n                tenant_id: binding.tenant_id,\n                external_id: phoneId,\n                channel: \"whatsapp\",\n              };\n            } else {"],
   ["                  if (pending) {\n                    // The opt-in recovery sweeper holds a lease on this event\n                    // (inboundRecovery.ts): never re-drive it concurrently;\n                    // 503 and let the provider redeliver.\n                    if (await recoveryLeaseActive(sb, { tenantId: String(account.tenant_id), inboundId: pending.inboundId })) {\n                      waOutcomes.push(\"retry\");\n                      continue;\n                    }\n                    waOutcomes.push(await runBatchEvent(() => handleIncomingWebhookMessage(\n                      sb, account, chatId,\n                      durableReply && !text ? durableReply.text : text,\n                      msgId, \"whatsapp\", phoneId,\n                      durableReplies ? durableReply?.choiceId ?? null : undefined,\n                      durableReplies ? typeof msgId === \"string\" && msgId.length > 0 : undefined,\n                      pending\n                    )));",
    "                  if (pending) {\n                    waOutcomes.push(await handleIncomingWebhookMessage(\n                      sb, account, chatId,\n                      durableReply && !text ? durableReply.text : text,\n                      msgId, \"whatsapp\", phoneId,\n                      durableReplies ? durableReply?.choiceId ?? null : undefined,\n                      durableReplies ? typeof msgId === \"string\" && msgId.length > 0 : undefined,\n                      pending\n                    ));"],
   ["              // runBatchEvent: an event that throws never aborts the batch;\n              // every event is processed before the status is chosen.\n              waOutcomes.push(await runBatchEvent(() => handleIncomingWebhookMessage(\n                sb,\n",
    "              waOutcomes.push(await handleIncomingWebhookMessage(\n                sb,\n"],
   ["                durableReplies ? typeof msgId === \"string\" && msgId.length > 0 : undefined\n              )));\n",
    "                durableReplies ? typeof msgId === \"string\" && msgId.length > 0 : undefined\n              ));\n"],
   ["                if (pending) {\n                  // Never concurrently with the recovery sweeper's lease.\n                  if (await recoveryLeaseActive(sb, { tenantId: String(account.tenant_id), inboundId: pending.inboundId })) {\n                    igOutcomes.push(\"retry\");\n                    continue;\n                  }\n                  igOutcomes.push(await runBatchEvent(() => handleIncomingWebhookMessage(\n                    sb, account, chatId, msg.text, msgId,\n                    channel as \"instagram\" | \"facebook\",\n                    undefined, msg.choiceId, providerEventIdGenuine, pending\n                  )));",
    "                if (pending) {\n                  igOutcomes.push(await handleIncomingWebhookMessage(\n                    sb, account, chatId, msg.text, msgId,\n                    channel as \"instagram\" | \"facebook\",\n                    undefined, msg.choiceId, providerEventIdGenuine, pending\n                  ));"],
   ["            // runBatchEvent: an event that throws never aborts the batch.\n            igOutcomes.push(await runBatchEvent(() => handleIncomingWebhookMessage(\n              sb,\n",
    "            igOutcomes.push(await handleIncomingWebhookMessage(\n              sb,\n"],
   ["              providerEventIdGenuine\n            )));\n",
    "              providerEventIdGenuine\n            ));\n"],
   ["          // A comment-ingest exception no longer aborts the remaining entries\n          // (it used to answer 500); it is a transient outcome (503) instead.\n          if (commentAutomationEnabled()) {\n            igOutcomes.push(await runBatchEvent(async () => {\n              await ingestSignedComments(sb, body.object, entry, {\n                env, encrypt: encryptField,\n              });\n            }));\n          }",
    "          if (commentAutomationEnabled()) {\n            await ingestSignedComments(sb, body.object, entry, {\n              env, encrypt: encryptField,\n            });\n          }"],
   ["      /* ────────────────────────────────────────────────────────────────\n         B-3/B-4 inbound recovery tick (inboundRecovery.ts, migration\n         20261029360000). Server-to-server only; DEFAULT OFF.\n         POST ?action=inbound_recovery_tick  body {\"mode\":\"tick\"}\n         Auth first: the SAME bearer rule as the flow workers\n         (flowWorkerAuth.ts; unchanged). Then FLOW_INBOUND_RECOVERY_ENABLED\n         + the worker release gate (423 while off), then only opted-in\n         tenants (automation_inbound_recovery_tenants, default none).\n         Re-drives through handleIncomingWebhookMessage (same claim/route).\n         Response: counters only (no ids, no text).\n      ──────────────────────────────────────────────────────────────── */\n      case \"inbound_recovery_tick\": {\n        if (req.method !== \"POST\") {\n          return json({ error: \"Method not allowed\" }, 405);\n        }\n        if (!acceptsFlowWorkerBearer(\n          req.headers.get(\"authorization\"),\n          env(\"SUPABASE_SERVICE_ROLE_KEY\"),\n          env(\"flow_worker_service_role_key\")\n        )) {\n          return json({ error: \"Unauthorized\" }, 401);\n        }\n        if (!inboundRecoveryEnabled((k) => Deno.env.get(k))) {\n          return json({ status: \"disabled\" }, 423);\n        }\n        if (body?.mode !== \"tick\") {\n          return json({ error: \"Invalid mode\" }, 400);\n        }\n        const counters = await runInboundRecovery(sb, {\n          decrypt: decryptFieldStrict,\n          redrive: (e) => handleIncomingWebhookMessage(\n            sb, e.account, e.chatId, e.text, e.eventId, e.channel, e.phoneId,\n            null, true, { conversationId: e.conversationId, inboundId: e.inboundId }\n          ),\n        });\n        return json({ status: \"ok\", counters });\n      }\n\n",
    ""],
   // Several active flows per account (flowInboundSelection.ts, Part 1) and
   // retryable inbound processing when flow eligibility is unknown
   // (inboundRoutingRetry.ts, migration 20261029340000): exactly these hunks,
   // undone FIRST so the older entries below match unchanged. Covered by
   // tests/flow-multi-active-selection.test.ts and tests/flow-inbound-retry.test.ts.
   ["import { processExclusiveEvent } from \"./exclusiveMessageClaim.ts\";\nimport { recordRoutingFailure, markRoutingResolved, retryableEvent, webhookStatusFor,\n  isRetryableOutcome, retryAttemptCap } from \"./inboundRoutingRetry.ts\";\nimport { syntheticEventId } from \"./syntheticEventId.ts\";\nimport { prepareSimpleFlowReply } from \"./flowPrepareMessage.ts\";\n",
    "import { processExclusiveEvent } from \"./exclusiveMessageClaim.ts\";\nimport { prepareSimpleFlowReply } from \"./flowPrepareMessage.ts\";\n"],
   ["import { prepareSimpleFlowReply } from \"./flowPrepareMessage.ts\";\nimport {attemptDurableInstagram,selectedFlowChoice,multichannelEnabled,\n  durableIngressConfigured,supportedDurableDocument} from \"./flowDurableIngress.ts\";\nimport { normalizeMetaMessages } from \"./normalizeMetaMessage.ts\";\n",
    "import { prepareSimpleFlowReply } from \"./flowPrepareMessage.ts\";\nimport {attemptDurableInstagram,selectedFlowChoice,multichannelEnabled} from \"./flowDurableIngress.ts\";\nimport { normalizeMetaMessages } from \"./normalizeMetaMessage.ts\";\n"],
   ["  choiceId: string | null;\n  timestamp: number | null;\n}> {\n",
    "  choiceId: string | null;\n}> {\n"],
   ["    choiceId: string | null;\n    /** The event's own timestamp (ms), only for a deterministic id when `mid` is missing. */\n    timestamp: number | null;\n  }> = [];\n",
    "    choiceId: string | null;\n  }> = [];\n"],
   ["          choiceId:selectedFlowChoice(ev.message),\n          timestamp: Number.isSafeInteger(ev.timestamp) ? ev.timestamp : null,\n        });\n",
    "          choiceId:selectedFlowChoice(ev.message),\n        });\n"],
   ["              choiceId:selectedFlowChoice(ev.message),\n              timestamp: Number.isSafeInteger(ev.timestamp) ? ev.timestamp : null,\n            });\n",
    "              choiceId:selectedFlowChoice(ev.message),\n            });\n"],
   ["            choiceId:selectedFlowChoice(value.message),\n            timestamp: Number.isSafeInteger(value.timestamp) ? value.timestamp : null,\n          });\n",
    "            choiceId:selectedFlowChoice(value.message),\n          });\n"],
   ["  selectedChoiceId?: string | null,\n  providerEventIdGenuine?: boolean,\n  // Re-drive of an already persisted event whose flow lookup failed before\n  // (inboundRoutingRetry.ts): the SAME inbound row and conversation are used,\n  // nothing is inserted again. Only set by the duplicate pre-check below.\n  redrive?: { conversationId: string; inboundId: string }\n): Promise<\"retry\" | void> {\n  const tenantId: string =\n",
    "  selectedChoiceId?: string | null,\n  providerEventIdGenuine?: boolean\n) {\n  const tenantId: string =\n"],
   ["\n  // Retry policy (inboundRoutingRetry.ts, migration 20261029340000):\n  //  * UNKNOWN state (read error, unconfirmed claim, flow eligibility unknown)\n  //    -> no flow and no AI; a persisted event is kept 'retrying' (webhook 503,\n  //    provider redelivery re-drives it); an event not yet persisted is simply\n  //    answered 503 (the redelivery is processed as new). Bounded: the last\n  //    attempt marks the row 'exhausted' (terminal, observable).\n  //  * KNOWN TERMINAL outcome -> a re-driven event is marked 'resolved'.\n  //  * Events without a Meta mid (B-5, syntheticEventId.ts) are never\n  //    retried: attempt cap 1 -> immediately 'exhausted' (observable), 200.\n  const syntheticEvent = channel !== \"whatsapp\" && providerEventIdGenuine !== true;\n  const retryKey = {\n    tenantId: String(tenantId), accountId: String(account?.id ?? \"\"),\n    platform: channel, eventId: String(externalMsgId ?? \"\"),\n  };\n  const keepRetryable = async (conversationId: string, inboundId: string): Promise<\"retry\" | void> => {\n    const decision = await recordRoutingFailure(sb, {\n      ...retryKey, conversationId, inboundId,\n    }, retryAttemptCap(syntheticEvent));\n    if (decision === \"retry\") {\n      console.warn(\"[webhook-routing] flow eligibility unknown; event kept for redelivery\");\n      return \"retry\";\n    }\n    if (decision === \"exhausted\") {\n      console.error(\"[webhook-routing] flow eligibility unknown; retries exhausted (automation_inbound_routing_retries)\");\n    } else if (decision === \"unavailable\") {\n      console.error(\"[webhook-routing] flow eligibility unknown; retry state unavailable, event not retried\");\n    }\n  };\n  // Unknown state BEFORE the inbound row exists (or in a re-drive).\n  const unknownState = async (): Promise<\"retry\" | void> =>\n    redrive ? keepRetryable(redrive.conversationId, redrive.inboundId) : \"retry\";\n  // Known terminal outcome: a re-driven event no longer needs a retry.\n  const resolvedAfterRedrive = async () => {\n    if (redrive) await markRoutingResolved(sb, retryKey);\n  };\n\n  const { data: tenant, error: tenantError } = await sb\n    .from(\"tenants\")\n",
    "\n  const { data: tenant } = await sb\n    .from(\"tenants\")\n"],
   ["\n  if (tenantError) {\n    console.error(`[${channel}_webhook] tenant read failed`);\n    return await unknownState();\n  }\n\n  if (!tenant) {\n",
    "\n  if (!tenant) {\n"],
   ["      `[${channel}_webhook] tenant not found: ${tenantId}`\n    );\n    await resolvedAfterRedrive();\n    return;\n  }\n",
    "      `[${channel}_webhook] tenant not found: ${tenantId}`\n    );\n    return;\n  }\n"],
   ["      `[${channel}_webhook] tenant inactive: ${tenantId}`\n    );\n    await resolvedAfterRedrive();\n    return;\n  }\n",
    "      `[${channel}_webhook] tenant inactive: ${tenantId}`\n    );\n    return;\n  }\n"],
   ["   */\n  const { data: existingConv, error: convError } = redrive\n    ? await sb\n        .from(\"conversations\")\n        .select(\"*\")\n        .eq(\"tenant_id\", tenantId)\n        .eq(\"id\", redrive.conversationId)\n        .eq(\"wa_chat_id\", chatId)\n        .maybeSingle()\n    : await sb\n        .from(\"conversations\")\n        .select(\"*\")\n        .eq(\"tenant_id\", tenantId)\n        .eq(\"wa_chat_id\", chatId)\n        .maybeSingle();\n\n",
    "   */\n  const { data: existingConv } = await sb\n    .from(\"conversations\")\n    .select(\"*\")\n    .eq(\"tenant_id\", tenantId)\n    .eq(\"wa_chat_id\", chatId)\n    .maybeSingle();\n\n"],
   ["  let conv: any = existingConv;\n\n  if (convError) {\n    console.error(`[${channel}_webhook] conversation read failed`);\n    return await unknownState();\n  }\n\n  if (redrive && !conv) {\n    // Proven absence (no read error): nothing left to answer.\n    console.error(`[${channel}_webhook] re-drive conversation not found`);\n    await resolvedAfterRedrive();\n    return;\n  }\n\n",
    "  let conv: any = existingConv;\n\n"],
   ["    );\n    // Not persisted yet: the provider redelivers it as a new event.\n    return \"retry\";\n  }\n",
    "    );\n    return;\n  }\n"],
   ["   */\n  let inboundMessageId: string | null = redrive ? redrive.inboundId : null;\n  const incomingResult = redrive ? \"saved\" : await persistInboundOnce(async () => {\n    const response = await sb.from(\"messages\").insert({\n",
    "   */\n  let inboundMessageId: string | null = null;\n  const incomingResult = await persistInboundOnce(async () => {\n    const response = await sb.from(\"messages\").insert({\n"],
   ["      console.error(`[${channel}_webhook] inbound insert did not commit`);\n      // Not persisted: the provider redelivers it as a new event (a commit\n      // whose response was lost is skipped as a duplicate, as before).\n      return \"retry\";\n    }\n",
    "      console.error(`[${channel}_webhook] inbound insert did not commit`);\n    }\n"],
   ["      `[${channel}_webhook] conversation transferred: ${conv.id}`\n    );\n    await resolvedAfterRedrive();\n    return;\n  }\n",
    "      `[${channel}_webhook] conversation transferred: ${conv.id}`\n    );\n    return;\n  }\n"],
   ["      `[${channel}_webhook] paused (credits): ${conv.id}`\n    );\n    await resolvedAfterRedrive();\n    return;\n  }\n",
    "      `[${channel}_webhook] paused (credits): ${conv.id}`\n    );\n    return;\n  }\n"],
   ["      `[${channel}_webhook] auto reply disabled for account ${account?.id}`\n    );\n    await resolvedAfterRedrive();\n    return;\n  }\n",
    "      `[${channel}_webhook] auto reply disabled for account ${account?.id}`\n    );\n    return;\n  }\n"],
   ["      `[${channel}_webhook] no credits: ${tenantId}`\n    );\n    await resolvedAfterRedrive();\n    return;\n  }\n",
    "      `[${channel}_webhook] no credits: ${tenantId}`\n    );\n    return;\n  }\n"],
   ["  // also try the durable path (same canary, claim and SQL re-checks).\n  // Flow eligibility UNKNOWN (switch/activation/publication READ error): no\n  // flow and no AI for this event; keep it retryable (inboundRoutingRetry.ts,\n  // migration 20261029340000) so the webhook answers 503 and the provider's\n  // redelivery re-drives it. Bounded: the last attempt marks it 'exhausted'\n  // (terminal, observable) and the webhook acknowledges.\n  if(channel===\"instagram\"||\n",
    "  // also try the durable path (same canary, claim and SQL re-checks).\n  if(channel===\"instagram\"||\n"],
   ["    });\n    if(durable===\"retry\")return await keepRetryable(String(conv.id),inboundMessageId);\n    if(durable===\"handled\"){await resolvedAfterRedrive();return;}\n  }\n",
    "    });\n    if(durable===\"handled\")return;\n  }\n"],
   ["  const deliveryTracking=env(\"DELIVERY_TRACKING_V1_ENABLED\")===\"true\";\n  // Several active flows: prepareSimpleFlowReply answers only the single\n  // deterministic winner (flowInboundSelection.ts) when it is a V2 flow. While\n  // the durable ingress is configured for this account, durable flows are\n  // ranked too, so a durable winner is never replaced by a lower V2 flow.\n  // No match -> null -> legacy AI (unchanged). A routing READ error makes\n  // processExclusiveEvent return \"routing_unavailable\": no claim, no reply.\n  const durableRanked=durableIngressConfigured(String(account.id),channel);\n  const outcome = await processExclusiveEvent({\n",
    "  const deliveryTracking=env(\"DELIVERY_TRACKING_V1_ENABLED\")===\"true\";\n  const outcome = await processExclusiveEvent({\n"],
   ["    prepareFlow: () => prepareSimpleFlowReply(\n      sb, tenantId, String(account.id), channel, customerText,\n      durableRanked?{durableDocument:(d)=>supportedDurableDocument(d,channel)}:{}\n    ),\n",
    "    prepareFlow: () => prepareSimpleFlowReply(\n      sb, tenantId, String(account.id), channel, customerText\n    ),\n"],
   ["  });\n  // No claim acquired (routing unknown, or the claim RPC failed / its commit\n  // is unknown) -> retryable: a retry re-claims (a committed claim answers\n  // \"duplicate\"), so it can never send twice. Every other outcome follows an\n  // ACQUIRED claim (the ownership proof: sent_*, send_failed, empty,\n  // delivery_unavailable) or a duplicate -> terminal, never re-sent.\n  if (isRetryableOutcome(outcome))\n    return await keepRetryable(String(conv.id), inboundMessageId);\n  await resolvedAfterRedrive();\n  if (outcome !== \"sent_and_billed\" && outcome !== \"duplicate\") {\n",
    "  });\n  if (outcome !== \"sent_and_billed\" && outcome !== \"duplicate\") {\n"],
   ["\n        // Per-event outcomes: any \"retry\" (flow eligibility unknown) answers 503\n        // so the provider redelivers (inboundRoutingRetry.ts).\n        const waOutcomes: unknown[] = [];\n        for (const entry of body.entry ?? []) {\n",
    "\n        for (const entry of body.entry ?? []) {\n"],
   ["                if (dup) {\n                  // Re-drive ONLY an event kept retryable after an unknown\n                  // flow eligibility; every other duplicate is skipped.\n                  const pending = await retryableEvent(sb, {\n                    tenantId: String(account.tenant_id), accountId: String(account.id ?? \"\"),\n                    platform: \"whatsapp\", eventId: msgId,\n                  });\n                  if (pending) {\n                    waOutcomes.push(await handleIncomingWebhookMessage(\n                      sb, account, chatId,\n                      durableReply && !text ? durableReply.text : text,\n                      msgId, \"whatsapp\", phoneId,\n                      durableReplies ? durableReply?.choiceId ?? null : undefined,\n                      durableReplies ? typeof msgId === \"string\" && msgId.length > 0 : undefined,\n                      pending\n                    ));\n                    continue;\n                  }\n                  console.log(\n",
    "                if (dup) {\n                  console.log(\n"],
   ["\n              waOutcomes.push(await handleIncomingWebhookMessage(\n                sb,\n",
    "\n              await handleIncomingWebhookMessage(\n                sb,\n"],
   ["                durableReplies ? typeof msgId === \"string\" && msgId.length > 0 : undefined\n              ));\n\n",
    "                durableReplies ? typeof msgId === \"string\" && msgId.length > 0 : undefined\n              );\n\n"],
   ["          }\n        }\n\n        if (webhookStatusFor(waOutcomes) === 503) {\n          return json({ error: \"Flow routing temporarily unavailable\" }, 503);\n        }\n",
    "          }\n        }\n"],
   ["\n        // Per-event outcomes: any \"retry\" (flow eligibility unknown) answers 503\n        // so the provider redelivers (inboundRoutingRetry.ts).\n        const igOutcomes: unknown[] = [];\n        for (const entry of body.entry ?? []) {\n",
    "\n        for (const entry of body.entry ?? []) {\n"],
   ["\n            // B-5 (syntheticEventId.ts): no Meta mid -> a deterministic id from\n            // signed payload fields (never raw text), so a redelivery maps to the\n            // same inbound row/claim key; without an event timestamp the old\n            // non-deduplicable fallback stays. Never treated as a provider id.\n            const derivedId = msg.mid\n              ? null\n              : await syntheticEventId({\n                  entryId, recipientId: msg.recipientId, senderId: msg.senderId,\n                  timestamp: \"timestamp\" in msg ? msg.timestamp : null, text: msg.text,\n                });\n            const msgId =\n",
    "\n            const msgId =\n"],
   ["            const msgId =\n              msg.mid || derivedId || `ig_${Date.now()}`;\n            // Provenance, never inferred from the id's shape: true only when\n",
    "            const msgId =\n              msg.mid || `ig_${Date.now()}`;\n            // Provenance, never inferred from the id's shape: true only when\n"],
   ["             */\n            if (msg.mid || derivedId) {\n              const { data: dup } = await sb\n",
    "             */\n            if (msg.mid) {\n              const { data: dup } = await sb\n"],
   ["              if (dup && dup.length > 0) {\n                // Re-drive ONLY an event kept retryable after an unknown\n                // flow eligibility; every other duplicate is skipped.\n                const pending = await retryableEvent(sb, {\n                  tenantId: String(account.tenant_id), accountId: String(account.id),\n                  platform: channel, eventId: msgId,\n                });\n                if (pending) {\n                  igOutcomes.push(await handleIncomingWebhookMessage(\n                    sb, account, chatId, msg.text, msgId,\n                    channel as \"instagram\" | \"facebook\",\n                    undefined, msg.choiceId, providerEventIdGenuine, pending\n                  ));\n                  continue;\n                }\n                console.log(\n",
    "              if (dup && dup.length > 0) {\n                console.log(\n"],
   ["\n            igOutcomes.push(await handleIncomingWebhookMessage(\n              sb,\n",
    "\n            await handleIncomingWebhookMessage(\n              sb,\n"],
   ["              providerEventIdGenuine\n            ));\n\n",
    "              providerEventIdGenuine\n            );\n\n"],
   ["          }\n        }\n\n        if (webhookStatusFor(igOutcomes) === 503) {\n          return json({ error: \"Flow routing temporarily unavailable\" }, 503);\n        }\n",
    "          }\n        }\n"],
   // FLOW_MULTICHANNEL_ENABLED (WhatsApp/Facebook durable ingress, default OFF): import
   ["import {attemptDurableInstagram,selectedFlowChoice,multichannelEnabled} from \"./flowDurableIngress.ts\";\nimport { normalizeMetaMessages } from \"./normalizeMetaMessage.ts\";\n",
    "import {attemptDurableInstagram,selectedFlowChoice} from \"./flowDurableIngress.ts\";\n"],
   // durable path also for whatsapp/facebook, only while the flag is on
   ["  // FLOW_MULTICHANNEL_ENABLED (default OFF): WhatsApp / Facebook events may\n  // also try the durable path (same canary, claim and SQL re-checks).\n  if(channel===\"instagram\"||\n     ((channel===\"whatsapp\"||channel===\"facebook\")&&multichannelEnabled())){\n",
    "  if(channel===\"instagram\"){\n"],
   // WhatsApp: flow-choice interactive replies of the canary account (flag ON only)
   ["            // FLOW_MULTICHANNEL_ENABLED (default OFF), and ONLY for the\n            // operator-selected durable canary account: signed interactive\n            // button replies carrying \"flow-choice:<id>\" (parsed by\n            // normalizeMetaMessage.ts) reach the durable path as their title\n            // + choice id. OFF or any other account: null, and the text-only\n            // handling below is unchanged.\n            const durableReplies =\n              multichannelEnabled() &&\n              typeof account.id === \"string\" &&\n              account.id === env(\"FLOW_DURABLE_CANARY_ACCOUNT_ID\")\n                ? new Map(\n                    normalizeMetaMessages({\n                      object: \"whatsapp_business_account\",\n                      entry: [{ changes: [change] }],\n                    })\n                      .filter((m) => m.choiceId !== null && m.providerMessageId !== null)\n                      .map((m) => [String(m.providerMessageId), m] as const)\n                  )\n                : null;\n\n            const customerNameOf = (waId: string) => {",
    "            const customerNameOf = (waId: string) => {"],
   ["              const durableReply =\n                durableReplies && msgId\n                  ? durableReplies.get(msgId) ?? null\n                  : null;\n\n              if (!text && !durableReply) {",
    "              if (!text) {"],
   ["                durableReply && !text ? durableReply.text : text,\n",
    "                text,\n"],
   ["                phoneId,\n                durableReplies ? durableReply?.choiceId ?? null : undefined,\n                durableReplies ? typeof msgId === \"string\" && msgId.length > 0 : undefined\n",
    "                phoneId\n"],
   // object=page: bad/missing signature -> 401 (Instagram object unchanged)
   ["        if (!sigOk) {\n          // Facebook Page events (object \"page\"): a missing or bad signature\n          // is rejected like WhatsApp (401), before any parsing side effect\n          // or DB access. The Instagram object keeps its behaviour below.\n          if (body.object === \"page\") {\n            console.error(\"[instagram_webhook] invalid page signature\");\n            return json({ error: \"Invalid webhook signature\" }, 401);\n          }\n\n",
    "        if (!sigOk) {\n"],
   // object=page: flow-choice postbacks (flag ON only)
   ["          // FLOW_MULTICHANNEL_ENABLED only: signed Facebook postbacks carrying\n          // \"flow-choice:<id>\" and a Meta mid (normalizeMetaMessage.ts). They\n          // are processed below ONLY for the durable canary account. OFF: [].\n          const pagePostbacks =\n            body.object === \"page\" && multichannelEnabled()\n              ? normalizeMetaMessages({ object: \"page\", entry: [entry] })\n                  .filter((m) => m.kind === \"postback\" && m.choiceId !== null &&\n                    m.providerMessageId !== null)\n                  .map((m) => ({\n                    senderId: m.senderId,\n                    recipientId: m.recipientId,\n                    text: m.text,\n                    mid: m.providerMessageId,\n                    choiceId: m.choiceId,\n                    postback: true as const,\n                  }))\n              : [];\n\n          for (const msg of [...msgs, ...pagePostbacks]) {",
    "          for (const msg of msgs) {"],
   // object=page: facebook-only account lookup, ambiguous page id ignored
   ["            let account: any = null;\n            // Facebook Page events: a channel='facebook' account ONLY (never\n            // an Instagram one); a page id shared by several accounts (e.g.\n            // several tenants) is never assigned to one of them: ignored.\n            let ambiguousPage = false;\n",
    "            let account: any = null;\n"],
   ["            for (const candidate of candidates) {\n              if (body.object === \"page\") {\n                const { data: pageAccounts } = await sb\n                  .from(\"channel_accounts\")\n                  .select(\n                    \"id, tenant_id, channel, external_id, status, agent_enabled, auto_reply, access_token_encrypted\"\n                  )\n                  .eq(\"external_id\", candidate)\n                  .eq(\"channel\", \"facebook\")\n                  .limit(2);\n\n                if (Array.isArray(pageAccounts) && pageAccounts.length > 1) {\n                  ambiguousPage = true;\n                  break;\n                }\n\n                if (Array.isArray(pageAccounts) && pageAccounts.length === 1) {\n                  account = pageAccounts[0];\n                  break;\n                }\n\n                continue;\n              }\n\n",
    "            for (const candidate of candidates) {\n"],
   ["            if (ambiguousPage) {\n              console.warn(\n                \"[instagram_webhook] page id matches several accounts — event ignored\"\n              );\n              continue;\n            }\n\n            if (!account) {\n",
    "            if (!account) {\n"],
   // postbacks only for the durable canary account
   ["            // Postbacks (flag ON only) reach the durable canary account only.\n            if (\"postback\" in msg &&\n                String(account.id) !== env(\"FLOW_DURABLE_CANARY_ACCOUNT_ID\")) {\n              continue;\n            }\n\n",
    ""],
   // Security hardening S1/S3/S4 (not part of HEAD e9a53a3): exactly these
   // hunks; the guard logic itself lives in safeFetch.ts / abuseGuards.ts /
   // waBinding.ts and is covered by tests/security-*.test.ts.
   // imports of the pure security modules
   ["// Security hardening (S1 / S3 / S4): pure, unit-tested modules.\nimport { safeFetchText, denoResolver } from \"./safeFetch.ts\";\nimport { rateGate, widgetIpRules, widgetScopeRules, aiActionRules, knowledgeAddRules, CLAIM_AI_ACTIONS } from \"./abuseGuards.ts\";\nimport { bindWhatsappNumber, supabaseBindStore, BIND_CONFLICT_BODY } from \"./waBinding.ts\";\n",
    ""],
   // S4: extractFromUrl uses the SSRF guard (safeFetch.ts)
   ["  // S4 SSRF guard (safeFetch.ts): public http(s) hosts only, ports 80/443,\n  // manual re-validated redirects (max 3), 8s deadline, 1.5 MB cap,\n  // text/html | text/plain | application/xhtml+xml only.\n  const res = await safeFetchText(url, {\n    fetch: (u, init) => fetch(u, init),\n    resolve: denoResolver(),\n",
    "  const res = await fetch(url, {\n    headers: {\n      \"user-agent\":\n        \"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36\",\n    },\n    redirect: \"follow\",\n"],
   // S4: body comes from the capped guard result
   ["  const raw = res.text;\n",
    "  const raw = await res.text();\n"],
   // S3: widget_message per-IP limit before any lookup
   ["      // S3 (abuseGuards.ts): per-IP limit BEFORE any lookup, write or LLM call.\n      const widgetIpLimited = await rateGate({\n        rpc: sb, headers: req.headers, salt: env(\"RATE_LIMIT_IP_SALT\"), cors: CORS,\n        rules: widgetIpRules,\n      });\n      if (widgetIpLimited) return widgetIpLimited;\n\n",
    ""],
   // S3: widget_message per-session / per-tenant caps before the first write
   ["      // S3 (abuseGuards.ts): per-session and per-tenant caps BEFORE the\n      // customer message is stored and before any LLM / embedding call.\n      const widgetScopeLimited = await rateGate({\n        rpc: sb, headers: req.headers, salt: env(\"RATE_LIMIT_IP_SALT\"), cors: CORS,\n        rules: () => widgetScopeRules(found.tenant.id, session.id),\n      });\n      if (widgetScopeLimited) return widgetScopeLimited;\n\n",
    ""],
   // S3/S4: claim-token AI actions rate limited
   ["      // S3/S4 (abuseGuards.ts): URL fetch / LLM / embedding claim actions are\n      // rate limited per IP and per tenant before any of that work.\n      if (CLAIM_AI_ACTIONS.has(action)) {\n        const aiLimited = await rateGate({\n          rpc: sb, headers: req.headers, salt: env(\"RATE_LIMIT_IP_SALT\"), cors: CORS,\n          rules: (ipHash) => aiActionRules(ipHash, tenant.id),\n        });\n        if (aiLimited) return aiLimited;\n      }\n\n",
    ""],
   // S1: bind_number never overwrites another tenant's phone_id
   ["          // S1 (waBinding.ts): never overwrite another tenant's number.\n          // INSERT .. ON CONFLICT (phone_id) DO NOTHING, then verify owner.\n          const bound = await bindWhatsappNumber(\n            supabaseBindStore(sb), tenant.id, phoneId\n          );\n          if (bound.status === \"conflict\") {\n            console.warn(\"[bind_number] refused\", { code: \"phone_id_owned_by_other_tenant\" });\n            return json(BIND_CONFLICT_BODY, 409);\n          }\n          if (bound.status === \"error\") {\n            console.error(\"[bind_number] failed\", { code: \"bind_error\" });\n            return err(\"تعذر ربط الرقم — حاول مرة أخرى\", 500);\n",
    "          const {\n            error,\n          } = await sb\n            .from(\n              \"wa_bindings\"\n            )\n            .upsert(\n              {\n                phone_id:\n                  phoneId,\n\n                tenant_id:\n                  tenant.id,\n              },\n              {\n                onConflict:\n                  \"phone_id\",\n              }\n            );\n\n          if (error) {\n            return err(\n              error.message,\n              500\n            );\n"],
   // S4: knowledge_add per-tenant limit
   ["        // S4 (abuseGuards.ts): per-tenant limit before URL fetch / embeddings.\n        const kbLimited = await rateGate({\n          rpc: sb, headers: req.headers, salt: env(\"RATE_LIMIT_IP_SALT\"), cors: CORS,\n          rules: () => knowledgeAddRules(tenant.id),\n        });\n        if (kbLimited) return kbLimited;\n\n",
    ""],
   // Security hardening S8 (Widget credit reserved before the LLM,
   // widgetBilling.ts) and S9 (wa_bindings verification gate, waBinding.ts):
   // exactly these hunks; covered by tests/security-widget-billing.test.ts,
   // tests/security-wa-verification.test.ts, tests/security-tenant-isolation-sql.test.mjs.
   ["// Security hardening (S8 Widget billing / S9 WhatsApp binding verification).\nimport { widgetBillingEnabled, reserveWidgetAnswer, commitWidgetAnswer, releaseWidgetAnswer, widgetBillingEarlyReply } from \"./widgetBilling.ts\";\nimport { bindingIsVerified, readBindingVerified } from \"./waBinding.ts\";\n",
    ""],
   // S9: whatsapp_webhook routes only VERIFIED wa_bindings rows
   ["            // S9 (waBinding.ts): only operator-VERIFIED bindings route traffic\n            // (20261029290000). Unverified -> not answered; approve with the\n            // service role: UPDATE public.wa_bindings SET is_verified = true,\n            // verified_at = now(), verified_by = '<operator>:<ticket>'\n            // WHERE phone_id = '<id>' AND tenant_id = '<tenant>';\n            const { data: bindingRow } = await sb\n              .from(\"wa_bindings\")\n              .select(\"tenant_id, phone_id, is_verified\")\n              .eq(\"phone_id\", phoneId)\n              .maybeSingle();\n            const binding = bindingIsVerified(bindingRow) ? bindingRow : null;\n            if (bindingRow && !binding) {\n              console.warn(\"[whatsapp_webhook] binding ignored\", { code: \"wa_binding_unverified\" });\n            }\n",
    "            const { data: binding } = await sb\n              .from(\"wa_bindings\")\n              .select(\"tenant_id, phone_id\")\n              .eq(\"phone_id\", phoneId)\n              .maybeSingle();\n"],
   // S8: reserve one credit before any embedding / LLM call
   ["      // S8 (widgetBilling.ts): reserve ONE credit atomically BEFORE any\n      // embedding / LLM call. Billing is ON unless WIDGET_BILLING_V2_ENABLED\n      // is exactly \"false\" (operator kill switch). Idempotent per session +\n      // client message id / message hash; released when no answer is delivered.\n      const widgetBill = await reserveWidgetAnswer(sb, {\n        enabled: widgetBillingEnabled(env(\"WIDGET_BILLING_V2_ENABLED\")),\n        tenantId: found.tenant.id, sessionId: session.id, message,\n        clientMessageId: body.clientMessageId,\n      });\n      const widgetEarly = await widgetBillingEarlyReply(sb, widgetBill, {\n        tenantId: found.tenant.id, widgetId: found.widget.id, sessionId: session.id,\n      });\n      if (widgetEarly) return json(widgetEarly);\n\n",
    ""],
   // S8: release the reserved credit on LLM error / refusal / save failure
   ["      } catch (e) {\n        await releaseWidgetAnswer(sb, found.tenant.id, widgetBill);\n        console.error(\n          \"[widget_message] AI error\",",
    "      } catch (e) {\n        console.error(\n          \"[widget_message] AI error\","],
   ["        await releaseWidgetAnswer(sb, found.tenant.id, widgetBill);\n        const reply =\n          \"عذرًا، ما عندي معلومات كافية عن هذا السؤال حاليًا.\";",
    "        const reply =\n          \"عذرًا، ما عندي معلومات كافية عن هذا السؤال حاليًا.\";"],
   ["      if(widgetSaveError||!savedWidgetReply?.id){\n        await releaseWidgetAnswer(sb, found.tenant.id, widgetBill);\n",
    "      if(widgetSaveError||!savedWidgetReply?.id){\n"],
   // S8: commit replaces the post-answer, flag-gated consume_widget_reply debit
   ["      // S8 (widgetBilling.ts): the credit was reserved before the LLM call;\n      // bind it to the saved answer (\"deferred\" only under the kill switch).\n      const billingStatus=await commitWidgetAnswer(\n        sb,found.tenant.id,widgetBill,savedWidgetReply.id);\n",
    "      // Two-phase deployment: additive SQL first, then activate separately.\n      // Disabled by default, preserving old (currently uncharged) Widget path.\n      let billingStatus:\"deferred\"|\"charged\"|\"already_charged\"|\"pending\"=\"deferred\";\n      if(env(\"WIDGET_BILLING_V2_ENABLED\")===\"true\"){\n        const charge=await chargeWidgetReply(\n          sb,found.tenant.id,savedWidgetReply.id);\n        billingStatus=charge.status===\"charged\"||charge.status===\"already_charged\"\n          ? charge.status:\"pending\";\n        if(billingStatus===\"pending\"){\n          console.error(\"[widget_message] reply saved but credit pending\",{\n            tenantId:found.tenant.id,\n            messageId:savedWidgetReply.id,\n            reason:charge.status\n          });\n        }\n      }else{\n        console.info(\"[widget_message] Widget billing v2 disabled; no charge\",{\n          tenantId:found.tenant.id,messageId:savedWidgetReply.id\n        });\n      }\n"],
   // S9: bind_number returns the additive verified flag + TODO(security)
   ["          // S9 interim control (20261029290000): new bindings start\n          // UNVERIFIED and get no auto-replies until an operator approves them\n          // (SQL in the migration header). Same-tenant re-bind never touches\n          // the flag (INSERT .. ON CONFLICT DO NOTHING).\n          // TODO(security): permanent fix — require the tenant's WhatsApp\n          // Business access token, call GET https://graph.facebook.com/<ver>/{phone_number_id}\n          // with it (fail closed on any error / mismatch) and set\n          // is_verified = true automatically instead of manual approval.\n          return json({\n            ok: true,\n            verified: await readBindingVerified(sb, phoneId, tenant.id),\n",
    "          return json({\n            ok: true,\n"],
   // S9: wa_status additive verified flag
   ["            phoneId,\n            // S9: additive; false until an operator verified the binding,\n            // null when the tenant has no binding.\n            verified: phoneId ? await readBindingVerified(sb, phoneId, tenant.id) : null,\n",
    "            phoneId,\n            // S9: additive; false until an operator verified the binding.\n            verified: phoneId ? await readBindingVerified(sb, phoneId, tenant.id) : false,\n"],
   // Comment automation (20261029300000; FLOW_COMMENT_AUTOMATION_ENABLED, default
   // OFF): exactly these hunks. The logic lives in commentIngress.ts /
   // commentActivity.ts (tests/flow-comment-automation.test.ts,
   // tests/flow-comment-replies-sql.test.mjs).
   ["import { chargeWidgetReply } from \"./widgetCredit.ts\";\n// Comment automation (FLOW_COMMENT_AUTOMATION_ENABLED, default OFF) and its Inbox read contract.\nimport { ingestSignedComments, commentAutomationEnabled } from \"./commentIngress.ts\";\nimport { readCommentActivity } from \"./commentActivity.ts\";\nimport { commentActivityRules } from \"./abuseGuards.ts\";\n",
    "import { chargeWidgetReply } from \"./widgetCredit.ts\";\n"],
   // signed comment changes, only while the flag is on (after the message loop)
   ["              );\n            }\n          }\n\n          // FLOW_COMMENT_AUTOMATION_ENABLED (default OFF; commentIngress.ts):\n          // signed Instagram \"comments\" / Page \"feed\" comment changes start a\n          // comment run (public reply first, then the DM). OFF: never parsed.\n          if (commentAutomationEnabled()) {\n            await ingestSignedComments(sb, body.object, entry, {\n              env, encrypt: encryptField,\n            });\n          }\n        }\n",
    "              );\n            }\n          }\n        }\n"],
   // claim action list + the read-only, rate-limited comment_activity action
   ["      \"qa_test\",\n      \"comment_activity\",\n    ];\n",
    "      \"qa_test\",\n    ];\n"],
   ["        // Inbox comment activity (commentActivity.ts): read-only, scoped to\n        // the claim-verified tenant, rate limited, at most 100 per page.\n        case \"comment_activity\": {\n          const caLimited = await rateGate({\n            rpc: sb, headers: req.headers, salt: env(\"RATE_LIMIT_IP_SALT\"), cors: CORS,\n            rules: (ipHash) => commentActivityRules(ipHash, String(tenant.id)),\n          });\n          if (caLimited) return caLimited;\n          const activity = await readCommentActivity(sb, String(tenant.id),\n            { limit: body.limit, cursor: body.cursor }, decryptField);\n          if (!activity.ok) {\n            return json({ ok: false, error: activity.error }, activity.status);\n          }\n          return json(activity);\n        }\n\n        case \"bind_number\": {\n",
    "        case \"bind_number\": {\n"]
  ];
  let cur=src(IDX),base=head.stdout;
  if(cur!==base)for(const [now,was] of allowed){
   assert.equal(cur.split(now).length,2,"allowed hunk present exactly once: "+now.trim().slice(0,60));
   // A hunk already committed in HEAD is baseline: it must stay byte-identical
   // (checked above) and is undone in BOTH texts in lockstep, so older entries
   // that a later (committed) entry supersedes still match exactly. Skipping
   // it instead made every older superseded entry unmatched once HEAD
   // contained the newer hunks (any diff at all then failed).
   const inHead=base.split(now).length-1;
   assert.ok(inHead<=1,"allowed hunk at most once in HEAD: "+now.trim().slice(0,60));
   cur=cur.replace(now,()=>was);
   if(inHead===1)base=base.replace(now,()=>was);
  }
  assert.equal(cur,base,"milan-api/index.ts differs from HEAD only by the authorized multichannel / page-hardening / security / comment-automation hunks");
 }
 assert.match(src(CHECKS),new RegExp(`cf\\.h IS DISTINCT FROM '${md5(body(MIG,"claim"))}'`),"170000 body hash embedded in checks");
 assert.match(src(CHECKS),new RegExp(`v2\\.h='${md5(body(CLAIM,"claim"))}'`),"220000 body hash embedded in checks");
});

// ---------------------------------------------------------------- live PG
function findPgBin(){
 const cands=[];
 if(process.env.PG_BIN)cands.push(process.env.PG_BIN);
 try{for(const v of readdirSync("/usr/lib/postgresql").sort().reverse())
  cands.push(`/usr/lib/postgresql/${v}/bin`);}catch{}
 return cands.find(d=>["initdb","pg_ctl","postgres","psql"].every(b=>existsSync(join(d,b))))??null;
}
const BIN=findPgBin();
const isRoot=typeof process.getuid==="function"&&process.getuid()===0;
const canRunAsPostgres=!isRoot||spawnSync("id",["-u","postgres"]).status===0;
const live=BIN&&canRunAsPostgres;
const skip=live?false:"PostgreSQL server binaries unavailable; static checks only";
let dir,port,started=false;
function asServer(cmd,args){
 return isRoot?spawnSync("runuser",["-u","postgres","--",join(BIN,cmd),...args],{encoding:"utf8"})
  :spawnSync(join(BIN,cmd),args,{encoding:"utf8"});
}
function clientEnv(extra={}){
 const env={};
 for(const [k,v] of Object.entries(process.env))if(!k.startsWith("PG"))env[k]=v;
 return {...env,...extra};
}
const pargs=(db,tab)=>["-X","-q","-t","-A",...(tab?["-F","\t"]:[]),"-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose",
 "-h",dir,"-p",String(port),"-U","postgres","-d",db];
function psql(db,{file,sql,env,role,tab}={}){
 const a=pargs(db,tab);
 if(file)a.push("-f",file);
 const input=sql===undefined?undefined:(role?`SET ROLE ${role};\n`:"")+sql;
 return spawnSync(join(BIN,"psql"),a,{encoding:"utf8",input,env:clientEnv(env),maxBuffer:1<<26});
}
function psqlAsync(db,sql){
 return new Promise(res=>{
  const p=spawn(join(BIN,"psql"),pargs(db),{env:clientEnv()});
  let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
  p.on("close",code=>res({code,out,err}));p.stdin.end(sql);
 });
}
function ok(db,s,label){
 const r=psql(db,s);
 assert.equal(r.status,0,`${label}\n${r.stderr}`);
 return r.stdout.trim();
}
function rows(db,query,role){
 const r=psql(db,{sql:`SELECT '@@'||coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)::text FROM (${query}) x;`,role});
 assert.equal(r.status,0,`${query}\n${r.stderr}`);
 return JSON.parse(r.stdout.split("\n").find(l=>l.startsWith("@@")).slice(2));
}
const val=(db,query,role)=>rows(db,`SELECT (${query}) AS v`,role)[0]?.v;
const sqlState=err=>(err.match(/ERROR:\s+([0-9A-Z]{5}):/)??[])[1];
function fails(db,sql,code,label,role){
 const r=psql(db,{sql,role});
 assert.notEqual(r.status,0,`${label} must fail`);
 assert.equal(sqlState(r.stderr),code,`${label}: ${r.stderr}`);
}
function refused(db,file,re,label,env){
 const before=fp(db);
 const r=psql(db,{file,env});
 assert.notEqual(r.status,0,`${label} must be refused`);
 assert.match(r.stderr,re,label);
 assert.equal(fp(db),before,`${label}: refused without any change`);
}

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111";  // tenant A instagram: the canary
const ACC2="dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // tenant A instagram: NOT the canary
const ACCB="cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // tenant B instagram
const FBB="22222222-2222-4222-8222-222222222222";  // tenant B facebook (fixture)
const WAA="33333333-3333-4333-8333-333333333333";  // tenant A whatsapp (fixture)
const doc={version:3,name:"two choices",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"choose",image:"",contentBlocks:[],options:[
  {id:"prices",label:"prices"},{id:"support",label:"support"}]}},
 {id:"yes",data:{kind:"message",text:"prices text",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"support text",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},{source:"choose",target:"yes",sourceHandle:"prices"},
  {source:"choose",target:"no",sourceHandle:"support"}]};
const J=o=>`'${JSON.stringify(o).replace(/'/g,"''")}'::jsonb`;
// Production live-only columns (as in tests/flow-lifecycle-integration.test.ts).
const LIVE=`
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,ADD COLUMN auto_reply boolean NOT NULL DEFAULT true;
ALTER TABLE public.conversations ADD COLUMN transferred boolean NOT NULL DEFAULT false,
 ADD COLUMN auto_paused_reason text,ADD COLUMN human_agent_expires_at timestamptz;
ALTER TABLE public.automation_flow_tenant_switches
 ADD COLUMN production_approved boolean NOT NULL DEFAULT false;`;
const CHAIN=["tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
 "tests/sql/flow-exclusive-claim-bootstrap.sql","@LIVE",CLAIM,
 "supabase/migrations/20261028224000_delivery_attempts.sql","supabase/migrations/20261028225000_flow_runtime_advance.sql",
 "supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql",
 // Durable start/button RPCs (bodies identical to the former proposal step).
 "supabase/migrations/20261029125000_flow_durable_button_run.sql",LC,AI,TK,CP];
const SEED=`
-- cc.dc references the 170000 function, which is created later per database.
SET check_function_bodies=off;
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES
 ('${ACC2}','${A}','instagram','instagram'),('${ACCB}','${B}','instagram','instagram');
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by) VALUES
 ('${A}','buttons',1,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${A}','delay',1,'${ACC}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${A}','other',1,'${ACC2}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${B}','bflow',1,'${ACCB}','instagram',${J(doc)},'88888888-8888-4888-8888-888888888888'),
 ('${B}','bfb',1,'${FBB}','facebook',${J(doc)},'88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active) VALUES
 ('${A}','${ACC}','instagram','buttons',1,true),('${A}','${ACC}','instagram','delay',1,true),
 ('${A}','${ACC2}','instagram','other',1,true),('${B}','${ACCB}','instagram','bflow',1,true),
 ('${B}','${FBB}','facebook','bfb',1,true);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved)
VALUES('${A}',true,false,true),('${B}',true,false,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
CREATE SCHEMA cc;
GRANT USAGE ON SCHEMA cc TO service_role;
CREATE FUNCTION cc.conv(p_tenant uuid,p_acc uuid) RETURNS uuid LANGUAGE sql AS $f$
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(gen_random_uuid(),p_tenant,p_acc,'instagram:'||gen_random_uuid()) RETURNING id$f$;
CREATE FUNCTION cc.inbound(p_tenant uuid,p_conv uuid,p_mid text) RETURNS uuid LANGUAGE sql AS $f$
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
 VALUES(p_tenant,p_conv,'in',p_mid) RETURNING id$f$;
-- One event = conversation + persisted inbound (what milan-api writes first).
CREATE TABLE cc.ev(name text PRIMARY KEY,tenant uuid,acc uuid,conv uuid,msg uuid,mid text);
GRANT SELECT,INSERT ON cc.ev TO service_role;
CREATE FUNCTION cc.mk(p_name text,p_tenant uuid,p_acc uuid) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid:=cc.conv(p_tenant,p_acc);
BEGIN INSERT INTO cc.ev VALUES(p_name,p_tenant,p_acc,c,cc.inbound(p_tenant,c,'mid.'||p_name),'mid.'||p_name); END $f$;
-- Durable canary claim for a named event, optionally overriding any argument.
CREATE FUNCTION cc.dc(p_name text,p_tenant uuid DEFAULT NULL,p_acc uuid DEFAULT NULL,p_platform text DEFAULT 'instagram',
 p_conv uuid DEFAULT NULL,p_msg uuid DEFAULT NULL)
RETURNS TABLE(acquired boolean,route text,claim_id uuid,outgoing_message_id uuid) LANGUAGE sql AS $f$
 SELECT d.* FROM cc.ev e,public.flow_claim_inbound_durable(coalesce(p_tenant,e.tenant),coalesce(p_acc,e.acc),
  p_platform,e.mid,coalesce(p_conv,e.conv),coalesce(p_msg,e.msg)) d WHERE e.name=p_name$f$;
CREATE FUNCTION cc.v2(p_name text,p_ready boolean DEFAULT false)
RETURNS TABLE(acquired boolean,route text,claim_id uuid,outgoing_message_id uuid) LANGUAGE sql AS $f$
 SELECT d.* FROM cc.ev e,public.flow_claim_inbound(e.tenant,e.acc,'instagram',e.mid,e.conv,e.msg,p_ready) d
 WHERE e.name=p_name$f$;
CREATE FUNCTION cc.claims(p_name text) RETURNS text LANGUAGE sql STABLE AS $f$
 SELECT count(*)::text||':'||coalesce(string_agg(c.route,',' ORDER BY c.route),'-')
 FROM public.automation_message_claims c JOIN cc.ev e ON e.mid=c.provider_event_id WHERE e.name=p_name$f$;
-- V2 behaviour over the whole switch matrix: (switches, engine_ready) -> first/second claim result.
CREATE FUNCTION cc.matrix(p_tag text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE g boolean; en boolean; t boolean; pa boolean; ready boolean; n text; r1 record; r2 record; out jsonb:='[]';
BEGIN
 FOREACH g IN ARRAY ARRAY[true,false] LOOP FOREACH en IN ARRAY ARRAY[true,false] LOOP
 FOREACH t IN ARRAY ARRAY[true,false] LOOP FOREACH pa IN ARRAY ARRAY[true,false] LOOP
 FOREACH ready IN ARRAY ARRAY[true,false] LOOP
  UPDATE public.automation_flow_global_switch SET enabled=g;
  UPDATE public.automation_flow_tenant_switches SET enabled=en,test_only=t,production_approved=pa WHERE tenant_id='${A}';
  n:=p_tag||'.'||g||en||t||pa||ready;
  PERFORM cc.mk(n,'${A}','${ACC}');
  SELECT * INTO r1 FROM cc.v2(n,ready); SELECT * INTO r2 FROM cc.v2(n,ready);
  out:=out||jsonb_build_object('k',g::text||en||t||pa||ready,'first',r1.acquired::text||'/'||r1.route,
   'second',r2.acquired::text||'/'||r2.route,'same_claim',r1.claim_id=r2.claim_id,'rows',cc.claims(n));
 END LOOP; END LOOP; END LOOP; END LOOP; END LOOP;
 UPDATE public.automation_flow_global_switch SET enabled=true;
 UPDATE public.automation_flow_tenant_switches SET enabled=true,test_only=false,production_approved=true WHERE tenant_id='${A}';
 RETURN out;
END $f$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cc TO service_role;
ANALYZE;`;
function buildBase(){
 ok("postgres",{sql:"CREATE DATABASE base;"},"createdb");
 ok("base",{sql:src("tests/sql/fixtures/flow-live-shape-bootstrap.sql")},"live shape");
 for(const f of CHAIN)ok("base",f==="@LIVE"?{sql:LIVE}:{file:f},f);
 ok("base",{sql:SEED},"seed");
}
before(()=>{
 if(!live)return;
 dir=mkdtempSync(join(tmpdir(),"flow-canary-pg-"));
 if(isRoot){
  const uid=Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout);
  const gid=Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout);
  chownSync(dir,uid,gid);
 }
 port=20000+((process.pid+41)%20000);
 let r=asServer("initdb",["-D",join(dir,"data"),"-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
 assert.equal(r.status,0,r.stderr);
 r=asServer("pg_ctl",["-D",join(dir,"data"),"-l",join(dir,"server.log"),"-w","-o",
  `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off`,"start"]);
 assert.equal(r.status,0,r.stderr+r.stdout);
 started=true;
 buildBase();
});
after(()=>{
 if(!dir)return;
 if(started)asServer("pg_ctl",["-D",join(dir,"data"),"-m","fast","-w","stop"]);
 rmSync(dir,{recursive:true,force:true});
});
let clones=0;
function clone(prefix,template="base"){
 const db=`${prefix}_${++clones}`;
 ok("postgres",{sql:`CREATE DATABASE ${db} TEMPLATE ${template};`},`clone ${db}`);
 return db;
}
const FP=data=>`SELECT md5(string_agg(x,E'\\n' ORDER BY x)) FROM (
 SELECT 'f:'||p.oid::regprocedure::text||':'||coalesce(obj_description(p.oid,'pg_proc'),'')||':'||md5(p.prosrc)||':'||
  coalesce(p.proacl::text,'')||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||pg_get_function_result(p.oid)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'r:'||c.oid::regclass::text||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(obj_description(c.oid,'pg_class'),'')||':'||c.relrowsecurity
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'i:'||pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'c:'||a.attrelid::regclass::text||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||
  coalesce(pg_get_expr(d.adbin,d.adrelid),'')
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v') AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'k:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid)||':'||convalidated
  FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 'p:'||polrelid::regclass::text||':'||polname FROM pg_policy
 UNION ALL SELECT 't:'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text FROM pg_trigger t WHERE NOT t.tgisinternal
 ${data?`UNION ALL SELECT 'd:'||c.oid::regclass::text||':'||md5(query_to_xml(
   format('SELECT t::text AS v FROM %s t ORDER BY 1',c.oid::regclass),false,false,'')::text)
  FROM pg_class c WHERE c.relkind IN('r','p') AND c.relnamespace='public'::regnamespace`:""}
) s(x);`;
const fp=(db,data=true)=>ok(db,{sql:FP(data)},"fingerprint");
const OLD_FN=`SELECT md5(pg_get_functiondef('${OLD_SIG}'::regprocedure))||':'||
 coalesce(obj_description('${OLD_SIG}'::regprocedure,'pg_proc'),'')||':'||
 (SELECT coalesce(proacl::text,'') FROM pg_proc WHERE oid='${OLD_SIG}'::regprocedure)`;
const REGISTER=(t=A,a=ACC)=>`INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by)
 VALUES('${t}','${a}','instagram','test-operator');`;
const SR="service_role";
const dc=(db,name,over="")=>rows(db,`SELECT acquired,route FROM cc.dc('${name}'${over})`,SR);
const claims=(db,name)=>val(db,`SELECT cc.claims('${name}')`);
const audit=db=>Number(val(db,"SELECT count(*) FROM public.automation_flow_canary_claims"));
const mk=(db,name,t=A,a=ACC)=>ok(db,{sql:`SELECT cc.mk('${name}','${t}','${a}');`},`event ${name}`);
// Installed + registered canary database.
function canaryDb(prefix){
 const db=clone(prefix);
 ok(db,{file:MIG},"170000");
 ok(db,{sql:REGISTER()},"operator registers the canary");
 return db;
}

test("(a) flow_claim_inbound (V2) is byte-for-byte unchanged by 170000, and behaves identically over the switch matrix",{skip},()=>{
 const pre=clone("v2pre"),post=clone("v2post");
 const before=ok(post,{sql:OLD_FN},"old fn before");
 assert.equal(before,ok(pre,{sql:OLD_FN},"old fn pre"));
 ok(post,{file:MIG},"170000");
 assert.equal(ok(post,{sql:OLD_FN},"old fn after"),before,"md5(pg_get_functiondef), marker and ACL identical");
 assert.equal(ok(post,{sql:`SELECT md5(prosrc) FROM pg_proc WHERE oid='${OLD_SIG}'::regprocedure`},"src"),
  md5(body(CLAIM,"claim")),"installed body is exactly the 20261028220000 file body");
 ok(post,{sql:REGISTER()},"register (must not influence V2)");
 const m1=JSON.parse(ok(pre,{sql:"SET ROLE service_role; SELECT cc.matrix('mx');"},"matrix pre"));
 const m2=JSON.parse(ok(post,{sql:"SET ROLE service_role; SELECT cc.matrix('mx');"},"matrix post"));
 assert.equal(m1.length,32);
 assert.deepEqual(m2,m1,"identical V2 output and side effects for all 32 switch/engine combinations");
 // Spot checks of the (unchanged) V2 rule: 'flow' only for test_only + engine ready + switches on.
 const by=Object.fromEntries(m1.map(r=>[r.k,r]));
 assert.equal(by.truetruetruetruetrue.first,"true/flow");
 assert.equal(by.truetruefalsetruetrue.first,"true/legacy_ai","production_approved without test_only stays legacy in V2");
 for(const r of m1){assert.match(r.second,/^false\//);assert.equal(r.same_claim,true);assert.match(r.rows,/^1:/);}
 assert.equal(audit(post),0,"V2 claims never write canary audit rows");
});

test("(b) approved, registered canary routes to the durable engine with exactly one claim",{skip},()=>{
 const db=canaryDb("ok");
 mk(db,"b1");
 assert.deepEqual(dc(db,"b1"),[{acquired:true,route:"flow"}]);
 assert.equal(claims(db,"b1"),"1:flow");assert.equal(audit(db),1);
 const run=val(db,`SELECT public.flow_begin_durable_run('${A}','${ACC}',e.conv,e.msg,e.mid,'buttons',1,'start','choose',1,
  'awaiting_input','{}'::jsonb,NULL,'[{"kind":"question","idempotencyKey":"q.b1","payload":{"kind":"question","text":"choose"}}]'::jsonb)
  FROM cc.ev e WHERE e.name='b1'`,SR);
 assert.match(String(run),/^[0-9a-f-]{36}$/,"durable run begins on the canary claim");
 assert.deepEqual(rows(db,`SELECT run_status,current_node_id FROM public.automation_flow_runs WHERE id='${run}'`),
  [{run_status:"awaiting_input",current_node_id:"choose"}]);
 // Tap on the same run: claimed through the canary function, resumes the branch.
 ok(db,{sql:`INSERT INTO cc.ev SELECT 'b1tap',tenant,acc,conv,cc.inbound(tenant,conv,'mid.b1tap'),'mid.b1tap' FROM cc.ev WHERE name='b1';`},"tap");
 assert.deepEqual(dc(db,"b1tap"),[{acquired:true,route:"flow"}]);
 assert.equal(val(db,`SELECT public.flow_resume_button_run('${A}','${run}',e.mid,e.msg,1,'choose','yes',2,'completed','{}'::jsonb,NULL,
  '[{"kind":"message","idempotencyKey":"m.b1","payload":{"kind":"message","text":"prices text"}}]'::jsonb) FROM cc.ev e WHERE e.name='b1tap'`,SR),true);
 assert.equal(val(db,`SELECT run_status FROM public.automation_flow_runs WHERE id='${run}'`),"completed");
 assert.equal(audit(db),2);
});

test("(c)(d) not approved, switched off or test_only tenants: no row, no claim; V2 then claims normally",{skip},()=>{
 const db=canaryDb("na");
 const cases=[
  ["c_unapproved",`UPDATE public.automation_flow_tenant_switches SET production_approved=false WHERE tenant_id='${A}';`],
  ["c_tenant_off",`UPDATE public.automation_flow_tenant_switches SET enabled=false WHERE tenant_id='${A}';`],
  ["c_global_off",`UPDATE public.automation_flow_global_switch SET enabled=false;`],
  ["c_no_switch_row",`DELETE FROM public.automation_flow_tenant_switches WHERE tenant_id='${A}';`],
  ["d_test_only",`UPDATE public.automation_flow_tenant_switches SET test_only=true WHERE tenant_id='${A}';`],
  ["c_inactive_activation",`UPDATE public.automation_flow_activations SET is_active=false WHERE tenant_id='${A}' AND channel_account_id='${ACC}';`],
  ["c_account_paused",`UPDATE public.channel_accounts SET auto_reply=false WHERE id='${ACC}';`],
  ["c_tenant_inactive",`UPDATE public.tenants SET is_active=false WHERE id='${A}';`],
  ["c_not_registered",`DELETE FROM public.automation_flow_canary_accounts;`],
 ];
 const RESET=`UPDATE public.automation_flow_global_switch SET enabled=true;
  INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved) VALUES('${A}',true,false,true)
  ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=false,production_approved=true;
  UPDATE public.automation_flow_activations SET is_active=true WHERE tenant_id='${A}';
  UPDATE public.channel_accounts SET auto_reply=true WHERE id='${ACC}'; UPDATE public.tenants SET is_active=true WHERE id='${A}';
  INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by)
  VALUES('${A}','${ACC}','instagram','test-operator') ON CONFLICT DO NOTHING;`;
 for(const [name,change] of cases){
  mk(db,name);
  ok(db,{sql:change},name);
  assert.deepEqual(dc(db,name),[],`${name}: not eligible -> no row`);
  assert.equal(claims(db,name),"0:-",`${name}: no claim row`);
  if(name==="d_test_only")
   assert.deepEqual(rows(db,`SELECT acquired,route FROM cc.v2('${name}',true)`,SR),[{acquired:true,route:"flow"}],
    "test_only keeps the unchanged V2/test path");
  else assert.deepEqual(rows(db,`SELECT acquired,route FROM cc.v2('${name}')`,SR),[{acquired:true,route:"legacy_ai"}],
   `${name}: V2 claims the event normally`);
  assert.equal(claims(db,name).split(":")[0],"1");
  ok(db,{sql:RESET},"reset");
 }
 assert.equal(audit(db),0);
 // Control: after every reset the canary is eligible again.
 mk(db,"c_control");assert.deepEqual(dc(db,"c_control"),[{acquired:true,route:"flow"}]);
});

test("(e) account that is not the registered canary, wrong platform, wrong conversation: refused",{skip},()=>{
 const db=canaryDb("acct");
 // Same approved tenant, active activation, but not the registered account.
 mk(db,"e_other",A,ACC2);
 assert.deepEqual(dc(db,"e_other"),[]);assert.equal(claims(db,"e_other"),"0:-");
 assert.deepEqual(rows(db,"SELECT acquired,route FROM cc.v2('e_other')",SR),[{acquired:true,route:"legacy_ai"}]);
 // Registered account, but a different platform argument / non-instagram account.
 mk(db,"e_plat");
 for(const p of ["facebook","whatsapp","Instagram","instagram ",null])
  assert.deepEqual(dc(db,"e_plat",`,p_platform=>${p===null?"NULL":`'${p}'`}`),[],String(p));
 assert.deepEqual(dc(db,"e_plat",`,p_acc=>'${WAA}'`),[],"tenant A whatsapp account");
 assert.equal(claims(db,"e_plat"),"0:-");
 // A registration for another platform cannot even exist.
 fails(db,`INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by)
  VALUES('${B}','${FBB}','facebook','x');`,"23514","facebook registration");
 // Conversation not bound to the canary account / message of another conversation.
 mk(db,"e_conv2");
 ok(db,{sql:`UPDATE public.conversations SET account_id=NULL WHERE id=(SELECT conv FROM cc.ev WHERE name='e_conv2');`},"unbound conv");
 assert.deepEqual(dc(db,"e_conv2"),[],"conversation without account binding");
 mk(db,"e_msg");mk(db,"e_msg2");
 assert.deepEqual(dc(db,"e_msg",`,p_msg=>(SELECT msg FROM cc.ev WHERE name='e_msg2')`),[],"inbound of another conversation");
 assert.deepEqual(dc(db,"e_msg",`,p_conv=>(SELECT conv FROM cc.ev WHERE name='e_msg2')`),[],"conversation of another inbound");
 for(const n of ["e_conv2","e_msg","e_msg2"])assert.equal(claims(db,n),"0:-",n);
 assert.equal(audit(db),0);
 // Bad arguments never error and never claim.
 assert.deepEqual(rows(db,`SELECT * FROM public.flow_claim_inbound_durable(NULL,NULL,NULL,NULL,NULL,NULL)`,SR),[]);
 assert.deepEqual(rows(db,`SELECT * FROM public.flow_claim_inbound_durable('${A}','${ACC}','instagram',repeat('x',257),
  (SELECT conv FROM cc.ev WHERE name='e_msg'),(SELECT msg FROM cc.ev WHERE name='e_msg'))`,SR),[]);
});

test("(f) duplicate webhook: concurrent and sequential redelivery -> exactly one claim, acquired=false, no 23505",{skip},async()=>{
 const db=canaryDb("dup");
 mk(db,"f_seq");
 const first=rows(db,"SELECT * FROM cc.dc('f_seq')",SR),second=rows(db,"SELECT * FROM cc.dc('f_seq')",SR);
 assert.equal(first[0].acquired,true);assert.equal(second[0].acquired,false);
 assert.equal(second[0].route,"flow");assert.equal(second[0].claim_id,first[0].claim_id);
 assert.equal(second[0].outgoing_message_id,first[0].outgoing_message_id,"winner's claim returned to the loser");
 assert.equal(claims(db,"f_seq"),"1:flow");assert.equal(audit(db),1,"only the winner writes the audit row");
 // V2 after the durable winner: duplicate, V2 stays silent.
 assert.deepEqual(rows(db,"SELECT acquired,route FROM cc.v2('f_seq',true)",SR),[{acquired:false,route:"flow"}]);
 // V2 won first (legacy_ai): the durable function never steals it.
 mk(db,"f_v2first");
 assert.deepEqual(rows(db,"SELECT acquired,route FROM cc.v2('f_v2first')",SR),[{acquired:true,route:"legacy_ai"}]);
 assert.deepEqual(dc(db,"f_v2first"),[{acquired:false,route:"legacy_ai"}]);
 assert.equal(claims(db,"f_v2first"),"1:legacy_ai");assert.equal(audit(db),1);
 // Concurrent: the winner holds its transaction open; the loser blocks on the
 // unique index, then returns the winner's claim (acquired=false), no error.
 for(let i=0;i<3;i++){
  const n=`f_conc${i}`;mk(db,n);
  const call=`SET ROLE service_role; SELECT CASE WHEN acquired THEN 'won' ELSE 'lost' END FROM cc.dc('${n}');`;
  const w=psqlAsync(db,`BEGIN; ${call} SELECT pg_sleep(1.5); COMMIT;`);
  await new Promise(r=>setTimeout(r,400));
  const l=psqlAsync(db,call);
  const [rw,rl]=await Promise.all([w,l]);
  assert.equal(rw.code,0,rw.err);assert.equal(rl.code,0,rl.err);
  assert.doesNotMatch(rw.err+rl.err,/23505|duplicate key/);
  assert.deepEqual([rw.out.trim(),rl.out.trim()],["won","lost"]);
  assert.equal(claims(db,n),"1:flow");
 }
 // Fully parallel burst on one event.
 mk(db,"f_burst");
 const burst=await Promise.all(Array.from({length:6},()=>psqlAsync(db,
  "SET ROLE service_role; SELECT CASE WHEN acquired THEN 'won' ELSE 'lost' END FROM cc.dc('f_burst');")));
 for(const r of burst){assert.equal(r.code,0,r.err);assert.doesNotMatch(r.err,/23505/);}
 assert.equal(burst.filter(r=>r.out.trim()==="won").length,1);
 assert.equal(burst.filter(r=>r.out.trim()==="lost").length,5);
 assert.equal(claims(db,"f_burst"),"1:flow");
 assert.equal(audit(db),5,"f_seq + 3 concurrent + burst: one audit row per event");
});

test("(g) tenant isolation: A's registration never matches B; forged tenant/account pairs refused (composite FK); no cross-tenant read/write",{skip},()=>{
 const db=canaryDb("iso");
 mk(db,"gA");mk(db,"gB",B,ACCB);
 // Tenant B is approved with an active activation, but has no registration.
 assert.deepEqual(dc(db,"gB"),[],"B event, B account: not registered");
 // Forged combinations.
 const forged=[
  [`,p_tenant=>'${B}'`,"B tenant with A canary account/conv/msg"],
  [`,p_acc=>'${ACCB}'`,"A tenant with B account"],
  [`,p_tenant=>'${A}',p_acc=>'${ACC}'`,"A tenant + A account but B conversation/inbound"],
 ];
 assert.deepEqual(dc(db,"gA",forged[0][0]),[],forged[0][1]);
 assert.deepEqual(dc(db,"gA",forged[1][0]),[],forged[1][1]);
 assert.deepEqual(dc(db,"gB",forged[2][0]),[],forged[2][1]);
 assert.deepEqual(dc(db,"gA",`,p_conv=>(SELECT conv FROM cc.ev WHERE name='gB'),p_msg=>(SELECT msg FROM cc.ev WHERE name='gB')`),[],
  "A ids with B conversation/inbound");
 assert.equal(claims(db,"gA"),"0:-");assert.equal(claims(db,"gB"),"0:-");assert.equal(audit(db),0);
 // B's own claim (via V2) is never returned to a tenant-A caller.
 assert.deepEqual(rows(db,"SELECT acquired,route FROM cc.v2('gB')",SR),[{acquired:true,route:"legacy_ai"}]);
 assert.deepEqual(rows(db,`SELECT * FROM public.flow_claim_inbound_durable('${A}','${ACC}','instagram','mid.gB',
  (SELECT conv FROM cc.ev WHERE name='gB'),(SELECT msg FROM cc.ev WHERE name='gB'))`,SR),[]);
 // Registration integrity: forged tenant/account pairs cannot be stored.
 // (inside a rolled-back transaction without A's own registration, so only the FK can refuse it)
 fails(db,`BEGIN; DELETE FROM public.automation_flow_canary_accounts WHERE tenant_id='${A}';\n${REGISTER(A,ACCB)}`,"23503",
  "A tenant + B account (composite FK)");
 fails(db,`BEGIN; DELETE FROM public.automation_flow_canary_accounts WHERE tenant_id='${A}';\n${REGISTER(A,FBB)}`,"23503",
  "A tenant + B facebook account (composite FK)");
 fails(db,REGISTER(B,ACC),"23505","B tenant + A account: the account is already the A canary");
 fails(db,`BEGIN; DELETE FROM public.automation_flow_canary_accounts WHERE tenant_id='${A}';\n${REGISTER(B,ACC)}`,"23503",
  "B tenant + A account (composite FK)");
 fails(db,REGISTER(A,ACC2),"23505","second canary for the same tenant/platform");
 fails(db,REGISTER(B,"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),"23503","unknown account");
 fails(db,`UPDATE public.channel_accounts SET tenant_id='${B}' WHERE id='${ACC}';`,"23503","moving the canary account to another tenant");
 // Privileges: only an operator session can register; clients see nothing.
 fails(db,REGISTER(B,ACCB),"42501","service_role cannot register a canary",SR);
 fails(db,`UPDATE public.automation_flow_canary_accounts SET channel_account_id='${ACC2}';`,"42501","service_role cannot re-point",SR);
 fails(db,`DELETE FROM public.automation_flow_canary_accounts;`,"42501","service_role cannot delete",SR);
 fails(db,`UPDATE public.automation_flow_canary_claims SET tenant_id='${B}';`,"42501","audit is append-only for service_role",SR);
 for(const role of ["anon","authenticated"]){
  fails(db,"SELECT * FROM public.automation_flow_canary_accounts;","42501",`${role} read registration`,role);
  fails(db,"SELECT * FROM public.automation_flow_canary_claims;","42501",`${role} read audit`,role);
  fails(db,`SELECT * FROM public.flow_claim_inbound_durable('${A}','${ACC}','instagram','x','${A}','${A}');`,"42501",`${role} execute`,role);
 }
 assert.deepEqual(rows(db,`SELECT relrowsecurity AS rls,(SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid)::int AS policies
  FROM pg_class c WHERE c.oid IN('public.automation_flow_canary_accounts'::regclass,'public.automation_flow_canary_claims'::regclass)`),
  [{rls:true,policies:0},{rls:true,policies:0}]);
 assert.deepEqual(rows(db,`SELECT prosecdef,proconfig FROM pg_proc WHERE oid='${SIG}'::regprocedure`),
  [{prosecdef:false,proconfig:['search_path=""']}]);
 // The legitimate canary still works after all forged attempts.
 assert.deepEqual(dc(db,"gA"),[{acquired:true,route:"flow"}]);
 assert.deepEqual(rows(db,"SELECT tenant_id,channel_account_id FROM public.automation_flow_canary_claims"),
  [{tenant_id:A,channel_account_id:ACC}]);
 assert.equal(Number(val(db,`SELECT count(*) FROM public.automation_message_claims WHERE tenant_id='${B}' AND route='flow'`)),0);
});

test("(h) production canary retry and lease expiry: failed begin + redelivery idempotent; crashed lease re-leased; one commit, one send",{skip},()=>{
 const db=canaryDb("lease");
 mk(db,"h1");
 assert.deepEqual(dc(db,"h1"),[{acquired:true,route:"flow"}]);
 const begin=(next_step)=>val(db,`SELECT public.flow_begin_durable_run('${A}','${ACC}',e.conv,e.msg,e.mid,'delay',1,'start','sleep',${next_step},
  'sleeping','{}'::jsonb,now()+interval '30 seconds','[{"kind":"delay","idempotencyKey":"d.h1","payload":{"kind":"delay"}}]'::jsonb)
  FROM cc.ev e WHERE e.name='h1'`,SR);
 // Begin fails (rejected arguments): nothing persisted, claim kept.
 assert.equal(begin(0),null);
 assert.equal(Number(val(db,"SELECT count(*) FROM public.automation_flow_runs WHERE provider_event_id='mid.h1'")),0);
 // Redelivery of the same webhook: claim is not re-acquired -> caller stops ("handled").
 assert.deepEqual(dc(db,"h1"),[{acquired:false,route:"flow"}]);
 assert.equal(claims(db,"h1"),"1:flow");assert.equal(audit(db),1);
 // The (single) successful begin; a repeated begin for the same event is inert.
 const run=begin(1);
 assert.match(String(run),/^[0-9a-f-]{36}$/);
 assert.equal(begin(1),null,"receipt makes begin idempotent per event");
 assert.equal(Number(val(db,"SELECT count(*) FROM public.automation_flow_runs WHERE provider_event_id='mid.h1'")),1);
 // Due; worker 1 leases and crashes.
 ok(db,{sql:`UPDATE public.automation_flow_runs SET wake_at=now()-interval '1 second' WHERE id='${run}';`},"due");
 const l1=rows(db,"SELECT run_id,lease_token FROM public.flow_lease_due_runs(20)",SR);
 assert.deepEqual(l1.map(r=>r.run_id),[run]);
 assert.deepEqual(rows(db,"SELECT run_id FROM public.flow_lease_due_runs(20)",SR),[],"held lease not re-leased");
 ok(db,{sql:`UPDATE public.automation_flow_run_leases SET expires_at=now()-interval '1 second' WHERE run_id='${run}';`},"expire");
 const l2=rows(db,"SELECT run_id,lease_token FROM public.flow_lease_due_runs(20)",SR);
 assert.deepEqual(l2.map(r=>r.run_id),[run],"expired lease re-leased");
 assert.notEqual(l2[0].lease_token,l1[0].lease_token);
 const commit=tok=>val(db,`SELECT public.flow_commit_run_step('${A}','${run}',1,'sleeping','yes',2,'completed','{}'::jsonb,NULL,
  '[{"kind":"message","idempotencyKey":"m.h1","payload":{"kind":"message","text":"later"}}]'::jsonb,'completed','${tok}')`,SR);
 assert.equal(commit(l1[0].lease_token),false,"crashed worker's stale token rejected");
 assert.equal(commit(l2[0].lease_token),true,"step commits once");
 assert.equal(commit(l2[0].lease_token),false,"never twice");
 const fx=rows(db,`SELECT id,effect_kind FROM public.automation_flow_outbox WHERE run_id='${run}' ORDER BY created_at,effect_kind`);
 assert.deepEqual(fx.map(f=>f.effect_kind).sort(),["delay","message"]);
 const msg=fx.find(f=>f.effect_kind==="message").id;
 // Single send: the outbox reservation (send lock) succeeds exactly once.
 assert.equal(val(db,`SELECT public.flow_reserve_outbox_delivery('${A}','${msg}')`,SR),true);
 assert.equal(val(db,`SELECT public.flow_reserve_outbox_delivery('${A}','${msg}')`,SR),false);
 assert.equal(Number(val(db,`SELECT count(*) FROM public.automation_flow_delivery_attempts WHERE outbox_id='${msg}'`)),1);
});

test("(i) migration: preflight refusal, idempotent re-apply, rollback guard + opt-in, exact pre-170000 fingerprints",{skip},()=>{
 // Preflight: refused on a chain without 160000 / with a foreign object.
 const pre160=clone("pf");
 ok(pre160,{file:OLDER_RB[0]},"160000 rollback");
 refused(pre160,MIG,/apply 20261029160000_flow_credits_pause first/,"170000 without 160000");
 const foreign=clone("pf");
 ok(foreign,{sql:"CREATE TABLE public.automation_flow_canary_accounts(x int);"},"foreign table");
 refused(foreign,MIG,/Unrecognized existing table public\.automation_flow_canary_accounts/,"foreign table");
 const foreignFn=clone("pf");
 ok(foreignFn,{sql:`CREATE FUNCTION public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)
  RETURNS TABLE(acquired boolean,route text,claim_id uuid,outgoing_message_id uuid) LANGUAGE sql AS 'SELECT true,''flow'',NULL::uuid,NULL::uuid';`},"foreign fn");
 refused(foreignFn,MIG,/Unrecognized existing function public\.flow_claim_inbound_durable/,"foreign function");
 const noCol=clone("pf");
 ok(noCol,{sql:"ALTER TABLE public.automation_flow_tenant_switches RENAME COLUMN production_approved TO pa;"},"no column");
 refused(noCol,MIG,/boolean column public\.automation_flow_tenant_switches\.production_approved/,"no production_approved");
 // Apply / re-apply / rollback.
 const db=clone("mig");
 const pre=fp(db),preSchema=fp(db,false),oldFn=ok(db,{sql:OLD_FN},"old");
 refused(db,RB,/20261029170000_flow_canary_claim_durable not installed; nothing to roll back/,"rollback before apply");
 ok(db,{file:MIG},"170000");
 const once=fp(db,false);
 ok(db,{file:MIG},"170000 re-applied");
 assert.equal(fp(db,false),once,"re-apply is a no-op");
 for(const f of OLDER_RB)refused(db,f,/roll back 20261029170000_flow_canary_claim_durable first/,f);
 // Without data the rollback restores the exact pre-170000 schema + data.
 ok(db,{file:RB},"170000 rollback (empty)");
 assert.equal(fp(db),pre,"pre-170000 schema+data fingerprint restored");
 assert.equal(ok(db,{sql:OLD_FN},"old"),oldFn);
 refused(db,RB,/nothing to roll back/,"rollback twice");
 // With a registration and canary claims: refused unless the operator opts in.
 ok(db,{file:MIG},"170000 again");
 assert.equal(fp(db,false),once,"re-apply after rollback reproduces the schema");
 ok(db,{sql:REGISTER()},"register");mk(db,"i1");
 assert.deepEqual(dc(db,"i1"),[{acquired:true,route:"flow"}]);
 refused(db,RB,/1 canary registration\(s\) and 1 canary claim audit row\(s\) would be lost/,"rollback with data");
 refused(db,RB,/would be lost/,"wrong opt-in value",{PGOPTIONS:"-c flow.rollback_170000=yes"});
 ok(db,{file:RB,env:{PGOPTIONS:OPT_IN}},"170000 rollback (explicit opt-in)");
 assert.equal(fp(db,false),preSchema,"pre-170000 schema fingerprint restored");
 assert.equal(ok(db,{sql:OLD_FN},"old"),oldFn,"V2 function still identical");
 assert.equal(claims(db,"i1"),"1:flow","claims themselves are kept by the rollback");
 // Correct order continues: 160000 rollback is accepted now.
 ok(db,{file:OLDER_RB[0]},"160000 rollback after 170000 rollback");
});

test("(i) predeploy checks report the 170000 objects and verify the intended canary registration (read only)",{skip},()=>{
 const db=clone("pdc");
 const run=(opts="")=>{
  const r=psql(db,{file:CHECKS,tab:true,env:opts?{PGOPTIONS:opts}:{}});
  assert.equal(r.status,0,r.stderr);
  return r.stdout.split("\n").map(l=>l.split("\t")).filter(c=>c.length===7)
   .map(([section,item,status,tenant_id,n,ids,detail])=>({section,item,status,tenant_id,n,ids,detail}));
 };
 const get=(rs,item)=>{const m=rs.filter(r=>r.item===item);assert.equal(m.length,1,item);return m[0];};
 const want=(t,a)=>`-c flow.canary_tenant=${t} -c flow.canary_account=${a}`;
 let rs=run();
 assert.equal(get(rs,"canary_registration").status,"ABSENT");
 assert.equal(get(rs,"canary_claim_function").status,"ABSENT");
 assert.equal(get(rs,`claim_v2_unchanged:${OLD_SIG}`).status,"OK");
 assert.equal(get(rs,`function:${SIG}`).status,"ABSENT");
 ok(db,{file:MIG},"170000");
 rs=run();
 for(const i of ["canary_claim_function","canary_table:public.automation_flow_canary_accounts",
  "canary_table:public.automation_flow_canary_claims",`function:${SIG}`,`claim_v2_unchanged:${OLD_SIG}`])
  assert.equal(get(rs,i).status,"OK",`${i}: ${get(rs,i).detail}`);
 assert.equal(get(rs,"canary_registration").status,"INFO");
 assert.equal(get(rs,"canary_registration").n,"0");
 assert.ok(!rs.some(r=>r.status.startsWith("CONFLICT")),JSON.stringify(rs.filter(r=>r.status.startsWith("CONFLICT"))));
 assert.equal(get(run(want(A,ACC)),"canary_registration").status,"MISSING: canary registration");
 ok(db,{sql:REGISTER()},"register");
 let r=get(run(want(A,ACC)),"canary_registration");
 assert.equal(r.status,"OK",r.detail);assert.equal(r.tenant_id,A);assert.equal(r.ids,ACC);
 assert.equal(get(run(want(A,ACC2)),"canary_registration").status,"CONFLICT: canary registration","registered account differs");
 assert.equal(get(run(want(A,ACCB)),"canary_registration").status,"CONFLICT: canary registration","account of another tenant");
 assert.equal(get(run(want(B,ACCB)),"canary_registration").status,"MISSING: canary registration");
 assert.equal(get(run(want("nope",ACC)),"canary_registration").status,"WARN");
 ok(db,{sql:`UPDATE public.automation_flow_tenant_switches SET test_only=true WHERE tenant_id='${A}';`},"test_only");
 r=get(run(want(A,ACC)),"canary_registration");
 assert.equal(r.status,"WARN");assert.match(r.detail,/not eligible yet: tenant test_only off/);
 // Tampering is detected.
 ok(db,{sql:"GRANT INSERT ON public.automation_flow_canary_accounts TO service_role;"},"tamper grant");
 assert.equal(get(run(),"canary_table:public.automation_flow_canary_accounts").status,
  "CONFLICT: public.automation_flow_canary_accounts privileges");
 ok(db,{sql:"GRANT EXECUTE ON FUNCTION public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid) TO anon;"},"tamper fn");
 assert.match(get(run(),"canary_claim_function").status,/privileges$/);
});
