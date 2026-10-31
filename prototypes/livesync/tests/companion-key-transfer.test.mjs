import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {keyTransferComparison,sealCompanionIdKey} from '../plugin/companion-key-transfer.mjs';
import {canonicalOwnership} from '../plugin/companion-ownership-model.mjs';
import {sha256} from '../plugin/companion-proof.mjs';
const encode=bytes=>Buffer.from(bytes).toString('base64');
async function fixture(){
 const keys=await crypto.subtle.generateKey({name:'RSA-OAEP',hash:'SHA-256',modulusLength:3072,publicExponent:new Uint8Array([1,0,1])},true,['encrypt','decrypt']);
 const spki=new Uint8Array(await crypto.subtle.exportKey('spki',keys.publicKey));
 const request={schema:1,nonce:randomUUID(),generation:randomUUID(),accountId:randomUUID(),workspaceId:'a'.repeat(32),companionDeviceId:randomUUID(),
  keyTransfer:{spki:encode(spki),publicKeyFingerprint:await sha256(spki),expiresAt:Date.now()+600000}};
 request.keyTransfer.comparisonCode=(await keyTransferComparison(request)).code;return {keys,request};
}
async function decrypt(envelope,privateKey){
 const aes=await crypto.subtle.decrypt({name:'RSA-OAEP'},privateKey,Buffer.from(envelope.wrappedKey,'base64'));
 const key=await crypto.subtle.importKey('raw',aes,{name:'AES-GCM'},false,['decrypt']);
 return crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(envelope.iv,'base64'),additionalData:new TextEncoder().encode(canonicalOwnership(envelope.context)),tagLength:128},key,Buffer.from(envelope.ciphertext,'base64'));
}
test('standard WebCrypto seals only the ID key with SHA256 OAEP and authenticated identity context',async()=>{
 const {keys,request}=await fixture(),secret='a'.repeat(64),envelope=await sealCompanionIdKey(request,secret);
 assert.equal(JSON.stringify(envelope).includes(secret),false);assert.equal(Buffer.from(envelope.iv,'base64').length,12);assert.equal(Buffer.from(envelope.wrappedKey,'base64').length,384);
 const payload=JSON.parse(new TextDecoder().decode(await decrypt(envelope,keys.privateKey)));
 assert.deepEqual(payload,{idDerivationVersion:1,idDerivationKey:secret,idDerivationKeyFingerprint:await sha256(new TextEncoder().encode(secret))});
 assert.equal((await keyTransferComparison(request)).code,request.keyTransfer.comparisonCode);
 assert.match(request.keyTransfer.comparisonCode,/^[A-Z2-7]{12}$/);
});
test('wrong key, ciphertext or authenticated generation cannot decrypt an enrollment key',async()=>{
 const {keys,request}=await fixture(),other=await fixture(),envelope=await sealCompanionIdKey(request,'b'.repeat(64));
 await assert.rejects(decrypt(envelope,other.keys.privateKey));
 await assert.rejects(decrypt({...envelope,context:{...envelope.context,generation:randomUUID()}},keys.privateKey));
 const corrupted=Buffer.from(envelope.ciphertext,'base64');corrupted[0]^=1;
 await assert.rejects(decrypt({...envelope,ciphertext:corrupted.toString('base64')},keys.privateKey));
});
test('expiry, substituted public key, comparison mismatch and unapproved secret formats fail closed',async()=>{
 const {request}=await fixture();
 await assert.rejects(keyTransferComparison({...request,keyTransfer:{...request.keyTransfer,expiresAt:Date.now()-1}}));
 await assert.rejects(keyTransferComparison({...request,keyTransfer:{...request.keyTransfer,publicKeyFingerprint:'0'.repeat(64)}}));
 await assert.rejects(keyTransferComparison({...request,keyTransfer:{...request.keyTransfer,comparisonCode:'AAAAAAAAAAAA'}}));
 await assert.rejects(sealCompanionIdKey(request,'account-password'));
 const first=await sealCompanionIdKey(request,'c'.repeat(64)),second=await sealCompanionIdKey(request,'c'.repeat(64));
 assert.notEqual(first.iv,second.iv);assert.notEqual(first.ciphertext,second.ciphertext);
});
