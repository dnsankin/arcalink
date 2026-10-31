import {safeRelative} from './folder-model.mjs';
import {folderContains} from './folder-exclusions.mjs';

const fail=code=>Object.assign(Error(code),{code});
const copy=value=>JSON.parse(JSON.stringify(value));
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const id=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(value);
const db=(value,prefix)=>typeof value==='string'&&new RegExp('^arcalink_'+prefix+'_[a-f0-9]{32}$').test(value);

/** Validate only non-secret catalog/routing metadata, never connection passwords. */
export function routingSnapshot(input,scope){
 if(!input||input.protocol!==2||input.account!==scope.account||input.workspace!==scope.workspace||!identity(input.account)||!identity(input.workspace)||!integer(input.revision)
   ||!input.personal||!db(input.personal.database,'p')||!integer(input.personal.generation,1)||!Array.isArray(input.folders)||input.folders.length>1000)throw fail('invalid-shared2-catalog');
 const folders=[],used=new Set();
 for(const row of input.folders){
  if(!row||!id(row.id)||used.has(row.id)||!db(row.database,'s')||!integer(row.generation,1)||!integer(row.revision)||!safeRelative(row.mount)||!safeRelative(row.documentRoot)
    ||!['owner','editor','viewer'].includes(row.role)||!['active','migrating','revoked'].includes(row.phase)||typeof row.encrypted!=='boolean'||!integer(row.keyEpoch,row.encrypted?1:0)||(!row.encrypted&&row.keyEpoch!==0))throw fail('invalid-shared2-mount');
  if(folders.some(old=>old.database===row.database||folderContains(old.mount,row.mount)||folderContains(row.mount,old.mount)))throw fail('overlapping-shared2-mount');
  used.add(row.id);
  folders.push({id:row.id,database:row.database,generation:row.generation,revision:row.revision,mount:row.mount,documentRoot:row.documentRoot,role:row.role,phase:row.phase,encrypted:row.encrypted,keyEpoch:row.keyEpoch});
 }
 folders.sort((a,b)=>a.id.localeCompare(b.id));
 return {protocol:2,account:input.account,workspace:input.workspace,revision:input.revision,personal:{database:input.personal.database,generation:input.personal.generation},folders};
}

/** Isolated routing coordinator; integration must supply a generation-aware engine.
 * No production engine hooks are installed by this module. A server write fence
 * remains mandatory: local checks cannot stop an offline client on another device.
 */
export function createShared2Router({store,scope,connector,quiesce,keysReady=()=>false}){
 scope={account:scope.account,workspace:scope.workspace};
 if(typeof quiesce!=='function')throw fail('shared2-quiesce-required');
 let current=null,updating=false,fault=null,queue=Promise.resolve();
 const running=new Set();
 function healthy(){if(fault)throw fail('shared2-routing-paused');if(updating)throw fail('shared2-catalog-switching');if(!current)throw fail('shared2-catalog-not-ready');}
 function route(path,mode='read'){
  healthy();if(!safeRelative(path)||!['read','write'].includes(mode))throw fail('invalid-shared2-path');
  const row=current.folders.find(row=>folderContains(row.mount,path));
  const common={account:current.account,workspace:current.workspace,catalogRevision:current.revision};
  if(!row)return Object.freeze({...common,kind:'personal',database:current.personal.database,generation:current.personal.generation,path});
  if(row.phase!=='active')throw fail(row.phase==='revoked'?'shared2-access-revoked':'shared2-folder-migrating');
  if(mode==='write'&&row.role==='viewer')throw fail('shared2-read-only');
  if(row.encrypted&&keysReady(row.id,row.keyEpoch)!==true)throw fail('shared2-key-unavailable');
  // Remove the local mount by segment count, preserving the descendant spelling.
  const relative=path.split('/').slice(row.mount.split('/').length).join('/');
  return Object.freeze({...common,kind:'shared',folder:row.id,database:row.database,generation:row.generation,revision:row.revision,
    keyEpoch:row.keyEpoch,encrypted:row.encrypted,role:row.role,relative,path:row.documentRoot+(relative?'/'+relative:'')});
 }
 function load(){
  const job=queue.then(async()=>{
   if(current||running.size||updating)throw fail('shared2-router-already-loaded');
   updating=true;
   try{const saved=await store.read();if(Object.keys(saved).length)current=routingSnapshot(saved,scope);fault=null;}
   catch(error){fault=error;throw error;}
   finally{updating=false;}
  });
  queue=job.catch(()=>{});return job;
 }
 function apply(input){
  // Snapshot the response before queueing so caller mutation cannot change scope.
  const incoming=copy(input);
  const job=queue.then(async()=>{
   updating=true;
   try{
    const next=routingSnapshot(incoming,scope);
    if(current&&(next.revision<current.revision||(next.revision===current.revision&&JSON.stringify(next)!==JSON.stringify(current))))throw fail('stale-shared2-catalog');
    if(current){
     if(next.personal.generation<current.personal.generation||(next.personal.database!==current.personal.database&&next.personal.generation<=current.personal.generation))throw fail('stale-shared2-generation');
     for(const old of current.folders){
      const row=next.folders.find(row=>row.id===old.id);
      // Removal requires a separate reverse-migration/leave handshake. Retain
      // a revoked mount meanwhile; do not let it fall through to personal sync.
      if(!row)throw fail('shared2-removal-handshake-required');
      if(row.generation<old.generation||row.revision<old.revision||(row.database!==old.database&&row.generation<=old.generation)
        ||(row.encrypted&&old.encrypted&&row.keyEpoch<old.keyEpoch))throw fail('stale-shared2-generation');
     }
    }
    await Promise.allSettled([...running]);
    await quiesce(); // Caller must stop legacy personal/shared workers too.
    await store.update(()=>next);
    current=next;fault=null;
    return copy(next);
   }catch(error){fault=error;throw error;}
   finally{updating=false;}
  });
  queue=job.catch(()=>{});return job;
 }
 function perform(mode,path,value){
  let lease;try{lease=route(path,mode);}catch(error){return Promise.reject(error);}
  const task=Promise.resolve().then(async()=>{
   await connector.ready(lease);
   healthy();
   if(route(path,mode).catalogRevision!==lease.catalogRevision)throw fail('stale-shared2-route');
   // Database/generation/revision travel with every call. Connector/gateway must
   // enforce them on the server; never silently retry via the personal database.
   return mode==='read'?connector.read(lease):connector.write(lease,value);
  });
  running.add(task);task.then(()=>running.delete(task),()=>running.delete(task));return task;
 }
 return {load,apply,route,read:path=>perform('read',path),write:(path,value)=>perform('write',path,value),
  state:()=>({ready:!!current&&!fault&&!updating,paused:!!fault,updating,pending:running.size,catalog:current?copy(current):null})};
}
