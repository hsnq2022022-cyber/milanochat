import { expect, test } from "@playwright/test";

test("phase 6 phone editor is a bounded bottom sheet; collapse does not lose edits",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto("/milanochat/#/flows");
 await expect(page.locator('[aria-label="مساحة التدفقات"]')).toHaveAttribute("data-touch-pan","true");
 await page.locator(".react-flow__node").nth(1).click();
 const panel=page.getByTestId("step-settings-panel");
 await expect(panel).toBeVisible();
 const bounds=await panel.boundingBox();
 expect(bounds).not.toBeNull();
 expect(bounds!.width).toBeLessThanOrEqual(391);
 expect(bounds!.height).toBeLessThanOrEqual(844*.79);
 expect(bounds!.y).toBeGreaterThan(130);
 const content=panel.getByRole("textbox",{name:"نص الرسالة"});
 await content.fill("رسالة تجربة الهاتف");
 await panel.getByRole("button",{name:"طي إعدادات الخطوة"}).click();
 const compact=await panel.boundingBox();
 expect(compact).not.toBeNull();
 expect(compact!.height).toBeLessThanOrEqual(85);
 await panel.getByRole("button",{name:"إظهار إعدادات الخطوة"}).click();
 await expect(content).toHaveValue("رسالة تجربة الهاتف");
 await page.keyboard.press("Escape");
 await expect(panel).toHaveCount(0);
});

test("phase 6 phone toolbars fit viewport and remain scrollable",async({page})=>{
 await page.setViewportSize({width:360,height:740});
 await page.goto("/milanochat/#/flows");
 await expect(page.getByTestId("flow-toolbar-actions")).toBeVisible();
 await expect(page.getByTestId("flow-toolbar-secondary")).toBeVisible();
 const safe=await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2);
 expect(safe,"No horizontal body overflow on small phones").toBe(true);
 await page.getByRole("button",{name:"طي شريط أدوات التدفقات"}).click();
 await expect(page.getByTestId("flow-toolbar-secondary")).toHaveCount(0);
 await page.getByRole("button",{name:"إظهار شريط أدوات التدفقات"}).click();
 await expect(page.getByTestId("flow-toolbar-secondary")).toBeVisible();
 await expect(page.locator(".react-flow__minimap")).toBeHidden();
});

test("phase 6 language toggle reverses shell direction without altering graph contents",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await expect(page.getByRole("textbox",{name:"اسم التدفق"})).toBeVisible();
 const before=await page.locator(".react-flow__node").allTextContents();
 await page.getByTestId("flow-ui-language").selectOption("en");
 await expect(page.locator('[data-testid="flow-toolbar-secondary"]')).toBeVisible();
 await expect(page.getByRole("button",{name:"Preview"})).toBeVisible();
 await expect(page.getByRole("textbox",{name:"Flow name"})).toBeVisible();
 await expect(page.getByRole("button",{name:"Hide flow toolbar"})).toBeVisible();
 await expect(page.locator(".react-flow__node")).toHaveText(before);
 await expect(page.locator('div[dir="ltr"]').first()).toBeVisible();
 await page.locator(".react-flow__node").nth(2).click();
 await expect(page.getByTestId("step-settings-panel")).toHaveAttribute("dir","ltr");
 await expect(page.getByTestId("step-settings-panel").getByRole("combobox",{name:"Response type"})).toBeVisible();
 await page.getByTestId("flow-ui-language").selectOption("ar");
 await expect(page.getByRole("button",{name:"تجربة"})).toBeVisible();
 await expect(page.getByTestId("step-settings-panel")).toHaveAttribute("dir","rtl");
 await expect(page.locator(".react-flow__node")).toHaveText(before);
});

test("phase 6 preview on phone keeps restart and submit within viewport",async({page})=>{
 await page.setViewportSize({width:390,height:720});
 await page.goto("/milanochat/#/flows");
 await page.getByRole("button",{name:"تجربة"}).click();
 const sim=page.getByTestId("flow-simulator");
 await expect(sim).toBeVisible();
 const footer=sim.getByRole("button",{name:"إعادة",exact:true});
 await expect(footer).toBeVisible();
 const rect=await footer.boundingBox();
 expect(rect).not.toBeNull();
 expect(rect!.y+rect!.height).toBeLessThanOrEqual(721);
 await sim.getByRole("button",{name:"إغلاق المعاينة"}).click();
 await expect(sim).toHaveCount(0);
});

test("local simulator can evaluate both Instagram condition branches without a provider send",async({page})=>{
 const start={id:"start",type:"flowNode",position:{x:0,y:0},data:{
  kind:"trigger",title:"Start",platform:"instagram",triggerMode:"message"
 }};
 const condition={id:"condition",type:"flowNode",position:{x:0,y:100},data:{
  kind:"condition",title:"Contains price",conditionField:"message",
  conditionValue:"سعر",operator:"contains"
 }};
 const yes={id:"price",type:"flowNode",position:{x:0,y:220},data:{
  kind:"message",title:"Price",text:"مسار الأسعار",image:"",options:[],contentBlocks:[]
 }};
 const no={id:"general",type:"flowNode",position:{x:220,y:220},data:{
  kind:"message",title:"General",text:"مسار الترحيب",image:"",options:[],contentBlocks:[]
 }};
 const document={version:3,name:"Safe isolated condition preview",
  nodes:[start,condition,yes,no],edges:[
   {id:"a",source:"start",target:"condition",sourceHandle:"next",targetHandle:"in",type:"flowEdge"},
   {id:"b",source:"condition",target:"price",sourceHandle:"yes",targetHandle:"in",type:"flowEdge"},
   {id:"c",source:"condition",target:"general",sourceHandle:"no",targetHandle:"in",type:"flowEdge"}
  ]};
 page.on("dialog",dialog=>{void dialog.accept();});
 await page.goto("/milanochat/#/flows");
 await page.locator('input[accept=".json,application/json"]').setInputFiles({
  name:"safe-condition.json",mimeType:"application/json",
  buffer:Buffer.from(JSON.stringify(document),"utf8")
 });
 await expect(page.getByRole("textbox",{name:"اسم التدفق"}))
  .toHaveValue("Safe isolated condition preview");
 await page.getByRole("button",{name:"تجربة"}).click();
 const sim=page.getByTestId("flow-simulator");
 await expect(sim).toContainText("مسار الترحيب");
 await sim.getByRole("textbox",{name:"رسالة البداية التجريبية"})
  .fill("أريد معرفة سعر الخدمة");
 await sim.getByRole("button",{name:"إعادة",exact:true}).click();
 await expect(sim).toContainText("مسار الأسعار");
 await expect(sim).not.toContainText("مسار الترحيب");
 await expect(sim).toContainText("لا يجري إرسال رسائل فعلية");
});
