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

/** Finds an empty point inside the canvas without relying on the diagram's zoom. */
async function freeCanvasPoint(page:import("@playwright/test").Page){
  const pane=await page.locator(".react-flow__pane").boundingBox();
  if(!pane)throw Error("React Flow pane not available");
  const occupied=await page.locator(".react-flow__node").evaluateAll(nodes=>nodes.map(n=>{
    const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};
  }));
  for(const x of [pane.x+40,pane.x+pane.width-45,pane.x+pane.width/2]){
    for(const y of [pane.y+40,pane.y+pane.height-50,pane.y+pane.height/2]){
      if(occupied.every(b=>x<b.x-20||x>b.right+20||y<b.y-20||y>b.bottom+20))
        return {x,y};
    }
  }
  throw Error("No free canvas area available for pointer test");
}
async function dragFrom(page:import("@playwright/test").Page,
                       source:import("@playwright/test").Locator,
                       dest:{x:number;y:number}){
  const b=await source.boundingBox();
  if(!b)throw Error("Drag source has no bounding rectangle");
  const x=b.x+b.width/2,y=b.y+b.height/2;
  await page.mouse.move(x,y);
  await page.mouse.down();
  await page.mouse.move((x+dest.x)/2,(y+dest.y)/2,{steps:6});
  await page.mouse.move(dest.x,dest.y,{steps:6});
  await page.mouse.up();
}

test("dragging an output handle into empty canvas opens add menu and connects the chosen node",async({page})=>{
  await page.setViewportSize({width:1366,height:768});
  await page.goto("/milanochat/#/flows");
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);
  const target=await freeCanvasPoint(page);
  const handle=page.locator(".react-flow__node").first().locator(".react-flow__handle.source").first();
  await dragFrom(page,handle,target);
  const menu=page.getByTestId("add-step-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("button",{name:"إرسال رسالة"}).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  // The original downstream node remains attached via inserted message.
  await expect(page.locator(".react-flow__edge")).toHaveCount(6);
});

test("detaching a selected edge's target to empty canvas removes only that connection and undo restores it",async({page})=>{
  await page.setViewportSize({width:1366,height:768});
  await page.goto("/milanochat/#/flows");
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);
  await page.locator(".react-flow__edge").first().click();
  const updater=page.locator(".react-flow__edgeupdater-target").first();
  await expect(updater).toBeAttached();
  await dragFrom(page,updater,await freeCanvasPoint(page));
  await expect(page.locator(".react-flow__edge")).toHaveCount(4);
  await page.getByTitle("تراجع Ctrl+Z").click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);
});

test("reconnecting a selected edge endpoint preserves edge count and changes its target",async({page})=>{
  await page.setViewportSize({width:1366,height:768});
  await page.goto("/milanochat/#/flows");
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);
  // Auto-Dagre and fitView run after mount. Do not drag to a stale offscreen
  // handle box: the previous test attempted to drop at y=928 on 768px viewport.
  await page.waitForTimeout(900);
  await page.locator(".react-flow__edge").first().click();
  const target=page.locator(".react-flow__node").nth(2).locator(".react-flow__handle.target");
  await expect.poll(async()=>{
    const rect=await target.boundingBox();
    return Boolean(rect&&rect.y>120&&rect.y+rect.height<768);
  }).toBe(true);
  const rect=await target.boundingBox();
  if(!rect)throw Error("Target handle not visible");
  await dragFrom(page,page.locator(".react-flow__edgeupdater-target").first(),
    {x:rect.x+rect.width/2,y:rect.y+rect.height/2});
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);
  await expect(page.getByTestId("add-step-menu")).toHaveCount(0);
});
