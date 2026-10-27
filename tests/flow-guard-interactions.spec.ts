import {test,expect} from "@playwright/test";

test("Ctrl+D and Ctrl+V refuse to duplicate the sole trigger",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await page.locator(".react-flow__node").first().click();
  await page.keyboard.press("Control+d");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await expect(page.getByRole("status")).toContainText("بداية واحدة");
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await expect(page.getByRole("status")).toContainText("لا يمكن نسخ نقطة البداية");
});

test("node Ctrl+D creates one inactive non-trigger copy and one undo entry",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await page.locator(".react-flow__node").nth(1).click();
  await page.keyboard.press("Control+d");
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  await expect(page.locator(".react-flow__node").filter({hasText:"بداية الأتمتة"})).toHaveCount(1);
  await page.getByTitle("تراجع Ctrl+Z").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
});

test("trigger delete asks confirmation and undo restores the original",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await page.locator(".react-flow__node").first().click();
  page.once("dialog",d=>d.dismiss());
  await page.keyboard.press("Delete");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  page.once("dialog",d=>d.accept());
  await page.keyboard.press("Delete");
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  await page.getByTitle("تراجع Ctrl+Z").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
});

test("flow enable UI explicitly says it does not send customer messages",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await expect(page.getByTestId("flow-enabled-toggle")).toContainText("تفعيل محلي للتجربة — لا يرسل رسائل");
});
