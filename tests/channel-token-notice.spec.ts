import { test, expect, type Page } from "@playwright/test";

/** Needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host); everything is mocked, nothing real is contacted. */
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;
test.skip(!URL_.startsWith("http://mock."), "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

const day = 86_400_000;
type Acc = { id: string; channel: string; platform: string; external_id: string; display_name: string; status: string; tokenExpiresAt: string | null };
const acc = (o: Partial<Acc> & Pick<Acc, "id" | "channel">): Acc => ({
  platform: o.channel, external_id: `ext-${o.id}`, display_name: `acct-${o.id}`, status: "active", tokenExpiresAt: null, ...o,
});

async function setup(page: Page, accounts: Acc[]) {
  const ref = new URL(URL_).hostname.split(".")[0];
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    `sb-${ref}-auth-token`,
    JSON.stringify({ access_token: FAKE_JWT, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
      user: { id: "u1", aud: "authenticated", role: "authenticated", email: "a@example.test", app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" } }),
  ]);
  const oauthCalls: string[] = [];
  await page.addInitScript(() => localStorage.setItem("milano.onboarding.v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "skipped"));
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    const p = u.pathname;
    if (p.endsWith("/milan-api")) {
      const action = u.searchParams.get("action");
      if (action === "summary") return json(200, { tenant: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", businessName: "متجر تجريبي", isActive: true, creditsRemaining: 10, phone: "" }, wa: { status: "none" }, openUnresolved: 0 });
      return json(200, action === "agent_prompt" ? { prompt: null } : []);
    }
    if (p.endsWith("/oauth-url")) { oauthCalls.push(p); return json(200, { url: "http://mock.supabase.test/oauth-stop" }); }
    if (p.endsWith("/channels/accounts")) return json(200, accounts);
    if (p.endsWith("/channels/summary")) return json(200, {});
    return json(200, {});
  });
  return oauthCalls;
}

const open = async (page: Page) => {
  await page.goto("/milanochat/#/dashboard");
  await page.getByTestId("sidebar-channels").click();
  await expect(page.getByText("Instagram DM")).toBeVisible();
  await expect(page.getByText("Facebook Messenger")).toBeVisible();
};

test("healthy and never-expiring accounts show no warning", async ({ page }) => {
  await setup(page, [acc({ id: "i1", channel: "instagram", tokenExpiresAt: new Date(Date.now() + 40 * day).toISOString() }), acc({ id: "f1", channel: "facebook" })]);
  await open(page);
  await expect(page.getByTestId("channel-token-notice")).toHaveCount(0);
});

test("expiring, expired and needs_reauth accounts show a warning with a reconnect action", async ({ page }) => {
  const calls = await setup(page, [
    acc({ id: "i1", channel: "instagram", tokenExpiresAt: new Date(Date.now() + 5 * day).toISOString() }),
    acc({ id: "f1", channel: "facebook", tokenExpiresAt: new Date(Date.now() - day).toISOString() }),
  ]);
  await open(page);
  const notices = page.getByTestId("channel-token-notice");
  await expect(notices).toHaveCount(2);
  await expect(page.locator('[data-state="expiring"]')).toHaveCount(1);
  await expect(page.locator('[data-state="expired"]')).toHaveCount(1);
  await expect(page.getByTestId("channel-token-reconnect")).toHaveCount(2);
  await page.getByTestId("channel-token-reconnect").first().click();
  await expect.poll(() => calls.length).toBeGreaterThan(0);
});

test("a needs_reauth account is flagged as an error and the channel is not shown as connected", async ({ page }) => {
  await setup(page, [acc({ id: "i1", channel: "instagram", status: "needs_reauth", tokenExpiresAt: new Date(Date.now() + 40 * day).toISOString() })]);
  await open(page);
  await expect(page.locator('[data-state="needs_reauth"]')).toHaveCount(1);
  await expect(page.getByTestId("channel-token-notice")).toHaveAttribute("role", "alert");
  await expect(page.getByText("غير متصل").first()).toBeVisible();
  await expect(page.getByText("متصل", { exact: true })).toHaveCount(0);
});
