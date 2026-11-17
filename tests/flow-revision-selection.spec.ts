import { test, expect, type Page } from "@playwright/test";

/**
 * Explicit revision selection in the editor toolbar and the publications panel.
 *   VITE_SUPABASE_URL=http://mock.supabase.test VITE_SUPABASE_ANON_KEY=fake-anon-key npx playwright test tests/flow-revision-selection.spec.ts
 * Every edge-function call is fulfilled by page.route; nothing leaves the machine.
 */
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const KEY = "default"; // the local editor flow, published under its own key
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;
test.skip(!URL_.startsWith("http://mock."), "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

type Kind = "text" | "buttons" | "delay" | "bad";
type Server = { active: number | null; revisions: number[]; kinds: Record<number, Kind>; calls: any[] };
const CHECKS = ["instagram", "tenant", "account", "globalSwitch", "tenantSwitch", "credits", "activeRevision", "supportedCandidate",
  "ingress", "activation", "canary", "operatorRelease", "outbox", "atomicDebit", "encryption", "scheduler", "buttons"];

async function mock(page: Page, s: Server) {
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
    s.calls.push(b);
    if (b.flowKey !== undefined && b.flowKey !== KEY && b.action !== "accounts") return reply({ ok: false, error: "unexpected flow" }, 400);
    const activeFlows = s.active === null ? [] : [{ flow_key: KEY, revision: s.active }];
    switch (b.action) {
      case "accounts": return reply({ ok: true, accounts: [{ id: ACCOUNT, platform: "instagram", is_active: true, canActivate: true }] });
      case "catalog": return reply({ ok: true, flows: [{ flowKey: KEY, latestRevision: s.revisions[0] }], activeFlows, active: activeFlows[0] ?? null, truncated: false });
      case "list": return reply({ ok: true, items: s.revisions.map((revision) => ({ revision, created_at: "2026-11-0" + revision })),
        activation: s.active === null ? null : { revision: s.active, is_active: true }, truncated: false });
      case "readiness": {
        const rev = b.revision ?? s.active;
        const kind = s.kinds[rev];
        const found = kind !== undefined, bad = kind === "bad" || !found;
        const checks = Object.fromEntries(CHECKS.map((c) => [c, c === "activeRevision" ? s.active !== null : c === "supportedCandidate" ? !bad : true]));
        return reply({ ok: true, candidateRevision: rev ?? null, readiness: { checks, candidateKind: bad ? "unsupported" : kind,
          needsButtons: kind === "buttons", needsScheduler: kind === "delay", needsInternalActions: false, needsMedia: false,
          buttonsConfigured: kind === "buttons", delayConfigured: kind === "delay", configured: !bad,
          candidate: { flowKey: KEY, revision: rev ?? null, source: b.revision ? "requested" : "active", found, activeRevision: s.active,
            engine: bad ? null : kind === "text" ? "v2" : "durable",
            reasons: { activeRevision: s.active === null ? "no_active_revision" : null, supportedCandidate: !found ? "revision_not_found" : bad ? "not_durable" : kind === "text" ? "not_durable_v2" : null } } } });
      }
      case "activate": case "rollback": s.active = b.revision; return reply({ ok: true, active: true, revision: b.revision });
      case "deactivate": s.active = null; return reply({ ok: true, active: false });
      default: return reply({ ok: false, error: "unexpected" });
    }
  });
}
const fresh = (o: Partial<Server> = {}): Server => ({ active: null, revisions: [5, 4, 3, 2], kinds: { 2: "text", 3: "buttons", 4: "delay", 5: "bad" }, calls: [], ...o });
const activations = (s: Server) => s.calls.filter((c) => c.action === "activate" || c.action === "rollback");
const dialogsOf = (page: Page) => { const seen: string[] = []; page.on("dialog", (d) => { seen.push(d.message()); void d.accept(); }); return seen; };
const status = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

test("editor: no default selection; V3 then V4 replaces it with a confirm naming both; reload restores the server state", async ({ page }) => {
  const s = fresh();
  const dialogs = dialogsOf(page);
  await mock(page, s);
  await page.goto("/milanochat/#/flows");
  const select = page.getByTestId("flow-revision-select");
  const go = page.getByTestId("flow-activate-selected");
  await expect(select).toHaveValue("");
  await expect(go).toBeDisabled();
  await select.selectOption("3");
  await go.click();
  await expect(status(page, "تم تفعيل الإصدار v3")).toBeVisible();
  expect(activations(s)).toEqual([expect.objectContaining({ action: "activate", flowKey: KEY, accountId: ACCOUNT, revision: 3 })]);
  await expect(page.getByTestId("flow-live-revision")).toHaveText("الإصدار المباشر: v3 · أحدث منشور: v5");
  await select.selectOption("4");
  await go.click();
  await expect(status(page, "بدل v3")).toBeVisible();
  expect(dialogs.at(-1)).toContain("Revision v3 (currently active) of flow \"default\" will be replaced by revision v4");
  expect(activations(s).map((c) => c.revision)).toEqual([3, 4]);
  await expect(page.getByTestId("flow-live-revision")).toHaveText("الإصدار المباشر: v4 · أحدث منشور: v5");
  // Readiness ran for exactly each selected revision before its activate.
  expect(s.calls.filter((c) => c.action === "readiness").map((c) => c.revision)).toEqual([3, 4]);
  await page.reload();
  await expect(page.getByTestId("flow-live-revision")).toHaveText("الإصدار المباشر: v4 · أحدث منشور: v5");
  await expect(page.getByTestId("flow-revision-select")).toHaveValue("");
  await expect(page.getByTestId("flow-revision-select").locator("option", { hasText: "v4 · نشط" })).toHaveCount(1);
});

test("editor: unsupported revision and stale state are refused without any activate call", async ({ page }) => {
  const s = fresh();
  dialogsOf(page);
  await mock(page, s);
  await page.goto("/milanochat/#/flows");
  const select = page.getByTestId("flow-revision-select");
  await select.selectOption("5");
  await page.getByTestId("flow-activate-selected").click();
  await expect(status(page, "غير جاهز للتفعيل")).toContainText("not_durable");
  // Another session activates v2 behind our back: the loaded state is stale.
  s.active = 2;
  await select.selectOption("3");
  await page.getByTestId("flow-activate-selected").click();
  await expect(status(page, "تغيّر الإصدار النشط على الخادم")).toBeVisible();
  expect(activations(s)).toHaveLength(0);
  await expect(page.getByTestId("flow-live-revision")).toHaveText("الإصدار المباشر: v2 · أحدث منشور: v5");
});

test("panel: draft row, per-revision status and reasons, unsupported refused, V3 -> V4 replacement", async ({ page }) => {
  const s = fresh({ active: 3 });
  const dialogs = dialogsOf(page);
  await mock(page, s);
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-publications").click();
  const dialog = page.getByRole("dialog", { name: "الإصدارات المنشورة" });
  await dialog.getByRole("combobox").first().selectOption(ACCOUNT);
  await dialog.getByRole("button", { name: "عرض الإصدارات" }).click();
  await expect(dialog.getByTestId("revision-draft")).toContainText("لا يمكن تفعيلها قبل النشر");
  await expect(dialog.getByTestId("revision-status-3")).toHaveAttribute("data-status", "active");
  await expect(dialog.getByTestId("revision-status-4")).toHaveAttribute("data-status", "unchecked");
  await dialog.getByTestId("select-published-revision-5").click();
  await expect(dialog.getByTestId("revision-status-5")).toHaveAttribute("data-status", "unsupported");
  await expect(dialog.getByTestId("revision-reasons-5")).toContainText("غير مدعوم في أي محرك");
  await dialog.getByRole("button", { name: "الرجوع لهذا الإصدار" }).nth(0).click(); // row of v5
  await expect(dialog.getByText("لا يمكن تفعيل الإصدار v5", { exact: false })).toBeVisible();
  expect(activations(s)).toHaveLength(0);
  await dialog.getByTestId("select-published-revision-4").click();
  await expect(dialog.getByTestId("revision-status-4")).toHaveAttribute("data-status", "candidate");
  await dialog.getByRole("button", { name: "الرجوع لهذا الإصدار" }).nth(1).click(); // row of v4
  await expect(dialog.getByText("الإصدار النشط: 4")).toBeVisible();
  expect(activations(s)).toEqual([expect.objectContaining({ action: "rollback", flowKey: KEY, revision: 4 })]);
  expect(dialogs.at(-1)).toContain("will be replaced by revision v4");
  await expect(dialog.getByTestId("revision-status-4")).toHaveAttribute("data-status", "active");
  await expect(dialog.getByTestId("revision-status-3")).not.toHaveAttribute("data-status", "active");
});
