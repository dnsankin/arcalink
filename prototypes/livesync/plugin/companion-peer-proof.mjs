import {safeCompanionPath,sha256} from './companion-proof.mjs';
export const COMPANION_READBACK_V2='arcalinkCompanionReadbackV2';
const revision=value=>typeof value==='string'&&/^[1-9][0-9]*-[a-zA-Z0-9]+$/.test(value);
export function validPeerProofV2(input){return !!input&&input.schema===2&&typeof input.nonce==='string'&&/^[a-zA-Z0-9-]{16,100}$/.test(input.nonce)&&Array.isArray(input.files)&&input.files.length>0&&input.files.length<=2&&new Set(input.files.map(f=>f.path)).size===input.files.length&&input.files.every(file=>file&&safeCompanionPath(file.path)&&revision(file.revision)&&typeof file.deleted==='boolean'&&Number.isSafeInteger(file.size)&&file.size>=0&&file.size<=256*1024*1024&&(file.deleted?file.size===0&&file.sha256===null:typeof file.sha256==='string'&&/^[a-f0-9]{64}$/.test(file.sha256)));}
/** PouchDB hides a winning physical tombstone from ordinary get(); keys keeps its authoritative revision. */
export async function winningPeerMetadata(database,id){
 try{return await database.get(id,{conflicts:true,deleted_conflicts:true});}catch(error){
  if(error.status!==404)throw error;
  const row=(await database.allDocs({keys:[id]})).rows[0];
  if(!row?.value?.deleted||typeof row.value.rev!=='string')return null;
  return await database.get(id,{rev:row.value.rev,conflicts:true,deleted_conflicts:true});
 }
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
/** Live bytes or actual absence, bracketed by the same winning DB revision and peer admission.
 * @param {any} input
 * @param {{getMetadata:(path:string)=>Promise<any>,readBytes:(path:string)=>Promise<ArrayBuffer|null>,readProvenance?:(path:string)=>Promise<string|undefined>,isCurrent?:()=>boolean,isAccepted?:()=>Promise<boolean>,isTarget?:(path:string)=>Promise<boolean>}} options
 */
export async function peerProofV2(input,{getMetadata,readBytes,readProvenance,isCurrent=()=>true,isAccepted=async()=>true,isTarget=async()=>true}){
 const denied={schema:2,applied:false};
 if(!validPeerProofV2(input))return denied;
 for(const file of input.files){
  if(!isCurrent()||!await isAccepted()||!await isTarget(file.path))return denied;
  const before=await getMetadata(file.path);
  if(!before||before._rev!==file.revision||before._conflicts?.length||Boolean(before.deleted||before._deleted)!==file.deleted)return denied;
  const bytes=await readBytes(file.path);
  if(file.deleted){if(bytes!==null)return denied;}
  else {if(bytes===null||bytes.byteLength!==file.size||await sha256(bytes)!==file.sha256)return denied;if(readProvenance&&await readProvenance(file.path)!==file.revision)return denied;}
  const after=await getMetadata(file.path);
  if(!isCurrent()||!await isAccepted()||!after||after._rev!==file.revision||after._conflicts?.length||Boolean(after.deleted||after._deleted)!==file.deleted)return denied;
 }
 return {schema:2,nonce:input.nonce,files:input.files,applied:true};
}
export function peerProofV2Matches(reply,input){return validPeerProofV2(input)&&reply?.schema===2&&reply.nonce===input.nonce&&reply.applied===true&&same(reply.files,input.files);}
