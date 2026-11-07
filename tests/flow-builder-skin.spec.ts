import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function dragHandle(page:Page,dy:number){
  const box=(await page.getByTestId("step-sheet-handle").boundingBox())!;
  const x=box.x+box.width/2,y=box.y+box.height/2;
  await page.mouse.move(x,y);await page.mouse.down();
  const steps=12;
  for(let i=1;i<=steps;i++){await page.mouse.move(x,y+dy*i/steps);await page.waitForTimeout(16);}
  await page.waitForTimeout(120); // settle without momentum so the nearest snap point wins
  await page.mouse.up();
}

test("phone step inspector is a draggable bottom sheet with half/full snap points",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto("/milanochat/#/flows");
  await page.locator(".react-flow__node").nth(1).click();
  const panel=page.getByTestId("step-settings-panel");
  await expect(panel).toHaveAttribute("data-snap","half");
  await expect.poll(async()=>Math.round((await panel.boundingBox())!.height)).toBeLessThanOrEqual(Math.round(844*.5)+2);
  expect((await panel.boundingBox())!.height).toBeGreaterThan(844*.45);

  await dragHandle(page,-330);
  await expect(panel).toHaveAttribute("data-snap","full");
  await expect.poll(async()=>(await panel.boundingBox())!.height).toBeGreaterThan(844*.88);

  const handle=page.getByTestId("step-sheet-handle");
  await expect(handle).toHaveAttribute("aria-expanded","true");
  await handle.click();
  await expect(panel).toHaveAttribute("data-snap","half");
  await handle.press("Enter");
  await expect(panel).toHaveAttribute("data-snap","full");
  await handle.press("Enter");
  await expect(panel).toHaveAttribute("data-snap","half");

  await expect.poll(async()=>Math.round((await panel.boundingBox())!.height)).toBeLessThanOrEqual(Math.round(844*.5)+2);
  await dragHandle(page,380);
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(6);

  await page.locator(".react-flow__node").nth(1).click();
  await expect(panel).toHaveAttribute("data-snap","half");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("flow switcher lists the real local flows and opens the chosen one",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await page.getByRole("button",{name:"إنشاء تدفق جديد"}).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.getByTestId("flow-switcher").click();
  const list=page.getByTestId("flow-switcher-list");
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.locator("[aria-current='true']")).toHaveCount(1);
  await list.getByRole("button").first().click();
  await expect(list).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await expect(page.getByRole("combobox",{name:"اختيار التدفق"})).toHaveValue("default");
  await page.getByTestId("flow-switcher").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("flow-switcher-list")).toHaveCount(0);
});

test("add-step palette lists the logic nodes by name and the AI/tag/notify/handoff action shortcuts",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await page.locator(".fs-fab").click();
  const pal=page.locator(".fs-palette");
  for(const name of ["شرط","إجراء","توزيع عشوائي"])await expect(pal.getByRole("button",{name,exact:true})).toBeVisible();
  for(const id of ["ai","tag","notify","handoff"])await expect(pal.getByTestId("pal-preset-"+id)).toHaveCount(1);
  const before=await page.locator(".react-flow__node").count();
  await pal.getByTestId("pal-preset-handoff").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before+1);
});

test("builder works on an insecure origin where crypto.randomUUID is undefined (plain http LAN IP)",async({page})=>{
  const errors:string[]=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(()=>{Object.defineProperty(crypto,"randomUUID",{value:undefined,configurable:true});});
  await page.goto("/milanochat/#/flows");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  expect(await page.evaluate(()=>typeof crypto.randomUUID)).toBe("undefined");
  const before=await page.locator(".react-flow__node").count();
  await page.locator(".fs-fab").click();
  await page.locator(".fs-palette").getByRole("button",{name:"سؤال وجمع بيانات",exact:true}).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before+1);
  expect(errors.filter(m=>/randomUUID|is not a function/i.test(m))).toEqual([]);
});
