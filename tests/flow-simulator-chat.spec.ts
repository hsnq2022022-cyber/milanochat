import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { makeNode, edgeFor } from "../src/flow/model";
import type { FlowDocument, FlowNode } from "../src/flow/model";

const node=(kind:FlowNode["data"]["kind"],title:string,x:number,data:Partial<FlowNode["data"]>={})=>
  makeNode(kind,{x,y:120+Math.abs(x)/2},{title,...data});
const link=(source:FlowNode,port:string,target:FlowNode)=>
  edgeFor({source:source.id,sourceHandle:port,target:target.id,targetHandle:"in"});
const start=()=>node("trigger","بداية",0,{triggerMode:"message"});
const ending=()=>node("end","نهاية",2400);
const COMPLETED="✅ اكتملت المحاكاة";
const DEAD_END="انتهى المسار هنا بدون خطوة تالية";

/** Shortens the simulated typing/delay time (same override the component reads). */
async function fastTyping(page:Page,ms=60){
  await page.addInitScript(value=>{(window as unknown as Record<string,number>).__FLOW_SIM_TYPING_MS__=value;},ms);
}
async function load(page:Page,doc:FlowDocument){
  page.on("dialog",dialog=>dialog.accept());
  await page.goto("/milanochat/#/flows");
  await page.locator('input[accept=".json,application/json"]').setInputFiles({
    name:"chat-sim.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(doc),"utf8")
  });
  await expect(page.getByRole("textbox",{name:"اسم التدفق"})).toHaveValue(doc.name);
}
async function open(page:Page){
  await page.getByRole("button",{name:"تجربة"}).click();
  return page.getByTestId("flow-simulator");
}
const shot=(name:string)=>(process.env.SIM_SHOTS||"test-results")+"/"+name+".png";

test("completion text appears ONLY at an End node, never on a dead end or mid-flow input",async({page})=>{
  await fastTyping(page);
  await page.goto("/milanochat/#/flows");
  const sim=await open(page);
  await expect(sim.getByRole("button",{name:"عمان"})).toBeVisible();
  // Arbitrary text while buttons are shown must not end anything.
  const answer=sim.getByRole("textbox",{name:"إجابة العميل"});
  await answer.fill("أي كلام");
  await answer.press("Enter");
  await expect(sim.getByText("من فضلك اختر أحد الخيارات")).toBeVisible();
  await expect(sim.getByText(/اكتملت المحاكاة/)).toHaveCount(0);
  await sim.getByRole("button",{name:"عمان"}).click();
  await expect(sim.getByText("تواصل ويانا لمعرفة الأسعار الحالية لخدمتك في عمان.")).toBeVisible();
  // The example flow has no End node: this is a dead end, not a completion.
  await expect(sim.getByText(DEAD_END)).toBeVisible();
  await expect(sim.getByText(/اكتملت المحاكاة/)).toHaveCount(0);
  await expect(sim.getByRole("button",{name:"إعادة المحاكاة"})).toBeVisible();
  await expect(answer).toBeDisabled();
});

test("typing indicator shows for the default 1500ms before every bot message, and blocks the composer",async({page})=>{
  await page.addInitScript(()=>{
    const log:string[]=[];(window as unknown as {__simLog:string[]}).__simLog=log;
    new MutationObserver(records=>{for(const r of records)r.addedNodes.forEach(n=>{
      if(!(n instanceof HTMLElement))return;
      if(n.matches('[data-testid="flow-sim-typing"]')||n.querySelector('[data-testid="flow-sim-typing"]'))log.push("typing");
      n.querySelectorAll?.('[data-sim-side="bot"]').forEach(()=>log.push("bot"));
      if(n.matches('[data-sim-side="bot"]'))log.push("bot");
    });}).observe(document,{childList:true,subtree:true});
  });
  await page.goto("/milanochat/#/flows");
  const sim=await open(page);
  const typing=sim.getByTestId("flow-sim-typing");
  await expect(typing).toBeVisible();
  await expect(sim.getByRole("textbox",{name:"إجابة العميل"})).toBeDisabled();
  await expect(sim.getByRole("button",{name:"إرسال الإجابة"})).toBeDisabled();
  await page.waitForTimeout(1000);
  await expect(sim.getByText("أهلاً بيك! اختار الخدمة التي تحتاجها.")).toHaveCount(0);
  await expect(sim.getByText("أهلاً بيك! اختار الخدمة التي تحتاجها.")).toBeVisible();
  await expect(sim.getByText("اختار دولتك")).toBeVisible({timeout:4000});
  await expect(typing).toHaveCount(0);
  await expect(sim.getByRole("textbox",{name:"إجابة العميل"})).toBeEnabled();
  await sim.getByRole("button",{name:"العراق"}).click();
  await expect(typing).toBeVisible();
  await page.screenshot({path:shot("sim-typing")});
  await expect(sim.getByText("تواصل ويانا لمعرفة الأسعار الحالية لخدمتك في العراق.")).toBeVisible();
  const log=await page.evaluate(()=>(window as unknown as {__simLog:string[]}).__simLog);
  const bots=log.map((x,i)=>[x,i] as const).filter(([x])=>x==="bot");
  expect(bots.length).toBe(3);
  for(const [,i] of bots)expect(log[i-1]).toBe("typing");
});

test("buttons route by option id to the right branch even when edge labels disagree",async({page})=>{
  await fastTyping(page);
  const a=start(),q=node("question","اختيار",300,{text:"اختر المعدن",options:[{id:"opt-gold",label:"ذهب"},{id:"opt-silver",label:"فضة"}]});
  const gold=node("message","ذهب",600,{text:"فرع الذهب"}),silver=node("message","فضة",900,{text:"فرع الفضة"}),end=ending();
  const g=link(q,"opt-gold",gold),s=link(q,"opt-silver",silver);
  g.data={label:"فضة"};s.data={label:"ذهب"};
  await load(page,{version:3,name:"توجيه الأزرار",nodes:[a,q,gold,silver,end],
    edges:[link(a,"next",q),g,s,link(gold,"next",end),link(silver,"next",end)]});
  const sim=await open(page);
  await sim.getByRole("button",{name:"فضة"}).click();
  await expect(sim.getByText("فرع الفضة")).toBeVisible();
  await expect(sim.getByText("فرع الذهب")).toHaveCount(0);
  await expect(sim.getByText(COMPLETED)).toBeVisible();
  // Answered buttons disappear so the conversation cannot be replayed out of order.
  await expect(sim.getByRole("button",{name:"ذهب"})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:shot("sim-completed-390")});
});

test("typed question validates, stores the variable and interpolates it in the next message",async({page})=>{
  await fastTyping(page);
  const a=start(),q=node("question","المدينة",300,{text:"من أي مدينة؟",inputMode:"text",inputField:"city"});
  const m=node("message","ترحيب",600,{text:"أهلاً {{first_name}} من {{city}}{{missing}}!"});
  const e=node("question","البريد",900,{text:"بريدك؟",inputMode:"email",inputField:"email"});
  const done=node("message","تأكيد",1200,{text:"سنراسلك على {{email}}"}),end=ending();
  await load(page,{version:3,name:"جمع البيانات",nodes:[a,q,m,e,done,end],
    edges:[link(a,"next",q),link(q,"valid",m),link(m,"next",e),link(e,"valid",done),link(done,"next",end)]});
  const sim=await open(page);
  const answer=sim.getByRole("textbox",{name:"إجابة العميل"});
  await answer.fill("بغداد");
  await sim.getByRole("button",{name:"إرسال الإجابة"}).click();
  await expect(sim.getByText("أهلاً عميلنا العزيز من بغداد!")).toBeVisible();
  await expect(sim.getByText(/\{\{/)).toHaveCount(0);
  await answer.fill("ليس-بريدًا");
  await answer.press("Enter");
  await expect(sim.getByRole("alert")).toContainText("البريد الإلكتروني غير صحيح");
  await expect(sim.getByText(COMPLETED)).toHaveCount(0);
  await answer.fill("client@example.com");
  await answer.press("Enter");
  await expect(sim.getByText("سنراسلك على client@example.com")).toBeVisible();
  await expect(sim.getByText(COMPLETED)).toBeVisible();
});

test("condition follows yes and no branches from the collected answer",async({page})=>{
  await fastTyping(page);
  const a=start(),q=node("question","سؤال",300,{text:"هل تريد العرض؟",inputMode:"text",inputField:"wants"});
  const c=node("condition","شرط",600,{conditionField:"wants",operator:"equals",conditionValue:"نعم"});
  const yes=node("message","نعم",900,{text:"مسار نعم"}),no=node("message","لا",1200,{text:"مسار لا"}),end=ending();
  await load(page,{version:3,name:"فحص الشرط",nodes:[a,q,c,yes,no,end],
    edges:[link(a,"next",q),link(q,"valid",c),link(c,"yes",yes),link(c,"no",no),link(yes,"next",end),link(no,"next",end)]});
  const sim=await open(page);
  const answer=sim.getByRole("textbox",{name:"إجابة العميل"});
  await answer.fill("نعم");await answer.press("Enter");
  await expect(sim.getByText("مسار نعم")).toBeVisible();
  await expect(sim.getByText("مسار لا")).toHaveCount(0);
  await sim.getByRole("button",{name:"إعادة المحاكاة"}).click();
  await answer.fill("لاحقًا");await answer.press("Enter");
  await expect(sim.getByText("مسار لا")).toBeVisible();
  await expect(sim.getByText("مسار نعم")).toHaveCount(0);
});

test("delay shows the real unit note, then continues; restart clears the conversation",async({page})=>{
  await fastTyping(page);
  const a=start(),d=node("delay","انتظار",300,{delayValue:3,delayUnit:"hours"});
  const m=node("message","بعد الانتظار",600,{text:"وصلت بعد الانتظار"}),end=ending();
  await load(page,{version:3,name:"فحص الانتظار",nodes:[a,d,m,end],edges:[link(a,"next",d),link(d,"next",m),link(m,"next",end)]});
  const sim=await open(page);
  await expect(sim.getByText("⏳ ينتظر 3 ساعات…")).toBeVisible();
  await expect(sim.getByText("وصلت بعد الانتظار")).toBeVisible();
  await expect(sim.getByText(COMPLETED)).toBeVisible();
  await sim.getByRole("button",{name:"إعادة المحاكاة"}).click();
  await expect(sim.getByText(COMPLETED)).toHaveCount(0);
  await expect(sim.getByText("وصلت بعد الانتظار")).toHaveCount(1);
  await expect(sim.getByText(COMPLETED)).toHaveCount(1);
});

test("a step without an outgoing edge shows the dead-end note and offers restart",async({page})=>{
  await fastTyping(page);
  const a=start(),act=node("action","وسم",300,{actionType:"tag",actionValue:"vip"});
  await load(page,{version:3,name:"مسار مقطوع",nodes:[a,act],edges:[link(a,"next",act)]});
  const sim=await open(page);
  await expect(sim.getByText("تم تنفيذ إجراء: إضافة وسم «vip»")).toBeVisible();
  await expect(sim.getByText(DEAD_END)).toBeVisible();
  await expect(sim.getByText(/اكتملت المحاكاة/)).toHaveCount(0);
  await expect(sim.getByRole("button",{name:"إعادة المحاكاة"})).toBeVisible();
});

test("RTL chat places user bubbles on the right and bot bubbles (with avatar) on the left at 390px",async({page})=>{
  await fastTyping(page);
  await page.setViewportSize({width:390,height:844});
  await page.goto("/milanochat/#/flows");
  const sim=await open(page);
  await expect(sim).toHaveAttribute("dir","rtl");
  await expect(sim.getByRole("button",{name:"العراق"})).toBeVisible();
  await page.screenshot({path:shot("sim-buttons-390")});
  await sim.getByRole("button",{name:"العراق"}).click();
  await expect(sim.getByText("تواصل ويانا لمعرفة الأسعار الحالية لخدمتك في العراق.")).toBeVisible();
  const panel=await sim.getByTestId("flow-sim-messages").boundingBox();
  const user=await sim.locator('[data-sim-side="user"]').last().boundingBox();
  const bot=await sim.locator('[data-sim-side="bot"]').last().boundingBox();
  const avatar=await sim.getByTestId("flow-sim-bot-avatar").last().boundingBox();
  const mid=panel!.x+panel!.width/2;
  expect(user!.x+user!.width).toBeGreaterThan(mid);
  expect(user!.x).toBeGreaterThan(bot!.x);
  expect(panel!.x+panel!.width-(user!.x+user!.width)).toBeLessThan(40);
  expect(bot!.x-panel!.x).toBeLessThan(80);
  expect(avatar!.x).toBeLessThan(bot!.x);
  // No horizontal scroll and 44px targets in the composer at 390px.
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  for(const name of ["إرسال الإجابة","إغلاق المعاينة","إعادة المحاكاة"]){
    const box=await sim.getByRole("button",{name,exact:true}).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
});

test("dialog is modal: focus stays inside on Tab and Escape closes it",async({page})=>{
  await fastTyping(page);
  await page.goto("/milanochat/#/flows");
  const sim=await open(page);
  const dialog=page.getByRole("dialog");
  await expect(dialog).toHaveAttribute("aria-modal","true");
  await expect(sim.getByRole("button",{name:"العراق"})).toBeVisible();
  for(let i=0;i<14;i++){
    await page.keyboard.press(i%3===0?"Shift+Tab":"Tab");
    expect(await page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(sim).toHaveCount(0);
});
