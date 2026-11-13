import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {shared2ProductionPlugin} from '../scripts/shared2-production-build.mjs';
import {patchScopedLiveSync} from '../scripts/patch-scoped-livesync.mjs';

const source=fileURLToPath(new URL('../.cache/source/',import.meta.url));
const require=createRequire(source+'esbuild.config.mjs');
const output=await require('esbuild').build({
 stdin:{contents:`
  export {LiveSyncCouchDBReplicator as SharedReplicator} from '@arcalink/shared2-livesync-replicator';
  export {LiveSyncCouchDBReplicator as PersonalReplicator} from '@vrtmrz/livesync-commonlib/compat/replication/couchdb/LiveSyncReplicator';
  export {createShared2LocalEngineFactory} from '../../plugin/shared2-local-engine.mjs';
  export {createShared2LiveSyncLifecycle} from '../../plugin/shared2-livesync-lifecycle.mjs';
  export {createShared2ScopedStorage} from '../../plugin/shared2-file-runtime.mjs';
  export {createShared2ResultRuntime} from '../../plugin/shared2-result-runtime.mjs';
  export {configureShared2Encryption} from '../../plugin/shared2-encryption.mjs';
  export {ReplicateResultProcessor} from './src/serviceFeatures/replication/ReplicateResultProcessor';
  import PouchDB from 'pouchdb-core';
  import Memory from 'pouchdb-adapter-memory';
  import Replication from 'pouchdb-replication';
  import Transform from 'transform-pouch';
  PouchDB.plugin(Memory).plugin(Replication).plugin(Transform);
  export const createDB=name=>new PouchDB(name,{adapter:'memory'});
 `,resolveDir:source},
 bundle:true,write:false,format:'cjs',platform:'node',
 plugins:[shared2ProductionPlugin(),{name:'headless-translation',setup(build){
  build.onResolve({filter:/^@\/common\/translation$/},()=>({path:'translation',namespace:'headless'}));
  build.onLoad({filter:/.*/,namespace:'headless'},()=>({contents:'export const $msg=key=>key;',loader:'js'}));
 }}],tsconfig:source+'tsconfig.json',nodePaths:[source+'node_modules'],external:['obsidian']
});
const Module=require('node:module'),mod=new Module('shared2-livesync-runtime');
mod.filename=source+'shared2-livesync-runtime.cjs';mod.paths=Module._nodeModulePaths(source);
mod._compile(output.outputFiles[0].text,mod.filename);
const {SharedReplicator,PersonalReplicator,createDB,createShared2LocalEngineFactory,createShared2LiveSyncLifecycle,createShared2ScopedStorage,createShared2ResultRuntime,ReplicateResultProcessor,configureShared2Encryption}=mod.exports;

function fixture(t,Replicator=SharedReplicator,direction=undefined){
 const local=createDB('local-'+crypto.randomUUID()),remote=createDB('remote-'+crypto.randomUUID()),received=[];
 t.after(async()=>{await local.destroy();await remote.destroy();});
 const services={
  context:{translate:key=>key},
  API:{isMobile:()=>false},
  database:{localDatabase:{localDatabase:local}},
  setting:{currentSettings:()=>({batch_size:8,batches_limit:1})},
  replicator:{replicationStatics:{value:{}},runFiniteReplicationActivity:task=>task()},
  replication:{parseSynchroniseResult:async docs=>received.push(...docs)}
 };
 const replicator=new Replicator({services,replicationDirection:direction});
 // Only the admission/connection boundary is injected. The stock finite/live
 // lifecycle, PouchDB transfer, event handling and cancellation execute intact.
 replicator.ensurePBKDF2Salt=async()=>true;
 const connection=async(_settings,live)=>({
  db:remote,info:await remote.info(),
  syncOptionBase:{batch_size:8,batches_limit:1},
  syncOption:{batch_size:8,batches_limit:1,live,retry:false},
  close:async()=>{}
 });
 replicator.checkOneShotReplicationConnectivity=connection;
 replicator.checkReplicationConnectivity=connection;
 t.after(()=>replicator.closeReplication());
 return {local,remote,replicator,received,services};
}

async function waitFor(predicate){
 const deadline=Date.now()+5000;
 while(!await predicate()){
  if(Date.now()>deadline)throw Error('LiveSync state did not converge');
  await new Promise(resolve=>setTimeout(resolve,10));
 }
}
async function exists(db,id){
 try{return await db.get(id);}catch(error){if(error.status===404)return null;throw error;}
}

test('shared scope patch fails closed on changed or already patched engine',()=>{
 assert.throws(()=>patchScopedLiveSync('unrecognized engine'),/scope boundary/);
 const pinned=readFileSync(require.resolve('@vrtmrz/livesync-commonlib/compat/replication/couchdb/LiveSyncReplicator'),'utf8');
 assert.throws(()=>patchScopedLiveSync(patchScopedLiveSync(pinned)),/scope boundary/);
 assert.notEqual(SharedReplicator,PersonalReplicator);
 assert.match(SharedReplicator.prototype.runOneShotReplication.toString(),/shared2:oneShotReplication/);
 assert.doesNotMatch(PersonalReplicator.prototype.runOneShotReplication.toString(),/shared2:oneShotReplication/);
});

test('two shared databases and the personal engine run finite transfers concurrently',async t=>{
 const a=fixture(t),b=fixture(t),personal=fixture(t,PersonalReplicator);
 for(const [i,x] of [a,b,personal].entries())await x.local.put({_id:'same-path',value:i});
 const result=await Promise.all([a,b,personal].map(x=>x.replicator.openOneShotReplication({},false,false,'sync')));
 assert.deepEqual(result,[true,true,true]);
 for(const [i,x] of [a,b,personal].entries())assert.equal((await x.remote.get('same-path')).value,i);
});

test('stock LiveSync continuously exchanges changes and stops only its own scope',async t=>{
 const a=fixture(t),b=fixture(t);
 const first=a.replicator.openContinuousReplication({},false,false);
 const second=b.replicator.openContinuousReplication({},false,false);
 await waitFor(()=>a.replicator.controller&&b.replicator.controller);
 await a.local.put({_id:'local-a',value:'A'});
 await b.remote.put({_id:'remote-b',value:'B'});
 await waitFor(async()=>await exists(a.remote,'local-a')&&await exists(b.local,'remote-b'));
 assert.ok(b.received.some(doc=>doc._id==='remote-b'));
 assert.equal(await exists(a.local,'remote-b'),null);
 await a.replicator.closeReplication();await first;
 assert.equal(b.replicator.controller.signal.aborted,false);
 await b.remote.put({_id:'after-a-stops',value:'still live'});
 await waitFor(()=>exists(b.local,'after-a-stops'));
 await b.replicator.closeReplication();await second;
});

test('viewer uses the same LiveSync lifecycle with pull-only finite and live transfers',async t=>{
 const viewer=fixture(t,SharedReplicator,'pullOnly');
 await viewer.local.put({_id:'local-draft',value:'kept on this device'});
 await viewer.remote.put({_id:'published',value:'server'});
 assert.equal(await viewer.replicator.openOneShotReplication({},false,false,'sync'),true);
 assert.equal(await exists(viewer.remote,'local-draft'),null);
 assert.equal((await viewer.local.get('published')).value,'server');
 const live=viewer.replicator.openContinuousReplication({},false,false);
 await waitFor(()=>viewer.replicator.controller);
 await viewer.local.put({_id:'another-local-draft',value:'private draft'});
 await viewer.remote.put({_id:'next-version',value:'incoming'});
 await waitFor(()=>exists(viewer.local,'next-version'));
 assert.equal(await exists(viewer.remote,'another-local-draft'),null);
 const removed=await viewer.remote.get('published');await viewer.remote.remove(removed);
 await waitFor(async()=>!await exists(viewer.local,'published'));
 await viewer.replicator.closeReplication();await live;
 assert.equal((await viewer.local.get('local-draft')).value,'kept on this device');
});

test('actual shared local-engine factory catches up and stays live through the scoped admission adapter',async t=>{
 const remoteName='factory-remote-'+crypto.randomUUID(),remote=createDB(remoteName),engines=[],received=[];
 await remote.put({_id:'_design/arcalink_shared2_access',filters:{files:"function(doc){return doc._id.charAt(0)!=='_';}"}});
 const profile={kind:'shared',account:'test',workspace:'stand',folder:'a'.repeat(32),database:'arcalink_s_'+'a'.repeat(32),generation:1,keyEpoch:0,encrypted:false,role:'editor',documentRoot:'Shared'};
 let allowed=true,connections=0,closed=0;
 t.after(async()=>{for(const engine of engines)await engine.close();await remote.destroy();});
 async function client(role='editor'){
  const factory=createShared2LocalEngineFactory({
   namespace:'shared2-live-'+crypto.randomUUID(),createPouchDB:(name,options)=>createDB(name),
   settingsFor:async p=>({database:p.database,generation:p.generation,settings:{hashAlg:'sha1',chunkSplitterVersion:'v1',useEden:false,disableWorkerForGeneratingChunks:true}}),
   lifecycle:'livesync',createLiveSyncLifecycle:createShared2LiveSyncLifecycle,
   accessCheck:async()=>allowed,
   // The memory adapter shares its backend between handles. Closing a network
   // lease must not close that stand-in server for the other client's lease.
   openRemote:async()=>{connections++;let retired=false;return {database:remote,close:async()=>{assert.equal(retired,false);retired=true;closed++;}};},
   onReplicatedDocuments:async(_profile,docs)=>received.push(...docs)
  });
  const engine=await factory({...profile,role});engines.push(engine);return engine;
 }
 const editor=await client(),viewer=await client('viewer');
 await editor.write('Shared/note.md',{bytes:new TextEncoder().encode('Before live')});
 await editor.synchronize();await viewer.synchronize();
 assert.equal(new TextDecoder().decode((await viewer.read('Shared/note.md')).bytes),'Before live');
 const a=editor.startLive(),b=viewer.startLive();
 await waitFor(()=>editor.getReplicationState().syncStatus==='PAUSED'&&viewer.getReplicationState().syncStatus==='PAUSED');
 const initial=await editor.read('Shared/note.md');
 await editor.write('Shared/note.md',{bytes:new TextEncoder().encode('Live update'),baseRevision:initial.revision});
 await waitFor(async()=>new TextDecoder().decode((await viewer.read('Shared/note.md'))?.bytes)==='Live update');
 assert.ok(received.some(doc=>doc.path==='Shared/note.md'));
 assert.deepEqual((await remote.allDocs()).rows.filter(row=>row.id.startsWith('_')).map(row=>row.id),['_design/arcalink_shared2_access']);
 assert.equal(received.some(doc=>doc._id.startsWith('_')),false);
 await editor.close();await a;
 await viewer.close();await b;
 assert.equal(connections,closed);
 allowed=false;
 const blocked=await client();
 await assert.rejects(blocked.synchronize(),{code:'shared2-replication-access-denied'});
});

test('full maintained LiveSync pipeline applies files continuously across different local mounts',async t=>{
 const remote=createDB('pipeline-server-'+crypto.randomUUID()),clients=[],errors=[],root='Owner/Shared';
 await remote.put({_id:'_design/arcalink_shared2_access',filters:{files:"function(doc){return doc._id.charAt(0)!=='_';}"}});
 const profile={kind:'shared',account:'test',workspace:'stand',folder:'a'.repeat(32),database:'arcalink_s_'+'a'.repeat(32),generation:1,keyEpoch:0,encrypted:false,role:'editor',documentRoot:root};
 t.after(async()=>{for(const client of clients)await client.engine.close();await remote.destroy();});
 async function client(mount){
  const disk=new Map(),provenance=new Map(),kv=new Map();let clock=1000000;
  const put=(path,body,mtime=++clock)=>{
   const blob=body instanceof Blob?body:new Blob([body],{type:typeof body==='string'?'text/plain':'application/octet-stream'});
   const file={name:path.split('/').at(-1),path,stat:{type:'file',ctime:1000000,mtime,size:blob.size},body:blob};disk.set(path,file);return file;
  };
  const storage={getStub:async p=>disk.get(p)||null,getFileStub:async p=>disk.get(p)||null,readStubContent:async f=>disk.get(f.path)||false,
   getFiles:async()=>[...disk.values()],normalisePath:p=>p,stat:async p=>disk.get(p)?.stat||false,ensureDir:async()=>true,touched:async()=>{},triggerFileEvent:()=>{},
   writeFileAuto:async(p,body,times)=>{put(p,body,times.mtime);return true;},deleteVaultItem:async p=>{disk.delete(p);return true;},
   renameFile:async(f,p)=>{const next={...disk.get(f.path),path:p,name:p.split('/').at(-1)};disk.delete(f.path);disk.set(p,next);return next;}};
  const factory=createShared2LocalEngineFactory({namespace:'shared2-pipeline-'+crypto.randomUUID(),createPouchDB:name=>createDB(name),
   settingsFor:async p=>({database:p.database,generation:p.generation,settings:{hashAlg:'sha1',chunkSplitterVersion:'v1',useEden:false,disableWorkerForGeneratingChunks:true}}),
   lifecycle:'livesync',createLiveSyncLifecycle:createShared2LiveSyncLifecycle,accessCheck:async()=>true,openRemote:async()=>({database:remote,close:async()=>{}}),
   fileRuntimeFor:async()=>({storageAccess:createShared2ScopedStorage({storage,mount,documentRoot:root}),
    fileReflectionProvenance:{get:async p=>provenance.get(p),set:async(p,r)=>provenance.set(p,r),delete:async p=>provenance.delete(p)},
    conflict:{queueCheckFor:async()=>{},queueCheckForIfOpen:async()=>{}},vault:{isTargetFile:async()=>true,isFileSizeTooLarge:()=>false},assertCurrent:async()=>true}),
   resultRuntimeFor:({services,files})=>createShared2ResultRuntime({ResultProcessor:ReplicateResultProcessor,services,files,keyValueDB:{get:async k=>kv.get(k),set:async(k,v)=>kv.set(k,v)},documentRoot:root,assertCurrent:async()=>true,retire:()=>errors.push('unexpected retirement'),onError:error=>errors.push(error)})
  });
  const engine=await factory(profile);
  const event=(type,relative,extra={})=>{const file=disk.get(mount+'/'+relative),{body,...stub}=file;return engine.files.localEvent({type,args:{file:{...stub,path:root+'/'+relative},...extra}});};
  const result={engine,disk,put:(relative,body)=>put(mount+'/'+relative,body),event,mount,kv};clients.push(result);return result;
 }
 const a=await client('Source/Shared'),b=await client('Recipient/Elsewhere');
 const first=a.engine.startLive(),second=b.engine.startLive();
 await waitFor(()=>a.engine.getReplicationState().syncStatus==='PAUSED'&&b.engine.getReplicationState().syncStatus==='PAUSED');
 a.put('note.md','First live revision');assert.equal(await a.event('CREATE','note.md'),true);
 await waitFor(()=>b.disk.has(b.mount+'/note.md'));
 assert.equal(await b.disk.get(b.mount+'/note.md').body.text(),'First live revision');
 const bytes=Uint8Array.from({length:3*1024*1024+17},(_,i)=>i%251);
 a.put('large.bin',bytes);await a.event('CREATE','large.bin');
 await waitFor(()=>b.disk.has(b.mount+'/large.bin'));
 assert.deepEqual(new Uint8Array(await b.disk.get(b.mount+'/large.bin').body.arrayBuffer()),bytes);
 const old=a.disk.get(a.mount+'/note.md');a.disk.delete(a.mount+'/note.md');
 a.disk.set(a.mount+'/Attachments/note.md',{...old,path:a.mount+'/Attachments/note.md'});
 await a.event('RENAME','Attachments/note.md',{oldPath:root+'/note.md'});
 await waitFor(()=>!b.disk.has(b.mount+'/note.md')&&b.disk.has(b.mount+'/Attachments/note.md'));
 assert.equal(await b.disk.get(b.mount+'/Attachments/note.md').body.text(),'First live revision');
 assert.equal(b.disk.has(root+'/Attachments/note.md'),false);
 await a.engine.close();await first;await b.engine.close();await second;
 assert.deepEqual(errors,[]);
 assert.ok(b.kv.has(b.engine.results.snapshotKey));
});

test('closing a scope drains an admitted finite connection before closing its local database',async t=>{
 const remote=createDB('slow-connection-'+crypto.randomUUID());let release,entered,closed=false,remoteClosed=false;
 const gate=new Promise(resolve=>release=resolve),opening=new Promise(resolve=>entered=resolve);
 const profile={kind:'shared',account:'test',workspace:'stand',folder:'b'.repeat(32),database:'arcalink_s_'+'b'.repeat(32),generation:1,keyEpoch:0,encrypted:false,role:'editor',documentRoot:'Shared'};
 const engine=await createShared2LocalEngineFactory({namespace:'shared2-cancel-'+crypto.randomUUID(),createPouchDB:name=>createDB(name),
  settingsFor:async p=>({database:p.database,generation:p.generation,settings:{hashAlg:'sha1',chunkSplitterVersion:'v1',useEden:false,disableWorkerForGeneratingChunks:true}}),
  lifecycle:'livesync',createLiveSyncLifecycle:createShared2LiveSyncLifecycle,onReplicatedDocuments:async()=>{},accessCheck:async()=>true,
  openRemote:async()=>{entered();await gate;return {database:remote,close:async()=>{remoteClosed=true;}};}
 })(profile);
 t.after(async()=>{release();await engine.close();await remote.destroy();});
 const syncing=engine.synchronize();await opening;
 const stopping=engine.close().then(()=>{closed=true;});
 await new Promise(resolve=>setTimeout(resolve,15));assert.equal(closed,false);
 release();await assert.rejects(syncing);await stopping;assert.equal(remoteClosed,true);assert.equal(closed,true);
});

test('encrypted shared scopes use their own envelope with the maintained finite lifecycle',async t=>{
 const profile={kind:'shared',account:'test',workspace:'stand',folder:'c'.repeat(32),database:'arcalink_s_'+'c'.repeat(32),generation:1,keyEpoch:1,encrypted:true,role:'editor',documentRoot:'Encrypted'};
 const remote=createDB('encrypted-server-'+crypto.randomUUID()),clients=[];
 const keyProvider=async p=>({...p,passphrase:'d'.repeat(64),salt:new Uint8Array(32).fill(7)});
 await remote.put({_id:'_design/arcalink_shared2_access',filters:{files:'function (doc) { return doc.type === "leaf" || doc.type === "plain" || doc.type === "newnote"; }'}});
 await configureShared2Encryption(remote,profile,keyProvider);
 t.after(async()=>{for(const engine of clients)await engine.close();await remote.destroy();});
 async function client(){
  const engine=await createShared2LocalEngineFactory({namespace:'shared2-cipher-'+crypto.randomUUID(),createPouchDB:name=>createDB(name),keyProvider,
   settingsFor:async p=>({database:p.database,generation:p.generation,settings:{hashAlg:'sha1',chunkSplitterVersion:'v1',useEden:false,disableWorkerForGeneratingChunks:true,disableWorkerForDecrypting:true}}),
   lifecycle:'livesync',createLiveSyncLifecycle:createShared2LiveSyncLifecycle,onReplicatedDocuments:async()=>{},accessCheck:async()=>true,openRemote:async()=>({database:remote,close:async()=>{}})
  })(profile);clients.push(engine);return engine;
 }
 const a=await client(),b=await client();
 await a.write('Encrypted/private.md',{bytes:new TextEncoder().encode('Folder-scoped secret')});await a.synchronize();await b.synchronize();
 assert.equal(new TextDecoder().decode((await b.read('Encrypted/private.md')).bytes),'Folder-scoped secret');
});

test('changing the pull filter preserves the old checkpoint, conflict leaves and local edits',async t=>{
 const remote=createDB('checkpoint-source-'+crypto.randomUUID()),local=createDB('checkpoint-target-'+crypto.randomUUID());
 t.after(async()=>{await local.destroy();await remote.destroy();});
 await remote.put({_id:'_design/arcalink_shared2_access',filters:{files:"function(doc){return doc._id.charAt(0)!=='_';}"}});
 const root='1-'+ 'a'.repeat(32),left='2-'+ 'b'.repeat(32),right='2-'+ 'c'.repeat(32);
 await remote.bulkDocs([{_id:'conflict',_rev:left,_revisions:{start:2,ids:['b'.repeat(32),'a'.repeat(32)]},value:'left'},
  {_id:'conflict',_rev:right,_revisions:{start:2,ids:['c'.repeat(32),'a'.repeat(32)]},value:'right'}],{new_edits:false});
 await remote.put({_id:'removed',value:'before deletion'});
 const oldFilter=doc=>typeof doc._id==='string'&&!doc._id.startsWith('_');
 const oldOptions={checkpoint:'target',filter:oldFilter};
 await local.replicate.from(remote,oldOptions);
 const generateId=require('pouchdb-generate-replication-id');
 const oldId=await generateId(remote,local,oldOptions),newOptions={checkpoint:'target',filter:'arcalink_shared2_access/files'},newId=await generateId(remote,local,newOptions);
 assert.notEqual(oldId,newId);const oldCheckpoint=await local.get(oldId);
 await local.put({_id:'local-draft',value:'keep'});
 const prior=await remote.get('removed');const tombstone=await remote.remove(prior);
 await remote.put({_id:'fresh',value:'arrived later'});
 await local.replicate.from(remote,newOptions);
 assert.equal((await local.get(oldId)).last_seq,oldCheckpoint.last_seq);
 assert.ok(await local.get(newId));assert.equal((await local.get('local-draft')).value,'keep');assert.equal((await local.get('fresh')).value,'arrived later');
 const leaves=await local.get('conflict',{open_revs:'all',revs:true});
 assert.deepEqual(leaves.map(x=>x.ok._rev).sort(),[left,right].sort());
 assert.ok(leaves.every(x=>x.ok._revisions.ids[1]===root.slice(2)));
 const deleted=await local.get('removed',{rev:tombstone.rev});assert.equal(deleted._deleted,true);
 await assert.rejects(local.get('_design/arcalink_shared2_access'),{status:404});
 assert.equal((await local.replicate.from(remote,newOptions)).docs_written,0);
});

test('finite editor replication keeps uploads bounded while pulling remote changes',async()=>{
 const local=createDB('push-batch-local-'+crypto.randomUUID()),remote=createDB('push-batch-remote-'+crypto.randomUUID()),pushBatches=[];
 await remote.put({_id:'_design/arcalink_shared2_access',filters:{files:"function(doc){return doc._id.charAt(0)!=='_';}"}});
 await remote.bulkDocs(Array.from({length:3},(_,i)=>({_id:'incoming-'+i,type:'leaf',data:'remote'})));
 await local.bulkDocs(Array.from({length:40},(_,i)=>({_id:'outgoing-'+String(i).padStart(3,'0'),type:'leaf',data:'local'})));
 const originalBulk=remote.bulkDocs.bind(remote);remote.bulkDocs=function(docs,...rest){pushBatches.push((Array.isArray(docs)?docs:docs.docs).length);return originalBulk(docs,...rest);};
 const profile={kind:'shared',role:'editor',database:'arcalink_s_'+'a'.repeat(32),folder:'a'.repeat(32),account:'test',workspace:'work',generation:1,keyEpoch:0,encrypted:false,documentRoot:'Team'};
 const services={context:{translate:key=>key},API:{isMobile:()=>false},setting:{currentSettings:()=>({encrypt:false,hashAlg:'sha1',chunkSplitterVersion:'v1',useEden:false,remoteType:'',readChunksOnline:false,useOnlyLocalChunk:true})},replicator:{replicationStatics:{value:{}}},replication:{parseSynchroniseResult:async()=>{}},database:{localDatabase:{localDatabase:local}}};
 const lifecycle=createShared2LiveSyncLifecycle({services,profile,accessCheck:async()=>true,openRemote:async()=>({database:remote,close:async()=>{}})});
 try{
  await lifecycle.synchronize();
  assert.ok(pushBatches.length>1);assert.ok(pushBatches.every(count=>count<=8),JSON.stringify(pushBatches));
  assert.equal((await remote.allDocs()).rows.filter(row=>row.id.startsWith('outgoing-')).length,40);
  for(let i=0;i<3;i++)assert.equal((await local.get('incoming-'+i)).data,'remote');
 }finally{await lifecycle.close();await local.destroy();await remote.destroy();}
});

test('temporary gateway failures do not complete or retry a scoped finite pull',async()=>{
 const {EventEmitter}=await import('node:events');
 const {createShared2RemoteTransport}=await import('../plugin/shared2-remote-transport.mjs');
 for(const failure of [429,502,504,'timeout']){
  const profile={kind:'shared',role:'viewer',database:'arcalink_s_'+'a'.repeat(32),folder:'a'.repeat(32),account:'test',workspace:'work',generation:1,keyEpoch:0,encrypted:false,documentRoot:'Team',revision:1,catalogRevision:1};
  let opens=0,mutations=0,closed=0;
  const services={context:{translate:key=>key},API:{isMobile:()=>false},setting:{currentSettings:()=>({encrypt:false,hashAlg:'sha1',chunkSplitterVersion:'v1',useEden:false,remoteType:'',readChunksOnline:false,useOnlyLocalChunk:true})},replicator:{replicationStatics:{value:{}}},replication:{parseSynchroniseResult:async()=>{mutations++;}},database:{localDatabase:{localDatabase:{name:'fault-'+crypto.randomUUID(),info:async()=>({update_seq:0}),replicate:{from(remote){
   const events=new EventEmitter();let reject;const task=new Promise((_,bad)=>{reject=bad});task.on=(...args)=>{events.on(...args);return task;};task.cancel=()=>{};
   queueMicrotask(async()=>{try{const response=await remote.transport.fetch(remote.transport.url+'/_changes');if(!response.ok)throw Object.assign(Error('gateway-failure'),{status:response.status});throw Error('expected failure');}catch(error){events.emit('error',error);reject(error);}});return task;
  }}}}}};
  const lifecycle=createShared2LiveSyncLifecycle({services,profile,accessCheck:async()=>true,openRemote:async(p,observer)=>{
   opens++;const transport=createShared2RemoteTransport({origin:'http://127.0.0.1',allowLocalTest:true,profile:p,onResponse:observer?.onResponse,onError:observer?.onError,resolveAccess:async()=>({...p,token:'synthetic'}),fetch:async url=>{if(!String(url).endsWith('/_changes'))return new Response('{}');if(failure==='timeout')throw Object.assign(Error('synthetic timeout'),{name:'TimeoutError'});return new Response('{}',{status:failure});}});
   return {database:{transport,info:async()=>{await transport.fetch(transport.url);return {update_seq:1};}},close:async()=>{await transport.close();closed++;}};
  }});
  try{await assert.rejects(lifecycle.synchronize());assert.equal(opens,1,String(failure));assert.equal(closed,1,String(failure));assert.equal(mutations,0,String(failure));}finally{await lifecycle.close();}
 }
});

test('a grant failure after 413 does not start a fallback attempt',async()=>{
 const {EventEmitter}=await import('node:events');
 const {createShared2RemoteTransport}=await import('../plugin/shared2-remote-transport.mjs');
 const profile={kind:'shared',role:'viewer',database:'arcalink_s_'+'a'.repeat(32),folder:'a'.repeat(32),account:'test',workspace:'work',generation:1,keyEpoch:0,encrypted:false,documentRoot:'Team',revision:1,catalogRevision:1};
 let denied=false,opens=0,http=0,grants=0;
 const services={context:{translate:key=>key},API:{isMobile:()=>false},setting:{currentSettings:()=>({encrypt:false,hashAlg:'sha1',chunkSplitterVersion:'v1',useEden:false,remoteType:'',readChunksOnline:false,useOnlyLocalChunk:true})},replicator:{replicationStatics:{value:{}}},replication:{parseSynchroniseResult:async()=>{}},database:{localDatabase:{localDatabase:{name:'fallback-grant-'+crypto.randomUUID(),info:async()=>({update_seq:0}),replicate:{from(remote){
  const events=new EventEmitter();let reject;const task=new Promise((_,bad)=>{reject=bad});task.on=(...args)=>{events.on(...args);return task;};task.cancel=()=>{};
  (async()=>{await remote.transport.fetch(remote.transport.url+'/_bulk_get');denied=true;await remote.transport.fetch(remote.transport.url+'/doc');})().catch(error=>{events.emit('error',error);reject(error);});return task;
 }}}}}};
 const lifecycle=createShared2LiveSyncLifecycle({services,profile,accessCheck:async()=>true,openRemote:async(p,observer)=>{
  opens++;const transport=createShared2RemoteTransport({origin:'http://127.0.0.1',allowLocalTest:true,profile:p,onResponse:observer?.onResponse,onError:observer?.onError,
   resolveAccess:async()=>{grants++;if(denied)throw Object.assign(Error('shared2-grant-mismatch'),{code:'shared2-grant-mismatch'});return {...p,token:'synthetic'};},
   fetch:async()=>{http++;return new Response('{}',{status:http===1?200:413});}});
  return {database:{transport,info:async()=>{await transport.fetch(transport.url);return {update_seq:1};}},close:()=>transport.close()};
 }});
 try{await assert.rejects(lifecycle.synchronize());assert.equal(opens,1);assert.equal(http,2);assert.equal(grants,3);}finally{await lifecycle.close();}
});

test('scoped upstream close failure prevents both ready and 413 fallback',async()=>{
 const {EventEmitter}=await import('node:events');
 for(const fail413 of [false,true]){
  let opens=0,observer;
  const profile={kind:'shared',role:'viewer',database:'arcalink_s_'+'a'.repeat(32),folder:'a'.repeat(32),account:'test',workspace:'work',generation:1,keyEpoch:0,encrypted:false,documentRoot:'Team'};
  const services={context:{translate:key=>key},API:{isMobile:()=>false},setting:{currentSettings:()=>({encrypt:false,hashAlg:'sha1',chunkSplitterVersion:'v1',useEden:false,remoteType:'',readChunksOnline:false,useOnlyLocalChunk:true})},replicator:{replicationStatics:{value:{}}},replication:{parseSynchroniseResult:async()=>{}},database:{localDatabase:{localDatabase:{name:'fallback-close-'+crypto.randomUUID(),info:async()=>({update_seq:0}),replicate:{from(){
   const events=new EventEmitter();let resolve,reject;const task=new Promise((yes,no)=>{resolve=yes;reject=no;});task.on=(...args)=>{events.on(...args);return task;};task.cancel=()=>{};
   queueMicrotask(()=>{if(fail413){observer.onResponse(413,'/shared2/couch/'+profile.database+'/_bulk_get');const error=Object.assign(Error('payload too large'),{status:413});events.emit('error',error);reject(error);}else{events.emit('complete',{ok:true});resolve({ok:true});}});return task;
  }}}}}};
  const lifecycle=createShared2LiveSyncLifecycle({services,profile,accessCheck:async()=>true,openRemote:async(_p,options)=>{opens++;observer=options;return {database:{info:async()=>({update_seq:1})},close:async()=>{throw Error('synthetic-close-failed');}};}});
  try{await assert.rejects(lifecycle.synchronize(),/synthetic-close-failed/);assert.equal(opens,1);await assert.rejects(lifecycle.synchronize(),/synthetic-close-failed/);assert.equal(opens,1);}finally{await assert.rejects(lifecycle.close(),/synthetic-close-failed/);}
 }
});

test('a continuous scoped close failure rejects stop and blocks reopening',async()=>{
 const {EventEmitter}=await import('node:events');let opens=0,attempt=0;
 const profile={kind:'shared',role:'viewer',database:'arcalink_s_'+'d'.repeat(32),folder:'d'.repeat(32),account:'test',workspace:'work',generation:1,keyEpoch:0,encrypted:false,documentRoot:'Team'};
 const services={context:{translate:key=>key},API:{isMobile:()=>false},setting:{currentSettings:()=>({encrypt:false,hashAlg:'sha1',chunkSplitterVersion:'v1',useEden:false,remoteType:'',readChunksOnline:false,useOnlyLocalChunk:true})},replicator:{replicationStatics:{value:{}},runFiniteReplicationActivity:fn=>fn()},replication:{parseSynchroniseResult:async()=>{}},database:{localDatabase:{localDatabase:{name:'continuous-close-'+crypto.randomUUID(),info:async()=>({update_seq:0}),replicate:{from(){
  const events=new EventEmitter();let resolve;const task=new Promise(yes=>{resolve=yes;});task.on=(...args)=>{events.on(...args);return task;};task.cancel=()=>{events.emit('complete',{status:'cancelled'});resolve({status:'cancelled'});};
  if(++attempt===1)queueMicrotask(()=>{events.emit('complete',{ok:true});resolve({ok:true});});return task;
 }}}}}};
 const lifecycle=createShared2LiveSyncLifecycle({services,profile,accessCheck:async()=>true,openRemote:async()=>{const number=++opens;return {database:{info:async()=>({update_seq:1})},close:async()=>{if(number===2)throw Error('continuous-close-failed');}};}});
 const live=lifecycle.start();live.catch(()=>{});
 try{await waitFor(()=>opens===2);await assert.rejects(lifecycle.stop(),/continuous-close-failed/);await assert.rejects(lifecycle.synchronize(),/continuous-close-failed/);assert.equal(opens,2);await assert.rejects(lifecycle.close(),/continuous-close-failed/);}finally{await lifecycle.close().catch(()=>{});await Promise.allSettled([live]);}
});

test('an external response-body abort after 413 does not start fallback',async()=>{
 const {EventEmitter}=await import('node:events');const {createShared2RemoteTransport}=await import('../plugin/shared2-remote-transport.mjs');
 const profile={kind:'shared',role:'viewer',database:'arcalink_s_'+'e'.repeat(32),folder:'e'.repeat(32),account:'test',workspace:'work',generation:1,keyEpoch:0,encrypted:false,documentRoot:'Team',revision:1,catalogRevision:1};
 let opens=0,attempt=0;const observed=[];
 const services={context:{translate:key=>key},API:{isMobile:()=>false},setting:{currentSettings:()=>({encrypt:false,hashAlg:'sha1',chunkSplitterVersion:'v1',useEden:false,remoteType:'',readChunksOnline:false,useOnlyLocalChunk:true})},replicator:{replicationStatics:{value:{}}},replication:{parseSynchroniseResult:async()=>{}},database:{localDatabase:{localDatabase:{name:'body-abort-'+crypto.randomUUID(),info:async()=>({update_seq:0}),replicate:{from(remote){
  const events=new EventEmitter();let resolve,reject;const task=new Promise((yes,no)=>{resolve=yes;reject=no;});task.on=(...args)=>{events.on(...args);return task;};task.cancel=()=>{};
  (async()=>{await Promise.resolve();if(++attempt===1){await(await remote.transport.fetch(remote.transport.url+'/_bulk_get')).json();const abort=new AbortController();const response=await remote.transport.fetch(remote.transport.url+'/slow',{signal:abort.signal});const reading=response.json();abort.abort();await reading;}events.emit('complete',{ok:true});resolve({ok:true});})().catch(error=>{events.emit('error',error);reject(error);});return task;
 }}}}}};
 const lifecycle=createShared2LiveSyncLifecycle({services,profile,accessCheck:async()=>true,openRemote:async(p,observer)=>{
  opens++;const transport=createShared2RemoteTransport({origin:'http://127.0.0.1',allowLocalTest:true,profile:p,onResponse:observer?.onResponse,onError:(error,detail)=>{observed.push(detail);observer?.onError?.(error,detail);},resolveAccess:async()=>({...p,token:'synthetic'}),fetch:async url=>url.endsWith('/slow')?new Response(new ReadableStream({},{highWaterMark:0})):new Response('{}',{status:url.endsWith('/_bulk_get')?413:200})});
  return {database:{transport,info:async()=>{await(await transport.fetch(transport.url)).json();return {update_seq:1};}},close:()=>transport.close()};
 }});
 try{await assert.rejects(lifecycle.synchronize());assert.equal(opens,1);assert.ok(observed.some(detail=>detail.externalAborted===true));}finally{await lifecycle.close();}
});
