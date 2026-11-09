import {safeRelative} from './folder-model.mjs';
const fail=code=>Object.assign(Error(code),{code});

/** Host lifecycle only. All revision, rename, deletion, conflict and incoming
 * content decisions remain in the maintained LiveSync services.
 * The legacy controller is used ONCE to establish the cutover baseline.
 */
export function createShared2LiveController({profile,engine,baseline,store,scan,checkLease,canUpload=()=>true,onReady=async(_result)=>{},onState=()=>{},isVerified=async(_meta)=>false,prepareEmptyMount=async()=>false}){
 let closed=false,ready=false,initialized=false,initializing,pumping,checking,live,localPrepared=false,problem='',localProblem='',progress=null,queued=0,displayLocalPending=0;
 const conflicts=new Set(),submissions=new Set();
 const valid=path=>safeRelative(path)&&path.startsWith(profile.documentRoot+'/');
 const healthy=async()=>{if(closed||await checkLease()!==true||closed)throw fail('shared2-vault-lease-rejected');};
 function notify(){onState(api.state);}
 function failed(error){if(!closed){problem=error.code||error.message||'shared2-vault-sync-failed';notify();}}
 async function applyPending(startup=false){
  if(pumping)return pumping;
  const task=(async()=>{
   for(;;){
    const pending=await store.pending();displayLocalPending=pending.length;if(!pending.length||profile.role==='viewer'||!canUpload())break;
    for(const event of pending){
    await healthy();
    const item={...event.item,restoredFromPreviousRuntime:true};
    const path=item.args.file.path;
    const redundant=startup&&['CREATE','DELETE'].includes(item.type)&&item.args.renameTarget===undefined&&
     await isVerified(await engine.metadata(path));
    if(!redundant){
     const result=await engine.files.localEvent(item);
     if(result!==true){const meta=await engine.metadata(path);if(item.type!=='DELETE'||!meta?.deleted)throw fail('shared2-file-event-incomplete');}
    }
    await store.ack(event.id);displayLocalPending=Math.max(0,displayLocalPending-1);
    }
   }
   queued=(await store.pending()).length;
   if(!queued&&localProblem&&problem===localProblem){problem='';localProblem='';}
  })();pumping=task;task.then(()=>{if(pumping===task)pumping=undefined;notify();},error=>{if(pumping===task)pumping=undefined;localProblem=error.code||error.message;failed(error);});return task;
 }
 async function reconcileLocal(full=false){
  await healthy();progress={state:'syncing',phase:'local'};notify();
  await scan({engine,full,onConflict:path=>api.conflict(path)});
  await applyPending(!full);
 }
 function startLive(){
  if(live||closed||!ready)return;
  const task=engine.startLive();live=task;
  task.then(result=>{if(live===task)live=undefined;if(!closed&&ready&&result===false)failed(fail('shared2-live-connection-interrupted'));notify();},error=>{if(live===task)live=undefined;failed(error);});
 }
 async function connect(){
  await healthy();progress={state:'syncing',phase:'exchange'};notify();
  await engine.results.restore();
  await engine.synchronize();await healthy();
  ready=true;initialized=true;problem='';progress=null;engine.results.resume();await applyPending(true);startLive();notify();
 }
 async function prepare(){
  if(!await store.prepared()){
   if(await prepareEmptyMount()){
    await healthy();
    // Persist before downloading. A restart uses the normal scanner, result
    // queue and replication checkpoint, even if the first pull was interrupted.
    await store.markPrepared();localPrepared=true;
    return connect();
   }
   const inherit=canUpload()&&await baseline.hasBaseline?.()===true;
   const result=inherit?{conflicts:[]}:await baseline.synchronize();await healthy();
   const ledger=await baseline.ledger();let done=0;const entries=Object.entries(ledger.files||{});
   for(const [relative,value] of entries){
    await healthy();progress={state:'syncing',phase:'baseline',done:done++,total:entries.length,path:relative};notify();
    if(value.hash&&value.revision){
     const path=profile.documentRoot+'/'+relative;
     if(inherit){
      // This durable old ledger records the branch previously displayed or
      // saved on THIS device. Import ancestry, not a claim that disk bytes are
      // unchanged. The normal offline pass compares current bytes to this base.
      const meta=await engine.metadata(path,value.revision);
      if(meta&&meta._rev===value.revision&&!meta.deleted&&!meta._deleted)await store.provenance.set(path,{revision:value.revision});
     }else await engine.files.adoptRevision(path,value.revision);
    }
   }
   await onReady(result);await store.markPrepared();localPrepared=!inherit;await applyPending(true);
  }
  if(!localPrepared){await reconcileLocal();localPrepared=true;}
  await connect();
 }
 const api={
  get ready(){return ready&&!closed;},get closed(){return closed;},
  baselineProgress(state){progress=state;notify();},
  get state(){
   if(problem)return {state:'error',code:problem};
   if(progress)return progress;
   const network=engine.getReplicationState?.()||{},incoming=engine.results?.state||{};
   if(initializing||checking||queued||engine.files?.pending||incoming.pending||incoming.loading||incoming.applying||['STARTED','CONNECTED'].includes(network.syncStatus))return {state:'syncing',phase:'exchange'};
   if(network.syncStatus==='ERRORED')return {state:'error',code:'shared2-live-connection-interrupted'};
   return {state:conflicts.size?'conflict':initialized?'idle':'syncing',conflicts:[...conflicts]};
  },
  get displayBacklog(){return {outgoing:displayLocalPending,incoming:engine.results.state.pending||0};},
  get activity(){return api.state.state==='syncing'?1:0;},
  reportError:failed,
  async conflict(path){const doc=await engine.metadata(path);if(doc?._conflicts?.length)conflicts.add(path);else conflicts.delete(path);notify();},
  wake(){
   if(closed)return Promise.resolve();
   if(checking)return checking;
   if(!initialized){if(initializing)return initializing;const task=prepare();initializing=task;task.then(()=>{if(initializing===task)initializing=undefined;notify();},error=>{if(initializing===task)initializing=undefined;failed(error);});return task;}
   if(problem==='shared2-live-connection-interrupted'&&!live)problem='';startLive();return applyPending();
  },
  enqueue(item){
   const task=(async()=>{
    await healthy();if(!valid(item?.args?.file?.path)||item.type==='RENAME'&&!valid(item.args.oldPath))throw fail('shared2-file-outside-document-root');
    if(profile.role==='viewer')throw fail('shared2-read-only');
    await store.append(item);queued++;displayLocalPending++;
    if(initialized&&!checking)return applyPending();
   })();submissions.add(task);task.then(()=>submissions.delete(task),()=>submissions.delete(task));return task;
  },
  synchronize(){
   if(closed)return Promise.reject(fail('shared2-vault-closed'));
   if(checking)return checking;
   if(!initialized)return api.wake().then(()=>({conflicts:[...conflicts]}));
   const task=(async()=>{
    ready=false;initialized=false;localPrepared=false;engine.results.pause();
    await engine.stopLive();if(live)await live;
    if(pumping)await pumping.catch(()=>{});
    await engine.files.drain();await reconcileLocal(true);localPrepared=true;
    await connect();return {conflicts:[...conflicts]};
   })();
   checking=task;task.then(()=>{if(checking===task)checking=undefined;notify();},error=>{if(checking===task)checking=undefined;failed(error);});return task;
  },
  ledger:()=>baseline.ledger(),
  async close(){closed=true;ready=false;engine.results.pause();await baseline.close();await engine.stopLive();await Promise.allSettled([initializing,pumping,checking,live,...submissions].filter(Boolean));await store.drain();},
 };
 return api;
}
