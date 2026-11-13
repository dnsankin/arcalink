import {SETTING_KEY_P2P_DEVICE_NAME} from '@vrtmrz/livesync-commonlib/compat/common/types';
import {canonicalOwnership,ownershipDigest,ownershipIdentity,validOwnershipIdentity} from './companion-ownership-model.mjs';

const AUTO=['liveSync','periodicReplication','syncOnSave','syncOnEditorSave','syncOnStart','syncOnFileOpen','syncAfterMerge'];
const INTERNAL=['syncInternalFiles','watchInternalFileChanges','syncInternalFilesBeforeReplication','usePluginSync'];
const P2P=['P2P_Enabled','P2P_AutoStart','P2P_AutoBroadcast'];
const BOOLEANS=[...AUTO,...INTERNAL,...P2P,'suspendFileWatching','suspendParseReplicationResult','handleFilenameCaseSensitive'];
const STRINGS=['syncIgnoreRegEx','syncOnlyRegEx','additionalSuffixOfDatabaseName','activeConfigurationId','P2P_ActiveRemoteConfigurationId','P2P_AutoSyncPeers','P2P_AutoWatchPeers'];
const NUMBERS=['P2P_AutoAccepting','syncInternalFilesInterval'];
const PHASES=['preparing','held','committing','committed'];
const COMMITTED_KEYS=[...AUTO,...INTERNAL,...P2P,'syncIgnoreRegEx','suspendFileWatching','suspendParseReplicationResult','syncInternalFilesInterval','P2P_AutoSyncPeers','P2P_AutoWatchPeers','P2P_AutoAccepting','activeConfigurationId','P2P_ActiveRemoteConfigurationId','additionalSuffixOfDatabaseName'];
const MAX_JOURNAL=8*1024*1024;
const RECOVERY='plugin-authority-recovered.json';
const uuid=(value:any)=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

/** The plugin always owns ordinary sync. Only recover settings left by the retired handoff. */
export class CompanionOwnership {
 state:any=null;error='';holding=false;busy=false;
 preparationDiagnostic='Синхронизацией хранилища управляет плагин. Компаньон подключается отдельно для самостоятельных действий.';
 private disposed=false;private attached=false;private recovery:Promise<void>|null=null;
 constructor(private plugin:any){}
 get directory(){return this.plugin.pilotDirectory+'/companion';}
 get journalPath(){return this.directory+'/ownership-state.json';}
 get blocksOrdinary(){return false;}
 get committed(){return false;}
 get defersAssistantPoll(){return false;}
 assertSharedScopeChange(){}
 async sharedScopeMutation<T>(action:()=>Promise<T>):Promise<T>{return action();}
 acceptsSharedRoot(_path:string){return true;}
 private adapter(){return this.plugin.app.vault.adapter;}
 private async read(name:string,max=16384){
  const path=this.directory+'/'+name,stat=await this.adapter().stat(path);
  if(!stat)return null;
  if(stat.type!=='file'||stat.size>max)throw Error('Invalid retired ownership metadata');
  const text=await this.adapter().read(path);
  if(new TextEncoder().encode(text).length>max)throw Error('Invalid retired ownership metadata');
  return JSON.parse(text);
 }
 private async write(name:string,value:any){
  let path='';for(const part of this.directory.split('/')){path=path?path+'/'+part:part;if(!await this.adapter().exists(path))await this.adapter().mkdir(path);}
  const text=canonicalOwnership(value),file=this.directory+'/'+name;
  await this.adapter().write(file,text);
  if(await this.adapter().read(file)!==text)throw Error('Retired ownership metadata write not verified');
 }
 private validJournal(state:any){
  if(!state||!validOwnershipIdentity(state)||!PHASES.includes(state.phase)||!uuid(state.pluginDeviceId)
   ||typeof state.remoteDatabase!=='string'||state.quarantineSuffix!=='companion-'+state.generation.replace(/-/g,'')
   ||!state.original||typeof state.original!=='object'||Array.isArray(state.original)
   ||typeof state.original.additionalSuffixOfDatabaseName!=='string')return false;
  const required=state.phase==='committing'||state.phase==='committed'?COMMITTED_KEYS:['suspendFileWatching','suspendParseReplicationResult','additionalSuffixOfDatabaseName'];
  if(required.some(key=>!Object.prototype.hasOwnProperty.call(state.original,key)))return false;
  return Object.entries(state.original).every(([key,value])=>BOOLEANS.includes(key)?typeof value==='boolean':STRINGS.includes(key)?typeof value==='string':NUMBERS.includes(key)?typeof value==='number'&&Number.isFinite(value)&&value>=0:false);
 }
 async load({publish=true}:{publish?:boolean}={}){
  try{
   const state=await this.read('ownership-state.json',MAX_JOURNAL);
   if(state?.phase==='cancelled')return;
   if(state&&!this.validJournal(state))throw Error('Invalid retired ownership metadata');
   this.state=state;
  }catch{this.preparationDiagnostic='Прежнее состояние подключения не используется. Обычной синхронизацией управляет плагин.';}
  finally{if(publish)try{await this.publishStartupCapabilities();}catch{/* Optional local metadata never gates sync. */}}
 }
 async retainedVaultId(){
  try{const value=await this.read('automatic-binding.json');return value?.schema===1&&uuid(value.localVaultId)?value.localVaultId:'';}
  catch{return '';}
 }
 async publishStartupCapabilities(){
  let localVaultId=await this.retainedVaultId();
  if(!localVaultId&&!await this.adapter().exists(this.directory+'/automatic-binding.json')){
   localVaultId=crypto.randomUUID();await this.write('automatic-binding.json',{schema:1,localVaultId});
  }
  // Replace any stale ownership:1 advertisement; independent actions publish their own capabilities.
  await this.write('capabilities.json',{schema:1,ownership:0,scopeRefresh:0,localSnapshot:0,automatic:0,...(localVaultId?{localVaultId}:{}),generatedAt:Date.now()});
 }
 attachBeforeStart(){
  if(this.attached)return;this.attached=true;
  this.plugin.core.services.appLifecycle.onSettingLoaded.addHandler(async()=>{
   if(!this.disposed){this.recovery??=this.restorePreviousSettings();await this.recovery;}
   return true;
  },-10000);
 }
 private async restorePreviousSettings(){
  const state=this.state;if(!state)return;
  try{
   const digest=await ownershipDigest({kind:'plugin-authority-recovery-v1',identity:ownershipIdentity(state),pluginDeviceId:state.pluginDeviceId,
    remoteDatabase:state.remoteDatabase,quarantineSuffix:state.quarantineSuffix,original:state.original});
   let previous:any;try{previous=await this.read(RECOVERY);}catch{/* A torn completion marker is retryable; the source journal is unchanged. */}
   if(previous?.schema===1&&previous.journalDigest===digest){this.state=null;return;}
   const p=this.plugin,s=p.core.services,settings=s.setting.currentSettings();
   await p.freeRelay.sessionWrites;
   const saved=await p.unifiedVault.saved(),bound=await p.workspaces.session(),session=await p.freeRelay.session()||saved?.auth;
   if(s.setting.currentSettings()!==settings||(saved?.workspaceId||bound?.workspaceId)!==state.workspaceId||session?.deviceId!==state.pluginDeviceId
    ||(settings.couchDB_DBNAME||'')!==state.remoteDatabase
    ||![state.original.additionalSuffixOfDatabaseName,state.quarantineSuffix].includes(settings.additionalSuffixOfDatabaseName||'')){
    this.preparationDiagnostic='Прежняя запись относится к другому подключению и не меняет настройки плагина.';return;
   }
   const guard:Record<string,any>=state.phase==='preparing'||state.phase==='held'
    ?{suspendFileWatching:true,suspendParseReplicationResult:true}
    :{...Object.fromEntries([...AUTO,...INTERNAL,...P2P].map(key=>[key,false])),syncIgnoreRegEx:'^.*$',suspendFileWatching:true,
      suspendParseReplicationResult:true,syncInternalFilesInterval:0,P2P_AutoSyncPeers:'',P2P_AutoWatchPeers:'',P2P_AutoAccepting:0,
      activeConfigurationId:'',P2P_ActiveRemoteConfigurationId:'',additionalSuffixOfDatabaseName:state.quarantineSuffix};
   if(Object.entries(state.original).some(([key,value])=>settings[key]!==value&&(!Object.prototype.hasOwnProperty.call(guard,key)||settings[key]!==guard[key]))){
    this.preparationDiagnostic='Настройки уже изменились после прежнего подключения. Они сохранены без автоматического отката.';return;
   }
   const patch={...state.original};
   const changedSuffix=(settings.additionalSuffixOfDatabaseName||'')!==state.original.additionalSuffixOfDatabaseName;
   let priorDeviceName:string|undefined;
   if(changedSuffix){
    // SettingService saves this in-memory field into the selected suffix namespace before saving data.json.
    const api=s.setting;if(typeof api.getDeviceLocalConfig!=='function'||typeof api.setDeviceAndVaultName!=='function'
     ||typeof api.getDeviceAndVaultName!=='function'||typeof s.API.getSystemVaultName!=='function')throw Error('Local settings unavailable');
    const vault=s.API.getSystemVaultName(),suffix='-'+state.original.additionalSuffixOfDatabaseName;
    const sourceName=api.getDeviceLocalConfig('obsidian-live-sync-vaultanddevicename-'+vault+suffix);
    const sourcePeer=api.getDeviceLocalConfig(vault+suffix+'-'+SETTING_KEY_P2P_DEVICE_NAME);
    if(sourceName!=null&&typeof sourceName!=='string'||sourcePeer!=null&&typeof sourcePeer!=='string')throw Error('Local settings invalid');
    priorDeviceName=api.getDeviceAndVaultName();api.setDeviceAndVaultName(sourceName||'');
    patch.P2P_DevicePeerName=sourcePeer||'';
   }
   try{
    await s.setting.applyPartial(patch,true);
    const persisted=await p.loadData();
    if(Object.entries(state.original).some(([key,value])=>s.setting.currentSettings()[key]!==value||persisted?.[key]!==value))throw Error('Settings recovery not verified');
   }catch(problem){
    if(priorDeviceName!==undefined&&(s.setting.currentSettings().additionalSuffixOfDatabaseName||'')===(settings.additionalSuffixOfDatabaseName||''))s.setting.setDeviceAndVaultName(priorDeviceName);
    throw problem;
   }
   // Settings must be durable first. Keep the original journal intact even if this marker write is interrupted.
   await this.write(RECOVERY,{schema:1,journalDigest:digest});
   this.state=null;this.preparationDiagnostic='Прежняя передача управления отменена. Синхронизацией хранилища управляет плагин.';
  }catch{this.preparationDiagnostic='Не удалось завершить сохранение прежних настроек. Владение синхронизацией Компаньону не передаётся.';}
 }
 dispose(){this.disposed=true;}
}
