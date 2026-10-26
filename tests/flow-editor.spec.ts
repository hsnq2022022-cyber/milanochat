import { test, expect } from "@playwright/test";
test("editor loads, deletes an edge and undoes without touching other screens",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);
  const point=await page.locator(".react-flow__edge-interaction").first().evaluate(element=>{
    const line=element as SVGPathElement;
    const midpoint=line.getPointAtLength(line.getTotalLength()/2);
    const screen=midpoint.matrixTransform(line.getScreenCTM()!);
    return {x:screen.x,y:screen.y};
  });
  await page.mouse.click(point.x,point.y,{button:"right"});
  await expect(page.getByRole("button",{name:"حذف الاتصال"}).last()).toBeVisible();
  await page.getByRole("button",{name:"حذف الاتصال"}).last().click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(4);
  await page.getByTitle("تراجع Ctrl+Z").click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);
  await page.screenshot({path:"test-results/flow-editor.png",fullPage:true});
});
test("node deletion and undo preserve previous document",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await page.locator(".react-flow__node").nth(1).click();
  await page.getByRole("button",{name:"حذف الخطوة"}).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  await page.getByTitle("تراجع Ctrl+Z").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
});


test("compact canvas hides permanent sidebar and arranges the original graph",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await expect(page.getByText("مكتبة الخطوات")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"فتح إضافة خطوة"})).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await expect.poll(async()=>{
    return page.locator(".react-flow__node").evaluateAll(nodes=>{
      const y=nodes.slice(0,3).map(el=>el.getBoundingClientRect().top);
      return y[0]<y[1]&&y[1]<y[2];
    });
  }).toBe(true);
  await expect(page.getByText("خصائص العقدة")).toHaveCount(0);
  await page.waitForTimeout(650);
  await page.screenshot({path:"test-results/flow-compact-layout.png",fullPage:true});
});

test("plus on a connected node inserts a new step without orphaning the old branch",async({page})=>{
  await page.goto("/milanochat/#/flows");
  const start=page.locator(".react-flow__node").first();
  await start.hover();
  await start.locator("button[aria-label^='إضافة خطوة بعد']").click();
  const menu=page.getByRole("dialog",{name:"إضافة خطوة"});
  await expect(menu).toBeVisible();
  await menu.getByRole("button",{name:"إرسال رسالة"}).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  await expect(page.locator(".react-flow__edge")).toHaveCount(6);
  await page.getByTitle("تراجع Ctrl+Z").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);
});

test("floating add menu appears only on demand, and left inspector closes on blank canvas",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await expect(page.getByTestId("add-step-menu")).toHaveCount(0);
  await page.getByRole("button",{name:"فتح إضافة خطوة"}).click();
  const menu=page.getByTestId("add-step-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("button",{name:"نهاية"}).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  await page.locator(".react-flow__pane").click({position:{x:40,y:40}});
  await expect(page.getByText("خصائص العقدة")).toHaveCount(0);
});
