import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFS,{createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {shared2ProductionPlugin} from '../scripts/shared2-production-build.mjs';
const source=fileURLToPath(new URL('../.cache/source/',import.meta.url)),require=createRequire(source+'esbuild.config.mjs');
const output=await require('esbuild').build({stdin:{contents:`
 export {Shared2} from '../../plugin/shared2';
 export {createShared2LocalEngineFactory} from '../../plugin/shared2-local-engine.mjs';
 import {Shared2PouchDB as PouchDB} from '../../plugin/shared2-pouch.mjs';
 import Memory from 'pouchdb-adapter-memory';PouchDB.plugin(Memory);
 export const createDB=(name,options)=>new PouchDB(name,{...options,adapter:'memory'});
`,resolveDir:source},plugins:[{name:'host-headless',setup(build){
 build.onResolve({filter:/ConflictResolveModal$/},()=>({path:'conflict-modal',namespace:'host'}));build.onLoad({filter:/^conflict-modal$/,namespace:'host'},()=>({contents:'export class ConflictResolveModal{}'}));
 build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'host'}));
 build.onLoad({filter:/^obsidian$/,namespace:'host'},()=>({contents:'export class Modal{};export class Notice{};export class Setting{};export class TFolder{};export function setIcon(){};export function requestUrl(){throw Error("Unexpected requestUrl");}'}));
 build.onResolve({filter:/^@\/common\/translation$|localized-obsidian$/},()=>({path:'translation',namespace:'host'}));
 build.onLoad({filter:/^translation$/,namespace:'host'},()=>({contents:'export const $msg=key=>key;export const localizeMessage=value=>value;'}));
}},shared2ProductionPlugin()],bundle:true,write:false,format:'cjs',platform:'node',nodePaths:[source+'node_modules']});
const Module=require('node:module'),mod=new Module('shared2-host-fixture');mod.filename=source+'shared2-host-fixture.cjs';mod.paths=Module._nodeModulePaths(source);mod._compile(output.outputFiles[0].text,mod.filename);
const {Shared2,createShared2LocalEngineFactory,createDB}=mod.exports;
async function waitFor(fn){const deadline=Date.now()+12000;while(!await fn()){if(Date.now()>deadline)throw Error('host scope did not converge');await new Promise(resolve=>setTimeout(resolve,10));}}
const textIfPresent=file=>{try{return syncFS.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}};

async function hostFixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'arcalink-host-live-')),remote=createDB('host-server-'+crypto.randomUUID()),clients=[],errors=[];
 await remote.put({_id:'_design/arcalink_shared2_access',filters:{files:"function(doc,req){return doc._id.charAt(0)!=='_';}"}});
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url);
  if(url.origin!=='http://arcalink-host.test')return originalFetch(input,options);
  const [id,...parts]=url.pathname.slice(1).split('/'),client=clients.find(client=>client.id===id),name=parts.map(decodeURIComponent).join('/');
  if(!client)return new Response(null,{status:404});
  client.reads.push(name);const full=path.join(client.root,name);
  if(!syncFS.existsSync(full))return new Response(null,{status:404});
  return new Response(Readable.toWeb(createReadStream(full)));
 };
 t.after(async()=>{for(const c of clients){c.manager.disposed=true;for(const e of c.manager.entries.values()){await e.controller.close();await e.engine.close();}await Promise.allSettled(c.background);}globalThis.fetch=originalFetch;await remote.destroy();await fs.rm(directory,{recursive:true,force:true});});
 async function client(id,mount){
  const root=path.join(directory,id);await fs.mkdir(root);
  const scope={account:id,workspace:'c'.repeat(32)},folder='a'.repeat(32),row={id:folder,owner:'a',ownerWorkspace:'c'.repeat(32),documentRoot:'Owner/Shared',database:'arcalink_s_'+'b'.repeat(32),generation:1,revision:1,role:'editor',encrypted:false,keyEpoch:0,authorityEpoch:1,membershipEpoch:1};
  const record={id:folder,protocol:2,mount,role:'editor',shared2Scope:scope,shared2CacheEpoch:'d'.repeat(32)},background=[],reads=[];
  const full=name=>path.join(root,name),stat=async name=>{try{const s=await fs.stat(full(name));return {type:s.isDirectory()?'folder':'file',size:s.size,ctime:s.ctimeMs,mtime:s.mtimeMs};}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const walk=(name='')=>{const result=[];if(!syncFS.existsSync(full(name)))return result;for(const entry of syncFS.readdirSync(full(name),{withFileTypes:true})){const file=(name?name+'/':'')+entry.name;if(entry.isDirectory())result.push(...walk(file));else{const s=syncFS.statSync(full(file));result.push({path:file,name:entry.name,stat:{size:s.size,mtime:s.mtimeMs,ctime:s.ctimeMs}});}}return result;};
  let manager;
  const emit=(event,name)=>{if(!name.startsWith(mount+'/')||!manager||manager.disposed)return;const item=walk().find(file=>file.path===name)||{path:name,stat:{}};const task=manager.changed(event,item).catch(error=>errors.push(error));background.push(task);};
  const adapter={stat,exists:async name=>!!await stat(name),mkdir:async name=>fs.mkdir(full(name)),read:async name=>fs.readFile(full(name),'utf8'),write:async(name,data)=>fs.writeFile(full(name),data),
   readBinary:async name=>{const value=await fs.readFile(full(name));return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);},
   writeBinary:async(name,data)=>fs.writeFile(full(name),new Uint8Array(data)),appendBinary:async(name,data)=>fs.appendFile(full(name),new Uint8Array(data)),
   copy:async(from,to)=>fs.copyFile(full(from),full(to)),
   rename:async(from,to)=>{if(await stat(to))throw Error('Destination already exists');await fs.rename(full(from),full(to));emit('delete',from);emit('create',to);},
   remove:async name=>{await fs.unlink(full(name));emit('delete',name);},
   list:async name=>{const entries=await fs.readdir(full(name),{withFileTypes:true});return {files:entries.filter(e=>e.isFile()).map(e=>name+'/'+e.name),folders:entries.filter(e=>e.isDirectory()).map(e=>name+'/'+e.name)};},
   getResourcePath:name=>'http://arcalink-host.test/'+id+'/'+name.split('/').map(encodeURIComponent).join('/')};
  const storage={getStub:async name=>{const s=await stat(name);return s?{path:name,name:name.split('/').at(-1),stat:s,...(s.type==='folder'?{isFolder:true}:{})}:null;},getFiles:async()=>walk(),normalisePath:name=>name,touched:async()=>{},_triggerFileEvent:async(event,name)=>{await Promise.resolve();emit(event,name);},renameFile:async(file,to)=>{await fs.rename(full(file.path),full(to));return storage.getStub(to);},vaultManager:{watchVaultRename(){}}};
  const plugin={app:{vault:{adapter,getFiles:()=>walk()},fileManager:{}},pilotDirectory:'.obsidian/plugins/arcalink-sync',folders:{records:[record],record:name=>name===mount||name.startsWith(mount+'/')?record:null,save:async()=>{},refresh(){}},core:{serviceModules:{storageAccess:storage}},unifiedVault:{base:'https://arcalink.invalid/sync/api'}};
  manager=new Shared2(plugin);manager.scope=scope;manager.catalog={protocol:2,revision:1,folders:[row]};manager.enabled=true;manager.initialized=true;manager.session=async()=>({session:{email:id+'@example.invalid',deviceId:id},workspace:scope.workspace});manager.context=manager.signature(await manager.session());
  const namespace='shared2-host-'+id+'-'+crypto.randomUUID();
  manager.engineFactory=options=>createShared2LocalEngineFactory({...options,namespace,createPouchDB:createDB,openRemote:async()=>({database:remote,close:async()=>{}})});
  const result={id,root,reads,manager,row,mount,background,record,submitted:[]};clients.push(result);
  await fs.mkdir(full(plugin.pilotDirectory),{recursive:true});await fs.mkdir(full(mount),{recursive:true});return result;
 }
 return {client,remote,errors};
}

test('actual host scopes use continuous LiveSync on physical files, preserve recovery copies and do not repeat a full scan',async t=>{
 const {client,remote,errors}=await hostFixture(t);
 const a=await client('a','Local'),b=await client('b','Elsewhere');
 b.record.shared2InitialPull=b.record.shared2CacheEpoch;
 await fs.writeFile(path.join(a.root,a.mount,'note.md'),'Original');await fs.writeFile(path.join(a.root,a.mount,'untouched.md'),'Untouched');
 await fs.writeFile(path.join(a.root,a.mount,'delete-offline.md'),'Delete while app is closed');
 const attachment=Buffer.alloc(3*1024*1024+1,0x8f);
 attachment[attachment.length-1]=0x5a;
 await fs.writeFile(path.join(a.root,a.mount,'attachment.bin'),attachment);
 const ae=await a.manager.ensure(a.row,a.mount);await ae.controller.wake();
 const be=await b.manager.ensure(b.row,b.mount);
 be.controller.baselineProgress=()=>assert.fail('an empty recipient mount must not enter legacy reconciliation');
 const enqueue=be.controller.enqueue;be.controller.enqueue=item=>{b.submitted.push(item);return enqueue(item);};
 await be.controller.wake();
 const bNote=path.join(b.root,b.mount,'note.md');await waitFor(()=>syncFS.existsSync(bNote));
 await waitFor(()=>ae.controller.activity===0&&be.controller.activity===0);
 assert.ok(be.metrics.applied>=1,'verified file applications are counted for this session');
 assert.deepEqual(await fs.readFile(path.join(b.root,b.mount,'attachment.bin')),attachment);
 const interrupted=await client('interrupted','Retry');
 interrupted.record.shared2InitialPull=interrupted.record.shared2CacheEpoch;
 const firstPull=await interrupted.manager.ensure(interrupted.row,interrupted.mount);
 firstPull.controller.baselineProgress=()=>assert.fail('initial pull must not use the legacy baseline');
 const pull=firstPull.engine.synchronize.bind(firstPull.engine);
 firstPull.engine.synchronize=async()=>{await pull();throw Error('interrupted before applying results');};
 await assert.rejects(firstPull.controller.wake(),/interrupted before applying results/);
 await firstPull.controller.close();await firstPull.engine.close();interrupted.manager.entries.delete(interrupted.row.id);
 await fs.writeFile(path.join(interrupted.root,interrupted.mount,'extra.md'),'Added while closed');
 const retry=await interrupted.manager.ensure(interrupted.row,interrupted.mount);
 retry.controller.baselineProgress=()=>assert.fail('a resumed pull must not use the legacy baseline');
 await assert.rejects(retry.controller.wake(),/shared2-initial-review-required/);
 assert.equal(interrupted.record.shared2InitialVerifiedEpoch,undefined);
 assert.equal(await fs.readFile(path.join(interrupted.root,interrupted.mount,'extra.md'),'utf8'),'Added while closed');
 assert.equal(await retry.engine.metadata('Owner/Shared/extra.md'),null);
 await fs.unlink(path.join(interrupted.root,interrupted.mount,'extra.md'));
 await retry.controller.enqueue({type:'CREATE',args:{file:{path:'Owner/Shared/note.md',name:'note.md',stat:{type:'file',size:1,mtime:1,ctime:1}}}});
 await retry.controller.wake();
 const pendingRuntime=await interrupted.manager.store('livesync-'+interrupted.row.id+'-'+interrupted.row.generation+'-'+interrupted.record.shared2CacheEpoch).load();assert.deepEqual(pendingRuntime.events,[]);

 assert.equal(interrupted.record.shared2InitialReview,false);assert.deepEqual(interrupted.manager.errorMessages,[]);
 await waitFor(()=>retry.controller.activity===0);
 assert.deepEqual(await fs.readFile(path.join(interrupted.root,interrupted.mount,'attachment.bin')),attachment);
 await retry.controller.close();await retry.engine.close();interrupted.manager.entries.delete(interrupted.row.id);
 const unsafe=await client('unsafe','Unsafe');unsafe.record.shared2InitialPull=unsafe.record.shared2CacheEpoch;
 await fs.writeFile(path.join(unsafe.root,unsafe.mount,'note.md'),'Local unsynced bytes');
 const unsafeEntry=await unsafe.manager.ensure(unsafe.row,unsafe.mount);
 const unsafeFile={path:'Owner/Shared/note.md',name:'note.md',stat:{type:'file',size:20,mtime:1,ctime:1}};
 await unsafeEntry.controller.enqueue({type:'CREATE',args:{file:unsafeFile}});await unsafeEntry.controller.enqueue({type:'CHANGED',args:{file:unsafeFile}});
 await assert.rejects(unsafeEntry.controller.wake(),/shared2-initial-review-required|shared2-initial-proof-incomplete|shared2-initial-proof-conflict/);
 const unsafeRuntime=await unsafe.manager.store('livesync-'+unsafe.row.id+'-'+unsafe.row.generation+'-'+unsafe.record.shared2CacheEpoch).load();
 assert.deepEqual(unsafeRuntime.events.map(event=>event.item.type),['CREATE','CHANGED']);assert.equal(unsafe.record.shared2InitialVerifiedEpoch,undefined);
 assert.equal(await fs.readFile(path.join(unsafe.root,unsafe.mount,'note.md'),'utf8'),'Local unsynced bytes');
 await unsafeEntry.controller.close();await unsafeEntry.engine.close();unsafe.manager.entries.delete(unsafe.row.id);
 const waitingLocal=await unsafe.manager.ensure(unsafe.row,unsafe.mount);
 waitingLocal.engine.results.reprocessStoredDocuments=()=>assert.fail('stable local event replayed the database');
 waitingLocal.engine.metadataFiles=()=>assert.fail('stable local event repeated the entire proof');
 await assert.rejects(waitingLocal.controller.wake(),/initial-review-required/);
 assert.equal(waitingLocal.controller.state.path,unsafeFile.path);
 assert.deepEqual(waitingLocal.controller.initialConflict.eventIds,unsafeRuntime.events.map(event=>event.id));
 await waitingLocal.controller.close();await waitingLocal.engine.close();unsafe.manager.entries.delete(unsafe.row.id);
 const legacy=await client('legacy','Legacy');
 legacy.record.shared2InitialPull=legacy.record.shared2CacheEpoch;
 let legacyEntry=await legacy.manager.ensure(legacy.row,legacy.mount);await legacyEntry.controller.wake();
 const originalRevision=(await legacyEntry.engine.metadata('Owner/Shared/note.md'))._rev;
 await legacyEntry.controller.close();await legacyEntry.engine.close();legacy.manager.entries.delete(legacy.row.id);
 delete legacy.record.shared2InitialPull;delete legacy.record.shared2InitialVerifiedEpoch;
 await fs.writeFile(path.join(legacy.root,legacy.mount,'note.md'),'Offline legacy edit');
 legacyEntry=await legacy.manager.ensure(legacy.row,legacy.mount);
 await assert.rejects(legacyEntry.controller.wake(),/shared2-initial-review-required/);
 assert.equal(await fs.readFile(path.join(legacy.root,legacy.mount,'note.md'),'utf8'),'Offline legacy edit');
 assert.equal((await legacyEntry.engine.metadata('Owner/Shared/note.md'))._rev,originalRevision);
 assert.equal(legacy.record.shared2InitialReview,true);
 await legacyEntry.controller.close();await legacyEntry.engine.close();legacy.manager.entries.delete(legacy.row.id);
 const beforeA=a.reads.length,beforeB=b.reads.length;
 for(let i=0;i<20;i++){await ae.controller.wake();await be.controller.wake();}
 assert.equal(a.reads.length,beforeA);assert.equal(b.reads.length,beforeB);
 await fs.writeFile(path.join(a.root,a.mount,'note.md'),'Updated');await a.manager.changed('modify',{path:a.mount+'/note.md',stat:{}});
 await waitFor(()=>textIfPresent(bNote)==='Updated');
 assert.equal(a.reads.slice(beforeA).some(name=>name.endsWith('untouched.md')),false);assert.equal(b.reads.slice(beforeB).some(name=>name.endsWith('untouched.md')),false);
 await waitFor(()=>be.controller.activity===0);
 assert.deepEqual(b.submitted,[],'native writes and deferred reflection notifications must not enter the local event queue');
 const ledger=await be.controller.ledger();assert.ok(ledger.recovery.some(item=>item.path==='note.md'));
 await fs.mkdir(path.join(a.root,a.mount,'Attachments'));await fs.rename(path.join(a.root,a.mount,'note.md'),path.join(a.root,a.mount,'Attachments/note.md'));
 await a.manager.renamed({path:a.mount+'/Attachments/note.md',stat:{}},a.mount+'/note.md');
 try{await waitFor(()=>!syncFS.existsSync(bNote)&&syncFS.existsSync(path.join(b.root,b.mount,'Attachments/note.md')));}catch(error){console.log({aState:ae.controller.state,bState:be.controller.state,aMeta:await ae.engine.metadataFiles(),bMeta:await be.engine.metadataFiles(),errors:errors.map(error=>error.code||error.message)});throw error;}
 assert.equal(syncFS.readFileSync(path.join(b.root,b.mount,'Attachments/note.md'),'utf8'),'Updated');
 await fs.rm(path.join(a.root,a.mount,'Attachments'),{recursive:true});await a.manager.changed('delete',{path:a.mount+'/Attachments',children:[]});
 try{await waitFor(()=>!syncFS.existsSync(path.join(b.root,b.mount,'Attachments/note.md')));}catch(error){console.log({stage:'delete-directory',aState:ae.controller.state,bState:be.controller.state,aMeta:await ae.engine.metadataFiles(),bMeta:await be.engine.metadataFiles(),errors:errors.map(error=>error.code||error.message)});throw error;}
 // Reopen the same cache identity after an offline edit and deletion. The
 // standard file handler must use persisted displayed ancestry, not the old
 // one-time full-reconciliation ledger.
 await be.controller.close();await be.engine.close();b.manager.entries.delete(b.row.id);
 await fs.writeFile(path.join(b.root,b.mount,'untouched.md'),'Edited while closed');
 await fs.unlink(path.join(b.root,b.mount,'delete-offline.md'));
 await fs.writeFile(path.join(b.root,b.mount,'created-offline.md'),'Created while closed');
 await fs.writeFile(path.join(a.root,a.mount,'remote-offline.md'),'Created on the other device');
 await a.manager.changed('create',{path:a.mount+'/remote-offline.md',stat:{}});
 const remoteDoc=await ae.engine.metadata('Owner/Shared/remote-offline.md');
 await waitFor(async()=>!!await remote.get(remoteDoc._id).catch(()=>null));
 const reopened=await b.manager.ensure(b.row,b.mount);await reopened.controller.wake();
 await waitFor(()=>textIfPresent(path.join(a.root,a.mount,'untouched.md'))==='Edited while closed');
 await waitFor(()=>!syncFS.existsSync(path.join(a.root,a.mount,'delete-offline.md')));
 await waitFor(()=>textIfPresent(path.join(a.root,a.mount,'created-offline.md'))==='Created while closed');
 await waitFor(()=>textIfPresent(path.join(b.root,b.mount,'remote-offline.md'))==='Created on the other device');
 await waitFor(()=>reopened.controller.activity===0);
 const revision=(await reopened.engine.metadata('Owner/Shared/untouched.md'))._rev;
 assert.equal((await reopened.engine.metadata('Owner/Shared/untouched.md'))._conflicts?.length||0,0);
 await reopened.controller.close();await reopened.engine.close();b.manager.entries.delete(b.row.id);
 const readsBeforeRestart=b.reads.length;
 const unchanged=await b.manager.ensure(b.row,b.mount);await unchanged.controller.wake();
 await waitFor(()=>unchanged.controller.activity===0);
 assert.deepEqual(b.reads.slice(readsBeforeRestart),[],'a verified restart must not open file contents');
 assert.equal((await unchanged.engine.metadata('Owner/Shared/untouched.md'))._rev,revision);
 await Promise.allSettled([...a.background,...b.background]);assert.deepEqual(errors,[]);
 assert.equal(ae.engine.getReplicationState().syncStatus==='ERRORED',false);
});


test('initial deletion review survives reopening, preserves local work and resumes only after proof',async t=>{
 const {client,remote}=await hostFixture(t);
 const name='report.xls',file='Owner/Shared/'+name;
 const writer=await client('writer','Live');
 await fs.writeFile(path.join(writer.root,writer.mount,name),Buffer.from([1,2,3]));
 const author=await writer.manager.ensure(writer.row,writer.mount);await author.controller.wake();
 const id=(await author.engine.metadata(file))._id;
 await waitFor(async()=>!!await remote.get(id).catch(()=>null));
 const original=await remote.get(id);
 await author.controller.close();await author.engine.close();writer.manager.entries.delete(writer.row.id);
 const [generation,parent]=original._rev.split('-');
 const start=Number(generation)+1;
 await remote.bulkDocs(['a','b'].map(c=>({...original,_rev:start+'-'+c.repeat(32),deleted:true,
  _revisions:{start,ids:[c.repeat(32),parent]}})),{new_edits:false});
 async function waiting(id){
  const c=await client(id,'Mount');
  c.record.shared2InitialPull=c.record.shared2CacheEpoch;
  c.manager.catalog.capabilities={confirmDeletion:1};
  const open=()=>c.manager.ensure(c.row,c.mount);
  const entry=await open();
  await assert.rejects(entry.controller.wake(),/shared2-initial-proof-conflict/);
  assert.equal(entry.controller.state.path,file);
  return {c,entry,open};
 }
 const clean=await waiting('clean'),dirty=await waiting('dirty'),restored=await waiting('restored'),renamed=await waiting('renamed');
 await clean.entry.controller.close();await clean.entry.engine.close();clean.c.manager.entries.delete(clean.c.row.id);
 clean.entry=await clean.open();
 clean.entry.engine.results.reprocessStoredDocuments=()=>assert.fail('stable conflict replayed the database');
 for(let i=0;i<3;i++)await assert.rejects(clean.entry.controller.wake(),/shared2-initial-proof-conflict/);
 const entry=dirty.entry,c=dirty.c;
 const meta=await entry.engine.metadata(file);
 const review=c.manager.initialDeletionReview(c.record,entry,meta,async()=>assert.ok(await entry.checked()));
 // The local session adapter is stubbed; PouchDB still operates on real revision trees.
 let submissions=0;
 c.manager.request=async(route,options)=>{
  await options.beforeSend();
  assert.equal(route,'/shared2/confirm-deletion');
  const action=JSON.parse(options.body);
  assert.deepEqual(Object.keys(action).sort(),['database','discard','document','keep','operation']);
  submissions++;
  await remote.remove(action.document,action.discard);
  return {status:200,json:{revision:action.keep,operation:action.operation}};
 };
 const moved={path:'Owner/Shared/archive/report.xls',name,stat:{type:'file',size:3,ctime:1,mtime:1}};
 await renamed.entry.controller.enqueue({type:'RENAME',args:{file:moved,oldPath:file}});
 const movedReview=renamed.c.manager.initialDeletionReview(renamed.c.record,renamed.entry,meta,async()=>assert.ok(await renamed.entry.checked()));
 assert.equal(await movedReview.available(),false);
 assert.equal(await review.available(),true);
 delete c.manager.catalog.capabilities.confirmDeletion;
 assert.equal(await review.available(),false);
 c.manager.catalog.capabilities.confirmDeletion=1;
 c.record.shared2LocalPaused=true;await assert.rejects(review.confirm(),/conflict-changed/);delete c.record.shared2LocalPaused;
 await fs.writeFile(path.join(c.root,c.mount,name),'recreated before submission');
 await assert.rejects(review.confirm(),/conflict-changed/);assert.equal(submissions,0);
 await fs.unlink(path.join(c.root,c.mount,name));
 const pendingFile={path:'Owner/Shared/draft.md',name:'draft.md',stat:{type:'file',size:7,ctime:1,mtime:1}};
 await fs.writeFile(path.join(c.root,c.mount,'draft.md'),'private');
 await entry.controller.enqueue({type:'CREATE',args:{file:pendingFile}});
 await review.confirm();
 await fs.writeFile(path.join(restored.c.root,restored.c.mount,name),'recreated after submission');
 await assert.rejects(restored.entry.controller.wake(),/initial-review-required/);
 assert.equal(await fs.readFile(path.join(restored.c.root,restored.c.mount,name),'utf8'),'recreated after submission');
 await assert.rejects(entry.controller.wake(),/initial-review-required/);
 assert.equal(entry.controller.ready,false);
 assert.equal(await fs.readFile(path.join(c.root,c.mount,'draft.md'),'utf8'),'private');
 assert.equal((await c.manager.store('livesync-'+c.row.id+'-1-'+c.record.shared2CacheEpoch).load()).events[0].item.args.file.path,pendingFile.path);
 assert.equal((await remote.allDocs({include_docs:true})).rows.some(row=>row.doc?.path===pendingFile.path),false);
 assert.equal((await remote.get(id,{conflicts:true}))._conflicts,undefined);
 await clean.entry.controller.wake();assert.equal(clean.entry.controller.ready,true);
 assert.equal(clean.c.record.shared2InitialVerifiedEpoch,clean.c.record.shared2CacheEpoch);
});

test('initial recovery reconciles 16 durable events on 14 exact paths without writing to the server',async t=>{
 const {client,remote}=await hostFixture(t);
 const names=Array.from({length:13},(_,i)=>i===0?'archive/old.bin':'note-'+i+'.bin');
 const source=await client('source','Publish'),target=await client('target','Receive');
 const data=name=>Buffer.from('independent bytes of '+name+'\0','utf8');
 for(const c of [source,target])await fs.mkdir(path.join(c.root,c.mount,'archive'));
 for(const name of names)for(const c of [source,target])await fs.writeFile(path.join(c.root,c.mount,name),data(name));
 await fs.writeFile(path.join(source.root,source.mount,'old.bin'),'historical bytes');
 const writer=await source.manager.ensure(source.row,source.mount);await writer.controller.wake();
 const canonical=name=>'Owner/Shared/'+name;
 const old=await writer.engine.metadata(canonical('old.bin'));
 await waitFor(async()=>!!await remote.get(old._id).catch(()=>null));
 await writer.controller.close();await writer.engine.close();source.manager.entries.delete(source.row.id);
 const parent=await remote.get(old._id);
 await remote.put({...parent,deleted:true,mtime:Date.now()});
 const before=(await remote.info()).update_seq;
 target.record.shared2InitialPull=target.record.shared2CacheEpoch;
 const recipient=await target.manager.ensure(target.row,target.mount);
 const event=(name,type)=>recipient.controller.enqueue({type,args:{file:{name,path:canonical(name),stat:{type:'file',mtime:1,ctime:1,size:data(name).length}}}});
 for(const name of names.slice(0,11))await event(name,'CREATE');
 await event('old.bin','CREATE');
 for(const name of names.slice(11)){await event(name,'DELETE');await event(name,'CREATE');}
 const store=target.manager.store('livesync-'+target.row.id+'-1-'+target.record.shared2CacheEpoch);
 assert.equal((await store.load()).events.length,16);
 await recipient.controller.wake();
 assert.equal(target.record.shared2InitialVerifiedEpoch,target.record.shared2CacheEpoch);
 for(const name of names){
  const bytes=await fs.readFile(path.join(target.root,target.mount,name));
  assert.deepEqual(await crypto.subtle.digest('SHA-256',bytes),await crypto.subtle.digest('SHA-256',data(name)));
 }
 assert.equal(syncFS.existsSync(path.join(target.root,target.mount,'old.bin')),false);
 assert.deepEqual((await store.load()).events,[]);
 for(let i=0;i<3;i++)await recipient.controller.wake();
 assert.equal((await remote.info()).update_seq,before);
 await recipient.controller.close();await recipient.engine.close();target.manager.entries.delete(target.row.id);
 const reopened=await target.manager.ensure(target.row,target.mount);await reopened.controller.wake();
 assert.equal(reopened.controller.ready,true);assert.deepEqual((await store.load()).events,[]);
 assert.equal((await remote.info()).update_seq,before);
});

test('early selection preserves a binary branch and applies exactly the reviewed decision before upload',async t=>{
 const {client,remote}=await hostFixture(t);
 const source=await client('publisher','Pub'),receiver=await client('editor','Local');
 const name='sample.xls',logical='Owner/Shared/'+name;
 const original=Buffer.from([0,255,70,1]);
 await fs.writeFile(path.join(source.root,source.mount,name),original);
 const author=await source.manager.ensure(source.row,source.mount);await author.controller.wake();
 const id=(await author.engine.metadata(logical))._id;
 await waitFor(()=>remote.get(id).then(()=>true,()=>false));
 await author.controller.close();await author.engine.close();source.manager.entries.delete(source.row.id);
 const base=await remote.get(id),n=Number(base._rev.split('-')[0])+1;
 const leaves=['a','b'].map(c=>({...base,deleted:c==='b',_rev:n+'-'+c.repeat(32),_revisions:{start:n,ids:[c.repeat(32),base._rev.split('-')[1]]}}));
 await remote.bulkDocs(leaves,{new_edits:false});
 receiver.record.shared2InitialPull=receiver.record.shared2CacheEpoch;
 receiver.manager.catalog.capabilities={resolveConflict:1};
 const e=await receiver.manager.ensure(receiver.row,receiver.mount);
 await assert.rejects(e.controller.wake(),/initial-proof-conflict/);
 const meta=await e.engine.metadata(logical),keep=leaves[0]._rev;
 const diskPath=path.join(receiver.root,receiver.mount,name);
 await fs.writeFile(diskPath,'local version seen by the user');
 const hash=await e.disk.fingerprint(name),current=async()=>{if(!await e.checked())throw Error('shared2-conflict-changed');};
 const compare=async()=>receiver.manager.initialVersionReview(receiver.record,e,meta,current,await receiver.manager.reviewFileState(e,name),[]);
 const review=await compare();
 const download=await e.engine.readRevision(logical,keep);assert.deepEqual(Buffer.from(download.bytes),original);
 const backup=await e.disk.backup(name,hash);
 let requests=0;
 receiver.manager.request=async(route,options)=>{
  await options.beforeSend();requests++;
  assert.equal(route,'/shared2/resolve-conflict');const action=JSON.parse(options.body);
  assert.deepEqual(action.revisions,leaves.map(l=>l._rev));
  assert.equal(e.canUpload(),false);
  for(const rev of action.revisions)if(rev!==action.keep)await remote.remove(action.document,rev);
  return {status:200,json:{revision:action.keep,operation:action.operation}};
 };
 await fs.writeFile(diskPath,'concurrent edit');
 await assert.rejects(review.confirm(keep),/conflict-changed/);
 assert.equal(requests,0);
 await fs.writeFile(diskPath,'local version seen by the user');
 await assert.rejects(review.confirm(keep),/conflict-changed/);
 await (await compare()).confirm(keep);assert.equal(requests,1);
 await e.controller.close();await e.engine.close();receiver.manager.entries.delete(receiver.row.id);
 const restored=await receiver.manager.ensure(receiver.row,receiver.mount);
 await restored.controller.wake();
 assert.equal(restored.controller.ready,true);
 assert.deepEqual(await fs.readFile(diskPath),original);
 assert.equal(await fs.readFile(path.join(receiver.root,backup),'utf8'),'local version seen by the user');
});
