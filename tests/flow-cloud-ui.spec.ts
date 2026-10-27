import { test, expect } from "@playwright/test";

test("cloud draft preview requires explicit action and never overwrites local flows", async ({ page }) => {
  await page.goto("/milanochat/#/flows");
  const button = page.getByTestId("flow-cloud-drafts");
  await expect(button).toBeVisible();
  await expect(page.getByRole("dialog", { name: "المسودات السحابية" })).toHaveCount(0);

  // التأكد من عدم وجود طلبات سحابية أو تعديل محلي قبل الضغط.
  const savedBefore = await page.evaluate(() => localStorage.getItem("social_flow_library_v1"));
  await button.click();
  const dialog = page.getByRole("dialog", { name: "المسودات السحابية" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("لا يحدث رفع أو تنزيل تلقائي.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "حفظ التدفق الحالي سحابيًا" })).toBeDisabled();

  await dialog.getByRole("button", { name: "عرض المسودات السحابية" }).click();
  await expect(dialog.getByRole("status")).toContainText("لم يتم إعداد Supabase");
  await expect(dialog.getByRole("button", { name: "حفظ التدفق الحالي سحابيًا" })).toBeDisabled();
  const savedAfter = await page.evaluate(() => localStorage.getItem("social_flow_library_v1"));
  expect(savedAfter).toBe(savedBefore);
  await dialog.getByRole("button", { name: "إغلاق المسودات السحابية" }).click();
  await expect(dialog).toHaveCount(0);
});
