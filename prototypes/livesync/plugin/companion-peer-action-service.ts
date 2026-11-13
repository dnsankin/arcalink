import {requestUrl} from 'obsidian';
import {configuredIdKey} from '@vrtmrz/livesync-commonlib/settings';
import {RpcRoom,subscribeTrysteroPeerEvents} from '@vrtmrz/livesync-commonlib/rpc';
import {isFreeRelayConnection} from './free-relay-settings.mjs';
import {actionHash} from './companion-action-outbox.mjs';
import {actionGrantFormatProof,actionGrantProof} from './companion-peer-action-session.mjs';
import {openAtomicActionStore} from './companion-peer-action-atomic-store.mjs';
import {openPeerActionPrivateDb} from './companion-peer-action-private-db.mjs';
import {createActionGrantRegistry} from './companion-peer-action-grants.mjs';
import {createPeerActionProtocol} from './companion-peer-action-protocol.mjs';
import {createPeerActionChannel} from './companion-peer-action-channel.mjs';
import {createPeerActionIngress} from './companion-peer-action-ingress.mjs';
import {createPeerActionDispatch} from './companion-peer-action-dispatch.mjs';
import {createPeerActionCipherStore} from './companion-peer-action-cipher-store.mjs';
import {openPeerActionClient} from './companion-peer-action-client.mjs';
import {sendPeerAction} from './companion-peer-action-send.mjs';
import {createPeerActionResults} from './companion-peer-action-results.mjs';
const fail=(code:string)=>Object.assign(Error(code),{code});
const token=(v:any)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(v);
const randomSecret=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
/** One private receiver per canonical vault; ordinary P2P DB RPC is untouched. */
export class CompanionPeerActionService{
 private host:any=null;private channel:any=null;private protocol:any=null;private ingress:any=null;private privateDb:any=null;private anchorDb:any=null;private disposed=false;private account='';private workspace='';private generation=0;private starting:Promise<void>|null=null;private closing:Promise<void>=Promise.resolve();private capturedCore:any=null;private capturedServices:any=null;private sessionKey='';private guard:(()=>Promise<boolean>)|null=null;private dispatchBusy=false;private senders=new Set<AbortController>();
 constructor(private plugin:any,private state:()=>any,private save:()=>void,private atomicFactory:any=openAtomicActionStore){plugin.core?.services?.replicator?.onBeforeReplicatorPublication?.addHandler(()=>{void this.close().catch(()=>{});return true;});}
 close(){this.generation++;for(const controller of this.senders)controller.abort();this.senders.clear();const channel=this.channel;channel?.close();this.protocol?.close();this.ingress?.close();this.channel=this.protocol=this.ingress=this.host=this.guard=null;const db=this.privateDb,anchor=this.anchorDb;this.privateDb=this.anchorDb=null;const previous=this.closing;
  const work=(async()=>{let prior:any;try{await previous;}catch(error){prior=error;}await channel?.closeAndDrain();const outcomes=await Promise.allSettled([db?.close(),anchor?.close()]);const failed=outcomes.find(result=>result.status==='rejected') as PromiseRejectedResult|undefined;if(prior)throw prior;if(failed)throw failed.reason;})();this.closing=work;return work;}
 dispose(){this.disposed=true;void this.close().catch(()=>{});}
 private async currentAccount(bound:any){let session=structuredClone(bound.session);const fetchMe=()=>requestUrl({url:'https://arcalink.ru/auth/me',headers:{Authorization:'Bearer '+session.accessToken},throw:false});let result=await fetchMe();if(result.status===401&&session.refreshToken){session=structuredClone(await this.plugin.freeRelay.refresh({...session,group:session.group||bound.workspaceId}));result=await fetchMe();}if(result.status!==200||!token(result.json?.user?.id)||typeof result.json?.user?.email!=='string'||result.json.user.email.toLowerCase()!==String(session.email).toLowerCase()||result.json?.device?.id!==session.deviceId)throw fail('action-binding-changed');return {account:result.json.user.id,accessToken:session.accessToken,deviceId:session.deviceId,email:session.email};}
 private async persistentAccepted(host:any,peer:string){
  if(await host.evaluatePeerAcceptance(peer)!=='accepted')return null;const name=host.knownAdvertisements.find((item:any)=>item.peerId===peer)?.name;if(typeof name!=='string'||!name||name.length>256)return null;
  const decision=await host.acceptedPeers.get(name);if(decision===true)return name;if(decision===false)return null;
  const s=this.plugin.core.services.setting.currentSettings(),match=(text:any)=>String(text||'').split(',').map((v:string)=>v.trim()).filter(Boolean).some((v:string)=>new RegExp(v.startsWith('~')?v.slice(1):'^'+v+'$','i').test(name));
  try{return !match(s.P2P_AutoDenyingPeers)&&(s.P2P_AutoAccepting===1||match(s.P2P_AutoAcceptingPeers))?name:null;}catch{return null;}
 }
 private async peerStillAccepted(host:any,name:string){
  const decision=await host.acceptedPeers.get(name);if(decision===true)return true;if(decision===false)return false;
  const s=this.plugin.core.services.setting.currentSettings(),match=(text:any)=>String(text||'').split(',').map((v:string)=>v.trim()).filter(Boolean).some((v:string)=>new RegExp(v.startsWith('~')?v.slice(1):'^'+v+'$','i').test(name));
  try{return !match(s.P2P_AutoDenyingPeers)&&(s.P2P_AutoAccepting===1||match(s.P2P_AutoAcceptingPeers));}catch{return false;}
 }
 private format(){const settings=this.plugin.core.services.setting.currentSettings();return {...settings,idDerivationKey:configuredIdKey(settings)};}
 async start(bound:any){if(this.starting)return this.starting;bound=structuredClone(bound);const work=this.startOnce(bound);this.starting=work;try{await work;}finally{if(this.starting===work)this.starting=null;}}
 private async startOnce(bound:any){
  const p=this.plugin,settings=p.core.services.setting.currentSettings();if(this.disposed||!isFreeRelayConnection(settings)||p.companionOwnership.blocksOrdinary){await this.close();return;}
  const host=await p.core.services.replicator.runWithActiveReplicatorContext(async(context:any)=>context?.replicator?.rawHost);if(!host?.room||!host.isServing)return;
  const sessionKey=JSON.stringify([bound.session.deviceId,bound.session.email,bound.workspaceId]);
  if(this.host===host&&this.channel&&this.privateDb&&this.capturedCore===p.core&&this.capturedServices===p.core.services&&this.sessionKey===sessionKey&&await this.privateDb.current())return;
  const closing=this.close(),generation=this.generation;await closing;const core=p.core,services=core.services,verified=await this.currentAccount(bound),account=verified.account,workspace=bound.workspaceId,dbService=services.database,main=dbService.localDatabase.localDatabase,state=this.state();
  const anchorDb=dbService.createPouchDBInstance('arcalink-peer-anchor-'+state.vaultId,{auto_compaction:false});if(await anchorDb.id()===await main.id()){await anchorDb.close();throw fail('action-private-db-invalid');}
  const scopeId=await actionHash(JSON.stringify([account,workspace])),anchorId='_local/anchor-'+scopeId;
  const anchor={load:async()=>{try{const row=await anchorDb.get(anchorId);if(!state.peerAnchors?.[scopeId]){state.peerAnchors??={};state.peerAnchors[scopeId]=true;this.save();}return row.value;}catch(e:any){if(e.status!==404)throw e;if(state.peerAnchors?.[scopeId])throw fail('action-private-db-missing');return null;}},saveIfAbsent:async(value:any)=>{if(state.peerAnchors?.[scopeId])throw fail('action-private-db-missing');try{await anchorDb.put({_id:anchorId,value});state.peerAnchors??={};state.peerAnchors[scopeId]=true;this.save();return true;}catch(e:any){if(e.status===409)return false;throw e;}}};
  let privateDb:any;try{privateDb=await openPeerActionPrivateDb({database:dbService,anchor,account,workspace,initialize:true,atomicOpen:(options:any)=>this.atomicFactory({...options,admit:async()=>{if(!await this.guard?.())throw fail('action-binding-changed');}})});}catch(e){await anchorDb.close();throw e;}
  const latestSaved=await p.unifiedVault.saved(),latestWorkspace=await p.workspaces.session(),latest=await p.freeRelay.session()||latestSaved?.auth;
  if(this.disposed||generation!==this.generation||p.core!==core||core.services!==services||services.database!==dbService||dbService.localDatabase.localDatabase!==main||(latestSaved?.workspaceId||latestWorkspace.workspaceId)!==workspace||latest?.deviceId!==verified.deviceId||latest?.email!==verified.email||latest?.accessToken!==verified.accessToken||p.workspaces.busy||p.companionOwnership.blocksOrdinary||!services.appLifecycle.isReady()||services.appLifecycle.isSuspended()||!isFreeRelayConnection(services.setting.currentSettings())||!host.room||!host.isServing||!await privateDb.current()){await privateDb.close();await anchorDb.close();return;}
  let authenticatedAccess=verified.accessToken;
  this.host=host;this.privateDb=privateDb;this.anchorDb=anchorDb;this.account=account;this.workspace=workspace;this.capturedCore=core;this.capturedServices=services;this.sessionKey=sessionKey;
  try{
  const current=async()=>{if(this.disposed||generation!==this.generation||p.core!==core||core.services!==services||this.host!==host||p.arcalinkP2P?.replicator?.rawHost&&p.arcalinkP2P.replicator.rawHost!==host||!host.room||!host.isServing||p.core.services.database!==dbService||!await privateDb.current()||p.workspaces.busy||p.companionOwnership.blocksOrdinary||p.folderPolicies.operation||p.folderPolicies.remoteOperation||p.folderPolicies.holding||!p.core.services.appLifecycle.isReady()||p.core.services.appLifecycle.isSuspended()||!isFreeRelayConnection(p.core.services.setting.currentSettings()))return false;
   const saved=await p.unifiedVault.saved(),workspaceState=await p.workspaces.session(),session=await p.freeRelay.session()||saved?.auth;
   if(!session?.accessToken||session.deviceId!==bound.session.deviceId||session.email!==bound.session.email)return false;
   if(session.accessToken!==authenticatedAccess){const checked=await this.currentAccount({...bound,session}),again=await p.freeRelay.session()||(await p.unifiedVault.saved())?.auth;if(checked.account!==account||again?.accessToken!==checked.accessToken||again?.deviceId!==checked.deviceId||again?.email!==checked.email)return false;authenticatedAccess=checked.accessToken;}
   return !this.disposed&&generation===this.generation&&p.core===core&&this.host===host&&p.core.services.database===dbService&&(saved?.workspaceId||workspaceState.workspaceId)===workspace&&await privateDb.current();};
  this.guard=current;const registry=createActionGrantRegistry({db:privateDb.db,...privateDb.binding,authorize:async(grant:any)=>await current()&&await this.peerStillAccepted(host,grant.sourcePeerName)&&grant.formatProof===await actionGrantFormatProof(grant.secret,this.format())&&await current()});
  let protocol:any;const ingress=createPeerActionIngress({db:privateDb.db,atomic:privateDb.atomic,assertCurrent:async(peer:string,grantId:string)=>await current()&&await protocol.isCurrent(peer,grantId),dispatch:async({grant,peerId,identity,key,staging,signal,recoverOnly}:any)=>{
   if(this.dispatchBusy)throw fail('action-receiver-busy');this.dispatchBusy=true;try{
   const scope={account,workspace,receiverId:grant.receiverId,ledgerEpoch:grant.ledgerEpoch,grantId:grant.grantId};
   const assertSession=async(peer:string,id:string)=>!signal.aborted&&await current()&&await protocol.isCurrent(peer,id),results=createPeerActionResults({db:privateDb.db,scope:privateDb.binding,admit:async()=>{if(!await assertSession(peerId,grant.grantId))throw fail('action-session-invalid');}});
   const run=createPeerActionDispatch({plugin:p,host,registry,journalDb:privateDb.db,store:(i:any)=>privateDb.atomic?{read:async(name:string)=>(await staging.store(i,key)).read(name)}:createPeerActionCipherStore({db:privateDb.db,scope,identity:i}),verifyStaged:(i:any,k:string)=>staging.verify(i,k),assertSession,predecessor:async(g:any,id:string)=>results.get(g.grantId,g.sourceVaultId,id)});
   const result=await run({grantId:grant.grantId,peerId,operationId:identity.operationId,key,recoverOnly});if(result.state==='confirmed'){await results.put(grant.grantId,grant.sourceVaultId,identity.operationId,result);if(staging.release)await staging.release(identity,key,async()=>result);}return result;
   }finally{this.dispatchBusy=false;}
  }});
  protocol=createPeerActionProtocol({registry,receiverPeerId:host.serverPeerId,execute:async(input:any)=>(input.method==='dispatch'||input.method==='recover')?ingress.execute(input):services.replicator.runWithActiveReplicatorContext(async(context:any)=>{if(context?.replicator?.rawHost!==host)throw fail('action-binding-changed');return ingress.execute(input);}),onSessionReset:((peer:string)=>ingress.leave(peer)) as any,authenticatePair:async(peerId:string,input:any,signal:AbortSignal)=>services.replicator.runWithActiveReplicatorContext(async(context:any)=>{
   if(context?.replicator?.rawHost!==host)throw fail('action-binding-changed');
   if(signal.aborted||!await current())throw fail('action-binding-changed');const name=await this.persistentAccepted(host,peerId);if(signal.aborted||!name||!input||input.account!==account||input.workspace!==workspace)throw fail('action-peer-not-approved');
   if(input.step==='capabilities'&&Object.keys(input).sort().join(',')==='account,step,workspace')return {...privateDb.binding};
   if(input.step!=='enroll'||Object.keys(input).sort().join(',')!=='account,grant,step,workspace')throw fail('action-grant-invalid');
   const grant=input.grant;if(grant?.sourcePeerName!==name||grant.formatProof!==await actionGrantFormatProof(grant.secret,this.format())||await this.persistentAccepted(host,peerId)!==name)throw fail('action-grant-not-admitted');
   await registry.enroll(grant,async()=>!signal.aborted&&await current()&&await this.persistentAccepted(host,peerId)===name);if(signal.aborted||!await current()||await this.persistentAccepted(host,peerId)!==name)throw fail('action-grant-not-admitted');return {grantId:grant.grantId,proof:await actionGrantProof(grant.secret,grant)};
  })});
  const channel=createPeerActionChannel({room:host.room,RpcRoom,subscribePeers:subscribeTrysteroPeerEvents,handlers:protocol.handlers,onLeave:((peer:string)=>{protocol.leave(peer);ingress.leave(peer);}) as any});this.protocol=protocol;this.ingress=ingress;this.channel=channel;
  }catch(error){await this.close();throw error;}
 }
 async enroll(profile:any,bound:any){
  await this.start(bound);const host=this.host,channel=this.channel,guard=this.guard;if(!host||!channel||!guard||!await guard())throw fail('action-peer-required');
  if(profile.peer)return profile.peer;
  const checked=await this.currentAccount(bound),account=checked.account;if(account!==profile.accountId)throw fail('action-binding-changed');
  const peers=host.knownAdvertisements.filter((item:any)=>token(item.peerId)).sort((a:any,b:any)=>a.peerId.localeCompare(b.peerId)).slice(0,8);
  let pending=profile.pendingPeer;
  for(const item of peers){const name=await this.persistentAccepted(host,item.peerId);if(!name||pending&&pending.receiverPeerName!==name)continue;
   let cap:any;try{cap=await channel.call(item.peerId,'action.pair',{step:'capabilities',account,workspace:bound.workspaceId},{timeoutMs:5000});}catch{continue;}
   if(cap?.account!==account||cap.workspace!==bound.workspaceId||!token(cap.receiverId)||!token(cap.ledgerEpoch))continue;
   if(pending&&(pending.grant.receiverId!==cap.receiverId||pending.grant.ledgerEpoch!==cap.ledgerEpoch))continue;
   if(!pending){const grant:any={account,workspace:bound.workspaceId,sourceVaultId:this.state().vaultId,sourceDeviceId:bound.session.deviceId,receiverId:cap.receiverId,ledgerEpoch:cap.ledgerEpoch,grantId:crypto.randomUUID(),secret:randomSecret(),sourcePeerName:host.deviceInfo.name};grant.formatProof=await actionGrantFormatProof(grant.secret,this.format());if(this.guard!==guard||!await guard())throw fail('action-binding-changed');pending={receiverPeerName:name,grant};profile.pendingPeer=pending;this.save();}
   const grant=pending.grant,reply:any=await channel.call(item.peerId,'action.pair',{step:'enroll',account,workspace:bound.workspaceId,grant},{timeoutMs:5000});
   if(reply?.grantId!==grant.grantId||reply.proof!==await actionGrantProof(grant.secret,grant)||await this.persistentAccepted(host,item.peerId)!==name||this.guard!==guard||!await guard())throw fail('action-grant-not-admitted');
   profile.peer=grant;delete profile.pendingPeer;this.save();return grant;
  }throw fail('action-peer-required');
 }
 async send(profile:any,action:any,store:any,key:string,admit:()=>Promise<void>){
  const host=this.host,channel=this.channel,grant=profile.peer;if(!host||!channel||!grant)throw fail('action-peer-required');
  const controller=new AbortController();this.senders.add(controller);try{
  for(const peer of host.knownAdvertisements.slice(0,8)){if(!token(peer.peerId)||!await this.persistentAccepted(host,peer.peerId))continue;
   let client:any;try{client=await openPeerActionClient({channel,peerId:peer.peerId,sourcePeerId:host.serverPeerId,grant,signal:controller.signal,timeoutMs:10000});}catch{continue;}try{return await sendPeerAction({client,store,identity:action.identity,key,admit});}finally{client.close();}
  }throw fail('action-peer-required');
  }finally{this.senders.delete(controller);}
 }
}
