/**
 * Failure isolation between tenants for the outbox tick (pure, no IO).
 *
 * The first scan is a global oldest-first window (OUTBOX_SCAN_LIMIT rows). Effects that stay pending on purpose
 * (a paused / suspended tenant, a closed approval gate, no credit) keep their old created_at, so ONE tenant with
 * a large backlog could fill the whole window every tick and starve everyone else until the 60 minute stale
 * sweep. Two bounded counter-measures, neither of which changes what is sent or how:
 *   1. tenantsDominatingWindow: tenants holding more than OUTBOX_TENANT_WINDOW_CAP rows of a saturated window are
 *      excluded from up to OUTBOX_SCAN_ROUNDS-1 follow-up scans, which then read the oldest rows of OTHER tenants.
 *   2. interleaveByTenant: the dispatch cap is shared round-robin, each tenant keeping its own oldest-first order
 *      (per-run effect order is enforced separately by effectOrder.ts and is unaffected).
 */
export const OUTBOX_TENANT_WINDOW_CAP=10;
export const OUTBOX_SCAN_ROUNDS=3;

export function tenantsDominatingWindow(rows:ReadonlyArray<{tenant_id:unknown}>,cap=OUTBOX_TENANT_WINDOW_CAP):string[]{
 const n=new Map<string,number>();
 for(const r of rows){const t=String(r.tenant_id);n.set(t,(n.get(t)??0)+1);}
 return [...n].filter(([,c])=>c>cap).map(([t])=>t).sort();
}

/** Round-robin over tenants in order of each tenant's first (oldest) row; stable within a tenant. */
export function interleaveByTenant<T extends {tenant_id:unknown}>(rows:readonly T[]):T[]{
 const groups=new Map<string,T[]>();
 for(const r of rows){const t=String(r.tenant_id);const g=groups.get(t);if(g)g.push(r);else groups.set(t,[r]);}
 const lists=[...groups.values()];
 const out:T[]=[];
 for(let i=0;out.length<rows.length;i++)for(const l of lists)if(i<l.length)out.push(l[i]);
 return out;
}
