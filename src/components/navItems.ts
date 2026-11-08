import { LayoutDashboard, MessageSquare, Workflow, Plug, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/* مصدر واحد لعناصر التنقل — يستعمله Sidebar (سطح المكتب) وBottomNav (الجوال). */
export type NavId = "home" | "inbox" | "flows" | "channels" | "settings";

export type NavItem = { id: NavId; label: string; href: string; icon: LucideIcon };

export const NAV_ITEMS: NavItem[] = [
  { id: "home", label: "الرئيسية", href: "#/dashboard", icon: LayoutDashboard },
  { id: "inbox", label: "المحادثات", href: "#/dashboard?tab=inbox", icon: MessageSquare },
  { id: "flows", label: "التدفقات", href: "#/flows", icon: Workflow },
  { id: "channels", label: "القنوات", href: "#/dashboard?tab=channels", icon: Plug },
  { id: "settings", label: "الإعدادات", href: "#/settings", icon: Settings },
];

/** استنتاج العنصر النشط من الهاش الحالي. */
export function activeNavId(hash: string): NavId | null {
  if (hash.startsWith("#/flows")) return "flows";
  if (hash.startsWith("#/settings") || hash.startsWith("#/profile") || hash.startsWith("#/widgets")) return "settings";
  if (hash.startsWith("#/dashboard")) {
    const tab = new URLSearchParams(hash.split("?")[1] ?? "").get("tab");
    if (tab === "inbox" || tab === "convs") return "inbox";
    if (tab === "channels") return "channels";
    return "home";
  }
  return null;
}
