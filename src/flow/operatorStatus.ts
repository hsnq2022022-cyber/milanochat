/**
 * PURE client classification of the flow-publication `operator_status` reply.
 *
 * The server is authoritative: every operator-only action (readiness, catalog,
 * read, list, legacy publish, activate, rollback, unknown actions) is refused
 * there with 403 for non-operators. Hiding controls in the UI is NOT a security
 * boundary; it only keeps ordinary customers away from controls the server
 * would refuse anyway.
 *
 * Fail closed: "operator" ONLY for an object reply with ok===true and
 * operator===true exactly. Errors, non-objects, arrays, missing fields, ok:false
 * or truthy non-boolean values are "customer". Operator status is never derived
 * from env flags (e.g. VITE_ENABLE_FLOW_CANARY_CONTROLS), tenant/staff roles,
 * user metadata or localStorage.
 */
export type OperatorStatus="loading"|"operator"|"customer";

export function classifyOperatorStatus(reply:unknown):"operator"|"customer"{
 if(reply===null||typeof reply!=="object"||Array.isArray(reply))return "customer";
 const r=reply as Record<string,unknown>;
 return r.ok===true&&r.operator===true?"operator":"customer";
}
