import { test, expect } from "@playwright/test";

/* حدّ الأخطاء للمسارات الكسولة: فشل تحميل وحدة الصفحة يعرض رسالة عربية وزر إعادة تحميل بدل شاشة فارغة */
for (const [hash, chunk] of [["#/dashboard", "Dashboard"], ["#/settings", "Settings"], ["#/widgets", "Widgets"]] as const) {
  test(`failed ${chunk} chunk shows the reload screen`, async ({ page }) => {
    await page.route(new RegExp(`/src/pages/${chunk}\\.tsx`), (route) => route.abort());
    await page.goto(`/milanochat/${hash}`);
    const box = page.getByTestId("route-error");
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute("role", "alert");
    await expect(box).toContainText("حدث خطأ غير متوقع أثناء تحميل الصفحة");
    const reload = box.getByRole("button", { name: "إعادة التحميل" });
    await expect(reload).toBeVisible();
    expect((await reload.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(box.getByRole("link", { name: /الصفحة الرئيسية/ })).toHaveAttribute("href", "#/");
  });
}

test("reload button recovers once the chunk is reachable", async ({ page }) => {
  await page.route(/\/src\/pages\/Dashboard\.tsx/, (route) => route.abort());
  await page.goto("/milanochat/#/dashboard");
  await expect(page.getByTestId("route-error")).toBeVisible();
  await page.unroute(/\/src\/pages\/Dashboard\.tsx/);
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "إعادة التحميل" }).click()]);
  await expect(page.getByTestId("route-error")).toHaveCount(0);
  expect(page.url()).toContain("#/dashboard");
});

test("boundary screen fits 390px without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.route(/\/src\/pages\/Widgets\.tsx/, (route) => route.abort());
  await page.goto("/milanochat/#/widgets");
  await expect(page.getByTestId("route-error")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
  if (process.env.ROUTE_ERR_SHOT) await page.screenshot({ path: process.env.ROUTE_ERR_SHOT });
});

test("landing page has no fake pay-now button", async ({ page }) => {
  await page.goto("/milanochat/");
  await expect(page.getByText("ادفع الآن — 40,000 دينار")).toHaveCount(0);
});
