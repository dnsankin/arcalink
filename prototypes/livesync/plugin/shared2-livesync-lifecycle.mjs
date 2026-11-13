import {LiveSyncCouchDBReplicator} from '@arcalink/shared2-livesync-replicator';
import {resolveShared2Key} from './shared2-encryption.mjs';
import {safeRelative} from './folder-model.mjs';

const fail=code=>Object.assign(Error(code),{code});

/** Shared2 has a catalog/key-envelope admission protocol, rather than the
 * personal database's central sync-parameters document. Only that connection
 * boundary is adapted. Catch-up, live replication, progress, cancellation and
 * transfer event handling belong to the maintained LiveSync implementation.
 */
export function createShared2LiveSyncLifecycle({services,profile,openRemote,accessCheck,keyProvider,canUpload=()=>true}){
 const p=Object.freeze({...profile});
 if(p.kind!=='shared'||!['owner','editor','viewer'].includes(p.role)||!/^arcalink_s_[a-f0-9]{32}$/.test(p.database)||!/^[a-f0-9]{32}$/.test(p.folder)
  ||![p.account,p.workspace].every(value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(value))||!Number.isSafeInteger(p.generation)||p.generation<1
  ||!Number.isSafeInteger(p.keyEpoch)||p.keyEpoch<0||p.encrypted!==(p.keyEpoch>0)||!safeRelative(p.documentRoot)||typeof openRemote!=='function'||typeof accessCheck!=='function'
  ||typeof p.encrypted!=='boolean'||p.encrypted&&typeof keyProvider!=='function'||!services?.database?.localDatabase)throw fail('invalid-shared2-livesync-lifecycle');
 let closing=false,closingTask,syncTask,cleanupFailure,stopEpoch=0;const tasks=new Set();
 const track=task=>{tasks.add(task);task.then(()=>tasks.delete(task),()=>tasks.delete(task));return task;};
 async function admitted(){
  if(cleanupFailure)throw cleanupFailure;
  if(closing)throw fail('shared2-replication-closed');
  if(await accessCheck(p,'read')!==true||p.role!=='viewer'&&canUpload()&&await accessCheck(p,'write')!==true)throw fail('shared2-replication-access-denied');
  if(cleanupFailure)throw cleanupFailure;
  if(closing)throw fail('shared2-replication-closed');
 }
 class ScopedReplicator extends LiveSyncCouchDBReplicator {
  // A scoped lease must be fully retired before another attempt or readiness.
  // The upstream helper logs and suppresses close errors, which is unsafe here.
  async closeRemoteConnection(connection){try{await connection.close();}catch(error){cleanupFailure=error;throw error;}}
  async ensurePBKDF2Salt(){
   await admitted();
   // Remote encryption is configured by the scoped remote factory with this
   // same envelope. Never register shared keys in the personal global handler.
   if(p.encrypted)await resolveShared2Key(p,keyProvider);
   return true;
  }
  async checkOneShotReplicationConnectivity(settings){return this.checkReplicationConnectivity(settings,false);}
  async checkReplicationConnectivity(settings,live){
   await admitted();
   if(settings.encrypt!==p.encrypted||settings.hashAlg!=='sha1'||settings.chunkSplitterVersion!=='v1'||settings.useEden!==false||settings.remoteType!==''||settings.readChunksOnline!==false||settings.useOnlyLocalChunk!==true)throw fail('shared2-livesync-settings-mismatch');
   const remote=await openRemote(p,typeof settings.shared2ResponseObserver==='function'?{onResponse:settings.shared2ResponseObserver,onError:settings.shared2ErrorObserver}:undefined);
   try{
    if(!remote?.database||typeof remote.close!=='function')throw fail('invalid-shared2-remote');
    await admitted();
    const files=doc=>typeof doc._id==='string'&&!doc._id.startsWith('_');
    const pull={checkpoint:'target',filter:'arcalink_shared2_access/files'};
    // Keep uploads bounded independently of the larger initial download batch.
    const push={checkpoint:'source',filter:files,batch_size:8,batches_limit:1};
    // Directional checkpoints stay local, including for read-only members.
    const syncOptionBase={batch_size:!live&&settings.shared2CatchupBatch===32?32:8,batches_limit:1,...pull,pull,push};
    // The shared gateway buffers a complete JSON response and its upstream
    // read times out after 30s. Heartbeat keeps CouchDB's response open, so
    // ask it to finish each idle long poll before either side times out.
    return {db:remote.database,info:await remote.database.info(),syncOptionBase,
     syncOption:{...syncOptionBase,live:!!live,retry:!!live,heartbeat:false,timeout:15000},close:()=>remote.close()};
   }catch(error){if(typeof remote?.close==='function')try{await remote.close();}catch(closeError){cleanupFailure=closeError;throw closeError;}throw error;}
  }
 }
 const replicator=new ScopedReplicator({services,get replicationDirection(){return p.role==='viewer'||!canUpload()?'pullOnly':'sync';}});
 const settings=()=>services.setting.currentSettings();
 return {
  synchronize(){
   if(closing)return Promise.reject(fail('shared2-replication-closed'));
   if(syncTask)return syncTask;
   const epoch=stopEpoch;
   const current=()=>{if(closing||epoch!==stopEpoch)throw fail('shared2-replication-closed');};
   const task=track((async()=>{
    await admitted();current();
    async function attempt(batch){
     let tooLarge=false,otherFailure=false;
     const onResponse=(status,path)=>{if(status===413)tooLarge=true;else if(status>=400&&!(status===404&&typeof path==='string'&&path.includes('/'+p.database+'/_local/')))otherFailure=true;};
     const onError=(error,detail)=>{
      // PouchDB probes the server root for a UUID, catches the local scope
      // rejection, and falls back to the database URL as replication identity.
      if(!tooLarge&&error?.code==='shared2-remote-scope-mismatch'&&detail?.identityProbe===true)return;
      // Closing the failed attempt aborts its own outstanding HTTP requests.
      // Only those explicit shutdown aborts may be ignored after a 413.
      if(tooLarge&&error?.name==='AbortError'&&detail?.closed===true&&detail?.aborted===true)return;
      otherFailure=true;
     };
     let result,error;
     try{result=await replicator.openOneShotReplication({...settings(),shared2CatchupBatch:batch,shared2ResponseObserver:onResponse,shared2ErrorObserver:onError},false,false,'sync');}
     catch(cause){error=cause;}
     if(result===true)return {ok:true};
     return {ok:false,retry:tooLarge&&!otherFailure&&(!error||error.status===413),error};
    }
    const first=await attempt(32);
    current();if(first.ok)return;
    if(!first.retry){if(first.error)throw first.error;throw fail('shared2-replication-incomplete');}
    await admitted();current();
    const second=await attempt(8);
    current();if(second.ok)return;
    if(second.retry)throw fail('shared2-response-too-large');
    if(second.error)throw second.error;
    throw fail('shared2-replication-incomplete');
   })());
   syncTask=task;task.then(()=>{if(syncTask===task)syncTask=undefined;},()=>{if(syncTask===task)syncTask=undefined;});return task;
  },
  start(){if(closing)return Promise.reject(fail('shared2-replication-closed'));return track(replicator.openContinuousReplication(settings(),false,false));},
  get state(){return {...services.replicator.replicationStatics.value};},
  async stop(){stopEpoch++;let failure;try{await replicator.closeReplication();}catch(error){failure=error;}await Promise.allSettled([...tasks]);if(cleanupFailure)throw cleanupFailure;if(failure)throw failure;},
  close(){if(closingTask)return closingTask;closing=true;closingTask=(async()=>{let failure;try{await replicator.closeReplication();}catch(error){failure=error;}await Promise.allSettled([...tasks]);if(cleanupFailure)throw cleanupFailure;if(failure)throw failure;})();return closingTask;},
 };
}
