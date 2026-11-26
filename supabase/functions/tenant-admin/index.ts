/**
 * tenant-admin Edge entry (verify_jwt=true). Manual commercial administration; see handler.ts.
 * Requires migration 20261126100000_manual_credit_admin and the secret TENANT_ADMIN_USER_IDS.
 * NOT deployed until separately approved.
 */
import {createClient} from "npm:@supabase/supabase-js@2";
import {handleTenantAdmin,type Db} from "./handler.ts";

if(import.meta.main)Deno.serve((req)=>handleTenantAdmin(req,{
 env:(k)=>Deno.env.get(k),
 db:(url,key)=>createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}) as unknown as Db
}));
