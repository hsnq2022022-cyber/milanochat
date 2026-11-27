import { test, expect } from "@playwright/test";

/** Needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host); everything is mocked. */
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test.skip(!URL_.startsWith("http://mock."), "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

async function setup(page: import("@playwright/test").Page) {
  const ref = new URL(URL_).hostname.split(".")[0];
  await page.addInitScript(([key, value, onb]) => {
    localStorage.setItem(key, value);
    localStorage.setItem(onb, "skipped");
  }, [
    `sb-${ref}-auth-token`,
    JSON.stringify({ access_token: FAKE_JWT, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
      user: { id: "u1", aud: "authenticated", role: "authenticated", email: "a@example.test", app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" } }),
    `milano.onboarding.v1:${TENANT}`,
  ] as const);
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    if (u.pathname.endsWith("/milan-api")) {
      const action = u.searchParams.get("action");
      if (action === "summary") return json({ tenant: { id: TENANT, businessName: "متجر تجريبي", isActive: true, creditsRemaining: 10, phone: "" }, wa: { status: "none" }, openUnresolved: 0 });
      return json(action === "agent_prompt" ? { prompt: null } : []);
    }
    if (u.pathname.endsWith("/channels/accounts")) return json([]);
    return json({});
  });
}

for (const [code, expected] of [
  ["account_already_linked", /مرتبط مسبقًا/],
  ["no_eligible_instagram", /Business أو Creator/],
  ["no_pages", /صفحة Facebook/],
  ["some_new_code", /تعذر إتمام ربط Meta/],
] as const) {
  test(`connection failure "${code}" shows a clear Arabic message, not the raw code`, async ({ page }) => {
    await setup(page);
    await page.goto(`/milanochat/?channel_error=${code}#/dashboard`);
    const toast = page.getByText(/فشل الربط:/);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText(expected);
    if (code !== "some_new_code") await expect(toast).not.toContainText(code);
  });
}
