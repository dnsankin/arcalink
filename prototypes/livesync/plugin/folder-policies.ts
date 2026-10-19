import {requestUrl} from 'obsidian';
import {encrypt,decrypt} from 'octagonal-wheels/encryption/encryption';
import {decodeFolderMetadata} from './folder-crypto.mjs';
import {verifyModeProofPage,modeProofMessages} from './folder-mode-proof.mjs';
import {upsertRemoteConfigurationInPlace} from '@vrtmrz/livesync-commonlib/remote-configurations';
import {getStoragePathFromUXFileInfo} from '@vrtmrz/livesync-commonlib/compat/common/typeUtils';
import {createFolderPolicyStore} from './folder-policy-store.mjs';
import {decodeFolderPolicyState,encodeFolderPolicy,folderPolicyExcludes} from './folder-policy.mjs';
import {cleanupEntry,planFolderCleanup,cleanupManifestDigest} from './folder-cleanup.mjs';
import {folderDatabaseName,installFolderDatabaseResolver,prepareFolderDatabase,activatePreparedFolderDatabase,retirePreparedFolderDatabase} from './folder-local-database.mjs';
import {pluginEnvironment} from './environment.mjs';
import {waitForReplicationDrain} from './replication-drain.mjs';
import {folderContains,withExcludedFolders} from './folder-exclusions.mjs';
import {isFreeRelayConnection} from './free-relay-settings.mjs';
const fail=()=>Error('Не удалось применить общие исключения. Локальные файлы сохранены. Проверьте соединение и повторите действие.');
const pause=(ms:number)=>new Promise(resolve=>window.setTimeout(resolve,ms));
const same=(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b);

/** Owns the policy boundary; generation changes run before opening the engine DB. */
export class FolderPolicies {
  active:boolean;store:any;factory:any;entry:any=null;workspace='';logical='';observed:any=null;
  available=false;holding=false;loading=false;disposed=false;reloading=false;error='';
  oldSuspended=false;lastCheck=0;operation:any=null;remoteOperation:any=null;remotePhase='';cloudReady=false;cancelling:Promise<void>|null=null;
  previewing:Promise<any>|null=null;previewCancelled=false;exchangePausedByFreeze=false;recovering=false;
  protectedPaths:string[]=[];protectedRevision='';
  constructor(private plugin:any){this.active=pluginEnvironment(plugin.manifest).folderPolicies;this.store=createFolderPolicyStore(plugin.app.vault.adapter,plugin.pilotDirectory+'/folder-policy-state');}
  get state(){return this.observed||this.entry?.state;}
  requiresPolicy(){return !!(this.state?.revision||this.entry?.state?.revision||this.entry?.seen?.revision||this.entry?.binding?.revision||this.entry?.journal||this.operation||this.remoteOperation);}
  legacyUnavailable(error:any){return !this.requiresPolicy()&&(error.unavailable===true||[404,408,429,500,502,503,504].includes(error.status));}
  excludes(path:string){return !!this.state?.policy&&folderPolicyExcludes(this.state.policy,path);}
  importReady(){return !this.active||!this.holding&&!this.loading&&!this.reloading&&!this.error&&(!this.state?.revision||this.state.phase==='ready'&&this.entry?.binding?.revision===this.state.revision);}
  assertSharedMount(path:string){
    if(!this.active)return;
    if(!this.importReady()||(this.state?.policy?.folders||[]).some((root:string)=>folderContains(root,path,false)||folderContains(path,root,false)))throw Error('Выберите общую папку вне общих исключений. Дождитесь применения текущих правил синхронизации.');
  }
  async assertLabVault(){if(pluginEnvironment(this.plugin.manifest).lab&&!await this.plugin.app.vault.adapter.exists('.arcalink-folder-lab.json'))throw Error('Испытательная сборка работает только в тестовом хранилище со стенда. Рабочие заметки не затронуты.');}
  logicalName(settings:any){if(pluginEnvironment(this.plugin.manifest).lab&&!settings.additionalSuffixOfDatabaseName)settings.additionalSuffixOfDatabaseName='arcalink-folders-lab';return this.plugin.core.services.vault.vaultName()+(settings.additionalSuffixOfDatabaseName?'-'+settings.additionalSuffixOfDatabaseName:'')+'-livesync-v2';}
  async bindingId(){const pending=await this.plugin.workspaces.pendingMerge()||await this.plugin.workspaces.pendingMigration();if(pending?.target?.id)return pending.target.id;const saved=await this.plugin.unifiedVault.saved(),session=await this.plugin.workspaces.session();return saved?.workspaceId||session.workspaceId;}
  async credentialsAuth(){
    const p=this.plugin,saved=await p.unifiedVault.saved();
    let session=await p.freeRelay.session()||saved?.auth;
    if(p.workspaces.pending?.access_token)return {auth:'Bearer '+p.workspaces.pending.access_token,session:null};
    if(session?.accessToken)return {auth:'Bearer '+session.accessToken,session};
    const s=p.core.services.setting.currentSettings();return {auth:'Basic '+btoa(s.couchDB_USER+':'+s.couchDB_PASSWORD),session:null};
  }
  async api(action:string,body:any={}){
    await this.assertLabVault();
    let {auth,session}=await this.credentialsAuth();
    const send=()=>requestUrl({url:this.plugin.unifiedVault.base+'/folder-policy/'+action,method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({id:this.workspace,...body}),throw:false});
    let r:any;try{r=await send();if(r.status===401&&session?.refreshToken){session=await this.plugin.freeRelay.refresh({...session,group:session.group||this.workspace});auth='Bearer '+session.accessToken;r=await send();}}catch{throw Object.assign(fail(),{unavailable:true});}
    if(r.status!==200){
      const code=r.json?.error_code;
      const error=(modeProofMessages as Record<string,string>)[code]?Error((modeProofMessages as Record<string,string>)[code]):fail();
      throw Object.assign(error,{status:r.status,code});
    }
    return r.json;
  }
  async save(change:any){
    const key=this.workspace+'|'+this.logical;
    const result=await this.store.update((data:any)=>({...data,[key]:{...(data[key]||{}),...change}}));if(key!==this.workspace+'|'+this.logical)throw fail();this.entry=result[key];
  }
  crypto(settings:any){return {encrypted:!!settings.encrypt,seal:(data:string)=>encrypt(data,settings.passphrase,false),open:(data:string)=>decrypt(data,settings.passphrase,false)};}
  attach(){
    if(!this.active)return;
    const p=this.plugin,s=p.core.services;
    this.factory=installFolderDatabaseResolver(s.database,()=>this.entry?.binding?.logical===this.logical?this.entry.binding:null);
    s.vault.isTargetFile.addHandler(async(file:any)=>{
      const path=getStoragePathFromUXFileInfo(file);
      return !this.state?.policy||!folderPolicyExcludes(this.state.policy,path);
    },-100);
    s.appLifecycle.onSettingLoaded.addHandler(()=>this.startup(),-15);
    s.replication.onBeforeReplicate.addHandler(()=>this.beforeExchange(),-30);
    const timer=window.setInterval(()=>{void this.poll();},15000);p.register(()=>{window.clearInterval(timer);this.disposed=true;this.factory.dispose();});
  }
  async select(workspace:string,settings:any){
    if(this.workspace!==workspace){this.exchangePausedByFreeze=false;this.protectedPaths=[];this.protectedRevision='';}
    this.workspace=workspace;this.logical=this.logicalName(settings);
    const values=await this.store.read();this.entry=values[workspace+'|'+this.logical]||{};
    this.observed=this.entry.seen||this.entry.state||null;
    this.available=!!this.observed?.revision;
  }
  async fetchState(settings:any,initialize=false){
    const key=this.workspace+'|'+this.logical;
    let raw=await this.api('read');
    if(key!==this.workspace+'|'+this.logical)throw fail();
    // A revision-zero workspace has no common policy to prepare. Discovering
    // its encryption format is optional until the user requests a first rule.
    // Cached/accepted policies and in-flight operations still fail closed.
    if(raw.enabled!==false&&raw.encryption_known===false&&(initialize||this.requiresPolicy()||raw.revision!==0||raw.operation)){
      try{await this.api('initialize',{encrypted:!!settings.encrypt});}
      catch(error:any){
        if(error.code!=='workspace-encryption-unknown'||!initialize||this.requiresPolicy()||raw.revision!==0||raw.operation)throw error;
        await this.recoverEncryption(settings);
      }
      if(key!==this.workspace+'|'+this.logical)throw fail();
      raw=await this.api('read');
      if(raw.encryption_known!==true)throw fail();
    }
    if(key!==this.workspace+'|'+this.logical)throw fail();
    if(raw.enabled===false){if(this.requiresPolicy())throw fail();this.available=false;return null;}
    const protectedPaths=raw.protected_folders||[];
    if(!Array.isArray(protectedPaths)||protectedPaths.length>512)throw fail();
    try{withExcludedFolders('',protectedPaths);}catch{throw fail();}
    this.protectedPaths=protectedPaths;this.protectedRevision=raw.protected_revision||'';
    this.cloudReady=!!raw.cloud_ready;this.available=true;this.remoteOperation=raw.operation||null;this.remotePhase=raw.operation_phase||'';
    if(this.remoteOperation)this.exchangePausedByFreeze=true;
    const decoded=await decodeFolderPolicyState(raw,this.workspace,this.observed,this.crypto(settings));
    this.observed=decoded;this.lastCheck=Date.now();if(!same(this.entry?.seen,decoded))await this.save({seen:decoded});return decoded;
  }
  async recoverEncryption(settings:any){
    const crypto={encrypt:!!settings.encrypt,passphrase:settings.passphrase,useDynamicIterationCount:settings.useDynamicIterationCount};
    const key=this.workspace+'|'+this.logical;
    const check=()=>{
      const current=this.plugin.core.services.setting.currentSettings();
      if(this.disposed||this.previewCancelled||this.requiresPolicy()||key!==this.workspace+'|'+this.logical||JSON.stringify(crypto)!==JSON.stringify({encrypt:!!current.encrypt,passphrase:current.passphrase,useDynamicIterationCount:current.useDynamicIterationCount}))throw fail();
    };
    let cursor=null,verified=0;
    for(let pages=0;pages<100001;pages++){
      check();const page=await this.api('encryption-proof',{cursor});check();
      verified+=await verifyModeProofPage(page,crypto);check();
      if(page.proof){
        if(crypto.encrypt&&!verified)throw fail();
        await this.api('initialize',{encrypted:crypto.encrypt,proof:page.proof});check();return;
      }
      cursor=page.cursor;
    }
    throw fail();
  }
  async applyAccess(access:any,settings:any,persist=true){
    if(!access)return;
    if(access.workspace_id!==this.workspace||!/^arcalink_p_[a-f0-9]{32}$/.test(access.database)||!access.user?.startsWith('pilot_')||typeof access.password!=='string'||access.password.length<20)throw fail();
    const configuredBase=new URL(this.plugin.unifiedVault.base);configuredBase.pathname=configuredBase.pathname.replace(/\/api\/?$/,'/couchdb/');
    if(access.url!==configuredBase.href)throw fail();
    Object.assign(settings,{couchDB_URI:access.url.replace(/\/$/,''),couchDB_DBNAME:access.database,couchDB_USER:access.user,couchDB_PASSWORD:access.password});
    upsertRemoteConfigurationInPlace(settings,'couchdb',{id:'arcalink-pilot',name:'ArcaLink',activate:!isFreeRelayConnection(settings)});
    if(persist)await this.plugin.core.services.setting.applyPartial(settings,true);
  }
  async finishPrepared(settings:any,persist:boolean){
    const e=this.entry;if(!e?.journal||!e.binding||e.journal.target!==e.binding.target)return;
    if(!e.acknowledgement){
      if(!e.challenge)throw fail();
      let ack;
      try{ack=await this.api('ack',{...e.challenge,protocol:1});}
      catch(error:any){
        if(error.code==='policy-changed'&&!persist)throw error;
        if(error.code==='policy-changed'&&!this.plugin.core.services.database.isDatabaseReady()){
          // This generation never ran. Re-plan from its intact former source.
          await this.save({binding:e.previousBinding||null,state:e.previousState||null,
            abandoned:[...(e.abandoned||[]),{logical:e.journal.logical,target:e.journal.target,workspace:e.journal.workspace,revision:e.journal.revision}],journal:null,challenge:null,acknowledgement:null,retirement:null});
          return;
        }
        throw error;
      }
      if(ack.revision!==e.journal.revision)throw fail();
      await this.applyAccess(ack.credentials,settings,persist);
      if(!persist)return; // The caller must persist its destination settings first.
      await this.save({acknowledgement:{workspace:this.workspace,revision:ack.revision,database:e.journal.database}});
    }
    await retirePreparedFolderDatabase({journal:this.entry.journal,binding:this.entry.binding,acknowledgement:this.entry.acknowledgement,
      retirement:this.entry.retirement,open:this.factory.openRaw,isCurrent:async()=>!this.disposed,isMapped:async(name:string)=>name===this.entry.binding.target,
      isQuiescent:async()=>!this.plugin.core.services.database.isDatabaseReady(),persistRetirement:async(value:any)=>this.save({retirement:value})});
    for(const abandoned of this.entry.abandoned||[]){
      if(abandoned.logical!==this.logical||abandoned.target===this.entry.binding.target)throw fail();
      if(folderDatabaseName(abandoned.logical,{protocol:1,...abandoned})!==abandoned.target)throw fail();
      const candidate=this.factory.openRaw(abandoned.target,{auto_compaction:false});
      await candidate.destroy();
    }
    await this.save({journal:null,challenge:null,acknowledgement:null,retirement:null,previousBinding:null,previousState:null,abandoned:[]});
  }
  async prepare(settings:any,persist=true){
    // Recover a lost earlier acknowledgement before asking for a newer policy.
    if(this.entry?.journal&&this.entry.binding)await this.finishPrepared(settings,persist);
    const state=await this.fetchState(settings);
    if(!state)return true;
    if(!state.revision){await this.save({state});return true;}
    if(state.phase!=='ready')return false;
    if(this.entry?.binding?.revision===state.revision&&this.entry.binding.database===state.database){await this.save({state});return true;}
    if(this.plugin.core.services.database.isDatabaseReady())throw fail();
    const challenge=await this.api('challenge');
    if(challenge.revision!==state.revision||challenge.database!==state.database)throw fail();
    await this.save({challenge,...(!this.entry.journal?{previousBinding:this.entry.binding||null,previousState:this.entry.state||null}:{})});
    const source=this.entry?.binding?.target||this.logical;
    const isCurrent=async()=>!this.disposed&&this.workspace===state.workspace&&this.logical===this.logicalName(settings);
    const previous=this.entry.journal;
    const journal=await prepareFolderDatabase({state,logical:this.logical,source,journal:previous?.revision===state.revision?previous:null,
      open:this.factory.openRaw,persistJournal:async(value:any)=>this.save({journal:value}),quiesce:async()=>!this.plugin.core.services.database.isDatabaseReady(),
      isCurrent,isMapped:async(name:string)=>name===this.entry?.binding?.target});
    const refreshed=await this.fetchState(settings);
    if(refreshed?.phase!=='ready'||refreshed.revision!==state.revision||refreshed.database!==state.database)throw fail();
    const binding=await activatePreparedFolderDatabase({state,journal,open:this.factory.openRaw,isCurrent,persistBinding:async(value:any)=>this.save({binding:value,state})});
    if(binding.target!==this.entry.binding.target)throw fail();
    await this.finishPrepared(settings,persist);return true;
  }
  proof(group:string){
    const state=this.state;
    return {protocol:1,revision:group===this.workspace&&state?.phase==='ready'&&this.entry?.binding?.revision===state.revision?state.revision:0};
  }
  async prepareAccess(space:any,settings:any){
    if(!this.active)return false;
    if(this.operation||this.previewing||this.cancelling||this.reloading)throw fail();
    let raw;try{raw=await this.api('read',{id:space.id});}catch(error:any){if(error.status===404&&!this.requiresPolicy())return false;throw error;}
    if(raw.enabled===false||raw.revision===0){
      // Switching workspace must also switch the resolver/filter, including a
      // destination that has never had a common exclusion.
      const changed=!!this.workspace&&(this.workspace!==space.id||this.logical!==this.logicalName(settings));
      if(changed&&this.entry?.binding){
        if(!this.holding)await this.hold();
        const services=this.plugin.core.services;services.appLifecycle.resetIsReady();
        await services.database.localDatabaseDirect?.close();
      }
      await this.select(space.id,settings);
      if(raw.enabled!==false)await this.fetchState(settings);
      return changed&&this.holding;
    }
    await decodeFolderPolicyState(raw,space.id,null,this.crypto(settings));
    if(raw.phase!=='ready')throw Error('Применяются общие исключения папок. Дождитесь завершения.');
    if(!this.holding)await this.hold();
    const s=this.plugin.core.services;s.appLifecycle.resetIsReady();
    await s.database.localDatabaseDirect?.close();
    try{
      await this.select(space.id,settings);
      if(!await this.prepare(settings,false))throw fail();
      return true;
    }catch(error){this.reload();throw error;}
  }
  releaseForDestination(){this.holding=false;this.plugin.core.services.appLifecycle.setSuspended(this.oldSuspended);}
  async ensureCloudAccess(workspace:string){
    if(!this.active)return;
    if(workspace!==this.workspace)return;
    const settings=this.plugin.core.services.setting.currentSettings();let state;
    try{state=await this.fetchState(settings);}catch(error:any){if(this.legacyUnavailable(error))return;throw error;}
    if(!state?.revision||this.cloudReady)return;
    if(state.phase!=='ready'||this.entry?.binding?.revision!==state.revision){this.reload();throw fail();}
    const challenge=await this.api('challenge');const ack=await this.api('ack',{...challenge,protocol:1});
    if(ack.revision!==state.revision||!ack.credentials)throw fail();
    await this.applyAccess(ack.credentials,settings,true);this.cloudReady=true;
  }
  async startup(){
    if(this.loading)return false;
    const settings=this.plugin.core.services.setting.currentSettings();
    try{await this.assertLabVault();}catch(error:any){this.error=error.message;return false;}
    if(!settings.isConfigured)return true;
    this.loading=true;
    try{const workspace=await this.bindingId();if(!/^[a-f0-9]{32}$/.test(workspace||''))return true;await this.select(workspace,settings);const ready=await this.prepare(settings);this.error=ready?'':'Применяются общие исключения папок. Дождитесь завершения.';return ready;}
    catch(e:any){
      if(this.legacyUnavailable(e)){this.available=false;this.error='';return true;}
      this.error=fail().message;return false;
    }finally{this.loading=false;}
  }
  async beforeExchange(){
    if(!this.active)return true;
    try{await this.assertLabVault();}catch(error:any){this.error=error.message;return false;}
    if(this.loading||this.holding||this.reloading)return false;
    if(!this.workspace)return true;
    const settings=this.plugin.core.services.setting.currentSettings();
    try{
      const next=await this.fetchState(settings);
      // A hold may have started while the preflight was waiting for the server.
      if(this.holding||this.loading||this.reloading)return false;
      if(!next){this.error='';return true;}
      if(this.remoteOperation){void this.plugin.core.services.replicator.onCloseActiveReplication().catch(()=>{});void this.plugin.arcalinkP2P?.transportLifecycle.disconnect().catch(()=>{});return false;}
      if(!next.revision){this.error='';return true;}
      if(next.phase==='ready'&&this.entry?.binding?.revision===next.revision&&this.entry.binding.database===next.database&&!this.entry.journal){this.error='';return true;}
      this.reload();return false;
    }catch(e:any){if(this.legacyUnavailable(e)){this.available=false;this.error='';return true;}this.error=fail().message;return false;}
  }
  async recoverFrozenExchange(){
    const s=this.plugin.core.services,settings=s.setting.currentSettings();
    if(this.recovering||this.holding||this.loading||this.reloading||this.plugin.workspaces?.busy||s.appLifecycle.isSuspended()||!settings.isConfigured)return;
    const free=isFreeRelayConnection(settings);
    if(free?!settings.P2P_AutoStart:!settings.liveSync&&!settings.syncOnSave&&!settings.periodicReplication)return;
    const messages=(await s.appLifecycle.getUnresolvedMessages()).flat();
    // A short freeze may finish between polls. Recognise only the structured
    // rejection observed by the native transport, never a generic module error.
    const frozen=messages.some((value:any)=>{
      if(typeof value!=='string'||!value.startsWith('Failed to fetch by API. 409: '))return false;
      try{return JSON.parse(value.slice('Failed to fetch by API. 409: '.length)).error_code==='workspace-frozen';}catch{return false;}
    });
    if(!this.exchangePausedByFreeze&&!frozen||this.holding||s.appLifecycle.isSuspended())return;
    const key=this.workspace+'|'+this.logical;this.recovering=true;
    try{
      const current=()=>!this.disposed&&!this.holding&&!this.loading&&!this.reloading&&!s.appLifecycle.isSuspended()&&key===this.workspace+'|'+this.logical;
      // A failed preflight may have retired its provider. Re-realise the
      // settings through the normal lifecycle before requesting replication.
      await s.control.applySettings();if(!current())return;
      if(!free){
        if(!await s.replication.replicate(false)||!current())return;
        if(settings.liveSync)await s.control.applySettings();
      }
      this.exchangePausedByFreeze=false;
    }catch{/* Preserve the pause reason and retry through normal readiness on a later poll. */}
    finally{this.recovering=false;}
  }
  async poll(){
    if(this.disposed||this.loading||this.holding||this.reloading||this.recovering||!navigator.onLine)return;
    if(!this.workspace)return;
    if(Date.now()-this.lastCheck<15000)return;
    if(!this.plugin.core.services.database.isDatabaseReady()){
      try{const next=await this.fetchState(this.plugin.core.services.setting.currentSettings());if(next?.phase==='ready')this.reload();}catch{/* Keep the saved local policy and retry without an alarm loop. */}
    }else if(await this.beforeExchange())await this.recoverFrozenExchange();
  }
  reload(){
    if(this.reloading||this.disposed)return;this.reloading=true;
    // A prepared generation is an ordinary database lifecycle transition, not a
    // plugin-manager restart. The existing provider retires on database events.
    window.setTimeout(()=>{void this.reopenGeneration().catch(()=>{
      this.reloading=false;this.error=fail().message;
      if(!this.disposed)window.setTimeout(()=>this.reload(),15000);
    });},0);
  }
  async reopenGeneration(){
    const s=this.plugin.core.services,key=this.workspace+'|'+this.logical;
    const current=()=>!this.disposed&&key===this.workspace+'|'+this.logical;
    let quiesced=false,released=false;
    try{
      if(!this.holding)await this.hold();
      quiesced=true;
      this.loading=true;s.appLifecycle.resetIsReady();
      await s.database.localDatabaseDirect?.close();
      if(!current()||!await this.prepare(s.setting.currentSettings()))throw fail();
      if(!current()||!await s.database.openDatabase({databaseEvents:s.databaseEvents,replicator:s.replicator}))throw fail();
      if(!current())throw fail();
      this.error='';this.loading=false;this.reloading=false;this.holding=false;released=true;
      s.appLifecycle.setSuspended(this.oldSuspended);s.appLifecycle.markIsReady();
      if(!this.oldSuspended){await s.control.applySettings();await s.vault.scanVault(false,false,true);}
    }catch(error){
      if(quiesced&&!released){this.holding=true;s.appLifecycle.setSuspended(true);s.appLifecycle.resetIsReady();}
      throw error;
    }finally{this.loading=false;}
  }
  async hold(){
    if(this.holding||this.loading||this.recovering)throw fail();
    const s=this.plugin.core.services;this.oldSuspended=s.appLifecycle.isSuspended();
    // Block new exchanges immediately, but let already received documents finish
    // before suspending the processor which owns their queue.
    this.holding=true;
    try{
      await s.fileProcessing.commitPendingFileEvents();
      await s.replicator.onCloseActiveReplication();await this.plugin.arcalinkP2P?.transportLifecycle.disconnect();
      const r=s.replication;
      if(!await waitForReplicationDrain(()=>[r.replicationResultCount.value,r.storageApplyingCount.value,r.databaseQueueCount.value,this.plugin.telegram?.busy?1:0]))throw fail();
      // An import already awaiting its final file write may have finished after
      // the first commit. Include those file events before selecting a new DB.
      await s.fileProcessing.commitPendingFileEvents();
      if(!await waitForReplicationDrain(()=>[r.replicationResultCount.value,r.storageApplyingCount.value,r.databaseQueueCount.value,this.plugin.telegram?.busy?1:0]))throw fail();
      s.appLifecycle.setSuspended(true);await s.appLifecycle.onSuspending();
    }catch(error){await this.release().catch(()=>{});throw error;}
  }
  async release(){
    this.holding=false;const s=this.plugin.core.services;s.appLifecycle.setSuspended(this.oldSuspended);
    if(!this.oldSuspended&&s.database.isDatabaseReady()){await s.control.applySettings();await s.vault.scanVault(false,false,true);}
  }
  async preview(folders:string[],expectedRevision:number){
    if(this.previewing||this.holding||this.loading||this.recovering||this.cancelling)throw fail();
    this.previewCancelled=false;
    const preparing=this.preparePreview(folders,expectedRevision);this.previewing=preparing;
    try{return await preparing;}finally{if(this.previewing===preparing)this.previewing=null;}
  }
  async preparePreview(folders:string[],expectedRevision:number){
    if(!this.available||!this.workspace)throw fail();
    const protectedPaths=['ArcaLink Shared',...this.protectedPaths,...(this.plugin.folders?.records||[]).map((record:any)=>record.mount)];
    if(folders.some(folder=>protectedPaths.some(path=>folderContains(folder,path,false)||folderContains(path,folder,false))))throw Error('Общие папки и совместные заметки управляются отдельно. Выберите папки личного хранилища.');
    await this.hold();
    const check=()=>{if(this.previewCancelled)throw Object.assign(fail(),{code:'folder-preview-cancelled'});};
    try{
      check();const settings=this.plugin.core.services.setting.currentSettings();
      const current=await this.fetchState(settings,true);check();
      if(!current||current.revision!==expectedRevision||this.remoteOperation)throw fail();
      const policy={protocol:1,workspace:this.workspace,folders,caseSensitive:!!this.state?.policy?.caseSensitive||!this.state?.revision&&!!settings.handleFilenameCaseSensitive};
      const envelope=await encodeFolderPolicy(policy,this.crypto(settings));check();
      let job=await this.api('reserve',{revision:expectedRevision,envelope,protected_revision:this.protectedRevision||undefined});this.operation=job;check();
      const deadline=Date.now()+15*60*1000;
      while(job.operation_phase==='draining'){
        if(Date.now()>deadline)throw fail();await pause(1000);check();job=await this.api('status',{operation:this.operation.operation});check();
      }
      if(job.operation_phase!=='preview')throw fail();
      this.operation={...this.operation,...job};
      if(!folders.length){const plan={sequence:job.source_sequence,folders:[],fileCount:0,logicalBytes:0,removeFiles:[],removeChunks:[]};this.operation.plan=plan;return plan;}
      const entries:any[]=[];let cursor:any=null,parameters:any=null;
      do{
        check();const page=await this.api('inventory',{operation:this.operation.operation,cursor});check();
        if(!same(page.source_sequence,job.source_sequence)||!Array.isArray(page.entries))throw fail();
        parameters=page.parameters;
        for(const doc of page.entries)entries.push(cleanupEntry(await decodeFolderMetadata(doc,settings,parameters)));
        cursor=page.cursor;
      }while(cursor);
      check();const plan=planFolderCleanup({sequence:job.source_sequence,entries},folders,{caseSensitive:policy.caseSensitive,allowEmpty:true});
      this.operation.plan=plan;return plan;
    }catch(error){
      // A fresh read can observe another device's operation. Roll back only
      // this preview's reservation; never cancel an operation just observed.
      if(this.operation)await this.cancelHeldPreview().catch(()=>{});
      else if(this.holding)await this.release().catch(()=>{});
      throw error;
    }
  }
  async cancelHeldPreview(includeRemote=false){
    const operation=this.operation?.operation||(includeRemote?this.remoteOperation:null);
    if(operation)await this.api('cancel',{operation});
    this.operation=null;
    if(operation){this.remoteOperation=null;this.remotePhase='';}
    if(this.holding)await this.release();
  }
  async cancelPreview(includeRemote=false){
    if(this.cancelling)return this.cancelling;
    this.previewCancelled=true;
    this.cancelling=(async()=>{
      // Closing a modal during preparation must not resume exchange while its
      // reserve request is still in flight. The preparer owns rollback first.
      await this.previewing?.catch(()=>{});
      await this.cancelHeldPreview(includeRemote);
    })().finally(()=>{this.cancelling=null;});return this.cancelling;
  }
  async resumeOperation(){
    const operation=this.operation?.operation||this.remoteOperation;if(!operation)throw fail();
    const status=await this.api('resume',{operation});
    if(status.operation_phase==='preview'){this.remotePhase='preview';throw fail();}
    await this.waitOperation(operation);this.reload();
  }
  async waitOperation(operation:string){
    const deadline=Date.now()+30*60*1000;
    while(true){
      const state=await this.api('status',{operation});
      if(state.operation_phase==='complete'){this.operation=null;this.remoteOperation=null;return;}
      if(state.error_code||Date.now()>deadline)throw fail();await pause(1000);
    }
  }
  async confirm(expectedRevision:number){
    const op=this.operation;if(!op?.plan)throw fail();
    const ids=[...op.plan.removeFiles,...op.plan.removeChunks];
    let frames=0,batch:string[]=[];
    const flush=async()=>{if(batch.length){await this.api('manifest',{operation:op.operation,frame:frames++,ids:batch});batch=[];}};
    for(const id of ids){if(batch.length>=128||JSON.stringify([...batch,id]).replace(/[^\x20-\x7e]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).length>60000)await flush();batch.push(id);}await flush();
    this.operation.confirmed=true;
    await this.api('confirm',{operation:op.operation,revision:expectedRevision,source_sequence:op.plan.sequence,frames,manifest_digest:await cleanupManifestDigest(ids)});
    await this.waitOperation(op.operation);
  }
}
