import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {fileURLToPath} from 'node:url';
import {prepareFolderDatabase,activatePreparedFolderDatabase,retirePreparedFolderDatabase,installFolderDatabaseResolver} from '../plugin/folder-local-database.mjs';
import {inspectCleanupDatabase,planFolderCleanup,copyCleanupSnapshot,verifyCleanupSnapshot} from '../plugin/folder-cleanup.mjs';
const require=createRequire(new URL('../.cache/source/package.json',import.meta.url));
const PouchDB=require('pouchdb-core').plugin(require('pouchdb-adapter-memory')).plugin(require('pouchdb-replication'));
const checked=(promise,code)=>assert.rejects(promise,error=>error.code===code);
const state=()=>({workspace:'a'.repeat(32),revision:1,database:'arcalink_p_'+'b'.repeat(32),phase:'ready',
 policy:{protocol:1,workspace:'a'.repeat(32),folders:['Фото'],caseSensitive:false}});
async function fixture(t){
 const logical='folder-local-'+randomUUID()+'-livesync-v2',names=new Set();
 const open=(name,options={})=>{names.add(name);return new PouchDB(name,{...options,adapter:'memory',auto_compaction:false});};
 t.after(async()=>{for(const name of names)await open(name).destroy();});
 const source=open(logical);
 await source.bulkDocs([
  {_id:'private',type:'newnote',path:'Фото/private.md',children:['h:private','h:shared'],size:6,mtime:1},
  {_id:'pending',type:'newnote',path:'Work/unsent.md',children:['h:shared','h:not-downloaded-yet'],size:7,mtime:9},
  {_id:'h:private',type:'leaf',data:'excluded bytes'},
  {_id:'h:shared',type:'leaf',data:'shared and unsent bytes'},
 ]);
 await source.bulkDocs([{_id:'conflict',_rev:'1-a',_revisions:{start:1,ids:['a']},type:'plain',path:'Work/conflict.md',children:[],size:3,data:'one'},
  {_id:'conflict',_rev:'1-b',_revisions:{start:1,ids:['b']},type:'plain',path:'Work/conflict.md',children:[],size:3,data:'two'}],{new_edits:false});
 await source.close();
 let journal,binding,retirement;const settings={additionalSuffixOfDatabaseName:'unchanged',syncIgnoreRegEx:'manual'};
 const current=state();let authority=true,quiescent=true;
 const options={state:current,logical,source:logical,open,
  persistJournal:async value=>{journal=structuredClone(value);},quiesce:async()=>quiescent,isCurrent:async()=>authority,
  isMapped:async name=>name===(binding?.target||logical)};
 return {logical,open,options,settings,get journal(){return journal;},get binding(){return binding;},get retirement(){return retirement;},
  setAuthority:value=>{authority=value;},setQuiescent:value=>{quiescent=value;},
  saveRetirement:async value=>{retirement=structuredClone(value);},
  prepare:extra=>prepareFolderDatabase({...options,...extra}),
  activate:extra=>activatePreparedFolderDatabase({state:current,journal,open,isCurrent:options.isCurrent,persistBinding:async value=>{binding=structuredClone(value);},...extra}),
  retire:extra=>retirePreparedFolderDatabase({journal,binding,retirement,acknowledgement:{workspace:current.workspace,revision:current.revision,database:current.database},open,
   isCurrent:options.isCurrent,isMapped:options.isMapped,isQuiescent:async()=>quiescent,persistRetirement:async value=>{retirement=structuredClone(value);},...extra})};
}
async function read(f,name,id,options){const database=f.open(name);try{return await database.get(id,options);}finally{await database.close();}}

test('local preparation preserves unsent revisions, conflicts, shared bytes and lazy missing chunks',async t=>{
 const f=await fixture(t);const before=structuredClone(f.settings);const journal=await f.prepare();
 assert.equal(journal.phase,'prepared');assert.equal(f.binding,undefined);
 assert.equal((await read(f,journal.target,'pending')).mtime,9);
 assert.equal((await read(f,journal.target,'h:shared')).data,'shared and unsent bytes');
 assert.equal((await read(f,journal.target,'conflict',{open_revs:'all'})).length,2);
 await assert.rejects(read(f,journal.target,'private'),error=>error.status===404);
 assert.ok(await read(f,f.logical,'private'));assert.deepEqual(f.settings,before);
 await f.activate();assert.equal(f.binding.target,journal.target);
 await f.retire();assert.equal(f.retirement.phase,'retired');
 assert.equal((await read(f,journal.target,'pending')).mtime,9);
 // Completion is idempotent; do not reopen or destroy the retired source.
 await f.retire({open:()=>assert.fail('Retired source must not be opened again')});
});

test('physical resolver uses the actual engine factory without changing the logical/KVS namespace',async()=>{
 const location=fileURLToPath(new URL('../.cache/source/node_modules/@vrtmrz/livesync-commonlib/dist/services/base/DatabaseService.js',import.meta.url));
 const {DatabaseService}=await import(pathToFileURL(location));const constructed=[];
 class Pouch {constructor(name,options){constructed.push({name,options});}}
 const settings={useIndexedDBAdapter:true,additionalSuffixOfDatabaseName:'user-suffix'};
 const service=new DatabaseService({}, {setting:{currentSettings:()=>settings},pouchDB:Pouch});
 const logical='MyVault_user-suffix-livesync-v2';
 let binding={protocol:1,logical,target:logical+'-arcalink-folder-'+'c'.repeat(32),workspace:'a'.repeat(32),revision:1};
 const factory=installFolderDatabaseResolver(service,()=>binding);
 service.createPouchDBInstance(logical,{auto_compaction:false});
 assert.equal(constructed[0].name,service.modifyDatabaseOptions(settings,binding.target,{}).name);
 assert.equal(constructed[0].options.adapter,'indexeddb');
 service.createPouchDBInstance('shared-document-cache',{});assert.equal(constructed[1].name,service.modifyDatabaseOptions(settings,'shared-document-cache',{}).name);
 factory.openRaw(logical,{});assert.equal(constructed[2].name,service.modifyDatabaseOptions(settings,logical,{}).name);
 binding=null;service.createPouchDBInstance(logical,{});assert.equal(constructed[3].name,constructed[2].name);
 assert.equal(settings.additionalSuffixOfDatabaseName,'user-suffix');factory.dispose();
});

test('partial copy after a crash is rebuilt only in its journal-owned inactive target',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.prepare({persistJournal:async value=>{
  await f.options.persistJournal(value);
  if(value.phase==='copying')throw Error('crash before copy');
 }}),/crash before copy/);
 const partial=f.open(f.journal.target);await partial.put({_id:'partial',data:'incomplete staging data'});await partial.close();
 const journal=await f.prepare({journal:f.journal});
 assert.equal(journal.phase,'prepared');await assert.rejects(read(f,journal.target,'partial'),error=>error.status===404);
 assert.ok(await read(f,f.logical,'private'));
});

test('restart verifies a prepared target instead of trusting a marker or a nonempty database',async t=>{
 const f=await fixture(t);await f.prepare();
 const recovered=await f.prepare({journal:f.journal});assert.equal(recovered.target,f.journal.target);
 const changed=f.open(f.journal.target);await changed.put({_id:'rogue',data:'not part of the prepared copy'});await changed.close();
 await checked(f.prepare({journal:f.journal}),'prepared-target-changed');
 await checked(f.activate(),'prepared-target-changed');assert.equal(f.binding,undefined);
 assert.ok(await read(f,f.logical,'pending'));
});

test('source edits, changed authority and pending file queues prevent local publication',async t=>{
 const f=await fixture(t);f.setQuiescent(false);
 await checked(f.prepare(),'local-database-not-quiescent');assert.equal(f.journal,undefined);
 f.setQuiescent(true);await f.prepare();
 const source=f.open(f.logical);await source.put({_id:'new-unsent',type:'plain',path:'Work/new.md',children:[],size:3,data:'new'});await source.close();
 await checked(f.prepare({journal:f.journal}),'local-source-changed');
 f.setAuthority(false);await checked(f.activate(),'prepared-target-changed');assert.equal(f.binding,undefined);
 assert.equal((await read(f,f.logical,'new-unsent')).data,'new');
});

test('a failed binding save never authorizes source retirement',async t=>{
 const f=await fixture(t);await f.prepare();
 await assert.rejects(f.activate({persistBinding:async()=>{throw Error('disk full');}}),/disk full/);
 await checked(f.retire(),'local-retirement-not-authorized');assert.ok(await read(f,f.logical,'pending'));
});

test('a policy change during durable binding save prevents acknowledgement and source removal',async t=>{
 const f=await fixture(t);await f.prepare();
 await checked(f.activate({persistBinding:async()=>f.setAuthority(false)}),'policy-changed');
 assert.ok(await read(f,f.logical,'pending'));
});

test('source remains intact until a matching ack, durable retirement journal and quiescent binding',async t=>{
 const f=await fixture(t);await f.prepare();await f.activate();
 await checked(f.retire({acknowledgement:{workspace:'b'.repeat(32),revision:1,database:state().database}}),'local-retirement-not-authorized');
 f.setQuiescent(false);await checked(f.retire(),'local-binding-changed');f.setQuiescent(true);
 await assert.rejects(f.retire({persistRetirement:async()=>{throw Error('disk full');}}),/disk full/);
 assert.ok(await read(f,f.logical,'pending'));
 const target=f.open(f.journal.target);await target.put({_id:'new-active',data:'changed active database'});await target.close();
 await checked(f.retire(),'prepared-target-changed');assert.ok(await read(f,f.logical,'pending'));
});

test('a crash after source destruction resumes from durable retirement proof without losing the active copy',async t=>{
 const f=await fixture(t);await f.prepare();await f.activate();
 await assert.rejects(f.retire({persistRetirement:async value=>{
  if(value.phase==='retired')throw Error('crash after destruction');
  await f.saveRetirement(value);
 }}),/crash after destruction/);
 assert.equal(f.retirement.phase,'retiring');
 await f.retire();assert.equal(f.retirement.phase,'retired');
 assert.ok(await read(f,f.binding.target,'pending'));
});

test('journal aliasing cannot destroy the source under a different target name',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.prepare({persistJournal:async value=>{await f.options.persistJournal(value);throw Error('stop');}}),/stop/);
 await checked(f.prepare({journal:f.journal,open:name=>f.open(name===f.journal.target?f.logical:name)}),'target-is-source');
 assert.ok(await read(f,f.logical,'pending'));
 await checked(f.prepare({journal:{...f.journal,target:'some-other-database'}}),'local-preparation-journal-changed');
});

test('removing all common exclusions copies current unsent data without mutating the independent local filter',async t=>{
 const f=await fixture(t);const current={...state(),revision:2,policy:{...state().policy,folders:[]}};
 const result=await f.prepare({state:current});assert.ok(await read(f,result.target,'private'));
 assert.equal(f.settings.syncIgnoreRegEx,'manual');
});

test('byte verification rejects corruption with an unchanged revision and source sequence',async t=>{
 const f=await fixture(t),source=f.open(f.logical),target=f.open(f.logical+'-verify');
 const plan=planFolderCleanup(await inspectCleanupDatabase(source),['Фото'],{allowMissingKeptChunks:true});
 await copyCleanupSnapshot(source,target,plan);
 const get=target.get.bind(target);
 target.get=async(...args)=>{const value=await get(...args);return value._id==='h:shared'?{...value,data:'corrupted bytes'}:value;};
 await checked(verifyCleanupSnapshot(source,target,plan),'copy-verification-failed');
 assert.equal((await source.get('h:shared')).data,'shared and unsent bytes');
 await source.close();await target.close();
});

test('staging preserves the engine ancestry of retained long conflict branches',async t=>{
 const f=await fixture(t),source=f.open(f.logical,{revs_limit:100});
 const id='long-conflict';
 for(const [depth,branch] of [[145,'long'],[100,'short']]){
  const ids=Array.from({length:depth},(_,i)=>depth-i).map(n=>createHash('md5').update((n>55?branch:'common')+':'+n).digest('hex'));
  await source.bulkDocs([{_id:id,_rev:depth+'-'+ids[0],_revisions:{start:depth,ids},type:'plain',path:'Work/retained.md',children:[],size:branch.length,data:branch}],{new_edits:false});
 }
 const expected=await source.get(id,{open_revs:'all',revs:true});
 assert.deepEqual(expected.map(row=>row.ok._revisions.ids.length),[100,100]);
 await source.close();
 const journal=await f.prepare();
 assert.deepEqual(await read(f,journal.target,id,{open_revs:'all',revs:true}),expected);
});
