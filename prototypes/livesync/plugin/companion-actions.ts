import {actionHttpError,actionDeliveryMessage} from './companion-action-http.mjs';
import {requestUrl} from 'obsidian';
import {configuredIdKey} from '@vrtmrz/livesync-commonlib/settings';
import {isFreeRelayConnection} from './free-relay-settings.mjs';
import {folderContains} from './folder-exclusions.mjs';
import {actionLinkRequestProof,validActionLinkProof,sealActionLink,actionLinkSettings} from './companion-action-link.mjs';
import {ownershipDigest} from './companion-ownership-model.mjs';
import {readAction,readActionHeader,confirmedActionChunks,openActionReceipt,sealActionReceipt,actionOperationKey} from './companion-action-outbox.mjs';
import {CompanionPeerActionService} from './companion-peer-action-service';
import {executeCompanionAction} from './companion-action-executor.mjs';
import {CompanionActionCodec} from './companion-action-codec';

const fail=(code:string)=>Object.assign(Error(code),{code});
const token=(value:string)=>/^[a-zA-Z0-9_-]{8,128}$/.test(value);
const PRIVATE='arcalink-independent-actions-v1';

/** Local settings handshake and immutable outbox reader. This module never
 * suspends the ordinary engine, opens its local database, or writes vault files. */
export class CompanionActions {
 get deliveryDiagnostic(){return this.error&&this.retry.size?actionDeliveryMessage(this.error):'';}
 private busy=false;private disposed=false;private cursor='';private retry=new Map<string,number>();
 private state:any=null;
 error='';
 private peerService:CompanionPeerActionService;
 constructor(private plugin:any){this.peerService=new CompanionPeerActionService(plugin,()=>this.state,()=>this.save());}
 dispose(){this.disposed=true;this.peerService.dispose();}
 private get adapter(){return this.plugin.app.vault.adapter;}
 private get directory(){return this.plugin.pilotDirectory+'/companion';}
 private async load(){
  if(this.state)return;
  this.state=this.plugin.app.loadLocalStorage(PRIVATE);
  if(!this.state){
   const old=await this.read(this.directory+'/actions-capabilities.json');
   if(old){const previous=JSON.parse(old);if(token(previous.localVaultId||'')&&await this.adapter.exists(this.directory+'/actions-v1/'+previous.localVaultId))throw fail('action-outbox-key-missing');}
   this.state={schema:1,vaultId:crypto.randomUUID(),profiles:{}};this.save();
  }
  if(this.state.schema!==1||!token(this.state.vaultId)||!this.state.profiles)throw fail('action-private-state-invalid');
 }
 private save(){this.plugin.app.saveLocalStorage(PRIVATE,this.state);if(JSON.stringify(this.plugin.app.loadLocalStorage(PRIVATE))!==JSON.stringify(this.state))throw fail('action-private-state-unverified');}
 private async directoryReady(path:string){
  let current='';for(const part of path.split('/')){current=current?current+'/'+part:part;if(!await this.adapter.exists(current))await this.adapter.mkdir(current);}
 }
 private async read(path:string,max=128*1024){
  const stat=await this.adapter.stat(path);if(!stat)return null;
  if(stat.type!=='file'||stat.size>max)throw fail('action-file-limit');
  const text=await this.adapter.read(path);if(new TextEncoder().encode(text).length>max)throw fail('action-file-limit');return text;
 }
 private async write(name:string,value:any){
  await this.directoryReady(this.directory);const text=JSON.stringify(value),path=this.directory+'/'+name;
  if(await this.read(path)===text)return;
  await this.adapter.write(path,text);if(await this.adapter.read(path)!==text)throw fail('action-write-unverified');
 }
 private async binding(){
  const p=this.plugin,saved=await p.unifiedVault.saved(),bound=await p.workspaces.session(),session=await p.freeRelay.session()||saved?.auth;
  const workspaceId=saved?.workspaceId||bound.workspaceId,settings=p.core.services.setting.currentSettings();
  if(!settings.isConfigured||!session?.refreshToken||!token(session.deviceId||'')||!session.email||!token(workspaceId||''))throw fail('action-plugin-sign-in-required');
  return {session,workspaceId,settings};
 }
 private excluded(){
  const p=this.plugin;
  return [...new Set<string>(['ArcaLink Shared',...(p.folderPolicies.protectedPaths||[]),...(p.folderPolicies.state?.policy?.folders||[]),...(p.folders.records||[]).map((record:any)=>record.mount)])].sort();
 }
 private async capability(bound:any){
  const p=this.plugin,{session,workspaceId,settings}=bound;
  const configuration={settings:actionLinkSettings({...settings,idDerivationKey:configuredIdKey(settings)}),
   scope:{excludedPrefixes:this.excluded()},exchangeFolder:p.desktop.settings.exchangeFolder,mode:isFreeRelayConnection(settings)?'p2p':'cloud',paused:p.core.services.appLifecycle.isSuspended()};
  // The public change token is random: it must not expose a password-verification hash.
  const digest=await ownershipDigest({workspaceId,...configuration});
  if(this.state.configurationDigest!==digest){this.state.configurationDigest=digest;this.state.configurationId=crypto.randomUUID();this.save();}
  const capability={schema:1,independentActions:1,localVaultId:this.state.vaultId,
   pluginDeviceId:session.deviceId,email:session.email,workspaceId,configurationId:this.state.configurationId,legacyBlocked:false,legacyCancellable:false};
  let previous:any;try{previous=JSON.parse(await this.read(this.directory+'/actions-capabilities.json')||'null');}catch{}
  if(!previous||Object.entries(capability).some(([key,value])=>previous[key]!==value))await this.write('actions-capabilities.json',{...capability,generatedAt:Date.now()});
  return configuration;
 }
 private async link(bound:any){
  const p=this.plugin,{session,workspaceId}=bound;
  let configuration=await this.capability(bound);
  const text=await this.read(this.directory+'/actions-request.json');if(!text)return;
  const request=JSON.parse(text);
  if(request.localVaultId!==this.state.vaultId||request.workspaceId!==workspaceId||request.pluginDeviceId!==session.deviceId||typeof request.email!=='string'||request.email.toLowerCase()!==session.email.toLowerCase()||
   !await validActionLinkProof(request.proof,await actionLinkRequestProof(request,session.refreshToken)))throw fail('action-link-binding-changed');
  const id=request.accountId+':'+workspaceId;
  let profile=this.state.profiles[id];
  if(!profile){
   const pending=this.directory+'/actions-v1/'+this.state.vaultId;
   if(await this.adapter.exists(pending)){
    const entries=await this.adapter.list(pending);if(entries.folders.length)throw fail('action-outbox-key-missing');
   }
   const key=Array.from(crypto.getRandomValues(new Uint8Array(32)),value=>value.toString(16).padStart(2,'0')).join('');
   profile={accountId:request.accountId,workspaceId,email:session.email,pluginDeviceId:session.deviceId,key,mode:configuration.mode};this.state.profiles[id]=profile;this.save();
  }
  if((profile.mode||'cloud')!==configuration.mode)throw fail('action-link-binding-changed');
  if(profile.email!==session.email||profile.pluginDeviceId!==session.deviceId)throw fail('action-link-binding-changed');
  if(profile.response?.context.nonce===request.nonce){await this.write('actions-response.json',profile.response);return;}
  const configurationId=this.state.configurationId,peer=configuration.mode==='p2p'?await this.peerService.enroll(profile,bound):undefined;
  const latestBound=await this.binding(),latestConfiguration=await this.capability(latestBound);
  if(this.disposed||latestBound.session.deviceId!==session.deviceId||latestBound.session.email!==session.email||latestBound.workspaceId!==workspaceId||this.state.configurationId!==configurationId||JSON.stringify(latestConfiguration)!==JSON.stringify(configuration))throw fail('action-binding-changed');
  const response=await sealActionLink(request,{...configuration,configurationId,outboxKey:profile.key,peer},session.refreshToken);
  const finalBound=await this.binding(),finalConfiguration=await this.capability(finalBound);if(this.disposed||finalBound.session.deviceId!==session.deviceId||finalBound.session.email!==session.email||finalBound.workspaceId!==workspaceId||this.state.configurationId!==configurationId||JSON.stringify(finalConfiguration)!==JSON.stringify(configuration))throw fail('action-binding-changed');
  profile.response=response;this.save();await this.write('actions-response.json',response);
 }
 private async admit(bound:any,profile:any,path:string,peer=false){
  const p=this.plugin,now=await this.binding();
  if(this.disposed||p.companionOwnership.blocksOrdinary||p.workspaces.busy||!p.core.services.appLifecycle.isReady()||p.core.services.appLifecycle.isSuspended()||
   now.workspaceId!==profile.workspaceId||now.session.deviceId!==profile.pluginDeviceId||now.session.email!==profile.email||
   JSON.stringify(now.settings)!==JSON.stringify(bound.settings))throw fail('action-binding-changed');
  if(isFreeRelayConnection(now.settings)!==peer)throw fail('action-peer-required');
  if(p.folderPolicies.operation||p.folderPolicies.remoteOperation||p.folderPolicies.holding)throw fail('action-policy-preparing');
  if(this.excluded().some(root=>folderContains(root,path,false))||p.folderPolicies.excludes(path)||p.folders.contains(path)||!await p.core.services.vault.isTargetFile(path))throw fail('action-outside-scope');
 }
 private store(operationId:string){
  if(!token(operationId))throw fail('action-id-invalid');
  const directory=this.directory+'/actions-v1/'+this.state.vaultId+'/'+operationId;
  return {read:(name:string)=>this.read(directory+'/'+name,512*1024),
   list:async()=>((await this.adapter.list(directory)).files as string[]).filter(path=>/\/receipt-[a-f0-9-]{36}\.json$/.test(path)),
   receipts:async()=>((await this.adapter.list(directory)).files as string[]).map(path=>path.slice(directory.length+1)).filter(name=>/^receipt-[a-f0-9-]{36}\.json$/.test(name)).slice(0,64),
   receipt:async(text:string)=>{const path=directory+'/receipt-'+crypto.randomUUID()+'.json';if(await this.adapter.exists(path))throw fail('action-file-exists');await this.adapter.write(path,text);if(await this.adapter.read(path)!==text)throw fail('action-write-unverified');}};
 }
 private identity(profile:any,id:string){return profile.peer?{schema:2,mode:'p2p',accountId:profile.accountId,workspaceId:profile.workspaceId,vaultId:this.state.vaultId,receiverId:profile.peer.receiverId,ledgerEpoch:profile.peer.ledgerEpoch,operationId:id}:{schema:1,accountId:profile.accountId,workspaceId:profile.workspaceId,vaultId:this.state.vaultId,operationId:id};}
 private async key(profile:any,id:string){return profile.peer?await actionOperationKey(profile.key,this.identity(profile,id)):profile.key;}
 private async action(profile:any,id:string,header=false){return (header?readActionHeader:readAction)(this.store(id),this.identity(profile,id),await this.key(profile,id));}
 private async receipt(profile:any,action:any){
  for(const path of (await this.store(action.identity.operationId).list()).slice(0,64)){
   try{const text=await this.read(path);if(text)return await openActionReceipt(action,text,await this.key(profile,action.identity.operationId));}catch{/* Partial or foreign receipts never confirm an operation. */}
  }return null;
 }
 private async prune(profile:any,id:string,budget:number){
  if(budget<1)return 0;
  const store=this.store(id),chunks=await confirmedActionChunks(store,this.identity(profile,id),await this.key(profile,id));
  const directory=this.directory+'/actions-v1/'+this.state.vaultId+'/'+id;let removed=0;
  for(const name of chunks){if(removed>=budget)break;const path=directory+'/'+name;
   if(await this.adapter.exists(path)){await this.adapter.remove(path);removed++;}
  }return removed;
 }
 private async drain(bound:any){
  const profile=Object.values<any>(this.state.profiles).find(value=>value.workspaceId===bound.workspaceId&&value.email===bound.session.email&&value.pluginDeviceId===bound.session.deviceId);
  if(!profile||this.plugin.companionOwnership.blocksOrdinary)return;
  const isPeer=isFreeRelayConnection(bound.settings);if(isPeer&&!profile.peer||!isPeer&&profile.peer)return;
  const root=this.directory+'/actions-v1/'+this.state.vaultId;if(!await this.adapter.exists(root))return;
  const ids=(await this.adapter.list(root)).folders.map((path:string)=>path.slice(root.length+1)).filter(token).sort();
  const available=ids.filter((id:string)=>id>this.cursor).slice(0,16);if(!available.length){this.cursor='';return;}
  const settings={...bound.settings},frozen={...bound,settings},authorization=isPeer?'':'Basic '+btoa(settings.couchDB_USER+':'+settings.couchDB_PASSWORD);
  const api=async(method:string,body:any)=>{
   const response=await requestUrl({url:this.plugin.unifiedVault.base+'/companion-actions/'+method,method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},
    body:JSON.stringify({workspace:profile.workspaceId,database:settings.couchDB_DBNAME,...body}),throw:false});
   let payload:any;try{payload=response.json;}catch{payload=null;}
   if(response.status!==200)throw fail(actionHttpError(response.status,payload));
   if(!payload||typeof payload!=='object')throw fail('action-service-unavailable');return payload;
  };
  const fetcher=this.plugin.core.services.API.webCompatFetch.bind(this.plugin.core.services.API);
  const started=Date.now();let cleanupBudget=32;
  for(const id of available){
   if(this.disposed||Date.now()-started>25000)break;this.cursor=id;
   if((this.retry.get(id)||0)>Date.now())continue;
   try{
    const header=await this.action(profile,id,true);if(await this.receipt(profile,header)){
     this.retry.delete(id);if(!this.retry.size)this.error='';
     try{cleanupBudget-=await this.prune(profile,id,cleanupBudget);}catch{/* Delivery is confirmed; cleanup retries on a later tick. */}
     continue;
    }
    const action=isPeer?header:await this.action(profile,id);
    const admit=async()=>this.admit(frozen,profile,action.intent.path,isPeer);
    const result=isPeer?await this.peerService.send(profile,action,this.store(id),await this.key(profile,id),admit):await executeCompanionAction(action,{api,admit,codec:async()=>new CompanionActionCodec(settings,fetcher,async(path:string)=>this.admit(frozen,profile,path)),
     predecessor:async(prior:string)=>this.receipt(profile,await this.action(profile,prior,true))});
    if(result.state==='confirmed'){
     await this.store(id).receipt(await sealActionReceipt(action,result,await this.key(profile,id)));
     try{cleanupBudget-=await this.prune(profile,id,cleanupBudget);}catch{/* Preserve the receipt and retry cleanup later. */}
    }
    else throw fail(result.code||'action-result-unconfirmed');
    this.retry.delete(id);if(!this.retry.size)this.error='';
   }catch(error:any){this.error=error.code||'action-unavailable';this.retry.set(id,Date.now()+30000);}
  }
 }
 async tick(){
  if(this.busy||this.disposed)return;this.busy=true;
  try{await this.load();const bound=await this.binding();try{await this.peerService.start(bound);}catch(error:any){this.error=error.code||'action-peer-unavailable';}try{await this.link(bound);}catch(error:any){this.error=error.code||'action-link-unavailable';}await this.drain(bound);}
  catch(error:any){this.error=error.code||'action-unavailable';}
  finally{this.busy=false;}
 }
}
