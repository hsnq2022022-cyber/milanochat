import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CommentActivityItem } from "../lib/api";

/** تبويب «التعليقات» داخل الوارد: يُجلب عند الفتح وبالتحديث اليدوي فقط (بلا polling). */

const PAGE = 20;

const card = "bg-pine/50 border border-verde/12 rounded-xl";

type Tone = "green" | "blue" | "red" | "gold" | "muted";
const TONE: Record<Tone, string> = {
  green: "text-verde bg-verde/10 border-verde/30",
  blue: "text-sky-300 bg-sky-400/10 border-sky-400/30",
  red: "text-red-300 bg-red-500/10 border-red-400/30",
  gold: "text-oro bg-oro/10 border-oro/30",
  muted: "text-sage bg-sage/10 border-sage/25",
};

function badges(it: CommentActivityItem): Array<{ key: string; tone: Tone; label: string }> {
  const out: Array<{ key: string; tone: Tone; label: string }> = [];
  if (it.publicReplyStatus === "sent") out.push({ key: "pub", tone: "green", label: "تم الرد العام ✅" });
  else if (it.publicReplyStatus === "failed") out.push({ key: "pub", tone: "red", label: "فشل الرد العام" });
  else out.push({ key: "pub", tone: "gold", label: "قيد الإرسال" });
  if (it.dmStatus === "sent") out.push({ key: "dm", tone: "blue", label: "تم إرسال الخاص ✅" });
  else if (it.dmStatus === "failed") out.push({ key: "dm", tone: "red", label: "فشل الإرسال" });
  else if (it.dmStatus === "skipped") out.push({ key: "dm", tone: "muted", label: "لم يُرسل الخاص" });
  else if (it.publicReplyStatus !== "pending") out.push({ key: "dm", tone: "gold", label: "قيد الإرسال" });
  return out;
}

function Row({ it, formatTime }: { it: CommentActivityItem; formatTime: (iso: string) => string }) {
  const [open, setOpen] = useState(false);
  const panelId = `comment-detail-${it.id}`;
  return (
    <li className={card} data-testid="comment-item">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="w-full min-h-[44px] text-start p-4 rounded-xl focus:outline-none focus:ring-2 focus:ring-verde hover:bg-night/40 transition-colors duration-200 ease-out"
      >
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-[13px] font-bold text-bone truncate notranslate">{it.customerName || "—"}</span>
          <span className="text-[10px] text-sage tabular-nums shrink-0">{formatTime(it.createdAt)}</span>
        </div>
        <p className={`text-[12.5px] text-sage leading-6 break-words notranslate ${open ? "hidden" : "line-clamp-2"}`}>{it.commentText}</p>
        <div className="flex gap-1.5 flex-wrap mt-2">
          {badges(it).map((b) => (
            <span key={b.key} className={`text-[10.5px] font-bold border rounded-full px-2 py-0.5 ${TONE[b.tone]}`}>{b.label}</span>
          ))}
        </div>
      </button>
      {open && (
        <div id={panelId} className="px-4 pb-4 space-y-3 border-t border-verde/10 pt-3" data-testid="comment-detail">
          <div>
            <p className="text-[11px] font-bold text-sage mb-1">التعليق</p>
            <p className="text-[13px] text-bone leading-6 break-words whitespace-pre-wrap notranslate">{it.commentText}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold text-sage mb-1">الرد العام</p>
            {it.publicReplyText ? (
              <p className="text-[13px] text-bone leading-6 break-words whitespace-pre-wrap bg-night/60 border border-verde/15 rounded-lg p-3 notranslate" data-testid="comment-reply-text">{it.publicReplyText}</p>
            ) : (
              <p className="text-[12px] text-sage/80">لا يوجد نص رد.</p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export default function CommentActivity({ tenantId, token, demo, formatTime }: {
  tenantId: string;
  token: string | null;
  demo: boolean;
  formatTime: (iso: string) => string;
}) {
  const [items, setItems] = useState<CommentActivityItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState(false);
  const seq = useRef(0);

  const message = (code: string) =>
    code === "unavailable" ? "ميزة الردود على التعليقات غير مفعّلة بعد لحسابك." : "تعذر تحميل التعليقات";

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true); setError(null); setMoreError(false);
    try {
      const r = await api.getCommentActivity(tenantId, token, PAGE);
      if (my !== seq.current) return;
      setItems(r.items ?? []); setCursor(r.nextCursor ?? null);
    } catch (e) {
      if (my !== seq.current) return;
      setItems([]); setCursor(null); setError(e instanceof Error ? e.message : "error");
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [tenantId, token]);

  useEffect(() => {
    if (demo) { setLoading(false); return; }
    load();
    return () => { seq.current++; };
  }, [demo, load]);

  const loadMore = async () => {
    if (!cursor || more) return;
    const my = seq.current;
    setMore(true); setMoreError(false);
    try {
      const r = await api.getCommentActivity(tenantId, token, PAGE, cursor);
      if (my !== seq.current) return;
      setItems((cur) => [...cur, ...(r.items ?? []).filter((n) => !cur.some((c) => c.id === n.id))]);
      setCursor(r.nextCursor ?? null);
    } catch {
      if (my === seq.current) setMoreError(true);
    } finally {
      setMore(false);
    }
  };

  return (
    <section className="max-w-2xl pb-[calc(6rem+env(safe-area-inset-bottom))]" data-testid="comment-activity">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-lg font-display font-bold text-bone">نشاط التعليقات</h2>
        <button
          type="button"
          onClick={load}
          disabled={loading || demo}
          className="min-h-[44px] px-4 rounded-xl border border-verde/25 text-mist text-sm font-semibold hover:border-oro/60 hover:text-oro transition-colors duration-200 ease-out focus:outline-none focus:ring-2 focus:ring-verde disabled:opacity-50 disabled:cursor-not-allowed"
        >
          تحديث
        </button>
      </div>

      {loading ? (
        <ul className="space-y-2" aria-busy="true" data-testid="comments-skeleton">
          {Array.from({ length: 4 }).map((_, i) => (
            <li key={i} className={`${card} p-4 animate-pulse space-y-2`}>
              <div className="h-3 bg-sage/10 rounded w-1/3" />
              <div className="h-3 bg-sage/10 rounded w-full" />
              <div className="h-3 bg-sage/5 rounded w-2/3" />
            </li>
          ))}
        </ul>
      ) : error ? (
        <div className={`${card} p-4 text-center`} role="alert" data-testid="comments-error">
          <p className="text-sm text-red-300 leading-6 break-words">{message(error)}</p>
          {error !== "unavailable" && (
            <button type="button" onClick={load} className="mt-3 min-h-[44px] px-5 rounded-xl bg-verde text-ink font-bold text-sm focus:outline-none focus:ring-2 focus:ring-oro">
              إعادة المحاولة
            </button>
          )}
        </div>
      ) : items.length === 0 ? (
        <div className={`${card} px-5 py-10 text-center`} data-testid="comments-empty">
          <p className="text-sm text-sage">لا توجد تعليقات بعد</p>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {items.map((it) => <Row key={it.id} it={it} formatTime={formatTime} />)}
          </ul>
          {moreError && <p className="text-xs text-red-300 text-center mt-3" role="alert">تعذر تحميل المزيد</p>}
          {cursor && (
            <button
              type="button"
              onClick={loadMore}
              disabled={more}
              className="mt-3 w-full min-h-[44px] rounded-xl border border-verde/25 text-mist text-sm font-semibold hover:border-oro/60 hover:text-oro transition-colors duration-200 ease-out focus:outline-none focus:ring-2 focus:ring-verde disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {more ? "جارٍ التحميل…" : "تحميل المزيد"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
