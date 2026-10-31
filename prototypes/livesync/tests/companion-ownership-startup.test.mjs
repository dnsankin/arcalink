import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from '../.cache/source/node_modules/esbuild/lib/main.js';

const source=new URL('../.cache/source/',import.meta.url);
async function compile(entry,extra={}){
 const stubs={
  obsidian:'export class Notice {} export class Modal {} export class Setting {} export async function requestUrl(){throw Error("Network forbidden");}',
  ...extra,
 };
 const result=await build({entryPoints:[fileURLToPath(entry)],bundle:true,write:false,format:'esm',platform:'node',nodePaths:[fileURLToPath(new URL('node_modules',source))],
  plugins:[{name:'startup-host-fixtures',setup(api){api.onResolve({filter:/.*/},args=>Object.hasOwn(stubs,args.path)?{path:args.path,namespace:'fixture'}:undefined);
   api.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'js'}));}}]});
 const dir=await mkdtemp(join(tmpdir(),'arcalink-ownership-test-')),path=join(dir,'compiled.mjs');
 try{await writeFile(path,result.outputFiles[0].text);return await import(pathToFileURL(path).href);}finally{await rm(dir,{recursive:true,force:true});}
}
const {CompanionOwnership}=await compile(new URL('../plugin/companion-ownership.ts',import.meta.url));
const {ModuleLiveSyncMain}=await compile(new URL('src/modules/main/ModuleLiveSyncMain.ts',source),{
 '@/modules/AbstractModule.ts':'export class AbstractModule { constructor(core){this.core=core;} get services(){return this.core.services;} get settings(){return this.services.setting.currentSettings();} _log(){} }',
 '@/common/events.ts':'export const EVENT_LAYOUT_READY="layout",EVENT_PLUGIN_LOADED="loaded",EVENT_REQUEST_RELOAD_SETTING_TAB="reload",EVENT_SETTING_SAVED="saved"; export const eventHub={emitEvent(){},onEvent(){}};',
 '@/common/translation':'export const $msg=value=>value; export function setLang(){};',
});
class Chain {
 handlers=[];
 addHandler(handler,priority=0){this.handlers.push({handler,priority});}
 async run(){for(const {handler}of this.handlers.toSorted((a,b)=>a.priority-b.priority))if(await handler()===false)return false;return true;}
}
function fixture(phase='held'){
 const calls=[],files=new Map(),settings={isConfigured:true,liveSync:true,additionalSuffixOfDatabaseName:'original',couchDB_DBNAME:'remote',syncIgnoreRegEx:'keep'};
 const hooks={onSettingLoaded:new Chain(),onBeforeReplicate:new Chain(),onBeforeSaveSettingData:new Chain()};
 const identity={schema:1,nonce:'11111111-1111-4111-8111-111111111111',generation:'22222222-2222-4222-8222-222222222222',
  accountId:'33333333-3333-4333-8333-333333333333',companionDeviceId:'44444444-4444-4444-8444-444444444444',workspaceId:'a'.repeat(32)};
 const journal={...identity,phase,original:{additionalSuffixOfDatabaseName:'original',liveSync:true,suspendFileWatching:false,suspendParseReplicationResult:false,syncIgnoreRegEx:'keep'},
  quarantineSuffix:'fresh',pluginDeviceId:'old-plugin',remoteDatabase:'remote',bases:[],scope:{ordinary:true,excludedPrefixes:[]}};
 files.set('.obsidian/plugins/arcalink-sync/companion/ownership-state.json',JSON.stringify(journal));
 const services={
  API:{},context:{events:{}},appLifecycle:{onSettingLoaded:()=>hooks.onSettingLoaded.run(),onWireUpEvents:async()=>true,onInitialise:async()=>true,onLoaded:async()=>{calls.push('ordinary-loaded');},onLayoutReady:async()=>true,
   onFirstInitialise:async()=>{calls.push('watch');return true;},onResumed:new Chain()},
  setting:{currentSettings:()=>settings,loadSettings:async()=>calls.push('settings-loaded'),onBeforeSaveSettingData:hooks.onBeforeSaveSettingData,
   applyPartial:async patch=>{Object.assign(settings,patch);calls.push('settings-saved');}},
  database:{openDatabase:async()=>{calls.push('database-open');},isDatabaseReady:()=>false},
  replication:{onBeforeReplicate:hooks.onBeforeReplicate,replicate:async()=>{calls.push('replicate');return true;}},
  databaseEvents:{initialiseDatabase:async()=>{calls.push('scan');return true;}},
 };
 const adapter={exists:async path=>files.has(path),stat:async path=>files.has(path)?{type:'file',size:files.get(path).length}:null,
  read:async path=>files.get(path),write:async(path,text)=>{files.set(path,text);},mkdir:async path=>{files.set(path,'');}};
 const plugin={core:{services,addOns:[],startupDatabaseOptions:{}},manifest:{id:'arcalink-sync'},pilotDirectory:'.obsidian/plugins/arcalink-sync',initializeCloudFeatures:async()=>{calls.push('shared-init');},
  app:{vault:{adapter,getFiles:()=>[]},plugins:{disablePlugin:async()=>calls.push('disable'),enablePlugin:async()=>calls.push('enable')}},
  unifiedVault:{saved:async()=>({workspaceId:identity.workspaceId,auth:{deviceId:'old-plugin'}})},workspaces:{session:async()=>({workspaceId:identity.workspaceId})},freeRelay:{session:async()=>null}};
 // Provide the real lifecycle registrar shape while preserving the callable upstream chain.
 services.appLifecycle.onSettingLoaded.addHandler=hooks.onSettingLoaded.addHandler.bind(hooks.onSettingLoaded);
 const owner=new CompanionOwnership(plugin);return {plugin,owner,services,settings,calls,files,identity,journal};
}

test('actual ownership startup gate runs after settings and before actual upstream database/scan/watch/replication while shared initialization survives',async()=>{
 for(const phase of ['preparing','held','committing','committed']){
  const f=fixture(phase);await f.owner.load();f.owner.attachBeforeStart();
  const main=new ModuleLiveSyncMain(f.plugin.core);
  assert.equal(await main._onLiveSyncLoad(),false,phase);
  assert.deepEqual(f.calls,['settings-loaded','shared-init'],phase);
  assert.equal(await f.services.replication.onBeforeReplicate.run(),false);
  if(phase==='committed'||phase==='committing'){
   assert.equal(f.settings.syncIgnoreRegEx,'^.*$');assert.equal(f.settings.additionalSuffixOfDatabaseName,'fresh');
   assert.equal(f.settings.P2P_Enabled,false);assert.equal(f.settings.activeConfigurationId,'');
  }
 }
 const main=await readFile(new URL('../plugin/main.ts',import.meta.url),'utf8');
 assert.ok(main.indexOf('await this.companionOwnership.load();')<main.indexOf('super.onload();'));
 assert.ok(main.indexOf('this.companionOwnership.attachBeforeStart();')<main.indexOf('super.onload();'));
});

test('an interrupted initial preparing journal without source coordinates can safely cancel and restart the original owner offline',async()=>{
 const f=fixture('preparing');await f.owner.load();f.owner.attachBeforeStart();
 assert.equal(await f.owner.cancel(),true);
 assert.equal(f.owner.state.phase,'cancelled');assert.equal(f.settings.additionalSuffixOfDatabaseName,'original');assert.equal(f.settings.liveSync,true);
 assert.equal(f.settings.syncIgnoreRegEx,'keep');assert.deepEqual(f.calls.slice(-2),['disable','enable']);
 const result=JSON.parse(f.files.get('.obsidian/plugins/arcalink-sync/companion/ownership-result.json'));
 assert.equal(result.phase,'cancelled');assert.equal(result.generation,f.identity.generation);
});

test('committing/committed authority cannot be cancelled and an identity change cannot restore source settings',async()=>{
 for(const phase of ['committing','committed']){const f=fixture(phase);await f.owner.load();f.owner.attachBeforeStart();assert.equal(await f.owner.cancel(),false);assert.deepEqual(f.calls,[]);}
 const f=fixture('held');await f.owner.load();f.owner.attachBeforeStart();f.settings.couchDB_DBNAME='different';
 assert.equal(await f.owner.cancel(),false);assert.equal(f.owner.state.phase,'held');assert.equal(f.settings.couchDB_DBNAME,'different');
 assert.equal(f.calls.includes('enable'),false);
});

test('a corrupt ownership journal fails closed before upstream database open and keeps shared init available',async()=>{
 const f=fixture();f.files.set('.obsidian/plugins/arcalink-sync/companion/ownership-state.json','partial {');await f.owner.load();f.owner.attachBeforeStart();
 assert.equal(await new ModuleLiveSyncMain(f.plugin.core)._onLiveSyncLoad(),false);assert.deepEqual(f.calls,['settings-loaded','shared-init']);
});

const {ownershipDigest,ownershipIdentity}=await import('../plugin/companion-ownership-model.mjs');
async function completeFixture(phase='committed'){
 const f=fixture(phase);await f.owner.load();
 Object.assign(f.owner.state,{mode:'cloud',peerId:'',publicKeyFingerprint:'f'.repeat(64),sequence:0,sourceName:'source',startedAt:1,records:[],engineFormat:{readChunksOnline:false},scope:{ordinary:true,excludedPrefixes:['ArcaLink Shared'],policyRevision:7,protectedRevision:'protected7'}});
 f.plugin.folders={records:[],entries:new Map(),queue:Promise.resolve()};
 f.services.replicator={onCloseActiveReplication:async()=>{f.calls.push('close-replication');}};
 const policy={enabled:true,revision:7,protected_revision:'protected7',phase:'ready',policy:{folders:[]},protected_folders:[]};
 f.plugin.folderPolicies={state:{revision:7,policy:{folders:[]}},protectedPaths:[],protectedRevision:'protected7',api:async()=>policy};
 f.plugin.workspaces.pendingMerge=async()=>null;f.plugin.workspaces.pendingMigration=async()=>null;
 const manifest=f.owner.heldManifest();f.owner.state.manifestDigest=await ownershipDigest(manifest);
 f.files.set(f.owner.directory+'/ownership-manifest.json',JSON.stringify(manifest));await f.owner.save();
 return {...f,policy,manifest};
}

test('scope refresh closes mutation admission durably, drains admitted mutations, unions roots and requires exact current seal before resume',async()=>{
 const f=await completeFixture(),scopeNonce='55555555-5555-4555-8555-555555555555';
 const request={...f.identity,manifestDigest:f.owner.state.manifestDigest,scopeNonce};
 assert.throws(()=>f.owner.assertSharedScopeChange());
 await f.owner.scopeRefresh({...request,phase:'scope-paused'});f.owner.assertSharedScopeChange();
 assert.equal(JSON.parse(f.files.get(f.owner.directory+'/ownership-scope.json')).phase,'scope-open');
 let finish;const gate=new Promise(resolve=>finish=resolve);
 const mutation=f.owner.sharedScopeMutation(async()=>{await gate;f.plugin.folders.records.push({mount:'New Shared'});});
 const seal=f.owner.scopeRefresh({...request,phase:'scope-seal'});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.owner.state.scopeWindow.status,'sealing');
 assert.equal(JSON.parse(f.files.get(f.owner.journalPath)).scopeWindow.status,'sealing');
 await assert.rejects(f.owner.sharedScopeMutation(async()=>{}));
 finish();await mutation;await seal;
 const sealed=JSON.parse(f.files.get(f.owner.directory+'/ownership-scope.json'));
 assert.equal(sealed.phase,'scope-sealed');assert.deepEqual(sealed.scope.excludedPrefixes,['ArcaLink Shared','New Shared']);
 const unsigned={...sealed};delete unsigned.sealDigest;assert.equal(sealed.sealDigest,await ownershipDigest(unsigned));
 const reopened=new CompanionOwnership(f.plugin);await reopened.load();assert.throws(()=>reopened.assertSharedScopeChange());
 await assert.rejects(reopened.scopeRefresh({...request,phase:'scope-ready',sealDigest:'0'.repeat(64)}));
 f.policy.revision=8;await assert.rejects(reopened.scopeRefresh({...request,phase:'scope-ready',sealDigest:sealed.sealDigest}));
 assert.equal(reopened.state.scopeWindow.status,'sealed');f.policy.revision=7;
 await reopened.scopeRefresh({...request,phase:'scope-ready',sealDigest:sealed.sealDigest});
 assert.equal(reopened.state.scopeWindow.status,'applied');assert.equal(reopened.state.original.additionalSuffixOfDatabaseName,'original');
 assert.equal(JSON.parse(f.files.get(f.owner.directory+'/ownership-scope.json')).phase,'scope-committed');
 assert.equal(reopened.acceptsSharedRoot('New Shared'),true);assert.throws(()=>reopened.assertSharedScopeChange());
 await reopened.scopeRefresh({...request,phase:'scope-ready',sealDigest:sealed.sealDigest}); // lost acknowledgement is idempotent
});

test('real coordinator commit survives interruption after each durable phase and never restores the original namespace',async()=>{
 for(const point of ['committing','settings','committed','result']){
  const f=await completeFixture('held');let stopped=false;
  const adapter=f.plugin.app.vault.adapter,write=adapter.write;
  adapter.write=async(path,text)=>{await write(path,text);const phase=JSON.parse(text).phase;
   if(!stopped&&(point==='committing'&&path===f.owner.journalPath&&phase==='committing'||point==='committed'&&path===f.owner.journalPath&&phase==='committed'||point==='result'&&path.endsWith('ownership-result.json'))){stopped=true;throw Error('simulated process interruption');}};
  const apply=f.services.setting.applyPartial;
  f.services.setting.applyPartial=async patch=>{await apply(patch);if(point==='settings'&&!stopped){stopped=true;throw Error('simulated process interruption');}};
  const bind=owner=>{owner.identity=async()=>({});owner.verifyDisk=async()=>{};owner.verifyPolicy=async()=>{};owner.engineFormat=async()=>owner.state.engineFormat;owner.openSource=async()=>({info:async()=>({update_seq:0})});};
  bind(f.owner);const ready={...f.identity,phase:'ready',manifestDigest:f.owner.state.manifestDigest};
  await assert.rejects(f.owner.commit(ready));assert.equal(stopped,true,point);
  const restarted=new CompanionOwnership(f.plugin);await restarted.load();restarted.attachBeforeStart();bind(restarted);
  assert.equal(restarted.blocksOrdinary,true,point);assert.equal(await restarted.cancel(),false,point);
  await restarted.commit(ready);assert.equal(restarted.state.phase,'committed');
  assert.equal(f.settings.syncIgnoreRegEx,'^.*$');assert.equal(f.settings.additionalSuffixOfDatabaseName,'fresh');
  assert.equal(restarted.state.original.additionalSuffixOfDatabaseName,'original');
  assert.equal(JSON.parse(f.files.get(restarted.directory+'/ownership-result.json')).manifestDigest,ready.manifestDigest);
 }
});

test('capability handshake is fresh public metadata and a matching native cancel request resumes only precommit ownership',async()=>{
 const f=fixture('preparing');await f.owner.load();
 const capability=JSON.parse(f.files.get(f.owner.directory+'/capabilities.json'));
 assert.deepEqual(Object.keys(capability).sort(),['generatedAt','ownership','schema','scopeRefresh']);assert.equal(capability.ownership,1);assert.equal(capability.scopeRefresh,1);
 f.files.set(f.owner.directory+'/ownership-request.json',JSON.stringify({...f.identity,phase:'cancel'}));await f.owner.tick();
 assert.equal(f.owner.state.phase,'cancelled');
 const c=fixture('committed');await c.owner.load();c.files.set(c.owner.directory+'/ownership-request.json',JSON.stringify({...c.identity,phase:'cancel'}));await c.owner.tick();assert.equal(c.owner.state.phase,'committed');
});
