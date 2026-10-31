/** WebCrypto device envelopes. Folder content uses the established LiveSync
 * cipher; this module only transports its random key to a pinned device key.
 * Both fingerprints must be independently pinned by the calling device UI.
 */
const fail=code=>Object.assign(Error(code),{code}),encode=value=>new TextEncoder().encode(JSON.stringify(value));
const fields=['ownerWorkspace','owner','senderAccount','senderDevice','recipientAccount','recipientDevice','folder','database','generation','keyEpoch'];
const b64=bytes=>{let text='';for(const value of new Uint8Array(bytes))text+=String.fromCharCode(value);return btoa(text).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};
const decode=(value,max=16384)=>{if(typeof value!=='string'||!(/^[A-Za-z0-9_-]*$/).test(value)||value.length>max)throw fail('shared2-invalid-key-envelope');try{const bytes=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));if(b64(bytes)!==value)throw Error();return bytes;}catch{throw fail('shared2-invalid-key-envelope');}};
function scope(value){
 const result={};for(const field of fields)result[field]=value?.[field];
 if(!['ownerWorkspace','owner','senderAccount','senderDevice','recipientAccount','recipientDevice'].every(field=>typeof result[field]==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(result[field]))||!(/^[a-f0-9]{32}$/).test(result.folder)||!(/^arcalink_s_[a-f0-9]{32}$/).test(result.database)||!Number.isSafeInteger(result.generation)||result.generation<1||!Number.isSafeInteger(result.keyEpoch)||result.keyEpoch<1||result.senderAccount!==result.owner)throw fail('shared2-invalid-envelope-scope');
 return result;
}
function jwk(value){
 if(!value||value.kty!=='EC'||value.crv!=='P-256'||decode(value.x,43).length!==32||decode(value.y,43).length!==32||'d' in value)throw fail('shared2-invalid-device-public-key');
 return {kty:'EC',crv:'P-256',x:value.x,y:value.y};
}
export async function shared2DeviceFingerprint(bundle){
 const canonical={account:bundle.account,device:bundle.device,signing:jwk(bundle.signing),encryption:jwk(bundle.encryption)};
 if(![canonical.account,canonical.device].every(value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(value)))throw fail('shared2-invalid-device-identity');
 return b64(await crypto.subtle.digest('SHA-256',encode(canonical)));
}
export async function createShared2DeviceKeys(account,device){
 const signing=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
 const encryption=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
 const publicBundle={account,device,signing:jwk(await crypto.subtle.exportKey('jwk',signing.publicKey)),encryption:jwk(await crypto.subtle.exportKey('jwk',encryption.publicKey))};
 return {publicBundle:{...publicBundle,fingerprint:await shared2DeviceFingerprint(publicBundle)},signingPrivate:signing.privateKey,encryptionPrivate:encryption.privateKey};
}
async function pinned(bundle,expected){if(typeof expected!=='string'||await shared2DeviceFingerprint(bundle)!==expected||bundle.fingerprint!==expected)throw fail('shared2-device-key-not-pinned');}
async function derive(privateKey,publicJwk,salt,context){
 const publicKey=await crypto.subtle.importKey('jwk',jwk(publicJwk),{name:'ECDH',namedCurve:'P-256'},false,[]);
 const bits=await crypto.subtle.deriveBits({name:'ECDH',public:publicKey},privateKey,256),base=await crypto.subtle.importKey('raw',bits,'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:encode({purpose:'arcalink-shared2-envelope-v1',...context})},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
function body(envelope){if(envelope?.protocol!==2)throw fail('shared2-invalid-key-envelope');return {protocol:2,...scope(envelope),senderFingerprint:envelope.senderFingerprint,recipientFingerprint:envelope.recipientFingerprint,ephemeral:jwk(envelope.ephemeral),salt:envelope.salt,nonce:envelope.nonce,ciphertext:envelope.ciphertext};}
export async function sealShared2Key({context,sender,recipient,recipientFingerprint,material}){
 const binding=scope(context);await pinned(recipient,recipientFingerprint);
 if(sender.publicBundle.account!==binding.senderAccount||sender.publicBundle.device!==binding.senderDevice||recipient.account!==binding.recipientAccount||recipient.device!==binding.recipientDevice)throw fail('shared2-envelope-device-mismatch');
 if(typeof material?.passphrase!=='string'||!(/^[a-f0-9]{64}$/).test(material.passphrase)||!(material.salt instanceof Uint8Array)||material.salt.length!==32)throw fail('shared2-invalid-folder-key');
 const ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']),salt=crypto.getRandomValues(new Uint8Array(32)),nonce=crypto.getRandomValues(new Uint8Array(12));
 const publicKey=jwk(await crypto.subtle.exportKey('jwk',ephemeral.publicKey)),senderFingerprint=await shared2DeviceFingerprint(sender.publicBundle);
 const aad={protocol:2,...binding,senderFingerprint,recipientFingerprint,ephemeral:publicKey,salt:b64(salt),nonce:b64(nonce)};
 const key=await derive(ephemeral.privateKey,recipient.encryption,salt,aad);
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:encode(aad),tagLength:128},key,encode({passphrase:material.passphrase,salt:b64(material.salt)}));
 const envelope={...aad,ciphertext:b64(ciphertext)};
 return {...envelope,signature:b64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},sender.signingPrivate,encode(envelope)))};
}
export async function openShared2Key({envelope,context,recipient,sender,senderFingerprint}){
 const binding=scope(context),encoded=body(envelope);await pinned(sender,senderFingerprint);
 if(fields.some(field=>binding[field]!==encoded[field])||encoded.senderFingerprint!==senderFingerprint||sender.account!==binding.senderAccount||sender.device!==binding.senderDevice||recipient.publicBundle.account!==binding.recipientAccount||recipient.publicBundle.device!==binding.recipientDevice||encoded.recipientFingerprint!==await shared2DeviceFingerprint(recipient.publicBundle))throw fail('shared2-envelope-scope-mismatch');
 const verifyKey=await crypto.subtle.importKey('jwk',jwk(sender.signing),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
 if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},verifyKey,decode(envelope.signature,100),encode(encoded)))throw fail('shared2-envelope-signature-rejected');
 const {ciphertext,...aad}=encoded,salt=decode(encoded.salt,43),nonce=decode(encoded.nonce,16);if(salt.length!==32||nonce.length!==12)throw fail('shared2-invalid-key-envelope');
 try{
  const key=await derive(recipient.encryptionPrivate,encoded.ephemeral,salt,aad),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:encode(aad),tagLength:128},key,decode(ciphertext));
  const material=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain)),folderSalt=decode(material.salt,43);
  if(typeof material.passphrase!=='string'||!(/^[a-f0-9]{64}$/).test(material.passphrase)||folderSalt.length!==32)throw Error();
  return {account:binding.recipientAccount,ownerWorkspace:binding.ownerWorkspace,folder:binding.folder,database:binding.database,generation:binding.generation,keyEpoch:binding.keyEpoch,passphrase:material.passphrase,salt:folderSalt};
 }catch{throw fail('shared2-key-envelope-decryption-rejected');}
}
