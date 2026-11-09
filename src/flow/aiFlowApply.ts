import { importFlow, validateDocument } from "./model.ts";
import type { FlowDocument, FlowEdge, FlowNode } from "./model.ts";
import { arrangeFlow, cardSize, findOpenPosition } from "./layout.ts";
import type { LayoutDirection } from "./layout.ts";
import { uuid } from "../lib/uuid.ts";

/** Pure helpers for the AI flow assistant: normalise + validate a server draft, then build the document to apply. */

export type PrepareResult = { ok: true; doc: FlowDocument } | { ok: false; message: string };
export const INVALID_DRAFT_MESSAGE = "التدفق المولّد غير صالح ولم يُطبَّق. حاول مرة أخرى أو عدّل وصفك.";

/** Runs the project's own normaliser (importFlow) and validator (validateDocument). Never throws. */
export function prepareGenerated(raw: unknown): PrepareResult {
  try {
    if (!raw || typeof raw !== "object") return { ok: false, message: INVALID_DRAFT_MESSAGE };
    const r = raw as { nodes?: unknown; edges?: unknown };
    const doc = importFlow({ version: 3, name: "تدفق مولّد", nodes: r.nodes, edges: r.edges });
    if (!doc) return { ok: false, message: INVALID_DRAFT_MESSAGE };
    const errors = validateDocument(doc).filter(i => i.severity === "error");
    if (errors.length) return { ok: false, message: INVALID_DRAFT_MESSAGE + " (" + errors[0].message + ")" };
    return { ok: true, doc };
  } catch {
    return { ok: false, message: INVALID_DRAFT_MESSAGE };
  }
}

/** True when the open flow is empty or only the default trigger: replacing it loses nothing. */
export function isDefaultFlow(doc: FlowDocument): boolean {
  if (doc.edges.length) return false;
  return doc.nodes.length === 0 || (doc.nodes.length === 1 && doc.nodes[0].data.kind === "trigger");
}

export type ApplyOutcome = { doc: FlowDocument; droppedTrigger: boolean };

/** Replace: keep the open flow's name, lay the generated steps out cleanly. */
export function buildReplace(current: FlowDocument, generated: FlowDocument, direction: LayoutDirection): ApplyOutcome {
  const arranged = arrangeFlow({ ...generated, name: current.name }, direction);
  return { doc: arranged, droppedTrigger: false };
}

/** Append: fresh ids everywhere, placed in free space; the generated trigger is dropped when one already exists. */
export function buildAppend(current: FlowDocument, generated: FlowDocument, direction: LayoutDirection): ApplyOutcome {
  const hasTrigger = current.nodes.some(n => n.data.kind === "trigger");
  const arranged = arrangeFlow(generated, direction);
  const dropIds = new Set(hasTrigger ? arranged.nodes.filter(n => n.data.kind === "trigger").map(n => n.id) : []);
  const kept = arranged.nodes.filter(n => !dropIds.has(n.id));
  if (!kept.length) throw new Error("nothing_to_add");
  if (current.nodes.length + kept.length > 100) throw new Error("too_many_nodes");

  const idMap = new Map<string, string>();
  const handleMap = new Map<string, string>();
  for (const n of kept) idMap.set(n.id, uuid());
  const cloned: FlowNode[] = kept.map(n => {
    const data = structuredClone(n.data);
    data.options = data.options.map(o => {
      const next = uuid();
      handleMap.set(n.id + "\u0000" + o.id, next);
      return { ...o, id: next };
    });
    if (typeof data.gotoNode === "string" && data.gotoNode) data.gotoNode = idMap.get(data.gotoNode) ?? "";
    return { ...structuredClone(n), id: idMap.get(n.id)!, data, selected: false };
  });
  const edges: FlowEdge[] = [];
  for (const e of arranged.edges) {
    const source = idMap.get(e.source), target = idMap.get(e.target);
    if (!source || !target) continue; // edge touched the dropped trigger
    const handle = e.sourceHandle ?? "next";
    edges.push({ ...structuredClone(e), id: uuid(), source, target, sourceHandle: handleMap.get(e.source + "\u0000" + handle) ?? handle, targetHandle: "in" });
  }
  if (current.nodes.length + cloned.length > 100 || current.edges.length + edges.length > 250) throw new Error("too_many_nodes");

  // Move the whole block into free space beside/below the current flow (relative layout preserved).
  const existing = current.nodes;
  let origin = { x: 0, y: 0 };
  if (existing.length) {
    const minX = Math.min(...existing.map(n => n.position.x)), minY = Math.min(...existing.map(n => n.position.y));
    const maxX = Math.max(...existing.map(n => n.position.x + cardSize(n).width));
    const maxY = Math.max(...existing.map(n => n.position.y + cardSize(n).height));
    origin = direction === "LR" ? { x: minX, y: maxY + 150 } : { x: maxX + 150, y: minY };
  }
  const gx = Math.min(...cloned.map(n => n.position.x)), gy = Math.min(...cloned.map(n => n.position.y));
  const placed: FlowNode[] = [];
  for (const n of cloned) {
    const preferred = { x: origin.x + (n.position.x - gx), y: origin.y + (n.position.y - gy) };
    placed.push({ ...n, position: findOpenPosition([...existing, ...placed], n, preferred) });
  }
  return {
    doc: { ...current, nodes: [...existing, ...placed], edges: [...current.edges, ...edges] },
    droppedTrigger: dropIds.size > 0,
  };
}
