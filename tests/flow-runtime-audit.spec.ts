import { test, expect } from "@playwright/test";
import { makeNode, edgeFor } from "../src/flow/model";
import type { FlowDocument, FlowNode } from "../src/flow/model";

const node=(kind:FlowNode["data"]["kind"],title:string,x:number,data:Partial<FlowNode["data"]>={})=>
  makeNode(kind,{x,y:120+Math.abs(x)/2},{title,...data});
const link=(source:FlowNode,port:string,target:FlowNode)=>
  edgeFor({source:source.id,sourceHandle:port,target:target.id,targetHandle:"in"});
async function load(page:import("@playwright/test").Page,doc:FlowDocument){
  page.on("dialog",dialog=>dialog.accept());
  await page.goto("/milanochat/#/flows");
  await page.locator('input[accept=".json,application/json"]').setInputFiles({
    name:"functional-audit.json",mimeType:"application/json",
    buffer:Buffer.from(JSON.stringify(doc),"utf8")
  });
  await expect(page.getByRole("textbox",{name:"اسم التدفق"})).toHaveValue(doc.name);
}
const start=()=>node("trigger","بداية",0,{triggerMode:"message"});
const ending=()=>node("end","نهاية",2000);

test("functional: condition executes yes branch after set_field, delay and 100% randomizer",async({page})=>{
  const a=start(),action=node("action","تعريف متغير",300,{actionType:"set_field",actionValue:"tier=premium"});
  const c=node("condition","التحقق من الباقة",600,{conditionField:"tier",operator:"equals",conditionValue:"premium"});
  const delay=node("delay","انتظار",900,{delayValue:4,delayUnit:"minutes"});
  const rand=node("randomizer","توزيع",1200,{options:[{id:"a",label:"مسار مضمون",weight:100},{id:"b",label:"صفر",weight:0}]});
  const ok=node("message","ناجح",1500,{text:"وصلت للفرع الصحيح"});
  const never=node("message","خطأ",1600,{text:"لا يفترض الوصول لهذا الفرع"});
  const end=ending();
  const doc:FlowDocument={version:3,name:"فحص تنفيذ الشرط والإجراء والتوزيع",nodes:[a,action,c,delay,rand,ok,never,end],
    edges:[link(a,"next",action),link(action,"next",c),link(c,"yes",delay),link(c,"no",never),
      link(delay,"next",rand),link(rand,"a",ok),link(rand,"b",never),link(ok,"next",end)]};
  await load(page,doc);
  await page.getByRole("button",{name:"تجربة"}).click();
  const sim=page.getByTestId("flow-simulator");
  await expect(sim).toContainText("وصلت للفرع الصحيح");
  await expect(sim).not.toContainText("لا يفترض الوصول لهذا الفرع");
  await expect(sim).toContainText("تم تخطي انتظار");
  await expect(sim).toContainText("انتهى التدفق");
});

test("functional: goto follows its actual target and end terminates",async({page})=>{
 const a=start(),g=node("goto","انتقال",300),m=node("message","المقصود",600,{text:"خطوة الانتقال وصلت بالفعل"}),end=ending();
 g.data.gotoNode=m.id;
 const doc:FlowDocument={version:3,name:"فحص الانتقال",nodes:[a,g,m,end],
   edges:[link(a,"next",g),link(m,"next",end)]};
 await load(page,doc);
 await page.getByRole("button",{name:"تجربة"}).click();
 const sim=page.getByTestId("flow-simulator");
 await expect(sim).toContainText("خطوة الانتقال وصلت بالفعل");
 await expect(sim).toContainText("انتهى التدفق");
});

test("functional: HTTP is explicitly NOT executed, and preview picks error path",async({page})=>{
 const a=start(),http=node("request","استدعاء تجريبي",300,{requestMethod:"GET",requestUrl:"https://example.org/api"});
 const ok=node("message","نجاح HTTP",600,{text:"نجح طلب HTTP الحقيقي"}),error=node("message","فشل HTTP",900,{text:"تم اختيار مسار الخطأ التجريبي"});
 const doc:FlowDocument={version:3,name:"HTTP لا ينفذ",nodes:[a,http,ok,error],
   edges:[link(a,"next",http),link(http,"success",ok),link(http,"error",error)]};
 await load(page,doc);
 await page.getByRole("button",{name:"تجربة"}).click();
 const sim=page.getByTestId("flow-simulator");
 await expect(sim).toContainText("لم يُنفذ HTTP من المتصفح");
 await expect(sim).toContainText("تم اختيار مسار الخطأ التجريبي");
 await expect(sim).not.toContainText("نجح طلب HTTP الحقيقي");
});

for(const choice of [
 {action:"AI Step",kind:"action",label:"نوع الإجراء"},
 {action:"تنفيذ إجراء",kind:"action",label:"نوع الإجراء"},
 {action:"شرط",kind:"condition",label:"الحقل"},
 {action:"توزيع عشوائي",kind:"randomizer",label:"نسب التوزيع"}
]){
 test("functional: action button "+choice.action+" creates an actual editable connected step",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await page.locator(".react-flow__node").nth(1).click();
  const panel=page.getByTestId("step-settings-panel");
  await panel.getByRole("button",{name:"إضافة زر"}).click();
  await panel.getByTestId("button-action-editor").getByRole("button",{name:choice.action,exact:true}).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  await expect(page.locator(".react-flow__edge")).toHaveCount(6);
  await expect(panel.getByText(choice.label).first()).toBeVisible();
 });
}

test("functional: add and remove a quick reply changes actual graph edges",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").nth(1).click();
 const panel=page.getByTestId("step-settings-panel");
 await panel.getByRole("button",{name:"إضافة رد سريع"}).click();
 const editor=panel.getByTestId("button-action-editor");
 await editor.getByRole("textbox",{name:"عنوان الزر"}).fill("اسأل عن عمان");
 await editor.getByRole("combobox",{name:"ربط الزر بخطوة"}).selectOption({index:3});
 await expect(page.locator(".react-flow__edge")).toHaveCount(6);
 await editor.getByRole("button",{name:"حذف الزر"}).click();
 await expect(page.locator(".react-flow__edge")).toHaveCount(5);
 await page.getByTitle("تراجع Ctrl+Z").click();
 await expect(page.locator(".react-flow__edge")).toHaveCount(6);
});
