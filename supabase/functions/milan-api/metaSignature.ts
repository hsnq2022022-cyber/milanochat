/**
 * Verify Meta's X-Hub-Signature-256 over the UNMODIFIED raw request body.
 * Never accept events when all app secrets are absent. No storage or network IO.
 * Meta may use INSTAGRAM_APP_SECRET or META_APP_SECRET depending on the app.
 */
export async function verifyMetaWebhookSignature(
  raw:string,signature:string,configuredSecrets:readonly string[]
):Promise<boolean> {
  if(typeof raw!=="string"||typeof signature!=="string"||
     !/^sha256=[a-fA-F0-9]{64}$/.test(signature)||!Array.isArray(configuredSecrets))
    return false;
  const secrets=configuredSecrets.filter(secret=>
    typeof secret==="string"&&secret.trim().length>0
  );
  if(secrets.length===0)return false;
  const expectedHex=signature.slice(7).toLowerCase();
  const bytes=new TextEncoder().encode(raw);
  let matched=0;
  for(const secret of secrets) {
    const key=await crypto.subtle.importKey(
      "raw",new TextEncoder().encode(secret.trim()),
      {name:"HMAC",hash:"SHA-256"},false,["sign"]
    );
    const digest=new Uint8Array(await crypto.subtle.sign("HMAC",key,bytes));
    let difference=0;
    for(let i=0;i<digest.length;i++){
      const expected=parseInt(expectedHex.slice(i*2,i*2+2),16);
      difference|=digest[i]^expected;
    }
    // Do not short-circuit across secrets: avoid leaking which configured
    // app secret was used through handler timing.
    matched|=Number(difference===0);
  }
  return matched!==0;
}
