import { test, expect, type Page } from "@playwright/test";
import { CUSTOMER_ACTIONS, operatorActionCalls } from "./flowActivationMock";

/**
 * Fake-host guard like flow-publication-lifecycle-ui.spec.ts:
 *   VITE_SUPABASE_URL=http://mock.supabase.test VITE_SUPABASE_ANON_KEY=fake-anon-key npx playwright test tests/flow-publish-live-ui.spec.ts
 * Signed in as an ORDINARY CUSTOMER (operator_status operator:false); every
 * operator-only action gets the server's 403 and must never be called.
 */
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const TENANT = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;
test.skip(!URL_.startsWith("http://mock."), "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

type Mode = "live" | "saved_not_live" | "abort" | "malformed" | "http500";
async function setup(page: Page, mode: Mode) {
  const calls: any[] = [];
  const ref = new URL(URL_).hostname.split(".")[0];
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    `sb-${ref}-auth-token`,
    JSON.stringify({ access_token: FAKE_JWT, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
      user: { id: "u1", aud: "authenticated", role: "authenticated", email: "t@example.test", app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" } }),
  ]);
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const cors = { "access-control-allow-origin": "*" };
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    const body = req.postDataJSON?.() ?? {};
    calls.push({ path: u.pathname, body });
    if (u.pathname.endsWith("/flow-delivery-review")) return json({ events: {}, periodDays: 30, truncated: false });
    if (u.pathname.endsWith("/flow-publication")) {
      if (!CUSTOMER_ACTIONS.includes(body.action)) return json({ ok: false, error: "Operator access required" }, 403);
      switch (body.action) {
        case "operator_status": return json({ ok: true, operator: false });
        case "accounts": return json({ ok: true, accounts: [{ id: ACCOUNT, platform: "instagram", is_active: true, canActivate: true }] });
        case "publish_live":
          await new Promise((r) => setTimeout(r, 300));
          if (mode === "abort") return route.abort("failed");
          if (mode === "malformed") return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: "{not json" });
          if (mode === "http500") return json({ ok: false, error: "internal_secret_code" }, 500);
          if (mode === "saved_not_live") return json({ ok: true, status: "saved_not_live", revision: 8, reason: "flag_off", message: "تم حفظ التدفق، لكن التفعيل غير متاح لهذا الحساب الآن." });
          return json({ ok: true, status: "live", revision: 8 });
        default: return json({ ok: false, error: "unexpected" });
      }
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
async function openPanel(page: Page) {
  page.on("dialog", (d) => void d.accept());
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-publications").click();
  // Customer panel: the only channel account is selected automatically (shown by name).
  const dialog = page.getByRole("dialog", { name: "نشر التدفق" });
  await expect(dialog.getByTestId("flow-publish-account-name")).toHaveText("حساب القناة: Instagram");
  await expect(dialog.getByTestId("flow-publish")).toBeEnabled();
  return dialog;
}
const publishes = (calls: any[]) => calls.filter((c) => c.body.action === "publish_live");
const NEUTRAL = "تعذر إكمال النشر";

test("live: one publish_live request (double click), live notice, no activate call", async ({ page }) => {
  const calls = await setup(page, "live");
  const dialog = await openPanel(page);
  await dialog.getByTestId("flow-publish").dblclick();
  await expect(dialog.getByText("تم نشر التدفق وهو يعمل الآن.")).toBeVisible();
  expect(publishes(calls)).toHaveLength(1);
  expect(publishes(calls)[0].body).toMatchObject({ action: "publish_live", accountId: ACCOUNT });
  expect(calls.filter((c) => ["publish", "activate"].includes(c.body.action))).toHaveLength(0);
  expect(operatorActionCalls(calls.filter((c) => c.path.endsWith("/flow-publication")).map((c) => c.body))).toEqual([]);
  await expect(dialog.getByText("8")).toHaveCount(0);
});
test("saved_not_live shows the safe message only, not a live claim", async ({ page }) => {
  await setup(page, "saved_not_live");
  const dialog = await openPanel(page);
  await dialog.getByTestId("flow-publish").click();
  await expect(dialog.getByText("تم حفظ التدفق، لكن التفعيل غير متاح لهذا الحساب الآن.")).toBeVisible();
  await expect(dialog.getByText("وهو يعمل الآن")).toHaveCount(0);
  await expect(dialog.getByText("flag_off")).toHaveCount(0);
});
for (const mode of ["abort", "malformed", "http500"] as const) {
  test(`${mode}: neutral message, no live/saved claim, no codes`, async ({ page }) => {
    await setup(page, mode);
    const dialog = await openPanel(page);
    await dialog.getByTestId("flow-publish").click();
    await expect(dialog.getByText(NEUTRAL)).toBeVisible();
    await expect(dialog.getByText("وهو يعمل الآن")).toHaveCount(0);
    await expect(dialog.getByText("internal_secret_code")).toHaveCount(0);
    await expect(dialog.getByText("HTTP 500")).toHaveCount(0);
  });
}
