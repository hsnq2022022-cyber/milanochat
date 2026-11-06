import { test, expect, type Page } from "@playwright/test";

/**
 * Requires a Supabase-configured build with a FAKE host so no real network is used:
 *   VITE_SUPABASE_URL=http://mock.supabase.test VITE_SUPABASE_ANON_KEY=fake-anon-key npx playwright test tests/flow-delivery-publication-ui.spec.ts
 * All edge-function calls are fulfilled by page.route mocks; the session is seeded in localStorage.
 */
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const TENANT = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;

test.skip(!URL_.startsWith("http://mock."), "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

async function setup(page: Page, handlers: { review?: unknown; reviewNetworkError?: boolean; publication?: (b: any) => unknown; inbox?: { status: number; body: unknown } }) {
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
  // Nothing may leave the machine: fulfil every request to the fake host.
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    const body = req.postDataJSON?.() ?? {};
    calls.push({ path: u.pathname, body });
    if (u.pathname.endsWith("/flow-delivery-review")) {
      if (handlers.reviewNetworkError) return route.abort("failed");
      return json(body.mode === "metrics" ? { events: { started: 3 }, periodDays: 30, truncated: false } : handlers.review);
    }
    if (u.pathname.endsWith("/flow-staff-inbox")) {
      const inbox = handlers.inbox ?? { status: 200, body: { items: [], readOnly: true } };
      return route.fulfill({ status: inbox.status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(inbox.body) });
    }
    if (u.pathname.endsWith("/flow-publication")) return json(handlers.publication?.(body) ?? { ok: false });
    if (u.pathname.endsWith("/milan-api")) {
      const action = u.searchParams.get("action");
      if (action === "summary") return json({ tenant: { id: TENANT, businessName: "متجر تجريبي", isActive: true, creditsRemaining: 10, phone: "" }, wa: { status: "none" }, openUnresolved: 0 });
      return json(action === "agent_prompt" ? { prompt: null } : []);
    }
    return json({});
  });
  return calls;
}

test("delivery review shows a friendly Arabic message when the edge function is unreachable", async ({ page }) => {
  await setup(page, { reviewNetworkError: true });
  await page.goto("/milanochat/#/dashboard");
  const panel = page.getByTestId("delivery-review-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("delivery-review-unreachable")).toHaveText("تعذر الاتصال بالخادم. يرجى المحاولة لاحقاً");
  await expect(panel.getByText("Failed to fetch")).toHaveCount(0);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "تحديث القائمة" })).toBeVisible();
});

test("delivery review shows cancel_reason labels for V3/V4 flow failures and tolerates unknown/null", async ({ page }) => {
  const calls = await setup(page, {
    review: {
      items: [{ claim_id: "c-v2-1", platform: "instagram", status: "uncertain", provider_message_id: null, attempted_at: "2025-01-01T00:00:00Z", uncertain_at: null, review_status: "pending", review_requested_at: null }], readOnly: true, flowAvailable: true, runCounts: {},
      flowFailures: [
        { id: "f-known", effect_kind: "text", delivery_status: "dead_letter", attempts: 2, created_at: null, cancel_reason: "ai_retries_exhausted" },
        { id: "f-ai", effect_kind: "text", delivery_status: "dead_letter", attempts: 2, created_at: null, cancel_reason: "ai_unavailable" },
        { id: "f-bill", effect_kind: "text", delivery_status: "billing_blocked", attempts: 0, created_at: null, cancel_reason: null },
        { id: "f-bill-missing", effect_kind: "text", delivery_status: "billing_blocked", attempts: 0, created_at: null, cancel_reason: null, ai_last_error_code: "ai_answer_missing" },
        { id: "f-unknown", effect_kind: null, delivery_status: "uncertain", attempts: 1, created_at: null, cancel_reason: "brand_new_code" },
        { id: "f-null", effect_kind: null, delivery_status: "dead_letter", attempts: 1, created_at: null, cancel_reason: null },
      ],
      flowRuns: [
        { id: "r-1", flow_key: "welcome", run_status: "blocked", wake_at: null, updated_at: null, ended_reason: "human_takeover" },
        { id: "r-2", flow_key: "other", run_status: "handoff", wake_at: null, updated_at: null, ended_reason: null },
      ],
      flowItems: [{ outbox_id: "o-1", claim_id: null, status: "uncertain", provider_message_id: null, attempted_at: null, review_status: "pending" }],
    },
  });
  await page.goto("/milanochat/#/dashboard");
  const panel = page.getByTestId("delivery-review-panel");
  await expect(panel).toBeVisible();
  const failures = panel.getByRole("region", { name: "رسائل التدفقات الفاشلة أو غير المؤكدة" });
  const items = failures.getByRole("listitem");
  await expect(items).toHaveCount(6);
  await expect(items.nth(0).getByTestId("flow-cancel-reason")).toHaveText("سبب الفشل: تعذّر إنتاج رد آلي بعد عدة محاولات");
  await expect(items.nth(1).getByTestId("flow-cancel-reason")).toContainText("خدمة الرد الآلي لم تكن متاحة");
  await expect(items.nth(2).getByTestId("flow-cancel-reason")).toHaveCount(0);
  await expect(items.nth(2)).toContainText("موقوف بسبب الرصيد");
  await expect(items.nth(3)).toContainText("موقوف: إجابة مفقودة");
  await expect(items.nth(3)).not.toContainText("موقوف بسبب الرصيد");
  await expect(items.nth(2)).not.toContainText("إجابة مفقودة");
  await expect(items.nth(4).getByTestId("flow-cancel-reason")).toHaveText("سبب الإلغاء: سبب غير معروف");
  await expect(items.nth(5).getByTestId("flow-cancel-reason")).toHaveText("سبب الفشل: السبب غير محدد");
  await expect(panel).not.toContainText("brand_new_code");
  expect(await panel.evaluate((el) => el.outerHTML.includes('title="brand_new_code"') || el.outerHTML.includes('aria-label="brand_new_code"'))).toBe(false);
  await expect(panel).toContainText("c-v2-1");
  const runs = panel.getByRole("region", { name: "تشغيلات تدفقات تحتاج متابعة" }).getByRole("listitem");
  await expect(runs).toHaveCount(2);
  await expect(runs.nth(0).getByTestId("flow-run-ended-reason")).toHaveText("سبب التوقف: تولّى موظف المحادثة");
  await expect(runs.nth(1).getByTestId("flow-run-ended-reason")).toHaveCount(0);
  await expect(panel.getByRole("region", { name: "محاولات إرسال التدفقات بانتظار المراجعة" }).getByRole("listitem")).toHaveCount(1);
  expect(calls.every((c) => !c.path.includes("send"))).toBe(true);
});

test("publication panel shows active, inactive and readiness states from mocked flow-publication", async ({ page }) => {
  let active = true;
  const calls = await setup(page, {
    publication: (b) => {
      if (b.action === "accounts") return { ok: true, accounts: [{ id: ACCOUNT, platform: "instagram", is_active: true, canActivate: true }] };
      if (b.action === "catalog") return { ok: true, flows: [], active: active ? { flow_key: "welcome", revision: 2 } : null };
      if (b.action === "list") return { ok: true, items: [{ revision: 2, created_at: "2025-01-01" }, { revision: 1, created_at: "2024-12-01" }], activation: active ? { revision: 2, is_active: true } : { revision: 2, is_active: false } };
      if (b.action === "deactivate") { active = false; return { ok: true }; }
      if (b.action === "readiness") return { ok: true, candidateRevision: 2, readiness: { candidateKind: "buttons", buttonsConfigured: false, delayConfigured: false, checks: { instagram: true, tenant: false } } };
      return { ok: false, error: "unexpected" };
    },
  });
  page.on("dialog", (d) => void d.accept());
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-publications").click();
  const dialog = page.getByRole("dialog", { name: "الإصدارات المنشورة" });
  await dialog.getByRole("combobox").first().selectOption(ACCOUNT);
  const status = dialog.getByTestId("flow-active-server-status");
  await expect(status).toContainText("welcome · v2");
  await dialog.getByRole("button", { name: "عرض الإصدارات" }).click();
  await expect(dialog.getByText("الإصدار النشط: 2")).toBeVisible();
  await dialog.getByRole("button", { name: "فحص جاهزية الإصدار" }).first().click();
  await expect(dialog.getByTestId("flow-readiness-report")).toContainText("الإعدادات غير مكتملة");
  await dialog.getByRole("button", { name: "إيقاف التدفق" }).click();
  await expect(dialog.getByText("التفعيل معطّل")).toBeVisible();
  expect(calls.some((c) => c.body.action === "deactivate")).toBe(true);
});

const EMPTY_REVIEW = { items: [], readOnly: true, flowAvailable: true, runCounts: {}, flowFailures: [], flowRuns: [], flowItems: [] };

test("delivery review labels internal effect kinds and statuses, unknown values stay generic", async ({ page }) => {
  await setup(page, {
    review: { ...EMPTY_REVIEW, flowFailures: [
      { id: "i-tag", effect_kind: "tag", delivery_status: "dead_letter", attempts: 3, created_at: null, cancel_reason: "revision_inactive" },
      { id: "i-untag", effect_kind: "untag", delivery_status: "cancelled", attempts: 0, created_at: null, cancel_reason: "stale" },
      { id: "i-notify", effect_kind: "staff_notification", delivery_status: "retry_wait", attempts: 1, created_at: null, cancel_reason: null },
      { id: "i-handoff", effect_kind: "handoff", delivery_status: "uncertain", attempts: 1, created_at: null, cancel_reason: "ineligible" },
      { id: "i-new", effect_kind: "brand_new_kind", delivery_status: "brand_new_status", attempts: 0, created_at: null, cancel_reason: null },
    ] },
  });
  await page.goto("/milanochat/#/dashboard");
  const items = page.getByTestId("delivery-review-panel").getByRole("region", { name: "رسائل التدفقات الفاشلة أو غير المؤكدة" }).getByRole("listitem");
  await expect(items).toHaveCount(5);
  await expect(items.nth(0).getByTestId("flow-effect-kind")).toHaveText("إجراء داخلي: إضافة وسم");
  await expect(items.nth(0).getByTestId("flow-delivery-status")).toHaveText("فشل الإرسال");
  await expect(items.nth(0).getByTestId("flow-cancel-reason")).toHaveText("سبب الفشل: نسخة التدفق لم تعد مفعّلة");
  await expect(items.nth(1).getByTestId("flow-effect-kind")).toHaveText("إجراء داخلي: إزالة وسم");
  await expect(items.nth(1).getByTestId("flow-delivery-status")).toHaveText("أُلغي");
  await expect(items.nth(1).getByTestId("flow-cancel-reason")).toHaveText("سبب الإلغاء: انتظرت الرسالة طويلًا ولم تُرسل");
  await expect(items.nth(2).getByTestId("flow-effect-kind")).toHaveText("إجراء داخلي: إشعار للموظف");
  await expect(items.nth(2).getByTestId("flow-delivery-status")).toHaveText("بانتظار إعادة المحاولة");
  await expect(items.nth(3).getByTestId("flow-effect-kind")).toHaveText("إجراء داخلي: تحويل لموظف");
  await expect(items.nth(3).getByTestId("flow-cancel-reason")).toHaveText("سبب الإلغاء: الرسالة غير مؤهلة للإرسال");
  await expect(items.nth(4).getByTestId("flow-effect-kind")).toHaveText("إجراء غير معروف");
  await expect(items.nth(4).getByTestId("flow-delivery-status")).toHaveText("حالة غير معروفة");
  await expect(page.getByTestId("delivery-review-panel")).not.toContainText("brand_new_");
});

test("delivery review lists flowInternal rows with Arabic labels and status badges", async ({ page }) => {
  await setup(page, {
    review: { ...EMPTY_REVIEW, flowInternalAvailable: true, flowInternal: [
      { id: "n-pending", effect_kind: "tag", delivery_status: "pending", attempts: 0, created_at: null, cancel_reason: null },
      { id: "n-leased", effect_kind: "untag", delivery_status: "leased", attempts: 1, created_at: null, cancel_reason: null },
      { id: "n-retry", effect_kind: "staff_notification", delivery_status: "retry_wait", attempts: 2, created_at: null, cancel_reason: null },
      { id: "n-settled", effect_kind: "handoff", delivery_status: "settled", attempts: 1, created_at: null, cancel_reason: null },
      { id: "n-cancel", effect_kind: "tag", delivery_status: "cancelled", attempts: 0, created_at: null, cancel_reason: "human_takeover", cancelled_at: null },
    ] },
  });
  await page.goto("/milanochat/#/dashboard");
  const sec = page.getByRole("region", { name: "الإجراءات الداخلية" });
  const rows = sec.getByTestId("flow-internal-row");
  await expect(rows).toHaveCount(5);
  const exp: Array<[string, string]> = [["إجراء داخلي: إضافة وسم", "بانتظار التنفيذ"], ["إجراء داخلي: إزالة وسم", "قيد التنفيذ"], ["إجراء داخلي: إشعار للموظف", "بانتظار إعادة المحاولة"], ["إجراء داخلي: تحويل لموظف", "نُفّذ"], ["إجراء داخلي: إضافة وسم", "أُلغي"]];
  for (let i = 0; i < exp.length; i++) {
    await expect(rows.nth(i).getByTestId("flow-internal-kind")).toHaveText(exp[i][0]);
    await expect(rows.nth(i).getByTestId("flow-internal-status")).toHaveText(exp[i][1]);
  }
  await expect(rows.nth(4).getByTestId("flow-internal-cancel-reason")).toHaveText("سبب الإلغاء: تولّى موظف المحادثة");
  await expect(sec.getByTestId("flow-internal-unavailable")).toHaveCount(0);
});

test("delivery review internal section: empty when available, neutral note when unavailable or missing", async ({ page }) => {
  await setup(page, { review: { ...EMPTY_REVIEW, flowInternalAvailable: true, flowInternal: [] } });
  await page.goto("/milanochat/#/dashboard");
  await expect(page.getByTestId("flow-internal-empty")).toHaveText("لا توجد إجراءات داخلية حديثة.");
  await expect(page.getByTestId("flow-internal-unavailable")).toHaveCount(0);
  await page.unroute(`${URL_}/**`);
  await setup(page, { review: { ...EMPTY_REVIEW, flowInternalAvailable: false, flowInternal: [] } });
  await page.reload();
  await expect(page.getByTestId("flow-internal-unavailable")).toHaveText("حالة الإجراءات الداخلية غير متاحة حاليًا.");
  await expect(page.getByTestId("flow-internal-empty")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.unroute(`${URL_}/**`);
  await setup(page, { review: EMPTY_REVIEW });
  await page.reload();
  await expect(page.getByTestId("flow-internal-unavailable")).toBeVisible();
  await expect(page.getByTestId("flow-internal-empty")).toHaveCount(0);
});

test("staff inbox shows items from flow-staff-inbox and an empty state", async ({ page }) => {
  const calls = await setup(page, {
    review: EMPTY_REVIEW,
    inbox: { status: 200, body: { readOnly: true, items: [{ outbox_id: "n-1", conversation_id: "abcdef12-0000-4000-8000-000000000000", body: "عميل يطلب موظفًا", status: "settled", created_at: null }] } },
  });
  await page.goto("/milanochat/#/dashboard");
  const inbox = page.getByTestId("staff-inbox-panel");
  await expect(inbox.getByTestId("staff-inbox-item")).toHaveCount(1);
  await expect(inbox).toContainText("عميل يطلب موظفًا");
  await expect(inbox).toContainText("تم التسليم");
  const call = calls.find((c) => c.path.endsWith("/flow-staff-inbox"));
  expect(call?.body).toEqual({ tenantId: TENANT });
  expect(calls.every((c) => !c.path.includes("flow_staff_notifications"))).toBe(true);
});

test("staff inbox handles empty, disabled (423), forbidden and error states in Arabic", async ({ page }) => {
  const cases: Array<[{ status: number; body: unknown }, string, string]> = [
    [{ status: 200, body: { items: [], readOnly: true } }, "staff-inbox-empty", "لا توجد إشعارات للموظفين الآن."],
    [{ status: 423, body: { error: "Staff inbox disabled" } }, "staff-inbox-disabled", "صندوق إشعارات الموظفين غير مفعّل حاليًا."],
    [{ status: 403, body: { error: "Not authorized" } }, "staff-inbox-forbidden", "ليس لديك صلاحية عرض إشعارات الموظفين لهذا المتجر."],
    [{ status: 503, body: { error: "Staff inbox unavailable" } }, "staff-inbox-error", "تعذر تحميل إشعارات الموظفين. حاول مرة أخرى لاحقًا."],
  ];
  for (const [inbox, id, text] of cases) {
    await page.unrouteAll();
    await setup(page, { review: EMPTY_REVIEW, inbox });
    await page.goto("/milanochat/#/dashboard");
    await page.reload();
    await expect(page.getByTestId("staff-inbox-panel").getByTestId(id)).toHaveText(text);
    await expect(page.getByTestId("staff-inbox-item")).toHaveCount(0);
  }
});

test("publication readiness warns when internal actions are required but not enabled", async ({ page }) => {
  let needsInternal = true, enabled = false;
  await setup(page, {
    publication: (b) => {
      if (b.action === "accounts") return { ok: true, accounts: [{ id: ACCOUNT, platform: "instagram", is_active: true, canActivate: true }] };
      if (b.action === "catalog") return { ok: true, flows: [], active: null };
      if (b.action === "readiness") return { ok: true, candidateRevision: 1, readiness: { candidateKind: "text", buttonsConfigured: false, delayConfigured: false, configured: false, needsInternalActions: needsInternal, checks: { instagram: true, internalActions: enabled } } };
      return { ok: false, error: "unexpected" };
    },
  });
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-publications").click();
  const dialog = page.getByRole("dialog", { name: "الإصدارات المنشورة" });
  await dialog.getByRole("combobox").first().selectOption(ACCOUNT);
  await dialog.getByTestId("flow-readiness-check").click();
  const report = dialog.getByTestId("flow-readiness-report");
  await expect(report.getByTestId("flow-readiness-internal-actions")).toContainText("لن تُنفَّذ هذه الإجراءات ما لم تُفعَّل ميزة الإجراءات الداخلية");
  await expect(report).toContainText("• تفعيل الإجراءات الداخلية");
  enabled = true;
  await dialog.getByTestId("flow-readiness-check").click();
  await expect(report.getByTestId("flow-readiness-internal-actions")).toContainText("الميزة مفعّلة");
  await expect(report).not.toContainText("• تفعيل الإجراءات الداخلية");
  needsInternal = false; enabled = false;
  await dialog.getByTestId("flow-readiness-check").click();
  await expect(report.getByTestId("flow-readiness-internal-actions")).toHaveCount(0);
  await expect(report).not.toContainText("تفعيل الإجراءات الداخلية");
});
