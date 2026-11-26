import test from "node:test";
import assert from "node:assert/strict";
import {channelTokenState,channelTokenNotice,instagramRefreshDecision} from "../src/lib/channelTokenState.ts";

const NOW=Date.parse("2026-11-26T00:00:00Z"),D=86_400_000;
const at=(days:number)=>new Date(NOW+days*D).toISOString();

test("healthy: far expiry or none (Facebook page tokens never expire)",()=>{
 assert.equal(channelTokenState({status:"active",tokenExpiresAt:at(31)},NOW).state,"healthy");
 assert.equal(channelTokenState({status:"active",tokenExpiresAt:null},NOW).state,"healthy");
 assert.equal(channelTokenNotice(channelTokenState({status:"active",tokenExpiresAt:at(31)},NOW)),null);
});
test("expiring warning inside 14 days, with a clear Arabic notice",()=>{
 const i=channelTokenState({status:"active",tokenExpiresAt:at(5)},NOW);
 assert.equal(i.state,"expiring");assert.equal(i.daysLeft,5);
 const n=channelTokenNotice(i);assert.equal(n?.severity,"warn");assert.ok(n!.text.length>5);
});
test("expired token is never healthy and is an error",()=>{
 const i=channelTokenState({status:"active",tokenExpiresAt:at(-1)},NOW);
 assert.equal(i.state,"expired");assert.equal(channelTokenNotice(i)?.severity,"error");
});
test("needs_reauth and disconnected win over any expiry",()=>{
 assert.equal(channelTokenState({status:"needs_reauth",tokenExpiresAt:at(40)},NOW).state,"needs_reauth");
 assert.equal(channelTokenState({status:"disconnected",tokenExpiresAt:at(40)},NOW).state,"disconnected");
 assert.equal(channelTokenNotice(channelTokenState({status:"needs_reauth",tokenExpiresAt:at(40)},NOW))?.severity,"error");
});
test("instagram refresh decision: window, minimum age, expired",()=>{
 assert.equal(instagramRefreshDecision(at(20),NOW),"due");
 assert.equal(instagramRefreshDecision(at(30),NOW),"not_due");
 assert.equal(instagramRefreshDecision(at(59.9),NOW),"not_due");
 assert.equal(instagramRefreshDecision(at(-1),NOW),"expired");
 assert.equal(instagramRefreshDecision(null,NOW),"unknown");
});
