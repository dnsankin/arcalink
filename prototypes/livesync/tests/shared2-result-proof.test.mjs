import test from 'node:test';
import assert from 'node:assert/strict';
import {createShared2ResultRuntime} from '../plugin/shared2-result-runtime.mjs';
test('result application errors block proof until a fresh reprocess and successful application',async()=>{
 let processor,fail=true;const values=new Map(),errors=[];
 class Processor{
  constructor(context){this.context=context;this.queue=[];processor=this;}
  async parseDocumentChange(change){await this.context.services.replication.processSynchroniseResult(change);}
  enqueueAll(docs){this.queue.push(...docs);}
  async reprocessStoredDocuments(){this.queue=[{_id:'doc',type:'plain',path:'Root/a.md'}];}
  async run(){const next=this.queue.shift();if(next)await this.parseDocumentChange(next);}
  async _takeSnapshot(){await this.context.getKeyValueDB().set('replicationResultProcessorSnapshot',{queued:this.queue,processing:[]});}
  resume(){}suspend(){}async restoreFromSnapshotOnce(){}async disposeContentRetries(){}
 }
 const runtime=createShared2ResultRuntime({ResultProcessor:Processor,services:{database:{localDatabase:{localDatabase:{name:'local'}}},setting:{currentSettings:()=>({})},path:{}},files:{incoming:async()=>{if(fail)throw Error('disk-failed');return true;},drain:async()=>{}},keyValueDB:{get:async k=>values.get(k),set:async(k,v)=>values.set(k,v)},documentRoot:'Root',assertCurrent:async()=>true,retire:()=>{},onError:error=>errors.push(error)});
 await runtime.reprocessStoredDocuments();await processor.run();assert.ok(errors.length>=1);await assert.rejects(runtime.confirmDrained(),/disk-failed/);
 fail=false;await runtime.reprocessStoredDocuments();await assert.rejects(runtime.confirmDrained(),/results-pending/);await processor.run();assert.equal(await runtime.confirmDrained(),true);await runtime.close();
});

test('polling an unchanged queue writes zero snapshots and a torn final write blocks readiness',async()=>{
 const key='replicationResultProcessorSnapshot',values=new Map();let processor,writes=0,failNext=false;
 class Processor{
  constructor(context){this.context=context;this.queue=[];processor=this;}
  reportStatus(){this.context.services.replication.replicationResultCount.value=this.queue.length;}
  async restoreFromSnapshotOnce(){const snap=await this.context.getKeyValueDB().get(key);this.queue=snap?.queued||[];}
  async _takeSnapshot(){await this.context.getKeyValueDB().set(key,{queued:this.queue,processing:[]});}
  enqueueAll(docs){this.queue.push(...docs);}
  suspend(){}async disposeContentRetries(){}
 }
 const create=()=>createShared2ResultRuntime({ResultProcessor:Processor,services:{database:{localDatabase:{localDatabase:{name:'local'}}},setting:{currentSettings:()=>({})},path:{}},files:{incoming:async()=>true,drain:async()=>{}},keyValueDB:{get:async k=>structuredClone(values.get(k)),set:async(k,v)=>{writes++;if(failNext){failNext=false;throw Error('torn-write');}values.set(k,v);}},documentRoot:'Root',assertCurrent:async()=>true,persistAdmission:()=>true,retire:()=>{},onError:()=>{}});
 let runtime=create();await runtime.restore();
 for(let i=0;i<100;i++)await runtime.confirmDrained();
 assert.equal(writes,0);
 await runtime.receive([{_id:'doc',type:'plain',path:'Root/a'}]);
 for(let i=0;i<100;i++)await assert.rejects(runtime.confirmDrained(),/results-pending/);
 assert.equal(writes,1);
 processor.queue=[];failNext=true;await assert.rejects(runtime.confirmDrained(),/torn-write/);
 runtime=create();await runtime.restore();assert.equal(processor.queue.length,1);
 processor.queue=[];await runtime.confirmDrained();const stable=writes;
 for(let i=0;i<100;i++)await runtime.confirmDrained();
 assert.equal(writes,stable);await runtime.close();
});

test('process death during a snapshot restores the last verified queue with a later edit intact',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 const {createShared2RuntimeStore}=await import('../plugin/shared2-runtime-store.mjs');
 const {createFolderPolicyStore}=await import('../plugin/folder-policy-store.mjs');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'shared2-torn-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const base=path.join(directory,'runtime'),profile={folder:'scope',cacheEpoch:'epoch'},mount='Local';
 const create=()=>{
  const adapter={exists:file=>fs.access(file).then(()=>true,()=>false),read:file=>fs.readFile(file,'utf8'),write:(file,body)=>fs.writeFile(file,body)};
  const slots=createFolderPolicyStore(adapter,base);
  return createShared2RuntimeStore({profile,mount,store:{load:async()=>{const state=await slots.read();return state.protocol?state:null;},save:value=>slots.update(()=>value)}});
 };
 const runtime=create(),file={path:'Root/old.bin'},item=type=>({type,args:{file}});
 const deleted=await runtime.append(item('DELETE')),created=await runtime.append(item('CREATE'));
 assert.equal(await runtime.ackSequence(file.path,[deleted,created],async()=>true),true);
 const newer=await runtime.append(item('CHANGED'));
 const key='shared2:db:replicationResultProcessorSnapshot',snapshot={queued:[{_id:'incoming'}],processing:[]};
 await runtime.kv.set(key,snapshot);
 const script=`
  import fs from 'node:fs/promises';
  import {createFolderPolicyStore} from ${JSON.stringify(new URL('../plugin/folder-policy-store.mjs',import.meta.url).href)};
  const journal=createFolderPolicyStore({
   exists:p=>fs.access(p).then(()=>true,()=>false),read:p=>fs.readFile(p,'utf8'),
   write:async(p,body)=>{await fs.writeFile(p,body.slice(0,body.length/2));process.kill(process.pid,'SIGKILL');}
  },process.argv[1]);
  await journal.update(s=>({...s,values:{...s.values,[process.argv[2]]:{queued:[],processing:[]}}}));
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script,base,key]);
 assert.equal(child.signal,'SIGKILL');
 const reopened=create();
 assert.deepEqual((await reopened.pending()).map(e=>e.id),[newer]);
 assert.deepEqual(await reopened.kv.get(key),snapshot);
});

test('an incoming batch awaiting the lease already prevents proof of an empty queue',async()=>{
 let release;
 const lease=new Promise(resolve=>{release=resolve;});
 class Processor{
  constructor(ctx){this.ctx=ctx;}
  async restoreFromSnapshotOnce(){await this.ctx.getKeyValueDB().get('replicationResultProcessorSnapshot');}
  reportStatus(){}enqueueAll(){}suspend(){}async disposeContentRetries(){}
 }
 const runtime=createShared2ResultRuntime({ResultProcessor:Processor,services:{database:{localDatabase:{localDatabase:{name:'db'}}},setting:{currentSettings:()=>({})},path:{}},files:{incoming:async()=>true,drain:async()=>{}},keyValueDB:{get:async()=>undefined,set:async()=>{}},documentRoot:'Root',assertCurrent:()=>lease,retire:()=>{},onError:()=>{}});
 await runtime.restore();
 const incoming=runtime.receive([{_id:'h:chunk',type:'leaf'}]);
 await assert.rejects(runtime.confirmDrained(),/results-pending/);
 release(true);await incoming;assert.equal(await runtime.confirmDrained(),true);await runtime.close();
});
