import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
test("emergency Stop remains visible for active revisions when global authorization is OFF",()=>{
 const ui=readFileSync("src/flow/FlowPublicationPanel.tsx","utf8");
 assert.match(ui,/\{activation\?\.is_active&&<button/);
 assert.doesNotMatch(ui,/\{showActivationControls&&activation\?\.is_active&&<button/);
 assert.match(ui,/\{showActivationControls&&<button/);
});
