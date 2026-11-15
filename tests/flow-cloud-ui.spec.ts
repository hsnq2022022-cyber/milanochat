import { test, expect } from "@playwright/test";

// The button exists only in builds with VITE_ENABLE_CLOUD_FLOW_DRAFTS=true; playwright.config.ts sets it for the dev server (as CI and deploy do).

test("cloud draft preview requires explicit action and never overwrites local flows", async ({ page }) => {
  await page.goto("/milanochat/#/flows");
  const button = page.getByTestId("flow-cloud-drafts");
  await expect(button).toBeVisible();
  await expect(page.getByRole("dialog", { name: "المسودات السحابية" })).toHaveCount(0);

  // التأكد من عدم وجود طلبات سحابية أو تعديل محلي قبل الضغط.
  await page.waitForTimeout(900); // انتظار أول حفظ محلي تلقائي لتثبيت نقطة المقارنة
  const savedBefore = await page.evaluate(() => localStorage.getItem("social_flow_library_v1"));
  await button.click();
  const dialog = page.getByRole("dialog", { name: "المسودات السحابية" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("لا يحدث رفع أو تنزيل تلقائي.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "حفظ التدفق الحالي سحابيًا" })).toBeDisabled();

  await dialog.getByRole("button", { name: "عرض المسودات السحابية" }).click();
  // Without VITE_SUPABASE_URL the panel says "not configured"; with a (mock/unreachable)
  // Supabase URL it reports cloud storage unavailable. Either way nothing is loaded or replaced.
  await expect(dialog.getByRole("status")).toContainText(/لم يتم إعداد Supabase|التخزين السحابي غير متاح/);
  await expect(dialog.getByRole("button", { name: "حفظ التدفق الحالي سحابيًا" })).toBeDisabled();
  const savedAfter = await page.evaluate(() => localStorage.getItem("social_flow_library_v1"));
  expect(savedAfter).toBe(savedBefore);
  await dialog.getByRole("button", { name: "إغلاق المسودات السحابية" }).click();
  await expect(dialog).toHaveCount(0);
});
