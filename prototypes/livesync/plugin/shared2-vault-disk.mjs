import {safeRelative} from './folder-model.mjs';
import {hashShared2Stream} from './shared2-stream-hash.mjs';
const fail=code=>Object.assign(Error(code),{code});
/** DataAdapter operations are bounded writes to private staging. readBlob/readStream
 * are native file/resource adapters; no readBinary of an entire video is used.
 * beforeCommit must quiesce this mount's event handlers while the rename commits.
 */
export function createShared2VaultDisk({adapter,mount,privateRoot,listFiles,readStream,readBlob,beforeCommit}){
 if(!safeRelative(mount)||typeof privateRoot!=='string'||!privateRoot.startsWith('ArcaLink Shared/')||!safeRelative(privateRoot)||privateRoot===mount||privateRoot.startsWith(mount+'/')||typeof listFiles!=='function'||typeof readStream!=='function'||typeof readBlob!=='function'||typeof beforeCommit!=='function')throw fail('shared2-disk-adapters-required');
 for(const method of ['exists','mkdir','appendBinary','writeBinary','rename','copy','remove','list','readBinary','stat'])if(typeof adapter[method]!=='function')throw fail('shared2-streaming-adapter-required');
 const path=relative=>{if(!safeRelative(relative))throw fail('shared2-invalid-local-path');return mount+'/'+relative;};
 async function mkdirs(directory){let current='';for(const part of directory.split('/')){current+=(current?'/':'')+part;if(!await adapter.exists(current)){try{await adapter.mkdir(current);}catch(error){if(!await adapter.exists(current))throw error;}}}}
 async function fingerprint(relative){const full=path(relative);if(!await adapter.exists(full))return null;return (await hashShared2Stream(await readStream(full))).sha256;}
 async function stableCopy(relative,hash,tag){
  if(await fingerprint(relative)!==hash)throw fail('shared2-local-file-changed');
  await mkdirs(privateRoot+'/backups');const destination=privateRoot+'/backups/'+hash;
  if(!await adapter.exists(destination))await adapter.copy(path(relative),destination);
  const proof=await hashShared2Stream(await readStream(destination));
  if(proof.sha256!==hash)throw fail('shared2-backup-proof-mismatch');
  if(await fingerprint(relative)!==hash)throw fail('shared2-local-file-changed');
  return destination;
 }
 async function conditional(relative,expected,fn){
  return beforeCommit(relative,async()=>{if(await fingerprint(relative)!==expected)throw fail('shared2-local-file-changed');return fn();});
 }
 async function writeJournal(file,value){await adapter.writeBinary(file,new TextEncoder().encode(JSON.stringify(value)).buffer);}
 async function recover(){
  if(!await adapter.exists(privateRoot+'/commits'))return;
  const listing=await adapter.list(privateRoot+'/commits');
  for(const file of listing.files){
   if(!file.startsWith(privateRoot+'/commits/')||!(/^[a-f0-9-]{36}\.json$/).test(file.split('/').at(-1)))throw fail('shared2-invalid-disk-journal');
   const stat=await adapter.stat(file);if(!stat||!Number.isSafeInteger(stat.size)||stat.size<0||stat.size>8192)throw fail('shared2-invalid-disk-journal');
   const j=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await adapter.readBinary(file)));
   if(j.protocol!==2||j.mount!==mount||!safeRelative(j.relative)||j.temporary!==privateRoot+'/staging/'+j.id||j.previous!==j.temporary+'.old'||file!==privateRoot+'/commits/'+j.id+'.json'||!(/^[a-f0-9-]{36}$/).test(j.id)||!(/^[a-f0-9]{64}$/).test(j.sha256)||j.expectedHash!==null&&!(/^[a-f0-9]{64}$/).test(j.expectedHash))throw fail('shared2-invalid-disk-journal');
   await conditional(j.relative,await fingerprint(j.relative),async()=>{
    const current=await fingerprint(j.relative),oldExists=await adapter.exists(j.previous);
    if(oldExists&&(await hashShared2Stream(await readStream(j.previous))).sha256!==j.expectedHash)throw fail('shared2-disk-recovery-conflict');
    if(current===j.sha256){if(oldExists)await adapter.remove(j.previous);}
    else if(current===null&&oldExists)await adapter.rename(j.previous,path(j.relative));
    else if(!(current===j.expectedHash&&!oldExists))throw fail('shared2-disk-recovery-conflict');
    if(await adapter.exists(j.temporary))await adapter.remove(j.temporary);
    await adapter.remove(file);
   });
  }
 }
 return {
  recover,
  async list(){const files=await listFiles(mount);return files.map(file=>{if(typeof file!=='string'||!file.startsWith(mount+'/'))throw fail('shared2-disk-scan-escaped');const relative=file.slice(mount.length+1);path(relative);return relative;});},
  fingerprint,
  async blob(relative){return readBlob(path(relative));},
  async backup(relative,expected){return stableCopy(relative,expected,'local');},
  async replace(relative,stream,{expectedHash,sha256,size}){
   if(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)||!Number.isSafeInteger(size)||size<0)throw fail('shared2-invalid-projection-proof');
   path(relative);await mkdirs(privateRoot+'/staging');const temporary=privateRoot+'/staging/'+crypto.randomUUID();
   await adapter.writeBinary(temporary,new ArrayBuffer(0));
   try{
    const observed=await hashShared2Stream((async function*(){for await(const part of stream){if(!(part instanceof Uint8Array))throw fail('shared2-invalid-byte-stream');for(let offset=0;offset<part.byteLength;offset+=256*1024){const slice=part.slice(offset,offset+256*1024);await adapter.appendBinary(temporary,slice.buffer);yield slice;}}})());
    if(observed.sha256!==sha256||observed.size!==size)throw fail('shared2-projection-proof-mismatch');
    await conditional(relative,expectedHash,async()=>{
     await mkdirs(path(relative).split('/').slice(0,-1).join('/'));await mkdirs(privateRoot+'/commits');
     const id=temporary.split('/').at(-1),previous=temporary+'.old',journal=privateRoot+'/commits/'+id+'.json';
     await writeJournal(journal,{protocol:2,id,mount,relative,temporary,previous,expectedHash,sha256});
     if(await fingerprint(relative)!==expectedHash)throw fail('shared2-local-file-changed');
     if(expectedHash){
      await adapter.rename(path(relative),previous);
      if((await hashShared2Stream(await readStream(previous))).sha256!==expectedHash){await adapter.rename(previous,path(relative));throw fail('shared2-local-file-changed');}
     }
     try{await adapter.rename(temporary,path(relative));}
     catch(error){if(expectedHash&&!await adapter.exists(path(relative)))await adapter.rename(previous,path(relative));throw error;}
     if(await fingerprint(relative)!==sha256)throw fail('shared2-projection-proof-mismatch');
     if(expectedHash)await adapter.remove(previous);await adapter.remove(journal);
    });
   }finally{const journal=privateRoot+'/commits/'+temporary.split('/').at(-1)+'.json';if(!await adapter.exists(journal)&&await adapter.exists(temporary))await adapter.remove(temporary).catch(()=>{});}
  },
  async remove(relative,{expectedHash}){await conditional(relative,expectedHash,async()=>{if(expectedHash){await stableCopy(relative,expectedHash,'deleted');if(await fingerprint(relative)!==expectedHash)throw fail('shared2-local-file-changed');await adapter.remove(path(relative));}});},
 };
}
