import {inspectCleanupDatabase,planFolderCleanup,copyCleanupSnapshot,verifyCleanupSnapshot,cleanupManifestDigest} from './folder-cleanup.mjs';
import {checkedFolderPolicy} from './folder-policy.mjs';
const failure=code=>Object.assign(Error(code),{code});
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
async function closeDatabases(databases,failed) {
  const results=await Promise.allSettled(databases.filter(Boolean).map(database=>database.close()));
  if(!failed){const rejected=results.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;}
}
const generationPrefix=logical=>logical+'-arcalink-folder-';
const isGeneration=(name,logical)=>typeof name==='string'&&name.startsWith(generationPrefix(logical))
  &&/^[a-f0-9]{32}$/.test(name.slice(generationPrefix(logical).length));
const localName=(name,logical)=>name===logical||isGeneration(name,logical);
function stateKey(state,logical) {
  if(typeof logical!=='string'||!logical.endsWith('-livesync-v2')||logical.length>512
    ||!state||!Number.isSafeInteger(state.revision)||state.revision<1||state.phase!=='ready'
    ||typeof state.database!=='string'||!/^arcalink_p_[a-f0-9]{32}$/.test(state.database))throw failure('invalid-local-policy-state');
  const policy=checkedFolderPolicy(state.policy,state.workspace);
  return JSON.stringify({logical,workspace:state.workspace,revision:state.revision,database:state.database,policy});
}
function checkedJournal(journal,key,logical,source) {
  const state=JSON.parse(key);
  if(!journal||journal.protocol!==1||journal.key!==key||journal.logical!==logical||journal.source!==source
    ||!localName(source,logical)||!isGeneration(journal.target,logical)||journal.target===source
    ||journal.workspace!==state.workspace||journal.revision!==state.revision||journal.database!==state.database
    ||!['copying','prepared'].includes(journal.phase)||typeof journal.manifest!=='string'
    ||!/^[a-f0-9]{64}$/.test(journal.manifest))throw failure('local-preparation-journal-changed');
  return journal;
}

/** The logical database/KVS namespace and settings suffix never change. */
export function folderDatabaseName(logical,binding) {
  if(!binding)return logical;
  if(binding.protocol!==1||typeof binding.logical!=='string'||!isGeneration(binding.target,binding.logical)
    ||typeof binding.workspace!=='string'||!/^[a-f0-9]{32}$/.test(binding.workspace)
    ||!Number.isSafeInteger(binding.revision)||binding.revision<1)throw failure('invalid-local-database-binding');
  return logical===binding.logical?binding.target:logical;
}

/** Intercept only the personal Pouch name, before the engine adds its adapter suffix. */
export function installFolderDatabaseResolver(database,readBinding) {
  const original=database.createPouchDBInstance;
  if(typeof original!=='function'||typeof readBinding!=='function')throw failure('invalid-database-factory');
  function resolved(name,options){return original.call(this,folderDatabaseName(name,readBinding()),options);}
  database.createPouchDBInstance=resolved;
  return {openRaw:(name,options)=>original.call(database,name,options),dispose:()=>{
    if(database.createPouchDBInstance===resolved)database.createPouchDBInstance=original;
  }};
}

/**
 * Called only with transport/watchers/file queues quiesced. Copy to a private
 * generation, persist a resumable preparation journal, never activate or delete
 * the source here. open() is the ORIGINAL factory (not the resolver).
 */
export async function prepareFolderDatabase({state,logical,source:sourceName,journal,open,persistJournal,quiesce,isCurrent,isMapped,decode=async doc=>doc}) {
  const key=stateKey(state,logical);
  if(!localName(sourceName,logical)||typeof open!=='function'||typeof persistJournal!=='function'
    ||typeof quiesce!=='function'||typeof isCurrent!=='function'||typeof isMapped!=='function')throw failure('invalid-local-preparation');
  if(!await quiesce()||!await isCurrent())throw failure('local-database-not-quiescent');
  if(journal)checkedJournal(journal,key,logical,sourceName);
  const source=open(sourceName,{auto_compaction:false});let target,failed=false;
  try{
    const snapshot=await inspectCleanupDatabase(source,{decode});
    const plan=planFolderCleanup(snapshot,state.policy.folders,{caseSensitive:state.policy.caseSensitive,
      allowEmpty:true,allowMissingKeptChunks:true});
    const manifest=await cleanupManifestDigest([...plan.removeFiles,...plan.removeChunks]);
    if(journal&&(!same(journal.sequence,snapshot.sequence)||journal.manifest!==manifest))throw failure('local-source-changed');
    if(!journal){
      journal={protocol:1,key,logical,source:sourceName,target:generationPrefix(logical)+crypto.randomUUID().replaceAll('-',''),
        workspace:state.workspace,revision:state.revision,database:state.database,sequence:snapshot.sequence,manifest,phase:'copying'};
      if(!await isCurrent())throw failure('policy-changed');
      await persistJournal(journal);
    }
    if(await isMapped(journal.target))throw failure('preparation-target-is-active');
    if(!await isCurrent())throw failure('policy-changed');
    target=open(journal.target,{auto_compaction:false});
    if(await source.id()===await target.id())throw failure('target-is-source');
    if(journal.phase==='copying'){
      // A partial, never-published generation belongs solely to this journal.
      // Keep the source on every failure; a retry starts the staging copy clean.
      if((await target.changes({since:0,limit:1})).results.length){
        if(await isMapped(journal.target)||!await isCurrent())throw failure('preparation-target-is-active');
        await target.destroy();target=open(journal.target,{auto_compaction:false});
      }
      const result=await copyCleanupSnapshot(source,target,plan,{isCurrent});
      journal={...journal,phase:'prepared',targetSequence:result.target_sequence,verifiedRevisions:result.verified_revisions};
      if(!await isCurrent())throw failure('policy-changed');
      await persistJournal(journal);
    }else{
      if(!same((await target.info()).update_seq,journal.targetSequence))throw failure('prepared-target-changed');
      await verifyCleanupSnapshot(source,target,plan,{isCurrent});
    }
    return journal;
  }catch(error){failed=true;throw error;}finally{await closeDatabases([target,source],failed);}
}

/** Persist the physical binding BEFORE acknowledging the server policy. */
export async function activatePreparedFolderDatabase({state,journal,open,persistBinding,isCurrent}) {
  const key=stateKey(state,journal?.logical);
  checkedJournal(journal,key,journal.logical,journal.source);
  if(journal.phase!=='prepared'||typeof persistBinding!=='function'||typeof isCurrent!=='function')throw failure('local-copy-not-prepared');
  const target=open(journal.target,{auto_compaction:false});
  try{
    if(!same((await target.info()).update_seq,journal.targetSequence)||!await isCurrent())throw failure('prepared-target-changed');
    const binding={protocol:1,logical:journal.logical,target:journal.target,workspace:state.workspace,revision:state.revision,
      database:state.database,key};
    await persistBinding(binding);
    // A concurrently changed server policy must not receive an acknowledgement.
    // The durable binding still points to an intact, verified local copy.
    if(!await isCurrent())throw failure('policy-changed');
    return binding;
  }finally{await target.close();}
}

/** Never retire an old cache before a matching successful server acknowledgement. */
export async function retirePreparedFolderDatabase({journal,binding,acknowledgement,retirement,open,persistRetirement,isCurrent,isMapped,isQuiescent,decode=async doc=>doc}) {
  if(!journal||!binding||binding.protocol!==1||journal.phase!=='prepared'||binding.database!==journal.database||binding.key!==journal.key||binding.target!==journal.target
    ||binding.logical!==journal.logical||binding.revision!==journal.revision||binding.workspace!==journal.workspace
    ||!acknowledgement||acknowledgement.revision!==journal.revision||acknowledgement.workspace!==journal.workspace
    ||acknowledgement.database!==journal.database||typeof persistRetirement!=='function'
    ||typeof isCurrent!=='function'||typeof isMapped!=='function'||typeof isQuiescent!=='function')throw failure('local-retirement-not-authorized');
  let state;
  try{state={...JSON.parse(journal.key),phase:'ready'};}catch{throw failure('invalid-local-policy-state');}
  checkedJournal(journal,stateKey(state,journal.logical),journal.logical,journal.source);
  const record={key:journal.key,source:journal.source,target:journal.target,sequence:journal.sequence};
  if(retirement&&(!['retiring','retired'].includes(retirement.phase)||!same({...retirement,phase:undefined},record)))throw failure('local-retirement-journal-changed');
  if(retirement?.phase==='retired')return retirement;
  const assertQuiescent=async()=>{
    if(!await isCurrent()||!await isQuiescent()||await isMapped(journal.source)||!await isMapped(journal.target))throw failure('local-binding-changed');
  };
  await assertQuiescent();
  const source=open(journal.source,{auto_compaction:false});let target,destroyed=false,failed=false;
  try{
    target=open(journal.target,{auto_compaction:false});
    if(await source.id()===await target.id())throw failure('target-is-source');
    if(!same((await target.info()).update_seq,journal.targetSequence))throw failure('prepared-target-changed');
    const info=await source.info();
    const alreadyRemoved=retirement?.phase==='retiring'&&info.update_seq===0&&info.doc_count===0;
    if(!alreadyRemoved){
      if(!same(info.update_seq,journal.sequence))throw failure('local-source-changed');
      const snapshot=await inspectCleanupDatabase(source,{decode});
      const plan=planFolderCleanup(snapshot,state.policy.folders,{caseSensitive:state.policy.caseSensitive,allowEmpty:true,allowMissingKeptChunks:true});
      if(await cleanupManifestDigest([...plan.removeFiles,...plan.removeChunks])!==journal.manifest)throw failure('local-source-changed');
      await verifyCleanupSnapshot(source,target,plan,{isCurrent});
    }
    // This durable proof distinguishes a previously destroyed database from a
    // source unexpectedly emptied before retirement was ever authorised.
    await persistRetirement({...record,phase:'retiring'});
    await assertQuiescent();
    await source.destroy();destroyed=true;
    const result={...record,phase:'retired'};await persistRetirement(result);return result;
  }catch(error){failed=true;throw error;}finally{await closeDatabases([target,...(destroyed?[]:[source])],failed);}
}
