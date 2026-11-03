import {backupPath} from './local-backup-store.mjs';
import {hashShared2Stream} from './shared2-stream-hash.mjs';
/** A durable rename journal protects the gap between moving the previous file
 * aside and publishing a fully verified streamed replacement. No partial target. */
export function createBackupRestorer({adapter,root,readStream,accept=backupPath}){
 const journal=root+'/restore.json';
 const digest=async path=>await adapter.exists(path)?(await hashShared2Stream(await readStream(path))).sha256:null;
 async function clean(j){for(const p of [j.stage,j.previous])if(await adapter.exists(p))await adapter.remove(p);await adapter.remove(journal);}
 async function recover(){
  if(!await adapter.exists(journal))return;
  const j=JSON.parse(await adapter.read(journal));
  if(j.protocol!==1||!backupPath(j.path)||!accept(j.path)||!/^\w[\w-]{1,100}$/.test(j.id)||j.stage!==root+'/restore-'+j.id||j.previous!==j.stage+'.old'||! /^[a-f0-9]{64}$/.test(j.sha256)||j.expected!==null&&! /^[a-f0-9]{64}$/.test(j.expected))throw Error('backup-restore-journal-invalid');
  const current=await digest(j.path),previous=await digest(j.previous);
  if(previous!==null&&previous!==j.expected)throw Error('backup-restore-previous-corrupt');
  if(current===j.sha256){await clean(j);return;}
  if(current===null&&previous!==null){await adapter.rename(j.previous,j.path);if(await digest(j.path)!==j.expected)throw Error('backup-restore-rollback-failed');await clean(j);return;}
  if(current===j.expected&&previous===null){await clean(j);return;}
  throw Error('backup-restore-recovery-conflict');
 }
 async function restore(v,stream,options={}){
  if(!backupPath(v.path)||!accept(v.path))throw Error('backup-restore-path-invalid');await recover();const expected=await digest(v.path);if('expectedHash'in options&&expected!==options.expectedHash)throw Error('backup-restore-target-changed');const id=crypto.randomUUID(),stage=root+'/restore-'+id,previous=stage+'.old';
  await adapter.writeBinary(stage,new ArrayBuffer(0));
  try{
   for await(const chunk of stream)await adapter.appendBinary(stage,chunk.buffer.slice(chunk.byteOffset,chunk.byteOffset+chunk.byteLength));
   const proof=await hashShared2Stream(await readStream(stage));if(proof.sha256!==v.sha256||proof.size!==v.size)throw Error('backup-restore-staging-corrupt');
   if(await digest(v.path)!==expected)throw Error('backup-restore-target-changed');
   const j={protocol:1,id,path:v.path,stage,previous,expected,sha256:v.sha256};const encoded=JSON.stringify(j);await adapter.write(journal,encoded);if(await adapter.read(journal)!==encoded)throw Error('backup-restore-journal-write-failed');
   if(expected!==null)await adapter.rename(v.path,previous);
   try{await adapter.rename(stage,v.path);}catch(error){await recover();throw error;}
   if(await digest(v.path)!==v.sha256)throw Error('backup-restore-readback-failed');
   await clean(j);
  }finally{if(!await adapter.exists(journal)&&await adapter.exists(stage))await adapter.remove(stage);}
 }
 return {recover,restore};
}
