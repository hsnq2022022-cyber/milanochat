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


test("Instagram trigger can be changed to WhatsApp without touching live channels",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await page.locator(".react-flow__node").first().click();
  await expect(page.getByRole("combobox",{name:"قناة بدء الأتمتة"})).toBeVisible();
  await page.getByRole("combobox",{name:"قناة بدء الأتمتة"}).selectOption("whatsapp");
  await expect(page.locator(".react-flow__node").first()).toContainText("WhatsApp");
  await expect(page.locator("aside select").nth(1).locator("option")).toHaveCount(2);
  await page.getByRole("combobox",{name:"قناة بدء الأتمتة"}).selectOption("messenger");
  await expect(page.locator(".react-flow__node").first()).toContainText("Messenger");
  await expect(page.getByText(/لا يُنشئ ربط حساب جديدًا/)).toBeVisible();
});

test("a quick reply can jump to a second locally saved flow and run its preview",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await page.getByRole("button",{name:"إنشاء تدفق جديد"}).click();
  await page.getByRole("textbox",{name:"اسم التدفق"}).fill("فرع الأسعار");
  const optionIds=await page.getByRole("combobox",{name:"اختيار التدفق"}).locator("option").evaluateAll(opts=>opts.map(x=>(x as HTMLOptionElement).value));
  expect(optionIds.length).toBe(2);
  await page.getByRole("combobox",{name:"اختيار التدفق"}).selectOption(optionIds[0]);
  await page.locator(".react-flow__node").nth(2).click();
  await expect(page.getByText("الأزرار والردود السريعة")).toBeVisible();
  await page.locator("aside [data-testid^='flow-button']").first().click();
  page.on("dialog",dialog=>{void dialog.accept();});
  await page.getByRole("button",{name:"الانتقال إلى تدفق آخر"}).click();
  await page.getByRole("combobox",{name:"اختر تدفقًا آخر"}).selectOption(optionIds[1]);
  await page.getByRole("button",{name:"تم",exact:true}).first().click();
  await page.getByRole("button",{name:"تجربة"}).click();
  await page.getByRole("button",{name:"العراق",exact:true}).click();
  await expect(page.getByText("انتقال إلى التدفق: فرع الأسعار")).toBeVisible();
  await expect(page.getByText("مرحباً! شلون نكدر نساعدك؟")).toBeVisible();
  await page.getByRole("button",{name:"إغلاق المعاينة"}).click();
  await page.waitForTimeout(950);
  await page.reload();
  await expect(page.getByRole("combobox",{name:"اختيار التدفق"}).locator("option")).toHaveCount(2);
});

test("rich message content adds PDF and data collection blocks that survive preview",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await page.locator(".react-flow__node").nth(1).click();
  await page.getByRole("button",{name:"إضافة محتوى"}).click();
  await page.getByTestId("content-block-menu").getByRole("button").filter({hasText:"PDF"}).click();
  await expect(page.getByTestId("content-block-pdf")).toBeVisible();
  await page.getByRole("textbox",{name:"رابط PDF"}).fill("https://example.com/sample.pdf");
  await page.getByRole("button",{name:"إضافة محتوى"}).click();
  await page.getByTestId("content-block-menu").getByRole("button").filter({hasText:"جمع بيانات"}).click();
  await page.getByRole("textbox",{name:"سؤال جمع البيانات"}).fill("شنو بريدك الإلكتروني؟");
  await page.getByRole("combobox",{name:"نوع البيانات"}).selectOption("email");
  await page.getByRole("button",{name:"تجربة"}).click();
  await expect(page.getByText("ملف PDF مرفق")).toBeVisible();
  await expect(page.getByText("شنو بريدك الإلكتروني؟")).toBeVisible();
  await page.getByRole("textbox",{name:"إجابة العميل"}).fill("customer@example.com");
  await page.getByRole("textbox",{name:"إجابة العميل"}).press("Enter");
  await expect(page.getByText("customer@example.com")).toBeVisible();
});

test("flow enable toggle is local-only and persists when switching documents",async({page})=>{
 await page.goto("/milanochat/#/flows");
 const toggle=page.getByTestId("flow-enabled-toggle");
 await expect(toggle).toHaveAttribute("aria-pressed","false");
 await toggle.click();
 await expect(toggle).toHaveAttribute("aria-pressed","true");
 await expect(page.getByText("تم تفعيل المسودة محليًا فقط.")).toBeVisible();
 await page.getByRole("button",{name:"إنشاء تدفق جديد"}).click();
 await expect(toggle).toHaveAttribute("aria-pressed","false");
 const select=page.getByRole("combobox",{name:"اختيار التدفق"});
 await select.selectOption("default");
 await expect(toggle).toHaveAttribute("aria-pressed","true");
 await page.waitForTimeout(900);
 await page.reload();
 await expect(toggle).toHaveAttribute("aria-pressed","true");
 await toggle.click();
 await expect(toggle).toHaveAttribute("aria-pressed","false");
});

test("start from scratch opens a separate flow with only a trigger, preserving the original flow",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await expect(page.locator(".react-flow__node")).toHaveCount(6);
 await page.getByRole("button",{name:"البدء من الصفر"}).click();
 await expect(page.locator(".react-flow__node")).toHaveCount(1);
 await expect(page.locator(".react-flow__edge")).toHaveCount(0);
 await expect(page.locator(".react-flow__node")).toContainText(["بداية الأتمتة"]);
 await page.getByRole("combobox",{name:"اختيار التدفق"}).selectOption("default");
 await expect(page.locator(".react-flow__node")).toHaveCount(6);
});

test("default pricing messages show three nonblocking warnings and can be enabled",async({page})=>{
  await page.goto("/milanochat/#/flows");
  const toggle=page.getByTestId("flow-enabled-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed","false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed","true");
  await page.getByTitle("فحص التدفق").click();
  const panel=page.getByText("فحص التدفق").last().locator("..");
  await expect(page.getByText(/⚠ تحذير: نهاية ضمنية/)).toHaveCount(3);
  await expect(page.getByText(/● خطأ:/)).toHaveCount(0);
});
test("an isolated node and a question option without a route block activation",async({page})=>{
  await page.goto("/milanochat/#/flows");
  const toggle=page.getByTestId("flow-enabled-toggle");
  await page.getByRole("button",{name:"فتح إضافة خطوة"}).click();
  await page.getByTestId("add-step-menu").getByRole("button",{name:"إرسال رسالة"}).click();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed","false");
  // Blocking errors open the findings panel automatically.
  await expect(page.getByText(/غير قابلة للوصول/).first()).toBeVisible();
  await expect(page.getByText(/● خطأ:/).first()).toBeVisible();
});

test("an unconnected quick reply blocks local activation and identifies its question node",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await page.locator(".react-flow__node").nth(2).click();
  await page.locator("aside [data-testid^='flow-button']").first().click();
  await page.getByRole("combobox",{name:"ربط الزر بخطوة"}).selectOption("");
  const toggle=page.getByTestId("flow-enabled-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed","false");
  await expect(page.getByText(/بلا وجهة/).first()).toBeVisible();
});

test("batch 2 undo restores local flow enabled toggle",async({page})=>{
 await page.goto("/milanochat/#/flows");
 const toggle=page.getByTestId("flow-enabled-toggle");
 await toggle.click();
 await expect(toggle).toHaveAttribute("aria-pressed","true");
 await page.getByTitle("تراجع Ctrl+Z").click();
 await expect(toggle).toHaveAttribute("aria-pressed","false");
 await page.getByTitle("إعادة Ctrl+Shift+Z").click();
 await expect(toggle).toHaveAttribute("aria-pressed","true");
});

test("batch 2 repeated node duplicates have separate positions and undo",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").nth(1).click();
 const duplicate=page.getByRole("button",{name:"نسخ",exact:true});
 await duplicate.click();
 await expect(page.locator(".react-flow__node")).toHaveCount(7);
 await duplicate.click();
 await expect(page.locator(".react-flow__node")).toHaveCount(8);
 const rects=await page.locator(".react-flow__node").evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
 expect(rects.length).toBe(8);
 for(const i of [6,7])for(let j=0;j<i;j++){
   const a=rects[i],b=rects[j];
   const intersect=a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
   expect(intersect,"Copied nodes must not intersect existing cards").toBe(false);
 }
 await page.getByTitle("تراجع Ctrl+Z").click();
 await expect(page.locator(".react-flow__node")).toHaveCount(7);
});

test("batch 2 arranging rich content and switching between flows preserves both graphs",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").nth(1).click();
 await page.getByRole("button",{name:"إضافة محتوى"}).click();
 await page.getByTestId("content-block-menu").getByRole("button").filter({hasText:"صورة"}).click();
 await page.getByRole("textbox",{name:"رابط صورة المكوّن"}).fill("https://example.com/demo.jpg");
 await page.getByTitle("ترتيب تلقائي").click();
 await expect(page.locator(".react-flow__node")).toHaveCount(6);
 await page.getByRole("button",{name:"إنشاء تدفق جديد"}).click();
 await expect(page.locator(".react-flow__node")).toHaveCount(2);
 await page.getByTitle("ترتيب تلقائي").click();
 await page.getByRole("combobox",{name:"اختيار التدفق"}).selectOption("default");
 await expect(page.locator(".react-flow__node")).toHaveCount(6);
 await page.locator(".react-flow__node").nth(1).click();
 await expect(page.getByTestId("content-block-image")).toHaveCount(1);
});

test("batch 2 insertion on edge is undoable and leaves all existing branches",async({page})=>{
 await page.goto("/milanochat/#/flows");
 const point=await page.locator(".react-flow__edge-interaction").first().evaluate(element=>{
  const path=element as SVGPathElement;
  const center=path.getPointAtLength(path.getTotalLength()/2);
  const screen=center.matrixTransform(path.getScreenCTM()!);
  return {x:screen.x,y:screen.y};
 });
 await page.mouse.click(point.x,point.y,{button:"right"});
 await page.getByRole("button",{name:"إدراج خطوة"}).last().click();
 await expect(page.locator(".react-flow__node")).toHaveCount(7);
 await expect(page.locator(".react-flow__edge")).toHaveCount(6);
 await page.getByTitle("تراجع Ctrl+Z").click();
 await expect(page.locator(".react-flow__node")).toHaveCount(6);
 await expect(page.locator(".react-flow__edge")).toHaveCount(5);
});


test("trigger settings show event-specific keyword chips instead of step title",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").first().click();
 const aside=page.locator("aside");
 await expect(aside.getByText("عنوان الخطوة")).toHaveCount(0);
 const event=aside.getByRole("combobox",{name:"نوع الحدث"});
 await event.selectOption("message");
 await expect(aside.getByTestId("trigger-keyword-settings")).toHaveCount(0);
 await event.selectOption("keyword");
 const editor=aside.getByTestId("trigger-keyword-settings");
 await expect(editor).toBeVisible();
 const input=editor.getByRole("textbox",{name:"إدخال كلمة مفتاحية"});
 await input.fill("عراق");
 await input.press("Enter");
 await expect(editor.getByTestId("saved-keywords")).toContainText("عراق");
 await input.fill("اسعار");
 await editor.getByRole("button",{name:"حفظ الكلمة المفتاحية"}).click();
 await expect(editor.getByTestId("saved-keywords")).toContainText("اسعار");
 await editor.getByRole("button",{name:"حذف الكلمة عراق"}).click();
 await expect(editor.getByTestId("saved-keywords")).not.toContainText("عراق");
 await event.selectOption("comment");
 await expect(editor.getByRole("checkbox",{name:"تحديد كلمات للتعليقات"})).toBeChecked();
 await event.selectOption("message");
 await expect(aside.getByTestId("trigger-keyword-settings")).toHaveCount(0);
});

test("comment keywords are optional and saved chips appear as selected criteria",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").first().click();
 const aside=page.locator("aside");
 await aside.getByRole("combobox",{name:"نوع الحدث"}).selectOption("comment");
 const editor=aside.getByTestId("trigger-keyword-settings");
 await editor.getByRole("checkbox",{name:"تحديد كلمات للتعليقات"}).check();
 const field=editor.getByRole("textbox",{name:"إدخال كلمة مفتاحية"});
 await field.fill("TOD");
 await field.press("Enter");
 await expect(editor.getByTestId("saved-keywords")).toContainText("TOD");
 await expect(page.locator(".react-flow__node").first()).toContainText("TOD");
 await editor.getByRole("checkbox",{name:"تحديد كلمات للتعليقات"}).uncheck();
 await expect(editor.getByText("سيُطبَّق الحدث على أي تعليق")).toBeVisible();
});

test("message content controls are available without expanding and legacy image stays visible",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").nth(1).click();
 const aside=page.locator("aside");
 await expect(aside.getByTestId("primary-message-content")).toBeVisible();
 await expect(aside.getByTestId("content-block-menu")).toBeVisible();
 await expect(aside.getByText("صورة الرسالة")).toHaveCount(0);
 await aside.getByRole("textbox",{name:"نص الرسالة"}).fill("رسالة جديدة");
 await aside.getByTestId("content-block-menu").getByRole("button").filter({hasText:"صورة"}).click();
 await expect(aside.getByTestId("content-block-image")).toBeVisible();
 await aside.getByRole("textbox",{name:"رابط صورة المكوّن"}).fill("https://example.com/photo.jpg");
 await expect(page.locator(".react-flow__node").nth(1)).toContainText("رسالة جديدة");
});

test("batch 3 hides a second trigger and preserves the current starting node",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.getByRole("button",{name:"فتح إضافة خطوة"}).click();
 const menu=page.getByTestId("add-step-menu");
 await expect(menu).toBeVisible();
 await expect(menu.getByRole("button",{name:"بداية الأتمتة"})).toHaveCount(0);
 await expect(menu.getByRole("button",{name:"إرسال رسالة"})).toBeVisible();
});

test("batch 3 mobile step action stays visible and preview counts execution steps",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto("/milanochat/#/flows");
 const add=page.locator(".react-flow__node").first().locator("button[aria-label^='إضافة خطوة بعد']");
 await expect(add).toBeVisible();
 const size=await add.boundingBox();
 expect(size).not.toBeNull();
 expect(size!.width).toBeGreaterThanOrEqual(44);
 expect(size!.height).toBeGreaterThanOrEqual(44);
 await page.getByRole("button",{name:"تجربة"}).click();
 await expect(page.getByTestId("simulator-step-counter")).toContainText("الخطوات:");
 await page.getByRole("button",{name:"إعادة",exact:true}).click();
 await expect(page.getByTestId("simulator-step-counter")).toContainText("/ 150");
});

test("audit: toolbar and step settings collapse and expand without erasing text",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.getByRole("button",{name:"طي شريط أدوات التدفقات"}).click();
 await expect(page.getByTestId("flow-toolbar-secondary")).toHaveCount(0);
 await page.getByRole("button",{name:"إظهار شريط أدوات التدفقات"}).click();
 await expect(page.getByTestId("flow-toolbar-secondary")).toBeVisible();
 await page.locator(".react-flow__node").nth(1).click();
 const panel=page.locator("aside");
 const field=panel.getByRole("textbox",{name:"نص الرسالة"});
 await field.fill("اختبار الطي والحفظ");
 await panel.getByRole("button",{name:"طي إعدادات الخطوة"}).click();
 await expect(field).toHaveCount(0);
 await panel.getByRole("button",{name:"إظهار إعدادات الخطوة"}).click();
 await expect(field).toHaveValue("اختبار الطي والحفظ");
});

test("audit: typed question modes expose two working routes and remove stale button edges",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").nth(2).click();
 const panel=page.locator("aside");
 const mode=panel.getByRole("combobox",{name:"نوع الإجابة"});
 for(const value of ["text","email","phone","number"]){
  await mode.selectOption(value);
  const routes=panel.getByTestId("question-text-routes");
  await expect(routes.getByRole("combobox",{name:"وجهة الإجابة الصحيحة"})).toBeVisible();
  await expect(routes.getByRole("combobox",{name:"وجهة الإجابة غير الصحيحة"})).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
 }
 await panel.getByRole("combobox",{name:"وجهة الإجابة الصحيحة"}).selectOption({index:2});
 await panel.getByRole("combobox",{name:"وجهة الإجابة غير الصحيحة"}).selectOption({index:3});
 await expect(page.locator(".react-flow__edge")).toHaveCount(4);
 await mode.selectOption("buttons");
 await expect(page.locator(".react-flow__edge")).toHaveCount(2);
 await expect(panel.getByTestId("question-text-routes")).toHaveCount(0);
});

test("audit: invalid email follows invalid route; valid email follows valid route",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").nth(2).click();
 const panel=page.locator("aside");
 await panel.getByRole("combobox",{name:"نوع الإجابة"}).selectOption("email");
 await panel.getByRole("combobox",{name:"وجهة الإجابة الصحيحة"}).selectOption({index:2});
 await panel.getByRole("combobox",{name:"وجهة الإجابة غير الصحيحة"}).selectOption({index:3});
 await page.getByRole("button",{name:"تجربة"}).click();
 const answer=page.getByRole("textbox",{name:"إجابة العميل"});
 await answer.fill("wrong-email");
 await answer.press("Enter");
 await expect(page.getByTestId("flow-simulator").getByText("تواصل ويانا لمعرفة الأسعار الحالية لخدمتك في عمان.")).toBeVisible();
 await page.getByRole("button",{name:"إعادة",exact:true}).click();
 await answer.fill("client@example.com");
 await answer.press("Enter");
 await expect(page.getByTestId("flow-simulator").getByText("تواصل ويانا لمعرفة الأسعار الحالية لخدمتك في العراق.")).toBeVisible();
});

for(const sample of [
 {mode:"phone",bad:"123",good:"٠٧٧٠١٢٣٤٥٦٧"},
 {mode:"number",bad:"not-a-number",good:"۱۲۳"},
 {mode:"text",bad:"",good:"مرحبا"}
]){
 test("audit: customer input "+sample.mode+" correctly routes to valid/invalid messages",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await page.locator(".react-flow__node").nth(2).click();
  const panel=page.locator("aside");
  await panel.getByRole("combobox",{name:"نوع الإجابة"}).selectOption(sample.mode);
  await panel.getByRole("combobox",{name:"وجهة الإجابة الصحيحة"}).selectOption({index:2});
  await panel.getByRole("combobox",{name:"وجهة الإجابة غير الصحيحة"}).selectOption({index:3});
  await page.getByRole("button",{name:"تجربة"}).click();
  const modal=page.getByTestId("flow-simulator");
  const answer=modal.getByRole("textbox",{name:"إجابة العميل"});
  if(sample.bad){
   await answer.fill(sample.bad);
   await answer.press("Enter");
   await expect(modal.getByText("تواصل ويانا لمعرفة الأسعار الحالية لخدمتك في عمان.")).toBeVisible();
   await modal.getByRole("button",{name:"إعادة",exact:true}).click();
  }
  await answer.fill(sample.good);
  await answer.press("Enter");
  await expect(modal.getByText("تواصل ويانا لمعرفة الأسعار الحالية لخدمتك في العراق.")).toBeVisible();
 });
}

for(const kind of [
 {label:"شرط",heading:"الحقل"},
 {label:"انتظار ذكي",heading:"مدة الانتظار"},
 {label:"إجراء",heading:"نوع الإجراء"},
 {label:"توزيع عشوائي",heading:"نسب التوزيع"},
 {label:"الانتقال لخطوة",heading:"الانتقال إلى خطوة"},
 {label:"طلب خارجي",heading:"طريقة طلب HTTP"},
 {label:"نهاية",heading:"تنهي المسار"}
]){
 test("audit: "+kind.label+" opens real editable settings",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await page.getByRole("button",{name:"فتح إضافة خطوة"}).click();
  await page.getByTestId("add-step-menu").getByRole("button",{name:kind.label,exact:true}).click();
  const panel=page.getByTestId("step-settings-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText(new RegExp(kind.heading)).first()).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
 });
}
test("audit: randomizer equal distribution performs an actual value update",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.getByRole("button",{name:"فتح إضافة خطوة"}).click();
 await page.getByTestId("add-step-menu").getByRole("button",{name:"توزيع عشوائي",exact:true}).click();
 const panel=page.getByTestId("step-settings-panel");
 await panel.getByRole("spinbutton",{name:"النسبة 1"}).fill("80");
 await panel.getByRole("button",{name:"توزيع متساوٍ"}).click();
 await expect(panel.getByRole("spinbutton",{name:"النسبة 1"})).toHaveValue("50");
 await expect(panel.getByRole("spinbutton",{name:"النسبة 2"})).toHaveValue("50");
});

test("audit: website button opens its HTTPS link in local preview",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").nth(1).click();
 const panel=page.getByTestId("step-settings-panel");
 await panel.getByRole("button",{name:"إضافة زر"}).click();
 const editor=panel.getByTestId("button-action-editor");
 await editor.getByRole("textbox",{name:"عنوان الزر"}).fill("موقع المتجر");
 await editor.getByRole("button",{name:"فتح موقع"}).click();
 await editor.getByRole("textbox",{name:"رابط الموقع"}).fill("https://example.com/shop");
 await page.getByRole("button",{name:"تجربة"}).click();
 const sim=page.getByTestId("flow-simulator");
 await sim.getByRole("button",{name:"موقع المتجر"}).click();
 await expect(sim.getByRole("link",{name:"فتح الرابط"})).toHaveAttribute("href","https://example.com/shop");
});

test("audit: quick reply connects to a real step and preview follows the connection",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").nth(1).click();
 const panel=page.getByTestId("step-settings-panel");
 await panel.getByRole("button",{name:"إضافة رد سريع"}).click();
 const editor=panel.getByTestId("button-action-editor");
 await editor.getByRole("textbox",{name:"عنوان الزر"}).fill("أسعار الإمارات");
 await editor.getByRole("combobox",{name:"ربط الزر بخطوة"}).selectOption({index:4});
 await page.getByRole("button",{name:"تجربة"}).click();
 const sim=page.getByTestId("flow-simulator");
 await sim.getByRole("button",{name:"أسعار الإمارات"}).click();
 await expect(sim.getByText("تواصل ويانا لمعرفة الأسعار الحالية لخدمتك في الإمارات.")).toBeVisible();
});

test("audit: AI Step and action buttons create editable nodes rather than inert buttons",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").nth(1).click();
 const panel=page.getByTestId("step-settings-panel");
 await panel.getByRole("button",{name:"إضافة زر"}).click();
 await panel.getByTestId("button-action-editor").getByRole("button",{name:"AI Step",exact:true}).click();
 await expect(page.locator(".react-flow__node")).toHaveCount(7);
 await expect(panel.getByText("نوع الإجراء")).toBeVisible();
 await expect(panel.getByText("هذه إعدادات تصميمية، وليست أوامر مفعّلة في النظام الحقيقي.")).toBeVisible();
});

test("batch 5 typed email and phone use input previews, never quick-reply buttons",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").nth(2).click();
 const editor=page.getByTestId("step-settings-panel");
 const mode=editor.getByRole("combobox",{name:"نوع الإجابة"});
 for(const value of ["email","phone","number","text"]){
   await mode.selectOption(value);
   const question=page.locator(".react-flow__node").nth(2);
   await expect(question.getByTestId("typed-question-preview")).toBeVisible();
   await expect(question.getByTestId("typed-question-routes")).toContainText("إجابة صحيحة");
   await expect(question.getByTestId("typed-question-routes")).toContainText("إجابة غير صحيحة");
   await expect(question.locator(".react-flow__handle.source")).toHaveCount(2);
   await expect(question.getByText("العراق", {exact:true})).toHaveCount(0);
 }
 await mode.selectOption("buttons");
 const question=page.locator(".react-flow__node").nth(2);
 await expect(question.getByTestId("typed-question-preview")).toHaveCount(0);
 await expect(question.getByTestId("typed-question-routes")).toHaveCount(0);
 await expect(question.getByText("العراق",{exact:true})).toBeVisible();
});
test("batch 5 deleting selected edge then undo redo restores the exact count",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await expect(page.locator(".react-flow__edge")).toHaveCount(5);
 await page.locator(".react-flow__edge").first().click();
 await page.keyboard.press("Delete");
 await expect(page.locator(".react-flow__edge")).toHaveCount(4);
 await page.getByTitle("تراجع Ctrl+Z").click();
 await expect(page.locator(".react-flow__edge")).toHaveCount(5);
 await page.getByTitle("إعادة Ctrl+Shift+Z").click();
 await expect(page.locator(".react-flow__edge")).toHaveCount(4);
});
test("batch 5 deleting selected node removes attached edges and undo restores them",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await expect(page.locator(".react-flow__edge")).toHaveCount(5);
 await page.locator(".react-flow__node").nth(2).click();
 await page.keyboard.press("Delete");
 await expect(page.locator(".react-flow__node")).toHaveCount(5);
 await expect(page.locator(".react-flow__edge")).toHaveCount(1);
 await page.getByTitle("تراجع Ctrl+Z").click();
 await expect(page.locator(".react-flow__node")).toHaveCount(6);
 await expect(page.locator(".react-flow__edge")).toHaveCount(5);
});

test("batch 5 context-menu removes exact edge and undo restores it",async({page})=>{
 await page.goto("/milanochat/#/flows");
 const path=page.locator(".react-flow__edge-interaction").first();
 const point=await path.evaluate(element=>{
   const p=element as SVGPathElement;
   const center=p.getPointAtLength(p.getTotalLength()/2);
   const screen=center.matrixTransform(p.getScreenCTM()!);
   return {x:screen.x,y:screen.y};
 });
 await page.mouse.click(point.x,point.y,{button:"right"});
 await page.getByRole("button",{name:"حذف الاتصال"}).last().click();
 await expect(page.locator(".react-flow__edge")).toHaveCount(4);
 await page.getByTitle("تراجع Ctrl+Z").click();
 await expect(page.locator(".react-flow__edge")).toHaveCount(5);
});

test("batch 5 delete-and-reconnect bridges one input and output atomically",async({page})=>{
 await page.goto("/milanochat/#/flows");
 await page.locator(".react-flow__node").nth(1).click();
 const panel=page.getByTestId("step-settings-panel");
 await panel.getByRole("button",{name:"حذف مع إعادة التوصيل"}).click();
 await expect(page.locator(".react-flow__node")).toHaveCount(5);
 await expect(page.locator(".react-flow__edge")).toHaveCount(4);
 await page.getByTitle("تراجع Ctrl+Z").click();
 await expect(page.locator(".react-flow__node")).toHaveCount(6);
 await expect(page.locator(".react-flow__edge")).toHaveCount(5);
});
