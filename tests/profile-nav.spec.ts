import { test, expect, type Page } from "@playwright/test";

/** Needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host); the session is seeded in localStorage. */
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;

test.skip(!URL_.startsWith("http://mock."), "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

async function setup(page: Page) {
  const ref = new URL(URL_).hostname.split(".")[0];
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    `sb-${ref}-auth-token`,
    JSON.stringify({
      access_token: FAKE_JWT, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
      user: { id: "u1", aud: "authenticated", role: "authenticated", email: "t@example.test", app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" },
    }),
  ]);
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (u.pathname.endsWith("/milan-api")) {
      const action = u.searchParams.get("action");
      if (action === "summary") return json({ tenant: { id: "11111111-1111-4111-8111-111111111111", businessName: "متجر تجريبي", isActive: true, creditsRemaining: 10, phone: "" }, wa: { status: "none" }, openUnresolved: 0 });
      return json(action === "agent_prompt" ? { prompt: null } : []);
    }
    return json({});
  });
}

test("dashboard bottom nav has flows + settings and settings page shows email/plan/logout", async ({ page }) => {
  await setup(page);
  await page.goto("/milanochat/#/dashboard");
  const nav = page.getByTestId("bottom-nav");
  await expect(nav).toBeVisible();
  await expect(nav.getByTestId("bottom-nav-flows")).toHaveText("التدفقات");
  await expect(nav.getByTestId("bottom-nav-flows")).toHaveAttribute("href", "#/flows");
  await expect(nav.getByTestId("bottom-nav-settings")).toHaveText("الإعدادات");
  await nav.getByTestId("bottom-nav-settings").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("الإعدادات");
  await expect(page.getByTestId("profile-page")).toBeVisible();
  await expect(page.getByTestId("profile-email")).toHaveText("t@example.test");
  await expect(page.getByTestId("settings-store-name")).toHaveText("متجر تجريبي");
  await expect(page.getByTestId("profile-plan")).toHaveText("—");
  await expect(page.getByTestId("profile-logout")).toHaveText("تسجيل خروج");
  await page.getByTestId("bottom-nav-home").click();
  await expect(page).toHaveURL(/#\/dashboard/);
});

test("#/profile still works as an alias of settings", async ({ page }) => {
  await setup(page);
  await page.goto("/milanochat/#/profile");
  await expect(page.getByTestId("profile-page")).toBeVisible();
  await expect(page.getByTestId("profile-email")).toHaveText("t@example.test");
});

test("settings has the five sections", async ({ page }) => {
  await setup(page);
  await page.goto("/milanochat/#/settings");
  for (const [id, title] of [
    ["balance", "رصيد الردود"], ["staff-inbox", "إشعارات الموظفين"], ["delivery-review", "مراجعة الرسائل غير المؤكدة"],
    ["widgets", "الودجات"], ["unresolved", "المحادثات العالقة"],
  ] as const) {
    await expect(page.getByTestId(`settings-section-${id}`).getByRole("heading", { level: 2 }).first()).toContainText(title);
  }
  await expect(page.getByTestId("settings-credits")).toContainText("10");
  await expect(page.getByTestId("settings-widgets-link")).toHaveCount(0);
  await page.getByTestId("settings-section-widgets-toggle").click();
  await expect(page.getByTestId("settings-widgets-link")).toHaveAttribute("href", "#/widgets");
});

test("dashboard has exactly 3 top tabs and no WhatsApp status card", async ({ page }) => {
  await setup(page);
  await page.goto("/milanochat/#/dashboard");
  const tabs = page.getByTestId("dashboard-tabs").getByRole("button");
  await expect(tabs).toHaveText(["المحادثات", "المعرفة", "القنوات"]);
  await expect(page.getByTestId("dashboard-kpis")).toBeVisible();
  await expect(page.getByText("حالة واتساب")).toHaveCount(0);
  await expect(page.getByText("Widgets")).toHaveCount(0);
});

test("Handicrafts first with Tajawal fallback; bold renders differently from normal", async ({ page }) => {
  await page.goto("/milanochat/");
  const r = await page.evaluate(async () => {
    await document.fonts.load('400 40px Handicrafts');
    await document.fonts.load('700 40px Handicrafts');
    const mk = (w: number) => { const s = document.createElement("span"); s.textContent = "ترحيب المتجر Abc 123"; s.style.cssText = `font-size:40px;font-weight:${w};position:absolute;white-space:nowrap`; document.body.appendChild(s); return s; };
    const n = mk(400), b = mk(700);
    return { ff: getComputedStyle(n).fontFamily, wn: n.getBoundingClientRect().width, wb: b.getBoundingClientRect().width, loaded: document.fonts.check('40px Handicrafts') };
  });
  expect(r.ff).toBe('Handicrafts, Tajawal, sans-serif');
  expect(r.loaded).toBe(true);
  expect(r.wb).toBeGreaterThan(r.wn);
});
