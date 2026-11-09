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
 build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'host'}));
 build.onLoad({filter:/^obsidian$/,namespace:'host'},()=>({contents:'export class Modal{};export class Notice{};export class Setting{};export class TFolder{};export function setIcon(){};export function requestUrl(){throw Error("Unexpected requestUrl");}'}));
 build.onResolve({filter:/^@\/common\/translation$|localized-obsidian$/},()=>({path:'translation',namespace:'host'}));
 build.onLoad({filter:/^translation$/,namespace:'host'},()=>({contents:'export const $msg=key=>key;export const localizeMessage=value=>value;'}));
}},shared2ProductionPlugin()],bundle:true,write:false,format:'cjs',platform:'node',nodePaths:[source+'node_modules']});
const Module=require('node:module'),mod=new Module('shared2-host-fixture');mod.filename=source+'shared2-host-fixture.cjs';mod.paths=Module._nodeModulePaths(source);mod._compile(output.outputFiles[0].text,mod.filename);
const {Shared2,createShared2LocalEngineFactory,createDB}=mod.exports;
async function waitFor(fn){const deadline=Date.now()+12000;while(!await fn()){if(Date.now()>deadline)throw Error('host scope did not converge');await new Promise(resolve=>setTimeout(resolve,10));}}
const textIfPresent=file=>{try{return syncFS.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}};

test('actual host scopes use continuous LiveSync on physical files, preserve recovery copies and do not repeat a full scan',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'arcalink-host-live-')),remote=createDB('host-server-'+crypto.randomUUID()),clients=[],errors=[];
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
 assert.deepEqual(await fs.readFile(path.join(b.root,b.mount,'attachment.bin')),attachment);
 const interrupted=await client('interrupted','Retry');
 interrupted.record.shared2InitialPull=interrupted.record.shared2CacheEpoch;
 const firstPull=await interrupted.manager.ensure(interrupted.row,interrupted.mount);
 firstPull.controller.baselineProgress=()=>assert.fail('initial pull must not use the legacy baseline');
 const pull=firstPull.engine.synchronize.bind(firstPull.engine);
 firstPull.engine.synchronize=async()=>{await pull();throw Error('interrupted before applying results');};
 await assert.rejects(firstPull.controller.wake(),/interrupted before applying results/);
 await firstPull.controller.close();await firstPull.engine.close();interrupted.manager.entries.delete(interrupted.row.id);
 const retry=await interrupted.manager.ensure(interrupted.row,interrupted.mount);
 retry.controller.baselineProgress=()=>assert.fail('a resumed pull must not use the legacy baseline');
 await retry.controller.wake();
 await waitFor(()=>retry.controller.activity===0);
 assert.deepEqual(await fs.readFile(path.join(interrupted.root,interrupted.mount,'attachment.bin')),attachment);
 await retry.controller.close();await retry.engine.close();interrupted.manager.entries.delete(interrupted.row.id);
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
