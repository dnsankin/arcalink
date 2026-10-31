const fail=code=>Object.assign(Error(code),{code});
/** Explicit migration-only view. Normal engine instances do not expose raw
 * revision import. Iteration holds one document body, including old/conflicting
 * revisions, rather than materialising an attachment or entire database. */
/** @param {any} local
 * @param {{pathId?:Function,chunkId?:Function,readOnly?:boolean}} options */
export function createShared2MigrationView(local,{pathId=undefined,chunkId=undefined,readOnly=false}){
 const database=local.localDatabase;
 async function revisionIds(group){
  const available=new Set(),candidates=new Set();
  for(const leaf of group.leaves){const doc=await database.get(group.id,{rev:leaf,revs:true,revs_info:true}).catch(error=>{if(error.status===404)throw fail('shared2-migration-source-leaf-missing');throw error;});available.add(leaf);
   // CouchDB omits _revs_info when rev= is present, unlike local PouchDB.
   // Follow the ancestry and probe bodies instead of silently losing parents.
   if(Array.isArray(doc._revs_info))for(const row of doc._revs_info){if(row.status==='available')available.add(row.rev);}
   else{if(!doc._revisions||!Number.isSafeInteger(doc._revisions.start)||!Array.isArray(doc._revisions.ids))throw fail('shared2-migration-source-ancestry-missing');doc._revisions.ids.forEach((hash,index)=>candidates.add((doc._revisions.start-index)+'-'+hash));}
  }
  for(const revision of candidates)if(!available.has(revision)){try{await database.get(group.id,{rev:revision});available.add(revision);}catch(error){if(error.status!==404)throw error;}}
  return [...available].sort((a,b)=>parseInt(a)-parseInt(b)||a.localeCompare(b));
 }

 return {
  revisionIds,
  forDatabase:remote=>createShared2MigrationView({localDatabase:remote},{pathId,chunkId,readOnly:true}),
  identity:()=>database.id(),info:()=>database.info(),
  async *groups(kind){let since=0;for(;;){const page=await database.changes({since,limit:32,style:'all_docs',return_docs:true});if(!page.results.length)return;for(const row of page.results){if(row.id.startsWith('_'))continue;if((row.id.startsWith('h:')?'chunk':'metadata')!==kind)continue;yield {id:row.id,leaves:row.changes.map(item=>item.rev)};}if(JSON.stringify(page.last_seq)===JSON.stringify(since))throw fail('shared2-migration-scan-stalled');since=page.last_seq;}},
  async *revisions(group){
   // Import parents before children; otherwise a known missing ancestor may be
   // skipped by PouchDB after its leaf is present.
   for(const revision of await revisionIds(group)){const doc=await database.get(group.id,{rev:revision,revs:true,attachments:true}).catch(error=>{if(error.status===404)throw fail('shared2-migration-source-history-missing');throw error;});const {_revs_info,_conflicts,_deleted_conflicts,...body}=doc;yield body;}
  },
  read:(id,revision)=>database.get(id,{rev:revision,revs:true,attachments:true}).catch(error=>{if(error.status===404)throw fail('shared2-migration-import-readback-missing');throw error;}),pathId,chunkId,
  async own(job,source,sequence){
   if(readOnly)throw fail('shared2-migration-read-only');const markerId='_local/arcalink_shared2_rekey';let marker;
   try{marker=await database.get(markerId);}catch(error){if(error.status!==404)throw error;}
   const expected={protocol:2,job,source,sequence};
   if(marker){if(Object.keys(expected).some(key=>JSON.stringify(marker[key])!==JSON.stringify(expected[key])))throw fail('shared2-migration-target-ownership');return;}
   const info=await database.info();const changes=await database.changes({since:0,limit:1});if(info.doc_count||info.doc_del_count||changes.results.length)throw fail('shared2-migration-target-not-empty');await database.put({_id:markerId,...expected});
  },
  async importRevision(doc){if(readOnly)throw fail('shared2-migration-read-only');if(!doc||typeof doc._id!=='string'||doc._id.startsWith('_')||!doc._rev||!doc._revisions)throw fail('shared2-migration-invalid-revision');const result=await database.bulkDocs([doc],{new_edits:false});if(result.some(row=>row.error))throw fail('shared2-migration-revision-rejected');},
 };
}
