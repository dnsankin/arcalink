import {createActionStaging,createBoundedActionUpload} from './companion-peer-action-staging.mjs';
import {createPeerActionCipherStore} from './companion-peer-action-cipher-store.mjs';
const fail=code=>Object.assign(Error(code),{code});
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(value),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
/** Limits total in-flight memory to eight 512 KiB uploads; persistent quota is
 * shared across every grant in one receiver epoch. */
export function createPeerActionIngress({db,atomic,assertCurrent,dispatch,idleMs=60000}){
 if(!db||typeof assertCurrent!=='function'||typeof dispatch!=='function'||!Number.isSafeInteger(idleMs)||idleMs<1||idleMs>60000)throw fail('action-ingress-invalid');
 let closed=false;const uploads=new Map();
 function leave(peer){const entry=uploads.get(peer);if(entry){clearTimeout(entry.timer);entry.upload.close();uploads.delete(peer);}}
 function touch(peer,entry){clearTimeout(entry.timer);entry.timer=setTimeout(()=>{if(uploads.get(peer)===entry)leave(peer);},idleMs);}
 async function check(peer,grant,signal){if(closed||signal.aborted||await assertCurrent(peer,grant.grantId)!==true||closed||signal.aborted)throw fail('action-session-invalid');}
 function scopeOf(g){return {account:g.account,workspace:g.workspace,receiverId:g.receiverId,ledgerEpoch:g.ledgerEpoch,grantId:g.grantId};}
 function identityOf(g,operationId){return {schema:2,mode:'p2p',accountId:g.account,workspaceId:g.workspace,vaultId:g.sourceVaultId,receiverId:g.receiverId,ledgerEpoch:g.ledgerEpoch,operationId};}
 function stagingFor(grant,peer,getSignal){const scope=scopeOf(grant),guard=async()=>check(peer,grant,getSignal());if(atomic)return {reserve:(identity,key,manifest)=>atomic.reserve(grant.grantId,identity,key,manifest,guard),chunk:(identity,key,index,value)=>atomic.chunk(grant.grantId,identity,key,index,value,guard),verify:(identity,key)=>atomic.verify(grant.grantId,identity,key,guard),store:(identity,key)=>atomic.store(grant.grantId,identity,key,guard),release:(identity,key,confirmed)=>atomic.release(grant.grantId,identity,key,confirmed,guard)};return createActionStaging({db,scope,store:identity=>createPeerActionCipherStore({db,scope,identity}),admit:guard});}
 async function execute({grant,peerId,method,body,signal}){
  await check(peerId,grant,signal);
  if(method==='begin'){
   if(!exact(body,['operationId','key','name','size','sha256'])||!token(body.operationId)||!hex(body.key)||uploads.has(peerId)||uploads.size>=8)throw fail('action-upload-invalid');
   const identity=identityOf(grant,body.operationId),ref={signal},staging=stagingFor(grant,peerId,()=>ref.signal),key=body.key;
   const upload=createBoundedActionUpload({finish:async(name,value)=>{await check(peerId,grant,ref.signal);if(name==='manifest.json')await staging.reserve(identity,key,value);else await staging.chunk(identity,key,Number(name.slice(6,-5)),value);await check(peerId,grant,ref.signal);}});
   upload.begin(body.name,body.size,body.sha256);const entry={upload,ref,grantId:grant.grantId,timer:null};uploads.set(peerId,entry);touch(peerId,entry);return {accepted:true};
  }
  if(method==='append'){
   if(!exact(body,['offset','data']))throw fail('action-upload-invalid');const entry=uploads.get(peerId);if(!entry||entry.grantId!==grant.grantId)throw fail('action-upload-invalid');entry.ref.signal=signal;entry.upload.append(body.offset,body.data);touch(peerId,entry);return {accepted:true};
  }
  if(method==='complete'){
   if(!exact(body,[]))throw fail('action-upload-invalid');const entry=uploads.get(peerId);if(!entry||entry.grantId!==grant.grantId)throw fail('action-upload-invalid');clearTimeout(entry.timer);entry.ref.signal=signal;try{await entry.upload.complete();await check(peerId,grant,signal);return {stored:true};}finally{if(uploads.get(peerId)===entry)leave(peerId);}
  }
  if(method==='dispatch'||method==='recover'){
   if(!exact(body,['operationId','key'])||!token(body.operationId)||!hex(body.key)||uploads.has(peerId))throw fail('action-ingress-invalid');
   const identity=identityOf(grant,body.operationId),staging=stagingFor(grant,peerId,()=>signal);await staging.verify(identity,body.key);await check(peerId,grant,signal);
   return dispatch({grant,peerId,identity,key:body.key,staging,signal,recoverOnly:method==='recover'});
  }
  throw fail('action-method-invalid');
 }
 return {execute,leave,close(){closed=true;for(const peer of uploads.keys())leave(peer);}};
}
