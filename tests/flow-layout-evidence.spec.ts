import {test,expect} from "@playwright/test";
import {edgeFor,exampleFlow,makeNode} from "../src/flow/model.ts";
import {FLOW_LIBRARY_KEY} from "../src/flow/library.ts";

function flow20(){
  const graph=exampleFlow();
  const first=graph.nodes[0];
  const nodes=[first];
  const edges=[];
  for(let i=0;i<19;i++){
    const node=makeNode("message",{x:380,y:250+i*240},{
      title:"Imported step "+(i+1),text:"هذه رسالة رقم "+(i+1)
    });
    if(i===0)edges.push(edgeFor({source:first.id,sourceHandle:"next",target:node.id,targetHandle:"in"}));
    else edges.push(edgeFor({source:nodes[i].id,sourceHandle:"next",target:node.id,targetHandle:"in"}));
    nodes.push(node);
  }
  return {...graph,name:"20-node imported flow",nodes,edges};
}
function intersect(a:{x:number;y:number;width:number;height:number},b:{x:number;y:number;width:number;height:number}){
  return Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)>1 &&
    Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>1;
}

for(const viewport of [{width:1366,height:768},{width:390,height:844}]){
  for(const variety of ["sample","20-node"] as const){
    test("flow-layout "+variety+" "+viewport.width+"x"+viewport.height,async({page},info)=>{
      await page.setViewportSize(viewport);
      if(variety==="20-node"){
        const stored=JSON.stringify({activeFlowId:"layout-evidence",flows:[{
          id:"layout-evidence",doc:flow20(),enabled:false
        }]});
        await page.addInitScript(({key,value})=>localStorage.setItem(key,value),
          {key:FLOW_LIBRARY_KEY,value:stored});
      }
      await page.goto("/milanochat/#/flows");
      const nodes=page.locator(".react-flow__node");
      await expect(nodes).toHaveCount(variety==="20-node"?20:6);
      await page.waitForTimeout(650); // let delayed fitView settle
      const rectangles=await nodes.evaluateAll(els=>els.map(el=>{
        const r=el.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height};
      }));
      for(let i=0;i<rectangles.length;i++)for(let j=i+1;j<rectangles.length;j++)
        expect(intersect(rectangles[i],rectangles[j]),"Nodes "+i+" and "+j+" overlap").toBe(false);

      const minimap=page.locator(".react-flow__minimap");
      if(await minimap.isVisible()){
        const a=await minimap.boundingBox(),b=await page.locator(".react-flow__controls").boundingBox();
        if(a&&b)expect(intersect(a,b),"Minimap obscures React Flow controls").toBe(false);
      }
      await page.screenshot({path:info.outputPath("layout-"+variety+"-"+viewport.width+"x"+viewport.height+".png"),fullPage:true});
    });
  }
}
