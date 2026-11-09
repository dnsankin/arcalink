import {safeRelative} from './folder-model.mjs';

const fail=code=>Object.assign(Error(code),{code});

/** Adapt the personal plugin's maintained ReplicateResultProcessor, supplied
 * by the host. It owns chunk readiness, retries and persisted pending results.
 * This scope owns only admission, lifecycle and the destination file handler.
 */
export function createShared2ResultRuntime({ResultProcessor,services,files,keyValueDB,documentRoot,assertCurrent,isReady=()=>true,isOnline=()=>true,retire,onError}){
 const scope=services?.database?.localDatabase?.localDatabase?.name;
 if(typeof ResultProcessor!=='function'||!services?.database?.localDatabase||!files?.incoming||!keyValueDB?.get||!keyValueDB?.set||!safeRelative(documentRoot)
  ||typeof scope!=='string'||!scope||scope.length>512||typeof assertCurrent!=='function'||typeof retire!=='function'||typeof onError!=='function')throw fail('invalid-shared2-result-runtime');
 let closing=false,retired=false,closingTask,lastWriteError,writeTail=Promise.resolve();const active=new Set();
 // A retired processor can still have a throttled snapshot callback scheduled
 // by upstream. Fence it so it cannot overwrite a replacement scope's state.
 const snapshotStore={
  async get(key){await writeTail;if(lastWriteError)throw lastWriteError;return keyValueDB.get('shared2:'+scope+':'+key);},
  set(key,value){
   if(retired)return Promise.resolve();
   const snapshot=structuredClone(value),task=writeTail.then(()=>{if(!retired)return keyValueDB.set('shared2:'+scope+':'+key,snapshot);});
   writeTail=task.then(()=>{lastWriteError=undefined;},error=>{lastWriteError=error;});return task;
  }
 };
 const inside=path=>safeRelative(path)&&path.startsWith(documentRoot+'/');
 const replication={replicationResultCount:{value:0},databaseQueueCount:{value:0},storageApplyingCount:{value:0},
  processVirtualDocument:async()=>false,processOptionalSynchroniseResult:async()=>false,
  processSynchroniseResult:async entry=>{try{const result=await files.incoming(entry);if(result!==true)onError(fail('shared2-file-apply-incomplete'));return result;}catch(error){onError(error);throw error;}}};
 class ScopedResults extends ResultProcessor {
  parseDocumentChange(change){
   // The upstream dispatcher intentionally starts this asynchronously. Track
   // those exact tasks so database retirement drains application as well.
   const task=Promise.resolve().then(()=>super.parseDocumentChange(change)).catch(onError);
   active.add(task);task.then(()=>active.delete(task),()=>active.delete(task));return task;
  }
 }
 const processor=new ScopedResults({
  currentSettings:()=>services.setting.currentSettings(),getKeyValueDB:()=>snapshotStore,
  getLocalDatabase:()=>services.database.localDatabase,requestActiveReplicatorRetirement:retire,
  runLocalApplicationActivity:async task=>task(),
  services:{API:{get isOnline(){return isOnline();}},path:services.path,replication,
   database:{isDatabaseReady:()=>!closing},appLifecycle:{isReady:()=>!closing&&isReady(),isSuspended:()=>closing},
   vault:{isTargetFile:async path=>inside(path),isValidPath:inside,isFileSizeTooLarge:()=>false}}
 });
 return {
  snapshotKey:'shared2:'+scope+':replicationResultProcessorSnapshot',
  async receive(docs){
   if(closing)throw fail('shared2-result-runtime-closed');
   if(await assertCurrent()!==true)throw fail('shared2-result-runtime-access-denied');
   if(closing)throw fail('shared2-result-runtime-closed');
   if(!Array.isArray(docs)||docs.some(doc=>!doc||typeof doc._id!=='string'||['plain','newnote'].includes(doc.type)&&!inside(doc.path)))throw fail('invalid-shared2-replicated-documents');
   processor.enqueueAll(structuredClone(docs));return true;
  },
  async restore(){if(closing)throw fail('shared2-result-runtime-closed');await processor.restoreFromSnapshotOnce();},
  resume(){if(!closing)processor.resume();},
  pause(){processor.suspend();},
  get state(){return {pending:replication.replicationResultCount.value,loading:replication.databaseQueueCount.value,applying:replication.storageApplyingCount.value};},
  close(){
   if(closingTask)return closingTask;closing=true;processor.suspend();
   const task=(async()=>{
    // Flush the dispatcher's already-admitted semaphore continuation. New
    // dispatches see the suspended state; active work finishes before snapshot.
    await Promise.resolve();while(active.size)await Promise.allSettled([...active]);
    await files.drain();await processor.disposeContentRetries();await writeTail;if(lastWriteError)throw lastWriteError;retired=true;
   })();closingTask=task;task.catch(()=>{if(closingTask===task)closingTask=undefined;});return task;
  }
 };
}
