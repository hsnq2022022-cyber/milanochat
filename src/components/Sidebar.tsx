import { useState } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { NAV_ITEMS, type NavId } from "./navItems";

const KEY = "milano.sidebar.collapsed";

function readCollapsed(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

/* شريط جانبي لسطح المكتب فقط (md+): يلتصق باليمين في RTL، قابل للطي ويحفظ الحالة. */
export default function Sidebar({ active }: { active: NavId | null }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => {
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* التخزين غير متاح */ }
      return next;
    });
  };
  const ToggleIcon = collapsed ? PanelRightOpen : PanelRightClose;
  return (
    <aside
      data-testid="sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      className={`hidden md:flex shrink-0 sticky top-0 h-[100dvh] flex-col gap-2 bg-[#0B241C] border-s border-[#173D30] p-3 transition-[width] duration-200 ease-out ${collapsed ? "w-[72px]" : "w-60"}`}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls="sidebar-nav"
        aria-label={collapsed ? "توسيع الشريط الجانبي" : "طي الشريط الجانبي"}
        data-testid="sidebar-toggle"
        className="flex items-center justify-center w-11 h-11 shrink-0 rounded-xl text-[#8B9E96] hover:text-white hover:bg-[#0F2E24] transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3DD189]"
      >
        <ToggleIcon className="w-5 h-5" aria-hidden="true" />
      </button>
      <nav id="sidebar-nav" aria-label="التنقل الرئيسي" className="flex flex-col gap-1">
        {NAV_ITEMS.map((i) => {
          const current = i.id === active;
          const Icon = i.icon;
          return (
            <a
              key={i.id}
              href={i.href}
              data-testid={`sidebar-${i.id}`}
              aria-current={current ? "page" : undefined}
              title={collapsed ? i.label : undefined}
              className={`flex items-center gap-3 min-h-[44px] rounded-xl px-3 text-sm transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3DD189] ${collapsed ? "justify-center px-0" : ""} ${current ? "bg-[#0F2E24] text-[#E5B54B] font-bold" : "text-[#8B9E96] font-normal hover:text-white hover:bg-[#0F2E24]"}`}
            >
              <Icon className="w-5 h-5 shrink-0" aria-hidden="true" />
              <span className={collapsed ? "sr-only" : "truncate"}>{i.label}</span>
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
