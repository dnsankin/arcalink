import {eventTouches} from './shared2-runtime-store.mjs';

// The store owns ordering. The last guard executes inside its writer, so it
// must use only the disk, remote and lease, never another read of the store.
/** @returns {Promise<{path: string, eventIds: string[]} | undefined>} */
export async function reconcileInitialEvents({runtime,engine,checkpoint,stat,exists,checked},onlyPath){
 const pending=await runtime.pending();
 const paths=onlyPath?[onlyPath]:[...new Set(pending.map(event=>event.item.args.file.path))];
 let first;
 for(const path of paths){
  const group=pending.filter(event=>eventTouches(event,path));
  if(!group.length)continue;
  const eventIds=group.map(event=>event.id);
  const block=()=>{first??={path,eventIds};};
  const simple=group.every(({item,needsDeleteCheck})=>!needsDeleteCheck&&item.args.file.path===path&&item.args.oldPath===undefined&&item.args.renameTarget===undefined);
  const sequence=group.map(event=>event.item.type).join(',');
  const doc=await engine.metadata(path);
  if(doc?._conflicts?.length)throw Object.assign(Error('shared2-initial-proof-conflict'),{code:'shared2-initial-proof-conflict',document:doc});
  if(!simple||!['CREATE','DELETE,CREATE'].includes(sequence)){block();continue;}
  if(!doc||doc.path!==path||doc._deleted||doc.deleted&&sequence!=='CREATE'){block();continue;}
  const createdAt=group.at(-1).item.args.file.stat?.mtime;
  const sameHead=async()=>{
   const head=await engine.remoteEventHead(path,createdAt);
   return head?.revision===doc._rev&&head.deleted===!!doc.deleted;
  };
  if(!await sameHead()){block();continue;}
  let expected;
  if(doc.deleted){
   if(await exists(path)){block();continue;}
  }else{
   await checkpoint.remember(doc,true,true);
   if(!await checkpoint.isVerified(doc)){block();continue;}
   const record=await runtime.provenance.get(path);
   if(record?.revision!==doc._rev){block();continue;}
   expected=record.verifiedStat;
  }
  const guarded=await runtime.ackSequence(path,eventIds,async()=>{
   if(!await sameHead()||!await checked())return false;
   if(doc.deleted)return !await exists(path);
   const now=await stat(path);
   return !!expected&&now?.type==='file'&&now.size===expected.size&&now.ctime===expected.ctime&&now.mtime===expected.mtime;
  });
  if(!guarded)block();
 }
 return first;
}
