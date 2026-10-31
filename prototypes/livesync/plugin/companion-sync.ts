import {NO_INTERACTION} from '@vrtmrz/livesync-commonlib/replication';

/** A local hint to the existing engine. This is never a delivery receipt. */
export class CompanionSync {
 private busy=false;private disposed=false;private lastId='';private lastAttempt=0;
 constructor(private plugin:any){}
 dispose(){this.disposed=true;}
 private identity(){
  const p=this.plugin,s=p.core.services.setting.currentSettings();
  return JSON.stringify([p.pilotDirectory,s.remoteType,s.couchDB_URI,s.couchDB_DBNAME,s.couchDB_USER,
   s.P2P_roomID,s.P2P_passphrase,s.passphrase,s.encrypt,s.isConfigured]);
 }
 private eligible(){
  const p=this.plugin,s=p.core.services.setting.currentSettings(),lifecycle=p.core.services.appLifecycle;
  return !this.disposed&&s.isConfigured&&navigator.onLine&&lifecycle.isReady()&&!lifecycle.isSuspended()&&!p.workspaces?.busy;
 }
 private async read(name:string){
  const adapter=this.plugin.app.vault.adapter,path=this.plugin.pilotDirectory+'/companion/'+name;
  const stat=await adapter.stat(path);if(!stat||stat.type!=='file'||stat.size>4096)return null;
  const text=await adapter.read(path);if(text.length>4096)return null;
  return JSON.parse(text);
 }
 async tick(){
  if(this.disposed||this.busy||!this.eligible()||Date.now()-this.lastAttempt<5000)return;
  this.busy=true;
  try{
   const request=await this.read('sync-request.json'),now=Date.now();
   if(!request||request.schema!==1||typeof request.id!=='string'||!/^[a-f0-9-]{36}$/.test(request.id)
    ||!['save','widget','manual'].includes(request.reason)||!Number.isSafeInteger(request.requestedAt)
    ||request.requestedAt>now+5000||now-request.requestedAt>86400000||request.id===this.lastId)return;
   const previous=await this.read('sync-result.json');
   if(previous?.schema===1&&previous.id===request.id){this.lastId=request.id;return;}
   if(!this.eligible())return;
   const identity=this.identity(),current=()=>this.eligible()&&identity===this.identity();
   // Reuse the ordinary scan so external SAF writes reach the local database.
   // It respects suspension, folder policy, conflicts and the active vault.
   await this.plugin.core.services.vault.scanVault(false,false,true);
   if(!current())return;
   const latest=await this.read('sync-request.json');
   if(latest?.id!==request.id||!current())return;
   const path=this.plugin.pilotDirectory+'/companion/sync-result.json';
   const result={schema:1,id:request.id,requestedAt:request.requestedAt,handledAt:Date.now(),state:'requested'};
   // Record consumption before calling the engine: restarts must not repeatedly
   // kick the same request. Any engine retries stay owned by the existing engine.
   await this.plugin.app.vault.adapter.write(path,JSON.stringify(result));
   if(!current())return;
   this.lastId=request.id;this.lastAttempt=Date.now();
   let state='failed';
   try{
    const outcome=await this.plugin.core.services.replication.replicateUnattendedByEvent({trigger:'database-event',interaction:NO_INTERACTION});
    state=['completed','blocked','cancelled','partial','failed'].includes(outcome?.status)?outcome.status:'requested';
   }catch{/* The local save is unaffected; the existing engine owns recovery. */}
   if(current())await this.plugin.app.vault.adapter.write(path,JSON.stringify({...result,state}));
  }catch{/* Missing/partial mailbox and an older companion are normal. */}
  finally{this.busy=false;}
 }
}
