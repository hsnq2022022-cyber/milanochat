import {test} from "node:test";
import assert from "node:assert/strict";
import {accountCanActivate,pickActivationAccount,type ActivationAccount} from "./activationAccount.ts";

const ig:ActivationAccount={id:"ig",platform:"instagram",is_active:true,canActivate:true,canActivateComments:true};
const fb:ActivationAccount={id:"fb",platform:"facebook",is_active:true,canActivate:false,canActivateComments:true};
const fbOff:ActivationAccount={...fb,id:"fbOff",canActivateComments:false};
const wa:ActivationAccount={id:"wa",platform:"whatsapp",is_active:true,canActivate:false,canActivateComments:false};

test("non-comment flows: the previous account choice and canActivate rule",()=>{
 assert.equal(pickActivationAccount([fb,ig],null)?.id,"ig");
 assert.equal(pickActivationAccount([fb,wa],null)?.id,"fb");
 assert.equal(pickActivationAccount([],null),null);
 assert.equal(accountCanActivate(fb,null),false,"facebook DM flow stays locked");
 assert.equal(accountCanActivate(ig,null),true);
 assert.equal(accountCanActivate(null,null),false);
});
test("facebook comment flow: picks the Page account the server marked canActivateComments",()=>{
 assert.equal(pickActivationAccount([ig,fb],"facebook")?.id,"fb");
 assert.equal(accountCanActivate(fb,"facebook"),true);
 // Server flags OFF: no canActivateComments -> locked, falls back to the old choice.
 assert.equal(pickActivationAccount([ig,fbOff],"facebook")?.id,"ig");
 assert.equal(accountCanActivate(fbOff,"facebook"),false);
 // Hint never crosses platforms; a missing field is OFF.
 assert.equal(accountCanActivate(fb,"instagram"),false);
 assert.equal(accountCanActivate({id:"x",platform:"facebook",is_active:true},"facebook"),false);
 assert.equal(accountCanActivate(wa,"facebook"),false);
});
test("instagram comment flow keeps the instagram account",()=>{
 assert.equal(pickActivationAccount([fb,ig],"instagram")?.id,"ig");
 assert.equal(accountCanActivate(ig,"instagram"),true);
});
