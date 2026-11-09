const fail=code=>Object.assign(Error(code),{code});
/** One durable queue/provenance owner per cache identity. Every writer shares
 * this transaction chain; incoming snapshots cannot overwrite local events.
 */
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
 function change(fn){const task=tail.then(async()=>{await load();const next=structuredClone(state),result=fn(next);await store.save(next);state=next;return result;});tail=task.catch(()=>{});return task;}
 const map=(field)=>({get:key=>read(s=>Object.hasOwn(s[field],key)?s[field][key]:undefined),set:(key,value)=>change(s=>{Object.defineProperty(s[field],key,{value:structuredClone(value),enumerable:true,writable:true,configurable:true});}),delete:key=>change(s=>{delete s[field][key];})});
 return {
  provenance:{...map('provenance'),snapshot:()=>read(s=>s.provenance),verify:(path,revision,stat,establishProvenance=false)=>change(s=>{
   const record=Object.hasOwn(s.provenance,path)&&s.provenance[path];
   if(record?.revision===revision)record.verifiedStat=structuredClone(stat);
   else if(!record&&establishProvenance)Object.defineProperty(s.provenance,path,{
    value:{revision,observedStorageMtime:stat.mtime,verifiedStat:structuredClone(stat)},enumerable:true,writable:true,configurable:true,
   });
  })},kv:map('values'),prepared:()=>read(s=>s.prepared===true),markPrepared:()=>change(s=>{s.prepared=true;}),
  pending:()=>read(s=>s.events),
  append:item=>change(s=>{const id=crypto.randomUUID();s.events.push({id,item:structuredClone(item)});return id;}),
  ack:id=>change(s=>{s.events=s.events.filter(event=>event.id!==id);}),
  drain:()=>tail,
 };
}
