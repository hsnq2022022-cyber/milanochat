import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const pub=readFileSync("src/flow/FlowPublicationPanel.tsx","utf8");
const review=readFileSync("src/pages/DeliveryReviewPanel.tsx","utf8");
const inbox=readFileSync("src/pages/StaffInboxPanel.tsx","utf8");
const api=readFileSync("src/lib/api.ts","utf8");
const dash=readFileSync("src/pages/Dashboard.tsx","utf8");

test("publication panel surfaces needsInternalActions readiness without listing it when not needed",()=>{
 assert.match(pub,/needsInternalActions\?:boolean/);
 assert.match(pub,/internalActions:r\.needsInternalActions===true/);
 assert.match(pub,/\(key!=="internalActions"\|\|readinessNeeds\(report\)\.internalActions\)/);
 assert.match(pub,/data-testid="flow-readiness-internal-actions"/);
 assert.match(pub,/لن تُنفَّذ هذه الإجراءات ما لم تُفعَّل ميزة الإجراءات الداخلية/);
 assert.match(pub,/internalActions:\{ar:/);
});
test("delivery review labels internal kinds and keeps billing_blocked label",()=>{
 for(const k of ["tag","untag","staff_notification","handoff"])assert.match(review,new RegExp(k+":\"")) ;
 assert.match(review,/billing_blocked:"موقوف بسبب الرصيد"/);
 assert.match(review,/f\.delivery_status!=="billing_blocked"/);
 for(const s of ["pending","leased","retry_wait","settled","cancelled","dead_letter"])assert.match(review,new RegExp(s+":\""));
});
test("staff inbox uses only the edge function and handles 423",()=>{
 assert.match(api,/functions\/v1\/flow-staff-inbox/);
 assert.match(api,/res\.status === 423/);
 assert.doesNotMatch(inbox+dash,/flow_staff_notifications/);
 assert.doesNotMatch(inbox,/getSupabase|\.from\(/);
 assert.match(inbox,/صندوق إشعارات الموظفين غير مفعّل حاليًا/);
 assert.match(inbox,/لا توجد إشعارات للموظفين الآن/);
 assert.match(dash,/<StaffInboxPanel token=\{token\} tenantId=\{st\.tenantId\} \/>/);
});
