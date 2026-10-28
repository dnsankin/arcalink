/** Exact-version evidence only. Connection/progress counters never enter this model. */
export const MAX_PROOF_BYTES=64*1024*1024;
export function safeCompanionPath(path){
 return typeof path==='string'&&path.length>0&&path.length<=1024&&!/[\\\x00-\x1f\x7f:#]/.test(path)&&
  path.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!part.startsWith('.'));
}
export function validProofFile(file){return !!file&&safeCompanionPath(file.path)&&Number.isSafeInteger(file.size)&&file.size>=0&&/^[a-f0-9]{64}$/.test(file.sha256);}
export function validProofRequest(input){
 return !!input&&input.schema===1&&(input.refreshNonce===undefined||typeof input.refreshNonce==='string'&&/^[a-zA-Z0-9-]{16,100}$/.test(input.refreshNonce))&&/^[a-zA-Z0-9-]{16,80}$/.test(input.vaultId)&&Array.isArray(input.requests)&&input.requests.length<=50&&
  input.requests.every(r=>/^[a-zA-Z0-9-]{16,100}$/.test(r.id)&&Array.isArray(r.files)&&r.files.length>0&&r.files.length<=1000&&r.files.every(validProofFile));
}
export async function sha256(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');}
const live=doc=>doc&&!doc._deleted&&!doc.deleted&&!(doc._conflicts?.length)&&typeof doc._rev==='string';
/** The supplied get() MUST read remote winning revisions with conflicts:true. */
export async function verifyCloudFile(file,{get,id,decode,stillCurrent=()=>true}){
 if(!validProofFile(file)||file.size>MAX_PROOF_BYTES)return false;
 const meta=await get(id);if(!stillCurrent()||!live(meta)||meta.size!==file.size||!['plain','newnote','notes'].includes(meta.type))return false;
 let data=meta.data;
 if(meta.type!=='notes'){
  if(!Array.isArray(meta.children)||meta.children.length>4096)return false;
  data=[];let encodedBytes=0;
  for(const child of meta.children){
   if(typeof child!=='string'||child.length>512)return false;
   const embedded=meta.eden?.[child];const chunk=embedded?{type:'leaf',data:embedded.data}:await get(child);
   if(!stillCurrent()||!chunk||chunk._deleted||chunk._conflicts?.length||chunk.isCorrupted||chunk.type!=='leaf'||typeof chunk.data!=='string')return false;
   encodedBytes+=chunk.data.length;if(encodedBytes>MAX_PROOF_BYTES*2)return false;data.push(chunk.data);
  }
 }
 if(typeof data!=='string'&&!Array.isArray(data))return false;
 const bytes=await decode({...meta,data,datatype:meta.type});
 if(!stillCurrent()||bytes.byteLength!==file.size||await sha256(bytes)!==file.sha256)return false;
 const final=await get(id);
 return stillCurrent()&&live(final)&&final._rev===meta._rev;
}
export function proofReplyMatches(reply,file,nonce){return !!reply&&reply.schema===1&&reply.nonce===nonce&&reply.path===file.path&&reply.size===file.size&&reply.sha256===file.sha256&&reply.applied===true;}
