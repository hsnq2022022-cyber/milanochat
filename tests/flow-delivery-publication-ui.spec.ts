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

async function setup(page: Page, handlers: { review?: unknown; publication?: (b: any) => unknown }) {
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
      return json(body.mode === "metrics" ? { events: { started: 3 }, periodDays: 30, truncated: false } : handlers.review);
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

test("delivery review shows cancel_reason labels for V3/V4 flow failures and tolerates unknown/null", async ({ page }) => {
  const calls = await setup(page, {
    review: {
      items: [{ claim_id: "c-v2-1", platform: "instagram", status: "uncertain", provider_message_id: null, attempted_at: "2025-01-01T00:00:00Z", uncertain_at: null, review_status: "pending", review_requested_at: null }], readOnly: true, flowAvailable: true, runCounts: {},
      flowFailures: [
        { id: "f-known", effect_kind: "text", delivery_status: "dead_letter", attempts: 2, created_at: null, cancel_reason: "ai_retries_exhausted" },
        { id: "f-ai", effect_kind: "text", delivery_status: "dead_letter", attempts: 2, created_at: null, cancel_reason: "ai_unavailable" },
        { id: "f-bill", effect_kind: "text", delivery_status: "billing_blocked", attempts: 0, created_at: null, cancel_reason: null },
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
  await expect(items).toHaveCount(5);
  await expect(items.nth(0).getByTestId("flow-cancel-reason")).toHaveText("سبب الفشل: تعذّر إنتاج رد آلي بعد عدة محاولات");
  await expect(items.nth(1).getByTestId("flow-cancel-reason")).toContainText("خدمة الرد الآلي لم تكن متاحة");
  await expect(items.nth(2).getByTestId("flow-cancel-reason")).toHaveCount(0);
  await expect(items.nth(2)).toContainText("موقوف بسبب الرصيد");
  await expect(items.nth(3).getByTestId("flow-cancel-reason")).toHaveText("سبب الإلغاء: سبب غير معروف");
  await expect(items.nth(4).getByTestId("flow-cancel-reason")).toHaveText("سبب الفشل: السبب غير محدد");
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
