import test from 'node:test';import assert from 'node:assert/strict';import * as Y from '../collaboration/node_modules/yjs/dist/yjs.mjs';import {bytesToBase64,base64ToBytes,folderPaths,safeRelative} from '../plugin/folder-model.mjs';
import {webcrypto} from 'node:crypto';
import {blobDigest,uploadSharedBlob,downloadSharedBlob} from '../plugin/shared-folder-blobs.mjs';
globalThis.crypto??=webcrypto;
class TestFile {constructor(path){this.path=path;this.extension=path.split('.').at(-1);}}
function file(doc,id,path,content,type='text'){const f=new Y.Map();f.set('path',path);f.set('type',type);if(type==='text'){const t=new Y.Text();t.insert(0,content);f.set('content',t);}else f.set('content',content);doc.getMap('files').set(id,f);return f;}
import fs from 'node:fs';import {stripTypeScriptTypes} from 'node:module';import {runInNewContext} from 'node:vm';
import {createSyncFeedback,folderSyncFailure} from '../plugin/sync-feedback.mjs';
import {unsupportedVersionMessage} from '../plugin/pilot-http.mjs';
import {createStartupNoticeGate} from '../plugin/startup-notices.mjs';
import {createMessageTranslator} from '../plugin/message-language.mjs';
import catalog from '../plugin/message-catalog.mjs';
function controller(){const notices=[];const ctx={Y,crypto:webcrypto,TextEncoder,TextDecoder,TFile:TestFile,blobDigest,uploadSharedBlob,downloadSharedBlob,bytesToBase64,base64ToBytes,folderPaths,safeRelative,createSyncFeedback,folderSyncFailure,Logger:()=>{},LOG_LEVEL_VERBOSE:0,EditorState:{readOnly:{of:v=>({readOnly:v})}},EditorView:{editable:{of:v=>({editable:v})}},Prec:{highest:v=>v},StateEffect:{appendConfig:{of:v=>v}},yCollab:()=>({binding:true}),keymap:{of:v=>v},yUndoManagerKeymap:[],Notice:class{constructor(message){this.message=message;notices.push(this);}hide(){this.hidden=true;}}};const source=fs.readFileSync(new URL('../plugin/folders.ts',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace(/\bexport /g,'');runInNewContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.Controller=SharedFolders;',ctx);const settings={isConfigured:true,couchDB_DBNAME:'personal',couchDB_USER:'pilot_test',couchDB_PASSWORD:'test-only'};const manager=new ctx.Controller({app:{},core:{services:{setting:{currentSettings:()=>settings}}},unifiedVault:{base:'https://example.invalid/api'},collaboration:{api:async()=>({role:'owner'})}});manager.settings=settings;manager.notices=notices;manager.save=async()=>{};manager.refresh=()=>{};return manager;}
test('mobile shared-folder startup keeps its failure state without showing transient popups',async()=>{
 const manager=controller();manager.plugin.startupSyncNotices=createStartupNoticeGate({enabled:true,translate:createMessageTranslator(catalog),readState:async()=>({}),notify:()=>{},schedule:()=>1,cancel:()=>{}});
 manager.discover=async()=>{throw Error('network timeout');};assert.equal(await manager.refreshBeforeSync(),false);
 assert.equal(manager.notices.length,0);assert.equal(manager.syncFeedback.messages.length,1);
 manager.discover=async()=>{throw Object.assign(Error(unsupportedVersionMessage),{status:403});};assert.equal(await manager.refreshBeforeSync(),false);assert.equal(manager.notices.length,1);assert.match(manager.notices[0].message,/эту версию ArcaLink/);
 manager.plugin.startupSyncNotices.dispose();manager.dispose();
});
test('preflight refusal blocks sync and reports the confirmed reason once until recovery',async()=>{
 const manager=controller();let fails=true,saves=0,bindings=0;
 manager.plugin.core={services:{setting:{currentSettings:()=>({isConfigured:true})}}};
 manager.records=[{id:'team',mount:'Team'}];manager.save=async()=>saves++;
 manager.ensure=async()=>bindings++;
 manager.plugin.collaboration.api=async action=>{assert.equal(action,'folders');if(fails)throw Object.assign(Error(unsupportedVersionMessage),{status:403});return {folders:[]};};
 for(let i=0;i<5;i++)assert.equal(await manager.refreshBeforeSync(),false);
 assert.equal(saves,0);assert.equal(bindings,0);assert.equal(manager.contains('Team/private.md'),true);
 assert.equal(manager.notices.length,1);assert.match(manager.notices[0].message,/Локальные заметки сохранены.*эту версию ArcaLink/);assert.equal(manager.syncFeedback.messages.length,1);
 fails=false;assert.equal(await manager.refreshBeforeSync(),true);assert.equal(saves,1);assert.equal(bindings,1);assert.equal(manager.notices[0].hidden,true);assert.deepEqual(manager.syncFeedback.messages,[]);
 fails=true;manager.lastRefresh-=15000;assert.equal(await manager.refreshBeforeSync(),false);assert.equal(manager.notices.length,2);
});

test('changed preflight cause replaces the previous notice and late rejection after unload stays silent',async()=>{
 const manager=controller();manager.discover=async()=>{throw Object.assign(Error(unsupportedVersionMessage),{status:403});};await manager.refreshBeforeSync();
 manager.discover=async()=>{throw Object.assign(Error('expired'),{status:401});};await manager.refreshBeforeSync();assert.equal(manager.notices.length,2);assert.equal(manager.notices[0].hidden,true);assert.match(manager.notices[1].message,/Повторно войдите/);assert.doesNotMatch(manager.notices[1].message,/эту версию/);
 let reject;manager.discover=()=>new Promise((_,r)=>reject=r);const pending=manager.refreshBeforeSync();manager.dispose();reject(Error('late private details'));assert.equal(await pending,false);assert.equal(manager.notices.length,2);assert.equal(manager.notices[1].hidden,true);assert.deepEqual(manager.syncFeedback.messages,[]);
});
test('disposal and stale preflight results cannot resurrect or clear a newer failure',async()=>{const manager=controller();let resolve;manager.discover=()=>new Promise(r=>resolve=r);const stale=manager.refreshBeforeSync();manager.settings.couchDB_DBNAME='other';manager.discover=async()=>{throw Error('private implementation details');};assert.equal(await manager.refreshBeforeSync(),false);resolve();assert.equal(await stale,false);assert.equal(manager.syncFeedback.messages.length,1);assert.equal(manager.notices.length,1);manager.discover=()=>new Promise(r=>resolve=r);const pending=manager.refreshBeforeSync();manager.dispose();resolve();assert.equal(await pending,false);assert.equal(manager.notices.length,1);assert.equal(manager.notices[0].hidden,true);assert.deepEqual(manager.syncFeedback.messages,[]);assert.equal(await manager.refreshBeforeSync(),false);});
test('concurrent successful checks share discovery and both pass the actual readiness gate',async()=>{
 const {createReplicationReadinessEvaluator}=await import('../.cache/source/node_modules/@vrtmrz/livesync-commonlib/dist/services/base/ReplicationService.readiness.js');
 const manager=controller(),messages=[];let resolve,calls=0;
 manager.discover=()=>{calls++;return new Promise(r=>resolve=r);};
 const evaluate=createReplicationReadinessEvaluator({
  diagnostics:{translate:k=>k,log:m=>messages.push(m),showError:m=>messages.push(m),getUnresolvedMessages:async()=>[],clearErrors:()=>{}},
  gates:{isApplicationReady:()=>true,runPolicyChecks:async()=>true,currentSettings:()=>({versionUpFlash:''}),isCleanupRunning:()=>false,isOnline:()=>true},
  preparation:{commitPendingFileEvents:async()=>true,prepareCentralRemote:async()=>true,runBeforeReplicate:()=>manager.refreshBeforeSync()}
 });
 const attempts=[evaluate(),evaluate(),evaluate()];await new Promise(r=>setImmediate(r));
 assert.equal(calls,1);resolve();
 for(const result of await Promise.all(attempts))assert.equal(result.ready,true);
 assert.deepEqual(messages,[]);assert.deepEqual(manager.syncFeedback.messages,[]);
});
test('concurrent real refusals all block, preserve shared paths and recover through a fresh check',async()=>{
 for(const status of [undefined,401,403,429]){
  const manager=controller();manager.records=[{id:'team',mount:'Team'}];
  let reject,calls=0,saves=0,bindings=0;manager.save=async()=>saves++;manager.ensure=async()=>bindings++;
  manager.plugin.collaboration.api=()=>{calls++;return new Promise((_,r)=>reject=r);};
  const attempts=[manager.refreshBeforeSync(),manager.refreshBeforeSync(),manager.refreshBeforeSync()];
  assert.equal(calls,1);reject(Object.assign(Error('private network or server detail'),{status}));
  assert.deepEqual(await Promise.all(attempts),[false,false,false]);
  assert.equal(saves,0);assert.equal(bindings,0);assert.equal(manager.contains('Team/private.md'),true);
  assert.equal(manager.notices.length,1);assert.equal(manager.syncFeedback.messages.length,1);
  manager.plugin.collaboration.api=async()=>{calls++;return {folders:[]};};
  assert.equal(await manager.refreshBeforeSync(),true);assert.equal(calls,2);assert.equal(saves,1);assert.equal(bindings,1);
  assert.equal(manager.notices[0].hidden,true);assert.deepEqual(manager.syncFeedback.messages,[]);
 }
});
test('successful discovery caches only the current connection and expiry starts one new check',async()=>{
 const manager=controller();let calls=0;manager.plugin.collaboration.api=async()=>{calls++;return {folders:[]};};
 assert.equal(await manager.refreshBeforeSync(),true);assert.equal(await manager.refreshBeforeSync(),true);assert.equal(calls,1);
 manager.lastRefresh-=10001;
 assert.deepEqual(await Promise.all([manager.refreshBeforeSync(),manager.refreshBeforeSync()]),[true,true]);assert.equal(calls,2);
 manager.settings.couchDB_DBNAME='other';assert.equal(await manager.refreshBeforeSync(),true);assert.equal(calls,3);
});
test('unload blocks every waiting check and ignores late discovery data or errors',async()=>{
 for(const fails of [false,true]){
  const manager=controller();let resolve,reject,saves=0;manager.save=async()=>saves++;
  manager.plugin.collaboration.api=()=>new Promise((a,b)=>{resolve=a;reject=b;});
  const pending=[manager.refreshBeforeSync(),manager.refreshBeforeSync()];manager.dispose();
  if(fails)reject(Error('late private failure'));else resolve({folders:[{id:'late',mount:'Team'}]});
  assert.deepEqual(await Promise.all(pending),[false,false]);assert.equal(saves,0);assert.equal(manager.records.length,0);
  assert.equal(manager.notices.length,0);assert.deepEqual(manager.syncFeedback.messages,[]);
 }
});
test('changed connection cannot reuse an in-flight check or accept its late data',async()=>{
 for(const field of ['isConfigured','remoteType','couchDB_URI','couchDB_DBNAME','couchDB_USER','couchDB_PASSWORD','additionalSuffixOfDatabaseName','base']){
  const manager=controller(),requests=[];let saves=0;manager.save=async()=>saves++;
  manager.plugin.collaboration.api=()=>new Promise(resolve=>requests.push(resolve));
  const old=manager.refreshBeforeSync();
  if(field==='base')manager.plugin.unifiedVault.base='https://other.invalid/api';
  else manager.settings[field]=field==='isConfigured'?false:'changed';
  // A context change alone must invalidate the old result, even before another check starts.
  requests[0]({folders:[{id:'old',mount:'Old'}]});assert.equal(await old,false);
  assert.equal(saves,0);assert.equal(manager.records.length,0);
  manager.settings.isConfigured=true;
  const fresh=manager.refreshBeforeSync();assert.equal(requests.length,2);
  requests[1]({folders:[]});assert.equal(await fresh,true);assert.equal(saves,1);
 }
});
test('a late success from another connection cannot clear the current refusal or populate its registry',async()=>{
 const manager=controller();let resolve,saves=0;manager.save=async()=>saves++;
 manager.plugin.collaboration.api=()=>new Promise(r=>resolve=r);
 const old=manager.refreshBeforeSync();manager.settings.couchDB_USER='pilot_other';
 manager.plugin.collaboration.api=async()=>{throw Object.assign(Error('expired'),{status:401});};
 assert.equal(await manager.refreshBeforeSync(),false);
 resolve({folders:[{id:'old',mount:'Old'}]});assert.equal(await old,false);
 assert.equal(saves,0);assert.equal(manager.records.length,0);assert.equal(manager.syncFeedback.messages.length,1);
 assert.equal(manager.notices.length,1);assert.match(manager.notices[0].message,/Повторно войдите/);
});
test('copying bindings invalidates a pending check without letting it erase a newer in-flight owner',async()=>{
 const manager=controller(),requests=[];let saves=0;manager.save=async()=>saves++;
 manager.plugin.collaboration.api=()=>new Promise(resolve=>requests.push(resolve));
 const old=manager.refreshBeforeSync();await manager.copyBindings();
 const fresh=manager.refreshBeforeSync();assert.equal(requests.length,2);
 requests[0]({folders:[{id:'old',mount:'Old'}]});assert.equal(await old,false);
 const joined=manager.refreshBeforeSync();assert.equal(requests.length,2);
 requests[1]({folders:[]});assert.deepEqual(await Promise.all([fresh,joined]),[true,true]);
 assert.equal(saves,1);assert.equal(manager.records.length,0);
});
test('late old connection results preserve the newer successful cache in either completion order',async()=>{
 for(const order of [[0,1],[1,0]])for(const fails of [false,true]){
  const manager=controller(),requests=[];let calls=0,saves=0;
  manager.save=async()=>saves++;
  manager.plugin.collaboration.api=()=>{calls++;return new Promise((resolve,reject)=>requests.push({resolve,reject}));};
  const old=manager.refreshBeforeSync();manager.settings.couchDB_DBNAME='new';const fresh=manager.refreshBeforeSync();
  for(const index of order){
   if(index===0&&fails)requests[0].reject(Error('old network failure'));
   else requests[index].resolve({folders:index===0?[{id:'old',mount:'Old'}]:[]});
   await (index===0?old:fresh);
  }
  assert.deepEqual(await Promise.all([old,fresh]),[false,true]);
  assert.equal(await manager.refreshBeforeSync(),true);assert.equal(calls,2);assert.equal(saves,1);
  assert.equal(manager.records.length,0);assert.equal(manager.notices.length,0);assert.deepEqual(manager.syncFeedback.messages,[]);
 }
});
test('registry write failure blocks all waiters and does not cache success before the write finishes',async()=>{
 const manager=controller();let reject,calls=0;
 manager.plugin.collaboration.api=async()=>{calls++;return {folders:[]};};
 manager.save=()=>new Promise((_,r)=>reject=r);
 const first=manager.refreshBeforeSync();await new Promise(r=>setImmediate(r));
 const second=manager.refreshBeforeSync();assert.equal(calls,1);assert.equal(manager.lastRefresh,0);
 reject(Error('disk unavailable'));assert.deepEqual(await Promise.all([first,second]),[false,false]);
 assert.equal(manager.notices.length,1);assert.equal(manager.syncFeedback.messages.length,1);
 manager.save=async()=>{};assert.equal(await manager.refreshBeforeSync(),true);assert.equal(calls,2);
});
test('folder owner obeys readonly scope and renewal recovers authoritative owner membership',async()=>{const manager=controller(),e={record:{id:'doc',role:'owner'}};await manager.authenticated(e,'readonly');assert.equal(e.record.role,'viewer');await manager.authenticated(e,'read-write');assert.equal(e.record.role,'owner');});
test('late folder authorization cannot overwrite a newer readonly scope, revocation or disposal',async()=>{for(const condition of ['readonly','denied','disposed']){const manager=controller(),e={record:{id:'doc',role:'owner'}};let resolve;manager.plugin.collaboration.api=()=>new Promise(r=>resolve=r);const pending=manager.authenticated(e,'read-write');if(condition==='readonly')await manager.authenticated(e,'readonly');else{e.record.role='viewer';if(condition==='denied')e.denied=true;else manager.disposed=true;}resolve({role:'owner'});await pending;assert.equal(e.record.role,'viewer');}});
test('folder editor rebind does not turn disk hydration into a duplicate Yjs edit',async()=>{const manager=controller(),doc=new Y.Doc(),f=file(doc,'id','note.md','shared русский 😀'),text=f.get('content'),r={id:'doc',mount:'Team',role:'owner'},e={record:r,doc,files:doc.getMap('files'),paths:new Map([['id','note.md']]),ready:true,denied:false,undo:new Map(),provider:{awareness:{}}};manager.records=[r];manager.ensure=async()=>e;manager.filePath=v=>v.path;let content='stale disk',bound=false,updates=0;doc.on('update',()=>updates++);const view={path:'Team/note.md',state:{get doc(){return {length:content.length,toString:()=>content}}},dispatch(t){if(t.effects?.configuration)bound=t.effects.configuration.some(x=>x.binding);if(t.changes){const {from,to,insert}=t.changes;content=content.slice(0,from)+insert+content.slice(to);if(bound)doc.transact(()=>{text.delete(from,to-from);text.insert(from,insert);});}}};manager.views.set(view,{path:null,added:true,c:{reconfigure:configuration=>({configuration})}});for(let i=0;i<5;i++){manager.views.get(view).bound=null;await manager.attach(view,true);}assert.equal(content,'shared русский 😀');assert.equal(text.toString(),content);assert.equal(updates,0);for(const undo of e.undo.values())undo.destroy();doc.destroy();});
test('opening a saved shared folder locks the editor before asynchronous authorization finishes',async()=>{const manager=controller(),r={id:'doc',mount:'Team',role:'owner'};manager.records=[r];manager.filePath=v=>v.path;let resolve;manager.ensure=()=>new Promise(r=>resolve=r);let readonly=false;const view={path:'Team/note.md',state:{doc:{length:0,toString:()=>''}},dispatch:t=>{if(t.effects?.configuration)readonly=t.effects.configuration.some(e=>e.readOnly===true);}};manager.views.set(view,{path:null,added:true,c:{reconfigure:configuration=>({configuration})}});const pending=manager.attach(view);assert.equal(readonly,true);const doc=new Y.Doc();resolve({record:r,doc,files:doc.getMap('files'),paths:new Map(),undo:new Map(),ready:false,denied:false,provider:{awareness:{}}});await pending;assert.equal(readonly,true);doc.destroy();});
test('unloading shared folders removes stale read-only editor configuration',()=>{const manager=controller();let readonly=true;const view={dispatch:t=>{readonly=t.effects.configuration.some(e=>e.readOnly);}};manager.views.set(view,{added:true,c:{reconfigure:configuration=>({configuration})}});manager.dispose();assert.equal(readonly,false);assert.equal(manager.views.size,0);});
test('joining a first shared folder initializes saved bindings before synchronization',async()=>{const manager=controller();let initialized=false;manager.validateMount=()=>{};manager.app.vault={getFiles:()=>[]};manager.plugin.initializeCloudFeatures=async()=>{assert.equal(manager.records.length,1);initialized=true;};manager.ensure=async()=>assert.equal(initialized,true);await manager.mount({id:'new',kind:'folder',role:'editor'},'Joined');assert.equal(initialized,true);});
test('voluntary exit disconnects only selected folder and retains local files',async()=>{
 const m=controller();const calls=[];m.records=[{id:'team',mount:'Team',role:'editor'},{id:'other',mount:'Other',role:'owner'}];
 m.plugin.collaboration.api=async(action,body)=>{calls.push([action,body.id]);return {left:true};};
 m.entries.set('team',{provider:{disconnect:()=>calls.push('disconnect'),destroy:()=>calls.push('provider destroyed')},persistence:{destroy:()=>calls.push('persistence closed')},undo:new Map(),doc:{destroy:()=>calls.push('doc destroyed')}});
 m.app.vault={adapter:{remove:()=>assert.fail('must preserve files'),write:()=>assert.fail('must preserve files')}};
 await m.leave('team');assert.deepEqual(calls[0],['leave','team']);assert.ok(calls.includes('disconnect'));assert.equal(m.records.length,1);assert.equal(m.records[0].id,'other');assert.equal(m.entries.has('team'),false);
 await assert.rejects(m.leave('other'),/Владелец/);
});
test('failed voluntary exit preserves local membership and connection',async()=>{
 const m=controller();m.records=[{id:'team',role:'viewer'}];m.plugin.collaboration.api=async()=>{throw Error('offline');};m.entries.set('team',{provider:{disconnect:()=>assert.fail('must stay connected')}});
 await assert.rejects(m.leave('team'),/offline/);assert.equal(m.records.length,1);assert.equal(m.entries.has('team'),true);
});
test('stop sharing retires shared binding while leaving folder eligible for ordinary vault sync',async()=>{
 const m=controller();m.records=[{id:'team',mount:'Team',role:'owner'},{id:'keep',mount:'Keep',role:'owner'}];const calls=[];
 m.plugin.collaboration.api=async(action,body)=>{calls.push([action,body.id]);return {stopped:true};};
 m.app.vault={adapter:{remove:()=>assert.fail('must preserve files'),write:()=>assert.fail('must preserve files')}};
 await m.stopSharing('team');assert.deepEqual(calls,[['stop-sharing','team']]);assert.equal(m.contains('Team/note.md'),false);assert.equal(m.contains('Keep/note.md'),true);
});
test('closed shared folders discovered on another device become ordinary without file changes',async()=>{
 const m=controller();m.records=[{id:'closed',mount:'Team',role:'owner'}];m.plugin.collaboration.api=async()=>({folders:[],removed:['closed']});
 await m.discover();assert.equal(m.contains('Team/note.md'),false);assert.equal(m.records.length,0);
});
test('failed stop sharing keeps the shared binding',async()=>{
 const m=controller();m.records=[{id:'team',mount:'Team',role:'owner'}];m.plugin.collaboration.api=async()=>{throw Error('offline');};
 await assert.rejects(m.stopSharing('team'),/offline/);assert.equal(m.contains('Team/note.md'),true);
});

function projectionFixture() {
 const manager=controller(),record={id:'a'.repeat(32),mount:'Team',role:'owner'},doc=new Y.Doc();
 const e={record,doc,files:doc.getMap('files'),ready:true,denied:false,disk:new Map(),paths:new Map(),projecting:Promise.resolve()};
 const local=new Map(),writes=[],trash=[];
 manager.records=[record];manager.ensure=async()=>e;manager.plugin.pilotDirectory='_private';
 manager.app.vault={
  getAbstractFileByPath:path=>local.get(path)?.file,
  readBinary:async f=>local.get(f.path).data.slice().buffer,
  getFiles:()=>[...local.values()].map(v=>v.file),
  adapter:{exists:async()=>true,writeBinary:async(path,data)=>writes.push([path,new Uint8Array(data).slice()])},
  modifyBinary:async(f,data)=>{local.get(f.path).data=new Uint8Array(data).slice();},
  createBinary:async(path,data)=>local.set(path,{file:new TestFile(path),data:new Uint8Array(data).slice()}),
  trash:async f=>{trash.push(f.path);local.delete(f.path);}
 };
 manager.app.fileManager={renameFile:async(f,path)=>{const entry=local.get(f.path);local.delete(f.path);f.path=path;local.set(path,entry);}};
 return {manager,e,local,writes,trash,put:(path,data)=>{const f=new TestFile(path);local.set(path,{file:f,data});return f;}};
}
test('failed attachment download preserves existing files and postpones all removals',async()=>{
 const x=projectionFixture(),id='b'.repeat(32),removed='c'.repeat(32);
 x.put('Team/old.jpg',new Uint8Array([9]));x.e.paths.set(removed,'old.jpg');
 const f=file(x.e.doc,id,'new.jpg','a'.repeat(64),'blob');f.set('size',5*1024*1024);
 x.manager.plugin.collaboration.api=async()=>{throw Error('offline');};
 await assert.rejects(x.manager.project(x.e),/offline/);
 assert.ok(x.local.has('Team/old.jpg'));assert.deepEqual(x.trash,[]);assert.equal(x.e.paths.has(removed),true);
});
test('failed upload never changes accepted metadata or deletes the local attachment',async()=>{
 const x=projectionFixture(),id='b'.repeat(32),f=file(x.e.doc,id,'photo.jpg','AA==','binary');
 const local=x.put('Team/photo.jpg',new Uint8Array(2*1024*1024));x.e.paths.set(id,'photo.jpg');
 x.manager.plugin.collaboration.api=async()=>{throw Error('quota');};
 await assert.rejects(x.manager.changed('modify',local),/quota/);
 assert.equal(f.get('type'),'binary');assert.equal(f.get('content'),'AA==');assert.ok(x.local.has(local.path));assert.deepEqual(x.trash,[]);
});
test('referenced projection verifies content and preserves conflicting local changes',async()=>{
 const x=projectionFixture(),id='b'.repeat(32),data=new Uint8Array([1,2,3]),hash=await blobDigest(data);
 const f=file(x.e.doc,id,'photo.jpg',hash,'blob');f.set('size',3);
 x.put('Team/photo.jpg',new Uint8Array([9]));x.e.paths.set(id,'photo.jpg');x.e.disk.set(id,await blobDigest(new Uint8Array([8])));
 x.manager.plugin.collaboration.api=async()=>({data:'AQID',offset:3,size:3});
 await x.manager.project(x.e);
 assert.deepEqual(x.local.get('Team/photo.jpg').data,data);assert.equal(x.writes.length,1);assert.deepEqual(x.writes[0][1],new Uint8Array([9]));
});
test('folder creation seeds over 100 files sequentially and stores large attachments as references',async()=>{
 const x=projectionFixture();x.manager.validateMount=()=>{};x.manager.project=async()=>{};
 for(let i=0;i<105;i++)x.put('Team/photo-'+i+'.jpg',new Uint8Array(i===0?5*1024*1024+1:2));
 let offset=0,size=0,hash,uploads=0;
 x.manager.plugin.collaboration.api=async(action,body)=>{
  if(action==='create')return {id:x.e.record.id,role:'owner',kind:'folder'};
  if(action==='mount')return {};
  if(action==='blob-begin'){uploads++;size=body.size;hash=body.hash;offset=0;return {upload:'a'.repeat(32),offset:0};}
  if(action==='blob-chunk'){assert.equal(body.offset,offset);offset+=Buffer.from(body.data,'base64').length;return {offset};}
  if(action==='blob-finish')return {complete:true,hash,size};
  throw Error(action);
 };
 await x.manager.create('Team');assert.equal(uploads,105);assert.equal(x.e.files.size,105);
 for(const f of x.e.files.values()) {assert.equal(f.get('type'),'blob');assert.match(f.get('content'),/^[a-f0-9]{64}$/);}
 assert.equal(x.local.size,105);assert.deepEqual(x.trash,[]);
});

test('missing server copies are rebuilt from local attachments before reconnect',async()=>{
 const x=projectionFixture(),id='b'.repeat(32),bytes=new Uint8Array([1,2,3]),hash=await blobDigest(bytes);
 const f=file(x.e.doc,id,'photo.jpg',hash,'blob');f.set('size',3);x.put('Team/photo.jpg',bytes);
 let completed=false;
 x.manager.plugin.collaboration.api=async(action,body)=>{
  if(action==='blob-check')throw Object.assign(Error('missing'),{status:409});
  if(action==='blob-begin')return {upload:'a'.repeat(32),offset:0};
  if(action==='blob-chunk')return {offset:3};
  if(action==='blob-finish'){completed=true;return {complete:true,hash,size:3};}
  throw Error(action);
 };
 await x.manager.restoreReferences(x.e);assert.equal(completed,true);assert.equal(f.get('content'),hash);assert.deepEqual(x.local.get('Team/photo.jpg').data,bytes);
});
test('unchanged attachments reuse verified disk signatures instead of re-reading every photo',async()=>{
 const x=projectionFixture(),id='b'.repeat(32),bytes=new Uint8Array([1,2,3]),hash=await blobDigest(bytes);
 const f=file(x.e.doc,id,'photo.jpg',hash,'blob');f.set('size',3);const local=x.put('Team/photo.jpg',bytes);local.stat={mtime:1,size:3};x.e.paths.set(id,'photo.jpg');
 let reads=0;x.manager.app.vault.readBinary=async()=>{reads++;return bytes.slice().buffer;};
 await x.manager.project(x.e);assert.equal(reads,1);await x.manager.project(x.e);assert.equal(reads,1);
});

test('a newer folder snapshot during download postpones projection without an unhandled error',async()=>{
 const x=projectionFixture(),id='b'.repeat(32),data=new Uint8Array([1,2,3]),hash=await blobDigest(data);
 const f=file(x.e.doc,id,'before.jpg',hash,'blob');f.set('size',3);
 x.manager.plugin.collaboration.api=async()=>{f.set('path','after.jpg');return {data:'AQID',offset:3,size:3};};
 await x.manager.project(x.e);assert.equal(x.local.size,0);assert.deepEqual(x.trash,[]);
 await x.manager.project(x.e);assert.deepEqual(x.local.get('Team/after.jpg').data,data);
});

test('additive rescan imports missing local files but preserves registered remote content and remote-only files',async()=>{
 const m=controller(),doc=new Y.Doc(),r={id:'team',mount:'Team',role:'owner'};
 file(doc,'old','existing.md','remote text');file(doc,'remote','remote-only.md','keep');
 const e={record:r,doc,files:doc.getMap('files'),provider:{synced:true},projecting:Promise.resolve(),ready:true};
 m.ensure=async()=>e;let projects=0;m.scheduleProject=()=>projects++;
 const files=['existing.md','missing.md','image.png'].map(p=>new TestFile('Team/'+p));
 m.app.vault={getFiles:()=>files,getAbstractFileByPath:p=>files.find(f=>f.path===p),readBinary:async f=>new TextEncoder().encode(f.path).buffer};
 m.upload=async()=>({hash:'a'.repeat(64),size:14});
 const progress=[];const result=await m.rescanMissing(r,(...x)=>progress.push(x));
 assert.equal(result.checked,3);assert.equal(result.added,2);assert.equal(e.files.size,4);
 assert.equal(e.files.get('old').get('content').toString(),'remote text');assert.equal(e.files.get('remote').get('content').toString(),'keep');
 assert.equal(progress.length,3);assert.equal(projects,1);assert.equal(e.rescanning,false);
 assert.equal((await m.rescanMissing(r)).added,0);
});
test('rescan refuses viewer, offline and concurrent work and retains partial progress on upload error',async()=>{
 const m=controller(),r={id:'team',mount:'Team',role:'viewer'},doc=new Y.Doc();
 const e={record:r,doc,files:doc.getMap('files'),provider:{synced:true},projecting:Promise.resolve(),ready:true};m.ensure=async()=>e;
 await assert.rejects(m.rescanMissing(r),/недоступна для записи/);r.role='owner';e.provider.synced=false;
 await assert.rejects(m.rescanMissing(r),/подключения/);e.provider.synced=true;e.rescanning=true;
 await assert.rejects(m.rescanMissing(r),/уже выполняется/);e.rescanning=false;
 const files=['first.md','bad.png'].map(p=>new TestFile('Team/'+p));
 m.app.vault={getFiles:()=>files,getAbstractFileByPath:p=>files.find(f=>f.path===p),readBinary:async()=>new TextEncoder().encode('local').buffer};
 m.upload=async()=>{throw Error('network timeout');};let projects=0;m.scheduleProject=()=>projects++;
 await assert.rejects(m.rescanMissing(r),/network timeout/);assert.equal(e.files.size,1);assert.equal(e.rescanning,false);assert.equal(projects,1);
});
test('rescan rechecks paths and write access after an awaited upload',async()=>{
 for(const revoke of [false,true]){
  const m=controller(),doc=new Y.Doc(),r={id:'team',mount:'Team',role:'owner'},f=new TestFile('Team/image.png');
  const e={record:r,doc,files:doc.getMap('files'),provider:{synced:true},projecting:Promise.resolve(),ready:true};m.ensure=async()=>e;m.scheduleProject=()=>{};
  m.app.vault={getFiles:()=>[f],getAbstractFileByPath:()=>f,readBinary:async()=>new Uint8Array([1]).buffer};
  m.upload=async()=>{if(revoke)e.denied=true;else file(doc,'peer','image.png','peer data');return{hash:'a'.repeat(64),size:1};};
  if(revoke){await assert.rejects(m.rescanMissing(r),/недоступна для записи/);assert.equal(e.files.size,0);}
  else{assert.equal((await m.rescanMissing(r)).added,0);assert.equal(e.files.size,1);assert.equal(e.files.get('peer').get('content').toString(),'peer data');}
  assert.equal(e.rescanning,false);
 }
});
test('fresh projection reuses matching local attachment bytes without redownloading them',async()=>{
 const x=projectionFixture(),id='b'.repeat(32),data=new Uint8Array([1,2,3]),hash=await blobDigest(data);
 const f=file(x.e.doc,id,'existing.png',hash,'blob');f.set('size',data.length);
 x.put('Team/existing.png',data);x.manager.plugin.collaboration.api=async()=>assert.fail('matching local bytes must not be downloaded again');
 await x.manager.project(x.e);
 assert.equal(x.e.paths.get(id),'existing.png');assert.equal(x.e.disk.get(id),hash);assert.equal(x.writes.length,0);assert.equal(x.trash.length,0);
});
