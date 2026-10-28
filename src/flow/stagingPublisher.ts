/**
 * Staging-only server-side publishing contract. This module is NOT mounted
 * as a production API and cannot activate a customer automation.
 *
 * The session verifier MUST use auth.getUser / verified server claims,
 * never client-provided tenant_id or mutable user_metadata.
 * PostgreSQL implementations MUST append immutable revisions atomically.
 */
import {importFlow} from "./model.ts";
import type {FlowDocument} from "./model.ts";
import {auditFlowPublication} from "./publicationGate.ts";
import type {FlowCapability} from "./publicationGate.ts";

export const MAX_PUBLISHED_DOCUMENT_BYTES=4*1024*1024;
export type VerifiedPublisher={userId:string;tenantId:string};
export type ServerAccount={
  id:string;tenantId:string;enabled:boolean;
  capabilities:ReadonlySet<FlowCapability>;
};
export type PublishedRevision={
  tenantId:string;flowKey:string;revision:number;
  accountId:string;document:FlowDocument;
};
export type Activation={
  tenantId:string;accountId:string;flowKey:string;
  revision:number;active:boolean;
};

export interface PublisherAuth {
  /** Server verifies bearer token and resolves tenant from DB. */
  identify(bearerToken:string):Promise<VerifiedPublisher|null>;
}
export interface PublicationStore {
  account(tenantId:string,accountId:string):Promise<ServerAccount|null>;
  /**
   * DB transaction: lock (tenant_id,flow_key), increment revision,
   * INSERT only, no UPDATE or DELETE of historical publications.
   */
  appendImmutable(input:{
    tenantId:string;accountId:string;flowKey:string;
    actorId:string;document:FlowDocument;
  }):Promise<PublishedRevision>;
  publication(tenantId:string,flowKey:string,revision:number):
    Promise<PublishedRevision|null>;
  activation(tenantId:string,accountId:string,flowKey:string):
    Promise<Activation|null>;
  /** DB transaction: update only activation pointer, never document. */
  setActivation(input:Activation):Promise<Activation>;
  /**
   * Read server-side opt-in/canary authorization. Must default false,
   * and require test-owned account plus owner-approved staging environment.
   */
  canActivateTestAccount(tenantId:string,accountId:string):Promise<boolean>;
}
type Outcome<T>=
  | {ok:true;value:T}
  | {ok:false;reason:"unauthenticated"|"invalid_request"|"forbidden"|
    "invalid_document"|"not_published"|"activation_disabled"};

const fail=<T>(reason:Extract<Outcome<T>,{ok:false}>["reason"]):Outcome<T>=>
  ({ok:false,reason});
const good=<T>(value:T):Outcome<T>=>({ok:true,value});
function validKey(x:unknown):x is string {
  return typeof x==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(x);
}
function validId(x:unknown):x is string{
  return typeof x==="string"&&x.length>0&&x.length<=256 &&
    x.trim()===x&&!/[\u0000-\u001f]/.test(x);
}

export class StagingFlowPublisher {
  private readonly auth:PublisherAuth;
  private readonly store:PublicationStore;
  constructor(auth:PublisherAuth,store:PublicationStore){
    this.auth=auth;
    this.store=store;
  }

  private async verify(bearer:string,accountId:string,allowDisabled=false){
    if(typeof bearer!=="string"||bearer.length<1||bearer.length>8192||
      !validId(accountId))return null;
    const caller=await this.auth.identify(bearer);
    if(!caller||!validId(caller.tenantId)||!validId(caller.userId))return null;
    const account=await this.store.account(caller.tenantId,accountId);
    if(!account||account.tenantId!==caller.tenantId||
       account.id!==accountId||(!allowDisabled&&!account.enabled))return null;
    return {caller,account};
  }

  async publish(bearer:string,accountId:string,flowKey:string,
                untrustedDocument:unknown):Promise<Outcome<PublishedRevision>>{
    if(!validKey(flowKey)||!validId(accountId))
      return fail("invalid_request");
    const scope=await this.verify(bearer,accountId);
    if(!scope)return fail("unauthenticated");
    let raw:string,document:FlowDocument|null;
    try{
      raw=JSON.stringify(untrustedDocument);
      if(!raw || new TextEncoder().encode(raw).length>MAX_PUBLISHED_DOCUMENT_BYTES)
        return fail("invalid_document");
      document=importFlow(JSON.parse(raw));
      if(!document||document.version!==3)return fail("invalid_document");
    }catch{return fail("invalid_document");}
    // The capabilities are read from a trusted server adapter, not the request.
    try{
      if(!auditFlowPublication(document,scope.account.capabilities).canPublish)
        return fail("invalid_document");
    }catch{return fail("invalid_document");}
    const revision=await this.store.appendImmutable({
      tenantId:scope.caller.tenantId,accountId,flowKey,
      actorId:scope.caller.userId,document
    });
    if(revision.tenantId!==scope.caller.tenantId||
       revision.accountId!==accountId||revision.flowKey!==flowKey||
       !Number.isSafeInteger(revision.revision)||revision.revision<=0)
      throw Error("invalid publication store result");
    return good(revision);
  }

  async activate(bearer:string,accountId:string,flowKey:string,revision:number):
    Promise<Outcome<Activation>>{
    if(!validKey(flowKey)||!Number.isSafeInteger(revision)||revision<1)
      return fail("invalid_request");
    const scope=await this.verify(bearer,accountId);
    if(!scope)return fail("unauthenticated");
    if(!await this.store.canActivateTestAccount(scope.caller.tenantId,accountId))
      return fail("activation_disabled");
    const pub=await this.store.publication(scope.caller.tenantId,flowKey,revision);
    if(!pub||pub.accountId!==accountId)
      return fail("not_published");
    // Reaudit at activation time; approved capabilities may have changed.
    try{
      if(!auditFlowPublication(pub.document,scope.account.capabilities).canPublish)
        return fail("invalid_document");
    }catch{return fail("invalid_document");}
    return good(await this.store.setActivation({
      tenantId:scope.caller.tenantId,accountId,flowKey,revision,active:true
    }));
  }

  async deactivate(bearer:string,accountId:string,flowKey:string):
    Promise<Outcome<Activation>>{
    if(!validKey(flowKey))return fail("invalid_request");
    const scope=await this.verify(bearer,accountId,true);
    if(!scope)return fail("unauthenticated");
    const existing=await this.store.activation(scope.caller.tenantId,accountId,flowKey);
    if(!existing)return fail("not_published");
    return good(await this.store.setActivation({...existing,active:false}));
  }

  /** Rollback changes the activation pointer; published revisions remain immutable. */
  async rollback(bearer:string,accountId:string,flowKey:string,targetRevision:number){
    return this.activate(bearer,accountId,flowKey,targetRevision);
  }
}
