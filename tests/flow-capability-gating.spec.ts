import { test, expect, type Page } from "@playwright/test";

/**
 * Editor capability gating against a fake flow-publication server.
 *   VITE_SUPABASE_URL=http://mock.supabase.test VITE_SUPABASE_ANON_KEY=fake-anon-key npx playwright test tests/flow-capability-gating.spec.ts
 */
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;
test.skip(!URL_.startsWith("http://mock."), "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

const ALL = ["trigger_message", "keyword_trigger", "message_scope", "comment_trigger", "public_reply", "private_reply", "text", "media_image",
  "buttons", "website_buttons", "typed_question", "delay", "conditions", "variables", "randomizer", "goto", "internal_actions", "ai_step", "multi_step", "unsupported_block"];
const BASIC = new Set(["trigger_message", "keyword_trigger", "message_scope", "text", "conditions"]);
/** Non-canary account: basic blocks only. */
const nonCanary = Object.fromEntries(ALL.map((c) => [c, c === "unsupported_block" ? { available: false, reason: "not_supported" }
  : BASIC.has(c) ? { available: true, reason: null } : { available: false, reason: c.startsWith("comment") || c.endsWith("reply") ? "comments_not_enabled" : "advanced_not_enabled" }]));

async function mock(page: Page, capabilities: "fail" | Record<string, unknown>, calls: any[] = []) {
  const ref = new URL(URL_).hostname.split(".")[0];
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [`sb-${ref}-auth-token`, JSON.stringify({
    access_token: FAKE_JWT, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
    user: { id: "u1", aud: "authenticated", role: "authenticated", email: "t@example.test", app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" } })]);
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    const reply = (b: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (!new URL(req.url()).pathname.endsWith("/flow-publication")) return reply({});
    const b = req.postDataJSON?.() ?? {};
    calls.push(b);
    switch (b.action) {
      case "accounts": return reply({ ok: true, accounts: [{ id: ACCOUNT, platform: "instagram", is_active: true, canActivate: true }] });
      case "catalog": return reply({ ok: true, flows: [], activeFlows: [], active: null, truncated: false });
      case "list": return reply({ ok: true, items: [], activation: null });
      case "capabilities":
        if (capabilities === "fail") return reply({ ok: false, error: "Capabilities unavailable" }, 503);
        return reply({ ok: true, platform: "instagram", capabilities, canPublish: { basic: true, advanced: false, comments: false } });
      default: return reply({ ok: false, error: "unexpected" });
    }
  });
  return calls;
}
const preloadDelay = (page: Page) => page.addInitScript(() => {
  const doc = { version: 3, name: "d", nodes: [
    { id: "s", type: "flowNode", position: { x: 0, y: 0 }, data: { kind: "trigger", title: "t", text: "", keywords: "", triggerMode: "message", platform: "instagram" } },
    { id: "w", type: "flowNode", position: { x: 0, y: 220 }, data: { kind: "delay", title: "انتظار", delayValue: 1, delayUnit: "minutes" } }],
    edges: [{ id: "e1", source: "s", target: "w", sourceHandle: "next", targetHandle: "in" }] };
  if (!localStorage.getItem("cap-spec-loaded")) { localStorage.setItem("social_flow_reactflow_v3", JSON.stringify(doc)); localStorage.setItem("cap-spec-loaded", "1"); }
});
const FORBIDDEN = /engine|revision|canary|operator|flag|worker|durable|محرك|إصدار|تجريبي/i;

test("palette: unavailable blocks are disabled with plain Arabic text and cannot be added", async ({ page }) => {
  const calls = await mock(page, nonCanary);
  await page.goto("/milanochat/#/flows");
  await expect.poll(() => calls.some((c) => c.action === "capabilities" && c.accountId === ACCOUNT)).toBe(true);
  const before = await page.locator(".react-flow__node").count();
  await page.getByRole("button", { name: "فتح إضافة خطوة" }).click();
  const menu = page.getByTestId("add-step-menu");
  const delay = menu.getByTestId("pal-kind-delay");
  await expect(delay).toHaveAttribute("aria-disabled", "true");
  await expect(delay).toBeVisible();
  const reason = menu.getByTestId("pal-gate-delay");
  await expect(reason).toContainText("غير متاحة لحسابك حاليًا");
  expect(await reason.textContent()).not.toMatch(FORBIDDEN);
  await expect(menu.getByTestId("pal-preset-tag")).toHaveAttribute("aria-disabled", "true");
  await expect(menu.getByTestId("pal-kind-request")).toHaveAttribute("aria-disabled", "true");
  await expect(menu.getByTestId("pal-kind-message")).not.toHaveAttribute("aria-disabled", "true");
  await expect(delay).toBeDisabled(); // aria-disabled: assistive tech and Playwright see it as disabled
  await delay.click({ force: true });
  await expect(page.locator(".react-flow__node")).toHaveCount(before);
  await expect(page.locator('.fs-node[data-kind="delay"]')).toHaveCount(0);
  await menu.getByTestId("pal-kind-message").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1);
});

test("existing unavailable block: badge on the card and a plain sentence in the step panel", async ({ page }) => {
  await preloadDelay(page);
  await mock(page, nonCanary);
  await page.goto("/milanochat/#/flows");
  const badge = page.locator('.fs-node[data-kind="delay"]').getByTestId("node-capability-badge");
  await expect(badge).toHaveText("غير متاح لحسابك");
  await page.locator('.fs-node[data-kind="delay"]').click();
  const notice = page.getByTestId("step-capability-notice");
  await expect(notice).toContainText("هذه الميزة غير متاحة لحسابك حاليًا");
  expect(await notice.textContent()).not.toMatch(FORBIDDEN);
  await expect(page.locator('.fs-node[data-kind="trigger"]').getByTestId("node-capability-badge")).toHaveCount(0);
});

test("capabilities failure: nothing gated, no badge, no claim", async ({ page }) => {
  await preloadDelay(page);
  const calls = await mock(page, "fail");
  await page.goto("/milanochat/#/flows");
  await expect.poll(() => calls.some((c) => c.action === "capabilities")).toBe(true);
  await expect(page.locator('.fs-node[data-kind="delay"]')).toBeVisible();
  await expect(page.getByTestId("node-capability-badge")).toHaveCount(0);
  await page.getByRole("button", { name: "فتح إضافة خطوة" }).click();
  await expect(page.getByTestId("add-step-menu").locator('[aria-disabled="true"]')).toHaveCount(0);
  await expect(page.getByTestId("add-step-menu").locator('[data-testid^="pal-gate-"]')).toHaveCount(0);
});
