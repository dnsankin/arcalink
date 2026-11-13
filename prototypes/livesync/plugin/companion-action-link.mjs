import {canonicalOwnership,ownershipIdentity,validOwnershipIdentity,OWNERSHIP_FORMAT_FIELDS} from './companion-ownership-model.mjs';
import {keyTransferComparison} from './companion-key-transfer.mjs';
import {safeCompanionPath} from './companion-proof.mjs';

export const ACTION_LINK_PURPOSE='arcalink-independent-actions-link-v1';
const fail=()=>Object.assign(Error('action-link-invalid'),{code:'action-link-invalid'});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const bytes=value=>new TextEncoder().encode(value);
const b64=value=>{let text='';for(const item of new Uint8Array(value))text+=String.fromCharCode(item);return btoa(text);};
const hex=value=>Array.from(new Uint8Array(value),item=>item.toString(16).padStart(2,'0')).join('');
async function mac(secret,purpose,value){
 if(typeof secret!=='string'||secret.length<20||secret.length>4096)throw fail();
 const key=await crypto.subtle.importKey('raw',bytes(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return hex(await crypto.subtle.sign('HMAC',key,bytes(purpose+'\0'+canonicalOwnership(value))));
}
export function actionLinkRequestBody(request){
 if(!validOwnershipIdentity(request)||request.phase!=='actions-prepare'||request.independentActions!==1||!uuid(request.localVaultId)||!uuid(request.pluginDeviceId)||request.companionDeviceId===request.pluginDeviceId||typeof request.email!=='string'||request.email.length>254||!request.email.includes('@'))throw fail();
 return {...ownershipIdentity(request),phase:'actions-prepare',independentActions:1,localVaultId:request.localVaultId,
  pluginDeviceId:request.pluginDeviceId,email:request.email,keyTransfer:request.keyTransfer};
}
export async function actionLinkRequestProof(request,secret){return mac(secret,ACTION_LINK_PURPOSE+'/request',actionLinkRequestBody(request));}
export async function actionLinkEnvelopeProof(envelope,secret){
 const {proof,...value}=envelope;
 if(value.context?.purpose!==ACTION_LINK_PURPOSE)throw fail();
 return mac(secret,ACTION_LINK_PURPOSE+'/response',value);
}
export async function validActionLinkProof(actual,expected){
 if(typeof actual!=='string'||typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(actual)||!/^[a-f0-9]{64}$/.test(expected))return false;
 let different=0;for(let i=0;i<64;i++)different|=actual.charCodeAt(i)^expected.charCodeAt(i);return different===0;
}
const FIELDS=[...OWNERSHIP_FORMAT_FIELDS.filter(key=>key!=='idDerivationKeyFingerprint'),'passphrase','idDerivationKey','syncIgnoreRegEx','syncOnlyRegEx'];
export function actionLinkSettings(settings){
 const value=Object.fromEntries(FIELDS.filter(key=>settings[key]!==undefined).map(key=>[key,settings[key]]));
 if(typeof value.encrypt!=='boolean'||typeof value.passphrase!=='string'||value.passphrase.length>4096||(value.encrypt||value.usePathObfuscation)&&!value.passphrase||![0,1].includes(value.idDerivationVersion??0))throw fail();
 if(value.idDerivationVersion===1&&(typeof value.idDerivationKey!=='string'||!/^[a-f0-9]{64}$/.test(value.idDerivationKey)))throw fail();
 if(!value.encrypt&&!value.usePathObfuscation)value.passphrase='';
 if(bytes(canonicalOwnership(value)).length>32768)throw fail();
 // Transport credentials and session tokens are deliberately not part of this
 // list. The Companion provisions access through its independent signed-in session.
 return value;
}
export async function sealActionLink(request,{settings,scope,exchangeFolder,mode,paused,outboxKey,configurationId,peer},secret,now=Date.now()){
 const body=actionLinkRequestBody(request),proof=await actionLinkRequestProof(request,secret);
 if(!await validActionLinkProof(request.proof,proof)||!safeCompanionPath(exchangeFolder)||!['cloud','p2p'].includes(mode)||typeof paused!=='boolean'||typeof outboxKey!=='string'||!/^[a-f0-9]{64}$/.test(outboxKey)||!scope||!Array.isArray(scope.excludedPrefixes)||scope.excludedPrefixes.length>1024||scope.excludedPrefixes.some(path=>typeof path!=='string'||!path||path.length>4096||/[\\:\x00-\x1f\x7f]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..')))throw fail();
 const approved=await keyTransferComparison(request,now);
 const context={...ownershipIdentity(request),purpose:ACTION_LINK_PURPOSE,localVaultId:body.localVaultId,pluginDeviceId:body.pluginDeviceId,
  publicKeyFingerprint:approved.fingerprint,expiresAt:approved.expiresAt};
 const payload={schema:1,localVaultId:body.localVaultId,accountId:body.accountId,workspaceId:body.workspaceId,settings:actionLinkSettings(settings),scope,exchangeFolder,mode,paused,outboxKey};
 if(peer!==undefined){if(mode!=='p2p'||!peer||peer.account!==body.accountId||peer.workspace!==body.workspaceId||peer.sourceVaultId!==body.localVaultId||peer.sourceDeviceId!==body.pluginDeviceId||!['receiverId','ledgerEpoch','grantId'].every(k=>typeof peer[k]==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(peer[k]))||typeof peer.secret!=='string'||!/^[a-f0-9]{64}$/.test(peer.secret))throw fail();payload.peer=structuredClone(peer);}
 if(configurationId!==undefined){if(!uuid(configurationId))throw fail();payload.configurationId=configurationId;}
 const plaintext=bytes(canonicalOwnership(payload));if(plaintext.length>65536)throw fail();
 const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']),raw=new Uint8Array(await crypto.subtle.exportKey('raw',key)),iv=crypto.getRandomValues(new Uint8Array(12));
 try{
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:bytes(canonicalOwnership(context))},key,plaintext);
  const wrappedKey=await crypto.subtle.encrypt({name:'RSA-OAEP'},approved.publicKey,raw);
  const result={schema:1,context,wrappedKey:b64(wrappedKey),iv:b64(iv),ciphertext:b64(ciphertext)};
  return {...result,proof:await actionLinkEnvelopeProof(result,secret)};
 }finally{raw.fill(0);plaintext.fill(0);}
}
