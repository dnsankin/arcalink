import {shared2PouchProgressPlugin,patchShared2PouchProgress} from '../scripts/shared2-pouch-progress.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../.cache/source/esbuild.config.mjs',import.meta.url));const {build}=require('esbuild');
const sourceDir=fileURLToPath(new URL('../.cache/source/',import.meta.url));
const code=(await build({stdin:{contents:`export {createShared2LocalEngineFactory} from '../../plugin/shared2-local-engine.mjs';import PouchDB from 'pouchdb-core';import Memory from 'pouchdb-adapter-memory';import Replication from 'pouchdb-replication';PouchDB.plugin(Memory).plugin(Replication);export const createDB=(name,opts)=>new PouchDB(name,{...opts,adapter:'memory'});`,resolveDir:sourceDir},bundle:true,plugins:[shared2PouchProgressPlugin()],platform:'node',format:'cjs',write:false,nodePaths:[sourceDir+'node_modules'],external:['obsidian']})).outputFiles[0].text;
const Module=require('node:module');const mod=new Module('shared2-local-engine-fixture');mod.filename=sourceDir+'shared2-local-engine-fixture.cjs';mod.paths=Module._nodeModulePaths(sourceDir);mod._compile(code,mod.filename);
const {createShared2LocalEngineFactory,createDB}=mod.exports;
const profile=(extra={})=>({kind:'shared',account:'test',workspace:'stand',database:'arcalink_s_'+'a'.repeat(32),generation:1,keyEpoch:0,encrypted:false,role:'editor',...extra});
function fixture(){const opened=[];return {opened,factory:createShared2LocalEngineFactory({namespace:'shared2-test-'+crypto.randomUUID(),createPouchDB:(name,opts)=>{opened.push(name);return createDB(name,opts)},settingsFor:async p=>({database:p.database,generation:p.generation,settings:{hashAlg:'sha1',chunkSplitterVersion:'v1',disableWorkerForGeneratingChunks:true}})})};}

test('real LiveSync engines store exact binary/text and keep identical paths isolated',async()=>{
 const x=fixture();const a=await x.factory(profile()),b=await x.factory(profile({database:'arcalink_s_'+'b'.repeat(32)}));
 try{
  const bytes=new Uint8Array([0,128,255,13,10,1]);await a.write('Owner/file.bin',{bytes});await b.write('Owner/file.bin',{bytes:new Uint8Array([7,8])});
  assert.deepEqual([...new Uint8Array((await a.read('Owner/file.bin')).bytes)],[...bytes]);assert.deepEqual([...new Uint8Array((await b.read('Owner/file.bin')).bytes)],[7,8]);
  const text=new TextEncoder().encode('Привет\nshared2');await a.write('Owner/note.md',{bytes:text});assert.equal(new TextDecoder().decode((await a.read('Owner/note.md')).bytes),'Привет\nshared2');assert.equal(await b.read('Owner/note.md'),null);
  assert.notEqual(x.opened[0],x.opened[1]);
 }finally{await a.close();await b.close();}
});
test('same scoped local DB survives close/reopen but other generation stays separate',async()=>{
 const x=fixture();const a=await x.factory(profile());await a.write('Owner/a.md',{bytes:new TextEncoder().encode('saved')});await a.close();
 const reopened=await x.factory(profile()),next=await x.factory(profile({generation:2}));
 try{assert.equal(new TextDecoder().decode((await reopened.read('Owner/a.md')).bytes),'saved');assert.equal(await next.read('Owner/a.md'),null);}finally{await reopened.close();await next.close();}
});
test('encrypted profiles refuse before creating any local database',async()=>{
 const x=fixture();await assert.rejects(x.factory(profile({encrypted:true,keyEpoch:1})),/encrypted-engine-not-ready/);assert.equal(x.opened.length,0);
});
test('two actual LiveSync clients exchange chunked content through a separate PouchDB',async()=>{
 const profiles=profile();const databases=[];
 const createPouchDB=(name,opts)=>{const db=createDB(name,opts);databases.push(db);return db};
 const settingsFor=async p=>({database:p.database,generation:p.generation,settings:{hashAlg:'sha1',chunkSplitterVersion:'v1',disableWorkerForGeneratingChunks:true}});
 const aFactory=createShared2LocalEngineFactory({namespace:'shared2-client-a-'+crypto.randomUUID(),createPouchDB,settingsFor});
 const bFactory=createShared2LocalEngineFactory({namespace:'shared2-client-b-'+crypto.randomUUID(),createPouchDB,settingsFor});
 const a=await aFactory(profiles),b=await bFactory(profiles);const remote=createDB('shared2-remote-'+crypto.randomUUID(),{});
 try{
  const bytes=Uint8Array.from({length:1024*1024},(_,i)=>i%251);await a.write('Owner/large.bin',{bytes});
  await remote.replicate.from(databases[0]);await databases[1].replicate.from(remote);
  assert.deepEqual(new Uint8Array((await b.read('Owner/large.bin')).bytes),bytes);
  await a.close();assert.deepEqual(new Uint8Array((await b.read('Owner/large.bin')).bytes),bytes);
 }finally{await a.close();await b.close();await remote.destroy();}
});
test('actual engine rejects stale revision and invalid UTF-8 without losing accepted data',async()=>{
 const x=fixture(),engine=await x.factory(profile());
 try{
  await engine.write('Owner/a.md',{bytes:new TextEncoder().encode('first')});const first=await engine.read('Owner/a.md');
  await engine.write('Owner/a.md',{bytes:new TextEncoder().encode('second'),baseRevision:first.revision});
  await assert.rejects(engine.write('Owner/a.md',{bytes:new TextEncoder().encode('stale'),baseRevision:first.revision}),/write-rejected/);
  await assert.rejects(engine.write('Owner/a.md',{bytes:new Uint8Array([255,254])}));
  assert.equal(new TextDecoder().decode((await engine.read('Owner/a.md')).bytes),'second');
 }finally{await engine.close();}
});
test('large actual engine reconstruction retains exact binary bytes',async()=>{
 const x=fixture(),engine=await x.factory(profile());
 try{const bytes=new Uint8Array(33*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  await engine.write('Owner/video.bin',{bytes});const read=new Uint8Array((await engine.read('Owner/video.bin')).bytes);assert.deepEqual(read,bytes);
 }finally{await engine.close();}
});
test('real engine close failure blocks I/O until close is retried successfully',async()=>{
 let failClose=false,closeCalls=0;
 const factory=createShared2LocalEngineFactory({namespace:'shared2-close-'+crypto.randomUUID(),settingsFor:async p=>({database:p.database,generation:p.generation,settings:{hashAlg:'sha1',chunkSplitterVersion:'v1',disableWorkerForGeneratingChunks:true}}),createPouchDB:(name,opts)=>{const db=createDB(name,opts),original=db.close.bind(db);db.close=async()=>{closeCalls++;if(failClose){failClose=false;throw Error('temporary close failure')}return original()};return db}});
 const engine=await factory(profile());await engine.write('Owner/a.md',{bytes:new TextEncoder().encode('saved')});failClose=true;
 await assert.rejects(engine.close(),/temporary close failure/);await assert.rejects(engine.read('Owner/a.md'),/closed/);await engine.close();assert.equal(closeCalls,2);
});
test('reader and unsafe settings cannot mutate or inherit personal configuration',async()=>{
 const x=fixture();const viewer=await x.factory(profile({role:'viewer'}));
 try{await assert.rejects(viewer.write('Owner/a.md',{bytes:new Uint8Array([1])}),/read-only/);assert.equal(await viewer.read('Owner/a.md'),null);}finally{await viewer.close();}
 let creates=0;const factory=createShared2LocalEngineFactory({namespace:'shared2-options-test',createPouchDB:()=>{creates++;throw Error('must not open')},settingsFor:async p=>({database:p.database,generation:p.generation,settings:{couchDB_PASSWORD:'test-only-forbidden-option'}})});
 await assert.rejects(factory(profile()),/unsupported-shared2-engine-option/);assert.equal(creates,0);
});

test('router and pool use actual engines without crossing personal/shared mount boundaries',async()=>{
 const {createShared2Router}=await import('../plugin/shared2-routing.mjs');
 const {createShared2EnginePool}=await import('../plugin/shared2-engine-pool.mjs');
 const x=fixture();let saved={};const store={read:async()=>saved,update:async change=>{saved=await change(saved)}};
 const pool=createShared2EnginePool({openEngine:x.factory,accessCheck:async()=>true});
 const router=createShared2Router({store,scope:{account:'test',workspace:'stand'},connector:pool,quiesce:()=>pool.quiesce()});
 const catalog={protocol:2,account:'test',workspace:'stand',revision:1,personal:{database:'arcalink_p_'+'c'.repeat(32),generation:1},folders:[{id:'a'.repeat(32),database:profile().database,generation:1,revision:0,mount:'Local',documentRoot:'Owner',role:'editor',phase:'active',encrypted:false,keyEpoch:0}]};
 const bytes=text=>({bytes:new TextEncoder().encode(text)}),text=value=>new TextDecoder().decode(value.bytes);
 try{
  await router.apply(catalog);await router.write('Local/a.md',bytes('shared'));await router.write('Owner/a.md',bytes('private'));
  assert.equal(text(await router.read('Local/a.md')),'shared');assert.equal(text(await router.read('Owner/a.md')),'private');assert.equal(x.opened.length,2);
  const reader=structuredClone(catalog);reader.revision++;reader.folders[0].revision++;reader.folders[0].role='viewer';await router.apply(reader);
  assert.equal(text(await router.read('Local/a.md')),'shared');await assert.rejects(router.write('Local/a.md',bytes('forbidden')));
  const revoked=structuredClone(reader);revoked.revision++;revoked.folders[0].revision++;revoked.folders[0].phase='revoked';await router.apply(revoked);
  await assert.rejects(router.read('Local/a.md'));await assert.rejects(router.write('Local/a.md',bytes('fallback')));
  assert.equal(text(await router.read('Owner/a.md')),'private');
 }finally{await pool.dispose();}
});

test('actual engine controlled replication uploads editors and only downloads for viewers',async()=>{
 const remote=createDB('shared2-controlled-'+crypto.randomUUID(),{}),opens=[],remoteCheckpoints=[];
 const get=remote.get.bind(remote);remote.get=(id,...args)=>{if(id.startsWith('_local/'))remoteCheckpoints.push(id);return get(id,...args)};
 const factory=role=>createShared2LocalEngineFactory({namespace:'shared2-controlled-'+crypto.randomUUID(),createPouchDB:createDB,settingsFor:async p=>({database:p.database,generation:p.generation,settings:{hashAlg:'sha1',chunkSplitterVersion:'v1',disableWorkerForGeneratingChunks:true}}),accessCheck:async()=>true,openRemote:async p=>{opens.push(p.role);return {database:remote,close:async()=>{}}}});
 const editor=await factory('editor')(profile()),viewer=await factory('viewer')(profile({role:'viewer'}));
 try{await remote.put({_id:'_design/stand',views:{}});await editor.write('Owner/a.md',{bytes:new TextEncoder().encode('transferred')});await editor.synchronize();const result=await viewer.synchronize();assert.equal(result.push,null);assert.equal(new TextDecoder().decode((await viewer.read('Owner/a.md')).bytes),'transferred');assert.deepEqual(opens,['editor','viewer']);assert.deepEqual(remoteCheckpoints,[]);}
 finally{await editor.close();await viewer.close();await remote.destroy();}
});

test('failed background progress info does not hide transfer failures or become unhandled',async()=>{
 const source=createDB('shared2-progress-source-'+crypto.randomUUID(),{}),target=createDB('shared2-progress-target-'+crypto.randomUUID(),{});
 const original=source.info.bind(source);let calls=0;source.info=(...args)=>{calls++;return calls===2?Promise.reject(Error('progress request cancelled')):original(...args)};
 try{await source.put({_id:'file',text:'preserved'});await target.replicate.from(source,{checkpoint:'target'});await new Promise(r=>setImmediate(r));assert.equal((await target.get('file')).text,'preserved');assert.ok(calls>=2);assert.throws(()=>patchShared2PouchProgress('unrecognized source'),/Unexpected/);}
 finally{await source.destroy();await target.destroy();}
});

test('required source info errors still reject replication after progress-only patch',async()=>{
 const source=createDB('shared2-required-source-'+crypto.randomUUID(),{}),target=createDB('shared2-required-target-'+crypto.randomUUID(),{});
 source.info=async()=>{throw Error('required source info failed')};
 try{await source.put({_id:'file',text:'not transferred'});await assert.rejects(target.replicate.from(source,{checkpoint:'target'}),/required source info failed/);await assert.rejects(target.get('file'),error=>error.status===404);}
 finally{await source.destroy();await target.destroy();}
});

test('trusted file verifier checks actual engine contents and rejects extra files',async()=>{
 const {verifyShared2Files,shared2FileDigest}=await import('../plugin/shared2-file-verifier.mjs');const x=fixture(),engine=await x.factory(profile());
 try{const bytes=new TextEncoder().encode('source file');await engine.write('Owner/note.md',{bytes});const manifest=[{path:'note.md',size:bytes.length,sha256:await shared2FileDigest(bytes)}];
  const receipt=await verifyShared2Files({engine,manifest,documentRoot:'Owner',isSealed:async()=>true});assert.equal(receipt.verified,true);
  await engine.write('Owner/extra.md',{bytes});await assert.rejects(verifyShared2Files({engine,manifest,documentRoot:'Owner',isSealed:async()=>true}),/unexpected/);
 }finally{await engine.close();}
});

test('actual engine streams binary and Unicode text without assembling a whole output buffer',async()=>{
 const {hashShared2Stream,verifyShared2FilesBounded}=await import('../scripts/shared2-node-file-verifier.mjs');const {shared2FileDigest}=await import('../plugin/shared2-file-verifier.mjs');const x=fixture(),engine=await x.factory(profile());
 try{const binary=Uint8Array.from({length:2*1024*1024},(_,i)=>i%251),text=new TextEncoder().encode('😀русский\n'.repeat(30000));await engine.write('Owner/video.bin',{bytes:binary});await engine.write('Owner/note.md',{bytes:text});
  assert.equal((await hashShared2Stream(engine.stream('Owner/video.bin'))).sha256,await shared2FileDigest(binary));assert.equal((await hashShared2Stream(engine.stream('Owner/note.md'))).sha256,await shared2FileDigest(text));
  const manifest=[{path:'video.bin',size:binary.length,sha256:await shared2FileDigest(binary)},{path:'note.md',size:text.length,sha256:await shared2FileDigest(text)}];const receipt=await verifyShared2FilesBounded({engine,manifest,documentRoot:'Owner',isSealed:async()=>true});assert.equal(receipt.verified,true);
 }finally{await engine.close();}
});

test('actual engine accepts lazy Blob input and validates text without a whole-file read',async()=>{
 const x=fixture(),engine=await x.factory(profile());try{const bytes=new TextEncoder().encode('lazy русский 😀');const blob=new Blob([bytes]);await engine.write('Owner/note.md',{blob});assert.equal(new TextDecoder().decode((await engine.read('Owner/note.md')).bytes),'lazy русский 😀');await assert.rejects(engine.write('Owner/bad.md',{blob:new Blob([new Uint8Array([255])])}));await assert.rejects(engine.write('Owner/ambiguous.bin',{bytes,blob}),/file-bytes/);}finally{await engine.close();}
});

test('revision-aware removal propagates a tombstone and keeps old contents readable',async()=>{
 const x=fixture(),engine=await x.factory(profile());
 try{
  await engine.write('Team/a.md',{bytes:new TextEncoder().encode('original')});const original=await engine.read('Team/a.md');
  await assert.rejects(engine.remove('Team/a.md'),/delete-base-required/);
  const removed=await engine.remove('Team/a.md',{baseRevision:original.revision});assert.equal(await engine.read('Team/a.md'),null);
  assert.equal((await engine.readRevision('Team/a.md',removed.rev)).deleted,true);
  assert.equal(new TextDecoder().decode((await engine.readRevision('Team/a.md',original.revision)).bytes),'original');
  assert.equal((await engine.inspect()).files[0].deleted,true);
 }finally{await engine.close();}
});

test('unknown ancestry preserves both existing remote contents and the independent local root',async()=>{
 const x=fixture(),engine=await x.factory(profile());
 try{
  const original=await engine.write('Team/conflict.md',{bytes:new TextEncoder().encode('server version')});
  const branch=await engine.write('Team/conflict.md',{bytes:new TextEncoder().encode('offline version'),independent:true});
  const file=(await engine.inspect()).files.find(file=>file.path==='Team/conflict.md');assert.equal(file.conflicts.length,1);
  assert.equal(new TextDecoder().decode((await engine.readRevision('Team/conflict.md',original.rev)).bytes),'server version');
  assert.equal(new TextDecoder().decode((await engine.readRevision('Team/conflict.md',branch.rev)).bytes),'offline version');
 }finally{await engine.close();}
});

test('reverse personal target uses original arbitrary private passphrase and path settings',async()=>{
 const p=profile({kind:'personal',folder:'f'.repeat(32),database:'arcalink_p_'+'c'.repeat(32),encrypted:true,keyEpoch:1});
 const config={encrypt:true,passphrase:'Личный пароль: not a shared2 hex key',E2EEAlgorithm:'v2',usePathObfuscation:true},original=structuredClone(config);
 const make=value=>createShared2LocalEngineFactory({namespace:'shared2-personal-test-'+crypto.randomUUID(),migrationMode:true,createPouchDB:createDB,settingsFor:async p=>({database:p.database,generation:p.generation,settings:{hashAlg:'sha1',chunkSplitterVersion:'v1',disableWorkerForGeneratingChunks:true}}),personalEncryptionFor:async()=>value});
 const a=await make(config)(p),b=await make({...config,passphrase:'different original personal password'})(p);
 try{const id=await a.migration.pathId('Team/private.md');assert.notEqual(id,await b.migration.pathId('Team/private.md'));await a.write('Team/private.md',{bytes:new TextEncoder().encode('private target content')});assert.equal(new TextDecoder().decode((await a.read('Team/private.md')).bytes),'private target content');assert.deepEqual(config,original);}finally{await a.close();await b.close();}
 await assert.rejects(make({...config,encrypt:false})(p),/private-cipher-settings/);
 await assert.rejects(make(config)(profile({folder:'f'.repeat(32),encrypted:true,keyEpoch:1})),/encrypted-engine-not-ready/,'personal adapter cannot replace shared folder keys');
});
