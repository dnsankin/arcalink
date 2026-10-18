import {excludedFolders,folderContains,withExcludedFolders} from './folder-exclusions.mjs';

const fileTypes=new Set(['plain','newnote']);
const error=code=>Object.assign(Error(code),{code});
const sequence=value=>JSON.stringify(value);
const isChunk=id=>id.startsWith('h:');
const isSelected=(path,folders,caseSensitive)=>!path.startsWith('i:')&&folders.some(folder=>folderContains(folder,path,caseSensitive));

/** Same canonical UTF-16 ordering / ASCII JSON as the server manifest. */
export async function cleanupManifestDigest(ids) {
  if(!Array.isArray(ids)||ids.length>100000||ids.some(id=>typeof id!=='string'||!id||id.startsWith('_')||id.length>4096))throw error('invalid-manifest');
  const json=JSON.stringify([...new Set(ids)].sort()).replace(/[^\x20-\x7e]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json));
  return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

/** Project metadata only: never retain attachment/chunk bodies in the inventory. */
export function cleanupEntry(doc) {
  if(!doc||typeof doc._id!=='string'||typeof doc._rev!=='string')throw error('invalid-document');
  const base={id:doc._id,rev:doc._rev};
  if(doc._deleted)return {...base,kind:'tombstone'};
  if(isChunk(doc._id))return {...base,kind:'chunk'};
  if(!fileTypes.has(doc.type)){
    // Unknown documents with file references cannot be silently ignored.
    if('children' in doc||'path' in doc)throw error('unknown-file-format');
    return {...base,kind:'other'};
  }
  if(typeof doc.path!=='string'||!doc.path||doc.path.startsWith('/\\:')
    ||(doc._id.startsWith('f:')&&doc.path.startsWith('%')&&doc.path.length>64)
    ||['h:++encrypted','h:++encrypted-hkdf'].some(key=>key in (doc.eden||{})))throw error('unreadable-metadata');
  if(!Array.isArray(doc.children)||doc.children.some(id=>typeof id!=='string'||!isChunk(id)))throw error('invalid-chunk-list');
  if(!Number.isSafeInteger(doc.size)||doc.size<0)throw error('invalid-file-size');
  return {...base,kind:'file',path:doc.path,children:[...doc.children],embedded:Object.keys(doc.eden||{}),size:doc.size,deleted:doc.deleted===true};
}

/**
 * Read ALL available revisions, including losing conflict branches and deleted
 * leaves. The caller supplies a paused database; a concurrent write invalidates
 * this snapshot. No filesystem operations or database mutations occur here.
 */
export async function inspectCleanupDatabase(db,{decode=async doc=>doc,pageSize=128}={}) {
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>1000)throw error('invalid-page-size');
  const before=await db.info(),entries=[];
  let since=0;
  while(true){
    const page=await db.changes({since,limit:pageSize,style:'all_docs',return_docs:true});
    for(const change of page.results){
      if(isChunk(change.id)){
        entries.push(...change.changes.map(item=>({id:change.id,rev:item.rev,kind:change.deleted?'tombstone':'chunk'})));continue;
      }
      const seen=new Set();
      for(const leaf of change.changes){
        const doc=await db.get(change.id,{rev:leaf.rev,revs:true,revs_info:true});
        if(doc._rev!==leaf.rev)throw error('revision-mismatch');
        const available=(doc._revs_info||[{rev:doc._rev,status:'available'}]).filter(item=>item.status==='available');
        for(const item of available){
          if(seen.has(item.rev))continue;seen.add(item.rev);
          const revision=item.rev===doc._rev?doc:await db.get(change.id,{rev:item.rev});
          const decoded=await decode(revision);
          if(decoded._id!==change.id||decoded._rev!==item.rev)throw error('revision-mismatch');
          entries.push(cleanupEntry(decoded));
        }
      }
    }
    if(!page.results.length)break;
    if(sequence(page.last_seq)===sequence(since))throw error('non-advancing-snapshot');
    since=page.last_seq;
  }
  const after=await db.info();
  if(sequence(before.update_seq)!==sequence(after.update_seq))throw error('database-changed');
  return {sequence:before.update_seq,entries};
}

/** Keep unclassified/orphan data conservatively; remove only proven exclusive chunks. */
export function planFolderCleanup(snapshot,folders,{caseSensitive=false,allowEmpty=false,allowMissingKeptChunks=false}={}) {
  const roots=excludedFolders(withExcludedFolders('',folders,caseSensitive));
  if(!roots.length&&!allowEmpty)throw error('empty-selection');
  const byId=new Map();
  for(const entry of snapshot.entries){
    const rows=byId.get(entry.id)||[];rows.push(entry);byId.set(entry.id,rows);
  }
  const removeFiles=[],candidateChunks=new Set(),keepChunks=new Set();
  let fileCount=0,logicalBytes=0;
  for(const [id,rows] of byId){
    const files=rows.filter(row=>row.kind==='file');
    if(!files.length)continue;
    const selected=files.filter(row=>isSelected(row.path,roots,caseSensitive));
    if(selected.length&&selected.length!==files.length)throw error('mixed-file-revisions');
    if(rows.some(row=>!['file','tombstone'].includes(row.kind)))throw error('mixed-document-types');
    if(selected.length){
      removeFiles.push(id);fileCount++;
      // A conservative preview per document, never a physical-space estimate.
      logicalBytes+=Math.max(...files.map(row=>row.deleted?0:row.size));
      if(!Number.isSafeInteger(logicalBytes))throw error('invalid-total-size');
      for(const row of files)for(const child of row.children)candidateChunks.add(child);
    }else for(const row of files)for(const child of row.children){
      keepChunks.add(child);
      if(!allowMissingKeptChunks&&!byId.get(child)?.some(entry=>entry.kind==='chunk')&&!row.embedded.includes(child))throw error('missing-kept-chunk');
    }
  }
  const removeChunks=[...candidateChunks].filter(id=>!keepChunks.has(id)&&byId.get(id)?.every(row=>['chunk','tombstone'].includes(row.kind)));
  return {sequence:snapshot.sequence,folders:roots,caseSensitive,fileCount,logicalBytes,
    removeFiles:removeFiles.sort(),removeChunks:removeChunks.sort()};
}

const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);

/** Verify every retained leaf body/conflict/tombstone, including chunk bytes. */
export async function verifyCleanupSnapshot(source,target,plan,{isCurrent=async()=>true,pageSize=128}={}) {
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>1000)throw error('invalid-page-size');
  if(source===target||await source.id()===await target.id())throw error('target-is-source');
  const removed=new Set([...plan.removeFiles,...plan.removeChunks]);
  const targetBefore=await target.info();let count=0;
  for(const [database,checkBody] of [[source,true],[target,false]]){
    let since=0;
    while(true){
      const page=await database.changes({since,limit:pageSize,style:'all_docs',return_docs:true});
      for(const row of page.results){
        if(removed.has(row.id)){
          if(!checkBody)throw error('excluded-data-in-target');
          continue;
        }
        for(const leaf of row.changes){
          let expected,actual;
          try{
            expected=await source.get(row.id,{rev:leaf.rev,revs:true,attachments:true});
            actual=await target.get(row.id,{rev:leaf.rev,revs:true,attachments:true});
          }catch{throw error('copy-verification-failed');}
          if(stable(expected)!==stable(actual))throw error('copy-verification-failed');
          if(checkBody)count++;
        }
      }
      if(!page.results.length)break;
      if(sequence(page.last_seq)===sequence(since))throw error('non-advancing-snapshot');
      since=page.last_seq;
    }
  }
  if(!await isCurrent()||sequence((await source.info()).update_seq)!==sequence(plan.sequence)
    ||sequence((await target.info()).update_seq)!==sequence(targetBefore.update_seq))throw error('database-changed');
  return {verified_revisions:count,target_sequence:targetBefore.update_seq};
}

/**
 * Copy only into a fresh, caller-owned staging DB. Never delete source documents
 * or emit tombstones. Publication/switching belongs to the authoritative server
 * transaction; this function deliberately cannot make a staging DB live.
 */
export async function copyCleanupSnapshot(source,target,plan,{isCurrent=async()=>true}={}) {
  if(source===target||await source.id()===await target.id())throw error('target-is-source');
  const assertCurrent=async()=>{
    if(!await isCurrent()||sequence((await source.info()).update_seq)!==sequence(plan.sequence))throw error('database-changed');
  };
  await assertCurrent();
  if((await target.info()).doc_count!==0||(await target.changes({since:0,limit:1})).results.length)throw error('target-not-empty');
  const removed=new Set([...plan.removeFiles,...plan.removeChunks]);
  const result=await source.replicate.to(target,{filter:doc=>!removed.has(doc._id),live:false,retry:false});
  if(result.errors?.length||result.doc_write_failures||result.status!=='complete')throw error('copy-failed');
  await assertCurrent();
  const copied=await target.allDocs({keys:[...removed]});
  if(copied.rows.some(row=>!row.error))throw error('excluded-data-in-target');
  return {...result,...await verifyCleanupSnapshot(source,target,plan,{isCurrent})};
}
