import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

test("exact v101 production recovery is deterministic, private and never overwrites",()=>{
 const dir=mkdtempSync(join(tmpdir(),"milan-v101-"));
 const output=join(dir,"index.ts");
 try{
  execFileSync(process.execPath,["scripts/recover-milan-api-v101.mjs",output],{stdio:"pipe"});
  const source=readFileSync(output,"utf8");
  assert.equal(source.length,117955);
  assert.match(source,/Unreadable encrypted field \(value preserved\)/);
  assert.match(source,/Deno\.serve\(async \(req\) =>/);
  assert.equal(statSync(output).mode & 0o077,0);
  assert.throws(()=>execFileSync(process.execPath,
   ["scripts/recover-milan-api-v101.mjs",output],{stdio:"pipe"}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
