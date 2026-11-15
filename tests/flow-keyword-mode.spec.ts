import { test, expect, type Page } from "@playwright/test";

/** Keyword trigger match mode select (stored in the trigger's operator field). */
async function seed(page: Page, trigger: Record<string, unknown>) {
  await page.addInitScript((extra) => {
    const n = (id: string, kind: string, y: number, data: Record<string, unknown>) =>
      ({ id, type: "flowNode", position: { x: 0, y }, data: { kind, title: kind, text: "", ...data } });
    localStorage.setItem("social_flow_reactflow_v3", JSON.stringify({ version: 3, name: "kw", nodes: [
      n("s", "trigger", 0, { platform: "instagram", triggerMode: "keyword", keywords: "menu", ...extra }),
      n("m", "message", 250, { text: "hello" })],
      edges: [{ id: "e1", source: "s", target: "m", sourceHandle: "next", targetHandle: "in" }] }));
  }, trigger);
  await page.goto("/milanochat/#/flows");
}
const stored = (page: Page) => page.evaluate(() =>
  JSON.parse(localStorage.getItem("social_flow_reactflow_v3") ?? "{}").nodes?.find((n: { id: string }) => n.id === "s")?.data?.operator);

test("keyword trigger: match mode select (contains default, exact) only for keyword triggers", async ({ page }) => {
  await seed(page, {});
  await page.locator(".react-flow__node").first().click();
  const aside = page.getByTestId("step-settings-panel");
  const mode = aside.getByTestId("trigger-keyword-match-mode");
  await expect(mode).toBeVisible();
  await expect(mode).toHaveValue("contains");
  await expect(mode.locator("option")).toHaveText(["يحتوي الكلمة / Contains the word", "مطابقة تامة / Exact"]);
  await mode.selectOption("exact");
  await expect(mode).toHaveValue("exact");
  await expect.poll(() => stored(page), { timeout: 5000 }).toBe("exact");
  await mode.selectOption("contains");
  await expect.poll(() => stored(page), { timeout: 5000 }).toBe("contains");
  // Not shown for message / comment triggers.
  const event = aside.getByRole("combobox", { name: "نوع الحدث" });
  await event.selectOption("message");
  await expect(aside.getByTestId("trigger-keyword-match-mode")).toHaveCount(0);
  await event.selectOption("comment");
  await expect(aside.getByTestId("trigger-keyword-match-mode")).toHaveCount(0);
});

test("legacy operator value on a keyword trigger shows as contains (documented mapping)", async ({ page }) => {
  await seed(page, { operator: "equals" });
  await page.locator(".react-flow__node").first().click();
  await expect(page.getByTestId("step-settings-panel").getByTestId("trigger-keyword-match-mode")).toHaveValue("contains");
});
