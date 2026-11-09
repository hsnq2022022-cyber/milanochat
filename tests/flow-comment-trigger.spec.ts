import { test, expect, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

type Extra = Record<string, unknown>;
async function seed(page: Page, trigger: Extra) {
  await page.addInitScript((extra) => {
    const n = (id: string, kind: string, y: number, data: Extra) => ({ id, type: "flowNode", position: { x: 0, y }, data: { kind, title: kind, text: "", ...data } });
    localStorage.setItem("social_flow_reactflow_v3", JSON.stringify({ version: 3, name: "comments", nodes: [
      n("s", "trigger", 0, { platform: "instagram", triggerMode: "comment", ...extra }),
      n("m", "message", 250, { text: "مرحبا" })],
      edges: [{ id: "e1", source: "s", target: "m", sourceHandle: "next", targetHandle: "in" }] }));
  }, trigger);
  await page.goto("/milanochat/#/flows");
}
const panel = (page: Page) => page.getByTestId("step-settings-panel");
const openTrigger = async (page: Page) => { await page.locator(".react-flow__node").first().click(); await expect(panel(page).getByTestId("comment-trigger-form")).toBeVisible(); };

test("radios reveal post id and keywords; keyword radio has 44px rows", async ({ page }) => {
  await seed(page, {});
  await openTrigger(page);
  const p = panel(page);
  await expect(p.getByRole("radio", { name: "كل المنشورات" })).toBeChecked();
  await expect(p.getByRole("radio", { name: "أي تعليق" })).toBeChecked();
  await expect(p.getByLabel("معرّف المنشور (Post ID)")).toHaveCount(0);
  await expect(p.getByTestId("trigger-keyword-settings")).toHaveCount(0);
  const box = await p.getByRole("radio", { name: "منشور محدد" }).locator("xpath=ancestor::label").boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await p.getByText("منشور محدد", { exact: true }).click();
  const post = p.getByLabel("معرّف المنشور (Post ID)");
  await expect(post).toBeVisible();
  await expect(post).toHaveAttribute("dir", "ltr");
  await expect(post).toHaveAttribute("required", "");
  await p.getByText("كلمة مفتاحية", { exact: true }).click();
  await expect(p.getByTestId("trigger-keyword-settings")).toBeVisible();
  await p.getByLabel("إدخال كلمة مفتاحية").fill("سعر");
  await p.getByLabel("حفظ الكلمة المفتاحية").click();
  await expect(p.getByTestId("saved-keywords")).toContainText("سعر");
  await p.getByText("كل المنشورات", { exact: true }).click();
  await expect(post).toHaveCount(0);
  await page.screenshot({ path: "test-results/flow-comment-trigger-390.png" });
});

test("public reply is required, shows live counter and caps at 2200", async ({ page }) => {
  await seed(page, {});
  await openTrigger(page);
  const reply = panel(page).getByTestId("public-reply-text");
  await expect(reply).toHaveAttribute("required", "");
  await expect(panel(page).getByTestId("public-reply-error")).toBeVisible();
  await expect(panel(page).getByTestId("public-reply-counter")).toHaveText("0/2200");
  await reply.fill("شكراً لتعليقك! أرسلنا لك التفاصيل في الخاص 💚");
  await expect(panel(page).getByTestId("public-reply-error")).toHaveCount(0);
  await expect(panel(page).getByTestId("public-reply-counter")).toContainText("/2200");
  await reply.fill("ا".repeat(2300));
  await expect(panel(page).getByTestId("public-reply-counter")).toHaveText("2200/2200");
  expect((await reply.inputValue()).length).toBe(2200);
  await reply.fill("   ");
  await expect(panel(page).getByTestId("public-reply-error")).toBeVisible();
});

test("settings persist after selecting another node and back", async ({ page }) => {
  await seed(page, {});
  await openTrigger(page);
  const p = panel(page);
  await p.getByText("منشور محدد", { exact: true }).click();
  await p.getByLabel("معرّف المنشور (Post ID)").fill("17912345678901234");
  await p.getByText("كلمة مفتاحية", { exact: true }).click();
  await p.getByLabel("إدخال كلمة مفتاحية").fill("اشتراك");
  await p.getByLabel("حفظ الكلمة المفتاحية").click();
  await p.getByTestId("public-reply-text").fill("تم الرد 💚");
  await p.getByRole("button", { name: "إغلاق المحرر" }).click();
  await page.locator(".react-flow__node").nth(1).click();
  await expect(p.getByTestId("comment-trigger-form")).toHaveCount(0);
  await p.getByRole("button", { name: "إغلاق المحرر" }).click();
  await page.locator(".react-flow__node").first().click();
  await expect(p.getByRole("radio", { name: "منشور محدد" })).toBeChecked();
  await expect(p.getByRole("radio", { name: "كلمة مفتاحية" })).toBeChecked();
  await expect(p.getByLabel("معرّف المنشور (Post ID)")).toHaveValue("17912345678901234");
  await expect(p.getByTestId("saved-keywords")).toContainText("اشتراك");
  await expect(p.getByTestId("public-reply-text")).toHaveValue("تم الرد 💚");
});

test("old comment document without new fields loads with derived defaults", async ({ page }) => {
  await seed(page, { keywords: "سعر, اشتراك" });
  await openTrigger(page);
  const p = panel(page);
  await expect(p.getByRole("radio", { name: "كل المنشورات" })).toBeChecked();
  await expect(p.getByRole("radio", { name: "كلمة مفتاحية" })).toBeChecked();
  await expect(p.getByTestId("saved-keywords")).toContainText("اشتراك");
  await expect(p.getByTestId("public-reply-text")).toHaveValue("");
});

test("old comment document with no keywords defaults to any comment", async ({ page }) => {
  await seed(page, { keywords: "" });
  await openTrigger(page);
  await expect(panel(page).getByRole("radio", { name: "أي تعليق" })).toBeChecked();
});

test("message trigger shows no comment form", async ({ page }) => {
  await seed(page, { triggerMode: "message" });
  await page.locator(".react-flow__node").first().click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId("comment-trigger-form")).toHaveCount(0);
});
