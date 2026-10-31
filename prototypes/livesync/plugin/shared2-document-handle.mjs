const fail=()=>Object.assign(Error('shared2-selection-scope'),{code:'shared2-selection-scope'});
/** Job-scoped opaque IDs also cover personal encryption without path obfuscation.
 * Source keys and decrypted paths never belong in the selection frame itself. */
export async function shared2DocumentHandle(job,nonce,identifier){
 if(typeof job!=='string'||!/^[a-f0-9]{32}$/.test(job)||typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce)||typeof identifier!=='string'||!identifier||identifier.startsWith('_'))throw fail();
 const bytes=new TextEncoder().encode(JSON.stringify(['shared2-document-v1',job,nonce,identifier]));
 return 'd:'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
}
