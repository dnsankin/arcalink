import {encryptString,decryptString} from '@vrtmrz/livesync-commonlib/compat/encryption/stringEncryption';
const actionHash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value)),byte=>byte.toString(16).padStart(2,'0')).join('');
import {ACTION_REVISION_PREFIX,isActionRevision} from './companion-action-revision.mjs';
const fail=code=>Object.assign(Error(code),{code});
const token=/^[A-Za-z0-9_-]{8,128}$/,hash=/^[a-f0-9]{64}$/;
const fields=['account','workspace','receiverId','ledgerEpoch','operationId','intent'];
export function checkedActionBinding(binding){if(!binding||fields.some(k=>typeof binding[k]!=='string'||!(k==='intent'?hash:token).test(binding[k])))throw fail('action-integrity-binding-invalid');return Object.fromEntries(fields.map(k=>[k,binding[k]]));}
function generation(doc){const value=Number(String(doc?._rev??'').split('-')[0]);if(!Number.isSafeInteger(value)||value<1)throw fail('action-integrity-invalid');return value;}
function checkedDoc(doc){if(!doc||typeof doc._id!=='string'||!doc._id||typeof doc.path!=='string'||!doc.path||!Number.isFinite(doc.ctime)||doc.ctime<0||doc.ctime>Number.MAX_SAFE_INTEGER||!Number.isFinite(doc.mtime)||doc.mtime<0||doc.mtime>Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(doc.size)||doc.size<0||doc.size>256*1024*1024||doc._deleted||doc.deleted)throw fail('action-integrity-invalid');}
export async function createActionIntegrity(settings,doc,bytes,binding){
 checkedDoc(doc);const identity=checkedActionBinding(binding);if(!(bytes instanceof Uint8Array)||bytes.length!==doc.size)throw fail('action-integrity-invalid');
 const value={purpose:'arcalink-peer-action',schema:1,...identity,nonce:crypto.randomUUID(),documentId:doc._id,path:doc.path,generation:generation(doc),ctime:doc.ctime,mtime:doc.mtime,size:doc.size,sha256:await actionHash(bytes)};
 const json=JSON.stringify(value);if(settings.encrypt){if(typeof settings.passphrase!=='string'||!settings.passphrase)throw fail('action-integrity-key-required');return 'sealed:'+await encryptString(json,settings.passphrase);}return 'plain:'+json;
}
export async function actionIntegrityRevision(envelope,generationValue){if(typeof envelope!=='string'||envelope.length>16384||!Number.isSafeInteger(generationValue)||generationValue<1)throw fail('action-integrity-invalid');return generationValue+'-'+ACTION_REVISION_PREFIX+await actionHash(envelope);}
export async function openActionIntegrity(settings,doc,binding){
 checkedDoc(doc);const envelope=doc.arcalinkActionIntegrity;if(typeof envelope!=='string'||envelope.length>16384||!isActionRevision(doc._rev)||await actionIntegrityRevision(envelope,generation(doc))!==doc._rev)throw fail('action-integrity-invalid');
 let text;if(settings.encrypt){if(typeof settings.passphrase!=='string'||!settings.passphrase||!envelope.startsWith('sealed:%$'))throw fail('action-integrity-key-required');try{text=await decryptString(envelope.slice(7),settings.passphrase);}catch{throw fail('action-integrity-invalid');}}else{if(!envelope.startsWith('plain:'))throw fail('action-integrity-invalid');text=envelope.slice(6);}
 let value;try{value=JSON.parse(text);}catch{throw fail('action-integrity-invalid');}
 if(!value||Object.keys(value).sort().join(',')!=='account,ctime,documentId,generation,intent,ledgerEpoch,mtime,nonce,operationId,path,purpose,receiverId,schema,sha256,size,workspace'||value.purpose!=='arcalink-peer-action'||value.schema!==1||typeof value.nonce!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.nonce)||value.documentId!==doc._id||value.path!==doc.path||value.generation!==generation(doc)||value.ctime!==doc.ctime||value.mtime!==doc.mtime||value.size!==doc.size||typeof value.sha256!=='string'||!hash.test(value.sha256))throw fail('action-integrity-invalid');
 const identity=checkedActionBinding(value);if(binding&&fields.some(k=>identity[k]!==checkedActionBinding(binding)[k]))throw fail('action-integrity-binding-invalid');
 return value;
}
export async function verifyActionIntegrity(settings,doc,bytes,binding){const value=await openActionIntegrity(settings,doc,binding);if(!(bytes instanceof Uint8Array)||bytes.length!==value.size||await actionHash(bytes)!==value.sha256)throw fail('action-integrity-invalid');return true;
}
/** Preserve the verified UTF-8 bytes, including an initial BOM, for the text API. */
export function actionTextFromBytes(buffer){
 if(!(buffer instanceof ArrayBuffer))throw fail('action-integrity-invalid');
 const input=new Uint8Array(buffer);let text;
 try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}catch{throw fail('action-integrity-invalid');}
 const roundtrip=new TextEncoder().encode(text);
 if(roundtrip.length!==input.length||roundtrip.some((byte,index)=>byte!==input[index]))throw fail('action-integrity-invalid');
 return text;
}
