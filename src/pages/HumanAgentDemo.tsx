import HumanAgentChat from "../components/HumanAgentChat";
import { DEMO_CONFIG } from "../lib/demoConfig";

/**
 * HumanAgentDemo - صفحة عرض تجربة Human Agent
 * 
 * هذه الصفحة مخصصة لعرض تجربة تحويل المحادثة من AI إلى موظف بشري
 * أمام Meta App Review.
 * 
 * ملاحظة: هذه محادثة تجريبية وليست متصلة بـ WhatsApp أو Meta فعلياً.
 */
export default function HumanAgentDemo() {
  return (
    <div className="min-h-screen bg-night">
      {/* ══════════════════════════════════════════════════════════════════════
          Header
      ══════════════════════════════════════════════════════════════════════ */}
      <header className="bg-pine/50 border-b border-verde/10 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <a href="#/" className="flex items-center gap-2 group">
                <div className="w-10 h-10 rounded-xl bg-verde flex items-center justify-center">
                  <span className="text-2xl">💬</span>
                </div>
                <span className="font-display font-bold text-xl text-bone">
                  ميلانو
                </span>
              </a>
              <div className="h-6 w-px bg-verde/20"></div>
              <span className="text-sage text-sm">Human Agent Demo</span>
            </div>
            <a
              href="#/"
              className="text-sage hover:text-bone transition-colors text-sm"
            >
              ← العودة للرئيسية
            </a>
          </div>
        </div>
      </header>

      {/* ══════════════════════════════════════════════════════════════════════
          Main Content
      ══════════════════════════════════════════════════════════════════════ */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* ══════════════════════════════════════════════════════════════════
            Info Banner
        ══════════════════════════════════════════════════════════════════ */}
        <div className="bg-oro/10 border border-oro/20 rounded-2xl p-6 mb-8">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-oro/20 flex items-center justify-center flex-shrink-0">
              <span className="text-2xl">ℹ️</span>
            </div>
            <div className="flex-1">
              <h2 className="font-display font-bold text-lg text-bone mb-2">
                Human Agent Demo - محادثة تجريبية
              </h2>
              <p className="text-sage text-sm leading-relaxed mb-3">
                هذه محادثة تجريبية لعرض تجربة تحويل المحادثة من الذكاء الاصطناعي إلى موظف بشري.
                هذه التجربة مخصصة للعرض التوضيحي وليست متصلة بـ WhatsApp أو Meta فعلياً.
              </p>
              <div className="flex flex-wrap gap-2">
                <span className="px-3 py-1 rounded-full bg-blue-500/20 text-blue-300 text-xs font-semibold">
                  Demo Conversation
                </span>
                <span className="px-3 py-1 rounded-full bg-green-500/20 text-green-300 text-xs font-semibold">
                  AI Agent
                </span>
                <span className="px-3 py-1 rounded-full bg-purple-500/20 text-purple-300 text-xs font-semibold">
                  Human Agent
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════════
            Chat Container
        ══════════════════════════════════════════════════════════════════ */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* ════════════════════════════════════════════════════════════════
              Left Sidebar - Info
          ════════════════════════════════════════════════════════════════ */}
          <div className="lg:col-span-1 space-y-6">
            {/* Scenario Info */}
            <div className="bg-pine/50 border border-verde/20 rounded-2xl p-6">
              <h3 className="font-display font-bold text-bone mb-4 flex items-center gap-2">
                <span className="text-xl">📋</span>
                <span>سيناريو العرض</span>
              </h3>
              <ol className="space-y-3 text-sm text-sage">
                <li className="flex items-start gap-2">
                  <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-300 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                    1
                  </span>
                  <span>العميل يبدأ محادثة مع AI Agent</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="w-6 h-6 rounded-full bg-green-500/20 text-green-300 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                    2
                  </span>
                  <span>AI Agent يرد على استفسارات العميل</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-300 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                    3
                  </span>
                  <span>العميل يطلب التحدث مع موظف بشري</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-300 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                    4
                  </span>
                  <span>النظام يحوّل المحادثة إلى Human Agent</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-300 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                    5
                  </span>
                  <span>الموظف البشري يواصل المحادثة</span>
                </li>
              </ol>
            </div>

            {/* Features */}
            <div className="bg-pine/50 border border-verde/20 rounded-2xl p-6">
              <h3 className="font-display font-bold text-bone mb-4 flex items-center gap-2">
                <span className="text-xl">✨</span>
                <span>الميزات المعروضة</span>
              </h3>
              <ul className="space-y-2 text-sm text-sage">
                <li className="flex items-center gap-2">
                  <span className="text-verde">✓</span>
                  <span>AI Agent ذكي</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-verde">✓</span>
                  <span>تحويل سلس إلى موظف بشري</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-verde">✓</span>
                  <span>حفظ سياق المحادثة</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-verde">✓</span>
                  <span>واجهة مستخدم احترافية</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-verde">✓</span>
                  <span>مؤشرات كتابة حية</span>
                </li>
              </ul>
            </div>

            {/* Instructions */}
            <div className="bg-pine/50 border border-verde/20 rounded-2xl p-6">
              <h3 className="font-display font-bold text-bone mb-4 flex items-center gap-2">
                <span className="text-xl">🎯</span>
                <span>كيفية التجربة</span>
              </h3>
              <div className="space-y-3 text-sm text-sage">
                <p>
                  <strong className="text-bone">1.</strong> راقب المحادثة الافتراضية بين العميل و AI Agent
                </p>
                <p>
                  <strong className="text-bone">2.</strong> عندما يطلب العميل التحدث مع موظف، اضغط على زر "تحويل إلى موظف بشري"
                </p>
                <p>
                  <strong className="text-bone">3.</strong> بعد التحويل، يمكنك كتابة ردود كموظف بشري
                </p>
              </div>
            </div>
          </div>

          {/* ════════════════════════════════════════════════════════════════
              Main Chat Area
          ════════════════════════════════════════════════════════════════ */}
          <div className="lg:col-span-2">
            <div className="h-[700px]">
              <HumanAgentChat />
            </div>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════════
            Footer Note
        ══════════════════════════════════════════════════════════════════ */}
        <div className="mt-8 text-center">
          <p className="text-sage text-sm">
            هذه نسخة تجريبية مخصصة للعرض التوضيحي. 
            للحصول على النسخة الكاملة مع التكامل الفعلي مع WhatsApp و Meta، 
            يرجى التواصل معنا.
          </p>
        </div>
      </main>
    </div>
  );
}
