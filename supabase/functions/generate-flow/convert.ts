/**
 * generate-flow: validated LLM flow -> the REAL frontend document shape.
 *
 * Reuses src/flow/model.ts (makeNode defaults, outputs() handle ids, edgeFor,
 * importFlow, validateDocument) exactly like flow-publication reuses
 * src/flow/serverPublicationValidation.ts, so the editor receives nodes it
 * would have created itself. Ids are always re-minted server-side and
 * positions are always assigned server-side (x:100, y:index*150).
 */
import { edgeFor, importFlow, makeNode, outputs, validateDocument } from "../../../src/flow/model.ts";
import type { FlowDocument, FlowEdge, FlowNode } from "../../../src/flow/model.ts";
import type { LlmFlow, LlmNode } from "./schema.ts";

export type GeneratedDocument = { nodes: FlowNode[]; edges: FlowEdge[] };
export type ConvertResult = { ok: true; document: GeneratedDocument } | { ok: false; reason: string };

/** Largest whole unit: 7200 s -> 2 hours, 90 s -> 90 seconds. */
export function delayParts(seconds: number): { delayValue: number; delayUnit: "seconds" | "minutes" | "hours" | "days" } {
  if (seconds % 86400 === 0) return { delayValue: seconds / 86400, delayUnit: "days" };
  if (seconds % 3600 === 0) return { delayValue: seconds / 3600, delayUnit: "hours" };
  if (seconds % 60 === 0) return { delayValue: seconds / 60, delayUnit: "minutes" };
  return { delayValue: seconds, delayUnit: "seconds" };
}

const newId = (): string => crypto.randomUUID();

function toNode(n: LlmNode, index: number, optionIds: Map<string, string>): FlowNode {
  const position = { x: 100, y: index * 150 };
  switch (n.type) {
    case "trigger":
      // "message" (any incoming DM) exists on every channel and needs no keywords.
      return makeNode("trigger", position, { platform: n.data.channel, triggerMode: "message", keywords: "" });
    case "message":
      return makeNode("message", position, { text: n.data.text, options: [] });
    case "question":
      return makeNode("question", position, {
        text: n.data.text, inputMode: "buttons",
        options: n.data.options.map(o => {
          const id = newId();
          optionIds.set(n.id + "\u0000" + o.id, id);
          return { id, label: o.label, buttonType: "button" as const, action: "step" as const };
        }),
      });
    case "delay":
      return makeNode("delay", position, delayParts(n.data.seconds));
    case "condition":
      return makeNode("condition", position, {
        conditionField: n.data.variable, operator: n.data.operator,
        conditionValue: n.data.operator === "exists" ? "" : n.data.value,
      });
    case "end":
      return makeNode("end", position);
  }
}

/** Converts, then requires the frontend's own import + validation to accept it (0 errors). */
export function toFrontendDocument(flow: LlmFlow): ConvertResult {
  try {
    const ids = new Map<string, string>();
    const optionIds = new Map<string, string>();
    const nodes = flow.nodes.map((n, i) => {
      const node = toNode(n, i, optionIds);
      node.id = newId();
      ids.set(n.id, node.id);
      return node;
    });
    const byNewId = new Map(nodes.map(n => [n.id, n]));
    const edges = flow.edges.map(e => {
      const source = ids.get(e.source)!, target = ids.get(e.target)!;
      const from = flow.nodes.find(n => n.id === e.source)!;
      const handle = from.type === "condition" ? (e.sourceHandle === "true" ? "yes" : "no")
        : from.type === "question" ? optionIds.get(e.source + "\u0000" + e.sourceHandle)!
        : "next";
      const label = outputs(byNewId.get(source)!).find(p => p.id === handle)?.label ?? "";
      return edgeFor({ source, target, sourceHandle: handle, targetHandle: "in" }, label);
    });
    const doc: FlowDocument = { version: 3, name: "تدفق مولّد بالذكاء الاصطناعي", nodes, edges };
    // Must survive the editor's own importer unchanged in size...
    const imported = importFlow(JSON.parse(JSON.stringify(doc)));
    if (!imported || imported.nodes.length !== nodes.length || imported.edges.length !== edges.length)
      return { ok: false, reason: "convert:import" };
    // ...and pass the editor's validator with zero errors (warnings allowed).
    const errors = validateDocument(imported).filter(i => i.severity === "error");
    if (errors.length) return { ok: false, reason: "convert:validate" };
    return { ok: true, document: { nodes, edges } };
  } catch {
    return { ok: false, reason: "convert:internal" };
  }
}
