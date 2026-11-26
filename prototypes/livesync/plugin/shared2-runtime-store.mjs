const fail=code=>Object.assign(Error(code),{code});
/** One durable queue/provenance owner per cache identity. Every writer shares
 * this transaction chain; incoming snapshots cannot overwrite local events.
 */
const pathKey=value=>typeof value==='string'?value.normalize('NFC').toLowerCase():null;
export function eventTouches(event,path){
 const args=event.item?.args;
 return [args?.file?.path,args?.oldPath,args?.renameTarget].some(value=>pathKey(value)===pathKey(path));
}
export function createShared2RuntimeStore({store,profile,mount}){
 const scope=JSON.stringify([profile.account,profile.workspace,profile.folder,profile.database,profile.generation,profile.keyEpoch,profile.cacheEpoch,mount]);
 let state,tail=Promise.resolve();
 async function load(){
  if(state)return;
  const value=await store.load();
  if(value&&(value.protocol!==1||value.scope!==scope||!Array.isArray(value.events)||!value.provenance||!value.values))throw fail('shared2-runtime-store-scope-mismatch');
  state=value||{protocol:1,scope,prepared:false,events:[],provenance:{},values:{}};
 }
 function read(fn){const task=tail.then(async()=>{await load();return structuredClone(fn(state));});tail=task.catch(()=>{});return task;}
 function change(fn,needed=()=>true){const task=tail.then(async()=>{await load();if(!needed(state))return;const next=structuredClone(state),result=fn(next);await store.save(next);state=next;return result;});tail=task.catch(()=>{});return task;}
 const map=(field)=>({get:key=>read(s=>Object.hasOwn(s[field],key)?s[field][key]:undefined),set:(key,value)=>change(s=>{Object.defineProperty(s[field],key,{value:structuredClone(value),enumerable:true,writable:true,configurable:true});}),delete:key=>change(s=>{delete s[field][key];},s=>Object.hasOwn(s[field],key))});
 return {
  provenance:{...map('provenance'),snapshot:()=>read(s=>s.provenance),verify:(path,revision,stat,establishProvenance=false,previousRevision=undefined)=>change(s=>{
   const record=Object.hasOwn(s.provenance,path)&&s.provenance[path];
   if(record?.revision===revision)record.verifiedStat=structuredClone(stat);
   else if(establishProvenance&&(!record||previousRevision&&record.revision===previousRevision))Object.defineProperty(s.provenance,path,{
    value:{revision,observedStorageMtime:stat.mtime,verifiedStat:structuredClone(stat)},enumerable:true,writable:true,configurable:true,
   });
  })},kv:map('values'),prepared:()=>read(s=>s.prepared===true),markPrepared:()=>change(s=>{s.prepared=true;}),
  pending:()=>read(s=>s.events),
  finishInitialProof:saveEpoch=>{const task=tail.then(async()=>{
   await load();
   if(state.events.length)throw fail('shared2-initial-proof-changed');
   // Certify the empty queue in the alternate recovery slot before a separate
   // registry can open the upload gate. A fallback cannot resurrect a deletion.
   await store.save(state);
   await saveEpoch();
  });tail=task.catch(()=>{});return task;},
  hasPending:path=>read(s=>s.events.some(event=>eventTouches(event,path))),
  ackSequence:(path,ids,validate)=>{const task=tail.then(async()=>{
   await load();
   const sequence=state.events.filter(event=>eventTouches(event,path));
   if(sequence.length!==ids.length||sequence.some((event,i)=>event.id!==ids[i]||event.needsDeleteCheck)||!await validate())return false;
   const confirmed=new Set(ids),next={...state,events:state.events.filter(event=>!confirmed.has(event.id))};
   await store.save(next);state=next;return true;
  });tail=task.catch(()=>{});return task;},
  append:item=>change(s=>{const id=crypto.randomUUID();s.events.push({id,item:structuredClone(item)});return id;}),
  markDeleteCheck:id=>change(s=>{const event=s.events.find(row=>row.id===id);if(event?.item.type!=='DELETE')throw fail('shared2-delete-check-incomplete');event.needsDeleteCheck=true;}),
  deleteReviews:()=>read(s=>s.deleteReviews||[]),
  reviewDelete:id=>change(s=>{
   const event=s.events.find(row=>row.id===id);
   if(!event?.needsDeleteCheck)throw fail('shared2-delete-check-incomplete');
   const path=event.item.args.file.path;
   s.deleteReviews=(s.deleteReviews||[]).filter(row=>row.path!==path);
   s.deleteReviews.push({id,path});
   s.events=s.events.filter(row=>row.id!==id);
   return s.deleteReviews;
  }),
  dismissDeleteReview:id=>change(s=>s.deleteReviews=(s.deleteReviews||[]).filter(row=>row.id!==id)),
  ack:id=>change(s=>{s.events=s.events.filter(event=>event.id!==id);}),
  drain:()=>tail,
 };
}
