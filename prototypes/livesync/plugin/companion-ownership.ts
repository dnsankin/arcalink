import {Modal,Notice,Setting,requestUrl} from 'obsidian';
import {REMOTE_RESOURCE_KINDS} from '@vrtmrz/livesync-commonlib/replication';
import {getFileRegExp} from '@vrtmrz/livesync-commonlib/compat/common/utils';
import {configuredIdKey} from '@vrtmrz/livesync-commonlib/settings';
import {isAcceptedAll} from '@vrtmrz/livesync-commonlib/compat/string_and_binary/path';
import {isFreeRelayConnection} from './free-relay-settings.mjs';
import {folderContains} from './folder-exclusions.mjs';
import {safeCompanionPath,sha256} from './companion-proof.mjs';
import {waitForReplicationDrain} from './replication-drain.mjs';
import {keyTransferComparison,sealCompanionIdKey} from './companion-key-transfer.mjs';
import {OWNERSHIP_FORMAT_FIELDS,assertOwnershipManifest,canonicalOwnership,ownershipDigest,ownershipIdentity,sameOwnershipIdentity,ownershipReadyMatches,proveOwnershipPage,validOwnershipIdentity} from './companion-ownership-model.mjs';

const AUTO=['liveSync','periodicReplication','syncOnSave','syncOnEditorSave','syncOnStart','syncOnFileOpen','syncAfterMerge'];
const INTERNAL=['syncInternalFiles','watchInternalFileChanges','syncInternalFilesBeforeReplication','usePluginSync'];
const P2P=['P2P_Enabled','P2P_AutoStart','P2P_AutoBroadcast'];
const ORIGINAL=[...AUTO,...INTERNAL,...P2P,'suspendFileWatching','suspendParseReplicationResult','syncIgnoreRegEx','syncOnlyRegEx','handleFilenameCaseSensitive','additionalSuffixOfDatabaseName','activeConfigurationId','P2P_ActiveRemoteConfigurationId','P2P_AutoSyncPeers','P2P_AutoWatchPeers','P2P_AutoAccepting','syncInternalFilesInterval'];
const BLOCKING=new Set(['preparing','held','committing','committed']);
const fail=(code='ownership-unavailable')=>Object.assign(Error('Не удалось передать синхронизацию Компаньону. Файлы и прежняя база сохранены.'),{code});
const same=(a:any,b:any)=>canonicalOwnership(a)===canonicalOwnership(b);
const MAX_MANIFEST=8*1024*1024;

/** One ordinary sync owner. Shared CRDT registries and their existing authenticated APIs are retained. */
export class CompanionOwnership {
 state:any=null;error='';holding=false;busy=false;disposed=false;dialogNonce='';
 private writes:Promise<any>=Promise.resolve();private controller:AbortController|null=null;
 private scopeMutations=new Set<Promise<void>>();
 private source:any=null;private sourceOwned=false;private startupAttached=false;private corrupt=false;private cancelling=false;
 constructor(private plugin:any){}
 get directory(){return this.plugin.pilotDirectory+'/companion';}
 get journalPath(){return this.directory+'/ownership-state.json';}
 get blocksOrdinary(){return this.corrupt||BLOCKING.has(this.state?.phase);}
 get committed(){return this.state?.phase==='committed';}
 assertSharedScopeChange(){
  if(this.blocksOrdinary&&!(this.committed&&this.state.scopeWindow?.status==='open'))throw Error('Приостановите Компаньон для изменения общих папок, затем примените изменения на его экране. Редактирование подключённых общих папок доступно.');
 }
 async sharedScopeMutation<T>(action:()=>Promise<T>):Promise<T>{
  this.assertSharedScopeChange();let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});this.scopeMutations.add(pending);
  try{return await action();}finally{release();this.scopeMutations.delete(pending);}
 }
 acceptsSharedRoot(path:string){return !this.blocksOrdinary||!!this.state?.scope?.excludedPrefixes?.includes(path)
  ||this.committed&&(this.state.scopeWindow?.status==='open'||this.state.scopeWindow?.status==='sealing'&&this.scopeMutations.size>0);}
 private async publishCapabilities(){await this.write('capabilities.json',{schema:1,ownership:1,scopeRefresh:1,generatedAt:Date.now()});}
 private adapter(){return this.plugin.app.vault.adapter;}
 async load(){
  try{await this.publishCapabilities();}catch{}
  try{
   if(!await this.adapter().exists(this.journalPath))return;
   const state=await this.read('ownership-state.json',MAX_MANIFEST);
   if(!state||!validOwnershipIdentity(state)||!['preparing','held','committing','committed','cancelled'].includes(state.phase)
    ||!state.original||!state.quarantineSuffix||Object.keys(state.original).some(key=>!ORIGINAL.includes(key)))throw fail();
   this.state=state;this.holding=BLOCKING.has(state.phase);
  }catch{this.error=fail().message;this.holding=true;this.corrupt=true;}
 }
 /** Install immediately after load(), before upstream onload is allowed to run. */
 attachBeforeStart(){
  if(this.startupAttached)return;this.startupAttached=true;
  const s=this.plugin.core.services;
  s.appLifecycle.onSettingLoaded.addHandler(async()=>{
   if(!this.blocksOrdinary)return true;
   if(this.committed||this.state?.phase==='committing')Object.assign(s.setting.currentSettings(),this.guards());
   // Returning false exits ModuleLiveSyncMain before openDatabase and all ordinary startup hooks.
   // Existing Yjs providers require loaded settings, but do not need the ordinary LiveSync database.
   await this.plugin.initializeCloudFeatures();return false;
  },-10000);
  s.replication.onBeforeReplicate.addHandler(async()=>!this.blocksOrdinary,-10000);
  s.setting.onBeforeSaveSettingData.addHandler(async()=>this.committed||this.state?.phase==='committing'?this.guards():{},-10000);
  const replicate=s.replication.replicate.bind(s.replication);
  s.replication.replicate=(...args:any[])=>this.committed?Promise.resolve(this.requestNativeSync()):this.blocksOrdinary?Promise.resolve(false):replicate(...args);
 }
 private guards(){
  return {...Object.fromEntries([...AUTO,...INTERNAL,...P2P].map(key=>[key,false])),
   syncIgnoreRegEx:'^.*$',suspendFileWatching:true,suspendParseReplicationResult:true,syncInternalFilesInterval:0,
   P2P_AutoSyncPeers:'',P2P_AutoWatchPeers:'',P2P_AutoAccepting:0,activeConfigurationId:'',P2P_ActiveRemoteConfigurationId:'',
   additionalSuffixOfDatabaseName:this.state.quarantineSuffix};
 }
 private async ensureDirectory(){
  let path='';for(const part of this.directory.split('/')){path=path?path+'/'+part:part;if(!await this.adapter().exists(path))await this.adapter().mkdir(path);}
 }
 private async read(name:string,max=16384){
  const path=this.directory+'/'+name,stat=await this.adapter().stat(path);
  if(!stat||stat.type!=='file'||stat.size>max)return null;
  const text=await this.adapter().read(path);if(text.length>max)return null;return JSON.parse(text);
 }
 private write(name:string,value:any){
  const text=canonicalOwnership(value);
  if(new TextEncoder().encode(text).length>MAX_MANIFEST)throw fail('ownership-manifest-too-large');
  // Keep the authoritative journal path present during replacement. A torn JSON journal fails closed at load().
  const operation=this.writes.then(async()=>{await this.ensureDirectory();await this.adapter().write(this.directory+'/'+name,text);});
  this.writes=operation.catch(()=>{});return operation;
 }
 private async save(){await this.write('ownership-state.json',this.state);}
 private async identity(request:any){
  const p=this.plugin,s=p.core.services.setting.currentSettings(),saved=await p.unifiedVault.saved(),bound=await p.workspaces.session();
  if(!validOwnershipIdentity(request)||!s.isConfigured||(saved?.workspaceId||bound.workspaceId)!==request.workspaceId)throw fail('ownership-binding-changed');
  let session=await p.freeRelay.session()||saved?.auth;
  if(!session?.accessToken)throw fail('ownership-sign-in-required');
  const send=()=>requestUrl({url:'https://arcalink.ru/auth/me',headers:{Authorization:'Bearer '+session.accessToken},throw:false});
  let response=await send();if(response.status===401&&session.refreshToken){session=await p.freeRelay.refresh({...session,group:session.group||request.workspaceId});response=await send();}
  if(response.status!==200||response.json?.user?.id!==request.accountId||response.json?.device?.id!==session.deviceId
   ||session.deviceId===request.companionDeviceId)throw fail('ownership-binding-changed');
  return {session,settings:s};
 }
 private async idle(){
  const p=this.plugin,f=p.folderPolicies;
  if(p.workspaces.busy||await p.workspaces.pendingMerge()||await p.workspaces.pendingMigration()
   ||f.operation||f.remoteOperation||f.previewing||f.loading||f.reloading||f.cancelling||f.holding
   ||[...p.folders.entries.values()].some((entry:any)=>entry.rescanning)||p.mobileAssistant?.isBusy?.())throw fail('ownership-operation-busy');
 }
 private scope(settings:any){
  const p=this.plugin,policy=p.folderPolicies.state;
  return {ordinary:true,excludedPrefixes:[...new Set(['ArcaLink Shared',...(p.folderPolicies.protectedPaths||[]),...(p.folders.records||[]).map((r:any)=>r.mount),...(policy?.policy?.folders||[])])].sort(),
   localIgnoreRegEx:settings.syncIgnoreRegEx||'',localOnlyRegEx:settings.syncOnlyRegEx||'',caseSensitive:!!settings.handleFilenameCaseSensitive,
   policyRevision:policy?.revision||0,protectedRevision:p.folderPolicies.protectedRevision||''};
 }
 private async ordinary(path:string){
  if(!safeCompanionPath(path)||this.state.scope.excludedPrefixes.some((root:string)=>folderContains(root,path,false)))return false;
  const scope=this.state.scope;
  const settings:any={syncIgnoreRegEx:scope.localIgnoreRegEx,syncOnlyRegEx:scope.localOnlyRegEx,handleFilenameCaseSensitive:scope.caseSensitive};
  const only=getFileRegExp(settings,'syncOnlyRegEx'),ignored=getFileRegExp(settings,'syncIgnoreRegEx');
  if((only.length&&!only.some(rule=>rule.test(path)))||ignored.some(rule=>rule.test(path)))return false;
  if(!this.state.engineFormat?.useIgnoreFiles)return true;
  const names=String(this.state.engineFormat.ignoreFiles||'.gitignore').split(',').map((value:string)=>value.trim()).filter(Boolean);
  if(names.some((name:string)=>name.includes('/')||name.includes('\\')||name==='.'||name==='..'||name.includes(':')))throw fail('ownership-ignore-format');
  return isAcceptedAll(path as any,names,async(filename:string)=>{
   const name=filename.replace(/^\//,''),entry=await this.ignoreFile(name);
   const known=this.state.scope.ignoreFileBases.find((base:any)=>base.path===name);
   if(known&&known.sha256!==entry.sha256||!known&&this.state.phase!=='preparing')throw fail('ownership-ignore-changed');
   if(!known)this.state.scope.ignoreFileBases.push({path:name,sha256:entry.sha256});
   return entry.lines;
  });
 }
 private async ignoreFile(path:string):Promise<{sha256:string|null;lines:string[]|false}>{
  if(!path||path.split('/').some(part=>!part||part==='.'||part==='..'||part==='.obsidian'||part==='.git')||/[\\:\x00-\x1f\x7f]/.test(path))throw fail('ownership-ignore-format');
  if(!await this.adapter().exists(path))return {sha256:null,lines:false};
  const stat=await this.adapter().stat(path);if(!stat||stat.type!=='file'||stat.size>256*1024)throw fail('ownership-ignore-unreadable');
  const text=await this.adapter().read(path);if(new TextEncoder().encode(text).length>256*1024)throw fail('ownership-ignore-unreadable');
  return {sha256:await sha256(new TextEncoder().encode(text)),lines:text.split(/\r?\n/g).map((line:string)=>line.replace(/\r$/,'').trim())};
 }
 private async engineFormat(settings:any){
  const format:any=Object.fromEntries(OWNERSHIP_FORMAT_FIELDS.filter(key=>key!=='idDerivationKeyFingerprint'&&settings[key]!==undefined).map(key=>[key,settings[key]]));
  format.readChunksOnline=false;
  if(settings.idDerivationVersion===1)format.idDerivationKeyFingerprint=await sha256(new TextEncoder().encode(configuredIdKey(settings) as string));
  return format;
 }
 private async diskBases(scope:any){
  const p=this.plugin,bases=[];
  for(const file of p.app.vault.getFiles()){
   if(!await this.ordinary(file.path))continue;
   const before={mtime:file.stat.mtime,size:file.stat.size},bytes=await p.app.vault.readBinary(file),hash=await sha256(bytes);
   if(file.stat.mtime!==before.mtime||file.stat.size!==before.size||bytes.byteLength!==before.size)throw fail('ownership-disk-changed');
   const revision=await p.core.serviceModules.fileHandler.readProvenanceSnapshot(file.path);
   bases.push({path:file.path,rev:typeof revision==='string'?revision:null,sha256:hash,size:bytes.byteLength,mtime:before.mtime,deleted:false});
  }
  return bases.sort((a,b)=>a.path.localeCompare(b.path));
 }
 private async verifyDisk(){
  const p=this.plugin,expected=this.state.bases;
  for(const base of this.state.scope.ignoreFileBases||[])if((await this.ignoreFile(base.path)).sha256!==base.sha256)throw fail('ownership-ignore-changed');
  for(const base of expected){
   const file=p.app.vault.getAbstractFileByPath(base.path);
   if(!file||!('stat'in file)||file.stat.mtime!==base.mtime||file.stat.size!==base.size
    ||await sha256(await p.app.vault.readBinary(file))!==base.sha256)throw fail('ownership-disk-changed');
  }
  // New ordinary paths during the hold must also invalidate the captured baseline.
  const paths=new Set(expected.map((base:any)=>base.path));
  for(const file of p.app.vault.getFiles())if(await this.ordinary(file.path)&&!paths.has(file.path))throw fail('ownership-disk-changed');
 }
 private async verifyPolicy(){
  const p=this.plugin,raw=await p.folderPolicies.api('read',{id:this.state.workspaceId}),scope=this.state.scope;
  if(raw.enabled===false){if(scope.policyRevision)throw fail('ownership-policy-changed');}
  else if(raw.revision!==scope.policyRevision||raw.protected_revision!==scope.protectedRevision||raw.phase!=='ready'||raw.operation)throw fail('ownership-policy-changed');
  for(const root of ['ArcaLink Shared',...(p.folders.records||[]).map((record:any)=>record.mount),...(raw.protected_folders||[])])
   if(!scope.excludedPrefixes.includes(root))throw fail('ownership-policy-changed');
 }
 private async openSource(){
  if(this.source)return this.source;
  const s=this.plugin.core.services,live=s.database.localDatabaseDirect?.localDatabase;
  if(live){this.source=live;return live;}
  if(!this.state?.sourceName)throw fail('ownership-source-unavailable');
  const Pouch=s.database.services.pouchDB;
  this.source=new Pouch(this.state.sourceName,{...(this.state.indexedDB?{adapter:'indexeddb'}:{}),auto_compaction:false});this.sourceOwned=true;
  return this.source;
 }
 private async remote(){
  const p=this.plugin,s=p.core.services,settings=s.setting.currentSettings();
  if(this.state.mode==='p2p'){
   const host=p.arcalinkP2P?.replicator?.rawHost;
   if(!host?.isServing||await host.evaluatePeerAcceptance(this.state.peerId)!=='accepted')throw fail('ownership-peer-unavailable');
   return {db:host.getConnection(this.state.peerId).getRemoteDB(this.controller!.signal),close:async()=>{},current:async()=>host===p.arcalinkP2P?.replicator?.rawHost&&await host.evaluatePeerAcceptance(this.state.peerId)==='accepted'};
  }
  const seed=await s.replicator.createRemoteResource(REMOTE_RESOURCE_KINDS.SECURITY_SEED,settings);
  if(!seed)throw fail('ownership-cloud-unavailable');
  try{
   const connection=await s.remote.connect(settings.couchDB_URI.replace(/\/$/,'')+'/'+encodeURIComponent(settings.couchDB_DBNAME),
    {type:'basic',username:settings.couchDB_USER,password:settings.couchDB_PASSWORD},!!p.app.isMobile,settings.encrypt?settings.passphrase:false,
    !!settings.useDynamicIterationCount,false,true,!!settings.enableCompression,{},!!settings.useRequestAPI,()=>seed.read(),
    {signal:this.controller!.signal,allowNativeFallback:false,encryptionAlgorithm:settings.E2EEAlgorithm,encryptInternalMetadata:!!settings.encryptInternalMetadata});
   if(typeof connection==='string'||!connection?.db)throw fail('ownership-cloud-unavailable');
   return {...connection,current:async()=>true,close:async()=>{await connection.close();await seed.dispose();}};
  }catch(error){await seed.dispose();throw error;}
 }
 async prepare(request:any){
  if(this.busy||this.disposed)return;this.busy=true;
  try{
   const bound=await this.identity(request);await this.idle();const p=this.plugin,s=p.core.services,settings=s.setting.currentSettings();
   if(!s.appLifecycle.isReady()||s.appLifecycle.isSuspended()||!navigator.onLine)throw fail('ownership-online-sync-required');
   if(this.blocksOrdinary)throw fail('ownership-already-pending');
   const keyTransfer=await keyTransferComparison(request);
   if(settings.idDerivationVersion===1)await this.write('ownership-key.json',await sealCompanionIdKey(request,configuredIdKey(settings) as string));
   await s.vault.scanVault(false,false,true);
   if(isFreeRelayConnection(settings)){
    const host=p.arcalinkP2P?.replicator?.rawHost,peers=p.arcalinkP2P?.peerDirectory.getPeers()||[];
    const admitted=[];for(const peer of peers)if(await host?.evaluatePeerAcceptance(peer.peerId)==='accepted')admitted.push(peer);
    if(admitted.length!==1)throw fail('ownership-peer-unavailable');
    const result=await p.arcalinkP2P.targetedTransfer.synchroniseWithPeer(admitted[0].peerId,false);
    if(result?.status!=='completed')throw fail('ownership-online-sync-required');
    request={...request,peerId:admitted[0].peerId,peerName:admitted[0].name||admitted[0].peerName||''};
   }else if(!await s.replication.replicate(false))throw fail('ownership-online-sync-required');
   await this.identity(request);await this.idle();
   const original=Object.fromEntries(ORIGINAL.filter(key=>settings[key]!==undefined).map(key=>[key,settings[key]]));
   this.state={...ownershipIdentity(request),phase:'preparing',mode:isFreeRelayConnection(settings)?'p2p':'cloud',peerId:request.peerId||'',peerName:request.peerName||'',
    original,scope:{...this.scope(settings),ignoreFileBases:[]},pluginDeviceId:bound.session.deviceId,remoteDatabase:settings.couchDB_DBNAME||'',publicKeyFingerprint:keyTransfer.fingerprint,
    quarantineSuffix:'companion-'+request.generation.replace(/-/g,''),startedAt:Date.now(),since:0,pages:0,records:[]};
   this.holding=true;await this.save();
   await s.replicator.onCloseActiveReplication();await s.fileProcessing.commitPendingFileEvents();
   const counts=()=>[s.replication.replicationResultCount.value,s.replication.storageApplyingCount.value,s.replication.databaseQueueCount.value,p.telegram?.busy?1:0];
   if(!await waitForReplicationDrain(counts,{idleTimeout:30000,totalTimeout:120000}))throw fail('ownership-drain-timeout');
   Object.assign(settings,{suspendFileWatching:true,suspendParseReplicationResult:true});
   await s.fileProcessing.commitPendingFileEvents();if(!await waitForReplicationDrain(counts,{idleTimeout:30000,totalTimeout:120000}))throw fail('ownership-drain-timeout');
   const source=await this.openSource(),info=await source.info();this.state.sourceName=source.name||info.db_name;this.state.indexedDB=!!settings.useIndexedDBAdapter;
   this.state.sequence=info.update_seq;this.state.scope={...this.scope(original),ignoreFileBases:[]};this.state.engineFormat=await this.engineFormat(settings);
   this.state.bases=await this.diskBases(this.state.scope);await this.save();
   await this.proveNext();
  }catch{this.error=fail().message;new Notice(this.error,15000);}
  finally{this.busy=false;}
 }
 private async proveNext(){
  if(this.state.cancelRequested)throw fail('ownership-cancelled');
  if(!this.state?.sequence&&this.state?.sequence!==0)throw fail();
  await this.identity(this.state);const source=await this.openSource();await this.verifyDisk();
  this.controller=new AbortController();const timeout=window.setTimeout(()=>this.controller?.abort(),30000);let connection:any;
  try{
   connection=await this.remote();
   const page=await proveOwnershipPage({source,remote:connection.db,sequence:this.state.sequence,since:this.state.since,limit:8,
    isOrdinary:(path:string)=>this.ordinary(path),
    getPath:(doc:any)=>doc.path||(!doc._deleted?this.plugin.core.services.path.getPath(doc):null),
    isCurrent:async()=>!this.disposed&&!this.controller?.signal.aborted&&await connection.current()});
   this.state.records.push(...page.records);this.state.since=page.since;this.state.pages++;await this.save();
   if(!page.done)return;
   await this.verifyDisk();
   const manifest=this.heldManifest();this.state.manifestDigest=await ownershipDigest(manifest);this.state.phase='held';await this.save();
   await this.write('ownership-manifest.json',manifest);
   // Release the old Free identity only after proving the chosen peer's complete copy.
   await this.plugin.arcalinkP2P?.transportLifecycle.disconnect();
  }finally{window.clearTimeout(timeout);await connection?.close();this.controller=null;}
 }
 private heldManifest(){
  return assertOwnershipManifest({...ownershipIdentity(this.state),phase:'held',mode:this.state.mode,peerId:this.state.peerId,...(this.state.peerName?{peerName:this.state.peerName}:{}),publicKeyFingerprint:this.state.publicKeyFingerprint,
   source:{sequence:this.state.sequence},scope:this.state.scope,engineFormat:this.state.engineFormat,records:this.state.records,bases:this.state.bases,createdAt:this.state.startedAt});
 }
 private async commit(reply:any){
  if(this.state.cancelRequested)throw fail('ownership-cancelled');
  const manifest=await this.read('ownership-manifest.json',MAX_MANIFEST);
  if(!manifest||!sameOwnershipIdentity(this.state,reply)||!await ownershipReadyMatches(manifest,reply))throw fail('ownership-ready-mismatch');
  await this.identity(this.state);await this.verifyDisk();const source=await this.openSource();
  if(!same((await source.info()).update_seq,this.state.sequence))throw fail('ownership-source-changed');
  await this.verifyPolicy();
  if(!same(await this.engineFormat(this.plugin.core.services.setting.currentSettings()),this.state.engineFormat))throw fail('ownership-format-changed');
  this.state.phase='committing';await this.save();
  // Shared credentials and registries remain in their existing locations; no secret backup is written.
  await this.plugin.core.services.setting.applyPartial(this.guards(),true);
  await this.plugin.arcalinkP2P?.transportLifecycle.disconnect();
  await this.plugin.core.services.replicator.onCloseActiveReplication();
  await this.plugin.core.services.database.localDatabaseDirect?.close();
  this.state.phase='committed';await this.save();
  await this.write('ownership-result.json',{...ownershipIdentity(this.state),phase:'committed',manifestDigest:this.state.manifestDigest});
 }
 /** Before commit the Companion has no file authority. Cancellation restores only this source's nonsensitive settings. */
 async cancel(){
  if(this.cancelling||!['preparing','held'].includes(this.state?.phase))return false;
  this.cancelling=true;
  try{
   this.state.cancelRequested=true;await this.save();this.controller?.abort();
   const deadline=Date.now()+30000;while(this.busy&&Date.now()<deadline)await new Promise(resolve=>window.setTimeout(resolve,50));
   if(this.busy)throw fail('ownership-cancel-waiting');
   const p=this.plugin,s=p.core.services,settings=s.setting.currentSettings(),saved=await p.unifiedVault.saved(),workspace=await p.workspaces.session();
   const session=await p.freeRelay.session()||saved?.auth;
   // Local checks permit recovery while offline, without authorizing a different account or database.
   if((saved?.workspaceId||workspace.workspaceId)!==this.state.workspaceId||session?.deviceId!==this.state.pluginDeviceId
    ||(settings.couchDB_DBNAME||'')!==this.state.remoteDatabase
    ||(settings.additionalSuffixOfDatabaseName||'')!==(this.state.original.additionalSuffixOfDatabaseName||''))throw fail('ownership-binding-changed');
   if(this.state.sourceName){const source=await this.openSource();if((source.name||(await source.info()).db_name)!==this.state.sourceName)throw fail('ownership-source-changed');}
   const original={...this.state.original};
   await s.setting.applyPartial({...original,...Object.fromEntries([...AUTO,...P2P].map(key=>[key,false])),suspendFileWatching:true,suspendParseReplicationResult:true},true);
   this.state.phase='cancelled';this.state.cancelRequested=false;await this.save();this.holding=false;this.error='';
   await this.write('ownership-result.json',{...ownershipIdentity(this.state),phase:'cancelled'});
   await s.setting.applyPartial(original,true);
   if(this.sourceOwned){await this.source?.close();this.source=null;this.sourceOwned=false;}
   // This is a user-requested plugin restart, not an automatic opening of Obsidian.
   await p.app.plugins.disablePlugin(p.manifest.id);await p.app.plugins.enablePlugin(p.manifest.id);return true;
  }catch{this.error=fail().message;new Notice(this.error,15000);return false;}
  finally{this.cancelling=false;}
 }
 private async scopeRefresh(request:any){
  if(!sameOwnershipIdentity(this.state,request)||request.manifestDigest!==this.state.manifestDigest
   ||!validOwnershipIdentity({...ownershipIdentity(request),nonce:request.scopeNonce}))throw fail('ownership-scope-binding');
  const previous=this.state.scopeWindow;
  if(request.phase==='scope-paused'){
   if(previous?.nonce===request.scopeNonce){
    if(previous.status==='open')await this.write('ownership-scope.json',{...ownershipIdentity(this.state),phase:'scope-open',scopeNonce:previous.nonce,manifestDigest:this.state.manifestDigest});
    else if(previous.payload)await this.write('ownership-scope.json',previous.status==='applied'?this.scopeCommitted(previous):previous.payload);
    return;
   }
   await this.idle();
   this.state.scopeWindow={nonce:request.scopeNonce,status:'open'};await this.save();
   await this.write('ownership-scope.json',{...ownershipIdentity(this.state),phase:'scope-open',scopeNonce:request.scopeNonce,manifestDigest:this.state.manifestDigest});return;
  }
  if(!previous||previous.nonce!==request.scopeNonce)throw fail('ownership-scope-binding');
  if(request.phase==='scope-seal'){
   if(previous.payload){await this.write('ownership-scope.json',previous.status==='applied'?this.scopeCommitted(previous):previous.payload);return;}
   // Close admission durably before waiting for any previously admitted asynchronous mount operations.
   previous.status='sealing';await this.save();
   await Promise.all([...this.scopeMutations]);await this.plugin.folders.queue;await this.idle();
   const raw=await this.plugin.folderPolicies.api('read',{id:this.state.workspaceId});
   if(raw.enabled!==false&&(raw.phase!=='ready'||raw.operation))throw fail('ownership-policy-changed');
   const scope={...this.state.scope,excludedPrefixes:[...new Set([...this.state.scope.excludedPrefixes,...this.scope(this.state.original).excludedPrefixes,...(raw.protected_folders||[]),...(raw.policy?.folders||[])])].sort(),
    policyRevision:raw.enabled===false?0:raw.revision,protectedRevision:raw.enabled===false?'':raw.protected_revision};
   for(const base of scope.ignoreFileBases||[])if((await this.ignoreFile(base.path)).sha256!==base.sha256)throw fail('ownership-ignore-changed');
   // Reuse the original strict scope validator without copying any document bodies or keys.
   assertOwnershipManifest({...this.heldManifest(),scope});
   const payload:any={...ownershipIdentity(this.state),phase:'scope-sealed',scopeNonce:previous.nonce,manifestDigest:this.state.manifestDigest,scope};
   payload.sealDigest=await ownershipDigest(payload);previous.payload=payload;previous.status='sealed';await this.save();await this.write('ownership-scope.json',payload);return;
  }
  if(request.phase==='scope-ready'){
   if(!previous.payload||request.sealDigest!==previous.payload.sealDigest)throw fail('ownership-scope-binding');
   if(previous.status!=='applied'){
    if(previous.status!=='sealed')throw fail('ownership-scope-binding');
    // A later policy/mount change cannot reuse an already verified private copy.
    const old=this.state.scope;this.state.scope=previous.payload.scope;
    try{await this.verifyPolicy();}catch(error){this.state.scope=old;throw error;}
    previous.status='applied';await this.save();
   }
   await this.write('ownership-scope.json',this.scopeCommitted(previous));
  }
 }
 private scopeCommitted(window:any){return {...ownershipIdentity(this.state),phase:'scope-committed',scopeNonce:window.nonce,manifestDigest:this.state.manifestDigest,sealDigest:window.payload.sealDigest};}
 async tick(){
  if(this.disposed||this.busy||this.cancelling)return;
  try{
   await this.publishCapabilities();
   const request=await this.read('ownership-request.json');
   if(this.committed){
    if(request?.phase?.startsWith('scope-')){this.busy=true;try{await this.scopeRefresh(request);this.error='';}finally{this.busy=false;}}
    await this.write('ownership-result.json',{...ownershipIdentity(this.state),phase:'committed',manifestDigest:this.state.manifestDigest});return;
   }
   if(request?.phase==='cancel'&&sameOwnershipIdentity(this.state,request)&&['preparing','held'].includes(this.state?.phase)){await this.cancel();return;}
   if(this.state?.phase==='cancelled'&&sameOwnershipIdentity(this.state,request))return;
   if(this.state?.cancelRequested){await this.cancel();return;}
   if(this.state?.phase==='preparing'){
    this.busy=true;try{await this.proveNext();this.error='';}finally{this.busy=false;}return;
   }
   if(this.state?.phase==='committing'){
    // The durable native ready proof survives a lost settings/result response.
    if(request?.phase==='ready'){this.busy=true;try{await this.commit(request);this.error='';}finally{this.busy=false;}}return;
   }
   if(this.state?.phase==='held'){
    if(request?.phase==='ready'){this.busy=true;try{await this.commit(request);this.error='';}finally{this.busy=false;}}
    else if(!await this.read('ownership-manifest.json',MAX_MANIFEST)){
     await this.verifyDisk();const source=await this.openSource();if(!same((await source.info()).update_seq,this.state.sequence))throw fail('ownership-source-changed');
     const manifest=this.heldManifest();if(await ownershipDigest(manifest)!==this.state.manifestDigest)throw fail('ownership-manifest-changed');await this.write('ownership-manifest.json',manifest);
    }return;
   }
   if(!request||!validOwnershipIdentity(request)||request.phase!=='prepare'||this.dialogNonce===request.nonce||this.error)return;
   const compared=await keyTransferComparison(request);this.dialogNonce=request.nonce;this.confirm(request,compared.code);
  }catch{if(this.blocksOrdinary)this.error=fail().message;}
 }
 private confirm(request:any,code:string){
  const dialog=new Modal(this.plugin.app);dialog.titleEl.setText('Передать синхронизацию Компаньону');
  dialog.contentEl.createEl('p',{text:'Компаньон будет самостоятельно синхронизировать обычные файлы этого хранилища. Общие папки и совместные заметки продолжат работать через плагин. Сверьте код на экране Компаньона: '+code});
  dialog.contentEl.createEl('p',{text:'Подключение: '+request.workspaceId+'. После проверки полной удалённой копии потребуется подтверждение Компаньона. Прежняя локальная база останется для восстановления.'});
  new Setting(dialog.contentEl).addButton(button=>button.setButtonText('Отмена').onClick(()=>dialog.close()))
   .addButton(button=>button.setButtonText('Код совпадает: проверить и передать').setCta().onClick(()=>{dialog.close();void this.prepare(request);}));dialog.open();
 }
 requestNativeSync(reason='manual'){
  if(!this.committed)return false;
  void this.write('sync-request.json',{schema:1,id:crypto.randomUUID(),reason,requestedAt:Date.now(),generation:this.state.generation,workspaceId:this.state.workspaceId});return true;
 }
 dispose(){this.disposed=true;this.controller?.abort();if(this.sourceOwned)void this.source?.close();}
}
