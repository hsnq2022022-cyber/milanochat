import { test, expect, type Page } from "@playwright/test";

/** Needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host); session seeded in localStorage, network mocked. */
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;
const TENANT = "11111111-1111-4111-8111-111111111111";

test.skip(!URL_.startsWith("http://mock."), "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

type Item = Record<string, unknown>;
const item = (id: string, over: Item = {}): Item => ({
  id, customerName: `عميل ${id}`, commentText: `تعليق رقم ${id}`, createdAt: "2026-11-01T10:00:00Z",
  publicReplyStatus: "sent", publicReplyText: `رد ${id}`, dmStatus: "sent", ...over,
});

type Reply = { status: number; body: unknown } | ((body: Record<string, any>) => { status: number; body: unknown });

async function setup(page: Page, reply: Reply, calls: Array<Record<string, any>> = []) {
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
    const cors = { "access-control-allow-origin": "*" };
    const send = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (u.pathname.endsWith("/milan-api")) {
      const action = u.searchParams.get("action");
      if (action === "summary") return send(200, { tenant: { id: TENANT, businessName: "متجر تجريبي", isActive: true, creditsRemaining: 10, phone: "" }, wa: { status: "none" }, openUnresolved: 0 });
      if (action === "comment_activity") {
        const body = req.postDataJSON?.() ?? {};
        calls.push({ ...body, _claim: req.headers()["x-tenant-token"] });
        const r = typeof reply === "function" ? reply(body) : reply;
        return send(r.status, r.body);
      }
      return send(200, action === "agent_prompt" ? { prompt: null } : []);
    }
    return send(200, {});
  });
}

const open = async (page: Page) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/milanochat/#/dashboard?tab=comments");
};

test("comments sub-tab: badges, collapsed excerpt, expand shows exact reply text", async ({ page }) => {
  const calls: Array<Record<string, any>> = [];
  const exact = "شكراً لك!\nراسلناك على الخاص 🌿";
  await setup(page, { status: 200, body: { ok: true, nextCursor: null, items: [
    item("1", { publicReplyText: exact }),
    item("2", { publicReplyStatus: "failed", dmStatus: "failed" }),
    item("3", { publicReplyStatus: "pending", publicReplyText: null, dmStatus: "pending" }),
    item("4", { dmStatus: "skipped" }),
  ] } }, calls);
  await open(page);
  const rows = page.getByTestId("comment-item");
  await expect(rows).toHaveCount(4);
  await expect(page.getByTestId("inbox-subtab-comments")).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(0)).toContainText("تم الرد العام ✅");
  await expect(rows.nth(0)).toContainText("تم إرسال الخاص ✅");
  await expect(rows.nth(1)).toContainText("فشل الرد العام");
  await expect(rows.nth(1)).toContainText("فشل الإرسال");
  await expect(rows.nth(2)).toContainText("قيد الإرسال");
  await expect(rows.nth(3)).toContainText("تم الرد العام ✅");
  await expect(rows.nth(3)).toContainText("لم يُرسل الخاص");
  expect(calls.length).toBeGreaterThan(0); // dev StrictMode may double-mount the effect
  expect(calls[0]).toMatchObject({ tenantId: TENANT, limit: 20 });
  expect(calls[0]._claim).toBeTruthy();
  const initial = calls.length;

  const btn = rows.nth(0).getByRole("button");
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: process.env.COMMENTS_SHOT_DIR ? `${process.env.COMMENTS_SHOT_DIR}/collapsed.png` : undefined });
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  await expect(rows.nth(0).getByTestId("comment-reply-text")).toHaveText(exact);
  await expect(btn).toHaveAttribute("aria-controls", (await rows.nth(0).getByTestId("comment-detail").getAttribute("id"))!);
  await page.screenshot({ path: process.env.COMMENTS_SHOT_DIR ? `${process.env.COMMENTS_SHOT_DIR}/expanded.png` : undefined });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await page.waitForTimeout(500);
  expect(calls).toHaveLength(initial); // expanding/collapsing never refetches
});

test("empty state", async ({ page }) => {
  await setup(page, { status: 200, body: { ok: true, items: [], nextCursor: null } });
  await open(page);
  await expect(page.getByTestId("comments-empty")).toHaveText("لا توجد تعليقات بعد");
});

test("error state retries; unavailable shows the not-enabled message", async ({ page }) => {
  let fail = true;
  await setup(page, () => (fail ? { status: 500, body: { ok: false, error: "boom" } } : { status: 200, body: { ok: true, items: [item("1")], nextCursor: null } }));
  await open(page);
  await expect(page.getByTestId("comments-error")).toContainText("تعذر تحميل التعليقات");
  fail = false;
  await page.getByRole("button", { name: "إعادة المحاولة" }).click();
  await expect(page.getByTestId("comment-item")).toHaveCount(1);
});

test("unavailable feature message", async ({ page }) => {
  await setup(page, { status: 503, body: { ok: false, error: "unavailable" } });
  await open(page);
  await expect(page.getByTestId("comments-error")).toContainText("غير مفعّلة");
  await expect(page.getByRole("button", { name: "إعادة المحاولة" })).toHaveCount(0);
});

test("pagination uses nextCursor and hides the button at the end; refresh refetches", async ({ page }) => {
  const calls: Array<Record<string, any>> = [];
  await setup(page, (b) => b.cursor === "c1"
    ? { status: 200, body: { ok: true, items: [item("3")], nextCursor: null } }
    : { status: 200, body: { ok: true, items: [item("1"), item("2")], nextCursor: "c1" } }, calls);
  await open(page);
  await expect(page.getByTestId("comment-item")).toHaveCount(2);
  await page.getByRole("button", { name: "تحميل المزيد" }).click();
  await expect(page.getByTestId("comment-item")).toHaveCount(3);
  expect(calls.filter((c) => c.cursor === "c1")).toHaveLength(1);
  await expect(page.getByRole("button", { name: "تحميل المزيد" })).toHaveCount(0);
  await page.getByRole("button", { name: "تحديث" }).click();
  await expect(page.getByRole("button", { name: "تحميل المزيد" })).toBeVisible();
  await expect(page.getByTestId("comment-item")).toHaveCount(2);
});

test("inbox without comments param still shows conversations; sub-tab switches", async ({ page }) => {
  const calls: Array<Record<string, any>> = [];
  await setup(page, { status: 200, body: { ok: true, items: [], nextCursor: null } }, calls);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/milanochat/#/dashboard?tab=inbox");
  await expect(page.getByTestId("inbox-subtab-chats")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("صندوق المحادثات الموحد")).toBeVisible();
  expect(calls).toHaveLength(0);
  await page.getByTestId("inbox-subtab-comments").click();
  await expect(page.getByTestId("comments-empty")).toBeVisible();
  await expect(page).toHaveURL(/tab=comments/);
});
