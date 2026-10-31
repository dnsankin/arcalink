import {safeRelative} from './folder-model.mjs';
const fail=code=>Object.assign(Error(code),{code});
export const shared2FileDigest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
/** Trusted coordinator only, after staging writes have been durably sealed.
 * Manifest comes from the frozen source, never an uploaded client assertion.
 */
export async function verifyShared2Files({engine,manifest,documentRoot,isSealed,hashStream}){
 if(!engine||typeof engine.inspect!=='function'||typeof engine.read!=='function'||typeof isSealed!=='function'||!safeRelative(documentRoot)||!Array.isArray(manifest)||await isSealed()!==true)throw fail('shared2-verification-not-sealed');
 const expected=new Map();
 for(const file of manifest){if(!file||!safeRelative(file.path)||!Number.isSafeInteger(file.size)||file.size<0||!(/^[a-f0-9]{64}$/).test(file.sha256)||expected.has(file.path.toLowerCase()))throw fail('invalid-shared2-file-manifest');expected.set(file.path.toLowerCase(),{...file,path:documentRoot+'/'+file.path});}
 const before=await engine.inspect(),seen=new Set(),needed=new Set();
 if(before.reserved.some(id=>id!=='_design/arcalink_shared2_access'))throw fail('shared2-unexpected-reserved-document');
 for(const file of before.files){
  const relative=file.path.startsWith(documentRoot+'/')?file.path.slice(documentRoot.length+1):null,entry=relative&&expected.get(relative.toLowerCase());
  if(!entry||seen.has(relative.toLowerCase())||entry.path!==file.path||file.deleted||file.conflicts.length)throw fail('shared2-unexpected-or-conflicted-file');
  seen.add(relative.toLowerCase());
  for(const child of file.children){if(typeof child!=='string'||!child.startsWith('h:'))throw fail('shared2-invalid-chunk-reference');if(!file.inline.includes(child))needed.add(child);}
  if(hashStream&&typeof engine.stream==='function'){
   const result=await hashStream(engine.stream(file.path));if(result.size!==entry.size||result.sha256!==entry.sha256)throw fail('shared2-file-content-mismatch');
  }else{const data=await engine.read(file.path);if(!data||data.bytes.byteLength!==entry.size||await shared2FileDigest(data.bytes)!==entry.sha256)throw fail('shared2-file-content-mismatch');}
 }
 if(seen.size!==expected.size||needed.size!==before.chunks.length||before.chunks.some(id=>!needed.has(id)))throw fail('shared2-incomplete-or-extra-content');
 const after=await engine.inspect();if(after.sequence!==before.sequence||await isSealed()!==true)throw fail('shared2-verification-changed');
 return {verified:true,files:seen.size,bytes:manifest.reduce((n,file)=>n+file.size,0),localSequence:after.sequence};
}
