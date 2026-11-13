import {actionHash} from './companion-action-outbox.mjs';
import {isActionRevision} from './companion-action-revision.mjs';
/* Local receiving ledger. The host must supply fresh authorization and strict applied proof. */
const token=/^[A-Za-z0-9_-]{8,128}$/, hex=/^[a-f0-9]{64}$/, rev=/^[1-9][0-9]*-[A-Za-z0-9]+$/;
const encode=new TextEncoder();
const canonical=v=>JSON.stringify(sort(v));
function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object'){const r=Object.create(null);for(const k of Object.keys(v).sort())r[k]=sort(v[k]);return r;}return v;}
async function digest(v){const bytes=await globalThis.crypto.subtle.digest('SHA-256',encode.encode(canonical(v)));return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');}
async function checkEnvelope(p){const doc=p.document;if(typeof doc.arcalinkActionIntegrity!=='string'||doc.arcalinkActionIntegrity.length>16384||!isActionRevision(doc._rev)||doc._rev.split('-')[1].slice(16)!==await actionHash(doc.arcalinkActionIntegrity))fail('action-integrity-invalid');}
function fail(code){const error=new Error(code);error.code=code;throw error;}
function ancestry(doc){const h=doc?._revisions;if(!h||!Number.isSafeInteger(h.start)||!Array.isArray(h.ids)||!h.ids.length||h.start<h.ids.length||h.ids.some(x=>typeof x!=='string'||!/^[A-Za-z0-9]+$/.test(x)))fail('action-revision-history-invalid');const a=h.ids.map((id,i)=>`${h.start-i}-${id}`);if(a[0]!==doc._rev)fail('action-revision-history-invalid');return a;}
function validate(input){
 const {account,workspace,operationId,intent,target}=input;
 if(![account,workspace,operationId].every(x=>typeof x==='string'&&token.test(x))||typeof intent!=='string'||!hex.test(intent))fail('action-identity-invalid');
 if(!target||Object.keys(target).sort().join(',')!=='path,resultHash,size'||typeof target.path!=='string'||!target.path||target.path.length>4096||target.path.startsWith('/')||/[\\:\x00-\x1f\x7f]/.test(target.path)||target.path.split('/').some(x=>!x||['.','..','.obsidian','.git','.livesync'].includes(x))||!hex.test(target.resultHash)||!Number.isSafeInteger(target.size)||target.size<0||target.size>256*1024*1024)fail('action-target-invalid');
}
function proposalCheck(value){
 if(!value||Object.keys(value).sort().join(',')!=='baseRevision,chunks,document'||encode.encode(canonical(value)).length>8*1024*1024)fail('action-proposal-invalid');
 const d=value.document;if(!d||typeof d._id!=='string'||!d._id||d._id.length>4096||d._id.startsWith('_')||d._id.startsWith('h:')||!['plain','newnote'].includes(d.type)||d._deleted||d.deleted||['_attachments','_conflicts','_deleted_conflicts'].some(k=>k in d))fail('action-document-invalid');
 const history=ancestry(d),base=value.baseRevision;if(base===null){if(history.length!==1||!d._rev.startsWith('1-'))fail('action-base-invalid');}else if(typeof base!=='string'||!rev.test(base)||history.length<2||history[1]!==base)fail('action-base-invalid');
 const chunks=value.chunks,children=d.children??[],eden=d.eden??{};if(!Array.isArray(chunks)||chunks.length>100000||chunks.some(x=>typeof x!=='string'||!x.startsWith('h:')||x.length>4096)||new Set(chunks).size!==chunks.length||!Array.isArray(children)||children.some(x=>typeof x!=='string')||!eden||typeof eden!=='object'||Array.isArray(eden))fail('action-chunks-invalid');
 if(!(typeof d.path==='string'&&d.path.startsWith('/\\:'))&&canonical([...new Set(children.filter(x=>!(x in eden)))].sort())!==canonical([...chunks].sort()))fail('action-chunks-invalid');
 return JSON.parse(JSON.stringify(value));
}
export async function initializePeerLedger({db,account,workspace,receiverId,ledgerEpoch}){
 if(!db||![account,workspace,receiverId,ledgerEpoch].every(x=>typeof x==='string'&&token.test(x)))fail('action-adapter-invalid');
 const id='_local/companion-actions-'+await digest([account,workspace,receiverId,ledgerEpoch]);
 try{await db.put({_id:id,schema:3,account,workspace,receiverId,ledgerEpoch,entries:{}});}catch(e){if(e.status===409)fail('action-journal-already-exists');throw e;}
}
export function createPeerLedger({db,journalDb=db,receiverId,ledgerEpoch,admit,verifyProposal,proveApplied,onMetadataPresent,requireExisting=false,limits={}}){
 if(!db||!journalDb||typeof journalDb.get!=='function'||typeof journalDb.put!=='function'||typeof receiverId!=='string'||!token.test(receiverId)||typeof ledgerEpoch!=='string'||!token.test(ledgerEpoch)||typeof admit!=='function'||typeof verifyProposal!=='function'||typeof proveApplied!=='function'||onMetadataPresent!==undefined&&typeof onMetadataPresent!=='function')fail('action-adapter-invalid');
 const maxBytes=limits.bytes??(8*1024*1024),maxEntries=limits.entries??4096,retries=limits.retries??20;
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8*1024*1024||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>4096||!Number.isSafeInteger(retries)||retries<1||retries>100)fail('action-limits-invalid');
 // verifyProposal must independently decode and bind document ID, path, content hash and size; return true only after successful verification.
 async function verify(i,p,target){if(await verifyProposal({account:i.account,workspace:i.workspace,operationId:i.operationId,intent:i.intent,target,proposal:p})!==true)fail('action-proposal-unverified');}
 async function ids(i){validate(i);return {journal:'_local/companion-actions-'+await digest([i.account,i.workspace,receiverId,ledgerEpoch]),key:await digest([i.account,i.workspace,i.operationId])};}
 async function read(id,i){let j;try{j=await journalDb.get(id);}catch(e){if(e.status===404){if(requireExisting)fail('action-journal-missing');return {_id:id,schema:3,account:i.account,workspace:i.workspace,receiverId,ledgerEpoch,entries:{}};}throw e;}if(j._id!==id||j.schema!==3||j.account!==i.account||j.workspace!==i.workspace||j.receiverId!==receiverId||j.ledgerEpoch!==ledgerEpoch||!j.entries||typeof j.entries!=='object'||Array.isArray(j.entries)||Object.keys(j.entries).length>4096||encode.encode(canonical(j.entries)).length>8*1024*1024)fail('action-journal-invalid');for(const [key,e] of Object.entries(j.entries)){if(!hex.test(key)||!e||e.account!==i.account||e.workspace!==i.workspace||await digest([e.account,e.workspace,e.operationId])!==key)fail('action-journal-invalid');try{validate(e);if(e.compact){if(e.phase!=='confirmed'||e.proposal!==undefined||Object.keys(e.compact).sort().join(',')!=='documentId,integrity,revision'||typeof e.compact.documentId!=='string'||!e.compact.documentId||e.compact.documentId.length>4096||e.compact.documentId.startsWith('_')||e.compact.documentId.startsWith('h:'))fail('action-journal-invalid');await checkEnvelope({document:{_id:e.compact.documentId,_rev:e.compact.revision,arcalinkActionIntegrity:e.compact.integrity}});}else{proposalCheck(e.proposal);await checkEnvelope(e.proposal);}}catch{fail('action-journal-invalid');}if(!['prepared','metadata-present','conflict','confirmed'].includes(e.phase)||(e.phase==='confirmed')!==!!e.receipt)fail('action-journal-invalid');if(e.receipt){const r=e.receipt,p=r.proof,d=e.compact?{_id:e.compact.documentId,_rev:e.compact.revision}:e.proposal.document;if(Object.keys(r).sort().join(',')!=='documentId,intent,operationId,outcome,proof,revision'||r.operationId!==e.operationId||r.intent!==e.intent||r.documentId!==d._id||r.revision!==d._rev||r.outcome!=='confirmed'||!p||Object.keys(p).sort().join(',')!=='provenance,revision,sha256,size'||p.revision!==d._rev||p.provenance!==d._rev||p.sha256!==e.target.resultHash||p.size!==e.target.size)fail('action-journal-invalid');}}return j;}
 function entry(j,key,i){const e=j.entries[key];if(e&&(e.intent!==i.intent||canonical(e.target)!==canonical(i.target)||e.account!==i.account||e.workspace!==i.workspace||e.operationId!==i.operationId))fail('action-id-reused');return e;}
 async function update(id,i,fn){for(let n=0;n<retries;n++){const j=await read(id,i);const oldCount=Object.keys(j.entries).length;const result=await fn(j);if(!result.write)return result.value;if(Object.keys(j.entries).length>maxEntries||(Object.keys(j.entries).length>oldCount&&encode.encode(canonical(j.entries)).length+32768*Object.values(j.entries).filter(e=>e.phase!=='confirmed').length>maxBytes))fail('action-journal-capacity-exceeded');try{await journalDb.put(j);return result.value;}catch(e){if(e.status!==409)throw e;}}fail('action-journal-busy');}
 async function leaves(id){try{return (await db.get(id,{open_revs:'all',revs:true})).map(x=>{if(!x.ok)fail('action-result-unverified');return x.ok;});}catch(e){if(e.status===404)return [];throw e;}}
 const reply=e=>e?JSON.parse(JSON.stringify({phase:e.phase,proposal:e.proposal??null,receipt:e.receipt??null})):null;
 async function prepare(i){const p=proposalCheck(i.proposal),{journal,key}=await ids(i);await checkEnvelope(p);await admit(i,true);
  return update(journal,i,async j=>{await admit(i,true);let e=entry(j,key,i);if(e){if(!e.compact)await verify(i,e.proposal,e.target);return {write:false,value:reply(e)};}await verify(i,p,i.target);e={account:i.account,workspace:i.workspace,operationId:i.operationId,intent:i.intent,target:JSON.parse(JSON.stringify(i.target)),proposal:p,phase:'prepared'};j.entries[key]=e;return {write:true,value:reply(e)};});}
 async function status(i){const {journal,key}=await ids(i);await admit(i,false);return reply(entry(await read(journal,i),key,i));}
 async function recover(i){
  if(!i||![i.account,i.workspace,i.operationId].every(x=>typeof x==='string'&&token.test(x))||typeof i.intent!=='string'||!hex.test(i.intent))fail('action-identity-invalid');
  const journal='_local/companion-actions-'+await digest([i.account,i.workspace,receiverId,ledgerEpoch]),key=await digest([i.account,i.workspace,i.operationId]),e=(await read(journal,i)).entries[key];
  if(!e)return null;if(e.intent!==i.intent)fail('action-id-reused');await admit(e,false);
  if(!e.receipt||e.phase!=='confirmed')return null;
  return {target:JSON.parse(JSON.stringify(e.target)),...reply(e)};
 }
 async function commit(i){const {journal,key}=await ids(i);await admit(i,true);let e=entry(await read(journal,i),key,i);if(!e)fail('action-not-prepared');if(e.receipt||e.phase==='conflict')return reply(e);const p=e.proposal,d=p.document;let current=await leaves(d._id),history=current.map(ancestry),present=history.some(h=>h.includes(d._rev));
  if(!present){if((p.baseRevision===null&&current.length)||(p.baseRevision!==null&&(current.length!==1||current[0]._rev!==p.baseRevision||current[0]._deleted||current[0].deleted)))return update(journal,i,async j=>{await admit(i,true);const x=entry(j,key,i);if(x.receipt||x.phase==='conflict')return {write:false,value:reply(x)};x.phase='conflict';return {write:true,value:reply(x)};});
   for(const id of p.chunks){const parts=await leaves(id);if(parts.length!==1||parts[0].type!=='leaf'||parts[0]._deleted)fail('action-chunk-unavailable');}
   await verify(i,p,e.target);await admit(i,true);const result=await db.bulkDocs({docs:[d],new_edits:false});if(result.some(x=>x.error))fail('action-write-failed');current=await leaves(d._id);history=current.map(ancestry);if(!history.some(h=>h.includes(d._rev)))fail('action-result-unverified');
  }
  e=await update(journal,i,async j=>{await admit(i,true);const x=entry(j,key,i);if(x.receipt||x.phase==='conflict')return {write:false,value:x};x.phase='metadata-present';return {write:true,value:x};});if(e.receipt||e.phase==='conflict')return reply(e);
  if(current.length!==1||current[0]._rev!==d._rev||current[0]._deleted||current[0].deleted)return reply(e);
  if(onMetadataPresent){await admit(i,true);await onMetadataPresent({account:i.account,workspace:i.workspace,operationId:i.operationId,intent:i.intent,target:e.target,proposal:p,leaf:current[0]});await admit(i,true);current=await leaves(d._id);if(current.length!==1||current[0]._rev!==d._rev||current[0]._deleted||current[0].deleted)return reply(e);}
  const proof=await proveApplied({account:i.account,workspace:i.workspace,operationId:i.operationId,intent:i.intent,target:e.target,proposal:p,leaf:current[0]});
  if(!proof||proof.revision!==d._rev||proof.sha256!==e.target.resultHash||proof.size!==e.target.size||proof.provenance!==d._rev)return reply(e);
  await admit(i,true);current=await leaves(d._id);if(current.length!==1||current[0]._rev!==d._rev||current[0]._deleted||current[0].deleted)return reply(e);
  return update(journal,i,async j=>{await admit(i,true);const x=entry(j,key,i);if(x.receipt||x.phase==='conflict')return {write:false,value:reply(x)};const latest=await leaves(d._id);if(latest.length!==1||latest[0]._rev!==d._rev||latest[0]._deleted||latest[0].deleted)return {write:false,value:reply(x)};x.phase='confirmed';x.receipt={operationId:i.operationId,intent:i.intent,documentId:d._id,revision:d._rev,outcome:'confirmed',proof:{revision:proof.revision,sha256:proof.sha256,size:proof.size,provenance:proof.provenance}};return {write:true,value:reply(x)};});
 }
 async function compact(i){const {journal,key}=await ids(i);await admit(i,false);return update(journal,i,async j=>{await admit(i,false);const e=entry(j,key,i);if(!e||e.phase!=='confirmed'||!e.receipt)fail('action-result-unconfirmed');if(e.compact)return {write:false,value:reply(e)};const d=e.proposal.document;e.compact={documentId:d._id,revision:d._rev,integrity:d.arcalinkActionIntegrity};delete e.proposal;return {write:true,value:reply(e)};});}
 return {prepare,status,commit,recover,compact};
}
