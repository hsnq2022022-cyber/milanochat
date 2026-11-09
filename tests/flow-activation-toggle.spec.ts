import { test, expect, type Page } from "@playwright/test";
import { ADVANCED_ONLY_CHECKS, MOCK_HOST, mockAccounts, mockActivation, type ActivationServer, type MultiAccountServer } from "./flowActivationMock";

test.skip(!MOCK_HOST, "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

const fresh = (o: Partial<ActivationServer> = {}): ActivationServer => ({ active: null, calls: [], ...o });
const mutations = (s: ActivationServer) => s.calls.filter((c) => c.action === "activate" || c.action === "deactivate");
/** Accept every confirm() and record its text (Playwright dismisses dialogs by default). */
const acceptDialogs = (page: Page) => {
  const seen: string[] = [];
  page.on("dialog", (d) => { seen.push(d.message()); void d.accept(); });
  return seen;
};
const LIVE = "ig_live_welcome_20261029";
/** Production-like: live flow at r2 under its own server key, r3/r4 published later. */
const liveR2 = (o: Partial<ActivationServer> = {}) => fresh({ active: 2, activeKey: LIVE, flows: { [LIVE]: [4, 3, 2, 1] }, items: [], ...o });

test("toggle shows loading then reflects the real inactive status; no 'locally enabled' wording", async ({ page }) => {
  const s = fresh({ delayMs: 0 });
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toBeEnabled();
  await expect(toggle).toContainText("غير مفعّل");
  await expect(page.getByText("محليًا")).toHaveCount(0);
  const actions = new Set(s.calls.map((c) => c.action)); // dev StrictMode may repeat reads
  expect([...actions].sort()).toEqual(["accounts", "catalog", "list"]);
  expect(mutations(s)).toHaveLength(0);
});

test("toggle reflects an already active server flow", async ({ page }) => {
  await mockActivation(page, fresh({ active: 2 }));
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toContainText("مفعّل");
});

test("activate sends latest revision once, shows busy state and success toast; deactivate stops it", async ({ page }) => {
  const s = fresh({ delayMs: 400 });
  const dialogs = acceptDialogs(page);
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-busy", "true");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status").filter({ hasText: "تم تفعيل التدفق (الإصدار 2)" })).toBeVisible();
  expect(mutations(s)).toHaveLength(1);
  expect(mutations(s)[0]).toMatchObject({ action: "activate", revision: 2 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("status").filter({ hasText: "تم إيقاف التدفق" })).toBeVisible();
  expect(mutations(s)[1]).toMatchObject({ action: "deactivate", flowKey: "default" });
  expect(s.active).toBeNull();
  // Readiness for exactly the activated revision ran before activate; both steps were confirmed.
  const order = s.calls.map((c) => c.action).filter((a) => a === "readiness" || a === "activate");
  expect(order).toEqual(["readiness", "activate"]);
  expect(s.calls.find((c) => c.action === "readiness")).toMatchObject({ flowKey: "default", revision: 2 });
  expect(dialogs).toHaveLength(2);
  expect(dialogs[0]).toContain("default");
  expect(dialogs[0]).toContain("v2");
  expect(dialogs[1]).toContain("v2");
});

test("unsupported-feature rejection shows an Arabic error and the toggle stays off", async ({ page }) => {
  const s = fresh({ mutationError: { status: 422, error: "This flow uses unsupported runtime features" } });
  acceptDialogs(page);
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await toggle.click();
  await expect(page.getByRole("status").filter({ hasText: "تعذر التفعيل: الميزة غير مدعومة" })).toBeVisible();
  // The real server code stays visible for support.
  await expect(page.getByRole("status").filter({ hasText: "This flow uses unsupported runtime features · HTTP 422" })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("unknown server error falls back to the generic Arabic message", async ({ page }) => {
  acceptDialogs(page);
  await mockActivation(page, fresh({ mutationError: { status: 500, error: "weird" } }));
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-enabled-toggle").click();
  await expect(page.getByRole("status").filter({ hasText: /^تعذر التفعيل \(رمز: weird · HTTP 500\)/ })).toBeVisible();
});

test("no published revision: activation is refused with guidance, nothing is sent", async ({ page }) => {
  const s = fresh({ items: [] });
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-enabled-toggle").click();
  await expect(page.getByRole("status").filter({ hasText: "انشر التدفق أولًا" })).toBeVisible();
  expect(mutations(s)).toHaveLength(0);
});

test("service unavailable: toggle is disabled with an Arabic explanation and never looks active", async ({ page }) => {
  await mockActivation(page, fresh({ accountsFail: true }));
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await expect(page.getByTestId("flow-activation-reason")).toContainText("غير متاحة");
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("account without activation approval: toggle disabled with explanation", async ({ page }) => {
  await mockActivation(page, fresh({ canActivate: false }));
  await page.goto("/milanochat/#/flows");
  await expect(page.getByTestId("flow-activation-reason")).toContainText("غير متاح لحسابك");
  await expect(page.getByTestId("flow-enabled-toggle")).toBeDisabled();
});

test("cancelling the confirm sends no mutation and leaves the toggle off", async ({ page }) => {
  const s = fresh();
  page.on("dialog", (d) => void d.dismiss());
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await toggle.click();
  await expect(page.getByRole("status").filter({ hasText: "أُلغي التفعيل" })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(mutations(s)).toHaveLength(0);
});

test("live r2 under a server key with a local uuid draft: toggle ON and live revision line (original bug)", async ({ page }) => {
  const s = liveR2();
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  // A brand-new local flow has a uuid editor id, never the server flow_key.
  await page.getByRole("button", { name: "إنشاء تدفق جديد" }).click();
  const toggle = page.getByTestId("flow-enabled-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toContainText("مفعّل");
  const line = page.getByTestId("flow-live-revision");
  await expect(line).toHaveText("الإصدار المباشر: v2 · أحدث منشور: v4");
  await expect(line).toHaveAttribute("data-flow-key", LIVE);
  const uuidCatalog = s.calls.filter((c) => c.action === "catalog" && /^[0-9a-f-]{36}$/.test(c.flowKey));
  expect(uuidCatalog.length).toBeGreaterThan(0);
  // Every list after resolution targets the server key, never the local uuid.
  expect(s.calls.filter((c) => c.action === "list").every((c) => c.flowKey === LIVE)).toBe(true);
  await page.getByTestId("flow-ui-language").selectOption("en");
  await expect(line).toHaveText("Live: v2 · Latest published: v4");
  expect(mutations(s)).toHaveLength(0);
});

test("update to latest: readiness(r4) then exactly one activate(LIVE, 4) after a confirm naming key and v2 -> v4", async ({ page }) => {
  const s = liveR2();
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  const update = page.getByTestId("flow-update-latest");
  await expect(update).toHaveText("تحديث إلى أحدث إصدار");
  // First attempt: the user cancels -> nothing is sent.
  const once = new Promise<string>((res) => page.once("dialog", (d) => { res(d.message()); void d.dismiss(); }));
  await update.click();
  const cancelled = await once;
  await expect(page.getByRole("status").filter({ hasText: "أُلغي التحديث" })).toBeVisible();
  expect(cancelled).toContain(LIVE);
  expect(cancelled).toContain("v2");
  expect(cancelled).toContain("v4");
  expect(mutations(s)).toHaveLength(0);
  const dialogs = acceptDialogs(page);
  const before = s.calls.length;
  await update.click();
  await expect(page.getByRole("status").filter({ hasText: "تم تحديث التدفق إلى الإصدار v4" })).toBeVisible();
  const after = s.calls.slice(before).filter((c) => c.action === "readiness" || c.action === "activate");
  expect(after).toEqual([
    expect.objectContaining({ action: "readiness", flowKey: LIVE, revision: 4 }),
    expect.objectContaining({ action: "activate", flowKey: LIVE, revision: 4 }),
  ]);
  expect(mutations(s)).toHaveLength(1);
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain(LIVE);
  await expect(page.getByTestId("flow-live-revision")).toHaveText("الإصدار المباشر: v4 · أحدث منشور: v4");
  await expect(update).toHaveCount(0);
  await expect(page.getByTestId("flow-enabled-toggle")).toHaveAttribute("aria-pressed", "true");
});

test("update to latest: blocked readiness shows the blockers and never activates", async ({ page }) => {
  const s = liveR2({ readinessMissing: ["canary", "buttons"] });
  const dialogs = acceptDialogs(page);
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-update-latest").click();
  await expect(page.getByRole("status").filter({ hasText: "غير جاهز للتفعيل" })).toContainText("canary, buttons");
  expect(s.calls.filter((c) => c.action === "readiness")).toEqual([expect.objectContaining({ flowKey: LIVE, revision: 4 })]);
  expect(mutations(s)).toHaveLength(0);
  expect(dialogs).toHaveLength(0);
  await expect(page.getByTestId("flow-live-revision")).toHaveText("الإصدار المباشر: v2 · أحدث منشور: v4");
});

test("update to latest: a server rejection leaves state unchanged and shows the code", async ({ page }) => {
  const s = liveR2({ mutationError: { status: 403, error: "Account not authorized" } });
  acceptDialogs(page);
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-update-latest").click();
  const status = page.getByRole("status").filter({ hasText: "تعذر التحديث" });
  await expect(status).toContainText("الحساب غير مصرّح له");
  await expect(status).toContainText("Account not authorized · HTTP 403");
  expect(s.active).toBe(2);
  await expect(page.getByTestId("flow-live-revision")).toHaveText("الإصدار المباشر: v2 · أحدث منشور: v4");
  await expect(page.getByTestId("flow-update-latest")).toBeVisible();
  await expect(page.getByTestId("flow-enabled-toggle")).toHaveAttribute("aria-pressed", "true");
});

test("a different flow_key active on the account: activation refused, no activate call", async ({ page }) => {
  // The local flow was published under its own key (default: r3), nothing active at load.
  const s = fresh({ items: [3, 2, 1], activeKey: "other_live_flow" });
  const dialogs = acceptDialogs(page);
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("flow-live-revision")).toHaveText("الإصدار المباشر: — · أحدث منشور: v3");
  // Another flow goes live on the same account (e.g. from another tab).
  s.active = 1;
  await toggle.click();
  const status = page.getByRole("status").filter({ hasText: "other_live_flow" });
  await expect(status).toContainText("تدفق نشط واحد فقط");
  await expect(status).toContainText("exactly one active flow per account");
  expect(mutations(s)).toHaveLength(0);
  expect(s.calls.filter((c) => c.action === "readiness")).toHaveLength(0);
  expect(dialogs).toHaveLength(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("deactivate targets the resolved server key after a confirm naming it and the live revision", async ({ page }) => {
  const s = liveR2();
  const dialogs = acceptDialogs(page);
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(page.getByRole("status").filter({ hasText: "تم إيقاف التدفق" })).toBeVisible();
  expect(mutations(s)).toEqual([expect.objectContaining({ action: "deactivate", flowKey: LIVE })]);
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain(LIVE);
  expect(dialogs[0]).toContain("v2");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(s.active).toBeNull();
});

test("local draft validation errors do not block updating an unrelated server flow", async ({ page }) => {
  const s = liveR2();
  acceptDialogs(page);
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  await expect(page.getByTestId("flow-update-latest")).toBeVisible();
  // An isolated node is a blocking local error for the draft.
  await page.getByRole("button", { name: "فتح إضافة خطوة" }).click();
  await page.getByTestId("add-step-menu").getByRole("button", { name: "إرسال رسالة" }).click();
  await page.getByTestId("flow-update-latest").click();
  await expect(page.getByRole("status").filter({ hasText: "تم تحديث التدفق إلى الإصدار v4" })).toBeVisible();
  expect(mutations(s)).toEqual([expect.objectContaining({ action: "activate", flowKey: LIVE, revision: 4 })]);
});

test("catalog failure falls back to the local key and shows the server code", async ({ page }) => {
  const s = fresh({ catalogError: { status: 409, error: "Conflicting active revisions" } });
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  await expect(page.getByTestId("flow-activation-reason")).toContainText("Conflicting active revisions · HTTP 409");
  expect(s.calls.filter((c) => c.action === "list").every((c) => c.flowKey === "default")).toBe(true);
  // Activation is refused fail-closed while the account's active flow cannot be verified.
  acceptDialogs(page);
  await page.getByTestId("flow-enabled-toggle").click();
  await expect(page.getByRole("status").filter({ hasText: "تعذر التحقق من التدفق النشط" })).toBeVisible();
  expect(mutations(s)).toHaveLength(0);
});

test("simple text-only flow (legacy server path) can still be activated: no advanced readiness blockers", async ({ page }) => {
  // Server report for a non-durable document: candidateKind "unsupported", no needs, advanced env checks off.
  const s = fresh({ items: [3, 2, 1], readinessKinds: { 3: "unsupported" }, readinessMissing: ADVANCED_ONLY_CHECKS });
  const dialogs = acceptDialogs(page);
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(page.getByRole("status").filter({ hasText: "تم تفعيل التدفق (الإصدار 3)" })).toBeVisible();
  expect(s.calls.filter((c) => c.action === "readiness")).toEqual([expect.objectContaining({ flowKey: "default", revision: 3 })]);
  expect(mutations(s)).toEqual([expect.objectContaining({ action: "activate", flowKey: "default", revision: 3 })]);
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain("default");
  expect(dialogs[0]).toContain("v3");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
});

test("simple text revision as latest: Update to latest activates exactly that revision", async ({ page }) => {
  const s = liveR2({ readinessKinds: { 4: "text" }, readinessMissing: ADVANCED_ONLY_CHECKS });
  acceptDialogs(page);
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-update-latest").click();
  await expect(page.getByRole("status").filter({ hasText: "تم تحديث التدفق إلى الإصدار v4" })).toBeVisible();
  expect(mutations(s)).toEqual([expect.objectContaining({ action: "activate", flowKey: LIVE, revision: 4 })]);
});

test("advanced delay flow with failed readiness stays blocked on the toggle", async ({ page }) => {
  const s = fresh({ items: [3, 2, 1], readinessKinds: { 3: "delay" }, readinessMissingByRevision: { 3: ["scheduler"] } });
  const dialogs = acceptDialogs(page);
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await toggle.click();
  await expect(page.getByRole("status").filter({ hasText: "غير جاهز للتفعيل" })).toContainText("scheduler");
  expect(s.calls.filter((c) => c.action === "readiness")).toEqual([expect.objectContaining({ flowKey: "default", revision: 3 })]);
  expect(mutations(s)).toHaveLength(0);
  expect(dialogs).toHaveLength(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("an unclassifiable readiness report fails closed: no activate", async ({ page }) => {
  const s = fresh({ items: [3, 2, 1], readinessMalformed: true });
  const dialogs = acceptDialogs(page);
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-enabled-toggle").click();
  await expect(page.getByRole("status").filter({ hasText: "غير جاهز للتفعيل" })).toContainText("readiness_unclassified");
  expect(mutations(s)).toHaveLength(0);
  expect(dialogs).toHaveLength(0);
});

/* ---------- Cross-account isolation (mocked server, per-account state, two sessions) ---------- */
const ACC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const twoTenants = (): MultiAccountServer => ({
  accounts: {
    [ACC_A]: { id: ACC_A, flows: { flow_a: [3, 2, 1] }, active: { flow_key: "flow_a", revision: 2 } },
    [ACC_B]: { id: ACC_B, flows: { flow_b: [5, 4, 3, 2, 1] }, active: { flow_key: "flow_b", revision: 4 } },
  },
  calls: [],
});
const callsOf = (s: MultiAccountServer, session: string) => s.calls.filter((c) => c.session === session && c.action !== "accounts");
const mutationsOf = (s: MultiAccountServer, session: string) => callsOf(s, session).filter((c) => c.action === "activate" || c.action === "deactivate");

test("isolation: session owning only A sends only A's id, flow key and revisions across load, update, OFF and ON", async ({ page }) => {
  const s = twoTenants();
  const bBefore = JSON.stringify(s.accounts[ACC_B]);
  acceptDialogs(page);
  await mockAccounts(page, s, { name: "user-a", owned: [ACC_A] });
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  const line = page.getByTestId("flow-live-revision");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(line).toHaveText("الإصدار المباشر: v2 · أحدث منشور: v3");
  await expect(line).toHaveAttribute("data-flow-key", "flow_a");
  // Update to latest (r3), then OFF, then ON again.
  await page.getByTestId("flow-update-latest").click();
  await expect(page.getByRole("status").filter({ hasText: "تم تحديث التدفق إلى الإصدار v3" })).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(page.getByRole("status").filter({ hasText: "تم تفعيل التدفق (الإصدار 3)" })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const mine = callsOf(s, "user-a");
  expect(mine.length).toBeGreaterThan(0);
  for (const c of mine) {
    expect(c.accountId).toBe(ACC_A);
    expect(["flow_a", "default"]).toContain(c.flowKey); // catalog carries the local editor id
    if (c.revision !== undefined) expect(c.revision).toBe(3);
    expect(JSON.stringify(c)).not.toMatch(/bbbbbbbb|flow_b/);
  }
  expect(mutationsOf(s, "user-a")).toEqual([
    expect.objectContaining({ action: "activate", accountId: ACC_A, flowKey: "flow_a", revision: 3 }),
    expect.objectContaining({ action: "deactivate", accountId: ACC_A, flowKey: "flow_a" }),
    expect.objectContaining({ action: "activate", accountId: ACC_A, flowKey: "flow_a", revision: 3 }),
  ]);
  // B's server state is byte-identical; nothing of B ever reached the page.
  expect(JSON.stringify(s.accounts[ACC_B])).toBe(bBefore);
  expect(await page.content()).not.toMatch(/flow_b|bbbbbbbb/);
});

test("isolation: a second session (tenant B) in a fresh context sees only its own flow and revisions", async ({ page, browser }) => {
  const s = twoTenants();
  acceptDialogs(page);
  await mockAccounts(page, s, { name: "user-a", owned: [ACC_A] });
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-update-latest").click();
  await expect(page.getByRole("status").filter({ hasText: "تم تحديث التدفق إلى الإصدار v3" })).toBeVisible();
  const aAfter = JSON.stringify(s.accounts[ACC_A]);
  const ctx = await browser.newContext();
  try {
    const pageB = await ctx.newPage();
    await mockAccounts(pageB, s, { name: "user-b", owned: [ACC_B] });
    await pageB.goto("/milanochat/#/flows");
    await expect(pageB.getByTestId("flow-enabled-toggle")).toHaveAttribute("aria-pressed", "true");
    const lineB = pageB.getByTestId("flow-live-revision");
    await expect(lineB).toHaveText("الإصدار المباشر: v4 · أحدث منشور: v5");
    await expect(lineB).toHaveAttribute("data-flow-key", "flow_b");
    for (const c of callsOf(s, "user-b")) {
      expect(c.accountId).toBe(ACC_B);
      expect(["flow_b", "default"]).toContain(c.flowKey);
      expect(JSON.stringify(c)).not.toMatch(/aaaaaaaa|flow_a/);
    }
    expect(mutationsOf(s, "user-b")).toHaveLength(0);
    expect(await pageB.content()).not.toMatch(/flow_a|aaaaaaaa/);
    // A's state is untouched by B's session.
    expect(JSON.stringify(s.accounts[ACC_A])).toBe(aAfter);
  } finally { await ctx.close(); }
});

test("isolation: a stale/foreign account id gets the server 403, shown with its code; no mutation, foreign key never adopted", async ({ page }) => {
  const s = twoTenants();
  const before = JSON.stringify(s.accounts);
  acceptDialogs(page);
  // The session's tenant owns only A, but a stale/foreign id B reaches the client.
  await mockAccounts(page, s, { name: "user-a", owned: [ACC_A], listed: [ACC_B] });
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await expect(page.getByTestId("flow-activation-reason")).toContainText("Account not authorized · HTTP 403");
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("flow-live-revision")).toHaveCount(0);
  await expect(page.getByTestId("flow-update-latest")).toHaveCount(0);
  expect(mutationsOf(s, "user-a")).toHaveLength(0);
  // The client never learned B's flow key: catalog/list failed, it stays on the local key.
  for (const c of callsOf(s, "user-a")) expect(["default"]).toContain(c.flowKey);
  expect(JSON.stringify(s.accounts)).toBe(before);
  expect(await page.content()).not.toMatch(/flow_b/);
});
