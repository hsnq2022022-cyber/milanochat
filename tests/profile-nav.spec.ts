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

test("dashboard bottom nav has flows + profile and profile page shows email/plan/logout", async ({ page }) => {
  await setup(page);
  await page.goto("/milanochat/#/dashboard");
  const nav = page.getByTestId("bottom-nav");
  await expect(nav).toBeVisible();
  await expect(nav.getByTestId("bottom-nav-flows")).toHaveText("التدفقات");
  await expect(nav.getByTestId("bottom-nav-flows")).toHaveAttribute("href", "#/flows");
  await nav.getByTestId("bottom-nav-profile").click();
  await expect(page.getByTestId("profile-page")).toBeVisible();
  await expect(page.getByTestId("profile-email")).toHaveText("t@example.test");
  await expect(page.getByTestId("profile-plan")).toHaveText("—");
  await expect(page.getByTestId("profile-logout")).toBeVisible();
  await page.getByTestId("bottom-nav-home").click();
  await expect(page).toHaveURL(/#\/dashboard/);
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
