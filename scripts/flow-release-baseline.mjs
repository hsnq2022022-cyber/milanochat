import assert from "node:assert/strict";

/**
 * Release safety invariants, not yesterday's customer counts.
 * The live smoke records a complete exact snapshot before creating fixtures,
 * and must compare every field for exact parity after teardown.
 * No production access or side effects when importing this module.
 */
const numericFields=[
 "tenants","accounts","conversations","widgetMessages","ledger",
 "widgetLedger","delivery","outbox","flows","windows","claims","publications",
 "historicalAnswers","enabledTenant"
];

export function assertReleaseSafe(snapshot){
 assert(snapshot&&typeof snapshot==="object"&&!Array.isArray(snapshot),
  "Missing production release snapshot");
 for(const key of numericFields){
  assert(Number.isSafeInteger(snapshot[key])&&snapshot[key]>=0,
    "Invalid production count: "+key);
 }
 assert.equal(snapshot.globalOff,true,
  "Global flow switch must remain OFF for protected release");
 assert.equal(snapshot.enabledTenant,0,
  "No tenant may have flows enabled during protected release");
 assert.equal(snapshot.flows,0,
  "No active flow allowed during protected release");
 assert.equal(snapshot.outbox,0,
  "Outbox must be empty for protected release");
 // Deliberately no fixed tenants/messages/payment/ledger/historical-answer totals.
 // Existing Widget replies are FREE and must never be retroactively charged.
}

export function assertReleaseRestored(before,after){
 assertReleaseSafe(before);
 assertReleaseSafe(after);
 assert.deepEqual(after,before,
  "Production counts changed across isolated release fixtures");
}
