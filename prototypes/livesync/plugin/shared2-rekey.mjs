import {safeRelative} from './folder-model.mjs';
const fail=code=>Object.assign(Error(code),{code});
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
/** Copy decrypted revision bodies through the TARGET engine's own ID/hash
 * services. Its existing remote transform encrypts them under the new key.
 * This function NEVER activates staging, changes ACLs or removes the source.
 */
export async function rekeyShared2Graph({source,target,job,isCurrent=async()=>true,onProgress=()=>{},verifyOnly=false}){
 if(!source||!target||!(/^[a-f0-9]{32}$/).test(job))throw fail('shared2-migration-adapters-required');
 const sourceId=await source.identity(),targetId=await target.identity();if(sourceId===targetId)throw fail('shared2-migration-target-is-source');const sequence=(await source.info()).update_seq;
 async function current(){if(!await isCurrent()||JSON.stringify((await source.info()).update_seq)!==JSON.stringify(sequence))throw fail('shared2-migration-source-changed');}
 await current();if(!verifyOnly)await target.own(job,sourceId,sequence);
 const chunks=new Map(),liveChunks=new Set(),metadata=new Map(),expected=new Map(),versions=new Map();let copied=0,contentProofDigest=await digest(job);
 async function verifyRevision(original,next){if(!versions.has(next._id))versions.set(next._id,new Set());versions.get(next._id).add(next._rev);if(stable(await target.read(next._id,next._rev))!==stable(next))throw fail('shared2-migration-copy-mismatch');contentProofDigest=await digest(contentProofDigest+':'+await digest(stable(original))+':'+await digest(stable(next)));}
 const remember=(identifier,revision)=>{if(!expected.has(identifier))expected.set(identifier,new Set());expected.get(identifier).add(revision);};
 async function mappedChunk(oldId,piece){if(typeof piece!=='string')throw fail('shared2-migration-invalid-chunk');const id=await target.chunkId(piece);if(chunks.has(oldId)&&chunks.get(oldId)!==id)throw fail('shared2-migration-mutated-chunk');chunks.set(oldId,id);liveChunks.add(oldId);return id;}
 for await(const group of source.groups('chunk')){
  for await(const doc of source.revisions(group)){
   await current();if(Object.keys(doc).some(key=>!['_id','_rev','_revisions','_deleted','type','data'].includes(key)))throw fail('shared2-migration-unsupported-chunk-fields');if(doc._deleted)continue;if(doc.type!=='leaf')throw fail('shared2-migration-invalid-chunk');const id=await mappedChunk(group.id,doc.data);const next={...doc,_id:id};if(!verifyOnly)await target.importRevision(next);await verifyRevision(doc,next);copied++;onProgress({copied});
  }
  if(!chunks.has(group.id))chunks.set(group.id,await target.chunkId('ArcaLink deleted chunk '+await digest(group.id)));
  for await(const doc of source.revisions(group))if(doc._deleted){await current();const next={...doc,_id:chunks.get(group.id)};if(!verifyOnly)await target.importRevision(next);await verifyRevision(doc,next);copied++;}
  for(const revision of group.leaves)remember(chunks.get(group.id),revision);
 }
 // First metadata pass maps every available branch before importing its
 // tombstones. A move across two distinct target IDs requires reconciliation.
 for await(const group of source.groups('metadata')){
  let id;
  for await(const doc of source.revisions(group)){
   await current();if(Object.keys(doc).some(key=>!['_id','_rev','_revisions','_deleted','path','mtime','ctime','size','children','eden','type','datatype','deleted'].includes(key)))throw fail('shared2-migration-unsupported-metadata-fields');if(doc._deleted)continue;if(!['plain','newnote'].includes(doc.type)||!safeRelative(doc.path)||!Array.isArray(doc.children))throw fail('shared2-migration-invalid-metadata');const mapped=await target.pathId(doc.path);if(id&&id!==mapped)throw fail('shared2-migration-mixed-file-history');id=mapped;
   for(const [oldId,value] of Object.entries(doc.eden||{}))await mappedChunk(oldId,value?.data);
  }
  metadata.set(group.id,id||await target.pathId('ArcaLink Tombstones/'+await digest(group.id)));
 }
 for await(const group of source.groups('metadata')){
  const id=metadata.get(group.id);
  for await(const doc of source.revisions(group)){
   await current();let next={...doc,_id:id};
   if(!doc._deleted){const children=doc.children.map(oldId=>{if(!chunks.has(oldId)||!liveChunks.has(oldId))throw fail('shared2-migration-missing-chunk');return chunks.get(oldId);});const eden=Object.fromEntries(Object.entries(doc.eden||{}).map(([oldId,value])=>[chunks.get(oldId),value]));next={...next,children,eden};}
   if(!verifyOnly)await target.importRevision(next);await verifyRevision(doc,next);copied++;onProgress({copied});
  }
  for(const revision of group.leaves)remember(id,revision);
 }
 await current();const targetSequence=(await target.info()).update_seq,actual=new Map();
 for(const kind of ['chunk','metadata'])for await(const group of target.groups(kind)){actual.set(group.id,new Set(group.leaves));const available=await target.revisionIds(group),wanted=versions.get(group.id);if(!wanted||available.length!==wanted.size||available.some(revision=>!wanted.has(revision)))throw fail('shared2-migration-target-history-mismatch');}
 if(actual.size!==expected.size||[...expected].some(([id,revisions])=>!actual.has(id)||actual.get(id).size!==revisions.size||[...revisions].some(revision=>!actual.get(id).has(revision))))throw fail('shared2-migration-target-graph-mismatch');
 if(JSON.stringify((await target.info()).update_seq)!==JSON.stringify(targetSequence))throw fail('shared2-migration-verification-changed');await current();
 return {verified:true,job,contentProofDigest,sourceSequence:sequence,targetSequence,documents:expected.size,revisions:copied};
}

/** Full revision upload, including non-leaf bodies skipped by normal replication. */
export async function pushShared2MigrationRevisions({view,remote,isCurrent=async()=>true}){
 const sequence=(await view.info()).update_seq;let copied=0;
 for(const kind of ['chunk','metadata'])for await(const group of view.groups(kind))for await(const doc of view.revisions(group)){
  if(!await isCurrent()||JSON.stringify((await view.info()).update_seq)!==JSON.stringify(sequence))throw fail('shared2-migration-source-changed');
  const result=await remote.bulkDocs([doc],{new_edits:false});if(result.some(row=>row.error))throw fail('shared2-migration-remote-write-rejected');
  if(stable(await remote.get(doc._id,{rev:doc._rev,revs:true,attachments:true}))!==stable(doc))throw fail('shared2-migration-remote-readback-mismatch');copied++;
 }
 if(JSON.stringify((await view.info()).update_seq)!==JSON.stringify(sequence))throw fail('shared2-migration-source-changed');return {revisions:copied};
}
