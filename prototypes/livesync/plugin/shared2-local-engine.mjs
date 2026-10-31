import {createShared2MigrationView} from './shared2-migration-view.mjs';
import {installShared2BoundedSplitter} from './shared2-bounded-splitter.mjs';
import {resolveShared2Key} from './shared2-encryption.mjs';
import {wrapShared2LocalBulk} from './shared2-local-bulk.mjs';
import {decodeBinary} from 'octagonal-wheels/binary';
import {ServiceContext} from '@vrtmrz/livesync-commonlib/context';
import {LiveSyncLocalDB} from '@vrtmrz/livesync-commonlib/compat/pouchdb/LiveSyncLocalDB';
import {DEFAULT_SETTINGS,E2EEAlgorithms} from '@vrtmrz/livesync-commonlib/compat/common/types';
import {readAsBlob} from '@vrtmrz/livesync-commonlib/compat/common/utils';
import {InjectableAPIService} from '@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectableAPIService';
import {InjectableSettingService} from '@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectableSettingService';
import {InjectableDatabaseEventService} from '@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectableDatabaseEventService';
import {InjectableAppLifecycleService} from '@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectableAppLifecycleService';
import {InjectableReplicatorService} from '@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectableReplicatorService';
import {PathServiceCompat} from '@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectablePathService';
import {createShared2Replication} from './shared2-replication.mjs';
import {safeRelative} from './folder-model.mjs';

const fail=code=>Object.assign(Error(code),{code});
const OPTIONS=new Set(['hashAlg','chunkSplitterVersion','customChunkSize','minimumChunkSize','useEden','maxChunksInEden','maxTotalLengthInEden','handleFilenameCaseSensitive','enableCompression','disableWorkerForGeneratingChunks','disableWorkerForDecrypting']);

/** Local storage adapter using the actual pinned LiveSync engine. No remote
 * replication is started here. Encrypted/rekey profiles are explicitly refused
 * until the separate crypto/remote adapters exist, never silently downgraded.
 */
/** @param {{createPouchDB: Function, settingsFor: Function, namespace?: string, log?: Function, openRemote?: Function, accessCheck?: Function, keyProvider?: Function, migrationMode?: boolean, personalEncryptionFor?: Function}} options */
export function createShared2LocalEngineFactory({createPouchDB,settingsFor,namespace='shared2-local',log=()=>{},openRemote=undefined,accessCheck=undefined,keyProvider=undefined,migrationMode=false,personalEncryptionFor=undefined}){
 if(typeof createPouchDB!=='function'||typeof settingsFor!=='function'||!/^shared2-[A-Za-z0-9_-]{1,80}$/.test(namespace))throw fail('invalid-shared2-engine-factory');
 if(personalEncryptionFor!==undefined&&typeof personalEncryptionFor!=='function')throw fail('invalid-shared2-personal-settings-adapter');
 if(openRemote!==undefined&&(typeof openRemote!=='function'||typeof accessCheck!=='function'))throw fail('shared2-remote-access-check-required');
 return async profile=>{
  profile=Object.freeze({...profile});
  const validIdentity=v=>typeof v==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(v);
  if(!validIdentity(profile.account)||!validIdentity(profile.workspace)||!['personal','shared'].includes(profile.kind)||!Number.isSafeInteger(profile.generation)||profile.generation<1
    ||!new RegExp('^arcalink_'+(profile.kind==='shared'?'s':'p')+'_[a-f0-9]{32}$').test(profile.database)
    ||(profile.kind==='shared'&&(typeof profile.encrypted!=='boolean'||!Number.isSafeInteger(profile.keyEpoch)||profile.keyEpoch<0||!['owner','editor','viewer'].includes(profile.role))))throw fail('invalid-shared2-engine-profile');
  const personal=profile.kind==='personal'&&personalEncryptionFor?await personalEncryptionFor(profile):null;
  if(personal&&((typeof personal.encrypt!=='boolean'||personal.encrypt!==profile.encrypted)||personal.encrypt&&(typeof personal.passphrase!=='string'||!personal.passphrase)||personal.usePathObfuscation!==undefined&&typeof personal.usePathObfuscation!=='boolean'||personal.E2EEAlgorithm!==undefined&&!Object.values(E2EEAlgorithms).includes(personal.E2EEAlgorithm)))throw fail('shared2-private-cipher-settings-required');
  if(profile.encrypted&&!personal&&typeof keyProvider!=='function')throw fail('shared2-encrypted-engine-not-ready');
  if(profile.encrypted&&!/^[a-f0-9]{32}$/.test(profile.folder))throw fail('invalid-shared2-folder');
  if(!profile.encrypted&&profile.keyEpoch>0)throw fail('invalid-shared2-encryption-epoch');
  const key=profile.encrypted?(personal?{passphrase:personal.passphrase}:await resolveShared2Key(profile,keyProvider)):null;
  if(profile.cacheEpoch!==undefined&&!/^[a-f0-9]{32}$/.test(profile.cacheEpoch))throw fail('invalid-shared2-cache-epoch');
  const resolved=await settingsFor(profile);
  if(!resolved||resolved.database!==profile.database||resolved.generation!==profile.generation||!resolved.settings)throw fail('shared2-engine-settings-scope-mismatch');
  for(const key of Object.keys(resolved.settings))if(!OPTIONS.has(key))throw fail('unsupported-shared2-engine-option');
  const settings={...structuredClone(DEFAULT_SETTINGS),...structuredClone(resolved.settings),isConfigured:true,remoteType:'',encrypt:!!key,passphrase:key?.passphrase||'',usePathObfuscation:personal?(personal.encrypt&&personal.usePathObfuscation===true):!!key,E2EEAlgorithm:personal?(personal.E2EEAlgorithm??E2EEAlgorithms.V1):(key?'v2':DEFAULT_SETTINGS.E2EEAlgorithm),...(personal?{useDynamicIterationCount:personal.useDynamicIterationCount===true}:{}),
   couchDB_URI:'',couchDB_USER:'',couchDB_PASSWORD:'',activeConfigurationId:'',remoteConfigurations:{},P2P_Enabled:false,
   hashCacheMaxCount:profile.kind==='shared'?1:DEFAULT_SETTINGS.hashCacheMaxCount,syncInternalFiles:false,syncIgnoreRegEx:'',liveSync:false,periodicReplication:false,syncOnStart:false,syncOnSave:false,syncOnFileOpen:false};
  const context=new ServiceContext(),API=new InjectableAPIService(context);API.addLog.setHandler(log);
  const setting=new InjectableSettingService(context,{APIService:API});setting.settings=settings;
  setting.saveData.setHandler(async()=>{});setting.loadData.setHandler(async()=>structuredClone(settings));
  const databaseEvents=new InjectableDatabaseEventService(context);
  const appLifecycle=new InjectableAppLifecycleService(context,{settingService:setting});
  const replicator=new InjectableReplicatorService(context,{settingService:setting,appLifecycleService:appLifecycle,databaseEventService:databaseEvents,registerLifecycleHandlers:false});
  const path=new PathServiceCompat(context,{settingService:setting});
  const services={context,API,setting,path,databaseEvents,appLifecycle,replicator,database:{createPouchDBInstance:(name,options)=>wrapShared2LocalBulk(createPouchDB(name,options))}};
  // Physical cache identity includes every isolation boundary, but no key values.
  const identity=JSON.stringify([profile.account,profile.workspace,profile.database,profile.generation,profile.keyEpoch||0,profile.cacheEpoch||null]);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const local=new LiveSyncLocalDB(namespace+'-'+hash,{services});let closed=false,retiring=false,closing;
  try{if(!await local.initializeDatabase())throw fail('shared2-engine-initialisation-rejected');}
  catch(error){await local.close().catch(()=>{});throw error;}
  if(profile.kind==='shared')installShared2BoundedSplitter(local);
  const transfer=openRemote&&profile.kind==='shared'?createShared2Replication({database:local.localDatabase,profile,openRemote,accessCheck}):null;
  const checked=name=>{if(closed||retiring)throw fail('shared2-engine-closed');if(!safeRelative(name))throw fail('invalid-shared2-document-path');};
  return {
   ...(migrationMode?{migration:createShared2MigrationView(local,{readOnly:profile.role==='viewer',pathId:name=>path.path2id(name),chunkId:async piece=>'h:'+await local.managers.hashManager.computeHash(piece)})}:{}),
   synchronize(){if(closed||retiring)return Promise.reject(fail('shared2-engine-closed'));if(!transfer)return Promise.reject(fail('shared2-remote-not-configured'));return transfer.synchronize();},
   async inspect(){
    checked('shared2-inspection');const sequence=(await local.localDatabase.info()).update_seq,files=[],chunks=[],reserved=[];let start;
    for(;;){
     checked('shared2-inspection');const options={limit:32,...(start?{startkey:start,skip:1}:{})};const page=await local.localDatabase.allDocs(options);
     if(!page.rows.length)break;
     for(const row of page.rows){const id=row.id;if(id.startsWith('h:')){chunks.push(id);continue;}if(id.startsWith('_')){reserved.push(id);continue;}
      const doc=await local.localDatabase.get(id,{conflicts:true});
      if(!['plain','newnote'].includes(doc.type)||!safeRelative(doc.path)||!Array.isArray(doc.children))throw fail('shared2-invalid-file-metadata');
      files.push({path:doc.path,size:doc.size,revision:doc._rev,deleted:doc.deleted===true,children:[...doc.children],inline:Object.keys(doc.eden||{}),conflicts:[...(doc._conflicts||[])]});
     }
     start=page.rows.at(-1).id;
    }
    checked('shared2-inspection');if((await local.localDatabase.info()).update_seq!==sequence)throw fail('shared2-inspection-changed');
    return {sequence,files,chunks,reserved};
   },
   async *stream(name){
    checked(name);const meta=await local.getDBEntryMeta(name);
    if(!meta||meta.deleted||meta._deleted||!Array.isArray(meta.children))throw fail('shared2-stream-file-missing');
    const eden=Object.fromEntries(Object.entries(meta.eden||{}).map(([id,value])=>[id,{_id:id,data:value.data,type:'leaf'}]));let size=0,index=0,legacy=false,carry='',cachedChars=0;const cache=new Map();
    for(const id of meta.children){
     checked(name);let chunks=cache.has(id)?[cache.get(id)]:await local.managers.chunkManager.read([id],{skipCache:true,waitForDelivery:false,preventRemoteRequest:true},eden);
     if(chunks.length!==1||!chunks[0]||typeof chunks[0].data!=='string')throw fail('shared2-stream-chunk-missing');
     if(!cache.has(id)){while(cache.size&&(cache.size>=8||cachedChars+chunks[0].data.length>2*1024*1024)){const first=cache.keys().next().value;cachedChars-=cache.get(first).data.length;cache.delete(first);}cache.set(id,chunks[0]);cachedChars+=chunks[0].data.length;}
     const content=chunks[0].data;let bytes;
     if(meta.type==='newnote'){if(index===0)legacy=content.startsWith('%');bytes=new Uint8Array(decodeBinary(legacy&&index>0?'%'+content:content));}
     else if(meta.type==='plain'){let text=carry+content;carry='';if(text.length&&text.charCodeAt(text.length-1)>=0xd800&&text.charCodeAt(text.length-1)<=0xdbff){carry=text.slice(-1);text=text.slice(0,-1);}bytes=new TextEncoder().encode(text);}
     else throw fail('shared2-stream-type-unsupported');
     index++;size+=bytes.byteLength;if(size>meta.size)throw fail('shared2-stream-size-mismatch');yield bytes;
    }
    if(carry){const bytes=new TextEncoder().encode(carry);size+=bytes.byteLength;yield bytes;}
    checked(name);if(size!==meta.size||(await local.getDBEntryMeta(name))?._rev!==meta._rev)throw fail('shared2-stream-file-changed');
   },
   async remove(name,{baseRevision}={}){
    checked(name);if(profile.kind==='shared'&&profile.role==='viewer')throw fail('shared2-read-only');
    if(typeof baseRevision!=='string'||!/^\d+-[A-Za-z0-9]+$/.test(baseRevision))throw fail('shared2-delete-base-required');
    const result=await local.managers.entryManager.storeDeletionAtRevision(name,baseRevision);
    if(result===false)throw fail('shared2-delete-base-missing');return result;
   },
   async readRevision(name,revision){
    checked(name);if(typeof revision!=='string'||!/^\d+-[A-Za-z0-9]+$/.test(revision))throw fail('invalid-shared2-base-revision');
    const meta=await local.getDBEntryMeta(name,{rev:revision},true);
    if(!meta)return null;if(meta.deleted||meta._deleted)return {deleted:true,revision:meta._rev};
    const doc=await local.getDBEntry(name,{rev:revision},false,false,true,true);
    if(!doc)throw fail('shared2-revision-content-missing');
    return {bytes:await readAsBlob(doc).arrayBuffer(),revision:doc._rev,ctime:doc.ctime,mtime:doc.mtime};
   },
   async read(name){
    checked(name);
    const doc=await local.getDBEntry(name,undefined,false,false,false,true);
    if(!doc)return null;
    return {bytes:await readAsBlob(doc).arrayBuffer(),revision:doc._rev,ctime:doc.ctime,mtime:doc.mtime};
   },
   async write(name,value){
    checked(name);if(profile.kind==='shared'&&profile.role==='viewer')throw fail('shared2-read-only');
    const binary=value&&(value.bytes instanceof ArrayBuffer||ArrayBuffer.isView(value.bytes)),blob=value?.blob instanceof Blob;
    if(!value||binary===blob)throw fail('invalid-shared2-file-bytes');
    const markdown=name.toLowerCase().endsWith('.md'),type=markdown?'text/plain':'application/octet-stream';
    const bytes=binary?(value.bytes instanceof ArrayBuffer?value.bytes:value.bytes.buffer.slice(value.bytes.byteOffset,value.bytes.byteOffset+value.bytes.byteLength)):null;
    const data=blob?value.blob.slice(0,value.blob.size,type):new Blob([bytes],{type});
    if(markdown){const decoder=new TextDecoder('utf-8',{fatal:true}),reader=data.stream().getReader();try{for(;;){const part=await reader.read();if(part.done)break;decoder.decode(part.value,{stream:true});}decoder.decode();}finally{reader.releaseLock();}}
    if(value.independent!==undefined&&value.independent!==true||value.independent&&value.baseRevision!==undefined)throw fail('invalid-shared2-write-ancestry');
    if(value.baseRevision!==undefined&&(typeof value.baseRevision!=='string'||!/^\d+-[A-Za-z0-9]+$/.test(value.baseRevision)))throw fail('invalid-shared2-base-revision');
    const now=Date.now();
    const note={_id:await path.path2id(name),path:name,data,ctime:Number.isFinite(value.ctime)?value.ctime:now,mtime:Number.isFinite(value.mtime)?value.mtime:now,size:data.size,children:[],eden:{},type:'newnote',datatype:'newnote'};
    const result=value.independent?await local.managers.entryManager.putDBEntryAsIndependentRoot(note):value.baseRevision!==undefined?await local.putDBEntryWithLiveBaseRevision(note,value.baseRevision):await local.putDBEntry(note);
    if(result===false)throw fail('shared2-engine-write-rejected');
    return result;
   },
   async close(){
    if(closed)return;if(closing)return closing;retiring=true;
    closing=(async()=>{if(transfer)await transfer.close();await local.close();})().then(()=>{closed=true;},error=>{closing=undefined;throw error;});
    return closing;
   },
  };
 };
}
