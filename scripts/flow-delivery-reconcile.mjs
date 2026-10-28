#!/usr/bin/env node
// Prepared for separately approved scheduling; never sends, retries, or bills.
const origin=process.env.SUPABASE_URL;
const secret=process.env.SUPABASE_SERVICE_ROLE_KEY;
const project="nmhefwvhoholcjrbbila";
const minAge=15,limit=100;
if(process.argv[2]!=="--run"){
 console.log("Reconciliation NOT scheduled. Explicit --run and service credentials required.");
 process.exit(0);
}
if(origin!=="https://"+project+".supabase.co"||!secret){
 console.error("Refusing reconciliation: exact project URL and service secret required");
 process.exit(1);
}
const res=await fetch(origin+"/rest/v1/rpc/flow_queue_uncertain_deliveries",{
 method:"POST",headers:{
  apikey:secret,authorization:"Bearer "+secret,"content-type":"application/json"
 },body:JSON.stringify({p_min_age_minutes:minAge,p_limit:limit}),signal:AbortSignal.timeout(10000)
});
if(!res.ok){
 console.error("Human-review queue failed: HTTP "+res.status);
 process.exitCode=1;
}else{
 const n=await res.json();
 if(!Number.isInteger(n)||n<0||n>limit){
  console.error("Unexpected review queue result");process.exitCode=1;
 }else console.log("Human review queued="+n+"; provider sends=0; retries=0; debit operations=0");
}
