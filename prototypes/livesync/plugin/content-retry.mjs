// Metadata stays pending while its content is unavailable. The normal result
// processor still owns revision, deletion, conflict and vault-write decisions.
export function createContentRetryQueue({owner,canRun,enqueue,changed,now=Date.now,
 setTimer=setTimeout,clearTimer=clearTimeout}) {
 const pending=new Map(),failures=new Map(),latest=new Map();
 let timer,disposed=false;
 const delays=[5000,15000,30000,60000];
 const same=(a,b)=>a.doc._rev===b._rev;
 const currentOwner=()=>{try{return owner();}catch{return undefined;}};
 function prune() {
  if(!pending.size&&!failures.size&&!latest.size)return;
  const current=currentOwner();
  for(const [id,item] of pending)if(item.owner!==current){pending.delete(id);failures.delete(id);}
  for(const [id,item] of failures)if(item.owner!==current)failures.delete(id);
  for(const [id,item] of latest)if(item.owner!==current)latest.delete(id);
 }
 function schedule() {
  if(timer!==undefined)clearTimer(timer);
  timer=undefined;if(disposed)return;prune();
  if(disposed||!pending.size)return;
  const due=[...pending.values()].reduce((due,x)=>Math.min(due,x.due),Infinity);
  timer=setTimer(run,Math.max(1,canRun()?due-now():5000));
 }
 function run() {
  timer=undefined;if(disposed)return;prune();
  if(!currentOwner())return;
  if(canRun())for(const [id,item] of [...pending]) {
   if(item.due>now())continue;
   pending.delete(id);
   enqueue(item.doc);
  }
  changed();schedule();
 }
 return {
  defer(doc,sourceOwner) {
   if(disposed||!sourceOwner||sourceOwner!==currentOwner())return false;
   const current=latest.get(doc._id);
   if(current&&current.owner===sourceOwner&&!same(current,doc))return false;
   const old=failures.get(doc._id);
   const attempt=old&&old.owner===sourceOwner&&same(old,doc)?old.attempt+1:1;
   const item={doc,owner:sourceOwner,attempt,due:now()+delays[Math.min(attempt-1,delays.length-1)]};
   failures.set(doc._id,item);pending.set(doc._id,item);
   changed();schedule();return true;
  },
  // An ordinary incoming change or an emitted retry takes over this ID.
  supersede(doc) {
   pending.delete(doc._id);
   latest.set(doc._id,{doc,owner:currentOwner()});
   const old=failures.get(doc._id);
   if(old&&!same(old,doc))failures.delete(doc._id);
   schedule();
  },
  finish(doc) {
   const old=failures.get(doc._id);
   if(old&&same(old,doc)&&!pending.has(doc._id))failures.delete(doc._id);
   const current=latest.get(doc._id);
   if(current&&same(current,doc)&&!pending.has(doc._id))latest.delete(doc._id);
  },
  snapshot() {prune();return [...pending.values()].map(x=>x.doc);},
  dispose() {disposed=true;if(timer!==undefined)clearTimer(timer);timer=undefined;},
 };
}
