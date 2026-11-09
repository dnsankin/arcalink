import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('../.cache/source/',import.meta.url));
const require=createRequire(source+'esbuild.config.mjs');
const output=await require('esbuild').build({
 stdin:{contents:`
  export {createShared2FileRuntime,createShared2ScopedStorage} from './shared2-file-runtime.mjs';
  export {createShared2ResultRuntime} from './shared2-result-runtime.mjs';
  export {ReplicateResultProcessor} from '../.cache/source/src/serviceFeatures/replication/ReplicateResultProcessor';
  export {LiveSyncLocalDB} from '@vrtmrz/livesync-commonlib/compat/pouchdb/LiveSyncLocalDB';
  export {DEFAULT_SETTINGS} from '@vrtmrz/livesync-commonlib/compat/common/types';
  export {compareMTime,createBlob,createTextBlob,readAsBlob} from '@vrtmrz/livesync-commonlib/compat/common/utils';
  export {createLiveSyncEventHub} from '@vrtmrz/livesync-commonlib/context';
  import PouchDB from 'pouchdb-core';
  import Memory from 'pouchdb-adapter-memory';
  import Replication from 'pouchdb-replication';
  PouchDB.plugin(Memory).plugin(Replication);
  export const createDB=name=>new PouchDB(name,{adapter:'memory'});
 `,resolveDir:fileURLToPath(new URL('../plugin/',import.meta.url))},
 bundle:true,write:false,format:'cjs',platform:'node',tsconfig:source+'tsconfig.json',nodePaths:[source+'node_modules'],external:['obsidian'],
 plugins:[{name:'headless-translation',setup(build){
  build.onResolve({filter:/^@\/common\/translation$/},()=>({path:'translation',namespace:'headless'}));
  build.onLoad({filter:/.*/,namespace:'headless'},()=>({contents:'export const $msg=key=>key;',loader:'js'}));
 }}]
});
const Module=require('node:module'),mod=new Module('shared2-file-runtime');
mod.filename=source+'shared2-file-runtime.cjs';mod.paths=Module._nodeModulePaths(source);
mod._compile(output.outputFiles[0].text,mod.filename);
const {createShared2FileRuntime,createShared2ScopedStorage,createShared2ResultRuntime,ReplicateResultProcessor,LiveSyncLocalDB,DEFAULT_SETTINGS,compareMTime,createBlob,createTextBlob,readAsBlob,createLiveSyncEventHub,createDB}=mod.exports;
const noop=()=>{},root='Owner/Shared';

async function device(t,{mount='Recipient/Mounted',role='owner'}={}){
 const db=createDB('shared-file-'+crypto.randomUUID()),disk=new Map(),trash=new Map(),provenance=new Map(),reads=[],conflicts=[];
 let time=1000000,allowed=true;
 const file=(path,body,mtime=++time)=>({name:path.split('/').at(-1),path,stat:{type:'file',ctime:1000000,mtime,size:new Blob([body]).size},body:typeof body==='string'?createTextBlob(body):createBlob(body)});
 const setting={currentSettings:()=>({...DEFAULT_SETTINGS,useOnlyLocalChunk:true,writeDocumentsIfConflicted:false})};
 const path={path2id:async p=>p,id2path:(id,doc)=>doc?.path??id,getPath:doc=>typeof doc==='string'?doc:doc.path,compareFileFreshness:(f,doc)=>compareMTime(f.stat.mtime,doc.mtime),markChangesAreSame:noop};
 const services={API:{addLog:noop},setting,path,context:{events:createLiveSyncEventHub()},database:{createPouchDBInstance:()=>db},databaseEvents:{onDatabaseInitialisation:async()=>true,onDatabaseHasReady:async()=>true,onCloseDatabase:async()=>true,onUnloadDatabase:async()=>true},replicator:{onCloseActiveReplication:async()=>true}};
 const local=new LiveSyncLocalDB(db.name,{services});assert.equal(await local.initializeDatabase(),true);
 services.database.localDatabase=local;
 const storage={
  getStub:async p=>disk.get(p)||null,getFileStub:async p=>disk.get(p)||null,
  readStubContent:async f=>{reads.push(f.path);return disk.get(f.path)||false;},
  getFiles:async()=>[...disk.values()],normalisePath:p=>p,
  ensureDir:async()=>true,stat:async p=>disk.get(p)?.stat||false,touched:async()=>{},triggerFileEvent:noop,
  writeFileAuto:async(p,body,times)=>{disk.set(p,file(p,body,times.mtime));return true;},
  deleteVaultItem:async p=>{trash.set(p,disk.get(p));disk.delete(p);return true;},
  renameFile:async(f,p)=>{const next={...disk.get(f.path),path:p,name:p.split('/').at(-1)};disk.delete(f.path);disk.set(p,next);return next;}
 };
 const view=createShared2ScopedStorage({storage,mount,documentRoot:root});
 const runtime=createShared2FileRuntime({services,storageAccess:view,fileReflectionProvenance:{get:async p=>provenance.get(p),set:async(p,r)=>provenance.set(p,r),delete:async p=>provenance.delete(p)},conflict:{queueCheckFor:async p=>conflicts.push(p),queueCheckForIfOpen:async p=>conflicts.push(p)},vault:{isTargetFile:async()=>true,isFileSizeTooLarge:()=>false},documentRoot:root,role,assertCurrent:async()=>allowed});
 t.after(async()=>{await runtime.close();local.offRemoteChunkFetchedHandler?.();await local.managers.teardownManagers();await db.destroy();});
 const put=(relative,body)=>{const p=mount+'/'+relative;const item=file(p,body);disk.set(p,item);return {...item,path:root+'/'+relative};};
 // Real Obsidian watcher events carry stubs; content must be read from storage.
 const event=(type,f,args={})=>{const {body,...stub}=f;return runtime.localEvent({type,args:{file:stub,...args}});};
 const content=async relative=>{const entry=await local.getDBEntry(root+'/'+relative,undefined,false,false,false,true);return entry?await readAsBlob(entry).arrayBuffer():null;};
 return {db,local,runtime,services,disk,trash,provenance,reads,conflicts,view,storage,mount,file,put,event,content,setAllowed:value=>allowed=value};
}
async function reflect(a,b){
 await a.db.replicate.to(b.db);
 const rows=await b.db.allDocs({include_docs:true});
 for(const {doc} of rows.rows)if(['plain','newnote'].includes(doc?.type))assert.equal(await b.runtime.incoming(doc),true);
}
const text=bytes=>new TextDecoder().decode(bytes);

test('standard file handler stores text/binary and maps different mount paths without personal copies',async t=>{
 const a=await device(t,{mount:'Source/Shared'}),b=await device(t);
 assert.equal(await a.event('CREATE',a.put('note.md','Hello\n')),true);
 const bytes=new Uint8Array([0,255,128,10,13,0,42]);
 assert.equal(await a.event('CREATE',a.put('attachment.bin',bytes)),true);
 await reflect(a,b);
 assert.equal(await b.disk.get(b.mount+'/note.md').body.text(),'Hello\n');
 assert.deepEqual(new Uint8Array(await b.disk.get(b.mount+'/attachment.bin').body.arrayBuffer()),bytes);
 assert.equal(b.disk.has('Source/Shared/note.md'),false);
 assert.equal(await a.db.get('Source/Shared/note.md').catch(error=>error.status),404);
 assert.ok(b.provenance.get(root+'/note.md')?.revision);
});

test('one file edit reads only that file and reflecting its own event does not create a revision',async t=>{
 const a=await device(t);
 for(const name of ['one.md','two.md','three.md'])await a.event('CREATE',a.put(name,name));
 a.reads.length=0;
 await a.event('CHANGED',a.put('two.md','updated'));
 assert.ok(a.reads.length>0);assert.ok(a.reads.every(p=>p===a.mount+'/two.md'));
 const before=(await a.db.get(root+'/two.md'))._rev;
 assert.equal(await a.runtime.incoming(await a.db.get(root+'/two.md')),true);
 const echoed={...a.disk.get(a.mount+'/two.md'),path:root+'/two.md'};
 assert.equal(await a.event('CHANGED',echoed),true);
 assert.equal((await a.db.get(root+'/two.md'))._rev,before);
});

test('drag rename and later deletion remove the old paths on a second client',async t=>{
 const a=await device(t),b=await device(t,{mount:'Different/Shared'});
 const old=a.put('report.md','Moved intact\n');await a.event('CREATE',old);await reflect(a,b);
 const moved=await a.storage.renameFile(a.disk.get(a.mount+'/report.md'),a.mount+'/Attachments/report.md');
 assert.equal(await a.event('RENAME',{...moved,path:root+'/Attachments/report.md'},{oldPath:root+'/report.md'}),true);
 await reflect(a,b);
 assert.equal(b.disk.has(b.mount+'/report.md'),false);
 assert.equal(await b.disk.get(b.mount+'/Attachments/report.md').body.text(),'Moved intact\n');
 a.disk.delete(a.mount+'/Attachments/report.md');
 assert.equal(await a.event('DELETE',{...moved,path:root+'/Attachments/report.md'}),true);
 await reflect(a,b);assert.equal(b.disk.has(b.mount+'/Attachments/report.md'),false);
});

test('remote deletion preserves an offline local edit as an ordinary LiveSync conflict',async t=>{
 const a=await device(t),b=await device(t);const original=a.put('note.md','Original');
 await a.event('CREATE',original);await reflect(a,b);
 b.put('note.md','Offline edit');a.disk.delete(a.mount+'/note.md');
 assert.equal(await a.event('DELETE',original),true);await reflect(a,b);
 assert.equal(await b.disk.get(b.mount+'/note.md').body.text(),'Offline edit');
 assert.equal(b.trash.size,0);
 const leaves=await b.db.get(root+'/note.md',{open_revs:'all'});
 assert.ok(leaves.some(x=>x.ok?.deleted));assert.ok(leaves.some(x=>x.ok&&!x.ok.deleted&&!x.ok._deleted));
});

test('viewer and stale membership cannot write through the file runtime',async t=>{
 const owner=await device(t),viewer=await device(t,{role:'viewer'});
 const draft=viewer.put('draft.md','Private draft');
 await assert.rejects(viewer.event('CREATE',draft),{code:'shared2-read-only'});
 assert.equal(await viewer.content('draft.md'),null);
 await owner.event('CREATE',owner.put('published.md','Server'));await reflect(owner,viewer);
 assert.equal(await viewer.disk.get(viewer.mount+'/published.md').body.text(),'Server');
 owner.setAllowed(false);
 await assert.rejects(owner.event('CHANGED',owner.put('published.md','Blocked')),{code:'shared2-file-runtime-access-denied'});
 assert.equal(text(await owner.content('published.md')),'Server');
 owner.setAllowed(true);
 assert.equal(await owner.event('CHANGED',owner.put('published.md','Permitted')),true);
 await owner.runtime.close();
 await assert.rejects(owner.event('CHANGED',owner.put('published.md','After close')),{code:'shared2-file-runtime-closed'});
});

test('scope validation rejects traversal, cross-mount rename and adjacent personal paths',async t=>{
 const a=await device(t);const original=a.put('note.md','Safe');await a.event('CREATE',original);
 for(const path of ['Owner/Private/note.md',root+'/../Private/note.md',root+'ish/note.md',root]){
  await assert.rejects(a.runtime.incoming({_id:path,path,type:'plain'}),{code:'shared2-file-outside-document-root'});
  await assert.rejects(a.event('CHANGED',{...original,path}),{code:'shared2-file-outside-document-root'});
 }
 await assert.rejects(a.event('RENAME',original,{oldPath:'Owner/Private/note.md'}),{code:'shared2-file-outside-document-root'});
 a.disk.set('Recipient/Private.md',a.file('Recipient/Private.md','Personal'));
 assert.deepEqual((await a.view.getFiles()).map(f=>f.path),[root+'/note.md']);
 await assert.rejects(a.view.getStub(root+'/../Private.md'),{code:'shared2-file-outside-document-root'});
 assert.equal(await a.disk.get('Recipient/Private.md').body.text(),'Personal');
});

async function waitFor(predicate){
 const deadline=Date.now()+12000;
 while(!await predicate()){
  if(Date.now()>deadline)throw Error('File pipeline did not converge');
  await new Promise(resolve=>setTimeout(resolve,10));
 }
}

test('ordinary result processor retains metadata until delayed chunks arrive',async t=>{
 const a=await device(t),b=await device(t),errors=[],kv=new Map();
 const result=createShared2ResultRuntime({ResultProcessor:ReplicateResultProcessor,services:b.services,files:b.runtime,
  keyValueDB:{get:async k=>kv.get(k),set:async(k,v)=>kv.set(k,v)},documentRoot:root,assertCurrent:async()=>true,retire:()=>errors.push('retired'),onError:error=>errors.push(error)});
 t.after(()=>result.close());
 await a.event('CREATE',a.put('delayed.md','Content arrives after metadata'));
 await b.db.replicate.from(a.db,{filter:doc=>doc.type!=='leaf'});
 const metadata=await b.db.get(root+'/delayed.md');
 await result.receive([metadata]);
 assert.equal(b.disk.has(b.mount+'/delayed.md'),false);
 await b.db.replicate.from(a.db,{filter:doc=>doc.type==='leaf'});
 const rows=await b.db.allDocs({include_docs:true});
 await result.receive(rows.rows.map(row=>row.doc).filter(doc=>doc?.type==='leaf'));
 await waitFor(()=>b.disk.has(b.mount+'/delayed.md'));
 assert.equal(await b.disk.get(b.mount+'/delayed.md').body.text(),'Content arrives after metadata');
 await result.close();assert.deepEqual(errors,[]);
 await assert.rejects(result.receive([metadata]),{code:'shared2-result-runtime-closed'});
});

test('pending incoming revisions survive shutdown and restore using the scoped snapshot',async t=>{
 const a=await device(t),b=await device(t),errors=[],kv=new Map();let ready=false;
 const options={ResultProcessor:ReplicateResultProcessor,services:b.services,files:b.runtime,
  keyValueDB:{get:async k=>kv.get(k),set:async(k,v)=>kv.set(k,v)},documentRoot:root,assertCurrent:async()=>true,isReady:()=>ready,retire:()=>errors.push('retired'),onError:error=>errors.push(error)};
 const first=createShared2ResultRuntime(options);
 await a.event('CREATE',a.put('pending.md','Held across restart'));await b.db.replicate.from(a.db);
 const meta=await b.db.get(root+'/pending.md');await first.receive([meta]);
 assert.equal(b.disk.size,0);await first.close();
 const snapshot=kv.get(first.snapshotKey);
 assert.equal(snapshot.queued.length+snapshot.processing.length,1);
 ready=true;const reopened=createShared2ResultRuntime(options);t.after(()=>reopened.close());await reopened.restore();reopened.resume();
 await waitFor(()=>b.disk.has(b.mount+'/pending.md'));
 assert.equal(await b.disk.get(b.mount+'/pending.md').body.text(),'Held across restart');
 await reopened.close();
 // Let the retired upstream processor's throttled snapshot callback fire.
 await new Promise(resolve=>setTimeout(resolve,80));
 const final=kv.get(reopened.snapshotKey);assert.equal(final.queued.length+final.processing.length,0);
 assert.deepEqual(errors,[]);
});

test('failed snapshot persistence blocks retirement and can be retried without losing queued files',async t=>{
 const a=await device(t),b=await device(t),kv=new Map();let broken=true;
 const result=createShared2ResultRuntime({ResultProcessor:ReplicateResultProcessor,services:b.services,files:b.runtime,
  keyValueDB:{get:async k=>kv.get(k),set:async(k,v)=>{if(broken)throw Error('snapshot-write-failed');kv.set(k,v);}},
  documentRoot:root,assertCurrent:async()=>true,isReady:()=>false,retire:()=>{},onError:()=>{}});
 await a.event('CREATE',a.put('pending.md','Must survive'));await b.db.replicate.from(a.db);
 await result.receive([await b.db.get(root+'/pending.md')]);
 await assert.rejects(result.close(),/snapshot-write-failed/);
 broken=false;await result.close();
 const snapshot=kv.get(result.snapshotKey);assert.equal(snapshot.queued.length+snapshot.processing.length,1);
});

test('two scopes with the same document root cannot restore each other\'s queued results',async t=>{
 const a=await device(t),b=await device(t),kv=new Map();
 const create=(device,ready)=>createShared2ResultRuntime({ResultProcessor:ReplicateResultProcessor,services:device.services,files:device.runtime,
  keyValueDB:{get:async k=>kv.get(k),set:async(k,v)=>kv.set(k,v)},documentRoot:root,assertCurrent:async()=>true,isReady:()=>ready,retire:()=>{},onError:()=>{}});
 const first=create(a,false),second=create(b,true);
 await first.receive([{_id:root+'/foreign.md',_rev:'1-foreign',path:root+'/foreign.md',type:'plain',children:[],size:0}]);
 await first.close();assert.notEqual(first.snapshotKey,second.snapshotKey);
 await second.restore();assert.equal(second.state.pending,0);assert.equal(b.disk.size,0);await second.close();
});
