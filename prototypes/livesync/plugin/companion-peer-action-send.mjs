import {actionHash,readAction,readActionDescriptor,applyCheckboxIntent} from './companion-action-outbox.mjs';
import {isActionRevision} from './companion-action-revision.mjs';
const fail=code=>Object.assign(Error(code),{code});
/** Upload only immutable ciphertext, then request guarded receiver dispatch. */
export async function sendPeerAction({client,store,identity,key,admit}){
 if(!client||typeof client.call!=='function'||typeof store?.read!=='function'||typeof admit!=='function')throw fail('action-send-invalid');
 await admit();const action=await readActionDescriptor(store,identity,key),manifest=await store.read('manifest.json');let parsed;try{parsed=JSON.parse(manifest);}catch{throw fail('action-manifest-invalid');}
 let resultHash=action.resultHash,targetSize=action.resultSize;
 async function loadResult(){
  const full=await readAction(store,identity,key);let resultBytes=full.payload;
  if(full.intent.kind==='set-checkbox'){let before;try{before=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(resultBytes);}catch{throw fail('action-checkbox-encoding');}resultBytes=new TextEncoder().encode(await applyCheckboxIntent(before,full.intent));}
  resultHash=await actionHash(resultBytes);targetSize=resultBytes.length;
 }
 function checked(value){
  if(value?.state==='confirmed'){
   const r=value.receipt,p=r?.proof;
   if(value.path!==action.intent.path||value.resultHash!==resultHash||r?.operationId!==identity.operationId||r.intent!==action.intentDigest||r.outcome!=='confirmed'||!isActionRevision(r.revision)||typeof r.documentId!=='string'||!p||p.revision!==r.revision||p.provenance!==r.revision||p.sha256!==resultHash||p.size!==targetSize)throw fail('action-receipt-invalid');
   return value;
  }
  if(value?.state==='pending'||value?.state==='conflict')return value;
  throw fail('action-result-unconfirmed');
 }
 async function upload(name,contents){
  if(typeof contents!=='string'||contents.length<1||contents.length>512*1024||/[^\x20-\x7e]/.test(contents))throw fail('action-upload-invalid');
  await admit();await client.call('begin',{operationId:identity.operationId,key,name,size:contents.length,sha256:await actionHash(contents)});
  for(let offset=0;offset<contents.length;offset+=4096){await admit();await client.call('append',{offset,data:contents.slice(offset,offset+4096)});}
  await admit();const done=await client.call('complete',{});if(done?.stored!==true)throw fail('action-upload-invalid');
 }
 await upload('manifest.json',manifest);
 if(!resultHash)await loadResult();
 await admit();const recovered=checked(await client.call('recover',{operationId:identity.operationId,key}));
 if(recovered.state==='confirmed'||recovered.state==='conflict'){await admit();return recovered;}
 for(let i=0;i<parsed.chunks.length;i++)await upload(`chunk-${i}.json`,await store.read(`chunk-${i}.json`));
 await admit();const value=checked(await client.call('dispatch',{operationId:identity.operationId,key}));
 await admit();return value;
}
