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
 let closing=false,closingTask;const tasks=new Set();
 const track=task=>{tasks.add(task);task.then(()=>tasks.delete(task),()=>tasks.delete(task));return task;};
 async function admitted(){
  if(closing)throw fail('shared2-replication-closed');
  if(await accessCheck(p,'read')!==true||p.role!=='viewer'&&canUpload()&&await accessCheck(p,'write')!==true)throw fail('shared2-replication-access-denied');
  if(closing)throw fail('shared2-replication-closed');
 }
 class ScopedReplicator extends LiveSyncCouchDBReplicator {
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
   const remote=await openRemote(p);
   try{
    if(!remote?.database||typeof remote.close!=='function')throw fail('invalid-shared2-remote');
    await admitted();
    const files=doc=>typeof doc._id==='string'&&!doc._id.startsWith('_');
    const pull={checkpoint:'target',filter:p.encrypted?'arcalink_shared2_access/files':files};
    const push={checkpoint:'source',filter:files};
    // Directional checkpoints stay local, including for read-only members.
    const syncOptionBase={batch_size:8,batches_limit:1,...pull,pull,push};
    // The shared gateway buffers a complete JSON response and its upstream
    // read times out after 30s. Heartbeat keeps CouchDB's response open, so
    // ask it to finish each idle long poll before either side times out.
    return {db:remote.database,info:await remote.database.info(),syncOptionBase,
     syncOption:{...syncOptionBase,live:!!live,retry:!!live,heartbeat:false,timeout:15000},close:()=>remote.close()};
   }catch(error){if(typeof remote?.close==='function')await remote.close();throw error;}
  }
 }
 const replicator=new ScopedReplicator({services,get replicationDirection(){return p.role==='viewer'||!canUpload()?'pullOnly':'sync';}});
 const settings=()=>services.setting.currentSettings();
 return {
  synchronize(){return track((async()=>{await admitted();if(await replicator.openOneShotReplication(settings(),false,false,'sync')!==true)throw fail('shared2-replication-incomplete');})());},
  start(){if(closing)return Promise.reject(fail('shared2-replication-closed'));return track(replicator.openContinuousReplication(settings(),false,false));},
  get state(){return {...services.replicator.replicationStatics.value};},
  async stop(){await replicator.closeReplication();await Promise.allSettled([...tasks]);},
  close(){if(closingTask)return closingTask;closing=true;closingTask=(async()=>{await replicator.closeReplication();await Promise.allSettled([...tasks]);})();return closingTask;},
 };
}
