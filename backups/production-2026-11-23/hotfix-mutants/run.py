import subprocess, re, os, sys
S="/tmp/claude-0/-home-user-milanochat/b83f4a81-cf0b-5d1e-b57f-3a22ee1b536e/scratchpad"
W=f"{S}/hotfix-work"; P=f"{S}/prod-snapshots"; M=f"{S}/hotfix-mutants"
base={"meta":f"{W}/meta-auth.v63.hotfix.index.ts","chan":f"{W}/channels.v112.hotfix.index.ts","api":f"{W}/api.v108.hotfix.index.ts"}
orig={"meta":f"{P}/meta-auth.v63.index.ts","chan":f"{P}/channels.v112.index.ts","api":f"{P}/api.v108.index.ts"}
src={k:open(v,encoding="utf8").read() for k,v in base.items()}
test=open(f"{S}/hotfix-tests/behavior.test.ts",encoding="utf8").read()
def rep(k,a,b):
    assert src[k].count(a)==1,(k,a[:60],src[k].count(a)); return src[k].replace(a,b)
M_=[]  # (id, module, description, mutated_text or None=use original)
def add(i,k,d,txt): M_.append((i,k,d,txt))
add("M1","meta","restore original /debug + logs (full original)",None)
add("M2","meta","re-add token-exchange redirect_uri log","meta" and rep("meta","const redirectUri = canonicalIgRedirect();\n","const redirectUri = canonicalIgRedirect();\n    console.log(\"[meta-auth] token exchange redirect_uri =\", JSON.stringify(redirectUri));\n"))
add("M3","meta","final catch logs full error object",rep("meta",'console.error("[meta-auth] unexpected error:", e instanceof Error ? e.name : "unknown");','console.error("[meta-auth]", e);'))
add("M4","meta","subscribed_apps catch logs e.message",rep("meta",'console.error("[meta-auth] subscribed_apps error:", e instanceof Error ? e.name : "unknown");','console.error("[meta-auth] subscribed_apps error:", e instanceof Error ? e.message : e);'))
add("M5","meta","subscribed_apps failure logs the whole JSON body",rep("meta",'sJson?.error ? metaErrTag(sJson) : "no_success"','JSON.stringify(sJson)'))
add("M6","meta","state verified with wrong secret",rep("meta","verifyState(state, igSecret)","verifyState(state, igSecret + 'x')"))
add("M7","meta","state expiry check removed",rep("meta","Date.now() / 1000 > Number(p.exp)","false"))
add("M8","meta","platform check removed",rep("meta",'    if (st.platform !== "instagram") return fail("oauth_state_platform_mismatch");\n',''))
add("M9","meta","redirect_uri taken from secret instead of canonical",rep("meta","const redirectUri = canonicalIgRedirect();","const redirectUri = Deno.env.get(\"INSTAGRAM_REDIRECT_URI\")!;"))
add("M10","meta","/debug returning only app id (new minimal leak)",rep("meta",'  // ─── FIX: channels يبني','  if (req.method === "GET" && url.pathname.endsWith("/debug")) return new Response(JSON.stringify({ id: Deno.env.get("INSTAGRAM_APP_ID") }));\n\n  // ─── FIX: channels يبني'))
add("C1","chan","re-add IG-DIAG log of redirect secret",rep("chan",'        const result: Record<string, unknown> = { url: igUrl, state, provider: "instagram" };','        console.log("[IG-DIAG] INSTAGRAM_REDIRECT_URI (secret) =", JSON.stringify(Deno.env.get("INSTAGRAM_REDIRECT_URI")));\n        const result: Record<string, unknown> = { url: igUrl, state, provider: "instagram" };'))
add("C2","chan","re-add debug fields (instagram)",rep("chan",'        const result: Record<string, unknown> = { url: igUrl, state, provider: "instagram" };','        const result: Record<string, unknown> = { url: igUrl, state, provider: "instagram" };\n        if (query.get("debug") === "1") result.debug = { clientId: igAppId };'))
add("C3","chan","re-add debug fields (facebook)",rep("chan",'      const fbResult: Record<string, unknown> = { url: oauthUrl, state, provider: "facebook" };','      const fbResult: Record<string, unknown> = { url: oauthUrl, state, provider: "facebook" };\n      if (query.get("debug") === "1") fbResult.debug = { clientId: appId };'))
add("C4","chan","PATCH returns raw error.message",rep("chan",'        console.error("[channels] account update failed:", error.code ?? "unknown");\n        return jsonResponse({ error: "خطأ داخلي" }, 500);','        return jsonResponse({ error: error.message }, 500);'))
add("C5","chan","DELETE returns raw error.message",rep("chan",'        console.error("[channels] account disconnect failed:", error.code ?? "unknown");\n        return jsonResponse({ error: "خطأ داخلي" }, 500);','        return jsonResponse({ error: error.message }, 500);'))
add("C6","chan","fatal returns e.message",rep("chan",'    console.error("[channels] fatal:", e instanceof Error ? e.name : "unknown");\n    return jsonResponse({ error: "خطأ داخلي" }, 500);','    console.error("[channels] fatal:", e instanceof Error ? e.name : "unknown");\n    return jsonResponse({ error: e?.message ?? "خطأ داخلي" }, 500);'))
add("C7","chan","fatal logs full error object",rep("chan",'console.error("[channels] fatal:", e instanceof Error ? e.name : "unknown");','console.error("[channels] fatal:", e);'))
add("C8","chan","accounts select logs full error object",rep("chan",'console.error("[Channels] accounts select error:", error.code ?? "unknown");','console.error("[Channels] accounts select error:", error);'))
add("C9","chan","instagram state signed with META secret",rep("chan",'userId, tenantId: tenant.id, platform: "instagram", secret: igSecret,','userId, tenantId: tenant.id, platform: "instagram", secret: envTrim("META_APP_SECRET") ?? igSecret,'))
add("C10","chan","state TTL 15m -> 5m",rep("chan","15 * 60","5 * 60"))
add("C11","chan","state payload key u -> user",rep("chan","{ u: opts.userId,","{ user: opts.userId,"))
add("C12","chan","instagram scope dropped",rep("chan",'          "instagram_business_manage_messages",\n',''))
add("C13","chan","always use direct login (fallback removed)",rep("chan",'if (channel === "instagram" && directFlag) {','if (channel === "instagram") {'))
add("C14","chan","facebook redirect_uri changed",rep("chan","/functions/v1/meta-auth/facebook/callback`;","/functions/v1/meta-auth/facebook/cb`;"))
add("A1","api","restore original /db-test (full original)",None)
add("A2","api","CORS origin changed",rep("api",'"Access-Control-Allow-Origin": "*"','"Access-Control-Allow-Origin": "https://x.example"'))
add("A3","api","health payload changed",rep("api",'service: "edge-api"','service: "edge-api-v2"'))
add("A4","api","unknown route 404 body changed",rep("api",'error: "Not found",','error: "nf",'))

add("M11","meta","claim error logs raw message (URL+nonce)",rep("meta",'dbErrTag(claimErr)','claimErr.message'))
add("M12","meta","upsert error logs raw message (URL+params)",rep("meta",'dbErrTag(upErr)','upErr.message'))
add("M13","meta","reflected error param logged via fail() (original behavior)",rep("meta",'''    if (metaError === "access_denied") return fail("user_cancelled");
    if (metaError) {
      // The value is attacker-controlled: it is still passed back to the client unchanged
      // (same redirect), but never written to logs.
      console.warn("[meta-auth] FAILED -> provider_error");
      return back({ channel_error: metaError });
    }''','''    if (metaError) return fail(metaError === "access_denied" ? "user_cancelled" : metaError);'''))
add("M14","meta","provider-error branch logs the attacker value",rep("meta",'console.warn("[meta-auth] FAILED -> provider_error");','console.warn("[meta-auth] FAILED ->", metaError);'))
add("M15","meta","provider-error redirect value changed (contract)",rep("meta",'return back({ channel_error: metaError });','return back({ channel_error: "oauth_error" });'))
add("M16","meta","dbErrTag returns the raw message",rep("meta",'function dbErrTag(err: any): string {\n','function dbErrTag(err: any): string {\n  return String(err?.message);\n'))
add("M19","meta","access_denied mapping removed",rep("meta",'    if (metaError === "access_denied") return fail("user_cancelled");\n',''))
add("M20","meta","nonce claim no longer requires consumed=false",rep("meta",'      .eq("consumed", false)\n',''))
add("M21","meta","nonce claim writes consumed:false",rep("meta",'.update({ consumed: true })','.update({ consumed: false })'))
add("M22","meta","token exchange grant_type changed",rep("meta",'grant_type: "authorization_code",','grant_type: "client_credentials",'))
add("M23","meta","facebook callback code changed",rep("meta",'return fail("facebook_callback_not_supported");','return fail("ok");'))
add("M24","meta","state HMAC hash SHA-256 -> SHA-512",rep("meta",'{ name: "HMAC", hash: "SHA-256" }','{ name: "HMAC", hash: "SHA-512" }'))
add("C0","chan","restore original channels (full vulnerable v112)",None)
add("C15","chan","warn logs the redirect secret value",rep("chan",'console.warn("[channels] INSTAGRAM_REDIRECT_URI secret differs from the canonical redirect");','console.warn("[channels] INSTAGRAM_REDIRECT_URI secret differs", igRedirectEnv);'))
add("C16","chan","facebook scope dropped",rep("chan",'"pages_show_list", "pages_messaging", "pages_manage_metadata",','"pages_show_list", "pages_manage_metadata",'))
add("C17","chan","default-tenant create error logged as full object",rep("chan",'createErr.code ?? "unknown"','createErr'))
add("C18","chan","account update failure logs full error object",rep("chan",'console.error("[channels] account update failed:", error.code ?? "unknown");','console.error("[channels] account update failed:", error);'))
add("C19","chan","account disconnect failure logs full error object",rep("chan",'console.error("[channels] account disconnect failed:", error.code ?? "unknown");','console.error("[channels] account disconnect failed:", error);'))

add("M25","meta","token-exchange log prints Meta free-text message",rep("meta",'metaErrTag(tJson)','tJson?.error_message ?? tJson?.error?.message ?? "unknown"'))
add("M26","meta","long-lived log prints Meta free-text message",rep("meta",'metaErrTag(lJson)','lJson?.error?.message ?? "unknown"'))
add("M27","meta","/me log prints Meta free-text message",rep("meta",'prof?.error ? metaErrTag(prof) : "no id"','prof?.error?.message ?? "no id"'))
add("M28","meta","subscribed_apps log prints Meta free-text message",rep("meta",'sJson?.error ? metaErrTag(sJson) : "no_success"','sJson?.error?.message ?? "no_success"'))
add("M29","meta","metaErrTag returns the free-text message",rep("meta",'function metaErrTag(j: any): string {\n','function metaErrTag(j: any): string {\n  return String(j?.error?.message ?? j?.error_message ?? "unknown");\n'))
add("M30","meta","Meta error body dumped as JSON in token-exchange log",rep("meta",'metaErrTag(tJson)','JSON.stringify(tJson)'))
add("C20","chan","default-tenant create error logs raw message",rep("chan",'createErr.code ?? "unknown"','createErr.message'))
add("C21","chan","default-tenant create failure no longer returns null (flow change)",rep("chan",'    console.error("[channels] failed to create default tenant:", createErr.code ?? "unknown");\n    return null;','    console.error("[channels] failed to create default tenant:", createErr.code ?? "unknown");\n    return { id: "x", user_id: userId };'))
res=[]
for i,k,d,txt in M_:
    mp=f"{M}/{i}.{k}.mutant.ts"
    open(mp,"w",encoding="utf8").write(txt if txt is not None else open(orig[k],encoding="utf8").read())
    tmpl={'meta':'${S}/hotfix-work/meta-auth.v63.hotfix.index.ts','chan':'${S}/hotfix-work/channels.v112.hotfix.index.ts','api':'${S}/hotfix-work/api.v108.hotfix.index.ts'}[k]
    t=test.replace(tmpl,mp)
    assert t!=test
    tp=f"{M}/{i}.test.ts"; open(tp,"w",encoding="utf8").write(t)
    env=dict(os.environ,DENO_DIR=f"{S}/deno-dir",DENO_CERT="/root/.ccr/ca-bundle.crt")
    r=subprocess.run([f"{S}/deno-bin/deno","test","--no-lock","--node-modules-dir=none",f"--import-map={S}/importmap.json","--allow-env","--allow-read",tp],capture_output=True,text=True,env=env)
    out=re.sub(r"\x1b\[[0-9;]*m","",r.stdout+r.stderr)
    m=re.search(r"(\d+) passed \| (\d+) failed",out)
    failed=[l.split(" ... ")[0] for l in out.splitlines() if l.endswith(tuple([" FAILED"])) or " ... FAILED" in l]
    res.append((i,k,d,m.groups() if m else ("?","?"),failed))
for i,k,d,pf,failed in res:
    status="KILLED" if pf[1] not in ("0","?") else ("SURVIVED" if pf[1]=="0" else "ERROR")
    print(f"{i:4} {k:5} {status:8} passed={pf[0]} failed={pf[1]}  | {d}")
    for f in failed[:3]: print("        ->",f[:110])
