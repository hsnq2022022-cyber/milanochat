import { test, expect, type Page } from "@playwright/test";
import { MOCK_HOST, mockAccounts, mockActivation, operatorActionCalls, type ActivationServer, type MultiAccountServer } from "./flowActivationMock";

/**
 * Operator-only controls come from the server's `operator_status` (fail closed).
 *   VITE_SUPABASE_URL=http://mock.supabase.test VITE_SUPABASE_ANON_KEY=fake-anon-key npx playwright test tests/flow-operator-ui.spec.ts
 * Customer fixtures answer operator_status {ok:true,operator:false} and every
 * operator-only action with the server's 403 "Operator access required"; each
 * call is recorded so the specs can prove the customer UI sends none.
 * Run once with VITE_ENABLE_FLOW_CANARY_CONTROLS=true as well: the canary build
 * flag must not reveal any operator control to a customer.
 */
test.skip(!MOCK_HOST, "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const MENU_CLOSE = "إغلاق قائمة الإضافة";
const LOCAL_KEY = "default"; // the local editor flow id (customer publish_live publishes under it)
const ALL = ["trigger_message", "keyword_trigger", "message_scope", "comment_trigger", "public_reply", "private_reply", "text", "media_image",
  "buttons", "website_buttons", "typed_question", "delay", "conditions", "variables", "randomizer", "goto", "internal_actions", "ai_step", "multi_step", "unsupported_block"];
const BASIC = new Set(["trigger_message", "keyword_trigger", "message_scope", "text", "conditions"]);
const nonCanary = Object.fromEntries(ALL.map((c) => [c, BASIC.has(c) ? { available: true, reason: null } : { available: false, reason: "advanced_not_enabled" }]));
/** Operator controls of the editor toolbar. */
const OPERATOR_TOOLBAR = ["flow-enabled-toggle", "flow-update-latest", "flow-revision-select", "flow-activate-selected", "flow-live-revision"];
/** Technical words / revision numbers a customer must never see in the Publish panel. */
const TECHNICAL = /\bv\d|revision|readiness|engine|canary|operator|flag|worker|durable|rollback|إصدار|جاهزية|محرك|تجريبي|الرجوع|رمز|HTTP/i;

const customer = (o: Partial<ActivationServer> = {}): ActivationServer =>
  ({ active: 2, items: [3, 2], capabilities: nonCanary, calls: [], ...o });
const deactivations = (s: ActivationServer) => s.calls.filter((c) => c.action === "deactivate");
const dialogsOf = (page: Page, accept = true) => {
  const seen: string[] = [];
  page.on("dialog", (d) => { seen.push(d.message()); void (accept ? d.accept() : d.dismiss()); });
  return seen;
};
/** Page is settled for a customer: operator_status answered and the account-based capabilities call made. */
async function settledCustomer(page: Page, s: ActivationServer) {
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  await expect.poll(() => s.calls.some((c) => c.action === "operator_status")).toBe(true);
  await expect.poll(() => s.calls.some((c) => c.action === "capabilities" && c.accountId === ACCOUNT)).toBe(true);
}
async function expectNoOperatorToolbar(page: Page) {
  for (const id of OPERATOR_TOOLBAR) await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(page.getByTestId("flow-publications")).not.toContainText("الإصدارات المنشورة");
}
async function openCustomerPanel(page: Page) {
  await page.getByTestId("flow-publications").click();
  const dialog = page.getByRole("dialog", { name: "نشر التدفق" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog", { name: "الإصدارات المنشورة" })).toHaveCount(0);
  return dialog;
}

test("customer: Publish and Stop only, gating from `accounts` alone, ZERO operator-only calls (catalog/list would 403)", async ({ page }) => {
  const s = customer();
  dialogsOf(page);
  await settledCustomer(page, s);
  await expectNoOperatorToolbar(page);
  await expect(page.getByTestId("flow-publications")).toContainText("نشر");
  await expect(page.getByTestId("flow-activation-reason")).toHaveCount(0); // no server code / 403 leaks into the editor
  // Capability gating still works: the account came from `accounts` only.
  await page.getByRole("button", { name: "فتح إضافة خطوة" }).click();
  const menu = page.getByTestId("add-step-menu");
  await expect(menu.getByTestId("pal-kind-delay")).toHaveAttribute("aria-disabled", "true");
  await expect(menu.getByTestId("pal-gate-delay")).toContainText("غير متاحة لحسابك حاليًا");
  await expect(menu.getByTestId("pal-kind-message")).not.toHaveAttribute("aria-disabled", "true");
  await menu.getByRole("button", { name: MENU_CLOSE }).click();
  // Reduced Publish panel.
  const dialog = await openCustomerPanel(page);
  await expect(dialog.getByTestId("flow-publish")).toBeEnabled();
  await expect(dialog.getByTestId("flow-stop")).toBeEnabled();
  await expect(dialog.getByTestId("flow-publish-account-name")).toHaveText("حساب القناة: Instagram");
  for (const id of ["flow-readiness-check", "flow-readiness-report", "flow-active-server-status", "revision-draft", "flow-copy-readiness"])
    await expect(dialog.getByTestId(id)).toHaveCount(0);
  await expect(dialog.locator('[data-testid^="revision-status-"], [data-testid^="select-published-revision-"], [data-testid^="readiness-published-revision-"], [data-testid^="preview-published-revision-"]')).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /عرض الإصدارات|تفعيل|الرجوع|استيراد|معاينة/ })).toHaveCount(0);
  expect(await dialog.textContent()).not.toMatch(TECHNICAL);
  expect(await dialog.textContent()).not.toContain(ACCOUNT.slice(0, 8));
  // Publish (publish_live) as a customer: still no operator-only call afterwards.
  await dialog.getByTestId("flow-publish").click();
  await expect(dialog.getByRole("status")).toBeVisible();
  expect(operatorActionCalls(s.calls)).toEqual([]);
  expect(s.calls.filter((c) => c.action === "publish_live")).toEqual([expect.objectContaining({ accountId: ACCOUNT, flowKey: LOCAL_KEY })]);
});

const FAILURES: Array<[string, ActivationServer["operatorStatus"]]> = [
  ["operator:false", { status: 200, body: { ok: true, operator: false } }],
  ["HTTP 500", { status: 500, body: { ok: false, error: "boom" } }],
  ["HTTP 403", { status: 403, body: { ok: false, error: "Operator access required" } }],
  ["ok:false with operator:true", { status: 200, body: { ok: false, operator: true } }],
  ["missing operator field", { status: 200, body: { ok: true } }],
  ["operator as string", { status: 200, body: { ok: true, operator: "true" } }],
  ["operator as 1", { status: 200, body: { ok: true, operator: 1 } }],
  ["array body", { status: 200, body: [{ ok: true, operator: true }] }],
  ["network failure", "abort"],
];
for (const [name, reply] of FAILURES) {
  test(`operator_status ${name} => customer view, no operator controls or calls`, async ({ page }) => {
    const s = customer({ operatorStatus: reply });
    await settledCustomer(page, s);
    await expectNoOperatorToolbar(page);
    const dialog = await openCustomerPanel(page);
    await expect(dialog.getByTestId("flow-publish")).toBeVisible();
    await expect(dialog.getByTestId("flow-readiness-check")).toHaveCount(0);
    expect(operatorActionCalls(s.calls)).toEqual([]);
  });
}

test("while operator_status is pending no operator control flashes; they appear only after {operator:true}", async ({ page }) => {
  let release!: () => void;
  const s = customer({ operator: true, operatorStatusGate: new Promise<void>((r) => { release = r; }) });
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  await expect.poll(() => s.calls.some((c) => c.action === "capabilities" && c.accountId === ACCOUNT)).toBe(true);
  await page.waitForTimeout(300);
  await expectNoOperatorToolbar(page);
  expect(operatorActionCalls(s.calls)).toEqual([]);
  release();
  await expect(page.getByTestId("flow-enabled-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("flow-live-revision")).toHaveText("الإصدار المباشر: v2 · أحدث منشور: v3");
});

test("canary UI build flag never reveals operator controls to a customer", async ({ page }) => {
  test.info().annotations.push({ type: "VITE_ENABLE_FLOW_CANARY_CONTROLS", description: String(process.env.VITE_ENABLE_FLOW_CANARY_CONTROLS ?? "unset") });
  const s = customer({ canActivate: true });
  await settledCustomer(page, s);
  await expectNoOperatorToolbar(page);
  const dialog = await openCustomerPanel(page);
  await expect(dialog.getByRole("button", { name: /تفعيل|الرجوع/ })).toHaveCount(0);
  expect(await dialog.textContent()).not.toMatch(TECHNICAL);
  expect(operatorActionCalls(s.calls)).toEqual([]);
});

test("operator: every operator control is shown and behaves as before", async ({ page }) => {
  const s = customer({ operator: true, active: 2, items: [3, 2] });
  const dialogs = dialogsOf(page);
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("flow-live-revision")).toHaveText("الإصدار المباشر: v2 · أحدث منشور: v3");
  await expect(page.getByTestId("flow-update-latest")).toBeVisible();
  await expect(page.getByTestId("flow-revision-select")).toHaveValue("");
  await expect(page.getByTestId("flow-activate-selected")).toBeDisabled();
  await expect(page.getByTestId("flow-publications")).toContainText("الإصدارات المنشورة");
  // Update to latest: readiness for exactly r3, then one activate.
  await page.getByTestId("flow-update-latest").click();
  await expect(page.getByRole("status").filter({ hasText: "تم تحديث التدفق إلى الإصدار v3" })).toBeVisible();
  expect(s.calls.filter((c) => c.action === "readiness")).toEqual([expect.objectContaining({ flowKey: LOCAL_KEY, revision: 3 })]);
  expect(s.calls.filter((c) => c.action === "activate")).toEqual([expect.objectContaining({ accountId: ACCOUNT, flowKey: LOCAL_KEY, revision: 3 })]);
  expect(dialogs.at(-1)).toContain("from revision v2 to v3");
  // The full operator panel (not the customer one).
  await page.getByTestId("flow-publications").click();
  const dialog = page.getByRole("dialog", { name: "الإصدارات المنشورة" });
  await expect(dialog.getByTestId("flow-readiness-check")).toBeVisible();
  await expect(dialog.getByTestId("flow-stop")).toHaveCount(0);
  await dialog.getByRole("combobox").first().selectOption(ACCOUNT);
  await dialog.getByRole("button", { name: "عرض الإصدارات" }).click();
  await expect(dialog.getByText("الإصدار النشط: 3")).toBeVisible();
  await expect(dialog.getByTestId("revision-status-3")).toHaveAttribute("data-status", "active");
  await dialog.getByTestId("readiness-published-revision-2").click();
  await expect(dialog.getByTestId("flow-readiness-report")).toBeVisible();
});

test("emergency stop: exactly one deactivate with the account and the LOCAL flow key; plain success text", async ({ page }) => {
  const s = customer({ delayMs: 300 });
  const dialogs = dialogsOf(page);
  await settledCustomer(page, s);
  const dialog = await openCustomerPanel(page);
  await dialog.getByTestId("flow-stop").dblclick();
  await expect(dialog.getByRole("status")).toHaveText("تم إيقاف التدفق.");
  expect(dialogs).toContain("إيقاف هذا التدفق الآن؟ ستتوقف ردوده التلقائية حتى تنشره من جديد.");
  expect(deactivations(s)).toEqual([{ action: "deactivate", accountId: ACCOUNT, flowKey: LOCAL_KEY }]);
  expect(s.active).toBeNull();
  expect(operatorActionCalls(s.calls)).toEqual([]);
});

test("emergency stop: cancelling the confirm sends nothing", async ({ page }) => {
  const s = customer();
  dialogsOf(page, false);
  await settledCustomer(page, s);
  const dialog = await openCustomerPanel(page);
  await dialog.getByTestId("flow-stop").click();
  await expect(dialog.getByTestId("flow-stop")).toBeEnabled();
  expect(deactivations(s)).toHaveLength(0);
  await expect(dialog.getByRole("status")).toHaveCount(0);
});

const STOP_FAILURES: Array<[string, Partial<ActivationServer>, string]> = [
  ["not running (404)", { active: null }, "هذا التدفق غير مفعّل حاليًا، فلا يوجد ما يلزم إيقافه."],
  ["HTTP 500 with a code", { mutationError: { status: 500, error: "internal_secret_code" } }, "تعذر إيقاف التدفق."],
  ["HTTP 403", { mutationError: { status: 403, error: "Account not authorized" } }, "تعذر إيقاف التدفق."],
  ["ok:true without active:false", { deactivateReply: { status: 200, body: { ok: true } } }, "تعذر إيقاف التدفق."],
  ["ok:true, active:true", { deactivateReply: { status: 200, body: { ok: true, active: true } } }, "تعذر إيقاف التدفق."],
];
for (const [name, o, text] of STOP_FAILURES) {
  test(`emergency stop ${name}: never claims it stopped, no codes`, async ({ page }) => {
    const s = customer(o);
    dialogsOf(page);
    await settledCustomer(page, s);
    const dialog = await openCustomerPanel(page);
    await dialog.getByTestId("flow-stop").click();
    const status = dialog.getByRole("status");
    await expect(status).toContainText(text);
    await expect(status).not.toContainText("تم إيقاف التدفق");
    expect(await status.textContent()).not.toMatch(/internal_secret_code|Account not authorized|HTTP|\d{3}/);
    expect(deactivations(s)).toEqual([{ action: "deactivate", accountId: ACCOUNT, flowKey: LOCAL_KEY }]);
    expect(operatorActionCalls(s.calls)).toEqual([]);
  });
}

test("customer with two accounts picks one by channel name; Stop targets exactly that account", async ({ page }) => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const s: MultiAccountServer = { calls: [], accounts: {
    [A]: { id: A, flows: { [LOCAL_KEY]: [1] }, active: { flow_key: LOCAL_KEY, revision: 1 } },
    [B]: { id: B, flows: { [LOCAL_KEY]: [1] }, active: { flow_key: LOCAL_KEY, revision: 1 } } } };
  dialogsOf(page);
  await mockAccounts(page, s, { name: "owner", owned: [A, B] });
  await page.goto("/milanochat/#/flows");
  await expect.poll(() => s.calls.some((c) => c.action === "operator_status")).toBe(true);
  await expectNoOperatorToolbar(page);
  const dialog = await openCustomerPanel(page);
  const select = dialog.getByTestId("flow-publish-account");
  await expect(select.locator("option")).toHaveText(["اختر الحساب", "Instagram 1", "Instagram 2"]);
  await expect(dialog.getByTestId("flow-stop")).toBeDisabled();
  await select.selectOption(B);
  await dialog.getByTestId("flow-stop").click();
  await expect(dialog.getByRole("status")).toHaveText("تم إيقاف التدفق.");
  expect(s.calls.filter((c) => c.action === "deactivate")).toEqual([expect.objectContaining({ accountId: B, flowKey: LOCAL_KEY })]);
  expect(s.accounts[A].active).not.toBeNull();
  expect(s.accounts[B].active).toBeNull();
  expect(operatorActionCalls(s.calls)).toEqual([]);
});
