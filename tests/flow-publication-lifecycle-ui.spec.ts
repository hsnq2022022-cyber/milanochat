import { test, expect, type Page } from "@playwright/test";

/**
 * Same fake-host guard as flow-delivery-publication-ui.spec.ts:
 *   VITE_SUPABASE_URL=http://mock.supabase.test VITE_SUPABASE_ANON_KEY=fake-anon-key npx playwright test tests/flow-publication-lifecycle-ui.spec.ts
 * Every edge-function call is fulfilled by page.route; nothing leaves the machine.
 */
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const TENANT = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;

test.skip(!URL_.startsWith("http://mock."), "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

async function setup(page: Page, handlers: { review?: unknown; publication?: (b: any) => unknown; delayMs?: number }) {
  const calls: any[] = [];
  const ref = new URL(URL_).hostname.split(".")[0];
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    `sb-${ref}-auth-token`,
    JSON.stringify({
      access_token: FAKE_JWT, refresh_token: "r", token_type: "bearer", expires_in: 3600,
      expires_at: 4102444800,
      user: { id: "u1", aud: "authenticated", role: "authenticated", email: "t@example.test", app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" },
    }),
  ]);
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    const body = req.postDataJSON?.() ?? {};
    calls.push({ path: u.pathname, body });
    if (u.pathname.endsWith("/flow-delivery-review")) {
      return json(body.mode === "metrics" ? { events: {}, periodDays: 30, truncated: false } : handlers.review);
    }
    if (u.pathname.endsWith("/flow-publication")) {
      if (handlers.delayMs && ["activate", "rollback", "deactivate"].includes(body.action)) await new Promise((r) => setTimeout(r, handlers.delayMs));
      return json(handlers.publication?.(body) ?? { ok: false });
    }
    if (u.pathname.endsWith("/milan-api")) {
      const action = u.searchParams.get("action");
      if (action === "summary") return json({ tenant: { id: TENANT, businessName: "متجر تجريبي", isActive: true, creditsRemaining: 10, phone: "" }, wa: { status: "none" }, openUnresolved: 0 });
      return json(action === "agent_prompt" ? { prompt: null } : []);
    }
    return json({});
  });
  return calls;
}

/** Stateful fake server: state.active = null | revision. */
function server(state: { active: number | null }, opts: { canActivate?: boolean; reject?: string[] } = {}) {
  return (b: any) => {
    const rejected = opts.reject?.includes(b.action);
    switch (b.action) {
      case "accounts": return { ok: true, accounts: [{ id: ACCOUNT, platform: "instagram", is_active: true, canActivate: opts.canActivate ?? true }] };
      case "catalog": return { ok: true, flows: [], active: null };
      case "list": return { ok: true, items: [{ revision: 2, created_at: "2025-01-01" }, { revision: 1, created_at: "2024-12-01" }], activation: { revision: state.active ?? 2, is_active: state.active !== null } };
      case "activate": case "rollback":
        if (rejected) return { ok: false, error: "not_allowed" };
        state.active = b.revision; return { ok: true };
      case "deactivate":
        if (rejected) return { ok: false, error: "not_allowed" };
        state.active = null; return { ok: true };
      default: return { ok: false, error: "unexpected" };
    }
  };
}

async function openPanel(page: Page) {
  page.on("dialog", (d) => void d.accept());
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-publications").click();
  const dialog = page.getByRole("dialog", { name: "الإصدارات المنشورة" });
  await dialog.getByRole("combobox").first().selectOption(ACCOUNT);
  await dialog.getByRole("button", { name: "عرض الإصدارات" }).click();
  return dialog;
}
const mutations = (calls: any[]) => calls.filter((c) => ["activate", "rollback", "deactivate"].includes(c.body.action));

test("activate sends exact payload once (double click) and UI follows the server", async ({ page }) => {
  const state = { active: null as number | null };
  const calls = await setup(page, { publication: server(state), delayMs: 300 });
  const dialog = await openPanel(page);
  await expect(dialog.getByText("التفعيل معطّل")).toBeVisible();
  await dialog.getByRole("button", { name: "تفعيل فعلي" }).first().dblclick();
  await expect(dialog.getByText("الإصدار النشط: 2")).toBeVisible();
  const m = mutations(calls);
  expect(m).toHaveLength(1);
  expect(m[0].body).toMatchObject({ action: "activate", accountId: ACCOUNT, revision: 2 });
  expect(typeof m[0].body.flowKey).toBe("string");
});

test("rollback sends exact payload for the chosen revision; active revision button is disabled", async ({ page }) => {
  const state = { active: 2 as number | null };
  const calls = await setup(page, { publication: server(state), delayMs: 300 });
  const dialog = await openPanel(page);
  await expect(dialog.getByText("الإصدار النشط: 2")).toBeVisible();
  const rollbacks = dialog.getByRole("button", { name: "الرجوع لهذا الإصدار" });
  await expect(rollbacks.nth(0)).toBeDisabled();
  await rollbacks.nth(1).dblclick();
  await expect(dialog.getByText("الإصدار النشط: 1")).toBeVisible();
  const m = mutations(calls);
  expect(m).toHaveLength(1);
  expect(m[0].body).toMatchObject({ action: "rollback", accountId: ACCOUNT, revision: 1 });
});

test("deactivate payload has no revision; rejected server keeps state and shows error", async ({ page }) => {
  const state = { active: 2 as number | null };
  const calls = await setup(page, { publication: server(state, { reject: ["deactivate", "rollback", "activate"] }) });
  const dialog = await openPanel(page);
  await dialog.getByRole("button", { name: "إيقاف التدفق" }).click();
  await expect(dialog.getByText("رفض الخادم التغيير", { exact: false })).toBeVisible();
  await expect(dialog.getByText("الإصدار النشط: 2")).toBeVisible();
  await dialog.getByRole("button", { name: "الرجوع لهذا الإصدار" }).nth(1).click();
  await expect(dialog.getByText("رفض الخادم التغيير", { exact: false })).toBeVisible();
  await expect(dialog.getByText("الإصدار النشط: 2")).toBeVisible();
  const m = mutations(calls);
  expect(m.map((c) => c.body.action)).toEqual(["deactivate", "rollback"]);
  expect(m[0].body).toMatchObject({ action: "deactivate", accountId: ACCOUNT });
  expect("revision" in m[0].body).toBe(false);
  expect(state.active).toBe(2);
});

test("rejected activate leaves activation OFF", async ({ page }) => {
  const state = { active: null as number | null };
  await setup(page, { publication: server(state, { reject: ["activate"] }) });
  const dialog = await openPanel(page);
  await dialog.getByRole("button", { name: "تفعيل فعلي" }).first().click();
  await expect(dialog.getByText("رفض الخادم التغيير", { exact: false })).toBeVisible();
  await expect(dialog.getByText("التفعيل معطّل")).toBeVisible();
});

test("account not approved for activation exposes no activate/rollback control", async ({ page }) => {
  const state = { active: null as number | null };
  const calls = await setup(page, { publication: server(state, { canActivate: false }) });
  const dialog = await openPanel(page);
  await expect(dialog.getByText("التفعيل معطّل")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /تفعيل|الرجوع لهذا الإصدار/ })).toHaveCount(0);
  expect(mutations(calls)).toHaveLength(0);
});

test("delivery review renders runCounts, flowFailures cancel_reason and the flowAvailable:false fallback", async ({ page }) => {
  const calls = await setup(page, {
    review: {
      items: [], readOnly: true, flowAvailable: false, runCounts: { blocked: 4, completed: 7 },
      flowFailures: [{ id: "f1", effect_kind: "text", delivery_status: "dead_letter", attempts: 2, created_at: null, cancel_reason: "no_knowledge" }],
      flowItems: [],
    },
  });
  await page.goto("/milanochat/#/settings");
  const panel = page.getByTestId("delivery-review-panel");
  const counts = panel.getByRole("region", { name: "حالة تشغيلات التدفقات" });
  await expect(counts).toContainText("بيانات التدفقات المتقدمة غير متاحة كاملة حاليًا");
  await expect(counts.getByText("متوقفة").locator("xpath=..")).toContainText("4");
  await expect(counts.getByText("مكتملة").locator("xpath=..")).toContainText("7");
  await expect(panel.getByTestId("flow-cancel-reason")).toContainText("لا توجد معرفة كافية");
  expect(calls.every((c) => !c.path.includes("send"))).toBe(true);
});

/** Readiness contract: new kinds use `configured`; old-shape responses fall back to per-kind flags. */
const allChecks = (over: Record<string, boolean> = {}) => ({ instagram: true, tenant: true, account: true, scheduler: true, buttons: true, ...over });
const readinessServer = (state: { active: number | null }, readiness: unknown) => {
  const base = server(state);
  return (b: any) => (b.action === "readiness" ? { ok: true, candidateRevision: 2, readiness } : base(b));
};
const cases: { name: string; readiness: any; line: string; ok: boolean; missing?: string }[] = [
  { name: "text configured", readiness: { candidateKind: "text", configured: true, needsButtons: false, needsScheduler: false, buttonsConfigured: false, delayConfigured: false, checks: allChecks({ scheduler: false, buttons: false }) }, line: "تدفق نصي / جمع بيانات: الإعدادات مكتملة", ok: true },
  { name: "mixed configured", readiness: { candidateKind: "mixed", configured: true, needsButtons: true, needsScheduler: true, buttonsConfigured: false, delayConfigured: false, checks: allChecks() }, line: "تدفق مختلط (أزرار وتأخير): الإعدادات مكتملة", ok: true },
  { name: "mixed missing scheduler", readiness: { candidateKind: "mixed", configured: false, needsButtons: true, needsScheduler: true, buttonsConfigured: false, delayConfigured: false, checks: allChecks({ scheduler: false }) }, line: "تدفق مختلط (أزرار وتأخير): الإعدادات غير مكتملة", ok: false, missing: "• جدولة التأخير" },
  { name: "text not configured (base gate)", readiness: { candidateKind: "text", configured: false, needsButtons: false, needsScheduler: false, buttonsConfigured: false, delayConfigured: false, checks: allChecks({ tenant: false, scheduler: false, buttons: false }) }, line: "تدفق نصي / جمع بيانات: الإعدادات غير مكتملة", ok: false, missing: "• نشاط المتجر" },
  { name: "old buttons shape configured", readiness: { candidateKind: "buttons", buttonsConfigured: true, delayConfigured: false, checks: allChecks({ scheduler: false }) }, line: "الأزرار التفاعلية: الإعدادات مكتملة", ok: true },
  { name: "old delay shape not configured", readiness: { candidateKind: "delay", buttonsConfigured: false, delayConfigured: false, checks: allChecks({ scheduler: false }) }, line: "الرسائل المؤجلة: الإعدادات غير مكتملة", ok: false, missing: "• جدولة التأخير" },
  { name: "unsupported unchanged", readiness: { candidateKind: "unsupported", configured: false, buttonsConfigured: false, delayConfigured: false, checks: allChecks({ buttons: false, scheduler: false }) }, line: "هذا الإصدار ليس تدفق أزرار أو تأخير مدعومًا.", ok: false },
];
for (const c of cases) {
  test(`readiness ${c.name}`, async ({ page }) => {
    const state = { active: null as number | null };
    const calls = await setup(page, { publication: readinessServer(state, c.readiness) });
    const dialog = await openPanel(page);
    await dialog.getByRole("button", { name: "فحص جاهزية الإصدار" }).first().click();
    const report = dialog.getByTestId("flow-readiness-report");
    await expect(report).toContainText(c.line);
    if (c.missing) await expect(report).toContainText(c.missing);
    // Buttons/scheduler items are only listed when the kind needs them.
    if (c.readiness.candidateKind === "text") await expect(report).not.toContainText("جدولة التأخير");
    if (c.ok) await expect(report).not.toContainText("•");
    // Activation control rule is unchanged: driven by canActivate, not by the readiness report.
    const activate = dialog.getByRole("button", { name: "تفعيل فعلي" }).first();
    await expect(activate).toBeEnabled();
    if (c.ok) {
      await activate.click();
      await expect(dialog.getByText("الإصدار النشط: 2")).toBeVisible();
      expect(mutations(calls)[0].body).toMatchObject({ action: "activate", accountId: ACCOUNT, revision: 2 });
    }
  });
}

/** Comment-trigger readiness: status and labels are rendered exactly as the server sends them. */
const commentReport = (status: "supported" | "unsupported", platform: "instagram" | "facebook", over: Record<string, unknown> = {}) => {
  const label = platform === "facebook"
    ? { ar: "مشغّل التعليقات (صفحة Facebook)", en: "Comment trigger (Facebook Page)" }
    : { ar: "مشغّل التعليقات (Instagram)", en: "Comment trigger (Instagram)" };
  const ok = status === "supported";
  return {
    candidateKind: "comment", configured: ok, needsButtons: false, needsScheduler: false, buttonsConfigured: false, delayConfigured: false,
    checks: { commentTrigger: ok, tenant: true, account: true, supportedCandidate: true, scheduler: false, buttons: false },
    commentTrigger: { platform, supported: ok, status, label, reason: ok ? "ok" : "comment_automation_off",
      statusLabel: ok ? { ar: "مدعوم", en: "Supported" } : { ar: "غير مدعوم", en: "Not supported" },
      detail: ok ? { ar: "مفعّل على الخادم", en: "Enabled on the server" } : { ar: "أتمتة التعليقات غير مفعّلة على الخادم.", en: "off" } },
    checkLabels: { commentTrigger: label },
    ...over,
  };
};
for (const platform of ["instagram", "facebook"] as const) {
  test(`readiness comment flow (${platform}) supported shows «مدعوم» from the server`, async ({ page }) => {
    const state = { active: null as number | null };
    await setup(page, { publication: readinessServer(state, commentReport("supported", platform)) });
    const dialog = await openPanel(page);
    await dialog.getByRole("button", { name: "فحص جاهزية الإصدار" }).first().click();
    const report = dialog.getByTestId("flow-readiness-report");
    const check = report.getByTestId("flow-readiness-comment-trigger");
    await expect(check).toHaveAttribute("data-status", "supported");
    await expect(report.getByTestId("flow-readiness-comment-status")).toHaveText("مدعوم");
    await expect(check).toContainText(platform === "facebook" ? "صفحة Facebook" : "(Instagram)");
    await expect(report).toContainText("تدفق تعليقات: الإعدادات مكتملة");
    await expect(report).not.toContainText("غير مدعوم");
    await expect(report).not.toContainText("قناة Instagram");
    await expect(report).not.toContainText("ليس تدفق أزرار أو تأخير");
    await expect(report).not.toContainText("•");
  });
}
test("readiness comment flow with server flags off shows «غير مدعوم» and the platform-specific missing check", async ({ page }) => {
  const state = { active: null as number | null };
  await setup(page, { publication: readinessServer(state, commentReport("unsupported", "facebook")) });
  const dialog = await openPanel(page);
  await dialog.getByRole("button", { name: "فحص جاهزية الإصدار" }).first().click();
  const report = dialog.getByTestId("flow-readiness-report");
  await expect(report.getByTestId("flow-readiness-comment-trigger")).toHaveAttribute("data-status", "unsupported");
  await expect(report.getByTestId("flow-readiness-comment-status")).toHaveText("غير مدعوم");
  await expect(report).toContainText("تدفق تعليقات: الإعدادات غير مكتملة");
  await expect(report).toContainText("• مشغّل التعليقات (صفحة Facebook)");
  await expect(report).not.toContainText("Instagram");
});
