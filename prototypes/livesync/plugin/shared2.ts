import {createShared2AliasTransfers} from './shared2-alias-transfers.mjs';
import {createShared2ReverseTransfers} from './shared2-reverse-transfers.mjs';
import {createShared2EncryptedTransfers} from './shared2-encrypted-transfers.mjs';
import {createShared2MigrationView} from './shared2-migration-view.mjs';
import {configureShared2PrivateTarget,configureShared2PrivateSource} from './shared2-private-encryption.mjs';
import {encodeFolderPolicy,folderPolicyExcludes} from './folder-policy.mjs';
import {checkedShared2ServerCatalog,shared2AuthorityTransition} from './shared2-server-catalog.mjs';
import {preserveShared2LegacyTexts,importShared2LegacyTexts} from './shared2-legacy-cache.mjs';
import {shared2Message,shared2Phase} from './shared2-messages.mjs';
import {createShared2MigrationPreparation,backupShared2Files} from './shared2-migration-preparation.mjs';
import {createShared2DeviceTransfers} from './shared2-device-transfers.mjs';
import {createShared2NamespaceJobs} from './shared2-namespace-jobs.mjs';
import {safeRelative} from './folder-model.mjs';
import {chooseSharedFolder} from './shared-folder-picker';
import {Notice,requestUrl,Setting,Modal} from 'obsidian';
import {Shared2PouchDB as PouchDB} from './shared2-pouch.mjs';
import {createFolderPolicyStore} from './folder-policy-store.mjs';
import {createShared2LocalEngineFactory} from './shared2-local-engine.mjs';
import {createShared2PrivateTargetRemoteFactory,createShared2PrivateRemoteFactory,createShared2RemoteFactory} from './shared2-remote-transport.mjs';
import {configureShared2Encryption} from './shared2-encryption.mjs';
import {createShared2CatalogClient} from './shared2-catalog-client.mjs';
import {createShared2Jobs} from './shared2-jobs.mjs';
import {createShared2VaultController} from './shared2-vault-controller.mjs';
import {createShared2VaultDisk} from './shared2-vault-disk.mjs';
import {hashShared2Stream} from './shared2-stream-hash.mjs';
import {createShared2KeyVault,createShared2IndexedKeyStore} from './shared2-key-vault.mjs';

const recordCache=(records:any[],id:string)=>records.find(record=>record.id===id)?.shared2CacheEpoch;

/** Explicit server-flagged integration. Existing personal engine is never used
 * for a shared2 mount. Server unavailability retains the boundary and pauses it.
 */
export class Shared2 {
 enabled=false;disposed=false;busy=false;transferCount=0;catalog:any=null;scope:any=null;
 preparations=new Map<string,any>();retentionStatus=new Map<string,any>();
 deviceTransfers:any=null;deviceState:any={requests:[],jobs:[]};
 aliasTransfers:any=null;aliasState:any={requests:[],jobs:[]};
 reverseTransfers:any=null;reverseState:any={requests:[],jobs:[]};
 encryptedTransfers:any=null;encryptedState:any={requests:[],jobs:[]};
 namespaceJobs:any=null;namespaceState:any={requests:[],jobs:[]};namespacePreparing=new Map<string,Promise<any>>();
 jobs:any=null;jobState:any={jobs:[]};inbox:any[]=[];entries=new Map<string,any>();
 access=new Map<string,any>();keyInbox:any[]=[];keyStorage:any=null;keys:any=null;warning='';timer:any;initializing:any;context='';lastError='';panels=new Set<HTMLElement>();panelGates=new Map<HTMLElement,(control:HTMLElement)=>void>();
 constructor(private plugin:any){}
 async session(){const saved=await this.plugin.unifiedVault.saved(),session=await this.plugin.freeRelay.session()||saved?.auth,workspace=(await this.plugin.workspaces.session())?.workspaceId||saved?.workspaceId;return {session,workspace};}
 signature(value:any){return JSON.stringify([value.session?.email,value.session?.deviceId,value.workspace]);}
 async request(path:string,options:any={}){
  const current=await this.session();if(this.context&&this.signature(current)!==this.context)throw Error('shared2-account-changed');
  let session=current.session;if(!session?.accessToken)throw Error('shared2-session-unavailable');
  const send=()=>requestUrl({url:this.plugin.unifiedVault.base+path,method:options.method||'GET',headers:{...options.headers,'Content-Type':'application/json',Authorization:'Bearer '+session.accessToken},...(options.body?{body:options.body}:{}),throw:false});
  let response=await send();if(response.status===401&&session.refreshToken){session=await this.plugin.freeRelay.refresh({...session,group:session.group||current.workspace});response=await send();}
  if(this.context&&this.signature(await this.session())!==this.context)throw Error('shared2-account-changed');
  return {status:response.status,json:response.json,sessionToken:session.accessToken};
 }
 store(name:string){const adapter=this.plugin.app.vault.adapter,base=this.plugin.pilotDirectory+'/shared2-'+this.scope.account+'-'+this.scope.workspace+'-'+name,slots=createFolderPolicyStore(adapter,base);return {load:async()=>{const value=await slots.read();return Object.keys(value).length?value:null;},save:(value:any)=>slots.update(()=>value)};}
 init(){if(this.initializing)return this.initializing;this.initializing=this.start().catch((error:any)=>{this.warning=error.code||error.message;}).finally(()=>{this.initializing=null;});return this.initializing;}
 async start(){
  if(this.disposed)return;const current=await this.session();if(!current.session?.accessToken||!current.workspace)return;if(!/^[a-f0-9]{32}$/.test(current.workspace))throw Error('shared2-invalid-workspace');
  const context=this.signature(current);if(this.context&&this.context!==context){await this.aliasTransfers?.close();this.aliasTransfers=null;this.aliasState={requests:[],jobs:[]};await this.reverseTransfers?.close();this.reverseTransfers=null;this.reverseState={requests:[],jobs:[]};await this.encryptedTransfers?.close();this.encryptedTransfers=null;this.encryptedState={requests:[],jobs:[]};await this.deviceTransfers?.close();this.deviceTransfers=null;this.deviceState={requests:[],jobs:[]};await this.retire();await this.jobs?.close();await this.namespaceJobs?.close();this.namespaceJobs=null;this.namespaceState={requests:[],jobs:[]};this.catalog=null;this.retentionStatus.clear();this.enabled=false;this.scope=null;this.keys=null;this.jobs=null;}
  this.context=context;
  const response=await this.request('/shared2/catalog');if(response.status!==200)return;
  const catalog=checkedShared2ServerCatalog(response.json);
  this.scope={account:catalog.account,workspace:current.workspace};this.catalog=catalog;this.enabled=true;
  this.keyStorage??=createShared2IndexedKeyStore();this.keys=createShared2KeyVault({...this.scope,device:current.session.deviceId,storage:this.keyStorage});
  this.jobs??=createShared2Jobs({scope:this.scope,store:this.store('jobs'),request:(...args:any[])=>this.request(args[0],args[1]),onChange:(state:any)=>{this.jobState=state;this.redraw();}});
  this.namespaceJobs??=createShared2NamespaceJobs({scope:this.scope,store:this.store('namespace-jobs'),request:(path:string,options:any)=>{if(this.context!==context)throw Error('shared2-account-changed');return this.request(path,options);},onChange:(state:any)=>{this.namespaceState=state;this.redraw();}});
  this.deviceTransfers??=createShared2DeviceTransfers({scope:{...this.scope,device:current.session.deviceId},store:this.store('device-transfers-'+current.session.deviceId),keys:this.keys,request:(path:string,options:any)=>{if(this.context!==context)throw Error('shared2-account-changed');return this.request(path,options);},createEngine:(profile:any)=>this.migrationEngine(profile),openRemote:(job:string,side:string,profile:any)=>this.migrationRemote(job,side,profile),beforeStart:(folder:string,key:string,options:any)=>this.prepareDeviceTransfer(folder,key,options),onChange:(state:any)=>{this.deviceState=state;this.redraw();}});
  this.encryptedTransfers??=createShared2EncryptedTransfers({scope:{...this.scope,device:current.session.deviceId},store:this.store('encrypted-transfers-'+current.session.deviceId),keys:this.keys,request:(path:string,options:any)=>{if(this.context!==context)throw Error('shared2-account-changed');return this.request(path,options);},prepare:(intent:any,check:any)=>this.prepareEncryptedShare(intent,check),openSource:async(job:any,profile:any,check:any)=>{const remote=await this.encryptedRemote(job,'source',profile,false,check);return {...remote,view:createShared2MigrationView({localDatabase:remote.database},{readOnly:true})};},openRaw:(job:any,side:string,profile:any,check:any)=>this.encryptedRemote(job,side,profile,true,check),openShared:(job:any,profile:any,check:any)=>this.encryptedRemote(job,'shared',profile,false,check),createEngine:(profile:any)=>this.migrationEngine(profile),onChange:(state:any)=>{this.encryptedState=state;this.redraw();}});
  this.reverseTransfers??=createShared2ReverseTransfers({scope:{...this.scope,device:current.session.deviceId},store:this.store('reverse-transfers-'+current.session.deviceId),keys:this.keys,request:(path:string,options:any)=>{if(this.context!==context)throw Error('shared2-account-changed');return this.request(path,options);},prepare:(intent:any,check:any)=>this.prepareReverse(intent,check),openPrivateSource:async(job:any,profile:any,check:any)=>{const remote=await this.reverseRemote(job,'source',profile,false,check);return {...remote,view:createShared2MigrationView({localDatabase:remote.database},{readOnly:true})};},openShared:async(job:any,profile:any,check:any)=>{const remote=await this.reverseRemote(job,'shared',profile,false,check);return {...remote,view:createShared2MigrationView({localDatabase:remote.database},{readOnly:true})};},openRaw:(job:any,side:string,profile:any,check:any)=>this.reverseRemote(job,side,profile,true,check),openTarget:(job:any,profile:any,check:any)=>this.reverseRemote(job,'target',profile,false,check),createEngine:(profile:any)=>this.migrationEngine(profile),onChange:(state:any)=>{this.reverseState=state;this.redraw();}});
  if(catalog.capabilities?.aliasReconciliation===true)this.aliasTransfers??=createShared2AliasTransfers({scope:{...this.scope,device:current.session.deviceId},store:this.store('alias-transfers-'+current.session.deviceId),keys:this.keys,request:(path:string,options:any)=>{if(this.context!==context)throw Error('shared2-account-changed');return this.request(path,options);},prepare:(intent:any,check:any)=>this.prepareAliases(intent,check),openView:async(job:any,side:string,profile:any,check:any)=>{const remote=await this.aliasRemote(job,side,profile,false,check);return {...remote,view:createShared2MigrationView({localDatabase:remote.database},{readOnly:true})};},openRaw:(job:any,side:string,profile:any,check:any)=>this.aliasRemote(job,side,profile,true,check),openTarget:(job:any,profile:any,check:any)=>this.aliasRemote(job,'shared',profile,false,check),createEngine:(profile:any)=>this.migrationEngine(profile),onChange:(state:any)=>{this.aliasState=state;this.redraw();}});
  try{const publicKey=await this.keys.publicIdentity(),registered=await this.request('/shared2/device-key',{method:'POST',body:JSON.stringify(publicKey)});if(registered.status!==200)throw Error('shared2-device-key-registration-unavailable');}catch(error:any){this.warning=error.code||error.message;}
  await this.reconcileDeviceTransfers();await this.encryptedTransfers.refresh();await this.reconcileEncryptedTransfers();await this.reverseTransfers.refresh();await this.reconcileReverseTransfers();if(this.aliasTransfers){await this.aliasTransfers.refresh();await this.reconcileAliasTransfers();}await this.applyCatalog(catalog);await this.poll();
  if(!this.timer)this.timer=window.setInterval(()=>{void this.poll();},10000);
 }
 async drainLegacy(id:string){
  const folders=this.plugin.folders,entry=folders.entries.get(id);if(!entry)return;
  entry.denied=true;entry.ready=false;entry.migrationPaused=true;entry.provider?.disconnect();entry.provider?.destroy();
  await Promise.allSettled([entry.promise,entry.changing,entry.projecting,entry.provider?.transferQueue].filter(Boolean));
  const record=folders.records.find((r:any)=>r.id===id);
  if(record&&this.scope){
   const nonce=crypto.randomUUID().replace(/-/g,''),root='ArcaLink Shared/shared2/'+this.scope.account+'/'+this.scope.workspace+'/'+id+'/legacy-'+nonce,adapter=this.plugin.app.vault.adapter;
   await this.mkdirs(root+'/objects');
   const versions=await preserveShared2LegacyTexts({files:entry.files,mount:record.mount,hashStream:hashShared2Stream,diskHash:async(path:string)=>await adapter.exists(path)?(await this.hashFile(path)).sha256:null,writeBackup:async(digest:string,text:string)=>{const file=root+'/objects/'+digest+'.txt';await adapter.write(file,text);if((await this.hashFile(file)).sha256!==digest)throw Error('shared2-backup-proof-mismatch');return file;},assertCurrent:async()=>{if(this.disposed||this.signature(await this.session())!==this.context)throw Error('shared2-account-changed');}});
   if(versions.length){const storeName='legacy-'+id+'-'+nonce;await this.store(storeName).save({protocol:2,scope:{...this.scope},folder:id,root,versions});record.shared2LegacyVersions=[...(record.shared2LegacyVersions||[]),{root,storeName}];await folders.save();}
  }
  await entry.persistence?.destroy();for(const undo of entry.undo.values())undo.destroy();entry.doc.destroy();folders.entries.delete(id);
 }
 async retire(){for(const entry of this.entries.values()){await entry.controller?.close();await entry.engine?.close();}this.entries.clear();}
 async applyCatalog(catalog:any){
  catalog=checkedShared2ServerCatalog(catalog);
  if(catalog.account!==this.scope.account)throw Error('shared2-account-changed');
  this.catalog=catalog;
  for(const [id,entry] of this.entries){const row=catalog.folders.find((row:any)=>row.id===id);if(!row||this.version(row)!==entry.version){await entry.controller.close();await entry.engine.close();this.entries.delete(id);}}
  let changed=false;
  for(const record of this.plugin.folders.records)if(record.protocol===2&&record.shared2Scope?.account===this.scope.account&&record.shared2Scope?.workspace===this.scope.workspace&&!catalog.folders.some((row:any)=>row.id===record.id)&&!record.shared2Revoked){record.shared2Revoked=true;changed=true;}

  for(const row of catalog.folders){
   if(!/^arcalink_s_[a-f0-9]{32}$/.test(row.database))continue;
   const record=this.plugin.folders.records.find((record:any)=>record.id===row.id);
   if(record&&!record.shared2Revoked&&(!record.shared2Scope||record.shared2Scope.account===this.scope.account&&record.shared2Scope.workspace===this.scope.workspace)){
    if(shared2AuthorityTransition(record,row)==='reaccepted'){record.shared2Revoked=true;changed=true;continue;}
    if(shared2AuthorityTransition(record,row)!=='unchanged'){
     const initial=record.protocol!==2;await this.drainLegacy(row.id);
     if(record.shared2CacheEpoch){record.shared2RetiredLedgers??=[];record.shared2RetiredLedgers.push('ledger-'+row.id+'-'+(record.shared2Generation||row.generation)+'-'+record.shared2CacheEpoch);}
     record.protocol=2;record.shared2Preparing=false;record.shared2CacheEpoch=record.shared2DeviceTarget&&record.shared2DeviceTarget.database===row.database&&record.shared2DeviceTarget.generation===row.generation&&record.shared2DeviceTarget.keyEpoch===row.keyEpoch?record.shared2DeviceTarget.cacheEpoch:crypto.randomUUID().replace(/-/g,'');record.role=row.role;record.shared2ReconcileAuthority=!initial;
     record.shared2AuthorityEpoch=row.authorityEpoch;record.shared2MembershipEpoch=row.membershipEpoch;record.shared2Generation=row.generation;record.shared2Database=row.database;record.shared2KeyEpoch=row.keyEpoch;
     if(initial&&row.role!=='viewer')record.shared2LegacyImportApprovedEpoch=record.shared2CacheEpoch;record.shared2Scope={...this.scope};changed=true;
    }
   }
  }
  if(changed)await this.plugin.folders.save();this.plugin.folders.refresh();
 }
 version(row:any){return JSON.stringify([row.database,row.generation,row.revision,row.role,row.keyEpoch,row.authorityEpoch,row.membershipEpoch]);}
 retentionFor(row:any){const status=this.retentionStatus.get(row?.id);return status&&status.database===row.database&&status.generation===row.generation?status:null;}
 retentionPaused(row:any){const status=this.retentionFor(row);return !!status&&(!['active','restored','retained'].includes(status.state)||status.state==='retained'&&Date.parse(status.retainedUntil)<=Date.now());}
 canEdit(id:string){const row=this.catalog?.folders.find((row:any)=>row.id===id);return !!row&&!this.retentionPaused(row)&&this.entries.has(id)&&row.role!=='viewer'&&!this.plugin.folders.records.find((r:any)=>r.id===id)?.shared2ReconcileAuthority&&!this.plugin.folders.records.find((r:any)=>r.id===id)?.shared2Unsharing&&!this.plugin.folders.records.find((r:any)=>r.id===id)?.shared2Rekeying&&!this.plugin.folders.records.find((r:any)=>r.id===id)?.shared2Reconciling;}
 async poll(){
  if(this.busy||this.disposed||!this.enabled)return;this.busy=true;
  try{
   await this.reconcileDeviceTransfers();await this.encryptedTransfers.refresh();await this.reconcileEncryptedTransfers();await this.reverseTransfers.refresh();await this.reconcileReverseTransfers();if(this.aliasTransfers){await this.aliasTransfers.refresh();await this.reconcileAliasTransfers();}const response=await this.request('/shared2/catalog');if(response.status!==200)throw Error('shared2-catalog-unavailable');await this.applyCatalog(response.json);
   const retention=await this.request('/shared2/retention');if(retention.status===200){if(!Array.isArray(retention.json.folders))throw Error('shared2-retention-unavailable');this.retentionStatus=new Map(retention.json.folders.map((row:any)=>[row.folder,row]));}
   await this.deviceTransfers.refresh();await this.reconcileDeviceTransfers();await this.jobs.refresh();await this.namespaceJobs.refresh();await this.reconcileNamespaceJobs();const inbox=await this.request('/shared2/inbox');if(inbox.status===200)this.inbox=inbox.json.invitations;
   const keyInbox=await this.request('/shared2/key-inbox');if(keyInbox.status===200){this.keyInbox=[];for(const delivery of keyInbox.json.envelopes){const row=this.catalog.folders.find((row:any)=>row.id===delivery.envelope.folder);if(!row)continue;try{await this.keys.get(this.profile(row));}catch{this.keyInbox.push(delivery);}}}
   for(const row of this.catalog.folders){
    if(this.disposed)break;
    if(row.role==='owner'&&this.access.get(row.id)?.revision!==row.revision){const members=await this.request('/shared2/folders/'+row.id+'/members'),invitations=await this.request('/shared2/folders/'+row.id+'/invitations'),devices=await this.request('/shared2/folders/'+row.id+'/devices');this.access.set(row.id,{revision:row.revision,members:members.status===200?members.json.members:[],invitations:invitations.status===200?invitations.json.invitations:[],devices:devices.status===200?devices.json.devices:[]});}
    if(!/^arcalink_s_[a-f0-9]{32}$/.test(row.database))continue;
    const record=this.plugin.folders.records.find((record:any)=>record.id===row.id&&record.protocol===2&&!record.shared2Left&&!record.shared2Revoked&&!record.shared2Creating&&!record.shared2Unsharing&&!record.shared2Rekeying&&!record.shared2Reconciling&&record.shared2Scope?.account===this.scope.account&&record.shared2Scope?.workspace===this.scope.workspace);if(!record)continue;
    if(this.retentionPaused(row)){const previous=this.entries.get(row.id);if(previous){await previous.controller.close();await previous.engine.close();this.entries.delete(row.id);}continue;}
    const entry=await this.ensure(row,record.mount);this.transferCount++;try{const result=await entry.controller.synchronize();if(record.shared2ReconcileAuthority&&!result.conflicts.length){record.shared2ReconcileAuthority=false;await this.plugin.folders.save();this.plugin.folders.refresh();}}catch(error){await entry.controller.close();await entry.engine.close();this.entries.delete(row.id);throw error;}finally{this.transferCount--;}
   }
   for(const record of this.plugin.folders.records)if(record.shared2Preparing&&!record.shared2EncryptedRequest&&!record.shared2NamespaceRequest&&!record.shared2Job&&record.shared2Scope?.account===this.scope.account&&record.shared2Scope?.workspace===this.scope.workspace&&!this.preparations.get(record.id)?.promise)void this.migrate(record.id).catch((error:any)=>{this.warning=error.code||error.message;this.redraw();});
   for(const intent of this.namespaceState.requests||[])if(!intent.terminal&&!intent.job&&!intent.cancelRequested&&intent.phase!=='error'&&!this.namespacePreparing.has(intent.requestKey))void this.prepareNamespace(intent);
   if(this.aliasTransfers&&!this.aliasTransfers.working&&this.aliasState.requests.some((intent:any)=>!intent.terminal&&!intent.error)){this.transferCount++;void this.aliasTransfers.step().catch((error:any)=>{this.warning=error.code||error.message;}).finally(()=>{this.transferCount--;this.redraw();});}
   if(!this.reverseTransfers.working&&this.reverseState.requests.some((intent:any)=>!intent.terminal&&!intent.error)){this.transferCount++;void this.reverseTransfers.step().catch((error:any)=>{this.warning=error.code||error.message;}).finally(()=>{this.transferCount--;this.redraw();});}
   if(!this.encryptedTransfers.working&&this.encryptedState.requests.some((intent:any)=>!intent.terminal&&!intent.error)){this.transferCount++;void this.encryptedTransfers.step().catch((error:any)=>{this.warning=error.code||error.message;}).finally(()=>{this.transferCount--;this.redraw();});}
   if(!this.deviceTransfers.working&&this.deviceState.requests.some((intent:any)=>!intent.terminal&&!intent.error)){this.transferCount++;void this.deviceTransfers.step().catch((error:any)=>{this.warning=error.code||error.message;}).finally(()=>{this.transferCount--;this.redraw();});}this.warning='';
  }catch(error:any){this.warning=error.code||error.message||'shared2-unavailable';}
  finally{this.busy=false;this.redraw();}
 }
 async reverseRemote(job:any,side:string,profile:any,raw:boolean,check:any){
  const context=this.context,settings={...this.plugin.core.services.setting.currentSettings()},identity=(value:any)=>JSON.stringify([value.encrypt,value.passphrase,value.E2EEAlgorithm,value.useDynamicIterationCount,value.usePathObfuscation,value.hashAlg,value.handleFilenameCaseSensitive]);
  if(side!=='shared'&&profile.encrypted!==!!settings.encrypt)throw Error('shared2-private-cipher-settings-required');
  const expected=identity(settings),current=async()=>this.context===context&&await check()&&expected===identity(this.plugin.core.services.setting.currentSettings());
  const bound={kind:side==='shared'?'shared':'personal',...this.scope,ownerWorkspace:this.scope.workspace,documentRoot:job.mount,...profile,catalogRevision:0};
  const options={origin:new URL(this.plugin.unifiedVault.base).origin,gatewayPath:new URL(this.plugin.unifiedVault.base).pathname.replace(/\/$/,'')+'/shared2/reverse-namespaces/'+job.id+'/'+side+'/couch/',createPouchDB:(name:string,options:any)=>new PouchDB(name,options),resolveAccess:async()=>{if(!await current())throw Error('shared2-account-changed');const result=await this.request('/shared2/reverse-namespaces/'+job.id+'/grant');if(result.status!==200)throw Error(result.json?.error||'shared2-reverse-unavailable');return {...bound,...result.json[side],token:result.sessionToken};}};
  if(side==='shared')return createShared2RemoteFactory({...options,configureEncryption:(database:any,p:any)=>configureShared2Encryption(database,p,(p:any)=>this.keys.get(p))})(bound);
  if(side==='target')return createShared2PrivateTargetRemoteFactory({...options,raw,configureEncryption:(database:any)=>configureShared2PrivateTarget(database,settings,{isCurrent:current})})(bound);
  return createShared2PrivateRemoteFactory({...options,raw,configureDecryption:(database:any)=>configureShared2PrivateSource(database,settings,{isCurrent:current})})(bound);
 }
 async prepareReverse(intent:any,check:any){
  const row=this.catalog?.folders.find((row:any)=>row.id===intent.folder&&row.role==='owner'),record=this.plugin.folders.records.find((r:any)=>r.id===intent.folder),policy=this.plugin.folderPolicies,services=this.plugin.core.services,settings=services.setting.currentSettings(),context=this.context;
  if(!row||!record||row.ownerWorkspace!==this.scope.workspace||record.mount!==intent.mount)throw Error('shared2-owned-folder-required');
  if(!policy?.active||policy.workspace!==this.scope.workspace)throw Error('shared2-private-policy-not-ready');
  const state=await policy.fetchState(settings,true);if(!state||state.phase!=='ready'||state.policy.caseSensitive||policy.remoteOperation)throw Error('shared2-private-policy-not-ready');
  const entry=await this.ensure(row,record.mount),result=await entry.controller.synchronize();if(result.conflicts.length)throw Error('shared2-conflicts-require-review');
  await services.fileProcessing.commitPendingFileEvents();if(!await services.replication.replicate(false))throw Error('shared2-source-not-ready');
  if(!await check()||context!==this.context)throw Error('shared2-job-cancelled');
  const next={...state.policy,folders:state.policy.folders.filter((folder:string)=>folder.toLowerCase()!==intent.mount.toLowerCase())};if(folderPolicyExcludes(next,intent.mount))throw Error('shared2-reverse-private-policy-excludes-mount');const envelope=await encodeFolderPolicy(next,policy.crypto(settings));
  await policy.hold();try{if(!await check()||context!==this.context)throw Error('shared2-job-cancelled');record.shared2Unsharing=true;record.shared2ReverseRequest=intent.requestKey;await this.plugin.folders.save();this.plugin.folders.refresh();}finally{await policy.release();}
  return {database:state.database,revision:state.revision,envelope,protectedRevision:policy.protectedRevision||null};
 }
 async reconcileReverseTransfers(){
  if(!this.reverseTransfers)return;const state=await this.reverseTransfers.snapshot();if(this.reverseTransfers.working)return;let changed=false;
  for(const intent of state.requests){const record=this.plugin.folders.records.find((row:any)=>row.shared2ReverseRequest===intent.requestKey&&row.shared2Scope?.account===this.scope.account&&row.shared2Scope?.workspace===this.scope.workspace);if(!record)continue;const job=state.jobs.find((row:any)=>row.id===intent.job);
   if(job?.state==='completed'){const entry=this.entries.get(record.id);if(entry){await entry.controller.close();await entry.engine.close();this.entries.delete(record.id);}this.plugin.folders.records=this.plugin.folders.records.filter((row:any)=>row!==record);changed=true;}
   else if(job?.state==='cancelled'||intent.terminal&&intent.phase==='cancelled'){record.shared2Unsharing=false;record.shared2ReverseRequest=null;changed=true;}
  }
  if(changed){await this.plugin.folders.save();this.plugin.folders.refresh();}
 }
 async aliasRemote(job:any,side:string,profile:any,raw:boolean,check:any){
  const shared=['shared','sharedSource'].includes(side),context=this.context,settings={...this.plugin.core.services.setting.currentSettings()},identity=(value:any)=>JSON.stringify([value.encrypt,value.passphrase,value.E2EEAlgorithm,value.useDynamicIterationCount,value.usePathObfuscation,value.hashAlg,value.handleFilenameCaseSensitive]);
  if(!shared&&profile.encrypted!==!!settings.encrypt)throw Error('shared2-private-cipher-settings-required');
  const cipher=identity(settings),current=async()=>this.context===context&&await check()&&(shared||cipher===identity(this.plugin.core.services.setting.currentSettings()));
  const bound={kind:shared?'shared':'personal',...this.scope,ownerWorkspace:this.scope.workspace,documentRoot:job.mount,...profile,catalogRevision:0},options={origin:new URL(this.plugin.unifiedVault.base).origin,gatewayPath:new URL(this.plugin.unifiedVault.base).pathname.replace(/\/$/,'')+'/shared2/alias-namespaces/'+job.id+'/'+side+'/couch/',createPouchDB:(name:string,opts:any)=>new PouchDB(name,opts),resolveAccess:async()=>{if(!await current())throw Error('shared2-account-changed');const result=await this.request('/shared2/alias-namespaces/'+job.id+'/grant');if(result.status!==200)throw Error(result.json?.error||'shared2-alias-unavailable');return {...bound,...result.json[side],token:result.sessionToken};}};
  if(shared)return createShared2RemoteFactory({...options,configureEncryption:(db:any,p:any)=>configureShared2Encryption(db,p,(p:any)=>this.keys.get(p))})(bound);
  return createShared2PrivateRemoteFactory({...options,raw,configureDecryption:(db:any)=>configureShared2PrivateSource(db,settings,{isCurrent:current})})(bound);
 }
 async prepareAliases(intent:any,check:any){
  const row=this.catalog?.folders.find((row:any)=>row.id===intent.folder&&row.role==='owner'),record=this.plugin.folders.records.find((record:any)=>record.id===intent.folder),policy=this.plugin.folderPolicies,services=this.plugin.core.services,settings=services.setting.currentSettings(),context=this.context;
  if(!row||!record||record.protocol!==2||record.mount!==intent.mount||row.documentRoot!==intent.mount||row.ownerWorkspace!==this.scope.workspace||record.shared2Unsharing||record.shared2Rekeying||record.shared2Reconciling&&record.shared2AliasRequest!==intent.requestKey)throw Error('shared2-owned-folder-required');
  if(!policy?.active||policy.workspace!==this.scope.workspace)throw Error('shared2-private-policy-not-ready');
  const state=await policy.fetchState(settings,true);if(!state||state.phase!=='ready'||state.policy.caseSensitive||policy.remoteOperation)throw Error('shared2-private-policy-not-ready');
  const entry=await this.ensure(row,record.mount),result=await entry.controller.synchronize();if(result.conflicts.length)throw Error('shared2-conflicts-require-review');
  await services.fileProcessing.commitPendingFileEvents();if(!await services.replication.replicate(false))throw Error('shared2-source-not-ready');
  if(!await check()||context!==this.context)throw Error('shared2-job-cancelled');
  const next=folderPolicyExcludes(state.policy,intent.mount)?state.policy:{...state.policy,folders:[...state.policy.folders,intent.mount]},envelope=await encodeFolderPolicy(next,policy.crypto(settings));
  await policy.hold();try{if(!await check()||context!==this.context)throw Error('shared2-job-cancelled');record.shared2Reconciling=true;record.shared2AliasRequest=intent.requestKey;await this.plugin.folders.save();this.plugin.folders.refresh();}finally{await policy.release();}
  await entry.controller.close();await entry.engine.close();this.entries.delete(row.id);
  return {database:state.database,revision:state.revision,envelope,protectedRevision:policy.protectedRevision||null};
 }
 async reconcileAliasTransfers(){
  if(!this.aliasTransfers||this.aliasTransfers.working)return;const state=await this.aliasTransfers.snapshot();let changed=false;
  for(const intent of state.requests){const record=this.plugin.folders.records.find((record:any)=>record.id===intent.folder&&record.shared2AliasRequest===intent.requestKey&&record.shared2Scope?.account===this.scope.account&&record.shared2Scope?.workspace===this.scope.workspace);if(!record)continue;
   if(intent.targetProfile&&JSON.stringify(record.shared2DeviceTarget)!==JSON.stringify(intent.targetProfile)){record.shared2DeviceTarget=intent.targetProfile;changed=true;}
   const job=state.jobs.find((row:any)=>row.id===intent.job);if(['completed','cancelled'].includes(job?.state)||intent.terminal&&intent.phase==='cancelled'){record.shared2Reconciling=false;record.shared2AliasRequest=null;changed=true;}
  }
  if(changed){await this.plugin.folders.save();this.plugin.folders.refresh();}
 }
 async encryptedRemote(job:any,side:string,profile:any,raw:boolean,check:any){
  const gatewayPath=new URL(this.plugin.unifiedVault.base).pathname.replace(/\/$/,'')+'/shared2/encrypted-namespaces/'+job.id+'/'+side+'/couch/',context=this.context;
  const bound={kind:side==='shared'?'shared':'personal',...this.scope,ownerWorkspace:this.scope.workspace,documentRoot:job.mount,...profile,catalogRevision:0};
  const resolveAccess=async()=>{if(!await check()||this.context!==context)throw Error('shared2-account-changed');const result=await this.request('/shared2/encrypted-namespaces/'+job.id+'/grant');if(result.status!==200)throw Error(result.json?.error||'shared2-encrypted-transfer-unavailable');return {...bound,...result.json[side],token:result.sessionToken};};
  const options={origin:new URL(this.plugin.unifiedVault.base).origin,gatewayPath,createPouchDB:(name:string,options:any)=>new PouchDB(name,options),resolveAccess};
  if(side==='shared')return createShared2RemoteFactory({...options,configureEncryption:(database:any,p:any)=>configureShared2Encryption(database,p,(p:any)=>this.keys.get(p))})(bound);
  const settings={...this.plugin.core.services.setting.currentSettings()};if(!settings.encrypt)throw Error('shared2-private-cipher-settings-required');
  const cipherIdentity=JSON.stringify([settings.encrypt,settings.passphrase,settings.E2EEAlgorithm,settings.useDynamicIterationCount]);const cipherCurrent=async()=>{const latest=this.plugin.core.services.setting.currentSettings();return this.context===context&&await check()&&cipherIdentity===JSON.stringify([latest.encrypt,latest.passphrase,latest.E2EEAlgorithm,latest.useDynamicIterationCount]);};
  return createShared2PrivateRemoteFactory({...options,raw,configureDecryption:(database:any)=>configureShared2PrivateSource(database,settings,{isCurrent:cipherCurrent})})(bound);
 }
 async prepareEncryptedShare(intent:any,check:any){
  const policy=this.plugin.folderPolicies,services=this.plugin.core.services,settings=services.setting.currentSettings(),context=this.context;
  if(!policy?.active||policy.workspace!==this.scope.workspace||!settings.encrypt)throw Error('shared2-private-cipher-settings-required');
  const current=await policy.fetchState(settings,true);if(!current||current.phase!=='ready'||current.policy.caseSensitive||policy.remoteOperation)throw Error('shared2-private-policy-not-ready');
  await services.fileProcessing.commitPendingFileEvents();if(!await services.replication.replicate(false))throw Error('shared2-source-not-ready');
  if(!await check()||context!==this.context)throw Error('shared2-job-cancelled');
  const next={...current.policy,folders:[...current.policy.folders,intent.mount]},envelope=await encodeFolderPolicy(next,policy.crypto(settings));
  // validateMount requires an import-ready policy; our own hold deliberately
  // removes that readiness. Validate before acquiring it, as in plain share.
  const mounts=JSON.stringify(this.plugin.folders.records.map((row:any)=>[row.id,row.mount]));
  if(!this.plugin.folders.records.some((row:any)=>row.shared2EncryptedRequest===intent.requestKey))this.plugin.folders.validateMount(intent.mount);
  await policy.hold();try{
   if(!await check()||context!==this.context)throw Error('shared2-job-cancelled');
   let record=this.plugin.folders.records.find((row:any)=>row.shared2EncryptedRequest===intent.requestKey);
   if(!record){if(JSON.stringify(this.plugin.folders.records.map((row:any)=>[row.id,row.mount]))!==mounts)throw Error('shared2-source-not-ready');record={id:crypto.randomUUID().replace(/-/g,''),mount:intent.mount,role:'owner',shared2Preparing:true,shared2Creating:true,shared2EncryptedRequest:intent.requestKey,shared2Scope:{...this.scope}};this.plugin.folders.records.push(record);await this.plugin.folders.save();this.plugin.folders.refresh();}
  }finally{await policy.release();}
  return {database:current.database,revision:current.revision,envelope,protectedRevision:policy.protectedRevision||null};
 }
 async reconcileEncryptedTransfers(){
  if(!this.encryptedTransfers)return;const state=await this.encryptedTransfers.snapshot();let changed=false;
  for(const intent of state.requests){const record=this.plugin.folders.records.find((row:any)=>row.shared2EncryptedRequest===intent.requestKey&&row.shared2Scope?.account===this.scope.account&&row.shared2Scope?.workspace===this.scope.workspace);if(!record)continue;const job=state.jobs.find((row:any)=>row.id===intent.job);
   if(job&&record.id!==job.folder){record.id=job.folder;changed=true;}
   if(intent.targetProfile&&JSON.stringify(record.shared2DeviceTarget)!==JSON.stringify(intent.targetProfile)){record.shared2DeviceTarget=intent.targetProfile;changed=true;}
   if(job?.state==='completed'&&record.shared2Creating){record.shared2Creating=false;changed=true;}
   if(!this.encryptedTransfers.working&&(job?.state==='cancelled'||intent.terminal&&intent.phase==='cancelled')){this.plugin.folders.records=this.plugin.folders.records.filter((row:any)=>row!==record);changed=true;}
  }
  if(changed){await this.plugin.folders.save();this.plugin.folders.refresh();}
 }
 async migrationEngine(profile:any){
  const personal={...this.plugin.core.services.setting.currentSettings()},options=['hashAlg','chunkSplitterVersion','customChunkSize','minimumChunkSize','useEden','maxChunksInEden','maxTotalLengthInEden','handleFilenameCaseSensitive','enableCompression'];
  return createShared2LocalEngineFactory({namespace:'shared2-vault',migrationMode:true,createPouchDB:(name:string,options:any)=>new PouchDB(name,options),settingsFor:async(p:any)=>({database:p.database,generation:p.generation,settings:{...(p.kind==='personal'?Object.fromEntries(options.filter(key=>personal[key]!==undefined).map(key=>[key,personal[key]])):{hashAlg:'sha1',chunkSplitterVersion:'v1',useEden:false}),disableWorkerForGeneratingChunks:true,disableWorkerForDecrypting:true}}),keyProvider:(p:any)=>this.keys.get(p),personalEncryptionFor:async()=>personal})(profile);
 }
 async migrationRemote(job:string,side:string,profile:any){return createShared2RemoteFactory({origin:new URL(this.plugin.unifiedVault.base).origin,gatewayPath:new URL(this.plugin.unifiedVault.base).pathname.replace(/\/$/,'')+'/shared2/device-jobs/'+job+'/'+side+'/couch/',createPouchDB:(name:string,options:any)=>new PouchDB(name,options),resolveAccess:async()=>{const result=await this.request('/shared2/device-jobs/'+job+'/grant');if(result.status!==200)throw Error(result.json?.error||'shared2-device-jobs-unavailable');return {...result.json[side],token:result.sessionToken};},configureEncryption:(database:any,p:any)=>configureShared2Encryption(database,p,(p:any)=>this.keys.get(p))})(profile);}
 async prepareDeviceTransfer(folder:string,requestKey:string,options:any={}){
  const row=this.catalog.folders.find((row:any)=>row.id===folder),record=this.plugin.folders.records.find((record:any)=>record.id===folder);
  if(!row||row.role!=='owner'||row.ownerWorkspace!==this.scope.workspace||!record||record.protocol!==2||record.shared2Unsharing||record.shared2Reconciling||record.shared2Revoked)throw Error('shared2-source-not-ready');
  if(record.shared2Rekeying){if(record.shared2DeviceRequest!==requestKey||!record.shared2DeviceSource)throw Error('shared2-operation-active');if(record.shared2DevicePrepared)return record.shared2DeviceSource;}
  const restore=options.operation==='restore';if(restore&&(!this.retentionFor(row)?.canRestore||!record.shared2CacheEpoch))throw Error('shared2-restore-cache-required');
  const source={...this.profile(row),cacheEpoch:record.shared2CacheEpoch};record.shared2Rekeying=true;record.shared2DeviceRequest=requestKey;record.shared2DeviceSource=source;record.shared2DevicePrepared=false;await this.plugin.folders.save();this.plugin.folders.refresh();
  if(restore){const previous=this.entries.get(folder);if(previous){await previous.controller.close();await previous.engine.close();this.entries.delete(folder);}record.shared2DevicePrepared=true;await this.plugin.folders.save();return source;}
  const entry=await this.ensure(row,record.mount),result=await entry.controller.synchronize();if(result.conflicts.length)throw Error('shared2-conflicts-require-review');await entry.controller.close();await entry.engine.close();this.entries.delete(folder);record.shared2DevicePrepared=true;await this.plugin.folders.save();return source;
 }
 async reconcileDeviceTransfers(){
  const state=await this.deviceTransfers.snapshot();let changed=false;
  for(const intent of state.requests){const record=this.plugin.folders.records.find((record:any)=>record.id===intent.folder&&record.shared2DeviceRequest===intent.requestKey);if(!record)continue;
   if(intent.targetProfile&&JSON.stringify(record.shared2DeviceTarget)!==JSON.stringify(intent.targetProfile)){record.shared2DeviceTarget=intent.targetProfile;changed=true;}
   const job=state.jobs.find((job:any)=>job.id===intent.job);if((['completed','cancelled'].includes(job?.state)||intent.terminal&&intent.phase==='cancelled')&&!this.deviceTransfers.working){record.shared2Rekeying=false;record.shared2DeviceRequest=null;record.shared2DeviceSource=null;record.shared2DevicePrepared=false;changed=true;}
  }
  if(changed){await this.plugin.folders.save();this.plugin.folders.refresh();}
 }
 async ensure(row:any,mount:string){
  const previous=this.entries.get(row.id);if(previous)return previous;
  if(!recordCache(this.plugin.folders.records,row.id))throw Error('shared2-cache-scope-unavailable');
  const profile={kind:'shared',...this.scope,cacheEpoch:recordCache(this.plugin.folders.records,row.id),authorityEpoch:row.authorityEpoch,membershipEpoch:row.membershipEpoch,folder:row.id,ownerWorkspace:row.ownerWorkspace,database:row.database,generation:row.generation,revision:row.revision,catalogRevision:this.catalog.revision,role:row.role,encrypted:row.encrypted,keyEpoch:row.keyEpoch,documentRoot:row.documentRoot};
  const checked=async()=>{if(this.disposed||this.signature(await this.session())!==this.context)return false;const current=this.catalog?.folders.find((item:any)=>item.id===row.id);return !!current&&this.version(current)===this.version(row);};
  const getSession=async()=>(await this.session()).session,client=createShared2CatalogClient({request:(...args:any[])=>this.request(args[0],args[1]),getSession});
  const openRemote=createShared2RemoteFactory({origin:new URL(this.plugin.unifiedVault.base).origin,gatewayPath:new URL(this.plugin.unifiedVault.base).pathname.replace(/\/$/,'')+'/shared2/couch/',createPouchDB:(name:string,options:any)=>new PouchDB(name,options),resolveAccess:(p:any)=>client.resolveAccess(p),configureEncryption:(db:any,p:any)=>configureShared2Encryption(db,p,(p:any)=>this.keys.get(p))});
  const factory=createShared2LocalEngineFactory({namespace:'shared2-vault',createPouchDB:(name:string,options:any)=>new PouchDB(name,options),settingsFor:async(p:any)=>({database:p.database,generation:p.generation,settings:{hashAlg:'sha1',chunkSplitterVersion:'v1',useEden:false,disableWorkerForGeneratingChunks:true,disableWorkerForDecrypting:true}}),keyProvider:(p:any)=>this.keys.get(p),openRemote,accessCheck:checked});
  const engine=await factory(profile),adapter=this.plugin.app.vault.adapter;
  const readStream=(path:string)=>this.readStream(path);
  const readBlob=async(path:string)=>{const response=await fetch(adapter.getResourcePath(path),{cache:'no-store'});if(!response.ok)throw Error('shared2-native-file-read-unavailable');return response.blob();};
  try{
   const disk=createShared2VaultDisk({adapter,mount,privateRoot:'ArcaLink Shared/shared2/'+this.scope.account+'/'+this.scope.workspace+'/'+row.id,listFiles:async(root:string)=>this.plugin.app.vault.getFiles().filter((file:any)=>file.path.startsWith(root+'/')).map((file:any)=>file.path),readStream,readBlob,beforeCommit:async(_path:string,operation:()=>Promise<any>)=>{if(!await checked())throw Error('shared2-vault-lease-rejected');return operation();}});
   await disk.recover();
   const record=this.plugin.folders.records.find((r:any)=>r.id===row.id);
   if(record?.shared2LegacyVersions?.length&&record.shared2LegacyImportApprovedEpoch===profile.cacheEpoch&&record.shared2LegacyImportedEpoch!==profile.cacheEpoch){
    await engine.synchronize();const versions:any[]=[];
    for(const saved of record.shared2LegacyVersions){const state=await this.store(saved.storeName).load();if(!state||state.scope?.account!==this.scope.account||state.scope?.workspace!==this.scope.workspace||state.folder!==row.id||state.root!==saved.root)throw Error('shared2-legacy-cache-scope-mismatch');versions.push(...state.versions);}
    const result=await importShared2LegacyTexts({versions,documentRoot:row.documentRoot,engine,role:row.role,hashStream:hashShared2Stream,readBackup:async(path:string)=>{if(!record.shared2LegacyVersions.some((saved:any)=>path.startsWith(saved.root+'/objects/')))throw Error('shared2-legacy-cache-scope-mismatch');return readBlob(path);},assertCurrent:async()=>{if(!await checked())throw Error('shared2-vault-lease-rejected');}});
    if(!result.pending){record.shared2LegacyImportedEpoch=profile.cacheEpoch;await this.plugin.folders.save();}
   }
   const controller=createShared2VaultController({profile,engine,disk,store:this.store('ledger-'+row.id+'-'+row.generation+'-'+profile.cacheEpoch),checkLease:checked,hashStream:hashShared2Stream,canUpload:()=>!record?.shared2ReconcileAuthority,onState:(state:any)=>{const e=this.entries.get(row.id);if(e)e.state=state;}});
   if(!await checked())throw Error('shared2-vault-lease-rejected');
   const entry={version:this.version(row),controller,engine,state:{state:'idle'}};this.entries.set(row.id,entry);return entry;
  }catch(error){await engine.close();throw error;}
 }
 createNamespace(){chooseSharedFolder(this.plugin.app,{title:'Поделиться папкой',description:'Папка станет общей. Содержимое переносится в фоне, пока Obsidian открыт.',action:'Поделиться папкой',unavailable:(mount:string)=>{try{this.plugin.folders.validateMount(mount);return '';}catch(error:any){return error.message;}},select:async(mount:string)=>{this.plugin.folders.validateMount(mount);if(this.plugin.core.services.setting.currentSettings().encrypt){await this.encryptedTransfers.plan(mount);void this.encryptedTransfers.step();new Notice('Задание сохранено. Зашифрованный перенос продолжится в фоне.');return;}const intent=await this.namespaceJobs.plan('share',mount);void this.prepareNamespace(intent);new Notice('Задание сохранено. Подготовка и перенос продолжатся в фоне.');}});}
 async beginUnshare(row:any,record:any){if(record.shared2Reconciling)throw Error('shared2-operation-active');if(row.encrypted||this.plugin.core.services.setting.currentSettings().encrypt){await this.reverseTransfers.plan(row.id,record.mount);void this.poll();return;}const intent=await this.namespaceJobs.plan('unshare',row.id);void this.prepareNamespace(intent);}
 prepareNamespace(intent:any){
  const previous=this.namespacePreparing.get(intent.requestKey);if(previous)return previous;
  const context=this.context,jobs=this.namespaceJobs,task=(async()=>{
   const current=async()=>{if(this.disposed||this.context!==context||this.signature(await this.session())!==context)throw Error('shared2-account-changed');const state=await jobs.snapshot();if(state.requests.find((row:any)=>row.requestKey===intent.requestKey)?.cancelRequested)throw Error('shared2-job-cancelled');};
   await jobs.mark(intent.requestKey,'preparing');await current();
   if(intent.kind==='share'){
    let record=this.plugin.folders.records.find((r:any)=>r.shared2NamespaceRequest===intent.requestKey);
    if(!record){
     this.plugin.folders.validateMount(intent.value);const policy=this.plugin.folderPolicies,services=this.plugin.core.services,settings=services.setting.currentSettings();
     if(!policy?.active||policy.workspace!==this.scope.workspace||settings.encrypt)throw Error('shared2-device-rekey-required');
     await policy.fetchState(settings,true);await current();await services.fileProcessing.commitPendingFileEvents();
     if(!await services.replication.replicate(false))throw Error('shared2-source-not-ready');await current();
     const database=services.database.localDatabaseDirect.localDatabase,sequence=(await database.info()).update_seq;
     await policy.hold();
     try{await current();if((await database.info()).update_seq!==sequence)throw Error('shared2-source-not-ready');record={id:crypto.randomUUID().replace(/-/g,''),mount:intent.value,role:'owner',shared2Preparing:true,shared2Creating:true,shared2NamespaceRequest:intent.requestKey,shared2Scope:{...this.scope}};this.plugin.folders.records.push(record);await this.plugin.folders.save();this.plugin.folders.refresh();}
     finally{await policy.release();}
    }
    await current();const job=await jobs.submit(intent);await current();record.id=job.folder;record.shared2NamespaceJob=job.id;await this.plugin.folders.save();
   }else{
    const row=this.catalog.folders.find((row:any)=>row.id===intent.value&&row.role==='owner'),record=this.plugin.folders.records.find((r:any)=>r.id===intent.value);
    if(!row||!record)throw Error('shared2-owned-folder-required');if(row.ownerWorkspace!==this.scope.workspace)throw Error('shared2-owner-workspace-required');
    if(!record.shared2Unsharing){const entry=await this.ensure(row,record.mount),result=await entry.controller.synchronize();if(result.conflicts.length)throw Error('shared2-conflicts-require-review');await current();record.shared2Unsharing=true;record.shared2NamespaceRequest=intent.requestKey;await this.plugin.folders.save();this.plugin.folders.refresh();}
    await current();await jobs.submit(intent);
   }
   await this.poll();
  })().catch(async(error:any)=>{if(!this.disposed&&this.context===context&&!(await jobs.snapshot()).requests.find((row:any)=>row.requestKey===intent.requestKey)?.cancelRequested){await jobs.mark(intent.requestKey,'error',error.code||error.message).catch(()=>{});new Notice(shared2Message(error));}}).finally(()=>{this.namespacePreparing.delete(intent.requestKey);this.redraw();});
  this.namespacePreparing.set(intent.requestKey,task);return task;
 }
 async cancelNamespacePreparation(intent:any){
  const result=await this.namespaceJobs.cancelIntent(intent);
  if(result.cancelled){const record=this.plugin.folders.records.find((r:any)=>r.shared2NamespaceRequest===intent.requestKey&&r.shared2Scope?.account===this.scope.account&&r.shared2Scope?.workspace===this.scope.workspace);if(record){if(record.shared2Creating)this.plugin.folders.records=this.plugin.folders.records.filter((r:any)=>r!==record);else{record.shared2Unsharing=false;record.shared2NamespaceRequest=null;}await this.plugin.folders.save();this.plugin.folders.refresh();}}
  await this.poll();
 }
 async reconcileNamespaceJobs(){
  let changed=false;

  for(const job of this.namespaceState.jobs||[]){
   if(job.workspace!==this.scope.workspace)continue;
   const record=this.plugin.folders.records.find((r:any)=>r.id===job.folder||r.shared2NamespaceRequest===job.requestKey);
   if(!record||record.shared2Scope?.account!==this.scope.account||record.shared2Scope?.workspace!==this.scope.workspace)continue;
   if(job.kind==='share'&&record.shared2Creating&&record.shared2NamespaceRequest===job.requestKey){if(record.id!==job.folder||record.shared2NamespaceJob!==job.id){record.id=job.folder;record.shared2NamespaceJob=job.id;changed=true;}if(job.state==='completed'){record.shared2Creating=false;changed=true;}}
   if((job.kind==='share'&&job.state==='cancelled'&&record.shared2Creating)||(job.kind==='unshare'&&job.state==='completed')){
    const entry=this.entries.get(record.id);if(entry){await entry.controller.close();await entry.engine.close();this.entries.delete(record.id);}
    this.plugin.folders.records=this.plugin.folders.records.filter((r:any)=>r!==record);changed=true;
   }else if(job.kind==='unshare'&&job.state==='cancelled'&&record.shared2Unsharing){record.shared2Unsharing=false;record.shared2NamespaceRequest=null;changed=true;}
  }
  if(changed){await this.plugin.folders.save();this.plugin.folders.refresh();}
 }
 async showRecoveries(record:any){
  const context=this.context,root='ArcaLink Shared/shared2/'+this.scope.account+'/'+this.scope.workspace+'/'+record.id;
  if(record.shared2Scope?.account!==this.scope.account||record.shared2Scope?.workspace!==this.scope.workspace)throw Error('shared2-account-changed');
  const names=new Set<string>(record.shared2RetiredLedgers||[]);if(record.shared2CacheEpoch)names.add('ledger-'+record.id+'-'+record.shared2Generation+'-'+record.shared2CacheEpoch);
  const versions:any[]=[],seen=new Set<string>();
  for(const name of names){if(!new RegExp('^ledger-'+record.id+'-[1-9][0-9]*-[a-f0-9]{32}$').test(name))throw Error('shared2-vault-ledger-scope-mismatch');const ledger=await this.store(name).load();for(const item of ledger?.recovery||[]){if(!safeRelative(item.path)||!(/^[a-f0-9]{64}$/).test(item.hash)||item.backup!==root+'/backups/'+item.hash)throw Error('shared2-backup-proof-mismatch');const key=item.path+':'+item.hash;if(!seen.has(key)){seen.add(key);versions.push(item);}}}
  const dialog=new Modal(this.plugin.app);dialog.contentEl.createEl('h3',{text:'Сохранённые локальные версии'});dialog.contentEl.createEl('p',{text:versions.length?'Восстановление создаёт отдельный локальный файл для сверки.':'Сохранённых версий пока нет.'});
  for(const item of versions)new Setting(dialog.contentEl).setName(item.path).addButton(button=>button.setButtonText('Восстановить отдельно').onClick(async()=>{button.setDisabled(true);try{if(this.disposed||this.context!==context||this.signature(await this.session())!==context)throw Error('shared2-account-changed');if((await this.hashFile(item.backup)).sha256!==item.hash)throw Error('shared2-backup-proof-mismatch');const destination=root+'/recovered/'+crypto.randomUUID()+'/'+item.path;await this.mkdirs(destination.split('/').slice(0,-1).join('/'));await this.plugin.app.vault.adapter.copy(item.backup,destination);if((await this.hashFile(destination)).sha256!==item.hash)throw Error('shared2-backup-proof-mismatch');new Notice('Локальная версия восстановлена: '+destination,15000);}catch(error:any){new Notice(shared2Message(error));}finally{button.setDisabled(false);}}));
  dialog.open();
 }
 async mkdirs(root:string){let path='';for(const part of root.split('/')){path+=(path?'/':'')+part;if(!await this.plugin.app.vault.adapter.exists(path))try{await this.plugin.app.vault.adapter.mkdir(path);}catch(error){if(!await this.plugin.app.vault.adapter.exists(path))throw error;}}}
 async readStream(path:string){const adapter=this.plugin.app.vault.adapter;const response=await fetch(adapter.getResourcePath(path),{cache:'no-store'});if(!response.ok||!response.body)throw Error('shared2-native-file-read-unavailable');return response.body;}
 async hashFile(path:string){return hashShared2Stream(await this.readStream(path));}
 async flushLegacy(record:any){
  if(this.plugin.folders.entries.get(record.id)?.denied)await this.drainLegacy(record.id);
  const e=await this.plugin.folders.ensure(record,true);if(e.denied)throw Error('shared2-source-not-ready');
  await Promise.all([e.changing,e.projecting,e.provider?.transferQueue].filter(Boolean));const deadline=Date.now()+30000;
  while(!e.provider?.synced||e.provider.hasUnsyncedChanges){if(this.disposed||Date.now()>deadline)throw Error('shared2-source-not-ready');await new Promise(resolve=>window.setTimeout(resolve,100));}
 }
 migrate(id:string){
  const previous=this.preparations.get(id);if(previous?.promise)return previous.promise;
  const entry=previous||{};this.preparations.set(id,entry);const task=this.prepareMigration(id);entry.promise=task;task.then(()=>{const entry=this.preparations.get(id);if(entry)entry.promise=null;},()=>{const entry=this.preparations.get(id);if(entry)entry.promise=null;});return task;
 }
 async prepareMigration(id:string){
  const record=this.plugin.folders.records.find((record:any)=>record.id===id);if(!record||record.protocol===2||record.role!=='owner'&&!record.shared2Preparing)throw Error('shared2-owned-legacy-folder-required');
  if(record.shared2Scope&&(record.shared2Scope.account!==this.scope.account||record.shared2Scope.workspace!==this.scope.workspace))throw Error('shared2-account-changed');
  if(!record.shared2BackupId){record.shared2BackupId=crypto.randomUUID().replace(/-/g,'');await this.plugin.folders.save();}
  const expectedContext=this.context,privateRoot='ArcaLink Shared/shared2/'+this.scope.account+'/'+this.scope.workspace+'/'+id+'/migration-'+record.shared2BackupId;
  const worker=createShared2MigrationPreparation({scope:this.scope,folder:id,mount:record.mount,privateRoot,store:this.store('prepare-'+id+'-'+record.shared2BackupId),adapter:this.plugin.app.vault.adapter,listFiles:async()=>this.plugin.app.vault.getFiles().filter((file:any)=>file.path.startsWith(record.mount+'/')).map((file:any)=>file.path),hashFile:(path:string)=>this.hashFile(path),flushSource:()=>this.flushLegacy(record),pauseEditing:async(value:boolean)=>{record.shared2Preparing=value;record.shared2Scope={...this.scope};await this.plugin.folders.save();this.plugin.folders.refresh();},recordJob:async(job:any,state:any)=>{record.shared2Job=job.id;record.shared2Backup=state.privateRoot;await this.plugin.folders.save();},drainSource:()=>this.drainLegacy(id),admit:async(folder:string,known?:string)=>{if(!known)return this.jobs.admit(folder);const response=await this.request('/shared2/jobs/'+known);if(response.status!==200)throw Error('shared2-job-unavailable');return response.json;},assertCurrent:async()=>!this.disposed&&this.context===expectedContext&&this.signature(await this.session())===expectedContext,onProgress:(state:any)=>{const entry=this.preparations.get(id);if(entry)entry.state=state;this.redraw();}});
  const entry=this.preparations.get(id);if(entry)entry.worker=worker;
  const job=await worker.start();new Notice('Перенос запущен в фоне. Прогресс показан в настройках общих папок.');await this.poll();return job;
 }

 redraw(){for(const panel of this.panels){if(!panel.isConnected)this.panels.delete(panel);else this.render(panel);}}
 render(container:HTMLElement,gate?:(control:HTMLElement)=>void){
  if(!this.enabled||!this.catalog)return false;if(gate)this.panelGates.set(container,gate);const tariffGate=this.panelGates.get(container)||(()=>{});this.panels.add(container);container.empty();
  container.createEl('h3',{text:'Общие папки'});container.createEl('p',{text:'Содержимое передаётся в фоне, пока Obsidian открыт. Закрытие настроек не отменяет задание.'});
  if(this.warning)container.createEl('p',{text:shared2Message(this.warning)});
  new Setting(container).setName('Новая общая папка').addButton(button=>{button.setButtonText('Поделиться папкой').onClick(()=>this.createNamespace());tariffGate(button.buttonEl);});
  new Setting(container).setName('Сводная информация').addButton(button=>button.setButtonText('Обновить').onClick(()=>{void (this.jobs?this.poll():this.init());}));
  for(const intent of this.aliasState.requests||[])if(!intent.terminal){const job=this.aliasState.jobs.find((row:any)=>row.id===intent.job);new Setting(container).setName('Сверка прежних копий: '+intent.mount).setDesc(intent.error?shared2Message(intent.error):job?.error?shared2Message(job.error):shared2Phase(job?.state||intent.phase)).addButton(button=>button.setButtonText('Повторить').setDisabled(!intent.error&&!job?.error).onClick(()=>{void this.aliasTransfers.retry(intent.job||intent.requestKey).then(()=>this.poll()).catch((error:any)=>new Notice(shared2Message(error)));})).addButton(button=>button.setButtonText('Отменить').setDisabled(!!intent.cancelRequested||job&&!job.canCancel).onClick(()=>{void this.aliasTransfers.cancel(intent.job||intent.requestKey).then(()=>this.poll()).catch((error:any)=>new Notice(shared2Message(error)));}));}
  for(const intent of this.aliasState.requests||[])if(!intent.terminal&&intent.error==='shared2-alias-union-review-required')new Setting(container).setName('Совпадающих файлов: '+(intent.aliasReview?.files||0)).setDesc('В личной и общей базе сохранились разные версии. После объединения останутся обе доступные истории и конфликтующие варианты для сверки.').addButton(button=>button.setButtonText('Сохранить обе истории').onClick(()=>this.confirm('Объединить прежние копии?','Сначала проверятся обе истории. Исходные базы будут заменены только после полной сверки; несовместимые ревизии остановят перенос.',async()=>{await this.aliasTransfers.approveAliases(intent.job);await this.poll();})));
  for(const intent of this.reverseState.requests||[])if(!intent.terminal){const job=this.reverseState.jobs.find((row:any)=>row.id===intent.job);new Setting(container).setName('Прекращение общего доступа: '+intent.mount).setDesc(intent.error?shared2Message(intent.error):job?.error?shared2Message(job.error):shared2Phase(job?.state||intent.phase)).addButton(button=>button.setButtonText('Повторить').setDisabled(!intent.error&&!job?.error).onClick(()=>{void this.reverseTransfers.retry(intent.job||intent.requestKey).then(()=>this.poll()).catch((error:any)=>new Notice(shared2Message(error)));})).addButton(button=>button.setButtonText('Отменить').setDisabled(!!intent.cancelRequested||job&&!job.canCancel).onClick(()=>{void this.reverseTransfers.cancel(intent.job||intent.requestKey).then(()=>this.poll()).catch((error:any)=>new Notice(shared2Message(error)));}));}
  for(const intent of this.reverseState.requests||[])if(!intent.terminal&&intent.error==='shared2-reverse-private-aliases-require-reconciliation')new Setting(container).setName('Найдены прежние личные копии: '+(intent.aliasReview?.files||0)).setDesc('Общая и личная папки содержат свои версии. При объединении сохраняются обе доступные истории; расходящиеся версии потребуют сверки.').addButton(button=>button.setButtonText('Сохранить обе истории').onClick(()=>this.confirm('Объединить истории папки?','Личные и общие версии сохранятся. Совпадающая ревизия с разными данными не будет перезаписана; перенос остановится для отдельной сверки.',async()=>{await this.reverseTransfers.approveAliases(intent.job);await this.poll();})));
  for(const intent of this.encryptedState.requests||[])if(!intent.terminal){const job=this.encryptedState.jobs.find((row:any)=>row.id===intent.job);new Setting(container).setName('Зашифрованный перенос: '+intent.mount).setDesc(intent.error?shared2Message(intent.error):job?.error?shared2Message(job.error):shared2Phase(job?.state||intent.phase)).addButton(button=>button.setButtonText('Повторить').setDisabled(!intent.error&&!job?.error).onClick(()=>{void this.encryptedTransfers.retry(intent.job||intent.requestKey).then(()=>this.poll()).catch((error:any)=>new Notice(shared2Message(error)));})).addButton(button=>button.setButtonText('Отменить').setDisabled(!!intent.cancelRequested||job&& !job.canCancel).onClick(()=>{void this.encryptedTransfers.cancel(intent.job||intent.requestKey).then(()=>this.poll()).catch((error:any)=>new Notice(shared2Message(error)));}));}
  for(const intent of this.namespaceState.requests||[])if(!intent.terminal&&!intent.job)new Setting(container).setName((intent.kind==='share'?'Подготовка папки: ':'Прекращение общего доступа: ')+intent.value).setDesc(intent.error?shared2Message(intent.error):shared2Phase(intent.phase)).addButton(button=>button.setButtonText('Повторить').setDisabled(intent.phase!=='error').onClick(()=>{if(intent.cancelRequested)void this.cancelNamespacePreparation(intent).catch((error:any)=>new Notice(shared2Message(error)));else void this.prepareNamespace(intent);})).addButton(button=>button.setButtonText('Отменить подготовку').setDisabled(!!intent.cancelRequested).onClick(()=>{void this.cancelNamespacePreparation(intent).catch((error:any)=>new Notice(shared2Message(error)));}));
  for(const intent of this.deviceState.requests||[]){if(intent.terminal)continue;const job=this.deviceState.jobs.find((job:any)=>job.id===intent.job);new Setting(container).setName((intent.operation==='restore'?'Восстановление: ':'Шифрование: ')+(this.plugin.folders.records.find((record:any)=>record.id===intent.folder)?.mount||intent.folder)).setDesc(shared2Phase(job?.state||intent.phase)+(intent.error?' · '+shared2Message(intent.error):'')).addButton(button=>button.setButtonText('Повторить').setDisabled(!intent.error&&job?.state!=='error').onClick(()=>{void this.deviceTransfers.retry(intent.job||intent.requestKey).then(()=>this.poll()).catch((error:any)=>new Notice(shared2Message(error)));})).addButton(button=>button.setButtonText('Отменить').setDisabled(job&&!job.canCancel).onClick(()=>this.confirm('Отменить смену ключа?','До переключения сохраняется прежняя общая папка.',async()=>{await this.deviceTransfers.cancel(intent.job||intent.requestKey);await this.poll();})));}
  for(const job of this.namespaceState.jobs||[]){const card=container.createDiv({cls:'arcalink-shared2-card'});new Setting(card).setName((job.kind==='share'?'Поделиться папкой: ':'Прекратить общий доступ: ')+job.mount).setDesc(shared2Phase(job.state)+' · '+job.done+' / '+job.total+(job.error?' · '+shared2Message(job.error):'')).addButton(button=>button.setButtonText('Повторить').setDisabled(job.state!=='error').onClick(()=>{void this.namespaceJobs.retry(job.id).then(()=>this.poll()).catch((error:any)=>new Notice(shared2Message(error)));})).addButton(button=>button.setButtonText('Отменить').setDisabled(!job.canCancel).onClick(()=>this.confirm('Отменить перенос?','Исходная папка и локальные файлы сохранятся.',async()=>{await this.namespaceJobs.cancel(job.id);await this.poll();})));}
  for(const [id,entry] of this.preparations)if(entry.state&&entry.state.phase!=='admitted'&&!this.jobState.jobs?.some((job:any)=>job.folder===id))new Setting(container).setName('Подготовка: '+(this.plugin.folders.records.find((r:any)=>r.id===id)?.mount||'папка')).setDesc(shared2Phase(entry.state.phase)+' · '+entry.state.done+' / '+entry.state.total);
  for(const job of this.jobState.jobs||[]){const card=container.createDiv({cls:'arcalink-shared2-card'});new Setting(card).setName('Перенос папки').setDesc(shared2Phase(job.state)+' · '+job.done+' / '+job.total+(job.path?' · '+job.path:'' )).addButton(button=>button.setButtonText('Повторить').setDisabled(job.state!=='error').onClick(()=>{void this.jobs.retry(job.id).catch((e:any)=>new Notice(shared2Message(e)));})).addButton(button=>button.setButtonText('Отменить перенос').setDisabled(!job.canCancel).onClick(()=>{void this.jobs.cancel(job.id).catch((e:any)=>new Notice(shared2Message(e)));}));}
  for(const record of this.plugin.folders.records){
   if(record.shared2Left)continue;
   const cancelled=this.jobState.jobs?.find((job:any)=>job.id===record.shared2Job&&job.state==='cancelled');if(cancelled&&record.shared2Preparing)new Setting(container).setName('Перенос отменён: '+record.mount).addButton(button=>button.setButtonText('Возобновить прежнее подключение').onClick(()=>this.confirm('Возобновить прежнее подключение?','Сначала сохранится резервная копия текущих локальных файлов для сверки. Затем подключится прежняя общая папка.',()=>this.resumeCancelled(record))));
   const row=this.catalog.folders.find((row:any)=>row.id===record.id),card=container.createDiv({cls:'arcalink-shared2-card'});
   const setting=new Setting(card).setName('Папка: '+record.mount).setDesc(row?(row.role==='owner'?'Владелец':row.role==='editor'?'Редактор':'Читатель')+' · '+shared2Phase(this.entries.get(row.id)?.state?.state):'Доступ приостановлен');
   if(record.protocol!==2&&!record.shared2Job&&record.role==='owner')setting.addButton(button=>{button.setButtonText('Перенести папку').onClick(()=>{void this.migrate(record.id).catch((e:any)=>new Notice(shared2Message(e)));});tariffGate(button.buttonEl);} );
   if(row)card.createEl('p',{text:'Владелец папки: '+(row.ownerLabel||row.owner)});
   const retention=row&&this.retentionFor(row);if(retention&&retention.state!=='active')new Setting(card).setName(retention.state==='purged'?'Серверная копия удалена':'Хранение серверной копии').setDesc(retention.state==='purged'?'Локальные файлы сохранены. Для восстановления нужен полный локальный кэш с историей.':retention.retainedUntil?'Срок хранения: '+new Date(retention.retainedUntil).toLocaleString():shared2Phase(retention.state)).addButton(button=>button.setButtonText('Восстановить из локальной копии').setDisabled(!retention.canRestore||row.ownerWorkspace!==this.scope.workspace||!!record.shared2Rekeying||!!record.shared2Reconciling||!!record.shared2Unsharing).onClick(()=>this.confirm('Восстановить серверную копию?','Будет проверена полнота сохранённого кэша и его истории. При недостающих версиях восстановление остановится. Для зашифрованной папки будет создан новый ключ; участникам потребуется передать его заново.',async()=>{await this.deviceTransfers.plan(row.id,'restore');await this.poll();})));
   if(record.protocol===2)new Setting(card).setName('Сохранённые локальные версии').setDesc('Версии, сохранённые перед заменой файлов или сменой прав.').addButton(button=>button.setButtonText('Посмотреть').onClick(()=>{void this.showRecoveries(record).catch((error:any)=>new Notice(shared2Message(error)));}));
   if(row&&record.shared2Revoked)new Setting(card).setName('Доступ предоставлен повторно').addButton(button=>button.setButtonText('Восстановить подключение').onClick(()=>this.confirm('Восстановить подключение?','Сохранённые локальные файлы будут сверены с общей папкой.',async()=>{if(record.shared2CacheEpoch){record.shared2RetiredLedgers??=[];record.shared2RetiredLedgers.push('ledger-'+row.id+'-'+(record.shared2Generation||row.generation)+'-'+record.shared2CacheEpoch);}record.shared2Revoked=false;record.shared2ReconcileAuthority=true;record.shared2AuthorityEpoch=row.authorityEpoch;record.shared2MembershipEpoch=row.membershipEpoch;record.shared2Generation=row.generation;record.shared2Database=row.database;record.shared2KeyEpoch=row.keyEpoch;record.shared2CacheEpoch=crypto.randomUUID().replace(/-/g,'');record.role=row.role;await this.plugin.folders.save();await this.poll();})));
   if(row&&record.protocol===2&&!record.shared2Revoked){
    if(record.shared2LegacyVersions?.length&&record.shared2LegacyImportedEpoch!==record.shared2CacheEpoch)new Setting(card).setName('Сохранены локальные версии прежнего формата').setDesc('Они доступны в локальной резервной копии.').addButton(button=>button.setButtonText('Добавить версии к общей папке').setDisabled(row.role==='viewer').onClick(()=>this.confirm('Добавить сохранённые локальные версии?','Различающиеся варианты сохранятся как конфликтующие версии для сверки.',async()=>{record.shared2LegacyImportApprovedEpoch=record.shared2CacheEpoch;await this.plugin.folders.save();const entry=this.entries.get(row.id);if(entry){await entry.controller.close();await entry.engine.close();this.entries.delete(row.id);}await this.poll();})));

    if(row.role==='owner'){
     if(this.aliasTransfers)new Setting(card).setName('Прежние личные копии').setDesc('Сверить версии этой папки в личной и общей базе. При совпадающих файлах потребуется отдельное подтверждение; обе доступные истории сохранятся.').addButton(button=>button.setButtonText('Сверить прежние копии').setDisabled(this.retentionPaused(row)||row.ownerWorkspace!==this.scope.workspace||!!record.shared2Reconciling||!!record.shared2Rekeying||!!record.shared2Reconciling||!!record.shared2Unsharing).onClick(()=>this.confirm('Сверить прежние копии папки?','Папка временно станет доступна только для чтения. Оставьте Obsidian открытым; операция сохранится и продолжится после повторного запуска.',async()=>{await this.aliasTransfers.plan(row.id,record.mount);await this.poll();})));
     new Setting(card).setName(row.encrypted?'Ключ шифрования':'Шифрование папки').setDesc(row.encrypted?'Новый ключ защитит будущие версии; ранее скачанные файлы остаются у участников.':'Содержимое будет зашифровано на этом устройстве и проверено перед переключением.').addButton(button=>button.setButtonText(row.encrypted?'Сменить ключ':'Включить шифрование').setDisabled(this.retentionPaused(row)||!!record.shared2Rekeying||!!record.shared2Reconciling||!!record.shared2Unsharing||row.ownerWorkspace!==this.scope.workspace).onClick(()=>this.confirm(row.encrypted?'Сменить ключ папки?':'Зашифровать папку?','Оставьте Obsidian открытым до завершения. Ключи устройств участников потребуется передать заново.',async()=>{await this.deviceTransfers.plan(row.id);void this.poll();})));
     new Setting(card).setName('Приглашения').addButton(button=>{button.setButtonText('Пригласить по email').onClick(()=>this.invite(row));tariffGate(button.buttonEl);});
     setting.addButton(button=>button.setButtonText('Прекратить общий доступ').setDisabled(this.retentionPaused(row)||!!record.shared2Unsharing||!!record.shared2Reconciling).onClick(()=>this.confirm('Прекратить общий доступ?','Доступ всех участников будет закрыт. Папка вернётся в обычную синхронизацию хранилища; локальные файлы сохранятся.',()=>this.beginUnshare(row,record))));
     const access=this.access.get(row.id);
     for(const member of access?.members||[]){const setting=new Setting(card).setName(member.label||member.account).setDesc(member.role==='owner'?'Владелец':member.role==='editor'?'Редактор':'Читатель');if(member.role!=='owner')setting.addButton(button=>button.setButtonText(member.role==='editor'?'Сделать читателем':'Сделать редактором').onClick(()=>{void this.changeRole(row,member.account,member.role==='editor'?'viewer':'editor');})).addButton(button=>button.setButtonText('Отозвать доступ').onClick(()=>this.confirm('Отозвать доступ участника?','Локальные файлы участника сохранятся.',()=>this.changeRole(row,member.account,'remove'))));}
     for(const invitation of access?.invitations||[])new Setting(card).setName(invitation.email).setDesc('Ожидает принятия · '+(invitation.role==='editor'?'Редактор':'Читатель')).addButton(button=>button.setButtonText('Отозвать приглашение').onClick(()=>{void this.mutate('/shared2/invitations/'+invitation.id+'/revoke',{workspace:row.ownerWorkspace},row.id);}));
     if(row.encrypted)for(const device of access?.devices||[])new Setting(card).setName('Устройство: '+device.account+' / '+device.device).addButton(button=>button.setButtonText('Передать ключ').onClick(()=>this.deliverKey(row,device)));
    }else setting.addButton(button=>button.setButtonText('Отказаться от общего доступа').onClick(()=>this.confirm('Отказаться от общего доступа?','Локальные файлы сохранятся на этом устройстве.',()=>this.leave(row,record))));
   }
  }
  for(const row of this.catalog.folders.filter((row:any)=>/^arcalink_s_[a-f0-9]{32}$/.test(row.database)&&!this.plugin.folders.records.some((r:any)=>r.id===row.id)))new Setting(container).setName('Папка: '+row.documentRoot).setDesc('Владелец: '+(row.ownerLabel||row.owner)).addButton(button=>button.setButtonText('Подключить локальную папку').onClick(()=>this.mount(row)));
  for(const delivery of this.keyInbox){const row=this.catalog.folders.find((row:any)=>row.id===delivery.envelope.folder);if(row)new Setting(container).setName('Ключ папки: '+row.documentRoot).setDesc('Устройство владельца: '+delivery.sender.device).addButton(button=>button.setButtonText('Проверить и принять ключ').onClick(()=>this.receiveKey(row,delivery)));}
  for(const invite of this.inbox){const card=container.createDiv({cls:'arcalink-shared2-card'});new Setting(card).setName('Приглашение: '+invite.name).setDesc('Владелец: '+invite.owner+' · '+(invite.role==='editor'?'Редактор':'Читатель')).addButton(button=>button.setButtonText('Принять').onClick(()=>{void this.respond(invite,'accept');})).addButton(button=>button.setButtonText('Отказаться').onClick(()=>{void this.respond(invite,'reject');}));}
  return true;
 }
 async respond(invite:any,action:string){try{const response=await this.request('/shared2/invitations/'+invite.id+'/'+action,{method:'POST',body:'{}'});if(response.status!==200)throw Error(response.json.error);await this.poll();if(action==='accept'){const row=this.catalog.folders.find((row:any)=>row.id===invite.folder);if(row)this.mount(row);}}catch(error:any){new Notice(shared2Message(error));}}

 profile(row:any){return {kind:'shared',...this.scope,folder:row.id,ownerWorkspace:row.ownerWorkspace,database:row.database,generation:row.generation,revision:row.revision,catalogRevision:this.catalog.revision,role:row.role,encrypted:row.encrypted,keyEpoch:row.keyEpoch};}
 confirm(title:string,description:string,operation:()=>Promise<any>){const app=this.plugin.app;class Confirmation extends Modal{override onOpen(){this.titleEl.setText(title);this.contentEl.createEl('p',{text:description});new Setting(this.contentEl).addButton(button=>button.setButtonText('Отмена').onClick(()=>this.close())).addButton(button=>button.setButtonText('Подтверждаю').setCta().onClick(async()=>{button.setDisabled(true);try{await operation();this.close();}catch(error:any){new Notice(shared2Message(error));button.setDisabled(false);}}));}}new Confirmation(app).open();}
 async mutate(path:string,body:any,folder?:string){const response=await this.request(path,{method:'POST',body:JSON.stringify(body)});if(response.status!==200)throw Error(response.json?.error||'shared2-request-rejected');if(folder)this.access.delete(folder);await this.poll();return response.json;}
 async changeRole(row:any,account:string,role:string){try{await this.mutate('/shared2/folders/'+row.id+'/members',{workspace:row.ownerWorkspace,account,role,revision:row.revision},row.id);}catch(error:any){new Notice(shared2Message(error));}}
 invite(row:any){const manager=this;class Invitation extends Modal{override onOpen(){this.titleEl.setText('Пригласить в папку: '+row.documentRoot);let email='',role='editor';new Setting(this.contentEl).setName('Email участника').addText(input=>input.setPlaceholder('name@example.com').onChange(value=>email=value));new Setting(this.contentEl).setName('Права').addDropdown(input=>input.addOptions({editor:'Редактор',viewer:'Читатель'}).setValue(role).onChange(value=>role=value));new Setting(this.contentEl).addButton(button=>button.setButtonText('Пригласить').setCta().onClick(async()=>{button.setDisabled(true);try{await manager.mutate('/shared2/folders/'+row.id+'/invitations',{workspace:row.ownerWorkspace,email:email.trim(),role,revision:row.revision},row.id);this.close();}catch(error:any){new Notice(shared2Message(error));button.setDisabled(false);}}));}}new Invitation(this.plugin.app).open();}
 mount(row:any){chooseSharedFolder(this.plugin.app,{title:'Подключить общую папку',description:'Выберите пустую локальную папку. Она будет связана с общей папкой владельца.',action:'Подключить',unavailable:(path:string)=>{try{this.plugin.folders.validateMount(path);if(this.plugin.app.vault.getFiles().some((file:any)=>file.path.startsWith(path+'/')))return 'Папка должна быть пустой';return '';}catch(error:any){return error.message;}},select:async(mount:string)=>{this.plugin.folders.validateMount(mount);if(this.plugin.app.vault.getFiles().some((file:any)=>file.path.startsWith(mount+'/')))throw Error('Папка должна быть пустой');if(this.plugin.folders.records.some((r:any)=>r.id===row.id))throw Error('Эта общая папка уже подключена к хранилищу');this.plugin.folders.records.push({id:row.id,mount,role:row.role,protocol:2,shared2CacheEpoch:crypto.randomUUID().replace(/-/g,''),shared2Scope:{...this.scope}});await this.plugin.folders.save();await this.poll();}});}
 async leave(row:any,record:any){await this.mutate('/shared2/folders/'+row.id+'/leave',{});const entry=this.entries.get(row.id);if(entry){await entry.controller.close();await entry.engine.close();this.entries.delete(row.id);}record.shared2Left=true;await this.plugin.folders.save();this.redraw();}
 deliverKey(row:any,recipient:any){this.confirm('Проверка устройства участника','Сверьте отпечаток с владельцем устройства другим способом: '+recipient.fingerprint,async()=>{await this.keys.pin(recipient);const own=await this.keys.publicIdentity(),context={ownerWorkspace:row.ownerWorkspace,owner:row.owner,senderAccount:this.scope.account,senderDevice:own.device,recipientAccount:recipient.account,recipientDevice:recipient.device,folder:row.id,database:row.database,generation:row.generation,keyEpoch:row.keyEpoch};const envelope=await this.keys.seal(this.profile(row),context,recipient);await this.mutate('/shared2/folders/'+row.id+'/envelopes',{revision:row.revision,envelope},row.id);});}
 receiveKey(row:any,delivery:any){this.confirm('Проверка устройства владельца','Сверьте отпечаток с владельцем другим способом: '+delivery.sender.fingerprint,async()=>{await this.keys.pin(delivery.sender);const own=await this.keys.publicIdentity(),context={ownerWorkspace:row.ownerWorkspace,owner:row.owner,senderAccount:row.owner,senderDevice:delivery.sender.device,recipientAccount:this.scope.account,recipientDevice:own.device,folder:row.id,database:row.database,generation:row.generation,keyEpoch:row.keyEpoch};await this.keys.receive(this.profile(row),context,delivery.envelope,delivery.sender);await this.poll();});}

 async resumeCancelled(record:any){
  const response=await this.request('/shared2/jobs/'+record.shared2Job);if(response.status!==200||response.json.state!=='cancelled'||response.json.folder!==record.id||response.json.workspace!==this.scope.workspace||record.protocol===2)throw Error('shared2-cancel-not-confirmed');
  const nonce=crypto.randomUUID().replace(/-/g,''),privateRoot='ArcaLink Shared/shared2/'+this.scope.account+'/'+this.scope.workspace+'/'+record.id+'/cancel-'+nonce,context=this.context;
  const files=await backupShared2Files({mount:record.mount,privateRoot,adapter:this.plugin.app.vault.adapter,listFiles:async()=>this.plugin.app.vault.getFiles().filter((file:any)=>file.path.startsWith(record.mount+'/')).map((file:any)=>file.path),hashFile:(path:string)=>this.hashFile(path),assertCurrent:async()=>{if(this.disposed||this.context!==context||this.signature(await this.session())!==context)throw Error('shared2-account-changed');}});
  await this.store('cancel-'+record.id+'-'+nonce).save({protocol:2,scope:this.scope,privateRoot,files});
  await this.drainLegacy(record.id);record.shared2PastBackups=[...(record.shared2PastBackups||[]),...(record.shared2Backup?[{root:record.shared2Backup,store:'prepare-'+record.id+'-'+record.shared2BackupId}]:[]),{root:privateRoot,store:'cancel-'+record.id+'-'+nonce}];
  record.shared2Preparing=false;record.shared2Job=null;record.shared2BackupId=null;record.shared2Backup=null;await this.plugin.folders.save();await this.plugin.folders.ensure(record);this.plugin.folders.refresh();
  new Notice('Прежнее подключение возобновлено. Локальная резервная копия для сверки: '+privateRoot);this.redraw();
 }
 async dispose(){this.disposed=true;if(this.timer)window.clearInterval(this.timer);await this.aliasTransfers?.close();await this.reverseTransfers?.close();await this.encryptedTransfers?.close();await this.deviceTransfers?.close();await this.retire();await this.jobs?.close();await this.namespaceJobs?.close();await this.keyStorage?.close();this.panels.clear();this.panelGates.clear();}
}
