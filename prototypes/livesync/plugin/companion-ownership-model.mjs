import {safeCompanionPath,sha256} from './companion-proof.mjs';

const failure=code=>Object.assign(Error(code),{code});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const revision=value=>typeof value==='string'&&/^[1-9][0-9]*-[a-zA-Z0-9]+$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const documentId=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!value.startsWith('_')&&!/[\x00-\x1f\x7f]/.test(value);
const same=(left,right)=>canonicalOwnership(left)===canonicalOwnership(right);
const bodyKeys=new Set(['_revisions','_revs_info','_conflicts','_deleted_conflicts','e_']);
const onlyKeys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
export const OWNERSHIP_FORMAT_FIELDS=['encrypt','E2EEAlgorithm','useDynamicIterationCount','encryptInternalMetadata','usePathObfuscation','idDerivationVersion',
 'handleFilenameCaseSensitive','hashAlg','minimumChunkSize','longLineThreshold','customChunkSize','enableCompression','readChunksOnline','chunkSplitterVersion',
 'enableChunkSplitterV2','useSegmenter','maxChunksInEden','maxTotalLengthInEden','maxAgeInEden','useEden','usePluginSyncV2','useIgnoreFiles','useCustomRequestHandler',
 'batch_size','batches_limit','useTimeouts','hashCacheMaxCount','hashCacheMaxAmount','concurrencyOfReadChunksOnline','minimumIntervalOfReadChunksOnline','ignoreFiles',
 'syncMaxSizeInMB','tweakModified','idDerivationKeyFingerprint'];

/** Stable UTF-16 key ordering and ASCII JSON shared with the private Android runtime. */
export function canonicalOwnership(value) {
 const visit=item=>{
  if(item===null||typeof item==='string'||typeof item==='boolean')return item;
  if(typeof item==='number'&&Number.isSafeInteger(item))return item;
  if(Array.isArray(item))return item.map(visit);
  if(item&&typeof item==='object'&&(Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null))
   return Object.fromEntries(Object.keys(item).sort().map(key=>[key,visit(item[key])]));
  throw failure('invalid-ownership-value');
 };
 return JSON.stringify(visit(value)).replace(/[^\x20-\x7e]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
}
export async function ownershipDigest(value){return sha256(new TextEncoder().encode(canonicalOwnership(value)));}
/** Strip only transient top-level revision reports/encryption flags; retain every plaintext body field. */
export function ownershipDocumentBody(doc) {
 if(!doc||!documentId(doc._id)||!revision(doc._rev))throw failure('invalid-ownership-document');
 return Object.fromEntries(Object.entries(doc).filter(([key])=>!bodyKeys.has(key)));
}
export async function ownershipBodyHash(doc){return ownershipDigest(ownershipDocumentBody(doc));}

export function validOwnershipIdentity(value) {
 return !!value&&value.schema===1&&uuid(value.nonce)&&uuid(value.generation)&&uuid(value.accountId)
  &&uuid(value.companionDeviceId)&&typeof value.workspaceId==='string'&&/^[a-f0-9]{32}$/.test(value.workspaceId);
}
export function ownershipIdentity(value) {
 if(!validOwnershipIdentity(value))throw failure('invalid-ownership-identity');
 return Object.fromEntries(['schema','nonce','generation','accountId','workspaceId','companionDeviceId'].map(key=>[key,value[key]]));
}
export function sameOwnershipIdentity(left,right){return validOwnershipIdentity(left)&&validOwnershipIdentity(right)&&same(ownershipIdentity(left),ownershipIdentity(right));}
function ancestry(doc) {
 const value=doc._revisions;
 if(!value||!Number.isSafeInteger(value.start)||value.start<1||!Array.isArray(value.ids)||!value.ids.length||value.ids.length>value.start
  ||value.ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9]+$/.test(id))||doc._rev!==value.start+'-'+value.ids[0])throw failure('missing-revision-ancestry');
 return {start:value.start,ids:[...value.ids]};
}
function assertLeaf(leaf) {
 if(!leaf||!revision(leaf.rev)||typeof leaf.deleted!=='boolean'||typeof leaf.pouchDeleted!=='boolean'||!digest(leaf.bodyHash)
  ||!Array.isArray(leaf.chunks)||leaf.chunks.length>4096)throw failure('invalid-ownership-leaf');
 ancestry({_rev:leaf.rev,_revisions:leaf.ancestry});
 for(const chunk of leaf.chunks)if(!chunk||!documentId(chunk.id)||!chunk.id.startsWith('h:')||!revision(chunk.rev)||!digest(chunk.bodyHash))throw failure('invalid-ownership-chunk');
}
export function assertOwnershipManifest(value) {
 if(!validOwnershipIdentity(value)||!onlyKeys(value,['schema','nonce','generation','accountId','workspaceId','companionDeviceId','phase','mode','peerId','peerName','publicKeyFingerprint','source','scope','engineFormat','records','bases','createdAt'])
  ||value.phase!=='held'||!onlyKeys(value.source,['sequence'])||!Object.hasOwn(value.source,'sequence')
  ||!onlyKeys(value.scope,['ordinary','excludedPrefixes','localIgnoreRegEx','localOnlyRegEx','caseSensitive','policyRevision','protectedRevision','ignoreFileBases'])
  ||value.scope.ordinary!==true||!Array.isArray(value.scope.excludedPrefixes)||value.scope.excludedPrefixes.some(path=>!safeCompanionPath(path))
  ||!Array.isArray(value.records)||value.records.length>100000||!Array.isArray(value.bases)||value.bases.length>100000)throw failure('invalid-ownership-manifest');
 for(const key of ['localIgnoreRegEx','localOnlyRegEx'])if(value.scope[key]!==undefined&&(typeof value.scope[key]!=='string'||value.scope[key].length>20000))throw failure('invalid-ownership-scope');
 if(value.scope.caseSensitive!==undefined&&typeof value.scope.caseSensitive!=='boolean'
  ||value.scope.policyRevision!==undefined&&(!Number.isSafeInteger(value.scope.policyRevision)||value.scope.policyRevision<0)
  ||value.scope.protectedRevision!==undefined&&(typeof value.scope.protectedRevision!=='string'||value.scope.protectedRevision.length>512))throw failure('invalid-ownership-scope');
 if(value.scope.ignoreFileBases!==undefined&&(!Array.isArray(value.scope.ignoreFileBases)||value.scope.ignoreFileBases.length>100000
  ||value.scope.ignoreFileBases.some(item=>!onlyKeys(item,['path','sha256'])||typeof item.path!=='string'||!item.path||item.path.length>4096
   ||item.path.startsWith('/')||/[\\\x00-\x1f\x7f:]/.test(item.path)||item.path.split('/').some(part=>!part||part==='.'||part==='..'||part==='.obsidian')
   ||item.sha256!==null&&!digest(item.sha256))))throw failure('invalid-ownership-ignore-files');
 if(value.peerName!==undefined&&(typeof value.peerName!=='string'||value.peerName.length>512))throw failure('invalid-ownership-peer');
 if(value.publicKeyFingerprint!==undefined&&!digest(value.publicKeyFingerprint))throw failure('invalid-ownership-public-key');
 if(value.engineFormat!==undefined&&(!onlyKeys(value.engineFormat,OWNERSHIP_FORMAT_FIELDS)||value.engineFormat.readChunksOnline!==false
  ||value.engineFormat.idDerivationVersion===1&&!digest(value.engineFormat.idDerivationKeyFingerprint)
  ||Object.values(value.engineFormat).some(item=>!['boolean','string','number'].includes(typeof item))))throw failure('invalid-ownership-engine-format');
 const ids=new Set(),paths=new Set();
 for(const record of value.records){
  if(!onlyKeys(record,['id','path','leaves'])||!documentId(record.id)||ids.has(record.id)||record.path!==null&&!safeCompanionPath(record.path)
   ||!Array.isArray(record.leaves)||!record.leaves.length||record.leaves.length>1000)throw failure('invalid-ownership-record');
  ids.add(record.id);const revisions=new Set();
  for(const leaf of record.leaves){
   if(!onlyKeys(leaf,['rev','deleted','pouchDeleted','ancestry','bodyHash','chunks'])||!onlyKeys(leaf.ancestry,['start','ids'])
    ||leaf.chunks?.some(chunk=>!onlyKeys(chunk,['id','rev','bodyHash'])))throw failure('invalid-ownership-leaf');
   assertLeaf(leaf);if(revisions.has(leaf.rev)||record.path===null&&!leaf.pouchDeleted)throw failure('invalid-ownership-record');revisions.add(leaf.rev);
  }
 }
 for(const base of value.bases){
  if(!onlyKeys(base,['path','rev','sha256','size','mtime','deleted'])||!safeCompanionPath(base.path)||paths.has(base.path)||base.rev!==null&&!revision(base.rev)||typeof base.deleted!=='boolean'
   ||base.sha256!==null&&!digest(base.sha256)||!Number.isSafeInteger(base.size)||base.size<0||!Number.isSafeInteger(base.mtime)||base.mtime<0
   ||base.deleted&&(base.sha256!==null||base.size!==0)||!base.deleted&&base.sha256===null)throw failure('invalid-ownership-base');
  paths.add(base.path);
 }
 canonicalOwnership(value);return value;
}
export async function ownershipReadyMatches(manifest,reply) {
 return sameOwnershipIdentity(manifest,reply)&&reply.phase==='ready'&&reply.manifestDigest===await ownershipDigest(assertOwnershipManifest(manifest));
}

const controls=new Set(['syncinfo','versioninfo','milestoneinfo','nodeinfo']);
const fileTypes=new Set(['plain','newnote','notes']);
/**
 * One bounded, read-only proof page. No counters or revision-existence claims substitute for bodies.
 * Historical ancestor bodies stay in the quarantined source; every available leaf carries its ancestry.
 * @param {{source:any,remote:any,sequence:any,since?:any,limit?:number,isOrdinary?:(path:string)=>boolean|Promise<boolean>,getPath?:(doc:any)=>string|null,isCurrent?:()=>boolean|Promise<boolean>}} options
 */
export async function proveOwnershipPage({source,remote,sequence,since=0,limit=32,isOrdinary=()=>true,getPath=doc=>doc.path||null,isCurrent=()=>true}) {
 if(!Number.isInteger(limit)||limit<1||limit>128)throw failure('invalid-ownership-page');
 const check=async()=>{if(!await isCurrent()||!same((await source.info()).update_seq,sequence))throw failure('ownership-source-changed');};
 await check();
 const page=await source.changes({since,limit,style:'all_docs',return_docs:true}),records=[];
 for(const change of page.results){
  await check();
  if(change.id.startsWith('_')||change.id.startsWith('h:')||change.id.startsWith('i:')||controls.has(change.id))continue;
  const leaves=[];let recordPath=null,omitted=false;
  for(const item of change.changes){
   const doc=await source.get(change.id,{rev:item.rev,revs:true});
   if(doc._rev!==item.rev||doc._id!==change.id)throw failure('ownership-revision-mismatch');
   const path=getPath(doc);
   if(path!==null&&!safeCompanionPath(path))throw failure('ownership-path-unreadable');
   if(!doc._deleted&&!fileTypes.has(doc.type)){
    if('path' in doc||'children' in doc)throw failure('ownership-format-unsupported');
    omitted=true;continue;
   }
   if(path!==null&&!await isOrdinary(path)){omitted=true;continue;}
   if(recordPath!==null&&path!==null&&recordPath!==path)throw failure('ownership-path-conflict');
   if(path!==null)recordPath=path;
   const actual=await remote.get(change.id,{rev:item.rev,revs:true}),tree=ancestry(doc);
   const bodyHash=await ownershipBodyHash(doc);
   if(!same(tree,ancestry(actual))||bodyHash!==await ownershipBodyHash(actual))throw failure('ownership-remote-body-mismatch');
   const chunks=[];
   if(!doc._deleted&&doc.type!=='notes'){
    if(!Array.isArray(doc.children)||doc.children.length>4096)throw failure('ownership-chunks-unreadable');
    for(const id of [...new Set(doc.children)]){
     if(typeof id!=='string'||!id.startsWith('h:')||!documentId(id))throw failure('ownership-chunks-unreadable');
     if(Object.hasOwn(doc.eden||{},id))continue; // Eden plaintext is already bound by the complete metadata hash.
     const chunk=await source.get(id,{conflicts:true,revs:true});
     if(chunk.type!=='leaf'||typeof chunk.data!=='string'||chunk._deleted||chunk.isCorrupted||chunk._conflicts?.length)throw failure('ownership-chunks-unreadable');
     const chunkHash=await ownershipBodyHash(chunk),remoteChunk=await remote.get(id,{rev:chunk._rev,revs:true});
     if(chunkHash!==await ownershipBodyHash(remoteChunk))throw failure('ownership-remote-chunk-mismatch');
     chunks.push({id,rev:chunk._rev,bodyHash:chunkHash});
    }
   }
   leaves.push({rev:item.rev,pouchDeleted:doc._deleted===true,deleted:doc.deleted===true,ancestry:tree,bodyHash,chunks:chunks.sort((a,b)=>a.id.localeCompare(b.id))});
  }
  if(omitted&&leaves.length)throw failure('ownership-mixed-scope-revisions');
  if(leaves.length)records.push({id:change.id,path:recordPath,leaves:leaves.sort((a,b)=>a.rev.localeCompare(b.rev))});
 }
 await check();
 if(page.results.length&&same(page.last_seq,since))throw failure('ownership-non-advancing-page');
 return {records,since:page.last_seq,done:page.results.length===0};
}
