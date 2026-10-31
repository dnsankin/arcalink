import {safeRelative} from './folder-model.mjs';
const fail=code=>Object.assign(Error(code),{code});
/** Device-side partition of a decrypted private source. Identifiers in the
 * selection stay opaque; paths and key material never belong in server frames.
 * This is inventory only: it cannot switch authority, upload or delete data.
 */
export async function partitionShared2Source({source,mount,isCurrent=async()=>true}){
 if(!source||!safeRelative(mount))throw fail('shared2-invalid-namespace-request');
 const sequence=(await source.info()).update_seq,selected=new Set(),needed=new Set(),outside=new Set(),chunks=new Set(),paths=new Map();
 const inside=path=>path.toLowerCase().startsWith(mount.toLowerCase()+'/');
 async function current(){if(!await isCurrent()||JSON.stringify((await source.info()).update_seq)!==JSON.stringify(sequence))throw fail('shared2-migration-source-changed');}
 await current();
 for await(const group of source.groups('chunk')){await current();chunks.add(group.id);}
 for await(const group of source.groups('metadata')){
  let member,protocol=false;const references=new Set();
  for await(const doc of source.revisions(group)){
   await current();if(doc._deleted)continue;
   if(!['plain','newnote'].includes(doc.type)){if('path' in doc||'children' in doc)throw fail('shared2-migration-invalid-metadata');protocol=true;continue;}
   if(typeof doc.path!=='string'||!doc.path||!Array.isArray(doc.children)||!doc.children.every(id=>typeof id==='string'&&id.startsWith('h:'))||doc.eden!==undefined&&(!doc.eden||Array.isArray(doc.eden)||typeof doc.eden!=='object'))throw fail('shared2-migration-invalid-metadata');
   const belongs=inside(doc.path);if(belongs&&!safeRelative(doc.path))throw fail('shared2-namespace-invalid-file-path');if(member!==undefined&&member!==belongs)throw fail('shared2-migration-mixed-file-history');member=belongs;
   if(belongs){const path=doc.path.toLowerCase(),other=paths.get(path);if(other&&other!==group.id)throw fail('shared2-namespace-case-conflict');paths.set(path,group.id);}
   for(const child of doc.children)if(!Object.prototype.hasOwnProperty.call(doc.eden||{},child))references.add(child);
  }
  if(member===true&&protocol)throw fail('shared2-migration-mixed-file-history');
  if(member===true){selected.add(group.id);for(const child of references)needed.add(child);}else for(const child of references)outside.add(child);
 }
 if([...needed,...outside].some(id=>!chunks.has(id)))throw fail('shared2-migration-missing-chunk');
 await current();const copy=new Set([...selected,...needed]),remove=new Set([...selected,...[...needed].filter(id=>!outside.has(id))]);
 const view={identity:()=>source.identity(),info:()=>source.info(),async *groups(kind){await current();for await(const group of source.groups(kind)){await current();if(copy.has(group.id))yield group;}},async *revisions(group){if(!copy.has(group.id))throw fail('shared2-migration-selection-scope');for await(const doc of source.revisions(group)){await current();yield doc;}}};
 return {sourceSequence:sequence,files:selected.size,copy:[...copy].sort(),remove:[...remove].sort(),view};
}
