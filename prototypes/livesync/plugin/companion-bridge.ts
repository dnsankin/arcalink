import {readAsBlob} from '@vrtmrz/livesync-commonlib/compat/common/utils';
import {isFreeRelayConnection} from './free-relay-settings.mjs';
import {safeCompanionPath,validProofRequest,validProofFile,sha256,verifyCloudFile,proofReplyMatches,MAX_PROOF_BYTES} from './companion-proof.mjs';

import {COMPANION_READBACK_V2,peerProofV2,winningPeerMetadata} from './companion-peer-proof.mjs';
const RPC='arcalinkCompanionReadbackV1';
/** Read-only receipt capability. Never starts/stops replication or applies a remote file. */
export class CompanionBridge {
 private disposed=false;private busy=false;private epoch=crypto.randomUUID();private sequence=0;
 private peerBusy=false;private controller:AbortController|null=null;private generation=0;private context:any=null;
 private proofs=new Map<string,{result:any;next:number;delay:number}>();private proofIdentity='';
 private fileProofs=new Map<string,number>();private refreshNonce='';
 constructor(private plugin:any){
  plugin.core.services.replicator.onBeforeReplicatorPublication.addHandler(async()=>{this.generation++;this.controller?.abort();return true;});
 }
 dispose(){this.disposed=true;this.controller?.abort();}
 private identity(){
  const s=this.plugin.core.services.setting.currentSettings();
  // Comparison stays in memory; credentials never appear in bridge files.
  return JSON.stringify([this.generation,s.isConfigured,s.remoteType,s.couchDB_URI,s.couchDB_DBNAME,s.couchDB_USER,s.couchDB_PASSWORD,
   s.P2P_roomID,s.P2P_passphrase,s.passphrase,s.encrypt,s.usePathObfuscation,s.idDerivationKey,
   this.plugin.workspaces?.busy,this.plugin.core.services.appLifecycle.isSuspended()]);
 }
 private host(){try{return this.context?.replicator?.rawHost||this.plugin.arcalinkP2P?.replicator?.rawHost;}catch{return undefined;}}
 private async bytes(file:any){
  if(!validProofFile(file)||file.size>MAX_PROOF_BYTES)throw Error('unsupported');
  const item=this.plugin.app.vault.getAbstractFileByPath(file.path);
  if(!item||!('extension' in item)||item.stat.size!==file.size||item.stat.size>MAX_PROOF_BYTES)throw Error('changed');
  if(this.plugin.folders?.contains(file.path))throw Error('shared-folder-proof-unsupported');
  // Respect the same per-device exclusions as ordinary note replication.
  if(!await this.plugin.core.services.vault.isTargetFile(item))throw Error('excluded');
  const bytes=await this.plugin.app.vault.readBinary(item);
  if(bytes.byteLength!==file.size||await sha256(bytes)!==file.sha256)throw Error('changed');
  return bytes;
 }
 private registerPeerProof(){
  const host=this.host();if(!host||host.isDisposed||!host.isServing||host.assignedFunctions.has(RPC))return;
  host.serveFunction(COMPANION_READBACK_V2,async(peerId:string,input:any)=>{
   if(this.disposed||this.peerBusy)return {schema:2,applied:false};
   const identity=this.identity();this.peerBusy=true;
   try{return await peerProofV2(input,{
    isCurrent:()=>!this.disposed&&identity===this.identity()&&host===this.host(),
    isAccepted:async()=>await host.evaluatePeerAcceptance(peerId)==='accepted',
    isTarget:async(path:string)=>!this.plugin.folders?.contains(path)&&await this.plugin.core.services.vault.isTargetFile(path),
    getMetadata:async(path:string)=>{const id=await this.plugin.core.services.path.path2id(path);return await winningPeerMetadata(this.plugin.core.services.database.localDatabase.localDatabase,id);},
    readBytes:async(path:string)=>{const file=this.plugin.app.vault.getAbstractFileByPath(path);if(!file)return null;if(!('extension' in file))throw Error('unsupported');return await this.plugin.app.vault.readBinary(file);},
    readProvenance:async(path:string)=>await this.plugin.core.serviceModules.fileHandler.readProvenanceSnapshot(path),
   });}catch{return {schema:2,applied:false};}finally{this.peerBusy=false;}
  });
  host.serveFunction(RPC,async(peerId:string,input:any)=>{
   if(this.disposed||this.peerBusy||!input||input.schema!==1||!/^[a-zA-Z0-9-]{16,100}$/.test(input.nonce)||!validProofFile(input.file))return {schema:1,applied:false};
   const identity=this.identity();this.peerBusy=true;
   try{
    if(host!==this.host()||await host.evaluatePeerAcceptance(peerId)!=='accepted')return {schema:1,applied:false};
    await this.bytes(input.file);
    if(this.disposed||identity!==this.identity()||host!==this.host()||await host.evaluatePeerAcceptance(peerId)!=='accepted')return {schema:1,applied:false};
    return {schema:1,nonce:input.nonce,...input.file,applied:true};
   }catch{return {schema:1,applied:false};}finally{this.peerBusy=false;}
  });
 }
 async tick(){
  if(this.disposed||this.busy)return;this.busy=true;
  try{await this.plugin.core.services.replicator.runWithActiveReplicatorContext(async(context:any)=>{this.context=context;try{await this.run();}finally{this.context=null;}});}
  catch{/* Publication unavailable: no receipt is better than an inferred success. */}
  finally{this.busy=false;}
 }
 private async run(){
  if(this.disposed)return;
  try{
   this.registerPeerProof();
   const p=this.plugin,adapter=p.app.vault.adapter,folder=p.pilotDirectory+'/companion';
   if(!await adapter.exists(folder+'/requests.json'))return;
   const text=await adapter.read(folder+'/requests.json');if(text.length>1024*1024)return;
   const input=JSON.parse(text);if(!validProofRequest(input))return;
   const identity=this.identity(),current=()=>!this.disposed&&identity===this.identity();
   if(this.proofIdentity!==identity||this.refreshNonce!==(input.refreshNonce||'')){this.proofs.clear();this.fileProofs.clear();this.proofIdentity=identity;this.refreshNonce=input.refreshNonce||'';}
   const keyOf=(request:any)=>JSON.stringify([input.vaultId,input.refreshNonce||'',request]);
   const keys=new Set<string>(input.requests.map(keyOf));for(const key of this.proofs.keys())if(!keys.has(key))this.proofs.delete(key);
   const settings={...p.core.services.setting.currentSettings()},free=isFreeRelayConnection(settings);
   const target=await sha256(new TextEncoder().encode(JSON.stringify(free?[settings.P2P_roomID]:[settings.couchDB_URI,settings.couchDB_DBNAME])));
   const started=Date.now(),results:any[]=[];
   this.controller=new AbortController();const abortTimer=window.setTimeout(()=>this.controller?.abort(),15000);
   const engine=this.context.replicator;
   let connection:any;
   try{
    const needsRemote=input.requests.some((request:any)=>!this.proofs.has(keyOf(request))||this.proofs.get(keyOf(request))!.next<=Date.now());
    if(needsRemote&&settings.isConfigured&&!free&&navigator.onLine&&!p.core.services.appLifecycle.isSuspended()&&typeof engine?.connectRemoteCouchDBWithSetting==='function'){
     const value=await engine.connectRemoteCouchDBWithSetting(settings,!!p.app.isMobile,false,true,{signal:this.controller.signal,allowNativeFallback:false});
     if(typeof value!=='string')connection=value;
    }
    for(const request of input.requests){
     if(!current()||Date.now()-started>15000)break;
     const key=keyOf(request),previous=this.proofs.get(key);
     if(previous&&previous.next>Date.now()){results.push(previous.result);continue;}
     let state='pending',scope='',peer='',verifiedAt=Date.now();
     try{
      for(const file of request.files)await this.bytes(file);
      if(free){
       const host=this.host();
       if(host?.isServing){
        for(const info of host.knownAdvertisements.slice(0,8)){
         if(Date.now()-started>15000||!current())break;
         const peerId=info.peerId;
         if(typeof peerId!=='string'||await host.evaluatePeerAcceptance(peerId)!=='accepted')continue;
         const nonce=crypto.randomUUID();let complete=true;
         for(const file of request.files){
          if(!current()||Date.now()-started>15000){complete=false;break;}
          const fileKey=JSON.stringify(['peer-vault',peerId,file]);
          const historical=this.fileProofs.get(fileKey);if(historical){verifiedAt=Math.min(verifiedAt,historical);continue;}
          const reply=await host.getConnection(peerId).invokeRemoteFunction(RPC,[{schema:1,nonce,file}],3000,this.controller?.signal);
          if(!proofReplyMatches(reply,file,nonce)||!current()||host!==this.host()){complete=false;break;}
          const time=Date.now();this.fileProofs.set(fileKey,time);verifiedAt=Math.min(verifiedAt,time);
         }
         if(complete&&await host.evaluatePeerAcceptance(peerId)==='accepted'){state='confirmed';scope='peer-vault';peer=peerId;break;}
        }
       }
      }else if(connection){
       let complete=true;
       for(const file of request.files){
        const fileKey=JSON.stringify(['cloud',file]),historical=this.fileProofs.get(fileKey);
        if(historical){verifiedAt=Math.min(verifiedAt,historical);continue;}
        const id=await p.core.services.path.path2id(file.path);
        const get=async(key:string)=>{try{return await connection.db.get(key,{conflicts:true});}catch(e:any){if(e.status===404)return false;throw e;}};
        if(!await verifyCloudFile(file,{id,get,decode:async(doc:any)=>await readAsBlob(doc).arrayBuffer(),stillCurrent:()=>current()&&Date.now()-started<=15000})){complete=false;break;}
        const time=Date.now();this.fileProofs.set(fileKey,time);verifiedAt=Math.min(verifiedAt,time);
       }
       if(complete){state='confirmed';scope='cloud';}
      }
      // A receipt never outlives a concurrent local edit, even within this pass.
      for(const file of request.files)await this.bytes(file);
     }catch(error:any){state=error.message==='changed'?'changed':error.message==='unsupported'?'unsupported':['excluded','shared-folder-proof-unsupported'].includes(error.message)?'excluded':'pending';scope='';peer='';}
     if(!current())return;
     const result={id:request.id,state,scope,peer,files:request.files,verifiedAt};results.push(result);
     const delay=state==='confirmed'?Infinity:Math.min((previous?.delay||7500)*2,300000);
     this.proofs.set(key,{result,next:Date.now()+delay,delay});
    }
   if(this.fileProofs.size>5000){this.fileProofs.clear();}
   }finally{window.clearTimeout(abortTimer);this.controller?.abort();this.controller=null;if(connection)await connection.close();}
   if(!current())return;
   const snapshot={schema:1,vaultId:input.vaultId,epoch:this.epoch,sequence:++this.sequence,generatedAt:Date.now(),target,
    refreshNonce:input.refreshNonce||'',mode:free?'relay':'cloud',online:navigator.onLine,configured:!!settings.isConfigured,paused:!!p.core.services.appLifecycle.isSuspended(),results};
   await adapter.write(folder+'/status.json',JSON.stringify(snapshot));
  }catch{/* Malformed requests or a failed read never mint a positive receipt. */}
 }
}
