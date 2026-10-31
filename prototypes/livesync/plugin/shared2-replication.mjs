const fail=code=>Object.assign(Error(code),{code});
/** Bounded single-pass replication. No timers/retries/global replicator. The
 * remote factory must use the scoped gateway transport, never personal auth.
 */
export function createShared2Replication({database,profile,openRemote,accessCheck}){
 const p=Object.freeze({...profile});
 if(p.kind!=='shared'||!['owner','editor','viewer'].includes(p.role)||!database?.replicate||typeof openRemote!=='function'||typeof accessCheck!=='function')throw fail('invalid-shared2-replication');
 let closing=false,closed=false,running,active,remote,closingTask;
 async function allowed(mode){if(closing||closed)throw fail('shared2-replication-closed');if(await accessCheck(p,mode)!==true)throw fail('shared2-replication-access-denied');if(closing||closed)throw fail('shared2-replication-closed');}
 async function pass(direction){
  await allowed(direction==='to'?'write':'read');
  const operation=database.replicate[direction](remote.database,{batch_size:8,batches_limit:1,live:false,retry:false,checkpoint:direction==='from'?'target':'source',filter:direction==='from'&&p.encrypted?'arcalink_shared2_access/files':doc=>typeof doc._id==='string'&&!doc._id.startsWith('_')});
  active=operation;
  try{const result=await operation;if(closing||result?.status==='cancelled')throw fail('shared2-replication-cancelled');if(result?.errors?.length||result?.ok===false)throw fail('shared2-replication-incomplete');return result;}
  finally{if(active===operation)active=undefined;}
 }
 function synchronize(){
  if(closing||closed)return Promise.reject(fail('shared2-replication-closed'));
  if(running)return running;
  const task=(async()=>{
   await allowed('read');
   if(!remote){const opened=await openRemote(p);remote=opened;if(!remote?.database||typeof remote.close!=='function')throw fail('invalid-shared2-remote');}
   const pull=await pass('from');const push=p.role==='viewer'?null:await pass('to');return {pull,push};
  })();
  running=task;task.then(()=>{if(running===task)running=undefined},()=>{if(running===task)running=undefined});return task;
 }
 function close(){
  if(closed)return Promise.resolve();if(closingTask)return closingTask;closing=true;
  const task=(async()=>{active?.cancel();if(running)await Promise.allSettled([running]);if(remote)await remote.close();remote=undefined;closed=true;})();
  closingTask=task;task.catch(()=>{if(closingTask===task)closingTask=undefined});return task;
 }
 return {synchronize,close};
}
