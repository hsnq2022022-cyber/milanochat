import {test} from "node:test";
import assert from "node:assert/strict";
import {WAYL_PACKAGES,selectTopupPackage,validWaylCheckoutLink,serverReturnUrl,makeLinkPayload}
 from "../supabase/functions/topup-create/contract.ts";
test("server controls credits and IQD amount; no fallback for unknown package",()=>{
 assert.equal(selectTopupPackage("starter")?.amountIQD,35000);
 assert.equal(selectTopupPackage("growth")?.credits,3000);
 assert.equal(selectTopupPackage("scale")?.amountIQD,225000);
 for(const value of ["","invalid","__proto__",null,1,["starter"]])
  assert.equal(selectTopupPackage(value),null);
 assert.equal(WAYL_PACKAGES.starter.credits,1000);
});
test("Wayl checkout URL cannot be redirected to phishing, http, credentials, or wrong host",()=>{
 assert.equal(validWaylCheckoutLink("https://checkout.thewayl.com/pay/legitimate"),true);
 for(const value of ["http://checkout.thewayl.com/pay/a",
 "https://checkout.thewayl.com.evil.test/pay/a",
 "https://username:secret@checkout.thewayl.com/pay/a",
 "https://evil.test/","javascript:alert(1)","https://checkout.thewayl.com/",
 null,[]])assert.equal(validWaylCheckoutLink(value),false);
});
test("redirect URL is operator-controlled and HTTPS only",()=>{
 assert.equal(serverReturnUrl("https://hsnq2022022-cyber.github.io/milanochat/"),
 "https://hsnq2022022-cyber.github.io/milanochat/");
 for(const value of ["http://example.com","https://user:pass@example.com/",
 "javascript:alert(1)","https://example.com/#secret"])assert.equal(serverReturnUrl(value),null);
});
test("Wayl link body always reconciles one line and signed webhook route",()=>{
 const p=makeLinkPayload({id:"payment-1",amountIQD:85000,label:"شحن 3000 رد",
  webhookUrl:"https://project.supabase.co/functions/v1/wayl-topup-webhook",
  webhookSecret:"test-secret",redirectUrl:"https://example.com/paid",env:"test"});
 assert.deepEqual(p.lineItem,[{label:"شحن 3000 رد",amount:85000,type:"increase"}]);
 assert.equal(p.total,85000);assert.equal(p.currency,"IQD");
 assert.equal(p.referenceId,"payment-1");assert.equal(p.env,"test");
});
