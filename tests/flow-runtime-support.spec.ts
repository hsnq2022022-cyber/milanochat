import { test, expect, type Page } from "@playwright/test";
import { makeNode, edgeFor } from "../src/flow/model";
import { CUSTOMER_ACTIONS } from "./flowActivationMock";

/**
 * The editor must not offer or imply what the runtime cannot execute (Arabic, RTL, no technical words):
 *  - the HTTP request step is unavailable in the palette (disabled, plain reason, cannot be added);
 *  - story / ad / live / referral triggers are disabled in the event list;
 *  - an existing draft that still carries such a trigger: the check list reports it, the preview stops
 *    ("simulation stopped here") and Publish is refused BEFORE any request or confirmation.
 * Tests 1-2 need no backend. Test 3 uses the fake-host guard like flow-publish-live-ui.spec.ts:
 *   VITE_SUPABASE_URL=http://mock.supabase.test VITE_SUPABASE_ANON_KEY=fake-anon-key npx playwright test tests/flow-runtime-support.spec.ts
 */
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const MOCK = URL_.startsWith("http://mock.");
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;
const LIBRARY_KEY = "social_flow_library_v1";

function storyFlow() {
  const t = makeNode("trigger", { x: 0, y: 0 }, { platform: "instagram", triggerMode: "story", title: "رد على القصة" });
  const m = makeNode("message", { x: 0, y: 200 }, { text: "شكرًا لردك على القصة", title: "الرد" });
  return { version: 3, name: "تدفق القصة", nodes: [t, m],
    edges: [edgeFor({ source: t.id, sourceHandle: "next", target: m.id, targetHandle: "in" })] };
}
async function seed(page: Page, doc: unknown) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value),
    [LIBRARY_KEY, JSON.stringify({ activeFlowId: "story-flow", flows: [{ id: "story-flow", doc, enabled: false }] })]);
}

test("palette: the HTTP request step is unavailable with a plain Arabic reason and cannot be added", async ({ page }) => {
  await page.goto("/milanochat/#/flows");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const before = await page.locator(".react-flow__node").count();
  expect(before).toBeGreaterThan(0);
  await page.locator(".fs-fab").click();
  const item = page.getByTestId("pal-kind-request");
  await expect(item).toHaveAttribute("data-gated", "true");
  await expect(page.getByTestId("pal-gate-request")).toHaveText("الطلب الخارجي غير مدعوم بعد.");
  await item.click({ force: true }); // aria-disabled: a forced click must still add nothing
  await expect(page.locator(".react-flow__node")).toHaveCount(before);
  await expect(page.getByRole("status").filter({ hasText: "الطلب الخارجي غير مدعوم بعد." })).toBeVisible();
  // supported steps stay available
  await expect(page.getByTestId("pal-kind-message")).not.toHaveAttribute("data-gated", "true");
  await expect(page.getByTestId("pal-kind-delay")).not.toHaveAttribute("data-gated", "true");
});

test("trigger event list: story, ad and live-comment are disabled with a reason; DM and comment stay selectable", async ({ page }) => {
  await page.goto("/milanochat/#/flows");
  await page.locator(".react-flow__node").first().click({ force: true });
  const select = page.getByLabel("نوع الحدث");
  await expect(select).toBeVisible();
  for (const label of ["رد على Story", "النقر على إعلان Instagram", "تعليق على البث المباشر"]) {
    const option = select.locator("option", { hasText: label });
    await expect(option).toBeDisabled();
    await expect(option).toContainText("غير مدعوم بعد");
  }
  for (const label of ["العميل يرسل رسالة", "رسالة تحتوي كلمة", "تعليق على منشور أو Reel"]) {
    await expect(select.locator("option", { hasText: label })).toBeEnabled();
  }
});

test("a draft with an unsupported trigger: check list, preview and Publish all say so, nothing is sent", async ({ page }) => {
  test.skip(!MOCK, "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");
  const calls: Array<{ path: string; body: any }> = [];
  const ref = new URL(URL_).hostname.split(".")[0];
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    `sb-${ref}-auth-token`,
    JSON.stringify({ access_token: FAKE_JWT, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
      user: { id: "u1", aud: "authenticated", role: "authenticated", email: "t@example.test", app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" } }),
  ]);
  await seed(page, storyFlow());
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
      if (body.action === "operator_status") return json({ ok: true, operator: false });
      if (body.action === "accounts") return json({ ok: true, accounts: [{ id: ACCOUNT, platform: "instagram", is_active: true, canActivate: true }] });
      return json({ ok: false, error: "unexpected" });
    }
    if (u.pathname.endsWith("/milan-api")) return json(u.searchParams.get("action") === "agent_prompt" ? { prompt: null } : []);
    return json({});
  });
  let confirmed = false;
  page.on("dialog", (d) => { confirmed = true; void d.accept(); });

  await page.goto("/milanochat/#/flows");
  // 1) the check list reports the trigger as an error
  await page.locator(".fs-chip-btn").click();
  await expect(page.locator(".fs-issues")).toContainText("بداية الأتمتة غير مدعوم");
  // 2) the preview stops at it and never claims completion
  await page.getByRole("button", { name: /تجربة/ }).click();
  const sim = page.getByTestId("flow-simulator");
  await expect(sim).toContainText("توقفت المحاكاة هنا", { timeout: 8000 });
  await expect(sim).not.toContainText("اكتملت المحاكاة");
  await expect(sim).not.toContainText("شكرًا لردك على القصة");
  await page.keyboard.press("Escape");
  await expect(sim).toHaveCount(0);
  // 3) Publish is refused locally, before the confirmation and before any request
  await page.getByTestId("flow-publications").click();
  const dialog = page.getByRole("dialog", { name: "نشر التدفق" });
  await expect(dialog.getByTestId("flow-publish-account-name")).toHaveText("حساب القناة: Instagram");
  await dialog.getByTestId("flow-publish").click();
  await expect(dialog.getByRole("status")).toContainText("لا يمكن نشر التدفق");
  await expect(dialog.getByRole("status")).toContainText("بداية الأتمتة غير مدعوم");
  expect(confirmed).toBe(false);
  expect(calls.filter((c) => c.body.action === "publish_live" || c.body.action === "publish")).toHaveLength(0);
  await expect(dialog.getByText("تم نشر التدفق")).toHaveCount(0);
});
