import {canonicalOwnership,ownershipIdentity,validOwnershipIdentity} from './companion-ownership-model.mjs';
import {sha256} from './companion-proof.mjs';
const fail=()=>Object.assign(Error('Не удалось безопасно подключить ключ Компаньона. Сверьте код и повторите подключение.'),{code:'ownership-key-transfer-invalid'});
const encode=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode=value=>{
 if(typeof value!=='string'||value.length>2048||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw fail();
 return Uint8Array.from(atob(value),char=>char.charCodeAt(0));
};
export async function keyTransferComparison(request,now=Date.now()) {
 if(!validOwnershipIdentity(request))throw fail();
 const value=request.keyTransfer;
 if(!value||Object.keys(value).some(key=>!['spki','publicKeyFingerprint','expiresAt','comparisonCode'].includes(key))
  ||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+10*60*1000)throw fail();
 const spki=decode(value.spki),fingerprint=await sha256(spki);
 if(fingerprint!==value.publicKeyFingerprint)throw fail();
 let publicKey;
 try{publicKey=await crypto.subtle.importKey('spki',spki,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);}catch{throw fail();}
 if(publicKey.algorithm.modulusLength!==3072)throw fail();
 const prefix=new TextEncoder().encode('arcalink-companion-pair-v1\0'),nonce=new TextEncoder().encode(request.nonce);
 const input=new Uint8Array(prefix.length+spki.length+nonce.length);input.set(prefix);input.set(spki,prefix.length);input.set(nonce,prefix.length+spki.length);
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',input)),alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let code='',bits=0,buffer=0;
 for(const value of bytes){buffer=(buffer<<8)|value;bits+=8;while(bits>=5&&code.length<12){bits-=5;code+=alphabet[(buffer>>>bits)&31];}if(code.length===12)break;}
 if(value.comparisonCode!==undefined&&value.comparisonCode!==code)throw fail();
 return {code,publicKey,fingerprint,expiresAt:value.expiresAt};
}
/** Ciphertext is the only key-transfer material written into the vault mailbox. */
export async function sealCompanionIdKey(request,idDerivationKey,now=Date.now()) {
 if(typeof idDerivationKey!=='string'||!/^[a-f0-9]{64}$/.test(idDerivationKey))throw fail();
 const approved=await keyTransferComparison(request,now),context={...ownershipIdentity(request),publicKeyFingerprint:approved.fingerprint,expiresAt:approved.expiresAt};
 const payload={idDerivationVersion:1,idDerivationKey,idDerivationKeyFingerprint:await sha256(new TextEncoder().encode(idDerivationKey))};
 const plaintext=new TextEncoder().encode(canonicalOwnership(payload)),iv=crypto.getRandomValues(new Uint8Array(12));
 const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']),raw=new Uint8Array(await crypto.subtle.exportKey('raw',key));
 try{
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(canonicalOwnership(context)),tagLength:128},key,plaintext);
  const wrappedKey=await crypto.subtle.encrypt({name:'RSA-OAEP'},approved.publicKey,raw);
  return {schema:1,context,wrappedKey:encode(wrappedKey),iv:encode(iv),ciphertext:encode(ciphertext)};
 }finally{plaintext.fill(0);raw.fill(0);}
}
