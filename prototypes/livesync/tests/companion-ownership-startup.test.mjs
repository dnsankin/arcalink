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
  obsidian:'export class Notice {} export class Modal {} export class Setting {} export const Platform={isAndroidApp:false}; export async function requestUrl(){throw Error("Network forbidden");}',
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
const {DEFAULT_SETTINGS,SETTING_KEY_P2P_DEVICE_NAME}=await import(new URL('node_modules/@vrtmrz/livesync-commonlib/dist/common/types.js',source));
const {SettingService}=await import(new URL('node_modules/@vrtmrz/livesync-commonlib/dist/services/base/SettingService.js',source));
const {ServiceContext}=await import(new URL('node_modules/@vrtmrz/livesync-commonlib/dist/services/base/ServiceBase.js',source));
const bools=['liveSync','periodicReplication','syncOnSave','syncOnEditorSave','syncOnStart','syncOnFileOpen','syncAfterMerge','syncInternalFiles','watchInternalFileChanges','syncInternalFilesBeforeReplication','usePluginSync','P2P_Enabled','P2P_AutoStart','P2P_AutoBroadcast','suspendFileWatching','suspendParseReplicationResult','handleFilenameCaseSensitive'];
const strings=['syncIgnoreRegEx','syncOnlyRegEx','additionalSuffixOfDatabaseName','activeConfigurationId','P2P_ActiveRemoteConfigurationId','P2P_AutoSyncPeers','P2P_AutoWatchPeers'];
const marker='.obsidian/plugins/arcalink-sync/companion/plugin-authority-recovered.json';
function fixture(phase=null){
 const calls=[],files=new Map(),local=new Map();
 const identity={schema:1,nonce:'11111111-1111-4111-8111-111111111111',generation:'22222222-2222-4222-8222-222222222222',accountId:'33333333-3333-4333-8333-333333333333',companionDeviceId:'44444444-4444-4444-8444-444444444444',workspaceId:'a'.repeat(32)};
 const settings={...structuredClone(DEFAULT_SETTINGS),isConfigured:true,liveSync:true,additionalSuffixOfDatabaseName:'original',couchDB_DBNAME:'remote',syncIgnoreRegEx:'keep',activeConfigurationId:'source-config',encrypt:false,idDerivationVersion:0,P2P_DevicePeerName:''};
 const original={...Object.fromEntries(bools.map(key=>[key,!!settings[key]])),...Object.fromEntries(strings.map(key=>[key,settings[key]||''])),P2P_AutoAccepting:0,syncInternalFilesInterval:0};
 Object.assign(settings,original);
 const journal={...identity,phase,original,quarantineSuffix:'companion-'+identity.generation.replace(/-/g,''),pluginDeviceId:'55555555-5555-4555-8555-555555555555',remoteDatabase:'remote'};
 if(phase==='committing'||phase==='committed')Object.assign(settings,Object.fromEntries(bools.filter(key=>key!=='handleFilenameCaseSensitive').map(key=>[key,false])),{syncIgnoreRegEx:'^.*$',suspendFileWatching:true,suspendParseReplicationResult:true,activeConfigurationId:'',P2P_ActiveRemoteConfigurationId:'',P2P_AutoSyncPeers:'',P2P_AutoWatchPeers:'',P2P_AutoAccepting:0,syncInternalFilesInterval:0,additionalSuffixOfDatabaseName:journal.quarantineSuffix});
 else if(phase)Object.assign(settings,{suspendFileWatching:true,suspendParseReplicationResult:true});
 let persisted=structuredClone(settings),deviceName='quarantine-device';
 const hooks={onSettingLoaded:new Chain(),onBeforeReplicate:new Chain(),onBeforeSaveSettingData:new Chain()};
 const services={API:{getSystemVaultName:()=> 'FixtureVault',addLog:()=>{}},context:{events:{}},
  appLifecycle:{onSettingLoaded:()=>hooks.onSettingLoaded.run(),onWireUpEvents:async()=>true,onInitialise:async()=>true,onLoaded:async()=>{calls.push('ordinary-loaded');},onLayoutReady:async()=>true,isReady:()=>true,onFirstInitialise:async()=>{calls.push('watch');return true;},onResumed:new Chain(),onScanningStartupIssues:async()=>true},
  setting:{currentSettings:()=>settings,loadSettings:async()=>calls.push('settings-loaded'),onBeforeSaveSettingData:hooks.onBeforeSaveSettingData,
   applyPartial:async patch=>{Object.assign(settings,patch);persisted=structuredClone(settings);calls.push('settings-saved');},getDeviceLocalConfig:key=>local.get(key),getDeviceAndVaultName:()=>deviceName,setDeviceAndVaultName:value=>{deviceName=value;}},
  database:{openDatabase:async()=>{calls.push('database-open');},isDatabaseReady:()=>false},replication:{onBeforeReplicate:hooks.onBeforeReplicate,replicate:async()=>{calls.push('replicate');return true;}},
  replicator:{onCloseActiveReplication:async()=>{throw Error('No direct replication management');}},control:{applySettings:async()=>{calls.push('settings-applied');},onReady:async()=>{calls.push('ready');return true;}},databaseEvents:{initialiseDatabase:async()=>{calls.push('scan');return true;}}};
 const adapter={exists:async path=>files.has(path),stat:async path=>files.has(path)?{type:'file',size:files.get(path).length}:null,read:async path=>files.get(path),write:async(path,text)=>{files.set(path,text);},mkdir:async path=>{files.set(path,'');}};
 const plugin={core:{services,addOns:[],startupDatabaseOptions:{}},manifest:{id:'arcalink-sync'},pilotDirectory:'.obsidian/plugins/arcalink-sync',app:{vault:{adapter}},loadData:async()=>structuredClone(persisted),unifiedVault:{saved:async()=>({workspaceId:identity.workspaceId,auth:{deviceId:'55555555-5555-4555-8555-555555555555'}})},workspaces:{session:async()=>({workspaceId:identity.workspaceId})},freeRelay:{session:async()=>null}};
 services.appLifecycle.onSettingLoaded.addHandler=hooks.onSettingLoaded.addHandler.bind(hooks.onSettingLoaded);
 const owner=new CompanionOwnership(plugin);if(phase)files.set(owner.journalPath,JSON.stringify(journal));
 return {owner,plugin,services,settings,calls,files,local,journal,original,hooks,persisted:()=>persisted,setPersisted:value=>{persisted=structuredClone(value);}};
}
async function startup(f,ready=true){
 await f.owner.load({publish:false});f.owner.attachBeforeStart();
 const main=new ModuleLiveSyncMain(f.plugin.core);assert.equal(await main._onLiveSyncLoad(),true);if(ready)await main._onLiveSyncReady();
 assert.equal(await f.services.replication.onBeforeReplicate.run(),true);await f.services.replication.replicate();
 for(const call of (ready?['database-open','ordinary-loaded','scan','watch','replicate']:['database-open','ordinary-loaded','replicate']))assert.ok(f.calls.includes(call),call);
 assert.equal(f.owner.blocksOrdinary,false);return main;
}
test('fresh plugin without Companion ignores even an authenticated-looking stale handoff request',async()=>{
 for(const request of [null,{schema:1,phase:'prepare',automatic:{localSnapshot:1}},'{partial']){
  const f=fixture(),path=f.owner.directory+'/ownership-request.json',replicate=f.services.replication.replicate;
  if(request)f.files.set(path,typeof request==='string'?request:JSON.stringify({...f.journal,...request}));
  const before=f.files.get(path);await startup(f);
  assert.equal(f.services.replication.replicate,replicate);assert.equal(f.hooks.onBeforeReplicate.handlers.length,0);assert.equal(f.hooks.onBeforeSaveSettingData.handlers.length,0);
  assert.equal(f.files.get(path),before);assert.equal(f.files.has(f.owner.journalPath),false);assert.equal(f.calls.includes('settings-saved'),false);
 }
});
for(const phase of ['preparing','held','committing','committed'])test(phase+' recovery restores original settings before the real upstream opens its database',async()=>{
 const f=fixture(phase),journal=f.files.get(f.owner.journalPath);await startup(f);
 for(const [key,value]of Object.entries(f.original))assert.equal(f.settings[key],value,key);
 assert.ok(f.calls.indexOf('settings-saved')<f.calls.indexOf('database-open'));
 assert.equal(f.calls.filter(call=>call==='database-open').length,1);assert.equal(f.files.get(f.owner.journalPath),journal);assert.equal(JSON.parse(f.files.get(marker)).schema,1);
 // A completed recovery cannot reset later user changes on the next launch.
 f.settings.liveSync=false;f.setPersisted(f.settings);f.owner=new CompanionOwnership(f.plugin);await f.owner.load({publish:false});f.owner.attachBeforeStart();await f.hooks.onSettingLoaded.run();assert.equal(f.settings.liveSync,false);
});
test('invalid, partial, oversized and foreign records preserve settings and source bytes without gating startup',async()=>{
 const variations=[f=>f.files.set(f.owner.journalPath,'{partial'),f=>f.files.set(f.owner.journalPath,' '.repeat(8*1024*1024+1)),f=>f.journal.original={additionalSuffixOfDatabaseName:'original'},f=>f.journal.original.liveSync='yes',f=>f.journal.original.couchDB_PASSWORD='never restore',f=>f.journal.workspaceId='b'.repeat(32),f=>f.journal.pluginDeviceId='66666666-6666-4666-8666-666666666666',f=>f.journal.remoteDatabase='another',f=>f.journal.quarantineSuffix='arbitrary'];
 for(const change of variations){const f=fixture('committed');Object.assign(f.settings,f.original);change(f);if(!f.files.get(f.owner.journalPath).startsWith('{partial')&&!f.files.get(f.owner.journalPath).startsWith(' '))f.files.set(f.owner.journalPath,JSON.stringify(f.journal));
  const before=structuredClone(f.settings),bytes=f.files.get(f.owner.journalPath);await startup(f);assert.deepEqual(f.settings,before);assert.equal(f.files.get(f.owner.journalPath),bytes);assert.equal(f.files.has(marker),false);assert.equal(f.calls.includes('settings-saved'),false);}
});
test('same binding with changed user settings is never rolled back or marked recovered',async()=>{
 for(const key of ['activeConfigurationId','syncIgnoreRegEx','syncOnlyRegEx']){const f=fixture('committed');f.settings[key]='user-new-value';const before=structuredClone(f.settings);await startup(f,false);assert.deepEqual(f.settings,before);assert.equal(f.files.has(marker),false);}
 const f=fixture('held');f.settings.liveSync=false;await startup(f,false);assert.equal(f.settings.liveSync,false);assert.equal(f.files.has(marker),false);
});
test('a failed or torn completion marker never destroys the source journal and retries on a later launch',async()=>{
 for(const torn of [false,true]){const f=fixture('committed'),bytes=f.files.get(f.owner.journalPath),write=f.plugin.app.vault.adapter.write;
  f.plugin.app.vault.adapter.write=async(path,text)=>{if(path===marker){if(torn)f.files.set(path,'{partial');throw Error('fixture interrupted marker');}return write(path,text);};
  await startup(f);assert.equal(f.files.get(f.owner.journalPath),bytes);assert.equal(f.persisted().additionalSuffixOfDatabaseName,'original');
  f.plugin.app.vault.adapter.write=write;f.owner=new CompanionOwnership(f.plugin);await f.owner.load({publish:false});f.owner.attachBeforeStart();await f.hooks.onSettingLoaded.run();assert.equal(JSON.parse(f.files.get(marker)).schema,1);assert.equal(f.files.get(f.owner.journalPath),bytes);
 }
});
test('memory-only settings save cannot create a completion marker',async()=>{
 const f=fixture('committed');f.services.setting.applyPartial=async patch=>{Object.assign(f.settings,patch);};await startup(f);assert.equal(f.files.has(marker),false);
 f.services.setting.applyPartial=async patch=>{Object.assign(f.settings,patch);f.setPersisted(f.settings);};f.owner=new CompanionOwnership(f.plugin);await f.owner.load({publish:false});f.owner.attachBeforeStart();await f.hooks.onSettingLoaded.run();assert.equal(JSON.parse(f.files.get(marker)).schema,1);
});
test('passive capabilities retire stale ownership advertisement without changing the retained vault identity',async()=>{
 const f=fixture(),id=crypto.randomUUID();f.files.set(f.owner.directory+'/automatic-binding.json',JSON.stringify({schema:1,localVaultId:id}));f.files.set(f.owner.directory+'/capabilities.json',JSON.stringify({ownership:1,automatic:1}));
 await f.owner.publishStartupCapabilities();const cap=JSON.parse(f.files.get(f.owner.directory+'/capabilities.json'));assert.equal(cap.localVaultId,id);for(const key of ['ownership','automatic','scopeRefresh','localSnapshot'])assert.equal(cap[key],0);assert.equal(await f.owner.retainedVaultId(),id);
});
test('actual SettingService keeps source and quarantine device/P2P names in their own namespaces',async()=>{
 const f=fixture('committed'),real=new SettingService(new ServiceContext(),{APIService:f.services.API});let persisted=structuredClone(f.settings);
 real._log=()=>{};real.settings=structuredClone(f.settings);real.getItem=key=>f.local.get(key);real.setItem=(key,value)=>f.local.set(key,value);real.deleteItem=key=>f.local.delete(key);real.loadData=async()=>structuredClone(persisted);real.saveData=async value=>{persisted=structuredClone(value);f.calls.push('settings-saved');};real.getPassphrase=async()=>false;
 const sourceDevice='obsidian-live-sync-vaultanddevicename-FixtureVault-original',quarantineDevice='obsidian-live-sync-vaultanddevicename-FixtureVault-'+f.journal.quarantineSuffix;
 const sourcePeer='FixtureVault-original-'+SETTING_KEY_P2P_DEVICE_NAME,quarantinePeer='FixtureVault-'+f.journal.quarantineSuffix+'-'+SETTING_KEY_P2P_DEVICE_NAME;
 f.local.set(sourceDevice,'source-device');f.local.set(quarantineDevice,'quarantine-device');f.local.set(sourcePeer,'source-peer');f.local.set(quarantinePeer,'quarantine-peer');
 real.setDeviceAndVaultName('quarantine-device');real.settings.P2P_DevicePeerName='quarantine-peer';real.loadSettings=async()=>f.calls.push('settings-loaded');
 f.services.setting=real;f.plugin.loadData=async()=>structuredClone(persisted);await startup(f);
 assert.equal(real.getDeviceAndVaultName(),'source-device');assert.equal(f.local.get(sourceDevice),'source-device');assert.equal(f.local.get(sourcePeer),'source-peer');assert.equal(f.local.get(quarantineDevice),'quarantine-device');assert.equal(f.local.get(quarantinePeer),'quarantine-peer');assert.equal(real.currentSettings().additionalSuffixOfDatabaseName,'original');assert.ok(f.files.has(marker));
});

test('settings replaced during binding reads cannot receive an old recovery patch',async()=>{
 const f=fixture('committed'),replacement={...f.settings,couchDB_DBNAME:'new-remote'};
 const saved=f.plugin.unifiedVault.saved;f.plugin.unifiedVault.saved=async()=>{f.services.setting.currentSettings=()=>replacement;return saved();};
 await f.owner.load({publish:false});f.owner.attachBeforeStart();await f.hooks.onSettingLoaded.run();
 assert.equal(replacement.couchDB_DBNAME,'new-remote');assert.equal(f.calls.includes('settings-saved'),false);assert.equal(f.files.has(marker),false);
});
