import { Component, type ErrorInfo, type ReactNode } from "react";

/* حدّ أخطاء للصفحات المحمّلة كسولًا: فشل تحميل الوحدة بعد نشر جديد أو أي خطأ عرض لا يترك شاشة فارغة.
   التفاصيل التقنية تظهر في وضع التطوير فقط. */
type Props = { children: ReactNode };
type State = { error: Error | null };

export default class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("[route crash]", error, info.componentStack); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" data-testid="route-error" dir="rtl" className="flex min-h-screen items-center justify-center bg-[#061A14] px-4 py-8 font-body text-bone">
        <div className="w-full max-w-sm rounded-2xl border border-[#173D30] bg-[#0B241C] p-6 text-center">
          <h1 className="mb-2 font-display text-lg font-bold">حدث خطأ غير متوقع أثناء تحميل الصفحة</h1>
          <p className="mb-6 text-sm font-normal text-[#8B9E96]">قد يكون السبب تحديثًا جديدًا للموقع أو انقطاعًا في الاتصال. أعد تحميل الصفحة وجرّب مرة أخرى.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mb-3 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-[#3DD189] px-4 py-2 font-bold text-[#061A14] transition-colors duration-200 hover:bg-[#E5B54B] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#E5B54B] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B241C]"
          >
            إعادة التحميل
          </button>
          <a
            href="#/"
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl text-sm text-[#8B9E96] underline underline-offset-4 transition-colors duration-200 hover:text-bone focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3DD189]"
          >
            العودة إلى الصفحة الرئيسية
          </a>
          {import.meta.env.DEV && (
            <p dir="ltr" data-testid="route-error-detail" className="mt-4 break-words text-start text-[11px] text-[#8B9E96]">{String(error?.message || error).slice(0, 200)}</p>
          )}
        </div>
      </div>
    );
  }
}
