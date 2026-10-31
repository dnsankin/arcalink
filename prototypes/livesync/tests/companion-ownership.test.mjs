import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {excludedFolders,withExcludedFolders} from '../plugin/folder-exclusions.mjs';
import {OWNERSHIP_FORMAT_FIELDS,canonicalOwnership,ownershipDigest,ownershipBodyHash,ownershipDocumentBody,proveOwnershipPage,assertOwnershipManifest,ownershipReadyMatches} from '../plugin/companion-ownership-model.mjs';

// Exercise the pinned engine's actual matcher and application boundary.
const engine=new URL('../.cache/source/node_modules/@vrtmrz/livesync-commonlib/dist/',import.meta.url);
const {isTargetFile}=await import(new URL('managers/EntryManager/EntryManagerImpls.js',engine));
const {ServiceFileHandlerBase}=await import(new URL('serviceModules/ServiceFileHandlerBase.js',engine));
const {ServiceDatabaseFileAccessBase}=await import(new URL('serviceModules/ServiceDatabaseFileAccessBase.js',engine));
const {TweakValuesTemplate}=await import(new URL('common/models/tweak.definition.js',engine));
const require=createRequire(new URL('../.cache/source/package.json',import.meta.url));
const PouchDB=require('pouchdb-core').plugin(require('pouchdb-adapter-memory')).plugin(require('pouchdb-replication'));

function fixture() {
 const original='^Keep-private/|[]|^(?:Existing)(?:/|$)';
 const settings={syncIgnoreRegEx:withExcludedFolders(original,[...excludedFolders(original),'Owned','Заметки [личные]']),
  syncOnlyRegEx:'',syncInternalFiles:false,handleFilenameCaseSensitive:false};
 const host={services:{setting:{currentSettings:()=>settings}}},applied=[];
 const vault={isTargetFile:path=>isTargetFile(host,path),isFileSizeTooLarge:()=>false};
 const handler={serializedByFileEventPaths:async(paths,action)=>action(),getPath:entry=>entry.path,
  getPathWithoutPrefix:entry=>entry.path,vault,storage:{getStub:async()=>null},events:{emitEvent(){}},_log(){},
  dbToStorageCore:async entry=>{applied.push(entry.path);return true;}};
 return {settings,applied,vault,handler,apply:entry=>ServiceFileHandlerBase.prototype._anyProcessReplicatedDoc.call(handler,
  {_id:entry.path,_rev:'2-fixture',size:1,...entry})};
}

test('ordinary scoped ownership rejects real engine apply of files and tombstones while unrelated paths remain usable',async()=>{
 const f=fixture();
 for(const path of ['Owned/note.md','Owned/nested/attachment.bin','Заметки [личные]/задачи.md']) {
  assert.equal(await f.apply({path}),false,path);
  assert.equal(await f.apply({path,deleted:true}),false,path);
  assert.equal(await f.apply({path,_deleted:true}),false,path);
 }
 for(const path of ['Ordinary/note.md','Owned-other/note.md','Shared mount/note.md','ArcaLink Shared/note.md'])
  assert.equal(await f.apply({path}),true,path);
 assert.deepEqual(f.applied,['Ordinary/note.md','Owned-other/note.md','Shared mount/note.md','ArcaLink Shared/note.md']);
 // The plugin's independent shared-folder router still owns those paths;
 // this test proves the scoped ordinary filter does not exclude them itself.
});

test('scoped rules preserve existing local exclusions and the engine blocks local DB deletions for owned files',async()=>{
 const f=fixture();
 for(const path of ['Keep-private/secret.md','Existing/file.md','Owned/task.md'])assert.equal(await f.vault.isTargetFile(path),false,path);
 let deletions=0;
 const database={vault:f.vault,_log(){},checkIsTargetFile(file){return ServiceDatabaseFileAccessBase.prototype.checkIsTargetFile.call(this,file);},
  deleteFromDBbyPath:async()=>{deletions++;return true;}};
 assert.equal(await ServiceDatabaseFileAccessBase.prototype.delete.call(database,'Owned/task.md'),true);
 assert.equal(deletions,0);
 assert.equal(await ServiceDatabaseFileAccessBase.prototype.delete.call(database,'Ordinary/note.md'),true);
 assert.equal(deletions,1);
});

test('a local target exclusion alone does not prevent a previously unsent sibling revision from travelling with raw database replication',async t=>{
 const name='companion-scope-'+randomUUID(),old=new PouchDB(name+'-old',{adapter:'memory'}),remote=new PouchDB(name+'-remote',{adapter:'memory'});
 t.after(async()=>{await old.destroy();await remote.destroy();});
 const id='Owned/note.md';
 await old.put({_id:id,type:'plain',path:id,data:'base',children:[],size:4});
 await old.replicate.to(remote);
 await old.put({...await old.get(id),data:'unsent old-plugin edit'});
 await remote.put({...await remote.get(id),data:'new companion edit'});
 const f=fixture();assert.equal(await f.vault.isTargetFile(id),false);
 // The pinned CouchDB transport uses raw sync/replicate without path selectors.
 // This is a regression witness for why handoff also needs a DB-generation boundary.
 await old.replicate.to(remote);
 const leaves=await remote.get(id,{open_revs:'all'});
 assert.deepEqual(leaves.map(row=>row.ok.data).sort(),['new companion edit','unsent old-plugin edit']);
 assert.equal((await remote.get(id,{conflicts:true}))._conflicts.length,1);
});

const identity=()=>({schema:1,nonce:randomUUID(),generation:randomUUID(),accountId:randomUUID(),workspaceId:'a'.repeat(32),companionDeviceId:randomUUID()});
const manifest=()=>({...identity(),phase:'held',mode:'cloud',source:{sequence:0},scope:{ordinary:true,excludedPrefixes:['ArcaLink Shared','Team']},records:[],bases:[]});
test('ownership format covers every pinned engine compatibility knob without permitting connection or encryption secrets',()=>{
 for(const key of Object.keys(TweakValuesTemplate))assert.ok(OWNERSHIP_FORMAT_FIELDS.includes(key),key);
 for(const key of ['passphrase','idDerivationKey','couchDB_PASSWORD','couchDB_USER','accessToken','refreshToken'])assert.equal(OWNERSHIP_FORMAT_FIELDS.includes(key),false,key);
});
async function databases(t){
 const name='companion-proof-'+randomUUID(),source=new PouchDB(name+'-source',{adapter:'memory'}),remote=new PouchDB(name+'-remote',{adapter:'memory'});
 t.after(async()=>{await source.destroy();await remote.destroy();});return {source,remote};
}
test('ownership canonical hashing is shared, excludes only transient top-level fields and never exports body content',async()=>{
 assert.equal(canonicalOwnership({z:'З😀',a:{b:2,a:1}}),' {"a":{"a":1,"b":2},"z":"\\u0417\\ud83d\\ude00"}'.trim());
 const doc={_id:'note',_rev:'1-a',data:'private contents',e_:true,_revisions:{start:1,ids:['a']},_revs_info:[],nested:{e_:true},e_extra:'keep'};
 const body=ownershipDocumentBody(doc);assert.equal(body.e_,undefined);assert.deepEqual(body.nested,{e_:true});assert.equal(body.e_extra,'keep');
 assert.equal(await ownershipBodyHash(doc),await ownershipDigest(body));
 assert.throws(()=>canonicalOwnership({missing:undefined}));assert.throws(()=>canonicalOwnership({number:NaN}));
 const m=manifest();assert.equal(assertOwnershipManifest(m),m);assert.throws(()=>assertOwnershipManifest({...m,accessToken:'forbidden'}));
 assert.throws(()=>assertOwnershipManifest({...m,scope:{...m.scope,passphrase:'forbidden'}}));
 const ready={...identity(),phase:'ready',manifestDigest:await ownershipDigest(m)};
 assert.equal(await ownershipReadyMatches(m,ready),false);
 assert.equal(await ownershipReadyMatches(m,{...m,records:undefined,bases:undefined,phase:'ready',manifestDigest:await ownershipDigest(m)}),true);
});
test('bounded proof checks every active/deleted conflict leaf, ancestry, eden and external chunk against a real replicated DB',async t=>{
 const {source,remote}=await databases(t);
 await source.put({_id:'h:external',type:'leaf',data:'private attachment bytes'});
 await source.bulkDocs([
  {_id:'file',_rev:'1-a',_revisions:{start:1,ids:['a']},type:'plain',path:'Owned/note.md',children:['h:external','h:embedded'],eden:{'h:embedded':{data:'embedded secret',epoch:1}},size:4},
  {_id:'file',_rev:'1-b',_revisions:{start:1,ids:['b']},type:'plain',path:'Owned/note.md',children:[],deleted:true,size:0},
  {_id:'gone',_rev:'1-c',_revisions:{start:1,ids:['c']},_deleted:true},
 ],{new_edits:false});
 await source.replicate.to(remote);const sequence=(await source.info()).update_seq;
 let since=0,records=[],done=false,passes=0;
 while(!done){const page=await proveOwnershipPage({source,remote,sequence,since,limit:1});since=page.since;done=page.done;records.push(...page.records);passes++;}
 assert.ok(passes>1);assert.equal(records.length,2);assert.equal(records.find(r=>r.id==='file').leaves.length,2);
 assert.equal(records.find(r=>r.id==='gone').path,null);assert.equal(records.find(r=>r.id==='gone').leaves[0].pouchDeleted,true);
 const exported=JSON.stringify(records);assert.equal(exported.includes('private attachment bytes'),false);assert.equal(exported.includes('embedded secret'),false);
 const m={...manifest(),source:{sequence},records};assertOwnershipManifest(m);
 assert.deepEqual(records.find(r=>r.id==='file').leaves.find(leaf=>leaf.rev==='1-a').chunks.map(chunk=>chunk.id),['h:external']);
});
test('missing remote bytes or a source change fails proof instead of accepting a completed replication counter',async t=>{
 const {source,remote}=await databases(t);
 await source.put({_id:'note',type:'plain',path:'Owned/note.md',children:['h:missing'],size:3});
 const sequence=(await source.info()).update_seq;
 await assert.rejects(proveOwnershipPage({source,remote,sequence}));
 await source.replicate.to(remote);
 await assert.rejects(proveOwnershipPage({source,remote,sequence}));
 await source.put({_id:'h:missing',type:'leaf',data:'abc'});
 await assert.rejects(proveOwnershipPage({source,remote,sequence}),error=>error.code==='ownership-source-changed');
 await source.replicate.to(remote);const current=(await source.info()).update_seq;
 const get=remote.get.bind(remote);let changed=false;
 const movingRemote={get:async(...args)=>{const result=await get(...args);if(!changed){changed=true;await source.put({_id:'new',type:'plain',path:'Owned/new.md',children:[],size:0});}return result;}};
 await assert.rejects(proveOwnershipPage({source,remote:movingRemote,sequence:current}),error=>error.code==='ownership-source-changed');
});
