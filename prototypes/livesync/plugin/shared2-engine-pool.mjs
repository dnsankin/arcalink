import {safeRelative} from './folder-model.mjs';
/** Isolated engine lifecycle coordinator. A real engine factory and generation-
 * aware access check are mandatory; no fallback to the personal global engine.
 */
const fail=code=>Object.assign(Error(code),{code});
function profile(lease){
 if(lease?.cacheEpoch!==undefined&&!/^[a-f0-9]{32}$/.test(lease.cacheEpoch))throw fail('invalid-shared2-cache-epoch');
 const identity=v=>typeof v==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(v);
 const number=v=>Number.isSafeInteger(v)&&v>=0;
 if(!lease||!identity(lease.account)||!identity(lease.workspace)||!['personal','shared'].includes(lease.kind)
   ||typeof lease.database!=='string'||!new RegExp('^arcalink_'+(lease.kind==='shared'?'s':'p')+'_[a-f0-9]{32}$').test(lease.database)
   ||!safeRelative(lease.path)||!number(lease.generation)||lease.generation<1||!number(lease.catalogRevision))throw fail('invalid-shared2-engine-lease');
 if(lease.kind==='shared'&&(!/^[a-f0-9]{32}$/.test(lease.folder)||!number(lease.revision)||!number(lease.keyEpoch)||!['owner','editor','viewer'].includes(lease.role)||typeof lease.encrypted!=='boolean'||(lease.encrypted?lease.keyEpoch<1:lease.keyEpoch!==0)))throw fail('invalid-shared2-engine-lease');
 return Object.freeze({account:lease.account,workspace:lease.workspace,kind:lease.kind,database:lease.database,generation:lease.generation,catalogRevision:lease.catalogRevision,
  ...(lease.cacheEpoch?{cacheEpoch:lease.cacheEpoch}:{}),...(lease.kind==='shared'?{folder:lease.folder,revision:lease.revision,keyEpoch:lease.keyEpoch,role:lease.role,encrypted:lease.encrypted}:{})});
}
export function createShared2EnginePool({openEngine,accessCheck}){
 if(typeof openEngine!=='function'||typeof accessCheck!=='function')throw fail('shared2-engine-factory-required');
 const slots=new Map(),pending=new Set();let epoch=0,retiring=false,disposed=false,closing;
 const healthy=()=>{if(disposed||retiring)throw fail('shared2-engines-paused');};
 function tracked(task){const run=Promise.resolve().then(task);pending.add(run);run.then(()=>pending.delete(run),()=>pending.delete(run));return run;}
 async function allowed(lease,mode,started){
  healthy();if(lease.kind==='shared'&&mode==='write'&&lease.role==='viewer')throw fail('shared2-read-only');
  if(await accessCheck(lease,mode)!==true)throw fail('shared2-engine-access-denied');
  healthy();if(epoch!==started)throw fail('stale-shared2-engine');
 }
 function ready(lease){
  let request,config;try{healthy();request=Object.freeze({...lease});config=profile(request);}catch(error){return Promise.reject(error);}
  const key=JSON.stringify(config),started=epoch;
  return tracked(async()=>{
   await allowed(request,'read',started);
   let slot=slots.get(key);
   if(!slot){
    slot={config,engine:null,closed:false};slots.set(key,slot);
    slot.opening=Promise.resolve().then(()=>openEngine(config)).then(async engine=>{
     slot.engine=engine;
     if(!engine||!['read','write','close'].every(method=>typeof engine[method]==='function')){
      if(typeof engine?.close==='function'){try{await engine.close();slot.closed=true;}catch(error){retiring=true;throw error;}}
      else if(engine)retiring=true;
      throw fail('invalid-shared2-engine');
     }
     return engine;
    });
    slot.opening.catch(()=>{if(slots.get(key)===slot&&(!slot.engine||slot.closed))slots.delete(key);});
   }
   await slot.opening;
   healthy();if(epoch!==started)throw fail('stale-shared2-engine');
  });
 }
 function operate(mode,lease,value){
  let request,config;try{healthy();request=Object.freeze({...lease});config=profile(request);}catch(error){return Promise.reject(error);}
  const key=JSON.stringify(config),started=epoch;
  return tracked(async()=>{
   await allowed(request,mode==='remove'?'write':['inspect','readRevision'].includes(mode)?'read':mode,started);
   const slot=slots.get(key);
   if(!slot||slot.closed)throw fail('shared2-engine-not-ready');
   const engine=await slot.opening;
   healthy();if(epoch!==started)throw fail('stale-shared2-engine');
   if(mode==='inspect'){if(typeof engine.inspect!=='function')throw fail('shared2-inspection-not-configured');return engine.inspect();}
   if(mode==='remove'){if(typeof engine.remove!=='function')throw fail('shared2-removal-not-configured');return engine.remove(request.path,value);}
   if(mode==='readRevision'){if(typeof engine.readRevision!=='function')throw fail('shared2-revision-not-configured');return engine.readRevision(request.path,value);}
   if(mode==='synchronize'){if(typeof engine.synchronize!=='function')throw fail('shared2-replication-not-configured');return engine.synchronize();}
   return mode==='read'?engine.read(request.path):engine.write(request.path,value);
  });
 }
 function quiesce(){
  if(closing)return closing;
  retiring=true;epoch++;
  const run=(async()=>{
   await Promise.allSettled([...pending]);
   for(const slot of slots.values())if(slot.engine&&!slot.closed){await slot.engine.close();slot.closed=true;}
   slots.clear();retiring=false;
  })();
  closing=run;run.then(()=>{if(closing===run)closing=undefined;},()=>{if(closing===run)closing=undefined;});
  return run;
 }
 async function dispose(){disposed=true;await quiesce();}
 return {ready,read:lease=>operate('read',lease),write:(lease,value)=>operate('write',lease,value),remove:(lease,value)=>operate('remove',lease,value),readRevision:(lease,revision)=>operate('readRevision',lease,revision),inspect:lease=>operate('inspect',lease),synchronize:lease=>operate('synchronize',lease),quiesce,dispose,
  state:()=>({engines:slots.size,pending:pending.size,paused:retiring||disposed,epoch})};
}
