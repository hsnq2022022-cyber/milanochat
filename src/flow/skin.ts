// Presentation-only skin for the Flow Builder (Dark Premium).
// Nothing here is read by the flow engine, validation, runtime plans or storage.
import { createContext, useContext } from "react";
import {
  MessageSquare, Rocket, HelpCircle, GitBranch, Clock3, Zap,
  Shuffle, CornerDownRight, Globe, Flag,
} from "lucide-react";
import type { Kind } from "./model";
import type { FlowLanguage } from "./uiLocale";

/** Node-kind colours used only for cards, ports, edges, palette and minimap. */
export const SKIN_COLOR: Record<Kind,string> = {
  trigger:"#3DD189",   // green
  message:"#A78BFA",   // purple
  question:"#38BDF8",  // blue
  delay:"#FB923C",     // orange
  condition:"#E5B54B", // gold
  action:"#F472B6",    // pink
  randomizer:"#2DD4BF",// teal
  goto:"#94A3B8",      // slate
  end:"#8B9E96",       // grey
  request:"#818CF8",   // indigo (not in the mockup; kept distinct from question blue)
};

export const SKIN_ICON: Record<Kind,typeof Rocket> = {
  trigger:Rocket,message:MessageSquare,question:HelpCircle,condition:GitBranch,delay:Clock3,
  action:Zap,randomizer:Shuffle,goto:CornerDownRight,request:Globe,end:Flag,
};

const HINTS: Record<Kind,[string,string]> = {
  trigger:["يبدأ التدفق","Starts the flow"],
  message:["نص، صور وأزرار","Text, images, buttons"],
  question:["أزرار أو إدخال بيانات","Buttons or typed input"],
  condition:["مساران حسب القيمة","Branch on a value"],
  delay:["تأخير زمني","Time delay"],
  action:["وسم، متغير أو تحويل","Tag, field or handoff"],
  randomizer:["توزيع بالنسب","Weighted split"],
  goto:["قفز إلى خطوة","Jump to a step"],
  request:["HTTP (غير منفّذ)","HTTP (not executed)"],
  end:["إنهاء المسار","End this path"],
};
export function skinHint(kind:Kind,language:FlowLanguage):string{
  return HINTS[kind][language==="ar"?0:1];
}

/** Validation findings per node, derived from the existing validateDocument() result. */
export type NodeIssueSummary={errors:number;warnings:number;first:string};
export const FlowIssuesContext=createContext<ReadonlyMap<string,NodeIssueSummary>>(new Map());
export const useNodeIssues=(id:string):NodeIssueSummary|undefined=>useContext(FlowIssuesContext).get(id);
