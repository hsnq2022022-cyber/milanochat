// Pure classification of a flow trigger's `messageScope` (no I/O, no env).
// Allowed literals come from the S1 model so the two cannot drift.
import {isMessageScope} from "../../../src/flow/model.ts";

export type MessageScopeClass = "every_message" | "conversation_start" | "invalid";

// `triggerData` is a trigger node's `data` object.
// - Non-plain-object input (null, undefined, primitives, arrays) -> "invalid".
//   Fail-safe: a missing/malformed data object is not a legacy trigger we can
//   trust, so it must never silently become "every_message".
// - Own property `messageScope` absent or `undefined` -> "every_message"
//   (legacy, backward compatible). Inherited values are ignored.
// - Present: exact "every_message" / "conversation_start" only (no trim, no
//   case folding, no coercion); anything else -> "invalid".
// - Any throw (e.g. hostile getter) -> "invalid".
export function classifyMessageScope(triggerData: unknown): MessageScopeClass {
  try {
    if (typeof triggerData !== "object" || triggerData === null || Array.isArray(triggerData)) return "invalid";
    if (!Object.prototype.hasOwnProperty.call(triggerData, "messageScope")) return "every_message";
    const v = (triggerData as Record<string, unknown>).messageScope;
    if (v === undefined) return "every_message";
    if (typeof v === "string" && isMessageScope(v)) return v;
    return "invalid";
  } catch {
    return "invalid";
  }
}

// true  -> the flow MAY claim/consume the inbound message.
// false -> the caller must NOT claim and must continue to the AI path (fallback).
// Read FAILURES of the conversation-start signal must be handled by the caller
// before this point; never pass null to mean "unknown -> AI". Here null/undefined
// only ever fail closed to false for "conversation_start".
export function messageScopeAllowsFlow(
  scope: MessageScopeClass,
  conversationStart: boolean | null | undefined,
): boolean {
  if (scope === "every_message") return true;
  if (scope === "conversation_start") return conversationStart === true;
  return false;
}
