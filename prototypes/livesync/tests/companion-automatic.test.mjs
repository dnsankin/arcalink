import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {keyTransferComparison,sealCompanionBootstrap,sealCompanionIdKey} from '../plugin/companion-key-transfer.mjs';
import {automaticRequestProof,verifyAutomaticRequest,automaticEnvelopeProof,BOOTSTRAP_PURPOSE} from '../plugin/companion-automatic.mjs';
import {canonicalOwnership} from '../plugin/companion-ownership-model.mjs';
import {sha256} from '../plugin/companion-proof.mjs';
const secret='synthetic-local-plugin-refresh-token-only';
async function fixture(){
 const keys=await crypto.subtle.generateKey({name:'RSA-OAEP',hash:'SHA-256',modulusLength:3072,publicExponent:new Uint8Array([1,0,1])},true,['encrypt','decrypt']);
 const spki=new Uint8Array(await crypto.subtle.exportKey('spki',keys.publicKey)),localVaultId=randomUUID(),deviceId=randomUUID();
 const request={schema:1,nonce:randomUUID(),generation:randomUUID(),accountId:randomUUID(),workspaceId:'a'.repeat(32),companionDeviceId:deviceId,phase:'prepare',
  keyTransfer:{spki:Buffer.from(spki).toString('base64'),publicKeyFingerprint:await sha256(spki),expiresAt:Date.now()+600000}};
 request.keyTransfer.comparisonCode=(await keyTransferComparison(request)).code;
 request.automatic={schema:1,localVaultId,proof:await automaticRequestProof(request,secret,localVaultId)};
 return {keys,request,localVaultId,session:{deviceId,email:'synthetic@example.test',accessToken:'synthetic-access-token',refreshToken:secret}};
}
async function decrypt(envelope,key){
 const aes=await crypto.subtle.decrypt({name:'RSA-OAEP'},key,Buffer.from(envelope.wrappedKey,'base64'));
 const imported=await crypto.subtle.importKey('raw',aes,{name:'AES-GCM'},false,['decrypt']);
 return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(envelope.iv,'base64'),additionalData:new TextEncoder().encode(canonicalOwnership(envelope.context))},imported,Buffer.from(envelope.ciphertext,'base64'))));
}
test('automatic prepare proves shared session, exact local binding, RSA descriptor and identity',async()=>{
 const f=await fixture();assert.equal(await verifyAutomaticRequest(f.request,f.session,f.localVaultId),true);
 for(const mutation of [r=>r.accountId=randomUUID(),r=>r.workspaceId='b'.repeat(32),r=>r.generation=randomUUID(),r=>r.nonce=randomUUID(),r=>r.companionDeviceId=randomUUID(),r=>r.keyTransfer.expiresAt--,r=>r.automatic.localVaultId=randomUUID(),r=>r.automatic.proof='0'.repeat(64)]){
  const altered=structuredClone(f.request);mutation(altered);await assert.rejects(verifyAutomaticRequest(altered,f.session,f.localVaultId));
 }
 await assert.rejects(verifyAutomaticRequest(f.request,{...f.session,refreshToken:secret+'changed'},f.localVaultId));
 await assert.rejects(verifyAutomaticRequest(f.request,f.session,randomUUID()));
 assert.equal(JSON.stringify(f.request).includes(secret),false);
});
test('local snapshot capability is authenticated and cannot be added or removed from an accepted request',async()=>{
 const f=await fixture();f.request.automatic.localSnapshot=1;
 await assert.rejects(verifyAutomaticRequest(f.request,f.session,f.localVaultId));
 f.request.automatic.proof=await automaticRequestProof(f.request,secret,f.localVaultId);
 assert.equal(await verifyAutomaticRequest(f.request,f.session,f.localVaultId),true);
 delete f.request.automatic.localSnapshot;
 await assert.rejects(verifyAutomaticRequest(f.request,f.session,f.localVaultId));
});
test('expired first request fails, while an already persisted accepted state can finish proof after descriptor expiry',async()=>{
 const f=await fixture();f.request.keyTransfer.expiresAt=Date.now()-1;f.request.automatic.proof=await automaticRequestProof(f.request,secret,f.localVaultId,true);
 await assert.rejects(verifyAutomaticRequest(f.request,f.session,f.localVaultId));
 assert.equal(await verifyAutomaticRequest(f.request,f.session,f.localVaultId,true),true);
});
test('plain and E2EE settings use authenticated, domain-separated ciphertext without exporting account tokens',async()=>{
 const f=await fixture();
 for(const settings of [{encrypt:false,passphrase:'',idDerivationVersion:0},{encrypt:true,passphrase:'Секретная фраза 🔒',idDerivationVersion:1,idDerivationKey:'b'.repeat(64)}]){
  const envelope=await sealCompanionBootstrap(f.request,settings);envelope.proof=await automaticEnvelopeProof(envelope,secret);
  assert.equal(envelope.context.purpose,BOOTSTRAP_PURPOSE);assert.equal(JSON.stringify(envelope).includes(secret),false);
  if(settings.passphrase)assert.equal(JSON.stringify(envelope).includes(settings.passphrase),false);
  const decoded=await decrypt(envelope,f.keys.privateKey);for(const [key,value]of Object.entries(settings))assert.equal(decoded[key],value);
  assert.equal(await automaticEnvelopeProof(envelope,secret),envelope.proof);
  const altered={...envelope,ciphertext:envelope.ciphertext.slice(0,-4)+'AAAA'};assert.notEqual(await automaticEnvelopeProof(altered,secret),envelope.proof);
  await assert.rejects(decrypt({...envelope,context:{...envelope.context,purpose:'wrong'}},f.keys.privateKey));
 }
 await assert.rejects(automaticEnvelopeProof(await sealCompanionIdKey(f.request,'a'.repeat(64)),secret));
});
