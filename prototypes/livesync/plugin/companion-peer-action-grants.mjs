import {actionHash} from './companion-action-outbox.mjs';
import {canonicalOwnership} from './companion-ownership-model.mjs';
const fail=code=>Object.assign(Error(code),{code});
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(value);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const grantFields=['account','workspace','sourceVaultId','sourceDeviceId','receiverId','ledgerEpoch','grantId','secret','sourcePeerName','formatProof'];
async function registryId(identity){return '_local/action-grants-'+await actionHash(canonicalOwnership(['arcalink-action-grants-v1',identity]));}
/** Only a freshly created epoch may initialize this registry. */
export async function initializeActionGrantRegistry({db,account,workspace,receiverId,ledgerEpoch}){
 const identity={account,workspace,receiverId,ledgerEpoch};if(!db||!Object.values(identity).every(token))throw fail('action-grant-invalid');
 try{await db.put({_id:await registryId(identity),schema:1,...identity,entries:{}});}catch(e){if(e.status===409)throw fail('action-grant-already-exists');throw e;}
}
function checked(value,identity){
 if(!value||Object.keys(value).sort().join(',')!==[...grantFields].sort().join(',')||!grantFields.slice(0,7).every(key=>token(value[key]))||!hex(value.secret)||!hex(value.formatProof)||typeof value.sourcePeerName!=='string'||!value.sourcePeerName||value.sourcePeerName.length>256||/[\x00-\x1f\x7f]/.test(value.sourcePeerName)||['account','workspace','receiverId','ledgerEpoch'].some(key=>value[key]!==identity[key]))throw fail('action-grant-invalid');
 return Object.freeze(structuredClone(value));
}
/** A grant delegates create/set-checkbox only; authorize must check current account,
 * workspace, source's durable approval and the local lifecycle on every use. */
export function createActionGrantRegistry({db,account,workspace,receiverId,ledgerEpoch,authorize}){
 const identity={account,workspace,receiverId,ledgerEpoch};
 if(!db||!Object.values(identity).every(token)||typeof authorize!=='function')throw fail('action-grant-invalid');
 const id=registryId(identity);
 async function load(){const key=await id;let journal;try{journal=await db.get(key);}catch(e){if(e.status===404)throw fail('action-grant-journal-missing');throw e;}
  if(journal.schema!==1||Object.keys(journal).some(key=>!['_id','_rev','schema','account','workspace','receiverId','ledgerEpoch','entries'].includes(key))||['account','workspace','receiverId','ledgerEpoch'].some(key=>journal[key]!==identity[key])||!journal.entries||typeof journal.entries!=='object'||Array.isArray(journal.entries)||Object.keys(journal.entries).length>128)throw fail('action-grant-invalid');
  for(const [key,entry] of Object.entries(journal.entries)){if(!hex(key)||!entry||Object.keys(entry).sort().join(',')!=='grant,state'||!['initializing','active','revoked'].includes(entry.state)||await actionHash(entry.grant?.grantId)!==key)throw fail('action-grant-invalid');entry.grant=checked(entry.grant,identity);}
  return journal;
 }
 async function update(fn,beforeWrite=async()=>{}){for(let n=0;n<20;n++){const journal=await load(),result=await fn(journal);if(!result.write)return result.value;await beforeWrite();try{await db.put(journal);return result.value;}catch(e){if(e.status!==409||n===19)throw e;}}}
 async function enroll(input,requestCurrent=async()=>true){
  const grant=checked(input,identity);if(await authorize(grant,'enroll')!==true)throw fail('action-grant-not-admitted');const key=await actionHash(grant.grantId);
  const guard=async()=>{if(await requestCurrent()!==true||await authorize(grant,'enroll')!==true||await requestCurrent()!==true)throw fail('action-grant-not-admitted');};
  const state=await update(async journal=>{await guard();const old=journal.entries[key];if(old){if(canonicalOwnership(old.grant)!==canonicalOwnership(grant)||old.state==='revoked')throw fail('action-grant-reused');return {write:false,value:old.state};}if(Object.keys(journal.entries).length>=128)throw fail('action-grant-capacity');journal.entries[key]={grant,state:'initializing'};return {write:true,value:'initializing'};},guard);
  if(state==='active')return;
  if(await authorize(grant,'enroll')!==true)throw fail('action-grant-not-admitted');
  await update(async journal=>{await guard();const entry=journal.entries[key];if(!entry||canonicalOwnership(entry.grant)!==canonicalOwnership(grant)||entry.state==='revoked')throw fail('action-grant-reused');if(entry.state==='active')return {write:false};entry.state='active';return {write:true};},guard);
 }
 async function get(grantId){if(!token(grantId))throw fail('action-grant-invalid');const key=await actionHash(grantId),entry=(await load()).entries[key];if(!entry||entry.state!=='active'||await authorize(entry.grant,'use')!==true)throw fail('action-grant-not-admitted');const current=(await load()).entries[key];if(!current||current.state!=='active'||canonicalOwnership(current.grant)!==canonicalOwnership(entry.grant)||await authorize(current.grant,'use')!==true)throw fail('action-grant-not-admitted');return structuredClone(entry.grant);}
 async function revoke(grantId){if(!token(grantId))throw fail('action-grant-invalid');const key=await actionHash(grantId);await update(async journal=>{const entry=journal.entries[key];if(!entry||entry.state==='revoked')return {write:false};entry.state='revoked';return {write:true};});}
 return {enroll,get,revoke};
}
