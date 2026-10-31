const fail=code=>Object.assign(Error(code),{code});
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');
function scope(value){if(!value||Object.keys(value).sort().join(',')!=='account,device,folder,job,workspace'||!['account','device'].every(key=>typeof value[key]==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(value[key]))||!['workspace','folder','job'].every(key=>typeof value[key]==='string'&&/^[a-f0-9]{32}$/.test(value[key])))throw fail('shared2-pinned-source-scope');}
/** Pin revision identities/hashes, not document bodies. While the private engine
 * is briefly quiesced, capture an immutable selection. Later unrelated writes
 * can advance its global sequence; every selected revision is still read exactly
 * by ID/revision and verified against its captured hash. No source mutation.
 */
export async function captureShared2PinnedSource({source,readRevision,scope:context,isCurrent=async()=>true,persist}){
 scope(context);if(typeof readRevision!=='function'||typeof persist!=='function')throw fail('shared2-pinned-source-adapters');
 const identity=await source.identity(),sequence=(await source.info()).update_seq,groups=[],seen=new Set();
 async function current(){if(!await isCurrent()||JSON.stringify((await source.info()).update_seq)!==JSON.stringify(sequence))throw fail('shared2-migration-source-changed');}
 await current();
 for(const kind of ['chunk','metadata'])for await(const group of source.groups(kind)){
  await current();if(typeof group.id!=='string'||group.id.startsWith('_')||seen.has(group.id)||!Array.isArray(group.leaves)||!group.leaves.length)throw fail('shared2-pinned-source-invalid');seen.add(group.id);const revisions=[];
  for await(const doc of source.revisions(group)){await current();if(doc._id!==group.id||typeof doc._rev!=='string'||revisions.some(row=>row.rev===doc._rev))throw fail('shared2-pinned-source-invalid');revisions.push({rev:doc._rev,hash:await digest(doc)});}
  if(group.leaves.some(leaf=>!revisions.some(row=>row.rev===leaf)))throw fail('shared2-pinned-source-leaf-missing');groups.push({kind,id:group.id,leaves:[...group.leaves],revisions});
 }
 await current();const body={protocol:2,scope:structuredClone(context),identity,sequence,groups};
 const prepared={...body,phase:'preparing'};await persist({...prepared,digest:await digest(prepared)});await current();
 // The last sequence check is the logical capture point. Afterwards revisions
 // are immutable; unrelated writes may proceed while this commit is persisted.
 const committed={...body,phase:'committed'},descriptor={...committed,digest:await digest(committed)};await persist(structuredClone(descriptor));
 return {descriptor,view:await reopenShared2PinnedSource({source,readRevision,scope:context,descriptor,isCurrent})};
}

export async function reopenShared2PinnedSource({source,readRevision,scope:context,descriptor,isCurrent=async()=>true}){
 scope(context);if(!descriptor||descriptor.protocol!==2||descriptor.phase!=='committed'||stable(descriptor.scope)!==stable(context)||typeof readRevision!=='function'||!Array.isArray(descriptor.groups))throw fail('shared2-pinned-source-scope');
 const {digest:expected,...body}=descriptor;if(expected!==await digest(body)||descriptor.identity!==await source.identity())throw fail('shared2-pinned-source-mismatch');
 // Own a deep copy: callers cannot rewrite a descriptor while readback is active.
 const pinned=structuredClone(descriptor),index=new Map();
 for(const group of pinned.groups){
  if(!group||!['chunk','metadata'].includes(group.kind)||typeof group.id!=='string'||group.id.startsWith('_')||index.has(group.id)||!Array.isArray(group.leaves)||!group.leaves.length||!Array.isArray(group.revisions)||!group.revisions.length)throw fail('shared2-pinned-source-invalid');
  const revisions=new Map();for(const row of group.revisions){if(typeof row.rev!=='string'||!/^\d+-[^\s]+$/.test(row.rev)||typeof row.hash!=='string'||!/^[a-f0-9]{64}$/.test(row.hash)||revisions.has(row.rev))throw fail('shared2-pinned-source-invalid');revisions.set(row.rev,row.hash);}if(new Set(group.leaves).size!==group.leaves.length||group.leaves.some(rev=>!revisions.has(rev)))throw fail('shared2-pinned-source-invalid');index.set(group.id,{...group,revisions});
 }
 async function current(){if(!await isCurrent())throw fail('shared2-pinned-source-authority-changed');}
 async function read(id,rev){await current();const group=index.get(id),expected=group?.revisions.get(rev);if(!expected)throw fail('shared2-pinned-source-selection');let doc;try{doc=await readRevision(id,rev);}catch(error){if(error.status===404)throw fail('shared2-pinned-source-revision-missing');throw error;}if(doc._id!==id||doc._rev!==rev||await digest(doc)!==expected)throw fail('shared2-pinned-source-revision-changed');await current();return doc;}
 await current();return {
  identity:async()=>{await current();if(await source.identity()!==pinned.identity)throw fail('shared2-pinned-source-mismatch');return stable([pinned.identity,pinned.digest]);},
  info:async()=>{await current();return {update_seq:pinned.digest};},
  async *groups(kind){await current();for(const group of index.values())if(group.kind===kind){await current();yield {id:group.id,leaves:[...group.leaves]};}},
  revisionIds:async group=>{await current();if(!index.has(group.id))throw fail('shared2-pinned-source-selection');return [...index.get(group.id).revisions.keys()];},
  async *revisions(group){if(!index.has(group.id))throw fail('shared2-pinned-source-selection');for(const rev of index.get(group.id).revisions.keys())yield await read(group.id,rev);},read,
 };
}
