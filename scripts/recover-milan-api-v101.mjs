#!/usr/bin/env node
/**
 * Restore exact once-observed production milan-api v101 from tracked .bak.
 * This only WRITES a requested local file. It does not deploy or contact APIs.
 * Captured production version: 101. No user data or token values are embedded.
 */
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
const input="supabase/functions/milan-api/index.ts.bak";
const output=process.argv[2];
if(!output||process.argv.length!==3){
 console.error("Usage: node scripts/recover-milan-api-v101.mjs <output-path>");
 process.exit(2);
}
const bytes=readFileSync(input);
const digest=createHash("sha1").update("blob "+bytes.byteLength+"\\0").update(bytes).digest("hex");
assert.equal(digest,"fd2e2a8377a7062a4e7f4641a7eadd92c65fc789","Source .bak blob changed; refuse reconstructed recovery");
const original=bytes.toString("utf8");
const originalBlock="  const data = fromHex(dataH);\n  const tag = fromHex(tagH);\n\n  const buf = new Uint8Array(data.length + 16);\n\n  buf.set(data, 0);\n  buf.set(tag, data.length);\n\n  const pt = await crypto.subtle.decrypt(\n    {\n      name: \"AES-GCM\",\n      iv: fromHex(ivH) as BufferSource,\n    },\n    await aesKey(\"decrypt\"),\n    buf as BufferSource\n  );\n\n  return dec.decode(pt);";
const deployedBlock="  try {\n    const data = fromHex(dataH);\n    const tag = fromHex(tagH);\n  \n    const buf = new Uint8Array(data.length + 16);\n  \n    buf.set(data, 0);\n    buf.set(tag, data.length);\n  \n    const pt = await crypto.subtle.decrypt(\n      {\n        name: \"AES-GCM\",\n        iv: fromHex(ivH) as BufferSource,\n      },\n      await aesKey(\"decrypt\"),\n      buf as BufferSource\n    );\n  \n    return dec.decode(pt);\n  } catch (error) {\n    // Preserve encrypted DB values unchanged; never leak ciphertext or secret material to logs.\n    console.warn(\"[milan-api:decryptField] Unreadable encrypted field (value preserved)\");\n    return \"[رسالة مشفرة غير قابلة للقراءة — يرجى مراجعة مفتاح التشفير]\";\n  }";
assert.equal(original.split(originalBlock).length,2,"Unique v101 decryption block missing");
const recovered=original.replace(originalBlock,deployedBlock).trimEnd();
assert.equal(recovered.length,117955,"Unexpected v101 source length");
writeFileSync(output,recovered,{flag:"wx",mode:0o600});
console.log("Recovered observed milan-api v101 source at "+output+
 " (sha256="+createHash("sha256").update(recovered).digest("hex")+")");
