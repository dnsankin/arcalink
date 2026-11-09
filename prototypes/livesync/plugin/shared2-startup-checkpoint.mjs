import {safeRelative} from './folder-model.mjs';

// A startup shortcut only. Old provenance identifies ancestry, not the
// bytes on disk. Create a checkpoint only after comparing those bytes with
// the exact live revision while the physical file attributes stay stable.
function fileStat(stat){
 if(stat?.type!=='file'||!Number.isSafeInteger(stat.size)||stat.size<0||
  !Number.isFinite(stat.mtime)||stat.mtime<=0||!Number.isFinite(stat.ctime)||stat.ctime<=0)return null;
 return {size:stat.size,mtime:stat.mtime,ctime:stat.ctime};
}
const same=(a,b)=>!!a&&!!b&&a.size===b.size&&a.mtime===b.mtime&&a.ctime===b.ctime;

export function createShared2StartupCheckpoint({documentRoot,provenance,stat,fingerprint,metadata,revisionProof}){
 const live=doc=>typeof doc?._rev==='string'&&safeRelative(doc.path)&&doc.path.startsWith(documentRoot+'/')&&
  !doc.deleted&&!doc._deleted&&!doc._conflicts?.length;
 async function isVerified(doc){
  if(!live(doc))return false;
  try{
   const record=await provenance.get(doc.path);
   return record?.revision===doc._rev&&!!record.verifiedStat&&same(record.verifiedStat,fileStat(await stat(doc.path)));
  }catch{return false;}
 }
 async function remember(doc,establishProvenance=false){
  if(!live(doc))return;
  try{
   const {path,_rev:revision}=doc,current=await metadata(path);
   if(!live(current)||current._rev!==revision||await isVerified(current))return;
   const previous=await provenance.get(path);
   if(previous?previous.revision!==revision:!establishProvenance)return;
   const before=fileStat(await stat(path));
   if(!before||before.size!==current.size)return;
   const remote=await revisionProof(path,revision);
   const local=await fingerprint(path);
   if(remote.size!==before.size||remote.sha256!==local||!same(before,fileStat(await stat(path))))return;
   if(!previous){
    const latest=await metadata(path);
    if(!live(latest)||latest._rev!==revision)return;
   }
   await provenance.verify(path,revision,before,establishProvenance);
  }catch{
   // An optional checkpoint must never block reflection or replace a retry.
  }
 }
 return {isVerified,remember};
}
