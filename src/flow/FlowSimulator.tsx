import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Bot, ExternalLink, FileText, RotateCcw, Send, X } from "lucide-react";
import type { FlowDocument } from "./model";
import { PLATFORM_LABELS } from "./model";
import { MAX_SIMULATOR_STEPS } from "./simulation";
import { interpolate, respond, startSimulation } from "./simulatorEngine";
import type { SimContext, SimCursor, SimEvent, SimInput, SimResult } from "./simulatorEngine";
import type { SavedFlow } from "./library";
import { flowText } from "./uiLocale";
import type { FlowLanguage } from "./uiLocale";
import { uuid } from "../lib/uuid.ts";

/** Default "bot is typing" time before every bot message; simulated delays are capped to it too. */
export const SIMULATOR_TYPING_MS = 1500;
/** Prop first, then a test-only global override, then the default. */
function resolveTypingMs(prop?: number): number {
  if (typeof prop === "number" && Number.isFinite(prop) && prop >= 0) return prop;
  const override = (globalThis as { __FLOW_SIM_TYPING_MS__?: unknown }).__FLOW_SIM_TYPING_MS__;
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) return override;
  return SIMULATOR_TYPING_MS;
}

type Bubble = { id: string; side: "bot" | "user" | "system"; text: string; image?: string; file?: string;
  link?: string; tone?: "info" | "success" | "warn"; retry?: boolean };
const toBubble = (e: SimEvent): Bubble => e.type === "delay"
  ? { id: uuid(), side: "system", text: e.text }
  : { id: uuid(), side: e.type, text: e.text,
      ...(e.type === "bot" ? { image: e.image, file: e.file, retry: e.retry } : {}),
      ...(e.type === "system" ? { tone: e.tone, link: e.link } : {}) };
const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
const ring = "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3DD189]";

function BotAvatar() {
  return <span data-testid="flow-sim-bot-avatar" aria-hidden="true"
    className="flex size-8 shrink-0 items-center justify-center self-end rounded-full border border-[#173D30] bg-[#0F2E24] text-[#3DD189]">
    <Bot size={16} />
  </span>;
}

export default function FlowSimulator({
  doc, flowId, flows, onClose, onVisited, language = "ar", typingDelayMs
}: {
  doc: FlowDocument; flowId: string; flows: SavedFlow[]; onClose: () => void; onVisited?: (ids: string[]) => void;
  language?: FlowLanguage; typingDelayMs?: number
}) {
  const t = (key: Parameters<typeof flowText>[0]) => flowText(key, language);
  const dir = language === "ar" ? "rtl" : "ltr";
  const typingMs = resolveTypingMs(typingDelayMs);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [typing, setTyping] = useState<number | null>(null); // id per bot message: one indicator each
  const [playing, setPlaying] = useState(true);
  const [cursor, setCursor] = useState<SimCursor | null>(null);
  const [input, setInput] = useState(""), [note, setNote] = useState("");
  const [triggerMessage, setTriggerMessage] = useState("اشتراكات");

  // Latest props/values for async playback without restarting on every render.
  const ctx: SimContext = { doc, flowId, flows };
  const live = useRef({ ctx, typingMs, onVisited, triggerMessage, language });
  live.current = { ctx, typingMs, onVisited, triggerMessage, language };
  const typingSeq = useRef(0), token = useRef(0), timers = useRef(new Set<number>()), cursorRef = useRef<SimCursor | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null), logRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLInputElement>(null);

  const cancel = useCallback(() => {
    token.current++;
    timers.current.forEach(id => window.clearTimeout(id));
    timers.current.clear();
  }, []);
  const sleep = useCallback((ms: number, run: number) => new Promise<boolean>(resolve => {
    const id = window.setTimeout(() => { timers.current.delete(id); resolve(run === token.current); }, ms);
    timers.current.add(id);
  }), []);

  const play = useCallback(async (result: SimResult, run: number) => {
    setPlaying(true);
    const delay = live.current.typingMs;
    for (const event of result.events) {
      if (run !== token.current) return;
      if (event.type === "bot") {
        typingSeq.current++;
        setTyping(typingSeq.current);
        if (!await sleep(delay, run)) return;
        setTyping(null);
        setBubbles(list => [...list, toBubble(event)]);
      } else if (event.type === "delay") {
        setBubbles(list => [...list, toBubble(event)]);
        if (!await sleep(Math.min(event.ms, delay), run)) return;
      } else setBubbles(list => [...list, toBubble(event)]);
    }
    if (run !== token.current) return;
    setTyping(null);
    cursorRef.current = result.cursor;
    setCursor(result.cursor);
    setPlaying(false);
    live.current.onVisited?.(result.cursor.visited);
  }, [sleep]);

  const restart = useCallback(() => {
    cancel();
    const run = token.current;
    const { ctx: current, triggerMessage: opening } = live.current;
    const platform = current.doc.nodes.find(n => n.data.kind === "trigger")?.data.platform || "instagram";
    setInput(""); setNote(""); setTyping(null); setCursor(null); cursorRef.current = null;
    setBubbles([{ id: uuid(), side: "system", text: "معاينة " + PLATFORM_LABELS[platform] + " — لا يجري إرسال رسائل فعلية" }]);
    void play(startSimulation(current, opening), run);
  }, [cancel, play]);

  useEffect(() => { restart(); return cancel; }, [restart, cancel]);

  const send = (value: SimInput) => {
    const current = cursorRef.current;
    if (playing || !current || current.status !== "waiting") return;
    const result = respond(live.current.ctx, current, value);
    if (!result.events.length) return;
    setNote("");
    void play(result, token.current);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (playing || cursor?.status !== "waiting") return;
    const answer = input.trim();
    if (!answer) { setNote(t("emptyAnswer")); return; }
    setInput("");
    send({ type: "text", text: answer });
  };

  // Dialog: remember the opener, keep focus inside, Escape closes, shortcuts don't reach the canvas.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, []);
  const onDialogKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.ctrlKey || e.metaKey) e.stopPropagation();
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  const waiting = !playing && cursor?.status === "waiting" ? cursor.wait : undefined;
  const finished = !playing && !!cursor && cursor.status !== "waiting";
  // Keep keyboard focus useful: return it to the composer when a typed answer is expected.
  useEffect(() => { if (waiting?.type === "input") inputRef.current?.focus(); }, [waiting]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbles, typing, waiting, finished]);

  const lastRetryId = useMemo(() => [...bubbles].reverse().find(b => b.retry)?.id, [bubbles]);
  const flowName = (cursor && cursor.flowId !== flowId ? flows.find(f => f.id === cursor.flowId)?.doc.name : undefined) || doc.name;
  const inputMode = waiting?.type === "input" ? waiting.inputMode : "text";
  const canType = !!waiting;

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-0 sm:p-3" onClick={onClose}>
    <div ref={dialogRef} data-testid="flow-simulator" role="dialog" aria-modal="true" aria-labelledby="flow-sim-title"
      tabIndex={-1} dir={dir} onKeyDown={onDialogKey} onClick={e => e.stopPropagation()}
      className="flex h-[100dvh] w-full max-w-md flex-col overflow-hidden border-[#173D30] bg-[#061A14] text-white shadow-2xl outline-none sm:h-[min(780px,95dvh)] sm:rounded-3xl sm:border">
      <header className="flex items-center gap-3 border-b border-[#173D30] bg-[#0B241C] px-3 py-2">
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#0F2E24] text-[#3DD189] ring-1 ring-[#173D30]">
          <Bot size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="flow-sim-title" className="truncate text-base font-bold">{t("testFlow")}{flowName}</h2>
          <p className="truncate text-xs text-[#8B9E96]">{typing !== null ? t("typing") : t("noMeta")}</p>
        </div>
        <button type="button" aria-label={t("closePreview")} onClick={onClose}
          className={"flex size-11 shrink-0 items-center justify-center rounded-full text-[#8B9E96] transition-colors duration-200 ease-out hover:bg-[#0F2E24] hover:text-white " + ring}>
          <X size={20} />
        </button>
      </header>

      <div className="flex items-end gap-2 border-b border-[#173D30] bg-[#0B241C] px-3 pb-2" data-testid="flow-simulator-inbound-message">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[#8B9E96]">
          <span>{t("startMessage")}</span>
          <input aria-label={t("startMessage")} maxLength={500} value={triggerMessage} onChange={e => setTriggerMessage(e.target.value)}
            className={"h-11 min-w-0 rounded-xl border border-[#173D30] bg-[#0F2E24] px-3 text-sm text-white " + ring} />
        </label>
        <button type="button" onClick={restart}
          className={"flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[#173D30] bg-[#0F2E24] px-3 text-sm text-white transition-colors duration-200 ease-out hover:bg-[#173D30] " + ring}>
          <RotateCcw size={15} aria-hidden="true" />{t("reset")}
        </button>
      </div>
      <p data-testid="simulator-step-counter" className="bg-[#0B241C] px-3 pb-1 text-[11px] text-[#8B9E96]">
        {t("steps")}{cursor?.stepCount ?? 0} / {MAX_SIMULATOR_STEPS}
      </p>

      <div ref={logRef} data-testid="flow-sim-messages" role="log" aria-live="polite" aria-label={t("testFlow") + flowName}
        className="flex flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden bg-[#061A14] p-3">
        {bubbles.map(b => {
          if (b.side === "system") return <div key={b.id} className="flex justify-center">
            <p data-sim-side="system" className={"max-w-[85%] whitespace-pre-wrap break-words rounded-full border px-3 py-1 text-center text-xs " +
              (b.tone === "success" ? "border-[#3DD189]/40 bg-[#0B241C] font-bold text-[#3DD189]"
                : b.tone === "warn" ? "border-[#E5B54B]/40 bg-[#0B241C] text-[#E5B54B]" : "border-[#173D30] bg-[#0F2E24] text-[#8B9E96]")}>
              {b.text}
              {b.link && <a href={b.link} target="_blank" rel="noopener noreferrer"
                className={"ms-2 inline-flex items-center gap-1 text-[#3DD189] underline " + ring}>
                <ExternalLink size={12} aria-hidden="true" />{t("openLink")}
              </a>}
            </p>
          </div>;
          if (b.side === "user") return <div key={b.id} dir="ltr" className="flex justify-end ps-12">
            <p data-sim-side="user" dir={dir}
              className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[#3DD189] px-3 py-2 text-sm text-[#061A14]">{b.text}</p>
          </div>;
          return <div key={b.id} dir="ltr" className="flex items-end justify-start gap-2 pe-10">
            <BotAvatar />
            <div data-sim-side="bot" dir={dir} role={b.id === lastRetryId ? "alert" : undefined}
              className={"max-w-[80%] overflow-hidden rounded-2xl rounded-bl-md border bg-[#0B241C] text-sm " +
                (b.retry ? "border-[#E5B54B]/50 " : "border-[#173D30] ") + (b.image && !b.text ? "p-1" : "px-3 py-2")}>
              {b.image && <img src={b.image} alt="صورة الرسالة" loading="lazy"
                className={"max-h-56 w-full rounded-xl object-cover" + (b.text ? " mb-2" : "")} />}
              {b.text && <p className="whitespace-pre-wrap break-words">{b.text}</p>}
              {b.file && <a href={b.file} target="_blank" rel="noopener noreferrer" download={b.file.startsWith("data:") ? "attachment.pdf" : undefined}
                className={"mt-2 flex min-h-11 items-center gap-2 rounded-xl border border-[#173D30] bg-[#0F2E24] px-3 text-[#3DD189] " + ring}>
                <FileText size={16} aria-hidden="true" /><span className="truncate">{t("pdfFile")}</span>
              </a>}
            </div>
          </div>;
        })}

        {waiting?.type === "choice" && <div dir="ltr" className="flex justify-start ps-10 pe-10" data-testid="flow-sim-options">
          <div dir={dir} className="flex w-full max-w-[80%] flex-col gap-1.5">
            {waiting.options.map(option => <button type="button" key={option.id} onClick={() => send({ type: "choice", optionId: option.id })}
              className={"flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[#173D30] bg-[#0B241C] px-4 text-sm font-bold text-[#3DD189] transition-colors duration-200 ease-out hover:bg-[#0F2E24] " + ring}>
              {option.action === "website" && <ExternalLink size={14} aria-hidden="true" />}
              {interpolate(option.label, cursor?.variables || {})}
            </button>)}
          </div>
        </div>}

        {typing !== null && <div key={"typing-" + typing} dir="ltr" className="flex items-end justify-start gap-2" data-testid="flow-sim-typing" role="status" aria-label={t("typing")}>
          <BotAvatar />
          <div className="flex h-9 items-center gap-1 rounded-2xl rounded-bl-md border border-[#173D30] bg-[#0B241C] px-3">
            {[0, 1, 2].map(i => <span key={i} aria-hidden="true" style={{ animationDelay: i * 160 + "ms" }}
              className="size-2 rounded-full bg-[#8B9E96] motion-safe:animate-bounce" />)}
          </div>
        </div>}

        {finished && <div className="flex justify-center pt-1">
          <button type="button" onClick={restart}
            className={"flex min-h-11 items-center gap-2 rounded-xl bg-[#3DD189] px-4 text-sm font-bold text-[#061A14] transition-colors duration-200 ease-out hover:bg-[#3DD189]/90 " + ring}>
            <RotateCcw size={16} aria-hidden="true" />{t("restartSim")}
          </button>
        </div>}
      </div>

      <form onSubmit={submit} className="border-t border-[#173D30] bg-[#0B241C] px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        {!!note && <p role="alert" className="pb-1 text-xs text-[#E5B54B]">{note}</p>}
        <div className="flex items-center gap-2">
          <label htmlFor="flow-sim-composer" className="sr-only">{t("customerAnswer")}</label>
          <input id="flow-sim-composer" ref={inputRef} aria-label={t("customerAnswer")} disabled={!canType} value={input}
            maxLength={1000} autoComplete="off" onChange={e => { setInput(e.target.value); if (note) setNote(""); }}
            type="text"
            inputMode={inputMode === "email" ? "email" : inputMode === "phone" ? "tel" : inputMode === "number" ? "decimal" : "text"}
            placeholder={playing ? t("waitBot") : finished ? t("simOver") : t("typeMessage")}
            className={"h-11 min-w-0 flex-1 rounded-full border border-[#173D30] bg-[#0F2E24] px-4 text-sm text-white placeholder:text-[#8B9E96] disabled:cursor-not-allowed disabled:opacity-50 " + ring} />
          <button type="submit" aria-label={t("submit")} disabled={!canType}
            className={"flex size-11 shrink-0 items-center justify-center rounded-full bg-[#3DD189] text-[#061A14] transition-colors duration-200 ease-out hover:bg-[#3DD189]/90 disabled:cursor-not-allowed disabled:opacity-50 " + ring}>
            <Send size={18} aria-hidden="true" className="rtl:-scale-x-100" />
          </button>
        </div>
      </form>
    </div>
  </div>;
}
