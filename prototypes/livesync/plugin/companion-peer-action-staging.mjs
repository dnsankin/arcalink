import {actionHash,readActionHeader,ACTION_CHUNK_BYTES} from './companion-action-outbox.mjs';
import {canonicalOwnership} from './companion-ownership-model.mjs';
const fail=code=>Object.assign(Error(code),{code});
const encode=value=>new TextEncoder().encode(value);
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function checkedScope(scope){if(!scope||Object.keys(scope).sort().join(',')!=='account,grantId,ledgerEpoch,receiverId,workspace'||!Object.values(scope).every(token))throw fail('action-staging-invalid');return structuredClone(scope);}
function epochScope(scope){const {grantId,...epoch}=checkedScope(scope);return epoch;}
async function stagingId(scope){return '_local/action-ingress-'+await actionHash(canonicalOwnership(['arcalink-action-staging-v1',epochScope(scope)]));}
/** Called only while issuing a new grant, never during reconnect/recovery. */
export async function initializeActionStaging(db,scope){
 if(!db)throw fail('action-staging-invalid');
 scope=checkedScope(scope);try{await db.put({_id:await stagingId(scope),schema:1,scope:epochScope(scope),entries:{}});}catch(e){if(e.status===409)throw fail('action-staging-already-exists');throw e;}
}
/** Durable bounded ciphertext ingress. store(identity) must provide atomic writeNew and read.
 * Call only after a scoped grant session and current policy have been checked. */
export function createActionStaging({db,scope,store,admit,maxBytes=384*1024*1024,maxOperations=1024}){
 scope=checkedScope(scope);if(!db||typeof store!=='function'||typeof admit!=='function'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>384*1024*1024||!Number.isSafeInteger(maxOperations)||maxOperations<1||maxOperations>1024)throw fail('action-staging-invalid');
 const idPromise=stagingId(scope);
 function matching(identity){return identity?.accountId===scope.account&&identity?.workspaceId===scope.workspace&&identity?.receiverId===scope.receiverId&&identity?.ledgerEpoch===scope.ledgerEpoch;}
 async function read(){const id=await idPromise;let journal;try{journal=await db.get(id);}catch(e){if(e.status===404)throw fail('action-staging-missing');throw e;}
  if(journal._id!==id||journal.schema!==1||canonicalOwnership(journal.scope)!==canonicalOwnership(epochScope(scope))||!journal.entries||typeof journal.entries!=='object'||Array.isArray(journal.entries)||Object.keys(journal.entries).length>1024)throw fail('action-staging-invalid');
  for(const [key,e] of Object.entries(journal.entries)){if(!hash(key)||!e||Object.keys(e).sort().join(',')!=='chunks,grantId,keyHash,manifestBytes,manifestHash,operationId,reserved'||!token(e.grantId)||!token(e.operationId)||await actionHash(canonicalOwnership([e.grantId,e.operationId]))!==key||!hash(e.manifestHash)||!hash(e.keyHash)||!Number.isSafeInteger(e.manifestBytes)||e.manifestBytes<1||e.manifestBytes>512*1024||!Number.isSafeInteger(e.reserved)||e.reserved<0||!Array.isArray(e.chunks)||e.chunks.length>1024||e.chunks.some((c,i)=>c?.index!==i||!hash(c.hash)||!Number.isSafeInteger(c.bytes)||c.bytes<1||c.bytes>2*ACTION_CHUNK_BYTES)||e.reserved!==e.manifestBytes+e.chunks.reduce((sum,c)=>sum+c.bytes,0))throw fail('action-staging-invalid');}
  return journal;
 }
 async function immutable(target,name,value,identity){let old=await target.read(name);if(old==null){await admit(identity);try{await target.writeNew(name,value);}catch(e){old=await target.read(name);if(old!==value)throw e;}old=await target.read(name);}if(old!==value)throw fail('action-staging-mismatch');await admit(identity);}
 async function reserve(identity,key,manifest){
  if(!identity||identity.schema!==2||!matching(identity)||!token(identity.operationId)||!hash(key)||typeof manifest!=='string'||manifest.length>512*1024||encode(manifest).length>512*1024)throw fail('action-staging-invalid');
  identity=structuredClone(identity);await admit(identity);
  const header=await readActionHeader({read:async name=>name==='manifest.json'?manifest:undefined},identity,key);
  const parsed=JSON.parse(manifest),manifestHash=await actionHash(manifest),keyHash=await actionHash(key),chunks=parsed.chunks.map(c=>({index:c.index,hash:c.hash,bytes:c.bytes}));
  const manifestBytes=encode(manifest).length,reserved=manifestBytes+chunks.reduce((sum,c)=>sum+c.bytes,0),entry={grantId:scope.grantId,operationId:identity.operationId,manifestHash,keyHash,manifestBytes,reserved,chunks},entryKey=await actionHash(canonicalOwnership([scope.grantId,identity.operationId]));
  for(let attempt=0;attempt<20;attempt++){
   await admit(identity);const journal=await read(),old=journal.entries[entryKey];
   if(old){if(canonicalOwnership(old)!==canonicalOwnership(entry))throw fail('action-id-reused');break;}
   const entries=Object.values(journal.entries);if(entries.length>=maxOperations||reserved>maxBytes||entries.reduce((sum,e)=>sum+e.reserved,0)+reserved>maxBytes)throw fail('action-staging-capacity');
   journal.entries[entryKey]=entry;
   await admit(identity);try{await db.put(journal);break;}catch(e){if(e.status!==409||attempt===19)throw e;}
  }
  await admit(identity);await immutable(store(identity),'manifest.json',manifest,identity);return header;
 }
 async function chunk(identity,key,index,value){
  if(!identity||identity.schema!==2||!matching(identity)||!token(identity.operationId)||!hash(key)||!Number.isSafeInteger(index)||index<0||typeof value!=='string'||value.length>512*1024)throw fail('action-staging-invalid');
  identity=structuredClone(identity);await admit(identity);const journal=await read(),entry=journal.entries[await actionHash(canonicalOwnership([scope.grantId,identity.operationId]))],descriptor=entry?.chunks[index];
  if(!descriptor||entry.keyHash!==await actionHash(key)||encode(value).length!==descriptor.bytes||await actionHash(value)!==descriptor.hash)throw fail('action-chunk-invalid');
  const target=store(identity),manifest=await target.read('manifest.json');if(typeof manifest!=='string'||await actionHash(manifest)!==entry.manifestHash)throw fail('action-staging-invalid');
  await readActionHeader(target,identity,key);await admit(identity);await immutable(target,`chunk-${index}.json`,value,identity);
 }
 async function verify(identity,key){
  if(!matching(identity)||identity?.schema!==2||!token(identity.operationId)||!hash(key))throw fail('action-staging-invalid');
  identity=structuredClone(identity);await admit(identity);const entry=(await read()).entries[await actionHash(canonicalOwnership([scope.grantId,identity.operationId]))];
  if(!entry||entry.keyHash!==await actionHash(key))throw fail('action-staging-invalid');
  const target=store(identity),manifest=await target.read('manifest.json');
  if(typeof manifest!=='string'||manifest.length>512*1024||await actionHash(manifest)!==entry.manifestHash)throw fail('action-staging-invalid');
  await readActionHeader(target,identity,key);await admit(identity);return true;
 }
 return {reserve,chunk,verify};
}

/** One bounded in-memory upload per authenticated session. No durable write occurs
 * before the caller checks the completed bytes against its manifest or operation. */
export function createBoundedActionUpload({maxBytes=512*1024,finish}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>512*1024||typeof finish!=='function')throw fail('action-upload-invalid');
 let active=null,closed=false,completing=false;
 function begin(name,size,sha256){
  if(closed||active||completing||typeof name!=='string'||!(/^(?:manifest|chunk-(?:0|[1-9][0-9]{0,3}))\.json$/.test(name))||!Number.isSafeInteger(size)||size<1||size>maxBytes||!hash(sha256))throw fail('action-upload-invalid');
  active={name,size,sha256,parts:[],length:0};
 }
 function append(offset,data){
  if(closed||!active||!Number.isSafeInteger(offset)||offset!==active.length||typeof data!=='string'||data.length<1||data.length>4096||/[^\x20-\x7e]/.test(data)||active.length+data.length>active.size)throw fail('action-upload-invalid');
  active.parts.push(data);active.length+=data.length;
 }
 async function complete(){
  if(closed||!active||active.length!==active.size)throw fail('action-upload-invalid');
  const value=active,contents=value.parts.join('');active=null;completing=true;
  try{if(await actionHash(contents)!==value.sha256||closed)throw fail('action-upload-invalid');await finish(value.name,contents);}finally{completing=false;}
 }
 return {begin,append,complete,close(){closed=true;active=null;}};
}
