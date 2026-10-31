import {checkedShared2Proof,shared2ProofBytes,shared2ProofSignature} from './shared2-proof.mjs';
import {createShared2DeviceKeys,shared2DeviceFingerprint,sealShared2Key,openShared2Key} from './shared2-key-envelope.mjs';
const fail=code=>Object.assign(Error(code),{code}),encode=value=>new TextEncoder().encode(JSON.stringify(value));
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(value);
/** IndexedDB stores nonextractable CryptoKeys through structured cloning. */
export function createShared2IndexedKeyStore(indexed=globalThis.indexedDB){
 if(!indexed)throw fail('shared2-device-key-storage-unavailable');let opening;
 function database(){if(!opening)opening=new Promise((resolve,reject)=>{const request=indexed.open('arcalink-shared2-device-keys',1);request.onupgradeneeded=()=>request.result.createObjectStore('keys');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(fail('shared2-device-key-storage-unavailable'));request.onblocked=()=>reject(fail('shared2-device-key-storage-blocked'));});return opening;}
 async function operation(key,value,insert){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('keys',insert?'readwrite':'readonly'),store=tx.objectStore('keys');let result;const read=store.get(key);read.onsuccess=()=>{result=read.result;if(result===undefined&&insert){result=value;store.add(value,key);}};tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(fail('shared2-device-key-storage-failed'));});}
 return {load:key=>operation(key),insertIfAbsent:(key,value)=>operation(key,value,true),async close(){if(opening)(await opening).close();}};
}
export function createShared2KeyVault({account,device,storage}){
 if(!identity(account)||!identity(device)||typeof storage?.load!=='function'||typeof storage?.insertIfAbsent!=='function')throw fail('shared2-key-vault-adapters-required');
 const deviceId='device:'+account+':'+device;let initializing;
 async function own(){
  if(initializing)return initializing;
  initializing=(async()=>{let row=await storage.load(deviceId);if(!row){const keys=await createShared2DeviceKeys(account,device),wrapping=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);row=await storage.insertIfAbsent(deviceId,{protocol:2,...keys,wrapping});}
   if(row.protocol!==2||row.publicBundle?.account!==account||row.publicBundle?.device!==device||row.wrapping?.extractable!==false||row.signingPrivate?.extractable!==false||row.encryptionPrivate?.extractable!==false||await shared2DeviceFingerprint(row.publicBundle)!==row.publicBundle.fingerprint)throw fail('shared2-device-key-storage-corrupt');return row;})();
  try{return await initializing;}catch(error){initializing=undefined;throw error;}
 }
 function scope(profile){
  if(profile.account!==account||!identity(profile.workspace)||!identity(profile.ownerWorkspace)||!(/^[a-f0-9]{32}$/).test(profile.folder)||!(/^arcalink_s_[a-f0-9]{32}$/).test(profile.database)||!Number.isSafeInteger(profile.generation)||profile.generation<1||!Number.isSafeInteger(profile.keyEpoch)||profile.keyEpoch<1||profile.encrypted!==true)throw fail('shared2-key-vault-scope-mismatch');
  return {account,device,workspace:profile.workspace,ownerWorkspace:profile.ownerWorkspace,folder:profile.folder,database:profile.database,generation:profile.generation,keyEpoch:profile.keyEpoch};
 }
 const id=binding=>'folder:'+JSON.stringify(binding);
 async function decode(row,binding){
  if(row?.protocol!==2||JSON.stringify(row.scope)!==JSON.stringify(binding)||!(row.nonce instanceof Uint8Array)||row.nonce.length!==12||!(row.ciphertext instanceof ArrayBuffer))throw fail('shared2-folder-key-storage-corrupt');
  try{const ownKeys=await own(),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:row.nonce,additionalData:encode(binding),tagLength:128},ownKeys.wrapping,row.ciphertext),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));if(typeof value.passphrase!=='string'||!(/^[a-f0-9]{64}$/).test(value.passphrase)||!Array.isArray(value.salt)||value.salt.length!==32||value.salt.some(n=>!Number.isInteger(n)||n<0||n>255))throw Error();return {...binding,passphrase:value.passphrase,salt:Uint8Array.from(value.salt)};}catch{throw fail('shared2-folder-key-storage-corrupt');}
 }
 async function store(profile,material){
  const binding=scope(profile);if(typeof material?.passphrase!=='string'||!(/^[a-f0-9]{64}$/).test(material.passphrase)||!(material.salt instanceof Uint8Array)||material.salt.length!==32)throw fail('shared2-invalid-folder-key');
  const ownKeys=await own(),nonce=crypto.getRandomValues(new Uint8Array(12)),ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:encode(binding),tagLength:128},ownKeys.wrapping,encode({passphrase:material.passphrase,salt:[...material.salt]}));
  const stored=await storage.insertIfAbsent(id(binding),{protocol:2,scope:binding,nonce,ciphertext}),result=await decode(stored,binding);
  if(result.passphrase!==material.passphrase||result.salt.some((n,i)=>n!==material.salt[i]))throw fail('shared2-folder-key-epoch-collision');return result;
 }
 async function get(profile){const binding=scope(profile),row=await storage.load(id(binding));if(!row)throw fail('shared2-folder-key-unavailable');return decode(row,binding);}
 async function pin(bundle){const fingerprint=await shared2DeviceFingerprint(bundle);if(bundle.fingerprint!==fingerprint)throw fail('shared2-invalid-device-fingerprint');const key='pin:'+account+':'+device+':'+bundle.account+':'+bundle.device,stored=await storage.insertIfAbsent(key,{fingerprint});if(stored.fingerprint!==fingerprint)throw fail('shared2-device-fingerprint-changed');return fingerprint;}
 async function pinned(bundle){const row=await storage.load('pin:'+account+':'+device+':'+bundle.account+':'+bundle.device);if(!row||row.fingerprint!==await shared2DeviceFingerprint(bundle))throw fail('shared2-device-key-not-pinned');return row.fingerprint;}
 return {
  publicIdentity:async()=>structuredClone((await own()).publicBundle),get,store,
  async signMigrationProof(value){const claim=checkedShared2Proof(value);if(claim.owner!==account||claim.device!==device)throw fail('shared2-migration-attestation-scope');const keys=await own(),signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.signingPrivate,shared2ProofBytes(claim));return {claim,fingerprint:keys.publicBundle.fingerprint,signature:shared2ProofSignature(signature)};},
  // Called only after the UI has shown and the user has verified the fingerprint.
  pin,
  async create(profile){try{return await get(profile);}catch(error){if(error.code!=='shared2-folder-key-unavailable')throw error;}try{return await store(profile,{passphrase:[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join(''),salt:crypto.getRandomValues(new Uint8Array(32))});}catch(error){if(error.code==='shared2-folder-key-epoch-collision')return get(profile);throw error;}},
  async seal(profile,context,recipient){
   if(context.senderAccount!==account||context.senderDevice!==device||context.owner!==account||context.recipientAccount!==recipient.account||context.recipientDevice!==recipient.device||['ownerWorkspace','folder','database','generation','keyEpoch'].some(field=>context[field]!==profile[field]))throw fail('shared2-envelope-scope-mismatch');
   const fingerprint=await pinned(recipient),binding=scope(profile),outbox='outbox:'+JSON.stringify({...binding,recipient:recipient.account,recipientDevice:recipient.device,fingerprint});
   const existing=await storage.load(outbox);if(existing)return existing;
   const envelope=await sealShared2Key({context,sender:await own(),recipient,recipientFingerprint:fingerprint,material:await get(profile)});
   return storage.insertIfAbsent(outbox,envelope);
  },
  async receive(profile,context,envelope,sender){const material=await openShared2Key({context,envelope,recipient:await own(),sender,senderFingerprint:await pinned(sender)});for(const field of ['account','ownerWorkspace','folder','database','generation','keyEpoch'])if(material[field]!==profile[field])throw fail('shared2-envelope-scope-mismatch');return store(profile,material);},
 };
}
