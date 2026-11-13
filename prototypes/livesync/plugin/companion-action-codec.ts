import {DirectFileManipulator} from '@vrtmrz/livesync-commonlib';
import {readAsBlob} from '@vrtmrz/livesync-commonlib/compat/common/utils';
import {decodeBinary} from '@vrtmrz/livesync-commonlib/compat/string_and_binary/convert';
import {sha256} from '@noble/hashes/sha256';
import {configuredIdKey} from '@vrtmrz/livesync-commonlib/settings';
import {DEFAULT_SETTINGS, type DocumentID} from '@vrtmrz/livesync-commonlib/compat/common/types';
import {actionHash} from './companion-action-outbox.mjs';

const fail=(code:string)=>Object.assign(Error(code),{code});
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const response=(value:any,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
// Metadata comes from JSON over Pouch HTTP; preserve finite numbers and ignore object key order.
const metadataSnapshot=(value:any)=>JSON.stringify(value,(_key,item)=>{if(!item||typeof item!=='object'||Array.isArray(item))return item;const sorted:Record<string,any>=Object.create(null);for(const key of Object.keys(item).sort())sorted[key]=item[key];return sorted;});

/** Maintained LiveSync codec with a bounded transport: chunks may be uploaded;
 * metadata can only be captured as a proposal. It has no vault or replication API.
 * The caller supplies its own authenticated fetch and current scope admission.
 */
export class CompanionActionCodec {
 private file:DirectFileManipulator;
 private target='';private base:any=null;private candidate:any=null;private shadow:any=null;private writing=false;
 private origin:string;private prefix:string;private transportFailure:any=null;
 private maxBytes:number;
 constructor(settings:any,private fetcher:typeof fetch,private admit:(path:string)=>Promise<void>){
  settings={...DEFAULT_SETTINGS,...settings};
  this.maxBytes=Math.min(256*1024*1024,Number(settings.syncMaxSizeInMB)>0?Number(settings.syncMaxSizeInMB)*1024*1024:256*1024*1024);
  if(settings.encrypt&&!settings.passphrase)throw fail('action-encryption-key-required');
  const endpoint=new URL(settings.couchDB_URI.replace(/\/+$/,'')+'/'+settings.couchDB_DBNAME+'/');
  this.origin=endpoint.origin;this.prefix=endpoint.pathname;
  this.file=new DirectFileManipulator({url:settings.couchDB_URI.replace(/\/+$/,''),database:settings.couchDB_DBNAME,
   username:settings.couchDB_USER,password:settings.couchDB_PASSWORD,passphrase:settings.encrypt?settings.passphrase:undefined,
   obfuscatePassphrase:settings.usePathObfuscation?settings.passphrase:undefined,
   idDerivationVersion:settings.idDerivationVersion,idDerivationKey:configuredIdKey(settings)||undefined,
   encryptInternalMetadata:settings.encryptInternalMetadata,useDynamicIterationCount:settings.useDynamicIterationCount,
   customChunkSize:settings.customChunkSize,minimumChunkSize:settings.minimumChunkSize,hashAlg:settings.hashAlg,
   useEden:settings.useEden,maxChunksInEden:settings.maxChunksInEden,maxTotalLengthInEden:settings.maxTotalLengthInEden,
   maxAgeInEden:settings.maxAgeInEden,enableCompression:settings.enableCompression,
   handleFilenameCaseSensitive:settings.handleFilenameCaseSensitive,chunkSplitterVersion:settings.chunkSplitterVersion,E2EEAlgorithm:settings.E2EEAlgorithm},
   {fetch:async(input,options)=>{try{return await this.transport(input,options);}catch(error){this.transportFailure=error;throw error;}}});
 }
 private async transport(input:RequestInfo|URL,options?:RequestInit):Promise<Response>{
  const request=new Request(input,options),url=new URL(request.url),method=request.method;
  if(url.origin!==this.origin||!(url.pathname===this.prefix.slice(0,-1)||url.pathname.startsWith(this.prefix)))throw fail('action-origin-denied');
  const name=decodeURIComponent(url.pathname.slice(this.prefix.length));
  if(method==='GET'||method==='HEAD'){
   if(method==='GET'&&this.shadow&&name===this.shadow._id&&url.searchParams.get('rev')===this.shadow._rev)return response(this.shadow);
   return this.fetcher(request);
  }
  if(method==='POST'&&['_all_docs','_bulk_get','_revs_diff'].includes(name))return this.fetcher(request);
  if(!this.writing)throw fail('action-unexpected-write');
  const body=await request.clone().json(),bulk=method==='POST'&&name==='_bulk_docs';
  const docs=bulk?body.docs:method==='PUT'?[body]:null;
  if(!Array.isArray(docs)||!docs.length)throw fail('action-unexpected-write');
  if(docs.every(doc=>typeof doc._id==='string'&&doc._id.startsWith('h:')&&doc.type==='leaf'&&!doc._deleted)){
   await this.admit(this.target);return this.fetcher(request);
  }
  if(docs.length!==1||this.candidate)throw fail('action-unexpected-write');
  const document=copy(docs[0]),id=await this.file.path2id(this.target as any);
  if(document._id!==id||!['plain','newnote'].includes(document.type)||document._deleted||document.deleted)throw fail('action-unexpected-write');
  if(this.base){
   if(bulk||document._rev!==this.base._rev)throw fail('action-base-changed');
   const generation=Number(this.base._rev.split('-')[0])+1,revision=crypto.randomUUID().replace(/-/g,'');
   document._rev=generation+'-'+revision;
   document._revisions={start:generation,ids:[revision,...this.base._revisions.ids]};
  }else if(!bulk||body.new_edits!==false||document._revisions?.start!==1)throw fail('action-unexpected-write');
  this.candidate=document;this.shadow=document;
  return response(bulk?[]:{ok:true,id,rev:document._rev},201);
 }
 async open(){try{await this.file.ready.promise;}catch(error){throw this.transportFailure??error;}}
 private get raw(){return this.file.liveSyncLocalDB.localDatabase;}
 async current(path:string,deletedAsMissing=false,readLimit=this.maxBytes){
  const meta=await this.metadata(path,deletedAsMissing);return meta?{meta,bytes:await this.bytes(meta,readLimit)}:null;
 }
 async metadata(path:string,deletedAsMissing=false){
  await this.admit(path);const id=await this.file.path2id(path as any);
  let leaves:any[];
  try{leaves=await this.raw.get(id,{open_revs:'all',revs:true} as any) as any;}
  catch(error:any){if(error.status===404)return null;throw error;}
  if(!leaves.length)return null;
  if(leaves.length!==1||!leaves[0].ok)throw fail('action-base-conflict');
  const meta=leaves[0].ok;
  if(meta._deleted){if(deletedAsMissing&&(meta.path==null||meta.path===path))return null;throw fail('action-base-conflict');}
  if(meta.path!==path)throw fail('action-path-mismatch');
  if(meta.deleted){if(deletedAsMissing)return null;throw fail('action-base-conflict');}
  return meta;
 }
 /** Read-only, finite changes page for a private Exchange presentation cache.
  * The caller persists the page before advancing its opaque Couch cursor. */
 async exchangeChanges(since:string|number,folder:string){
  if(typeof folder!=='string'||!folder||folder.length>4096||/[\\:\x00-\x1f\x7f]/.test(folder)||folder.split('/').some(part=>!part||part==='.'||part==='..'))throw fail('action-exchange-folder-invalid');
  if(!(Number.isSafeInteger(since)&&Number(since)>=0||typeof since==='string'&&since.length<=512&&/^[\x21-\x7e]+$/.test(since)))throw fail('action-exchange-cursor-invalid');
  const page:any=await this.raw.changes({since,include_docs:true,conflicts:true,style:'all_docs',limit:32,return_docs:true});
  if(!Array.isArray(page.results)||page.results.length>32||typeof page.last_seq!=='string'&&typeof page.last_seq!=='number')throw fail('action-exchange-page-invalid');
  const entries:any[]=[];
  for(const row of page.results){
   if(typeof row.id!=='string'||row.id.length>4096)throw fail('action-exchange-page-invalid');
   let meta:any=row.doc;
   if(meta?._deleted){
    try{meta=await this.raw.get(row.id,{rev:meta._rev,revs:true,deleted_conflicts:true} as any);}catch(error:any){if(error.status!==404)throw error;}
   }else try{meta=await this.raw.get(row.id,{conflicts:true,deleted_conflicts:true} as any);}catch(error:any){if(error.status!==404)throw error;}
   const path=meta?.path;
   if(typeof path!=='string'||!path.startsWith(folder+'/')){
    if(meta?._deleted||row.deleted)entries.push({id:row.id,deleted:true});
    continue;
   }
   if(await this.file.path2id(path as any)!==row.id)throw fail('action-exchange-id-mismatch');
   try{await this.admit(path);}catch(error:any){if(error?.code!=='action-outside-scope'&&error?.message!=='scope')throw error;entries.push({id:row.id,excluded:true});continue;}
   if(meta.deleted||meta._deleted){entries.push({id:row.id,deleted:true});continue;}
   if(!['plain','newnote'].includes(meta.type)||!Number.isSafeInteger(meta.mtime)||meta.mtime<0||!Number.isSafeInteger(meta.size)||meta.size<0)throw fail('action-exchange-metadata-invalid');
   entries.push({id:row.id,path,revision:meta._rev,mtime:meta.mtime,size:meta.size,conflict:!!meta._conflicts?.length});
  }
  return {cursor:page.last_seq,entries,complete:page.results.length<32};
 }
 private async bytes(meta:any,limit=this.maxBytes){
  if(!Number.isSafeInteger(meta.size)||meta.size<0||meta.size>limit)throw fail('action-size-limit');
  const content=await this.file.liveSyncLocalDB.getDBEntryFromMeta(meta,false,false);
  if(!content)throw fail('action-content-unavailable');
  const value=new Uint8Array(await readAsBlob(content).arrayBuffer());
  if(value.length!==meta.size)throw fail('action-content-invalid');
  return value;
 }
 /** Stream one bounded decoded LiveSync chunk at a time, retaining the exact
  * single-leaf revision across the transfer. No vault or metadata write. */
 async streamExchange(path:string,revision:string,write:(bytes:Uint8Array,offset:number)=>Promise<void>){
  if(typeof write!=='function'||typeof revision!=='string')throw fail('action-exchange-invalid');
  const meta=await this.metadata(path);if(!meta||meta._rev!==revision)throw fail('action-exchange-stale');
  if(!Number.isSafeInteger(meta.size)||meta.size<0||meta.size>256*1024*1024||!['plain','newnote'].includes(meta.type)||!Array.isArray(meta.children)||meta.children.length>100000)throw fail('action-exchange-size-limit');
  if(meta.size>0&&!meta.children.length)throw fail('action-exchange-size-limit');
  const eden:Record<string,any>=Object.create(null);if(meta.eden&&typeof meta.eden==='object'&&!Array.isArray(meta.eden))for(const [id,value] of Object.entries(meta.eden) as [string,any][])eden[id]={_id:id,type:'leaf',data:value?.data};
  const hasher=sha256.create(),encoder=new TextEncoder(),snapshot=metadataSnapshot(meta),snapshots=new Map<string,{id:string,rev:string,hash:string}>();let offset=0,legacy=false,index=0,lastId='',lastDecoded:Uint8Array|null=null;
  const leaf=async(id:string)=>{const leaves:any[]=await this.raw.get(id,{open_revs:'all'} as any) as any;if(leaves.length!==1||!leaves[0].ok||leaves[0].ok._deleted||leaves[0].ok.type!=='leaf'||typeof leaves[0].ok.data!=='string')throw fail('action-content-unavailable');return leaves[0].ok;};
  for(const id of meta.children){
   if(typeof id!=='string'||!id.startsWith('h:'))throw fail('action-exchange-content-invalid');
   await this.admit(path);let decoded:Uint8Array;
   if(id===lastId&&lastDecoded&&!(legacy&&index===1&&meta.type!=='plain')){decoded=lastDecoded;}else{
    const before=eden[id]?null:await leaf(id);const chunks=await this.file.liveSyncLocalDB.managers.chunkManager.read([id as DocumentID],{skipCache:true,waitForDelivery:false,preventRemoteRequest:false},eden as any);
    if(chunks.length!==1||!chunks[0]||typeof chunks[0].data!=='string')throw fail('action-content-unavailable');
    const encoded=chunks[0].data;if(encoded.length>8*1024*1024)throw fail('action-exchange-size-limit');
    if(before){const after=await leaf(id);if(before._rev!==after._rev||before.data!==after.data||before.data!==encoded)throw fail('action-exchange-stale');const value={id,rev:before._rev,hash:await actionHash(encoded)},previous=snapshots.get(id);if(previous&&(previous.rev!==value.rev||previous.hash!==value.hash))throw fail('action-exchange-stale');snapshots.set(id,value);}
    if(index===0)legacy=encoded.startsWith('%');
    decoded=meta.type==='plain'?encoder.encode(encoded):new Uint8Array(decodeBinary(legacy&&index>0?'%'+encoded:encoded));lastId=id;lastDecoded=decoded;
   }index++;
   if(offset+decoded.length>meta.size)throw fail('action-content-invalid');
   for(let at=0;at<decoded.length;at+=65536){const frame=decoded.subarray(at,Math.min(at+65536,decoded.length));hasher.update(frame);await write(frame.slice(),offset);offset+=frame.length;}
  }
  if(offset!==meta.size)throw fail('action-content-invalid');await this.admit(path);
  for(const snapshot of snapshots.values()){await this.admit(path);const latest=await leaf(snapshot.id);if(latest._rev!==snapshot.rev||latest.data.length>8*1024*1024||await actionHash(latest.data)!==snapshot.hash)throw fail('action-exchange-stale');}
  const latest=await this.metadata(path);if(!latest||metadataSnapshot(latest)!==snapshot)throw fail('action-exchange-stale');await this.admit(path);
  return {size:offset,sha256:Array.from(hasher.digest(),v=>v.toString(16).padStart(2,'0')).join('')};
 }
 async prepare(path:string,payload:Uint8Array,baseHash:string|null,createdAt:number){
  if(payload.length>this.maxBytes)throw fail('action-size-limit');
  if(this.target)throw fail('action-codec-reused');
  const current=await this.current(path);
  if(baseHash===null?current!==null:!current||await actionHash(current.bytes)!==baseHash)throw fail('action-base-changed');
  this.target=path;this.base=current?.meta??null;
  const blob=new Blob([payload as BlobPart],{type:/\.(md|txt|json|canvas|csv|svg|css|js|html)$/i.test(path)?'text/plain':'application/octet-stream'});
  const note={_id:await this.file.path2id(path as any),path,data:blob,ctime:this.base?.ctime??createdAt,mtime:createdAt,size:blob.size,type:'plain',datatype:'plain',children:[]};
  this.writing=true;
  try{
   const result=this.base?await this.file.liveSyncLocalDB.putDBEntryWithLiveBaseRevision(note as any,this.base._rev):await this.file.liveSyncLocalDB.putDBEntryAsIndependentRoot(note as any);
   if(!result||!this.candidate)throw fail('action-proposal-unavailable');
   const plain:any=await this.raw.get(this.candidate._id,{rev:this.candidate._rev});
   if(plain.path!==path||await actionHash(await this.bytes(plain))!==await actionHash(payload))throw fail('action-proposal-invalid');
   return {document:copy(this.candidate),baseRevision:this.base?._rev??null,chunks:[...new Set<string>(plain.children.filter((id:string)=>!plain.eden?.[id]))]};
  }catch(error){throw this.transportFailure??error;}finally{this.writing=false;}
 }
 /** A fresh codec instance reads every chunk. No encoding-time cache is proof.
  * beforeCommit uses an opaque chosen proposal; afterCommit reads its exact
  * server revision, even if a subsequent ordinary edit already superseded it.
  */
 async verify(proposal:any,path:string,expectedHash:string,beforeCommit=false,expectedSize?:number,checkChunks?:(meta:any)=>Promise<void>){
  if(this.target)throw fail('action-codec-reused');
  await this.admit(path);const id=await this.file.path2id(path as any),doc=proposal?.document;
  if(!doc||doc._id!==id||typeof doc._rev!=='string')throw fail('action-proposal-invalid');
  if(beforeCommit)this.shadow=copy(doc);
  try{
   const actual:any=await this.raw.get(id,{rev:doc._rev});
   if(actual.path!==path||actual.deleted||actual._deleted||expectedSize!==undefined&&actual.size!==expectedSize)throw fail('action-result-mismatch');
   if(checkChunks)await checkChunks(actual);
   if(await actionHash(await this.bytes(actual))!==expectedHash)throw fail('action-result-mismatch');
   if(checkChunks)await checkChunks(actual);
  }finally{this.shadow=null;}
 }
 async close(){await this.file.close();}
}
