import { Component, type ErrorInfo, type ReactNode } from "react";

/* Shows the exact crash message on screen (red) instead of a blank page. Diagnostic aid for the flow builder. */
const box: React.CSSProperties = {
  direction: "ltr", textAlign: "left", background: "#061A14", color: "#FF6B6B", minHeight: "100vh",
  padding: "20px", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: "14px",
  whiteSpace: "pre-wrap", wordBreak: "break-word", overflow: "auto",
};

export default class FlowErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("[FlowBuilder crash]", error, info.componentStack); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" data-testid="flow-crash" style={box}>
        <div style={{ fontWeight: 700, fontSize: "16px", marginBottom: "8px" }}>Flow Builder crashed</div>
        {String(error?.message || error)}
        {error?.stack ? "\n\n" + error.stack.split("\n").slice(0, 8).join("\n") : ""}
      </div>
    );
  }
}

/* Errors outside React rendering (event handlers, async code, chunk loading) never reach an error boundary:
   show them in a red banner too, only on the flow builder route. */
/* Dev-server / socket noise (Vite HMR, closed WebSockets, ResizeObserver loop) is not an app error: never show it. */
export function isBenignRuntimeNoise(value: unknown): boolean {
  if (value == null) return false;
  if (typeof Event !== "undefined" && value instanceof Event) return true; // CloseEvent/Event carries no message
  const text = String((value as { message?: unknown })?.message ?? value);
  if (!text || text === "[object Object]") return typeof value === "object" && !(value instanceof Error) && !(value as { message?: unknown }).message;
  return /websocket|web socket|\bhmr\b|\[vite\]|ResizeObserver loop/i.test(text);
}

export function installFlowErrorBanner() {
  const show = (msg: string) => {
    if (!location.hash.startsWith("#/flows")) return;
    let el = document.getElementById("flow-error-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "flow-error-banner";
      Object.assign(el.style, { position: "fixed", left: "0", right: "0", top: "0", zIndex: "99999", background: "#2a0b0b", color: "#FF6B6B",
        padding: "10px 12px", font: "13px ui-monospace, Menlo, Consolas, monospace", direction: "ltr", textAlign: "left", whiteSpace: "pre-wrap", wordBreak: "break-word" });
      document.body.appendChild(el);
    }
    el.textContent = msg.slice(0, 600);
  };
  window.addEventListener("error", (e) => { if (isBenignRuntimeNoise(e.error ?? e.message) || isBenignRuntimeNoise(e.message)) return; show("Error: " + (e.message || "unknown") + (e.filename ? "\n" + e.filename + ":" + e.lineno : "")); });
  window.addEventListener("unhandledrejection", (e) => { if (isBenignRuntimeNoise(e.reason)) return; show("Unhandled rejection: " + String((e.reason && (e.reason.message || e.reason)) || "unknown")); });
}
