import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes,createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {createFolderPolicyStore} from '../plugin/folder-policy-store.mjs';
import * as policies from '../plugin/folder-policy.mjs';
import * as generations from '../plugin/folder-local-database.mjs';
import {waitForReplicationDrain} from '../plugin/replication-drain.mjs';
import {folderContains,withExcludedFolders} from '../plugin/folder-exclusions.mjs';
import {pluginEnvironment} from '../plugin/environment.mjs';
const require=createRequire(new URL('../.cache/source/package.json',import.meta.url));
const PouchDB=require('pouchdb-core').plugin(require('pouchdb-adapter-memory')).plugin(require('pouchdb-replication'));
const workspace='a'.repeat(32),database='arcalink_p_'+'b'.repeat(32);
async function fixture(t,options={}){
 const files=new Map([['.arcalink-folder-lab.json','{}'],['Фото/private.md','keep physical bytes']]),names=new Set();
 const adapter={exists:async p=>files.has(p),read:async p=>{if(!files.has(p))throw Error('missing');return files.get(p);},write:async(p,v)=>files.set(p,v)};
 const open=name=>{names.add(name);return new PouchDB(name,{adapter:'memory',auto_compaction:false});};
 t.after(async()=>{for(const name of names)await open(name).destroy();});
 const settings={isConfigured:true,encrypt:false,additionalSuffixOfDatabaseName:'',remoteType:'ONLY_P2P',P2P_relays:pluginEnvironment({id:'arcalink-folders-lab'}).freeSignal};
 let ready=false;
 const plugin={manifest:{id:'arcalink-folders-lab'},pilotDirectory:'private',app:{vault:{adapter}},core:{services:{vault:{vaultName:()=>randomName},database:{isDatabaseReady:()=>ready},setting:{currentSettings:()=>settings,applyPartial:async v=>Object.assign(settings,v)}}}};
 const randomName='controller-'+randomUUID();
 let code=readFileSync(new URL('../plugin/folder-policies.ts',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace('export class','class');
 code=stripTypeScriptTypes(code,{mode:'transform'})+'\nglobalThis.Controller=FolderPolicies;';
 const context={...policies,...generations,createFolderPolicyStore,pluginEnvironment,folderContains,withExcludedFolders,verifyModeProofPage:options.verify||async function(){return 0;},modeProofMessages:{},waitForReplicationDrain:options.drain||waitForReplicationDrain,crypto,TextEncoder,Uint8Array,btoa,atob,URL,navigator:{onLine:true},window:{setTimeout,setInterval,clearInterval},isFreeRelayConnection:s=>s.remoteType==='ONLY_P2P'};
 runInNewContext(code,context);const c=new context.Controller(plugin);c.factory={openRaw:open};
 let revision=1,phase='ready',envelope=await policies.encodeFolderPolicy({protocol:1,workspace,folders:['Фото'],caseSensitive:false},{encrypted:false});
 let ackError=false,ackCalls=0;
 c.api=async(action,body)=>{
  if(action==='read')return {protocol:1,revision,phase,envelope,database,enabled:true,cloud_ready:true};
  if(action==='challenge')return {revision,challenge:'d'.repeat(64),database,prepared:false};
  if(action==='ack'){ackCalls++;if(ackError)throw Object.assign(Error('offline'),{code:'network'});return {revision:body.revision,credentials:null};}
  throw Error('unexpected '+action);
 };
 await c.select(workspace,settings);
 const source=open(c.logical);await source.bulkDocs([{_id:'excluded',path:'Фото/private.md',type:'plain',children:[],size:3,data:'old'},
  {_id:'pending',path:'Work/pending.md',type:'plain',children:[],size:6,data:'unsent',mtime:99}]);await source.close();
 return {c,plugin,settings,files,open,ready:v=>ready=v,revision:v=>revision=v,envelope:v=>envelope=v,phase:v=>phase=v,ackError:v=>ackError=v,acks:()=>ackCalls};
}
test('controller prepares actual Pouch data before ack, retains unsent allowed edits and physical files',async t=>{
 const f=await fixture(t);assert.equal(await f.c.prepare(f.settings),true);const binding=f.c.entry.binding;
 assert.equal(f.acks(),1);assert.equal(f.c.entry.journal,null);assert.equal(f.c.proof(workspace).revision,1);
 const db=f.open(binding.target);assert.equal((await db.get('pending')).data,'unsent');await assert.rejects(db.get('excluded'),e=>e.status===404);await db.close();
 assert.equal(f.files.get('Фото/private.md'),'keep physical bytes');assert.equal(f.settings.additionalSuffixOfDatabaseName,'arcalink-folders-lab');
});
test('lost acknowledgement keeps the original cache and recovers the same prepared generation',async t=>{
 const f=await fixture(t);f.ackError(true);await assert.rejects(f.c.prepare(f.settings));const target=f.c.entry.binding.target;
 let source=f.open(f.c.logical);assert.equal((await source.get('excluded')).data,'old');await source.close();
 f.ackError(false);assert.equal(await f.c.prepare(f.settings),true);assert.equal(f.c.entry.binding.target,target);assert.equal(f.c.entry.journal,null);
});
test('destination preparation defers source retirement until settings are persisted',async t=>{
 const f=await fixture(t);assert.equal(await f.c.prepare(f.settings,false),true);assert.ok(f.c.entry.journal);assert.equal(f.c.entry.acknowledgement,undefined);
 let db=f.open(f.c.logical);assert.equal((await db.get('excluded')).data,'old');await db.close();
 await f.c.finishPrepared(f.settings,true);assert.equal(f.c.entry.journal,null);assert.equal(f.acks(),2);
});
test('a preparing policy and an open local database never acknowledge unfiltered data',async t=>{
 const f=await fixture(t);f.phase('preparing');assert.equal(await f.c.prepare(f.settings),false);assert.equal(f.acks(),0);
 f.phase('ready');f.ready(true);await assert.rejects(f.c.prepare(f.settings));assert.equal(f.acks(),0);
});
test('server rollback after a prepared policy fails closed',async t=>{
 const f=await fixture(t);await f.c.prepare(f.settings);f.revision(0);f.envelope(null);await assert.rejects(f.c.prepare(f.settings),e=>e.code==='policy-revision-regressed');assert.equal(f.acks(),1);
});
test('test build rejects an ordinary vault before it can contact the server',async t=>{
 const f=await fixture(t);f.files.delete('.arcalink-folder-lab.json');await assert.rejects(f.c.assertLabVault(),/Испытательная сборка/);
});
test('unrelated internal builds do not install a policy factory or add network calls',async t=>{
 const f=await fixture(t);const ordinary=new f.c.constructor({...f.plugin,manifest:{id:'arcalink-livesync-prototype'}});ordinary.api=()=>assert.fail('Feature must be disabled for this internal build');
 assert.equal(ordinary.active,false);ordinary.attach();assert.equal(ordinary.factory,undefined);assert.equal(await ordinary.beforeExchange(),true);assert.equal(await ordinary.prepareAccess({id:workspace},f.settings),false);await ordinary.ensureCloudAccess(workspace);
});
test('Community enables capability discovery without requiring a lab marker',async t=>{
 const f=await fixture(t);f.files.delete('.arcalink-folder-lab.json');const c=new f.c.constructor({...f.plugin,manifest:{id:'arcalink-sync'}});
 assert.equal(c.active,true);await c.assertLabVault();const settings={...f.settings,additionalSuffixOfDatabaseName:''};assert.ok(!c.logicalName(settings).includes('arcalink-folders-lab'));assert.equal(settings.additionalSuffixOfDatabaseName,'');
});
test('requested first-policy encryption initialization is explicit, re-read and cannot affect a newly selected workspace',async t=>{
 const f=await fixture(t);let known=false;const calls=[];
 f.c.api=async(action,body)=>{calls.push([action,body]);if(action==='initialize'){assert.equal(body.encrypted,false);known=true;return {initialized:true};}return {protocol:1,revision:0,phase:'ready',envelope:null,database,enabled:true,encryption_known:known};};
 assert.equal((await f.c.fetchState(f.settings,true)).revision,0);assert.deepEqual(calls.map(x=>x[0]),['read','initialize','read']);
 calls.length=0;await f.c.fetchState(f.settings,true);assert.deepEqual(calls.map(x=>x[0]),['read']);
 f.c.api=async action=>{assert.equal(action,'read');f.c.workspace='e'.repeat(32);return {enabled:true,encryption_known:false};};
 await assert.rejects(f.c.fetchState(f.settings,true));
});
test('failed or unverifiable Free-first initialization never prepares a local generation',async t=>{
 for(const fails of [true,false]){
  const f=await fixture(t);f.c.api=async action=>{if(action==='initialize'){if(fails)throw Error('mode mismatch');return {initialized:true};}return {enabled:true,encryption_known:false};};
  await assert.rejects(f.c.fetchState(f.settings,true));assert.equal(f.c.entry.binding,undefined);assert.equal(f.acks(),0);
 }
});
test('unavailable optional policy service preserves legacy exchange but never bypasses a known policy',async t=>{
 const f=await fixture(t);
 for(const error of [Object.assign(Error('offline'),{unavailable:true}),Object.assign(Error('missing'),{status:404}),Object.assign(Error('unavailable'),{status:503})]){
  f.c.api=async()=>{throw error;};f.c.entry={};f.c.observed=null;assert.equal(await f.c.beforeExchange(),true);
  for(const saved of [{seen:{revision:1}},{state:{revision:1}},{binding:{revision:1}},{journal:{revision:1}}]){
   f.c.entry=saved;assert.equal(await f.c.beforeExchange(),false);
  }
 }
 for(const status of [401,403]){f.c.entry={};f.c.api=async()=>{throw Object.assign(Error('denied'),{status});};assert.equal(await f.c.beforeExchange(),false);}
});
test('disabled capability cannot erase a seen or partially prepared policy',async t=>{
 const f=await fixture(t);f.c.api=async()=>({enabled:false});
 for(const entry of [{seen:{revision:1}},{binding:{revision:1}},{journal:{revision:1}}]){f.c.entry=entry;await assert.rejects(f.c.fetchState(f.settings));}
});
test('cached common rules remain visible while offline and a validated read clears only the controller error',async t=>{
 const f=await fixture(t);await f.c.prepare(f.settings);f.c.available=false;await f.c.select(workspace,f.settings);assert.equal(f.c.available,true);
 const api=f.c.api;f.c.api=async()=>{throw Object.assign(Error('offline'),{status:503});};assert.equal(await f.c.beforeExchange(),false);assert.ok(f.c.error);
 f.c.api=api;assert.equal(await f.c.beforeExchange(),true);assert.equal(f.c.error,'');
});
test('server-protected mounts from another device block overlapping cleanup before a hold',async t=>{
 const f=await fixture(t);const api=f.c.api;f.c.api=async(action,body)=>({...await api(action,body),protected_folders:['Команда/Документы'],protected_revision:'f'.repeat(64)});
 await f.c.fetchState(f.settings);assert.equal(f.c.protectedRevision,'f'.repeat(64));assert.deepEqual([...f.c.protectedPaths],['Команда/Документы']);
 await assert.rejects(f.c.preview(['Команда'],1),/управляются отдельно/);assert.equal(f.c.holding,false);assert.equal(f.c.operation,null);
});
test('shared mounts cannot intersect a common exclusion, even with different case',async t=>{
 const f=await fixture(t);await f.c.prepare(f.settings);
 for(const path of ['Фото','фото/новое'])assert.throws(()=>f.c.assertSharedMount(path),/вне общих исключений/);
 assert.doesNotThrow(()=>f.c.assertSharedMount('Разрешено'));f.c.holding=true;assert.throws(()=>f.c.assertSharedMount('Разрешено'));
});

function lifecycle(f,{suspended=false}={}){
 const events=[],s=f.plugin.core.services;let paused=suspended;
 s.appLifecycle={isSuspended:()=>paused,setSuspended:v=>{paused=v;events.push('pause:'+v);},onSuspending:async()=>{events.push('suspending');}};
 s.fileProcessing={commitPendingFileEvents:async()=>{events.push('commit');}};
 s.replicator={onCloseActiveReplication:async()=>{events.push('close');}};
 f.plugin.arcalinkP2P={transportLifecycle:{disconnect:async()=>{events.push('disconnect');}}};
 s.replication={replicationResultCount:{value:36},storageApplyingCount:{value:0},databaseQueueCount:{value:0}};
 s.control={applySettings:async()=>{events.push('apply');}};s.vault.scanVault=async()=>{events.push('scan');};f.ready(true);
 return {s,events,paused:()=>paused};
}
test('hold drains an occupied receive queue before pausing its processor',async t=>{
 let l,clock=0;const f=await fixture(t,{drain:read=>waitForReplicationDrain(read,{now:()=>clock,idleTimeout:5,totalTimeout:100,pollInterval:1,sleep:async()=>{clock++;if(!l.paused())l.s.replication.replicationResultCount.value--;}})});l=lifecycle(f);
 // Progress may exceed the idle timeout; only a paused processor would stall.
 await f.c.hold();assert.equal(l.s.replication.replicationResultCount.value,0);assert.equal(l.paused(),true);assert.equal(f.c.holding,true);
 assert.deepEqual(l.events,['commit','close','disconnect','commit','pause:true','suspending']);
 await f.c.release();assert.equal(l.paused(),false);assert.equal(f.c.holding,false);assert.deepEqual(l.events.slice(-3),['pause:false','apply','scan']);
});
test('hold waits for an in-flight Telegram write and commits its late file event before pausing',async t=>{
 let l,clock=0,late=false,commits=0;const f=await fixture(t,{drain:read=>waitForReplicationDrain(read,{now:()=>clock,idleTimeout:5,totalTimeout:100,pollInterval:1,sleep:async()=>{clock++;assert.equal(l.paused(),false);f.plugin.telegram.busy=false;late=true;}})});l=lifecycle(f);
 l.s.replication.replicationResultCount.value=0;f.plugin.telegram={busy:true};
 l.s.fileProcessing.commitPendingFileEvents=async()=>{commits++;if(commits===2){assert.equal(late,true);late=false;}};
 await f.c.hold();assert.equal(commits,2);assert.equal(late,false);assert.equal(l.paused(),true);assert.equal(f.plugin.telegram.busy,false);
});
function nativeGeneration(f,options={}){
 const l=lifecycle(f,options);let appReady=true,opened=0;
 l.s.appLifecycle.resetIsReady=()=>{appReady=false;l.events.push('not-ready');};l.s.appLifecycle.markIsReady=()=>{appReady=true;l.events.push('ready');};
 l.s.database.localDatabaseDirect={close:async()=>{f.ready(false);l.events.push('database-close');}};
 l.s.database.openDatabase=async()=>{opened++;const db=f.open(f.c.entry.binding.target);await assert.rejects(db.get('excluded'),e=>e.status===404);assert.equal((await db.get('pending')).data,'unsent');await db.close();f.ready(true);l.events.push('database-open');return true;};
 return {...l,appReady:()=>appReady,opened:()=>opened};
}
test('generation switches through native DB lifecycle without plugin restart and preserves manual pause',async t=>{
 for(const suspended of [false,true]){
  const f=await fixture(t,{drain:async()=>true}),l=nativeGeneration(f,{suspended});await f.c.reopenGeneration();
  assert.equal(l.opened(),1);assert.equal(l.appReady(),true);assert.equal(l.paused(),suspended);assert.equal(f.c.holding,false);assert.equal(f.c.loading,false);
  assert.equal(f.files.get('Фото/private.md'),'keep physical bytes');assert.equal(f.c.entry.binding.revision,1);assert.equal(f.c.entry.journal,null);
  assert.equal(l.events.includes('apply'),!suspended);assert.equal(l.events.includes('scan'),!suspended);
 }
});
test('failed ack stays paused with the old cache recoverable and retries the same prepared generation',async t=>{
 const f=await fixture(t,{drain:async()=>true}),l=nativeGeneration(f);f.ackError(true);await assert.rejects(f.c.reopenGeneration());const target=f.c.entry.binding.target;
 assert.equal(l.paused(),true);assert.equal(l.appReady(),false);assert.equal(l.opened(),0);let db=f.open(f.c.logical);assert.equal((await db.get('excluded')).data,'old');await db.close();
 f.ackError(false);await f.c.reopenGeneration();assert.equal(f.c.entry.binding.target,target);assert.equal(l.opened(),1);assert.equal(l.paused(),false);assert.equal(l.appReady(),true);
});
test('failed pre-switch drain never closes the old DB or marks a non-drained hold reusable',async t=>{
 const f=await fixture(t,{drain:async()=>false}),l=nativeGeneration(f);await assert.rejects(f.c.reopenGeneration());
 assert.equal(l.paused(),false);assert.equal(l.appReady(),true);assert.equal(f.c.holding,false);assert.equal(l.opened(),0);assert.ok(!l.events.includes('database-close'));
});
test('post-switch resume failure keeps the verified DB and reacquires a full hold on retry',async t=>{
 let drains=0;const f=await fixture(t,{drain:async()=>{drains++;return true;}}),l=nativeGeneration(f),apply=l.s.control.applySettings;
 l.s.control.applySettings=async()=>{throw Error('resume failure');};await assert.rejects(f.c.reopenGeneration());assert.equal(f.c.holding,false);assert.equal(l.appReady(),true);assert.equal(l.paused(),false);
 const before=drains;l.s.control.applySettings=apply;await f.c.reopenGeneration();assert.ok(drains>before);assert.equal(l.appReady(),true);assert.equal(l.paused(),false);
});
test('a stuck queue rolls back hold and does not reserve or freeze the workspace',async t=>{
 const f=await fixture(t,{drain:async()=>false}),l=lifecycle(f);f.c.available=true;
 await assert.rejects(f.c.preview(['Фото'],1));assert.equal(l.paused(),false);assert.equal(f.c.holding,false);assert.equal(f.c.operation,null);
 assert.ok(l.events.includes('scan'));assert.ok(!l.events.includes('suspending'));
});
for(const stage of ['commit','close','disconnect','suspending'])test('hold restores the original state after '+stage+' fails',async t=>{
 const f=await fixture(t,{drain:async()=>true}),l=lifecycle(f),error=Error('injected '+stage);
 const target=stage==='commit'?l.s.fileProcessing:stage==='close'?l.s.replicator:stage==='disconnect'?f.plugin.arcalinkP2P.transportLifecycle:l.s.appLifecycle;
 target[{commit:'commitPendingFileEvents',close:'onCloseActiveReplication',disconnect:'disconnect',suspending:'onSuspending'}[stage]]=async()=>{throw error;};
 await assert.rejects(f.c.hold(),e=>e===error);assert.equal(l.paused(),false);assert.equal(f.c.holding,false);
});
test('failed and cancelled holds preserve a user pause without restarting processing',async t=>{
 for(const drained of [false,true]){
  const f=await fixture(t,{drain:async()=>drained}),l=lifecycle(f,{suspended:true});
  if(drained){await f.c.hold();await f.c.release();}else await assert.rejects(f.c.hold());
  assert.equal(l.paused(),true);assert.equal(f.c.holding,false);assert.ok(!l.events.includes('apply'));assert.ok(!l.events.includes('scan'));
 }
});
test('a concurrent request cannot take or release another hold during its first await',async t=>{
 const f=await fixture(t,{drain:async()=>true}),l=lifecycle(f);let finish;
 l.s.fileProcessing.commitPendingFileEvents=()=>finish?Promise.resolve():new Promise(resolve=>{finish=resolve;});
 const first=f.c.hold();assert.equal(f.c.holding,true);await assert.rejects(f.c.hold());assert.equal(f.c.holding,true);
 finish();await first;assert.equal(l.paused(),true);await f.c.release();assert.equal(l.paused(),false);
});

test('a preflight already awaiting the server cannot reopen exchange after hold starts',async t=>{
 const f=await fixture(t,{drain:async()=>true}),l=lifecycle(f);let finish;
 f.c.fetchState=()=>new Promise(resolve=>{finish=resolve;});
 const preflight=f.c.beforeExchange();
 // assertLabVault is asynchronous; let preflight enter fetchState first.
 while(!finish)await new Promise(resolve=>setImmediate(resolve));
 await f.c.hold();finish({revision:0});assert.equal(await preflight,false);assert.equal(l.paused(),true);
 await f.c.release();
});

for(const stage of ['commit','reserve','inventory'])test('closing during '+stage+' waits for preparation rollback and never leaves a frozen operation',async t=>{
 const f=await fixture(t,{drain:async()=>true}),l=lifecycle(f);f.c.available=true;const calls=[];let finish;
 if(stage==='commit')l.s.fileProcessing.commitPendingFileEvents=()=>finish?Promise.resolve():new Promise(resolve=>{finish=resolve;});
 f.c.api=async(action)=>{
  calls.push(action);
  if(action==='read')return {protocol:1,revision:1,phase:'ready',envelope:await policies.encodeFolderPolicy({protocol:1,workspace,folders:['Фото'],caseSensitive:false},{encrypted:false}),database,enabled:true,encryption_known:true};
  if(action===stage)return await new Promise(resolve=>{finish=resolve;});
  if(action==='reserve')return {operation:'own-preview',operation_phase:'preview',source_sequence:'snapshot'};
  if(action==='inventory')return {source_sequence:'snapshot',entries:[],cursor:null};
  if(action==='cancel')return {cancelled:true};throw Error('unexpected '+action);
 };
 const preview=f.c.preview(['Фото'],1),rejected=assert.rejects(preview,e=>e.code==='folder-preview-cancelled');
 while(!finish)await new Promise(resolve=>setImmediate(resolve));
 const cancelled=f.c.cancelPreview();assert.equal(f.c.holding,true);
 finish(stage==='reserve'?{operation:'own-preview',operation_phase:'preview',source_sequence:'snapshot'}:stage==='inventory'?{source_sequence:'snapshot',entries:[],cursor:null}:undefined);
 await rejected;await cancelled;assert.equal(f.c.holding,false);assert.equal(l.paused(),false);assert.equal(f.c.operation,null);
 assert.equal(calls.filter(x=>x==='cancel').length,stage==='commit'?0:1);
 if(stage==='commit')assert.equal(calls.length,0);
});

async function freezeFixture(t){
 const f=await fixture(t),l=lifecycle(f);f.settings.remoteType='';f.settings.syncOnSave=true;f.revision(0);f.envelope(null);
 let messages=[],replications=0,blocked=false;
 l.s.appLifecycle.getUnresolvedMessages=async()=>[messages];
 l.s.replication.replicate=async prominent=>{assert.equal(prominent,false);assert.ok(l.events.includes('apply'),'Reactivate the retired provider before replication');replications++;messages=[];return true;};
 const api=f.c.api;f.c.api=async(action,body)=>{const r=await api(action,body);return action==='read'?{...r,operation:blocked?'own-freeze':null}:r;};
 return {...f,...l,messages:v=>messages=v,blocked:v=>blocked=v,replications:()=>replications,poll:async()=>{f.c.lastCheck=0;await f.c.poll();}};
}
test('a cancelled observed freeze resumes ordinary automatic exchange on the unchanged policy',async t=>{
 const f=await freezeFixture(t);f.blocked(true);await f.poll();assert.equal(f.replications(),0);assert.equal(f.c.exchangePausedByFreeze,true);
 f.blocked(false);await f.poll();assert.equal(f.replications(),1);assert.equal(f.c.exchangePausedByFreeze,false);assert.ok(f.events.includes('apply'));
 await f.poll();assert.equal(f.replications(),1);
});
test('a native rejection from a freeze shorter than polling resumes without bypassing readiness',async t=>{
 const f=await freezeFixture(t);f.messages(['Failed to fetch by API. 409: '+JSON.stringify({error_code:'workspace-frozen'}),'Репликация отменена из-за сбоя модуля']);
 await f.poll();assert.equal(f.replications(),1);await f.poll();assert.equal(f.replications(),1);
});
test('generic errors, manual pause, disabled automatic sync and an active freeze never trigger recovery',async t=>{
 const f=await freezeFixture(t);
 for(const messages of [['Репликация отменена из-за сбоя модуля'],['Failed to fetch by API. 409: {"error_code":"inventory-changed"}'],['Failed to fetch by API. 409: invalid']]){f.messages(messages);await f.poll();}
 assert.equal(f.replications(),0);
 f.messages(['Failed to fetch by API. 409: {"error_code":"workspace-frozen"}']);
 f.s.appLifecycle.setSuspended(true);await f.poll();assert.equal(f.replications(),0);
 f.s.appLifecycle.setSuspended(false);f.settings.syncOnSave=false;await f.poll();assert.equal(f.replications(),0);
 f.settings.syncOnSave=true;f.blocked(true);await f.poll();assert.equal(f.replications(),0);
});

test('failed readiness retains a freeze recovery for a later poll without clearing errors',async t=>{
 const f=await freezeFixture(t);f.c.exchangePausedByFreeze=true;f.s.replication.replicate=async()=>false;
 await f.poll();assert.equal(f.c.exchangePausedByFreeze,true);assert.equal(f.c.recovering,false);assert.ok(f.events.includes('apply'));
 f.s.replication.replicate=async()=>{throw Error('offline');};await f.poll();assert.equal(f.c.recovering,false);assert.equal(f.c.exchangePausedByFreeze,true);
});
test('Free reconnects only after an observed freeze and keeps a manual auto-start preference',async t=>{
 const f=await freezeFixture(t);f.settings.remoteType='ONLY_P2P';f.c.exchangePausedByFreeze=true;
 await f.poll();assert.ok(!f.events.includes('apply'));f.settings.P2P_AutoStart=true;
 await f.poll();assert.equal(f.replications(),0);assert.ok(f.events.includes('apply'));assert.equal(f.c.exchangePausedByFreeze,false);
});

test('legacy Community cloud without an accepted policy starts even when optional encryption discovery cannot identify its format',async t=>{
 for(const encrypted of [false,true]){
  const f=await fixture(t);f.plugin.manifest.id='arcalink-sync';f.settings.remoteType='';f.settings.encrypt=encrypted;f.settings.additionalSuffixOfDatabaseName='';
  f.c.bindingId=async()=>workspace;const calls=[];
  f.c.api=async action=>{calls.push(action);if(action==='initialize')throw Object.assign(Error('Unrecognised legacy metadata'),{status:409,code:'workspace-encryption-unknown'});assert.equal(action,'read');return {protocol:1,revision:0,phase:'ready',envelope:null,database,enabled:true,encryption_known:false,cloud_ready:true};};
  assert.equal(await f.c.startup(),true);assert.equal(f.c.error,'');assert.equal(await f.c.beforeExchange(),true);
  assert.equal(f.c.entry.binding,undefined);assert.equal(f.acks(),0);assert.equal(f.files.get('Фото/private.md'),'keep physical bytes');
  assert.ok(!calls.includes('initialize')&&!calls.includes('challenge')&&!calls.includes('ack'));
 }
});
test('known exclusion policy never bypasses startup checks because encryption metadata is unavailable',async t=>{
 const f=await fixture(t);f.plugin.manifest.id='arcalink-sync';f.settings.remoteType='';f.c.bindingId=async()=>workspace;
 f.c.entry={seen:{workspace,revision:1,phase:'ready',database}};f.c.observed=f.c.entry.seen;
 f.c.api=async action=>{if(action==='initialize')throw Object.assign(Error('Unrecognised legacy metadata'),{status:409,code:'workspace-encryption-unknown'});return {protocol:1,revision:1,phase:'ready',envelope:await policies.encodeFolderPolicy({protocol:1,workspace,folders:['Фото'],caseSensitive:false},{encrypted:false}),database,enabled:true,encryption_known:false};};
 // Persist the accepted boundary before startup reselects its workspace.
 await f.c.save({seen:f.c.entry.seen});assert.equal(await f.c.startup(),false);assert.ok(f.c.error);assert.equal(await f.c.beforeExchange(),false);assert.equal(f.acks(),0);
});

test('Community Free without a common policy also starts without initializing encryption',async t=>{
 const f=await fixture(t);f.plugin.manifest.id='arcalink-sync';f.c.bindingId=async()=>workspace;
 f.c.api=async action=>{assert.equal(action,'read');return {protocol:1,revision:0,phase:'ready',envelope:null,database,enabled:true,encryption_known:false};};
 assert.equal(await f.c.startup(),true);assert.equal(await f.c.beforeExchange(),true);assert.equal(f.acks(),0);
});
test('unverifiable first common rule never reserves and releases its hold while preserving physical files',async t=>{
 const f=await fixture(t,{drain:async()=>true}),l=lifecycle(f);f.c.available=true;const calls=[];
 f.c.api=async action=>{calls.push(action);if(['initialize','encryption-proof'].includes(action))throw Object.assign(Error('Unknown mode'),{status:409,code:'workspace-encryption-unknown'});assert.equal(action,'read');return {protocol:1,revision:0,phase:'ready',envelope:null,database,enabled:true,encryption_known:false};};
 await assert.rejects(f.c.preview(['Фото'],0),e=>e.code==='workspace-encryption-unknown');assert.deepEqual(calls,['read','initialize','encryption-proof']);
 assert.equal(f.c.holding,false);assert.equal(l.paused(),false);assert.equal(f.c.operation,null);assert.equal(f.c.entry.binding,undefined);assert.equal(f.files.get('Фото/private.md'),'keep physical bytes');
});
test('a policy changed during first-rule preparation is never reserved under an obsolete revision',async t=>{
 const f=await fixture(t,{drain:async()=>true}),l=lifecycle(f);f.c.available=true;
 f.c.api=async action=>{assert.equal(action,'read');return {protocol:1,revision:2,phase:'ready',envelope:await policies.encodeFolderPolicy({protocol:1,workspace,folders:['Фото'],caseSensitive:false},{encrypted:false}),database,enabled:true,encryption_known:true};};
 await assert.rejects(f.c.preview(['Фото'],1));assert.equal(f.c.holding,false);assert.equal(l.paused(),false);assert.equal(f.c.operation,null);
});
test('fresh preview admission never cancels another device operation observed by its metadata read',async t=>{
 const f=await fixture(t,{drain:async()=>true}),l=lifecycle(f);f.c.available=true;const calls=[];
 f.c.api=async action=>{calls.push(action);assert.equal(action,'read');return {protocol:1,revision:1,phase:'ready',envelope:await policies.encodeFolderPolicy({protocol:1,workspace,folders:['Фото'],caseSensitive:false},{encrypted:false}),database,enabled:true,encryption_known:true,operation:'other-device',operation_phase:'preview'};};
 await assert.rejects(f.c.preview(['Фото'],1));
 // The modal's error handler closes its preview too; that is not consent to
 // cancel the remote operation which caused admission to fail.
 await f.c.cancelPreview();assert.deepEqual(calls,['read']);assert.equal(f.c.remoteOperation,'other-device');assert.equal(f.c.operation,null);assert.equal(f.c.holding,false);assert.equal(l.paused(),false);
});
test('closing during a fresh metadata read cannot cancel the remote preview it discovers',async t=>{
 const f=await fixture(t,{drain:async()=>true}),l=lifecycle(f);f.c.available=true;let finish;const calls=[];
 f.c.api=async action=>{calls.push(action);assert.equal(action,'read');return new Promise(resolve=>{finish=resolve;});};
 const preview=f.c.preview(['Фото'],1),rejected=assert.rejects(preview,e=>e.code==='folder-preview-cancelled');
 while(!finish)await new Promise(resolve=>setImmediate(resolve));
 const cancelled=f.c.cancelPreview();
 finish({protocol:1,revision:0,phase:'ready',envelope:null,database,enabled:true,encryption_known:true,operation:'other-device',operation_phase:'preview'});
 await rejected;await cancelled;assert.deepEqual(calls,['read']);assert.equal(f.c.remoteOperation,'other-device');assert.equal(f.c.holding,false);assert.equal(l.paused(),false);
});
test('explicit common-operation cancel still cancels an observed remote preview',async t=>{
 const f=await fixture(t);f.c.remoteOperation='other-device';f.c.remotePhase='preview';const calls=[];
 f.c.api=async(action,body)=>{calls.push({action,operation:body.operation});return {cancelled:true};};
 await f.c.cancelPreview(true);assert.deepEqual(calls,[{action:'cancel',operation:'other-device'}]);assert.equal(f.c.remoteOperation,null);assert.equal(f.c.remotePhase,'');
});

for(const encrypt of [false,true])test('explicit first-rule recovery verifies every proof page before initializing '+encrypt,async t=>{
 const verified=[],f=await fixture(t,{verify:async page=>{verified.push(page);return encrypt?1:0;}});f.settings.encrypt=encrypt;
 let known=false;const calls=[];f.c.api=async(action,body)=>{
  calls.push([action,body]);
  if(action==='read')return {protocol:1,revision:0,phase:'ready',envelope:null,database,enabled:true,encryption_known:known};
  if(action==='initialize'){if(!body.proof)throw Object.assign(Error('Unknown mode'),{code:'workspace-encryption-unknown'});assert.equal(verified.length,2);assert.equal(body.encrypted,encrypt);known=true;return {initialized:true};}
  assert.equal(action,'encryption-proof');return body.cursor?{cursor:null,proof:'final-proof'}:{cursor:'signed-cursor',proof:null};
 };
 await f.c.fetchState(f.settings,true);assert.equal(known,true);assert.equal(f.acks(),0);
 assert.deepEqual(calls.map(x=>x[0]),['read','initialize','encryption-proof','encryption-proof','initialize','read']);
 assert.equal(calls[3][1].cursor,'signed-cursor');
});
test('invalid key, closing preview, or changed key prevents metadata initialization and releases preview hold',async t=>{
 for(const reason of ['key','close','change']){
  let f;f=await fixture(t,{drain:async()=>true,verify:async()=>{if(reason==='key')throw Object.assign(Error('Wrong key'),{code:'workspace-encryption-key-invalid'});if(reason==='close')f.c.previewCancelled=true;else f.settings.passphrase='Changed phrase';return 1;}});const l=lifecycle(f);f.c.available=true;f.settings.encrypt=true;f.settings.passphrase='Original phrase';let confirmations=0;
  f.c.api=async(action,body)=>{
   if(action==='read')return {protocol:1,revision:0,phase:'ready',envelope:null,database,enabled:true,encryption_known:false};
   if(action==='initialize'){if(body.proof)confirmations++;throw Object.assign(Error('Unknown mode'),{code:'workspace-encryption-unknown'});}
   assert.equal(action,'encryption-proof');return {cursor:null,proof:'proof'};
  };
  await assert.rejects(f.c.preview(['Фото'],0));assert.equal(confirmations,0);assert.equal(f.c.holding,false);assert.equal(l.paused(),false);assert.equal(f.files.get('Фото/private.md'),'keep physical bytes');
 }
});
test('an encrypted final proof without any verified ciphertext is never acknowledged',async t=>{
 const f=await fixture(t);f.settings.encrypt=true;f.c.api=async action=>{assert.equal(action,'encryption-proof');return {cursor:null,proof:'empty-proof'};};
 await assert.rejects(f.c.recoverEncryption(f.settings));
});
