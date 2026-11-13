import {canonicalOwnership} from './companion-ownership-model.mjs';

const fail=code=>Object.assign(Error(code),{code});
const text=value=>new TextEncoder().encode(value);
const hex=value=>Array.from(new Uint8Array(value),b=>b.toString(16).padStart(2,'0')).join('');
const unhex=value=>Uint8Array.from(value.match(/../g),part=>parseInt(part,16));
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(value);
const nonce=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const secretOK=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fields=['account','workspace','sourceVaultId','sourceDeviceId','receiverId','ledgerEpoch','grantId','sourcePeerId','receiverPeerId','sourceNonce','receiverNonce'];
function context(value){
 if(!value||Object.keys(value).sort().join(',')!==[...fields].sort().join(',')||!fields.slice(0,9).every(key=>token(value[key]))||!nonce(value.sourceNonce)||!nonce(value.receiverNonce))throw fail('action-session-invalid');
 return Object.fromEntries(fields.map(key=>[key,value[key]]));
}
async function mac(secret,purpose,value){
 if(!secretOK(secret))throw fail('action-session-invalid');
 const raw=unhex(secret);try{const key=await crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',key,text(purpose+'\0'+canonicalOwnership(value))));}finally{raw.fill(0);}
}
function equal(a,b){if(!nonce(a)||!nonce(b))return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
/** Both challenges and every subsequent frame bind the grant and actual peers. */
export async function actionSessionProof(secret,role,binding){
 if(!['source','receiver'].includes(role))throw fail('action-session-invalid');
 return mac(secret,'arcalink-action-handshake-v1/'+role,context(binding));
}
export async function verifyActionSessionProof(secret,role,binding,proof){return equal(proof,await actionSessionProof(secret,role,binding));}
export async function actionGrantFormatProof(secret,settings){
 if(!settings||typeof settings!=='object')throw fail('action-session-invalid');
 const value={encrypt:!!settings.encrypt,passphrase:settings.encrypt||settings.usePathObfuscation?String(settings.passphrase||''):'',usePathObfuscation:!!settings.usePathObfuscation,idDerivationVersion:settings.idDerivationVersion??0,idDerivationKey:String(settings.idDerivationKey||''),handleFilenameCaseSensitive:!!settings.handleFilenameCaseSensitive,hashAlg:String(settings.hashAlg||'')};
 return mac(secret,'arcalink-action-format-v1',value);
}
export async function actionGrantProof(secret,grant){return mac(secret,'arcalink-action-grant-v1',grant);}
export async function actionFrameReference(frame){
 if(!frame||!Number.isSafeInteger(frame.sequence)||typeof frame.method!=='string'||!Object.hasOwn(frame,'body')||!Object.hasOwn(frame,'reference'))throw fail('action-frame-invalid');
 return hex(await crypto.subtle.digest('SHA-256',text(canonicalOwnership({sequence:frame.sequence,method:frame.method,body:frame.body,reference:frame.reference}))));
}
/** Single-direction counters reject replays; reconnect after a lost frame. */
export function createActionSession(secret,binding,role){
 binding=context(binding);
 if(!secretOK(secret)||!['source','receiver'].includes(role))throw fail('action-session-invalid');
 let outgoing=0,incoming=0,closed=false,verifying=false,signing=false;
 const outgoingRole=role,incomingRole=role==='source'?'receiver':'source';
 async function sign(method,body,reference=null){
  if(closed||signing||typeof method!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(method)||reference!==null&&!nonce(reference))throw fail('action-session-invalid');
  signing=true;
  try{const frame=structuredClone({sequence:outgoing+1,method,body,reference});
   if(text(canonicalOwnership(frame)).length>8192)throw fail('action-frame-limit');
   outgoing=frame.sequence;
   const proof=await mac(secret,'arcalink-action-frame-v1/'+outgoingRole,{binding,frame});
   if(closed)throw fail('action-session-invalid');return {...frame,proof};
  }finally{signing=false;}
 }
 async function verify(value){
  if(closed||verifying||!value||Object.keys(value).sort().join(',')!=='body,method,proof,reference,sequence'||value.reference!==null&&!nonce(value.reference)||!Number.isSafeInteger(value.sequence)||value.sequence!==incoming+1||typeof value.method!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(value.method))throw fail('action-frame-invalid');
  verifying=true;
  try{
   const frame=structuredClone({sequence:value.sequence,method:value.method,body:value.body,reference:value.reference}),proof=value.proof;
   if(text(canonicalOwnership(frame)).length>8192||!equal(proof,await mac(secret,'arcalink-action-frame-v1/'+incomingRole,{binding,frame}))||closed)throw fail('action-frame-invalid');
   incoming=frame.sequence;return frame;
  }finally{verifying=false;}
 }
 return {sign,verify,close(){closed=true;}};
}
