import { test, expect, type Page } from "@playwright/test";

/** Needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host); the session is seeded in localStorage. */
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const TENANT = "11111111-1111-4111-8111-111111111111";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;

test.skip(!URL_.startsWith("http://mock."), "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

const LABELS = ["الرئيسية", "المحادثات", "التدفقات", "القنوات", "الإعدادات"];
const IDS = ["home", "inbox", "flows", "channels", "settings"];

async function setup(page: Page, opts: { authed?: boolean; accounts?: unknown[]; flags?: Record<string, string> } = {}) {
  const { authed = true, accounts = [], flags = {} } = opts;
  const ref = new URL(URL_).hostname.split(".")[0];
  await page.addInitScript(([key, value, f, withSession]) => {
    if (withSession) localStorage.setItem(key, value);
    for (const [k, v] of Object.entries(f)) localStorage.setItem(k, v);
  }, [
    `sb-${ref}-auth-token`,
    JSON.stringify({
      access_token: FAKE_JWT, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
      user: { id: "u1", aud: "authenticated", role: "authenticated", email: "t@example.test", app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" },
    }),
    flags,
    authed,
  ] as const);
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (u.pathname.endsWith("/milan-api")) {
      const action = u.searchParams.get("action");
      if (action === "summary") return json({ tenant: { id: TENANT, businessName: "متجر تجريبي", isActive: true, creditsRemaining: 10, phone: "" }, wa: { status: "none" }, openUnresolved: 0 });
      return json(action === "agent_prompt" ? { prompt: null } : []);
    }
    if (u.pathname.endsWith("/channels/accounts")) return json(accounts);
    if (u.pathname.endsWith("/channels/summary")) return json({});
    return json({});
  });
}

const account = { id: "a1", channel: "facebook", external_id: "p1", display_name: "صفحة", avatar_url: null, status: "active" };

test.describe("desktop 1280", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("sidebar visible with the 5 items, bottom nav hidden, active state follows the route", async ({ page }) => {
    await setup(page, { flags: { [`milano.onboarding.v1:${TENANT}`]: "skipped" } });
    await page.goto("/milanochat/#/dashboard");
    const sb = page.getByTestId("sidebar");
    await expect(sb).toBeVisible();
    await expect(page.getByTestId("bottom-nav")).toBeHidden();
    for (let i = 0; i < 5; i++) {
      await expect(sb.getByTestId(`sidebar-${IDS[i]}`)).toHaveText(LABELS[i]);
    }
    await expect(sb.getByTestId("sidebar-home")).toHaveAttribute("aria-current", "page");
    await sb.getByTestId("sidebar-channels").click();
    await expect(sb.getByTestId("sidebar-channels")).toHaveAttribute("aria-current", "page");
    await expect(sb.getByTestId("sidebar-home")).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByText("القنوات والحسابات")).toBeVisible();
    await sb.getByTestId("sidebar-inbox").click();
    await expect(sb.getByTestId("sidebar-inbox")).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("القنوات والحسابات")).toHaveCount(0);
    await sb.getByTestId("sidebar-settings").click();
    await expect(page.getByTestId("profile-page")).toBeVisible();
    await expect(sb.getByTestId("sidebar-settings")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("sidebar")).toHaveCount(1);
    await sb.getByTestId("sidebar-flows").click();
    await expect(page).toHaveURL(/#\/flows/);
    await expect(page.getByTestId("sidebar").getByTestId("sidebar-flows")).toHaveAttribute("aria-current", "page");
  });

  test("sidebar docks right, collapses to icons and persists", async ({ page }) => {
    await setup(page, { flags: { [`milano.onboarding.v1:${TENANT}`]: "skipped" } });
    await page.goto("/milanochat/#/dashboard");
    const sb = page.getByTestId("sidebar");
    const toggle = page.getByTestId("sidebar-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const box = (await sb.boundingBox())!;
    expect(Math.round(box.width)).toBe(240);
    expect(Math.round(box.x + box.width)).toBe(1280);
    const tb = (await toggle.boundingBox())!;
    expect(tb.width).toBeGreaterThanOrEqual(44);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(async () => Math.round((await sb.boundingBox())!.width)).toBe(72);
    await page.reload();
    await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
    await page.getByTestId("sidebar-toggle").click();
    await page.reload();
    await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  test("no shell when unauthenticated", async ({ page }) => {
    await setup(page, { authed: false });
    await page.goto("/milanochat/#/dashboard");
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
    await expect(page.getByTestId("bottom-nav")).toHaveCount(0);
    await page.goto("/milanochat/");
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
  });
});

test.describe("mobile 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("bottom nav shows the same 5 items, sidebar hidden, 44px targets, no overflow", async ({ page }) => {
    await setup(page, { flags: { [`milano.onboarding.v1:${TENANT}`]: "skipped" } });
    await page.goto("/milanochat/#/dashboard");
    const nav = page.getByTestId("bottom-nav");
    await expect(nav).toBeVisible();
    await expect(page.getByTestId("sidebar")).toBeHidden();
    for (let i = 0; i < 5; i++) {
      const a = nav.getByTestId(`bottom-nav-${IDS[i]}`);
      await expect(a).toHaveText(LABELS[i]);
      const b = (await a.boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.width).toBeGreaterThanOrEqual(44);
    }
    await expect(nav.getByTestId("bottom-nav-home")).toHaveAttribute("aria-current", "page");
    await nav.getByTestId("bottom-nav-channels").click();
    await expect(nav.getByTestId("bottom-nav-channels")).toHaveAttribute("aria-current", "page");
    await nav.getByTestId("bottom-nav-inbox").click();
    await expect(nav.getByTestId("bottom-nav-inbox")).toHaveAttribute("aria-current", "page");
    await nav.getByTestId("bottom-nav-flows").click();
    await expect(page).toHaveURL(/#\/flows/);
    await expect(page.getByTestId("bottom-nav")).toHaveCount(0); // full-screen editor: no bottom nav
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe("onboarding wizard", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("shows for a new user without channels; ESC asks for confirmation; skip is remembered", async ({ page }) => {
    await setup(page, { accounts: [] });
    await page.goto("/milanochat/#/dashboard");
    const dlg = page.getByRole("dialog", { name: "ابدأ إعداد حسابك" });
    await expect(dlg).toBeVisible();
    await expect(dlg).toHaveAttribute("aria-modal", "true");
    await expect(page.getByTestId("onboarding-progress")).toHaveText("الخطوة 1 من 3");
    await expect(page.getByTestId("onboarding-panel-channel")).toBeVisible();
    await page.getByTestId("onboarding-next").click();
    await expect(page.getByTestId("onboarding-panel-prompt")).toBeVisible();
    await page.getByTestId("onboarding-next").click();
    await expect(page.getByTestId("onboarding-panel-flow")).toBeVisible();
    await expect(page.getByTestId("onboarding-step-3")).toHaveAttribute("aria-current", "step");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("onboarding-skip-confirm")).toBeVisible();
    await page.getByTestId("onboarding-skip-cancel").click();
    await expect(dlg).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("onboarding-skip-confirm").click();
    await expect(dlg).toHaveCount(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), `milano.onboarding.v1:${TENANT}`)).toBe("skipped");
    await page.reload();
    await expect(page.getByTestId("dashboard-tabs")).toBeVisible();
    await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
  });

  test("focus stays trapped inside the dialog", async ({ page }) => {
    await setup(page, { accounts: [] });
    await page.goto("/milanochat/#/dashboard");
    await expect(page.getByTestId("onboarding-wizard")).toBeVisible();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="onboarding-wizard"]'))).toBe(true);
    }
  });

  test("never shows when a channel is connected", async ({ page }) => {
    await setup(page, { accounts: [account] });
    await page.goto("/milanochat/#/dashboard");
    await expect(page.getByTestId("dashboard-tabs")).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
  });

  test("does not appear on the public landing page", async ({ page }) => {
    await setup(page, { accounts: [] });
    await page.goto("/milanochat/");
    await page.waitForTimeout(500);
    await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
  });
});
