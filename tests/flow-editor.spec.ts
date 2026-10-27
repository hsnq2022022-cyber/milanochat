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
 await expect(page.locator(".react-flow__node")).toContainText(["بداية المحادثة"]);
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
