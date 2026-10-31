import {getConfiguredFunctionsForEncryption} from '@arcalink/shared2-engine-encryption';
import {E2EEAlgorithms} from '@vrtmrz/livesync-commonlib/compat/common/types';
const fail=code=>Object.assign(Error(code),{code});
const scopes=['account','workspace','folder','database','generation','keyEpoch'];
/** Folder-scoped material from a device key vault, never from the server catalog.
 * Uses the pinned engine's V2 AES-GCM/HKDF transform, with per-instance closures.
 */
export async function resolveShared2Key(profile,provider){
 if(!profile.encrypted||!Number.isSafeInteger(profile.keyEpoch)||profile.keyEpoch<1||typeof provider!=='function')throw fail('shared2-encrypted-engine-not-ready');
 const value=await provider(Object.freeze({...profile}));
 if(!value||scopes.some(key=>value[key]!==profile[key])||typeof value.passphrase!=='string'||!(/^[a-f0-9]{64}$/).test(value.passphrase)||!(value.salt instanceof Uint8Array)||value.salt.length!==32)throw fail('shared2-key-scope-mismatch');
 return {passphrase:value.passphrase,salt:value.salt.slice()};
}
export async function configureShared2Encryption(database,profile,provider){
 if(!profile.encrypted)throw fail('shared2-encryption-profile-required');
 if(typeof database?.transform!=='function')throw fail('shared2-encryption-transform-required');
 const key=await resolveShared2Key(profile,provider);
 const transforms=getConfiguredFunctionsForEncryption(key.passphrase,false,false,async()=>key.salt.slice(),E2EEAlgorithms.V2,true);
 const decrypted=new WeakSet();
 database.transform({
  async incoming(doc){
   const encrypted=await transforms.incoming(doc);
   if(doc.type==='leaf'&&encrypted.e_!==true)throw fail('shared2-plaintext-chunk-rejected');
   if(['plain','newnote'].includes(doc.type)&&!(typeof encrypted.path==='string'&&encrypted.path.startsWith('/\\:')))throw fail('shared2-plaintext-metadata-rejected');
   return encrypted;
  },
  async outgoing(doc){
   if(decrypted.has(doc))return doc;
   if(['plain','newnote'].includes(doc.type)&&!(typeof doc.path==='string'&&doc.path.startsWith('/\\:')))throw fail('shared2-plaintext-metadata-rejected');
   if(doc.type==='leaf'&&(doc.e_!==true||typeof doc.data!=='string'||!doc.data.startsWith('%=')))throw fail('shared2-plaintext-chunk-rejected');
   try{const result=await transforms.outgoing(doc);decrypted.add(result);return result;}catch{throw fail('shared2-key-decryption-rejected');}
  },
 });
}
