import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {shared2ProductionPlugin} from '../scripts/shared2-production-build.mjs';
const source=fileURLToPath(new URL('../.cache/source/',import.meta.url)),require=createRequire(source+'esbuild.config.mjs');
const mock={name:'obsidian-manager-test',setup(build){build.onResolve({filter:/localized-obsidian$/},()=>({path:'localize',namespace:'manager-localize'}));build.onLoad({filter:/.*/,namespace:'manager-localize'},()=>({contents:'export const localizeMessage=value=>value;export const localizeMessageForLanguage=localizeMessage;'}));build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'manager-mock'}));build.onLoad({filter:/.*/,namespace:'manager-mock'},()=>({contents:`export class Modal{};export class Notice{};export class Setting{setName(value){globalThis.__shared2Settings?.push(value);return this;}setDesc(){return this;}addButton(fn){const button={buttonEl:{},setButtonText(){return this;},setDisabled(){return this;},setCta(){return this;},onClick(){return this;}};fn(button);return this;}};export class TFolder{};export function setIcon(){};export function requestUrl(){throw Error('Unexpected HTTP request');}` }));}};
const output=await require('esbuild').build({stdin:{contents:`export {Shared2} from '../../plugin/shared2';`,resolveDir:source},bundle:true,write:false,platform:'node',format:'cjs',plugins:[mock,shared2ProductionPlugin()],nodePaths:[source+'node_modules']});const Module=require('node:module'),mod=new Module('shared2-manager-test');mod.filename=source+'shared2-manager-test.cjs';mod.paths=Module._nodeModulePaths(source);mod._compile(output.outputFiles[0].text,mod.filename);const {Shared2}=mod.exports;
const id='a'.repeat(32),oldDatabase='arcalink_s_'+'b'.repeat(32),newDatabase='arcalink_s_'+'c'.repeat(32),oldCache='d'.repeat(32),newCache='e'.repeat(32),request='f'.repeat(32),scope={account:'owner',workspace:'work'};
function setup(){const record={id,protocol:2,mount:'Team',role:'owner',shared2Scope:scope,shared2CacheEpoch:oldCache,shared2AuthorityEpoch:1,shared2MembershipEpoch:1,shared2Generation:1,shared2Database:oldDatabase,shared2KeyEpoch:0,shared2Rekeying:true,shared2DeviceRequest:request};let saves=0;const plugin={folders:{records:[record],save:async()=>saves++,refresh(){},entries:new Map()}},manager=new Shared2(plugin);manager.scope=scope;const row={id,documentRoot:'Team',owner:'owner',ownerWorkspace:'work',ownerLabel:'owner@example.invalid',database:newDatabase,generation:2,revision:1,role:'owner',encrypted:true,keyEpoch:1,authorityEpoch:2,membershipEpoch:1};return {record,manager,row,plugin,get saves(){return saves;}};}

test('device pause persists and closes only this shared mount, then resumes with the same routing and cache',async()=>{
 const f=setup(),events=[];
 f.record.shared2Rekeying=false;
 f.manager.catalog={folders:[f.row]};f.manager.session=async()=>({});
 f.manager.context=f.manager.signature({});f.manager.poll=async()=>events.push('poll');
 f.manager.entries.set('other',{});
 f.manager.entryTasks.set(id,Promise.resolve().then(()=>{
  f.manager.entries.set(id,{controller:{close:async()=>events.push('controller')},engine:{close:async()=>events.push('engine')}});
 }));
 await f.manager.setLocalSync(f.record,false);
 assert.deepEqual(events,['controller','engine']);
 assert.equal(f.saves,1);assert.equal(f.record.shared2LocalPaused,true);
 assert.equal(f.manager.entries.has('other'),true);assert.equal(f.manager.entries.has(id),false);
 assert.equal(f.manager.scopeRow(f.record),null);assert.equal(f.manager.canEdit(id),true);
 await assert.rejects(f.manager.ensure(f.row,'Team'),/shared2-local-paused/);
 await f.manager.setLocalSync(f.record,true);
 assert.deepEqual(events,['controller','engine','poll']);
 assert.equal(f.saves,2);assert.equal(f.record.shared2CacheEpoch,oldCache);
 assert.equal(f.manager.scopeRow(f.record),f.row);
});

test('failed pause persistence leaves the connection active and stale accounts cannot change the preference',async()=>{
 const f=setup();
 f.record.shared2Rekeying=false;f.manager.catalog={folders:[f.row]};f.manager.session=async()=>({});
 f.manager.context=f.manager.signature({});
 f.plugin.folders.save=async()=>{throw Error('disk full');};
 const entry={controller:{close:async()=>assert.fail('closing an unpaused entry')}};
 f.manager.entries.set(id,entry);
 await assert.rejects(f.manager.setLocalSync(f.record,false),/disk full/);
 assert.equal(f.manager.scopeRow(f.record),f.row);assert.equal(f.manager.entries.get(id),entry);
 f.manager.session=async()=>({workspace:'elsewhere'});
 await assert.rejects(f.manager.setLocalSync(f.record,false),/shared2-account-changed/);
});

function recoveryBrowser(t,plugin){
 const names=['window','document','navigator'],saved=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));
 const win=new EventTarget(),doc=new EventTarget(),network={onLine:true},timers=new Map(),listeners=[];
 let next=0;
 win.setInterval=fn=>{timers.set(++next,fn);return next;};
 win.clearInterval=id=>timers.delete(id);
 doc.hidden=false;
 for(const [name,value] of [['window',win],['document',doc],['navigator',network]])Object.defineProperty(globalThis,name,{configurable:true,value});
 plugin.registerDomEvent=(target,type,fn)=>{target.addEventListener(type,fn);listeners.push(()=>target.removeEventListener(type,fn));};
 t.after(()=>{for(const remove of listeners)remove();names.forEach((name,i)=>{if(saved[i])Object.defineProperty(globalThis,name,saved[i]);else delete globalThis[name];});});
 return {win,doc,network,timers};
}
const flushRecovery=()=>new Promise(resolve=>setImmediate(resolve));

test('offline first catalog request retains retries and retries actual initialization on online',async t=>{
 const f=setup(),browser=recoveryBrowser(t,f.plugin);
 f.manager.session=async()=>({session:{accessToken:'synthetic',email:'owner@example.invalid',deviceId:'test'},workspace:'c'.repeat(32)});
 let attempts=0;
 f.manager.request=async()=>{attempts++;throw Error('network unavailable');};
 await f.manager.init();
 assert.equal(attempts,1);assert.equal(f.manager.enabled,false);assert.equal(browser.timers.size,1);
 browser.network.onLine=false;await f.manager.recoverConnection();assert.equal(attempts,1);
 browser.network.onLine=true;browser.win.dispatchEvent(new Event('online'));await flushRecovery();
 assert.equal(attempts,2);assert.equal(browser.timers.size,1);assert.equal(f.manager.initializing,null);
 await f.manager.dispose();assert.equal(browser.timers.size,0);
 browser.win.dispatchEvent(new Event('focus'));await flushRecovery();assert.equal(attempts,2);
});

test('partial startup retries initialization, then wake events poll without duplicate initialization',async t=>{
 const f=setup(),browser=recoveryBrowser(t,f.plugin);let starts=0,polls=0,finish;
 f.manager.start=async()=>{
  starts++;f.manager.enabled=true;
  if(starts===1)throw Error('network lost while loading state');
  await new Promise(resolve=>finish=resolve);f.manager.initialized=true;f.manager.warning='';
 };
 f.manager.poll=async()=>{polls++;};
 await f.manager.init();assert.equal(f.manager.initialized,false);assert.match(f.manager.warning,/network lost/);
 const retry=f.manager.recoverConnection();
 browser.win.dispatchEvent(new Event('online'));browser.win.dispatchEvent(new Event('focus'));
 browser.doc.dispatchEvent(new Event('visibilitychange'));
 assert.equal(starts,2);finish();await retry;
 assert.equal(f.manager.initialized,true);assert.equal(f.manager.warning,'');assert.equal(browser.timers.size,1);
 browser.win.dispatchEvent(new Event('focus'));await flushRecovery();assert.equal(polls,1);assert.equal(starts,2);
 browser.doc.hidden=true;browser.doc.dispatchEvent(new Event('visibilitychange'));await flushRecovery();assert.equal(polls,1);
 browser.doc.hidden=false;browser.doc.dispatchEvent(new Event('visibilitychange'));await flushRecovery();assert.equal(polls,2);
 await [...browser.timers.values()][0]();await flushRecovery();assert.equal(polls,3);
 await f.manager.dispose();
});

test('real partial initialization and polling recover from network rejection without restarting the manager',async t=>{
 const f=setup(),browser=recoveryBrowser(t,f.plugin),stored=new Map();
 f.manager.session=async()=>({session:{accessToken:'synthetic',email:'owner@example.invalid',deviceId:'test'},workspace:'c'.repeat(32)});
 f.manager.keyStorage={load:async key=>stored.get(key),insertIfAbsent:async(key,value)=>{if(!stored.has(key))stored.set(key,value);return stored.get(key);},close:async()=>{}};
 const worker=()=>({working:false,refresh:async()=>{},close:async()=>{}});
 f.manager.jobs=worker();f.manager.namespaceJobs=worker();f.manager.deviceTransfers=worker();f.manager.encryptedTransfers=worker();f.manager.reverseTransfers=worker();
 for(const name of ['reconcileDeviceTransfers','reconcileEncryptedTransfers','reconcileReverseTransfers','reconcileNamespaceJobs'])f.manager[name]=async()=>{};
 let failRefresh=true,failCatalog=false;
 f.manager.encryptedTransfers.refresh=async()=>{if(failRefresh)throw Error('offline during startup');};
 f.manager.request=async path=>{
  if(path==='/shared2/catalog'){
   if(failCatalog)throw Error('offline during poll');
   return {status:200,json:{protocol:2,account:'owner',revision:1,folders:[f.row]}};
  }
  return {status:404,json:{}};
 };
 await f.manager.init();assert.equal(f.manager.enabled,true);assert.equal(f.manager.initialized,false);assert.match(f.manager.warning,/offline during startup/);
 failRefresh=false;browser.win.dispatchEvent(new Event('online'));await flushRecovery();await f.manager.initializing;
 assert.equal(f.manager.initialized,true);assert.equal(f.manager.warning,'');assert.equal(f.manager.busy,false);
 failCatalog=true;await f.manager.recoverConnection();assert.match(f.manager.warning,/offline during poll/);assert.equal(f.manager.busy,false);
 failCatalog=false;await f.manager.recoverConnection();assert.equal(f.manager.warning,'');assert.equal(f.manager.busy,false);
 assert.equal(f.plugin.folders.records.length,1);assert.equal(f.record.shared2Rekeying,true);
 await f.manager.dispose();
});
test('restored device intent supplies verified cache before authority transition',async()=>{const f=setup();f.manager.deviceTransfers={working:false,snapshot:async()=>({requests:[{folder:id,requestKey:request,job:'c'.repeat(32),targetProfile:{database:newDatabase,generation:2,keyEpoch:1,cacheEpoch:newCache}}],jobs:[{id:'c'.repeat(32),state:'completed'}]})};await f.manager.reconcileDeviceTransfers();assert.equal(f.record.shared2Rekeying,false);await f.manager.applyCatalog({protocol:2,account:'owner',revision:1,folders:[f.row]});assert.equal(f.record.shared2CacheEpoch,newCache);assert.equal(f.record.shared2ReconcileAuthority,true);assert.equal(f.record.shared2RetiredLedgers.length,1);});
test('cancellation cannot release mount boundary until active client work drains',async()=>{const f=setup();f.manager.deviceTransfers={working:true,snapshot:async()=>({requests:[{folder:id,requestKey:request,terminal:true,phase:'cancelled'}],jobs:[]})};await f.manager.reconcileDeviceTransfers();assert.equal(f.record.shared2Rekeying,true);f.manager.deviceTransfers.working=false;await f.manager.reconcileDeviceTransfers();assert.equal(f.record.shared2Rekeying,false);assert.equal(f.record.shared2CacheEpoch,oldCache);});

test('namespace reconciliation does not render device controls or require a settings container',async()=>{const f=setup();f.manager.deviceState={requests:[{folder:id,requestKey:request}],jobs:[]};await f.manager.reconcileNamespaceJobs();assert.equal(f.record.shared2Rekeying,true);assert.equal(f.saves,0);});

test('settings render a pending device task together with the folder controls',()=>{const f=setup(),container={empty(){},createEl(){return {};},createDiv(){return this;},isConnected:true};f.manager.enabled=true;f.manager.catalog={folders:[f.row]};f.manager.deviceState={requests:[{folder:id,requestKey:request,phase:'planned'}],jobs:[]};globalThis.__shared2Settings=[];try{assert.equal(f.manager.render(container),true);assert.ok(globalThis.__shared2Settings.includes('Шифрование: Team'));assert.ok(globalThis.__shared2Settings.includes('Папка: Team'));}finally{delete globalThis.__shared2Settings;}});
test('encrypted share adopts verified cache before converting its newly admitted folder',async()=>{const f=setup();f.record.id='0'.repeat(32);f.record.protocol=undefined;f.record.shared2EncryptedRequest=request;f.record.shared2Creating=true;f.record.shared2Preparing=true;f.record.shared2CacheEpoch=undefined;f.manager.encryptedTransfers={working:false,snapshot:async()=>({requests:[{requestKey:request,job:'1'.repeat(32),targetProfile:{database:newDatabase,generation:2,keyEpoch:1,cacheEpoch:newCache}}],jobs:[{id:'1'.repeat(32),folder:id,state:'completed'}]})};await f.manager.reconcileEncryptedTransfers();assert.equal(f.record.id,id);assert.equal(f.record.shared2Creating,false);await f.manager.applyCatalog({protocol:2,account:'owner',revision:1,folders:[f.row]});assert.equal(f.record.protocol,2);assert.equal(f.record.shared2CacheEpoch,newCache);});
test('encrypted cancellation waits for device transfer to drain before removing local routing boundary',async()=>{const f=setup();f.record.shared2EncryptedRequest=request;f.manager.encryptedTransfers={working:true,snapshot:async()=>({requests:[{requestKey:request,terminal:true,phase:'cancelled'}],jobs:[]})};await f.manager.reconcileEncryptedTransfers();assert.equal(f.plugin.folders.records.length,1);f.manager.encryptedTransfers.working=false;await f.manager.reconcileEncryptedTransfers();assert.equal(f.plugin.folders.records.length,0);});

test('reverse completion drains client work before closing shared engine and removing only routing record',async()=>{const f=setup();f.record.shared2ReverseRequest=request;f.record.shared2Unsharing=true;const closed=[];f.manager.entries.set(id,{controller:{close:async()=>closed.push('controller')},engine:{close:async()=>closed.push('engine')}});f.manager.reverseTransfers={working:true,snapshot:async()=>({requests:[{requestKey:request,job:'1'.repeat(32)}],jobs:[{id:'1'.repeat(32),state:'completed'}]})};await f.manager.reconcileReverseTransfers();assert.equal(f.plugin.folders.records.length,1);assert.deepEqual(closed,[]);f.manager.reverseTransfers.working=false;await f.manager.reconcileReverseTransfers();assert.equal(f.plugin.folders.records.length,0);assert.deepEqual(closed,['controller','engine']);assert.equal(f.manager.entries.size,0);});
test('reverse cancellation restores shared editing boundary without changing cache or unrelated records',async()=>{const f=setup(),other={...f.record,id:'2'.repeat(32),shared2ReverseRequest:'other'};f.plugin.folders.records.push(other);f.record.shared2ReverseRequest=request;f.record.shared2Unsharing=true;f.manager.reverseTransfers={working:false,snapshot:async()=>({requests:[{requestKey:request,phase:'cancelled',terminal:true}],jobs:[]})};await f.manager.reconcileReverseTransfers();assert.equal(f.record.shared2Unsharing,false);assert.equal(f.record.shared2ReverseRequest,null);assert.equal(f.record.shared2CacheEpoch,oldCache);assert.equal(f.plugin.folders.records.length,2);assert.equal(other.shared2ReverseRequest,'other');});

test('forward alias completion drains work, reuses verified union cache and preserves the routing record',async()=>{
 const f=setup();f.record.shared2AliasRequest=request;f.record.shared2Reconciling=true;f.manager.aliasTransfers={working:true,snapshot:async()=>({requests:[{folder:id,requestKey:request,job:'1'.repeat(32),targetProfile:{database:newDatabase,generation:2,keyEpoch:1,cacheEpoch:newCache}}],jobs:[{id:'1'.repeat(32),state:'completed'}]})};await f.manager.reconcileAliasTransfers();assert.equal(f.record.shared2Reconciling,true);assert.equal(f.record.shared2DeviceTarget,undefined);f.manager.aliasTransfers.working=false;await f.manager.reconcileAliasTransfers();assert.equal(f.record.shared2Reconciling,false);assert.equal(f.plugin.folders.records.length,1);await f.manager.applyCatalog({protocol:2,account:'owner',revision:1,folders:[f.row]});assert.equal(f.record.shared2CacheEpoch,newCache);assert.equal(f.record.shared2ReconcileAuthority,true);
});
test('forward alias cancellation releases only its editing boundary and keeps local files/cache',async()=>{
 const f=setup();f.record.shared2AliasRequest=request;f.record.shared2Reconciling=true;f.manager.aliasTransfers={working:false,snapshot:async()=>({requests:[{folder:id,requestKey:request,terminal:true,phase:'cancelled'}],jobs:[]})};await f.manager.reconcileAliasTransfers();assert.equal(f.record.shared2Reconciling,false);assert.equal(f.record.shared2AliasRequest,null);assert.equal(f.record.shared2CacheEpoch,oldCache);assert.equal(f.plugin.folders.records.length,1);
});
test('encrypted unshare uses durable reverse intent while plaintext keeps existing namespace flow',async()=>{const f=setup(),calls=[];f.plugin.core={services:{setting:{currentSettings:()=>({encrypt:false})}}};f.manager.reverseTransfers={plan:async(...args)=>calls.push(['reverse',...args])};f.manager.namespaceJobs={plan:async(...args)=>{calls.push(['plain',...args]);return {requestKey:request};}};f.manager.poll=async()=>{};f.manager.prepareNamespace=async()=>{};await f.manager.beginUnshare(f.row,f.record);assert.deepEqual(calls,[['reverse',id,'Team']]);f.row.encrypted=false;await f.manager.beginUnshare(f.row,f.record);assert.equal(calls.at(-1)[0],'plain');});
function reversePreparation(){const f=setup(),workspace='c'.repeat(32),events=[];f.manager.scope={...scope,workspace};f.record.shared2Scope={...scope,workspace};f.row.ownerWorkspace=workspace;f.manager.catalog={folders:[f.row]};const state={phase:'ready',database:'arcalink_p_'+'d'.repeat(32),revision:2,policy:{protocol:1,workspace,caseSensitive:false,folders:['Team','Private/Excluded']}};f.plugin.core={services:{setting:{currentSettings:()=>({encrypt:false})},fileProcessing:{commitPendingFileEvents:async()=>events.push('files')},replication:{replicate:async()=>{events.push('private');return true;}}}};f.plugin.folderPolicies={active:true,workspace,protectedRevision:'protected',fetchState:async()=>state,crypto:()=>({encrypted:false}),hold:async()=>events.push('hold'),release:async()=>events.push('release')};f.manager.ensure=async()=>({controller:{synchronize:async()=>{events.push('shared');return {conflicts:[]};}}});return {...f,state,events,intent:{folder:id,mount:'Team',requestKey:request}};}
test('reverse preparation drains both sources and restores ordinary folder policy without changing other exclusions',async()=>{const f=reversePreparation(),result=await f.manager.prepareReverse(f.intent,async()=>true);assert.deepEqual(f.events,['shared','files','private','hold','release']);assert.equal(result.database,f.state.database);assert.equal(result.protectedRevision,'protected');assert.deepEqual(JSON.parse(result.envelope.data).folders,['Private/Excluded']);assert.equal(f.record.shared2ReverseRequest,request);assert.equal(f.record.shared2Unsharing,true);assert.equal(f.plugin.folders.records.length,1);});
test('reverse preparation cannot silently leave the returned folder under excluded parent or continue after cancellation',async()=>{const f=reversePreparation();f.record.mount='Parent/Team';f.intent.mount=f.record.mount;f.state.policy.folders=['Parent'];await assert.rejects(f.manager.prepareReverse(f.intent,async()=>true),/excludes-mount/);assert.equal(f.record.shared2Unsharing,undefined);assert.equal(f.events.includes('hold'),false);const g=reversePreparation();await assert.rejects(g.manager.prepareReverse(g.intent,async()=>false),/cancelled/);assert.equal(g.events.includes('hold'),false);});

test('forward alias preparation preserves exclusions, closes source work and leaves ordinary sync connected',async()=>{
 const f=reversePreparation();f.record.shared2Rekeying=false;f.manager.ensure=async()=>({controller:{synchronize:async()=>{f.events.push('shared');return {conflicts:[]};},close:async()=>f.events.push('controller-close')},engine:{close:async()=>f.events.push('engine-close')}});const result=await f.manager.prepareAliases(f.intent,async()=>true);assert.deepEqual(JSON.parse(result.envelope.data).folders,['Team','Private/Excluded']);assert.deepEqual(f.events,['shared','files','private','hold','release','controller-close','engine-close']);assert.equal(f.record.shared2Reconciling,true);assert.equal(f.record.shared2AliasRequest,request);assert.equal(f.record.shared2Unsharing,undefined);assert.equal(f.plugin.folders.records.length,1);
});
test('forward alias preparation refuses another document root before touching sync',async()=>{
 const f=reversePreparation();f.record.shared2Rekeying=false;f.row.documentRoot='Different';await assert.rejects(f.manager.prepareAliases(f.intent,async()=>true),/owned-folder-required/);assert.deepEqual(f.events,[]);
});

test('legacy alias review is rendered separately from an ordinary retry action',()=>{const f=setup(),container={empty(){},createEl(){return {};},createDiv(){return this;},isConnected:true};f.manager.enabled=true;f.manager.catalog={folders:[f.row]};f.manager.reverseState={requests:[{folder:id,mount:'Team',requestKey:request,job:'1'.repeat(32),error:'shared2-reverse-private-aliases-require-reconciliation',aliasReview:{files:2}}],jobs:[]};globalThis.__shared2Settings=[];try{f.manager.render(container);assert.ok(globalThis.__shared2Settings.includes('Прекращение общего доступа: Team'));assert.ok(globalThis.__shared2Settings.includes('Найдены прежние личные копии: 2'));}finally{delete globalThis.__shared2Settings;}});

test('purged restore preparation uses only the existing cache and drains active work without source synchronization',async()=>{
 const f=setup(),events=[];f.row.database=oldDatabase;f.row.generation=1;f.row.keyEpoch=0;f.record.shared2Rekeying=false;f.manager.catalog={revision:1,folders:[f.row]};f.manager.retentionStatus.set(id,{folder:id,database:oldDatabase,generation:1,state:'purged',canRestore:true});
 f.manager.entries.set(id,{controller:{close:async()=>events.push('controller'),synchronize:async()=>{throw Error('erased source requested');}},engine:{close:async()=>events.push('engine')}});f.manager.ensure=async()=>{throw Error('empty replacement must not be opened');};
 const source=await f.manager.prepareDeviceTransfer(id,request,{operation:'restore'});assert.equal(source.cacheEpoch,oldCache);assert.equal(source.database,oldDatabase);assert.deepEqual(events,['controller','engine']);assert.equal(f.record.shared2DevicePrepared,true);assert.equal(f.record.shared2Rekeying,true);
});
test('purged folder UI shows explicit local restore and paused authority cannot accept ordinary edits',()=>{
 const f=setup(),container={empty(){},createEl(){return {};},createDiv(){return this;},isConnected:true};f.manager.enabled=true;f.manager.catalog={folders:[f.row]};f.manager.retentionStatus.set(id,{folder:id,database:f.row.database,generation:f.row.generation,state:'purged',canRestore:true});f.manager.entries.set(id,{});f.record.shared2Rekeying=false;
 assert.equal(f.manager.canEdit(id),false);globalThis.__shared2Settings=[];try{f.manager.render(container);assert.ok(globalThis.__shared2Settings.includes('Серверная копия удалена'));}finally{delete globalThis.__shared2Settings;}
 f.manager.retentionStatus.get(id).generation--;assert.equal(f.manager.canEdit(id),true,'old-generation pause must not affect a new authority');
});

function encryptedPreparation(){
 const f=reversePreparation();f.plugin.folders.records=[];f.state.policy.folders=[];
 f.plugin.core.services.setting.currentSettings=()=>({encrypt:true});
 f.plugin.folderPolicies.crypto=()=>({encrypted:true,seal:async()=> 'synthetic sealed policy'});
 f.plugin.folderPolicies.hold=async()=>{f.events.push('hold');f.plugin.folderPolicies.holding=true;};
 f.plugin.folderPolicies.release=async()=>{f.events.push('release');f.plugin.folderPolicies.holding=false;};
 // The real validator rejects while holding; keep that boundary in this fixture.
 f.plugin.folders.validateMount=mount=>{f.events.push('validate');assert.equal(mount,'Team');if(f.plugin.folderPolicies.holding)throw Error('Policy is not import-ready');};
 return f;
}
test('encrypted personal extraction validates the mount before its own policy hold and can resume one intent',async()=>{
 const f=encryptedPreparation(),result=await f.manager.prepareEncryptedShare(f.intent,async()=>true);
 assert.deepEqual(f.events,['files','private','validate','hold','release']);assert.equal(result.envelope.format,'sealed-v1');assert.equal(f.plugin.folders.records.length,1);
 assert.equal(f.plugin.folders.records[0].shared2EncryptedRequest,request);
 f.events.length=0;await f.manager.prepareEncryptedShare(f.intent,async()=>true);
 assert.deepEqual(f.events,['files','private','hold','release']);assert.equal(f.plugin.folders.records.length,1);
});
test('encrypted personal extraction releases its hold if another mount appears during the drain',async()=>{
 const f=encryptedPreparation(),hold=f.plugin.folderPolicies.hold;
 f.plugin.folderPolicies.hold=async()=>{await hold();f.plugin.folders.records.push({id:'9'.repeat(32),mount:'Team/Sub'});};
 await assert.rejects(f.manager.prepareEncryptedShare(f.intent,async()=>true),/source-not-ready/);
 assert.equal(f.plugin.folders.records.length,1);assert.equal(f.plugin.folders.records[0].mount,'Team/Sub');assert.equal(f.plugin.folderPolicies.holding,false);
});

function plainNamespacePreparation(){
 const f=reversePreparation();f.plugin.folders.records=[];f.plugin.folders.validateMount=()=>{};
 const session={session:{email:'owner@example.invalid',deviceId:'device'},workspace:f.manager.scope.workspace};
 f.manager.session=async()=>session;f.manager.context=f.manager.signature(session);f.manager.poll=async()=>{};f.manager.redraw=()=>{};
 f.plugin.core.services.replicator={runWithActiveReplicatorContext:async task=>task({replicator:{closeReplication:async()=>f.events.push('close-continuous')}})};f.plugin.core.services.control={applySettings:async()=>f.events.push('resume')};
 f.plugin.core.services.database={localDatabaseDirect:{localDatabase:{info:async()=>({update_seq:5})}}};
 f.plugin.folderPolicies.hold=async()=>{f.events.push('hold');f.plugin.folderPolicies.holding=true;};
 f.plugin.folderPolicies.release=async()=>{f.events.push('release');f.plugin.folderPolicies.holding=false;};
 f.plugin.folderPolicies.fetchState=async()=>{f.events.push('proof');assert.equal(f.plugin.folderPolicies.holding,true);return f.state;};
 const intent={kind:'share',value:'Team',requestKey:request},marks=[];
 f.manager.namespaceJobs={mark:async(...args)=>marks.push(args),snapshot:async()=>({requests:[intent]}),submit:async()=>{f.events.push('submit');return {id:'1'.repeat(32),folder:id};}};
 return {...f,intent,marks};
}
test('plain namespace encryption proof runs after replication drains and while exchanges are held',async()=>{
 const f=plainNamespacePreparation();await f.manager.prepareNamespace(f.intent);
 assert.deepEqual(f.events,['files','close-continuous','private','hold','proof','release','submit']);
 assert.equal(f.plugin.folders.records[0].id,id);assert.equal(f.plugin.folderPolicies.holding,false);
 assert.equal(f.marks.some(row=>row[1]==='error'),false);
});
test('failed namespace proof releases exchanges without routing or submitting a partial share',async()=>{
 const f=plainNamespacePreparation();f.plugin.folderPolicies.fetchState=async()=>{f.events.push('proof');throw Error('workspace-encryption-changed');};
 await f.manager.prepareNamespace(f.intent);
 assert.deepEqual(f.events,['files','close-continuous','private','hold','proof','release']);assert.equal(f.plugin.folders.records.length,0);
 assert.equal(f.plugin.folderPolicies.holding,false);assert.equal(f.marks.at(-1)[2],'workspace-encryption-changed');
});

test('namespace proof failures explain retry without claiming a service outage',async()=>{
 const {shared2Message}=await import('../plugin/shared2-messages.mjs');
 assert.match(shared2Message('workspace-encryption-changed'),/хранилище изменилось/);
 assert.match(shared2Message('workspace-encryption-proof-invalid'),/устарела/);
});

test('failed finite namespace drain restores continuous settings and does not publish a route',async()=>{
 const f=plainNamespacePreparation();f.plugin.core.services.replication.replicate=async()=>{f.events.push('private');return false;};
 await f.manager.prepareNamespace(f.intent);assert.deepEqual(f.events,['files','close-continuous','private','resume']);
 assert.equal(f.plugin.folders.records.length,0);assert.equal(f.marks.at(-1)[2],'shared2-source-not-ready');
});

test('namespace finite drain stops the current connection without retiring its provider',async()=>{
 const f=plainNamespacePreparation();let active=true,continuous=true;
 f.plugin.core.services.replicator={runWithActiveReplicatorContext:async task=>{assert.equal(active,true);return task({replicator:{closeReplication:async()=>{continuous=false;f.events.push('close-continuous');}}});},onCloseActiveReplication:async()=>{active=false;}};
 f.plugin.core.services.replication.replicate=async()=>{assert.equal(active,true);assert.equal(continuous,false);f.events.push('private');return true;};
 await f.manager.prepareNamespace(f.intent);assert.equal(f.marks.some(row=>row[1]==='error'),false);assert.equal(f.plugin.folders.records[0].id,id);
});

function eventScopes(){
 const a={id:'a'.repeat(32),protocol:2,mount:'Local',shared2Scope:scope},b={id:'b'.repeat(32),protocol:2,mount:'Other',shared2Scope:scope};
 const records=[a,b],events=[],personal=[];
 const plugin={folders:{records,record:path=>records.find(r=>path===r.mount||path.startsWith(r.mount+'/'))},app:{vault:{getFiles:()=>[]},fileManager:{renameFile:async()=>{throw Error('Unexpected move reversal');}}},core:{serviceModules:{storageAccess:{vaultManager:{watchVaultRename:(file,old)=>personal.push([file.path,old])}}}}};
 const manager=new Shared2(plugin);manager.scope=scope;manager.catalog={folders:records.map((r,i)=>({id:r.id,role:'editor',documentRoot:i?'Second/Root':'Owner/Root'}))};
 for(const r of records)manager.entries.set(r.id,{controller:{enqueue:async item=>events.push([r.id,item])},engine:{metadataFiles:async()=>[]}});
 manager.ensure=async row=>manager.entries.get(row.id);
 const file=(path)=>({path,name:path.split('/').at(-1),stat:{size:10,ctime:1,mtime:2}});
 return {manager,plugin,a,b,events,personal,file};
}
test('protocol-2 drag rename routes to the ordinary LiveSync rename handler with the original path',async()=>{
 const f=eventScopes();await f.manager.renamed(f.file('Local/Attachments/a.bin'),'Local/a.bin');
 assert.equal(f.events.length,1);const event=f.events[0][1];assert.equal(event.type,'RENAME');assert.equal(event.args.oldPath,'Owner/Root/a.bin');assert.equal(event.args.file.path,'Owner/Root/Attachments/a.bin');
});
test('directory deletion queues only the affected live metadata paths',async()=>{
 const f=eventScopes();f.manager.entries.get(f.a.id).engine.metadataFiles=async()=>[{path:'Owner/Root/Sub/a.md'},{path:'Owner/Root/Sub/deep/b.bin'},{path:'Owner/Root/Sub/old.md',deleted:true},{path:'Owner/Root/Submarine/untouched.md'}];
 await f.manager.changed('delete',{path:'Local/Sub',children:[]});
 assert.deepEqual(f.events.map(([,item])=>[item.type,item.args.file.path]),[['DELETE','Owner/Root/Sub/a.md'],['DELETE','Owner/Root/Sub/deep/b.bin']]);
});
test('moving a directory out of a shared scope routes child events to both scoped and personal engines',async()=>{
 const f=eventScopes();f.plugin.app.vault.getFiles=()=>[f.file('Private/Moved/a.md'),f.file('Private/Moved/deep/b.bin')];
 await f.manager.renamed({path:'Private/Moved',children:[]},'Local/Sub');
 assert.deepEqual(f.events.map(([,item])=>[item.type,item.args.file.path]),[['DELETE','Owner/Root/Sub/a.md'],['DELETE','Owner/Root/Sub/deep/b.bin']]);
 assert.deepEqual(f.personal,[['Private/Moved/a.md','Local/Sub/a.md'],['Private/Moved/deep/b.bin','Local/Sub/deep/b.bin']]);
});
test('moving between two shared scopes does not leak either document root into the other',async()=>{
 const f=eventScopes();await f.manager.renamed(f.file('Other/New/a.md'),'Local/a.md');
 assert.deepEqual(f.events.map(([id,item])=>[id,item.type,item.args.file.path]),[[f.a.id,'DELETE','Owner/Root/a.md'],[f.b.id,'CREATE','Second/Root/New/a.md']]);
 assert.deepEqual(f.personal,[]);
});
test('metadata polling wakes a live owner without awaiting startup or starting another full pass',async()=>{
 const f=setup();f.record.shared2Rekeying=false;Object.assign(f.row,{database:oldDatabase,generation:1,revision:0,encrypted:false,keyEpoch:0,authorityEpoch:1,membershipEpoch:1});
 f.manager.enabled=true;f.manager.initialized=true;
 const worker=()=>({working:false,refresh:async()=>{}});f.manager.deviceTransfers=worker();f.manager.encryptedTransfers=worker();f.manager.reverseTransfers=worker();f.manager.jobs=worker();f.manager.namespaceJobs=worker();
 for(const method of ['reconcileDeviceTransfers','reconcileEncryptedTransfers','reconcileReverseTransfers','reconcileNamespaceJobs'])f.manager[method]=async()=>{};
 let wakes=0;const entry={version:f.manager.version(f.row),controller:{wake:()=>{wakes++;return new Promise(()=>{});},synchronize:()=>{throw Error('Full scan must never be called by metadata polling');}}};
 f.manager.entries.set(id,entry);f.manager.access.set(id,{revision:0});f.manager.ensure=async()=>entry;
 f.manager.request=async path=>({status:200,json:path==='/shared2/catalog'?{protocol:2,account:'owner',revision:0,folders:[f.row]}:path==='/shared2/retention'?{folders:[]}:path==='/shared2/key-inbox'?{envelopes:[]}:{invitations:[]}});
 await f.manager.poll();await f.manager.poll();assert.equal(wakes,2);assert.equal(f.manager.busy,false);
});
