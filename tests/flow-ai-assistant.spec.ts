import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { MOCK_HOST, mockActivation } from "./flowActivationMock";

test.skip(!MOCK_HOST, "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const TENANT = "33333333-3333-4333-8333-333333333333";
const PROMPT = "تدفق ترحيبي لمتجر ملابس";

const base = (kind: string, title: string, text = "", extra: Record<string, unknown> = {}) => ({
  kind, title, text, image: "", options: [], contentBlocks: [], platform: "instagram", keywords: "", triggerMode: "keyword",
  commentScope: "all", commentPostId: "", commentMatchType: "any", publicReplyText: "", inputMode: "buttons", inputField: "response",
  conditionField: "message", operator: "contains", conditionValue: "", delayValue: 1, delayUnit: "minutes", actionType: "tag",
  actionValue: "", gotoNode: "", requestMethod: "GET", requestUrl: "", ...extra,
});
const node = (id: string, x: number, y: number, data: Record<string, unknown>) => ({ id, type: "flowNode", position: { x, y }, data });
const edge = (id: string, source: string, target: string, sourceHandle = "next") => ({ id, type: "flowEdge", source, target, sourceHandle, targetHandle: "in", data: { label: "" } });

/** trigger -> welcome -> question(2 buttons) -> end. Ids deliberately collide with nothing in the app. */
function goodDocument(tag = "AIGEN") {
  return {
    nodes: [
      node("g-trigger", 0, 0, base("trigger", `${tag} بداية`, "", { keywords: "مرحبا" })),
      node("g-welcome", 0, 250, base("message", `${tag} ترحيب`, "أهلاً بك في متجرنا")),
      node("g-q", 0, 500, base("question", `${tag} القسم`, "أي قسم تفضل؟", { options: [{ id: "opt-men", label: "رجالي" }, { id: "opt-women", label: "نسائي" }] })),
      node("g-end", 0, 800, base("end", `${tag} نهاية`)),
    ],
    edges: [edge("ge1", "g-trigger", "g-welcome"), edge("ge2", "g-welcome", "g-q"), edge("ge3", "g-q", "g-end", "opt-men"), edge("ge4", "g-q", "g-end", "opt-women")],
  };
}

type Server = {
  calls: Array<Record<string, any>>;
  reply: (n: number) => { status: number; body: unknown } | "network" | "hang";
  authHeaders: Array<string | undefined>;
};
const ok = (document: unknown, cached = false) => ({ status: 200, body: { ok: true, cached, document, credits_charged: 5 } });

async function setup(page: Page, reply: Server["reply"]): Promise<Server> {
  const server: Server = { calls: [], reply, authHeaders: [] };
  await mockActivation(page, { active: null, calls: [] });
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const cors = { "access-control-allow-origin": "*" };
    if (req.method() === "OPTIONS") return route.fallback();
    if (path.endsWith("/auth/v1/user")) return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ id: "u1", aud: "authenticated", role: "authenticated", email: "t@example.test", app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" }) });
    if (path.endsWith("/rest/v1/tenants")) return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ id: TENANT }) });
    if (path.endsWith("/generate-flow")) {
      server.calls.push(req.postDataJSON());
      server.authHeaders.push(req.headers()["authorization"]);
      const r = server.reply(server.calls.length);
      if (r === "network") return route.abort("failed");
      if (r === "hang") return; // never answered
      return route.fulfill({ status: r.status, contentType: "application/json", headers: cors, body: JSON.stringify(r.body) });
    }
    return route.fallback();
  });
  return server;
}

const nodes = (page: Page) => page.locator(".react-flow__node");
const open = async (page: Page) => {
  await page.goto("/milanochat/#/flows");
  await expect(nodes(page)).toHaveCount(6);
  await page.getByTestId("ai-flow-fab").click();
  await expect(page.getByRole("dialog", { name: "مساعد الذكاء الاصطناعي" })).toBeVisible();
};
const submit = async (page: Page, text = PROMPT) => {
  await page.getByTestId("ai-flow-prompt").fill(text);
  await page.getByTestId("ai-flow-generate").click();
};
const storeNodes = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("social_flow_reactflow_v3") ?? "null")?.nodes?.length ?? 0);

test("FAB shows the visible label with the icon and opens an accessible modal; ESC closes and returns focus", async ({ page }) => {
  await setup(page, () => ok(goodDocument()));
  await page.goto("/milanochat/#/flows");
  const fab = page.getByTestId("ai-flow-fab");
  await expect(fab).toBeVisible();
  await expect(fab).toContainText("مساعد الذكاء الاصطناعي");
  expect((await fab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await fab.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "مساعد الذكاء الاصطناعي" });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toContainText("5 أرصدة");
  await expect(dialog).toContainText("مسودة");
  await expect(page.getByTestId("ai-flow-prompt")).toBeFocused();
  // focus trap: Tab cycles inside the dialog
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(fab).toBeFocused();
});

test("empty prompt is blocked with no request; counter and maxlength work", async ({ page }) => {
  const s = await setup(page, () => ok(goodDocument()));
  await open(page);
  await page.getByTestId("ai-flow-generate").click();
  await expect(page.getByRole("alert").filter({ hasText: "اكتب وصفًا" })).toBeVisible();
  await page.getByTestId("ai-flow-prompt").fill("   ");
  await page.getByTestId("ai-flow-generate").click();
  await expect(page.getByRole("alert").filter({ hasText: "اكتب وصفًا" })).toBeVisible();
  await page.getByTestId("ai-flow-prompt").fill("ا".repeat(1600));
  await expect(page.getByText("1500 / 1500")).toBeVisible();
  expect(s.calls).toHaveLength(0);
});

test("loading state disables the form; success -> choice -> append keeps the flow and adds re-id'd nodes with the right body", async ({ page }) => {
  const s = await setup(page, () => ok(goodDocument()));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(`${URL_}/functions/v1/generate-flow`, async (route) => { await gate; await route.fallback(); });
  await open(page);
  await submit(page);
  const gen = page.getByTestId("ai-flow-generate");
  await expect(gen).toBeDisabled();
  await expect(gen).toContainText("جارٍ توليد التدفق");
  await expect(page.getByTestId("ai-flow-prompt")).toBeDisabled();
  release();
  await expect(page.getByTestId("ai-flow-append")).toBeVisible();
  await expect(page.getByText("استبدال التدفق الحالي أم إضافة إليه؟")).toBeVisible();
  expect(s.calls).toHaveLength(1);
  expect(s.calls[0]).toMatchObject({ prompt: PROMPT, tenant_id: TENANT });
  expect(s.calls[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(s.authHeaders[0]).toMatch(/^Bearer /);
  await expect(nodes(page)).toHaveCount(6); // nothing applied yet
  await page.getByTestId("ai-flow-append").click();
  await expect(page.getByTestId("ai-flow-dialog")).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(9); // 6 + 4 generated - dropped trigger
  await expect(page.getByRole("status").filter({ hasText: "تم تطبيق التدفق — راجعه قبل التفعيل" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "اربط أول خطوة" })).toBeVisible();
  // ids: no collisions and none of the server ids survive
  await expect.poll(() => storeNodes(page)).toBe(9);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("social_flow_reactflow_v3")!));
  const ids = saved.nodes.map((n: any) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.some((i: string) => i.startsWith("g-"))).toBe(false);
  const edgeIds = saved.edges.map((e: any) => e.id);
  expect(new Set(edgeIds).size).toBe(edgeIds.length);
  expect(edgeIds.some((i: string) => i.startsWith("ge"))).toBe(false);
  expect(saved.nodes.filter((n: any) => n.data.kind === "trigger")).toHaveLength(1);
  const ai = saved.nodes.filter((n: any) => String(n.data.title).startsWith("AIGEN"));
  expect(ai).toHaveLength(3);
  const aiIds = new Set(ai.map((n: any) => n.id));
  const q = ai.find((n: any) => n.data.kind === "question");
  const aiEdges = saved.edges.filter((e: any) => aiIds.has(e.source) || aiIds.has(e.target));
  expect(aiEdges).toHaveLength(3); // trigger edge dropped
  expect(aiEdges.every((e: any) => aiIds.has(e.source) && aiIds.has(e.target))).toBe(true);
  const handles = aiEdges.filter((e: any) => e.source === q.id).map((e: any) => e.sourceHandle).sort();
  expect(handles).toEqual(q.data.options.map((o: any) => o.id).sort());
  // no overlap between new and old cards
  const boxes = await nodes(page).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    expect(a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3], `nodes ${i}/${j} overlap`).toBe(false);
  }
  // undoable in one step
  await page.getByTitle("تراجع Ctrl+Z").click();
  await expect(nodes(page)).toHaveCount(6);
});

test("replace needs a second confirmation on a non-default flow and is undoable", async ({ page }) => {
  await setup(page, () => ok(goodDocument()));
  await open(page);
  await submit(page);
  await page.getByTestId("ai-flow-replace").click();
  await expect(page.getByText("سيتم استبدال التدفق الحالي. هل أنت متأكد؟")).toBeVisible();
  await expect(nodes(page)).toHaveCount(6);
  await page.getByRole("button", { name: "رجوع" }).click();
  await expect(page.getByTestId("ai-flow-replace")).toBeVisible();
  await page.getByTestId("ai-flow-replace").click();
  await page.getByTestId("ai-flow-replace-confirm").click();
  await expect(nodes(page)).toHaveCount(4);
  await expect(page.locator(".react-flow__node").filter({ hasText: "AIGEN ترحيب" })).toBeVisible();
  await page.getByTitle("تراجع Ctrl+Z").click();
  await expect(nodes(page)).toHaveCount(6);
});

test("replace on a blank flow (only the default trigger) needs no second confirmation; cached note is shown", async ({ page }) => {
  await setup(page, () => ok(goodDocument(), true));
  await page.goto("/milanochat/#/flows");
  await page.getByRole("button", { name: "البدء من الصفر" }).first().click();
  await expect(nodes(page)).toHaveCount(1);
  await page.getByTestId("ai-flow-fab").click();
  await submit(page);
  await expect(page.getByText("تم استرجاع نتيجة سابقة بدون خصم")).toBeVisible();
  await page.getByTestId("ai-flow-replace").click();
  await expect(page.getByTestId("ai-flow-dialog")).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(4);
  await expect(page.getByRole("status").filter({ hasText: "بدون خصم" })).toBeVisible();
});

for (const [code, message, expected] of [
  ["insufficient_credits", "رصيدك لا يكفي لتوليد التدفق (5 أرصدة).", "رصيدك لا يكفي لتوليد التدفق (5 أرصدة)."],
  ["generation_failed", "تعذر توليد تدفق مناسب، جرّب وصفًا آخر.", "تعذر توليد تدفق مناسب، جرّب وصفًا آخر."],
  ["disabled", "رسالة داخلية من الخادم", "الميزة غير مفعّلة بعد"],
] as const) {
  test(`server error ${code} is shown inline with retry`, async ({ page }) => {
    const s = await setup(page, (n) => (n === 1 ? { status: code === "disabled" ? 403 : 402, body: { ok: false, error: code, message } } : ok(goodDocument())));
    await open(page);
    await submit(page);
    const alert = page.getByTestId("ai-flow-error");
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toContainText(expected);
    if (code === "insufficient_credits") await expect(alert.getByRole("link", { name: "شحن الرصيد" })).toHaveAttribute("href", "#/dashboard?pay=1");
    else await expect(page.getByRole("link", { name: "شحن الرصيد" })).toHaveCount(0);
    await expect(nodes(page)).toHaveCount(6);
    // retry after a server answer is a NEW submission (new request_id)
    await page.getByTestId("ai-flow-generate").click();
    await expect(page.getByTestId("ai-flow-append")).toBeVisible();
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1].request_id).not.toBe(s.calls[0].request_id);
  });
}

test("a 200 {ok:false} reply is also shown verbatim", async ({ page }) => {
  await setup(page, () => ({ status: 200, body: { ok: false, error: "rate_limited", message: "طلبات كثيرة، انتظر دقيقة." } }));
  await open(page);
  await submit(page);
  await expect(page.getByTestId("ai-flow-error")).toContainText("طلبات كثيرة، انتظر دقيقة.");
});

test("network failure maps to the generic message and the retry REUSES request_id; an edited prompt gets a new one", async ({ page }) => {
  const s = await setup(page, (n) => (n <= 2 ? "network" : ok(goodDocument())));
  await open(page);
  await submit(page);
  await expect(page.getByTestId("ai-flow-error")).toContainText("تعذر الاتصال، حاول مرة أخرى");
  await page.getByTestId("ai-flow-generate").click(); // retry, same text
  await expect(page.getByTestId("ai-flow-error")).toContainText("تعذر الاتصال، حاول مرة أخرى");
  expect(s.calls).toHaveLength(2);
  expect(s.calls[1].request_id).toBe(s.calls[0].request_id);
  await page.getByTestId("ai-flow-prompt").fill(PROMPT + " مع قسم الأطفال");
  await page.getByTestId("ai-flow-generate").click();
  await expect(page.getByTestId("ai-flow-append")).toBeVisible();
  expect(s.calls).toHaveLength(3);
  expect(s.calls[2].request_id).not.toBe(s.calls[0].request_id);
});

test("closing while generating asks first (credits warning) and aborts the request", async ({ page }) => {
  const s = await setup(page, () => "hang");
  await open(page);
  await submit(page);
  await expect(page.getByTestId("ai-flow-generate")).toBeDisabled();
  await page.getByRole("button", { name: "إغلاق" }).click();
  await expect(page.getByText("قد يُخصم الرصيد")).toBeVisible();
  await page.getByRole("button", { name: "متابعة الانتظار" }).click();
  await expect(page.getByTestId("ai-flow-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  const aborted = page.waitForEvent("requestfailed", (r) => r.url().endsWith("/generate-flow")).catch(() => null);
  await page.getByTestId("ai-flow-abort").click();
  await expect(page.getByTestId("ai-flow-dialog")).toHaveCount(0);
  await aborted;
  expect(s.calls).toHaveLength(1);
  await expect(nodes(page)).toHaveCount(6);
});

test("invalid server documents are rejected and never applied", async ({ page }) => {
  const bad = goodDocument();
  bad.edges.push(edge("ghost", "g-q", "does-not-exist", "opt-men")); // dangling edge
  const noTrigger = { nodes: goodDocument().nodes.slice(1), edges: [] };
  const docs: unknown[] = [bad, noTrigger, { nodes: "nope", edges: [] }, null];
  await setup(page, (n) => ok(docs[n - 1]));
  await open(page);
  for (let i = 0; i < docs.length; i++) {
    await page.getByTestId("ai-flow-prompt").fill(PROMPT + i);
    await page.getByTestId("ai-flow-generate").click();
    await expect(page.getByTestId("ai-flow-error")).toContainText("التدفق المولّد غير صالح");
    await expect(page.getByTestId("ai-flow-append")).toHaveCount(0);
    await expect(nodes(page)).toHaveCount(6);
  }
});

test("an exception while applying leaves the flow untouched and shows an Arabic error", async ({ page }) => {
  // 100 valid generated nodes cannot be appended to a 6-node flow (limit 100) -> buildAppend throws.
  const nodesList = [node("t", 0, 0, base("trigger", "BIG t", "", { keywords: "x" }))];
  const edges: any[] = [];
  for (let i = 0; i < 99; i++) {
    nodesList.push(node("m" + i, 0, 250 * (i + 1), base(i === 98 ? "end" : "message", "BIG " + i, "نص")));
    edges.push(edge("e" + i, i === 0 ? "t" : "m" + (i - 1), "m" + i));
  }
  await setup(page, () => ok({ nodes: nodesList, edges }));
  await open(page);
  await submit(page);
  await page.getByTestId("ai-flow-append").click();
  await expect(page.getByTestId("ai-flow-error")).toContainText("لم يتغيّر تدفقك الحالي");
  await expect(page.getByTestId("ai-flow-dialog")).toBeVisible();
  await expect(nodes(page)).toHaveCount(6);
  await expect(page.getByText("حدث خطأ")).toHaveCount(0); // route error boundary not triggered
  await page.getByRole("button", { name: "إغلاق" }).click();
  await expect(page.getByTestId("ai-flow-fab")).toBeVisible();
});

test("manual builder still works after using the assistant (add step, undo, simulator)", async ({ page }) => {
  await setup(page, () => ok(goodDocument()));
  await open(page);
  await submit(page);
  await page.getByTestId("ai-flow-append").click();
  await expect(nodes(page)).toHaveCount(9);
  await page.getByRole("button", { name: "فتح إضافة خطوة" }).click();
  await page.getByTestId("add-step-menu").getByRole("button", { name: "إرسال رسالة" }).click();
  await expect(nodes(page)).toHaveCount(10);
  await page.getByTitle("تراجع Ctrl+Z").click();
  await expect(nodes(page)).toHaveCount(9);
  await page.keyboard.press("Control+z"); // keyboard undo of the AI append
  await expect(nodes(page)).toHaveCount(6);
});

test("layout: FAB does not collide with other controls at 390px and 1280px", async ({ page }) => {
  await setup(page, () => ok(goodDocument()));
  for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(size);
    await page.goto("/milanochat/#/flows");
    await expect(nodes(page)).toHaveCount(6);
    const fab = (await page.getByTestId("ai-flow-fab").boundingBox())!;
    expect(fab.x).toBeGreaterThanOrEqual(0);
    expect(fab.x + fab.width).toBeLessThanOrEqual(size.width);
    const tools = (await page.getByTestId("flow-workspace-tools").boundingBox())!;
    const overlap = fab.x < tools.x + tools.width && tools.x < fab.x + fab.width && fab.y < tools.y + tools.height && tools.y < fab.y + fab.height;
    expect(overlap, `FAB overlaps workspace tools at ${size.width}px`).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/ai-fab-${size.width}.png` });
    await page.getByTestId("ai-flow-fab").click();
    await page.getByTestId("ai-flow-prompt").fill(PROMPT);
    await page.screenshot({ path: `test-results/ai-modal-${size.width}.png` });
    await page.getByTestId("ai-flow-generate").click();
    await expect(page.getByTestId("ai-flow-append")).toBeVisible();
    await page.screenshot({ path: `test-results/ai-choice-${size.width}.png` });
    await page.getByTestId("ai-flow-replace").click();
    await page.screenshot({ path: `test-results/ai-confirm-${size.width}.png` });
    await page.keyboard.press("Escape");
  }
});
