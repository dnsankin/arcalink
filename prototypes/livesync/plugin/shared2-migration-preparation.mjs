import {safeRelative} from './folder-model.mjs';
const fail=code=>Object.assign(Error(code),{code});
export async function backupShared2Files({mount,privateRoot,adapter,listFiles,hashFile,assertCurrent,onProgress=(_state)=>{}}){
 if(!safeRelative(mount)||!safeRelative(privateRoot)||!privateRoot.startsWith('ArcaLink Shared/')||privateRoot.toLowerCase()===mount.toLowerCase()||privateRoot.toLowerCase().startsWith(mount.toLowerCase()+'/')||mount.toLowerCase().startsWith(privateRoot.toLowerCase()+'/'))throw fail('shared2-invalid-backup-scope');
 async function mkdirs(root){let path='';for(const part of root.split('/')){path+=(path?'/':'')+part;if(!await adapter.exists(path)){try{await adapter.mkdir(path);}catch(error){if(!await adapter.exists(path))throw error;}}}}
   await mkdirs(privateRoot+'/objects');const files=await listFiles(),seen=new Set(),manifest=[];
   for(const full of files){if(typeof full!=='string'||!full.startsWith(mount+'/'))throw fail('shared2-backup-path-escaped');const relative=full.slice(mount.length+1);if(!safeRelative(relative)||seen.has(relative.toLowerCase()))throw fail('shared2-backup-path-invalid');seen.add(relative.toLowerCase());}
   let done=0;for(const full of files){
    await assertCurrent();const relative=full.slice(mount.length+1),proof=await hashFile(full);
    if(!proof||!(/^[a-f0-9]{64}$/).test(proof.sha256)||!Number.isSafeInteger(proof.size)||proof.size<0)throw fail('shared2-backup-proof-invalid');
    const destination=privateRoot+'/objects/'+proof.sha256;
    if(!await adapter.exists(destination))await adapter.copy(full,destination);
    const backup=await hashFile(destination);if(backup.sha256!==proof.sha256||backup.size!==proof.size)throw fail('shared2-backup-proof-mismatch');
    manifest.push({path:relative,...proof});onProgress({phase:'backing-up',done:++done,total:files.length,path:relative});
   }
 return manifest;
}
/** Device-side safety preparation, followed by idempotent server admission.
 * Backups are private, content-addressed and retained for explicit review.
 * State contains hashes/paths only, never tokens, note bytes or encryption keys.
 */
export function createShared2MigrationPreparation({scope,folder,mount,privateRoot,store,adapter,listFiles,hashFile,flushSource,pauseEditing,recordJob,drainSource,admit,assertCurrent,onProgress=(_state)=>{}}){
 if(!scope?.account||!scope?.workspace||!(/^[a-f0-9]{32}$/).test(folder)||!safeRelative(mount)||!safeRelative(privateRoot)||!privateRoot.startsWith('ArcaLink Shared/')||privateRoot.toLowerCase()===mount.toLowerCase()||privateRoot.toLowerCase().startsWith(mount.toLowerCase()+'/')||mount.toLowerCase().startsWith(privateRoot.toLowerCase()+'/'))throw fail('shared2-invalid-preparation-scope');
 for(const fn of [listFiles,hashFile,flushSource,pauseEditing,recordJob,drainSource,admit,assertCurrent])if(typeof fn!=='function')throw fail('shared2-preparation-adapters-required');
 let flight,state;const binding=JSON.stringify([scope.account,scope.workspace,folder,mount]);
 async function current(){if(await assertCurrent()!==true)throw fail('shared2-preparation-scope-changed');}
 async function persist(){await store.save(structuredClone(state));}
 async function load(){if(state)return;state=await store.load();if(state&&(state.protocol!==2||state.binding!==binding||state.privateRoot!==privateRoot||!['planned','backing-up','admitting','admitted'].includes(state.phase)||!Array.isArray(state.files)||state.job!==null&&!/^[a-f0-9]{32}$/.test(state.job)))throw fail('shared2-preparation-state-corrupt');if(!state){state={protocol:2,binding,privateRoot,phase:'planned',files:[],job:null};await persist();}}
 async function run(){
  await current();await load();await pauseEditing(true);
  if(state.phase==='planned'){
   onProgress({phase:'waiting-for-source',done:0,total:0});await flushSource();await current();state.phase='backing-up';await persist();
  }
  if(state.phase==='backing-up'){
   const manifest=await backupShared2Files({mount,privateRoot,adapter,listFiles,hashFile,assertCurrent:current,onProgress});
   state.files=manifest;state.phase='admitting';await persist();
  }
  await current();onProgress({phase:'admitting',done:state.files.length,total:state.files.length});
  const job=await admit(folder,state.job);await current();state.job=job.id;state.phase='admitted';await persist();await recordJob(job,state);await drainSource();return job;
 }
 function start(){if(flight)return flight;const task=run();flight=task;task.then(()=>{if(flight===task)flight=null;},()=>{if(flight===task)flight=null;});return task;}
 return {start,async resetBeforeAdmission(){await load();if(!['planned','backing-up'].includes(state.phase))throw fail('shared2-admission-may-have-started');state.phase='planned';state.files=[];await persist();await pauseEditing(false);},async snapshot(){await load();return structuredClone(state);}};
}
