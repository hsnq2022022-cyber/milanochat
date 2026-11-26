import { test, expect, type Page } from "@playwright/test";

/** Needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host); the session is seeded in localStorage.
 *  The tenant-admin function is mocked: nothing real is contacted, nothing is charged or sent. */
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;
const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test.skip(!URL_.startsWith("http://mock."), "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

type Sent = Record<string, unknown>;
async function setup(page: Page, opts: { admin: boolean; failFirstAdjust?: boolean }) {
  const sent: Sent[] = [];
  let adjustCalls = 0;
  const ref = new URL(URL_).hostname.split(".")[0];
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    `sb-${ref}-auth-token`,
    JSON.stringify({ access_token: FAKE_JWT, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
      user: { id: "u1", aud: "authenticated", role: "authenticated", email: "a@example.test", app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" } }),
  ]);
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (new URL(req.url()).pathname.endsWith("/functions/v1/tenant-admin")) {
      const body = JSON.parse(req.postData() ?? "{}") as Sent;
      sent.push(body);
      if (body.action === "whoami") return json(200, { ok: true, admin: opts.admin });
      if (!opts.admin) return json(403, { error: "Admin access required" });
      if (body.action === "list_tenants") return json(200, { ok: true, tenants: [{ id: T, business_name: "متجر تجريبي", is_active: false, credits_remaining: 5, created_at: "2026-11-01T00:00:00Z" }] });
      if (body.action === "ledger") return json(200, { ok: true, actions: [] });
      if (body.action === "adjust_credits") {
        adjustCalls += 1;
        if (opts.failFirstAdjust && adjustCalls === 1) return route.abort("failed");
        return json(200, { ok: true, duplicate: adjustCalls > 1, balance: 105 });
      }
      return json(200, { ok: true });
    }
    return json(200, {});
  });
  return sent;
}

test("a non-admin sees only 'not authorised' and the panel never asks for tenant data", async ({ page }) => {
  const sent = await setup(page, { admin: false });
  await page.goto("/milanochat/#/admin");
  await expect(page.getByTestId("admin-denied")).toBeVisible();
  await expect(page.getByTestId("admin-panel")).toHaveCount(0);
  expect([...new Set(sent.map((s) => s.action))]).toEqual(["whoami"]);
});

test("an admin grants credits with a mandatory reason; a failed attempt retried reuses the SAME idempotency key", async ({ page }) => {
  const sent = await setup(page, { admin: true, failFirstAdjust: true });
  await page.goto("/milanochat/#/admin");
  await expect(page.getByTestId("admin-panel")).toBeVisible();
  await page.getByRole("button", { name: "إدارة" }).first().click();
  await page.getByLabel("عدد الردود (للشحن أو الخصم)").fill("100");
  // no reason -> blocked in the browser, nothing is sent
  await page.getByRole("button", { name: "شحن رصيد" }).click();
  await expect(page.getByRole("alert")).toContainText("السبب مطلوب");
  expect(sent.filter((s) => s.action === "adjust_credits")).toHaveLength(0);
  await page.getByLabel("السبب (مطلوب)").fill("تأكيد دفع خارج المنصة");
  await page.getByRole("button", { name: "شحن رصيد" }).click();      // network failure
  await expect(page.getByRole("alert")).toContainText("إعادة المحاولة بأمان");
  await page.getByRole("button", { name: "شحن رصيد" }).click();      // retry
  await expect(page.getByRole("status").filter({ hasText: "الطلب نُفّذ سابقًا" })).toBeVisible();
  const adj = sent.filter((s) => s.action === "adjust_credits");
  expect(adj).toHaveLength(2);
  expect(adj[0].idempotencyKey).toBe(adj[1].idempotencyKey);
  expect(adj[0]).toMatchObject({ tenantId: T, delta: 100, reason: "تأكيد دفع خارج المنصة" });
  expect(String(adj[0].idempotencyKey)).toMatch(/^adm-[0-9a-f-]{36}$/);
  expect(adj[0]).not.toHaveProperty("operatorId");
});
