import {safeRelative} from './folder-model.mjs';
const fail=code=>Object.assign(Error(code),{code});
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
/** Reconcile in the ORIGINAL private codec before any write. Chunk IDs alone
 * are not proof of equal data. Every available branch is read and compared.
 * Existing equal revisions are never re-encrypted or overwritten remotely.
 */
export async function planShared2ReverseUnion({source,incoming,isCurrent=async()=>true,metadataIds=[],mount}){
 if(!Array.isArray(metadataIds)||new Set(metadataIds).size!==metadataIds.length||metadataIds.some(id=>typeof id!=='string'||!id||id.startsWith('_')||id.startsWith('h:'))||metadataIds.length&&!safeRelative(mount))throw fail('shared2-reverse-alias-scope');const metadata=new Set(metadataIds);
 const before=await Promise.all([source.info(),incoming.info()]);
 async function current(){if(!await isCurrent()||(await Promise.all([source.info(),incoming.info()])).some((info,n)=>stable(info.update_seq)!==stable(before[n].update_seq)))throw fail('shared2-reverse-union-changed');}
 const original=new Map();for(const kind of ['chunk','metadata'])for await(const group of source.groups(kind)){await current();original.set(group.id,group);}
 const records=[],added=[],merged=[],skip=new Map();
 for(const kind of ['chunk','metadata'])for await(const group of incoming.groups(kind)){
  await current();const revisions=await incoming.revisionIds(group),record={id:group.id,leaves:[...group.leaves],revisions};records.push(record);
  const existing=original.get(group.id);if(!existing){added.push(group.id);continue;}
  const alias=kind==='metadata'&&metadata.has(group.id);
  if(kind!=='chunk'&&!alias)throw fail('shared2-reverse-private-metadata-collision');
  if(alias){
   const paths=new Set();let counts=0;
   for(const [view,branch] of [[source,existing],[incoming,group]]){let live=false;for await(const doc of view.revisions(branch)){await current();if(doc._deleted)continue;if(!['plain','newnote'].includes(doc.type)||!safeRelative(doc.path)||!doc.path.toLowerCase().startsWith(mount.toLowerCase()+'/'))throw fail('shared2-reverse-alias-scope');paths.add(doc.path.toLowerCase());live=true;}if(live)counts++;}
   if(paths.size!==1||counts!==2)throw fail('shared2-reverse-alias-history-requires-review');
  }
  const prior=new Set(await source.revisionIds(existing));let data,live=false;const identical=new Set();
  async function chunk(doc){if(alias)return;if(doc._deleted)return;if(doc.type!=='leaf'||typeof doc.data!=='string'||Object.keys(doc).some(key=>!['_id','_rev','_revisions','_deleted','type','data'].includes(key)))throw fail('shared2-reverse-invalid-chunk');if(live&&data!==doc.data)throw fail('shared2-reverse-chunk-content-disagrees');data=doc.data;live=true;}
  for await(const doc of source.revisions(existing)){await current();await chunk(doc);}
  for await(const doc of incoming.revisions(group)){
   await current();await chunk(doc);if(prior.has(doc._rev)){if(stable(await source.read(group.id,doc._rev))!==stable(doc))throw fail('shared2-reverse-chunk-history-disagrees');identical.add(doc._rev);}
   // A new deletion branch must not turn a private live chunk into a missing
   // winner. Retain the frozen sources for explicit reconciliation instead.
   else if(doc._deleted&&!alias)throw fail('shared2-reverse-chunk-deletion-collision');
  }
  if(!live&&!alias)throw fail('shared2-reverse-deleted-chunk-collision');
  merged.push(alias?{...record,kind:'metadata'}:record);skip.set(group.id,identical);
 }
 await current();
 const upload={info:()=>incoming.info(),groups:kind=>incoming.groups(kind),async *revisions(group){for await(const doc of incoming.revisions(group))if(!skip.get(group.id)?.has(doc._rev))yield doc;}};
 return {added,merged,records,upload};
}

/** A revision-restricted, read-only subgraph of a REAL target. A shared leaf
 * can become an ancestor in P1; it remains a leaf of the selected S0 subgraph.
 * Bodies/ancestry always come from P1 and are verified by rekeyShared2Graph.
 * The independent raw union proof rejects unknown extra revisions.
 */
export function selectedShared2RevisionTarget(view,records){
 if(!Array.isArray(records))throw fail('shared2-reverse-target-selection');const selection=new Map();
 for(const row of records){if(!row||typeof row.id!=='string'||!row.id||row.id.startsWith('_')||selection.has(row.id)||!Array.isArray(row.revisions)||!Array.isArray(row.leaves)||!row.leaves.length||!row.revisions.length||new Set(row.revisions).size!==row.revisions.length||new Set(row.leaves).size!==row.leaves.length||row.revisions.some(rev=>typeof rev!=='string'||!/^\d+-[^\s]+$/.test(rev))||row.leaves.some(rev=>!row.revisions.includes(rev)))throw fail('shared2-reverse-target-selection');selection.set(row.id,structuredClone(row));}
 const check=(identifier,revision)=>{const row=selection.get(identifier);if(!row||revision!==undefined&&!row.revisions.includes(revision))throw fail('shared2-reverse-target-selection');return row;};
 return {identity:()=>view.identity(),info:()=>view.info(),pathId:(...args)=>view.pathId(...args),chunkId:(...args)=>view.chunkId(...args),async *groups(kind){const found=new Set();for await(const group of view.groups(kind))if(selection.has(group.id)){const row=check(group.id),available=await view.revisionIds(group);if(row.revisions.some(rev=>!available.includes(rev)))throw fail('shared2-reverse-target-revision-missing');found.add(group.id);yield {id:group.id,leaves:[...row.leaves]};}for(const row of selection.values())if((row.id.startsWith('h:')?'chunk':'metadata')===kind&&!found.has(row.id))throw fail('shared2-reverse-target-revision-missing');},async revisionIds(group){const row=check(group.id);if(stable([...group.leaves].sort())!==stable([...row.leaves].sort()))throw fail('shared2-reverse-target-selection');for(const rev of row.revisions)await view.read(row.id,rev);return [...row.revisions];},read(identifier,revision){check(identifier,revision);return view.read(identifier,revision);},async *revisions(group){const row=check(group.id);for(const rev of row.revisions)yield await view.read(row.id,rev);}};
}
