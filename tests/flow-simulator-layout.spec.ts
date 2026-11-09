import { test, expect } from "@playwright/test";

test("simulator follows the connected edge for each quick reply, not static text",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await page.getByRole("button",{name:"تجربة"}).click();
  const sim=page.getByTestId("flow-simulator");
  await expect(sim.getByText("أهلاً بيك! اختار الخدمة التي تحتاجها.")).toBeVisible();
  await expect(sim.getByText("اختار دولتك")).toBeVisible();
  await sim.getByRole("button",{name:"عمان"}).click();
  await expect(sim.getByText("تواصل ويانا لمعرفة الأسعار الحالية لخدمتك في عمان.")).toBeVisible();
  await expect(sim.getByText("في العراق.")).toHaveCount(0);
  await expect(sim.getByText("في الإمارات.")).toHaveCount(0);
  await sim.getByRole("button",{name:"إعادة",exact:true}).click();
  await sim.getByRole("button",{name:"العراق"}).click();
  await expect(sim.getByText("تواصل ويانا لمعرفة الأسعار الحالية لخدمتك في العراق.")).toBeVisible();
});

async function positions(page:import("@playwright/test").Page){
  return page.locator(".react-flow__node").evaluateAll(els=>els.map(el=>{
    const r=el.getBoundingClientRect();return {x:r.left,y:r.top};
  }));
}

test("layout toggle switches between vertical and horizontal and is undoable",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  const tools=page.getByTestId("flow-workspace-tools");
  const horizontal=tools.getByRole("button",{name:"أفقي"});
  const vertical=tools.getByRole("button",{name:"عمودي"});
  await expect(vertical).toHaveAttribute("aria-pressed","true");

  await horizontal.click();
  await expect(horizontal).toHaveAttribute("aria-pressed","true");
  // Horizontal: ranks advance along x (trigger, message, question are in distinct columns on one row).
  await expect.poll(async()=>{
    const p=await positions(page);
    const xs=[p[0].x,p[1].x,p[2].x];
    return Math.abs(xs[0]-xs[1])>150&&Math.abs(xs[1]-xs[2])>150&&Math.abs(p[0].y-p[1].y)<80;
  }).toBe(true);

  await vertical.click();
  await expect.poll(async()=>{
    const p=await positions(page);
    return p[0].y<p[1].y&&p[1].y<p[2].y&&Math.abs(p[0].x-p[1].x)<80;
  }).toBe(true);

  // Undo restores the previous (horizontal) arrangement through store history.
  await page.getByTitle("تراجع Ctrl+Z").click();
  await expect.poll(async()=>{
    const p=await positions(page);
    return Math.abs(p[0].y-p[1].y)<80;
  }).toBe(true);
});

async function handleSides(page:import("@playwright/test").Page){
  return page.locator(".react-flow__node").first().evaluate(()=>{
    const out:Record<string,string[]>={};
    document.querySelectorAll(".react-flow__node").forEach(n=>{
      n.querySelectorAll(".react-flow__handle").forEach(h=>{
        const id=h.getAttribute("data-handleid")||"";
        const kind=h.classList.contains("source")?"source":"target";
        (out[kind]??=[]).push(h.getAttribute("data-handlepos")||"");
        void id;
      });
    });
    return out;
  });
}

test("handles follow layout direction and layout buttons are 44px tap targets",async({page})=>{
  await page.goto("/milanochat/#/flows");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  const tools=page.getByTestId("flow-workspace-tools");
  for(const name of ["عمودي","أفقي"]){
    const box=await tools.getByRole("button",{name}).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await expect.poll(async()=>{
    const s=await handleSides(page);
    return [...new Set(s.target)].join()+"|"+[...new Set(s.source)].join();
  }).toBe("top|bottom");

  await tools.getByRole("button",{name:"أفقي"}).click();
  await expect.poll(async()=>{
    const s=await handleSides(page);
    return [...new Set(s.target)].join()+"|"+[...new Set(s.source)].join();
  }).toBe("left|right");
  await page.screenshot({path:process.env.LAYOUT_SHOT||"test-results/horizontal.png"});

  await tools.getByRole("button",{name:"عمودي"}).click();
  await expect.poll(async()=>{
    const s=await handleSides(page);
    return [...new Set(s.target)].join()+"|"+[...new Set(s.source)].join();
  }).toBe("top|bottom");
});
