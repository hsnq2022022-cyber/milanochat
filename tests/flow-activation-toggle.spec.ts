import { test, expect } from "@playwright/test";
import { MOCK_HOST, mockActivation, type ActivationServer } from "./flowActivationMock";

test.skip(!MOCK_HOST, "needs VITE_SUPABASE_URL=http://mock.supabase.test (fake host)");

const fresh = (o: Partial<ActivationServer> = {}): ActivationServer => ({ active: null, calls: [], ...o });
const mutations = (s: ActivationServer) => s.calls.filter((c) => c.action === "activate" || c.action === "deactivate");

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
  expect([...actions].sort()).toEqual(["accounts", "list"]);
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
  expect(mutations(s)[1]).toMatchObject({ action: "deactivate" });
  expect(s.active).toBeNull();
});

test("unsupported-feature rejection shows an Arabic error and the toggle stays off", async ({ page }) => {
  const s = fresh({ mutationError: { status: 422, error: "This flow uses unsupported runtime features" } });
  await mockActivation(page, s);
  await page.goto("/milanochat/#/flows");
  const toggle = page.getByTestId("flow-enabled-toggle");
  await toggle.click();
  await expect(page.getByRole("status").filter({ hasText: "تعذر التفعيل: الميزة غير مدعومة" })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("unknown server error falls back to the generic Arabic message", async ({ page }) => {
  await mockActivation(page, fresh({ mutationError: { status: 500, error: "weird" } }));
  await page.goto("/milanochat/#/flows");
  await page.getByTestId("flow-enabled-toggle").click();
  await expect(page.getByRole("status").filter({ hasText: /^تعذر التفعيل/ })).toBeVisible();
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
