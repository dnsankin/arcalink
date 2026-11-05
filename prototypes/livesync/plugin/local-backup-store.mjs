import {createFolderPolicyStore} from './folder-policy-store.mjs';
import {hashShared2Stream} from './shared2-stream-hash.mjs';
const fail=code=>Object.assign(Error(code),{code});
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
export const backupPath=path=>typeof path==='string'&&path.length<=2048&&!path.startsWith('/')&&!/[\\\u0000-\u001f]/.test(path)&&path.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!p.startsWith('.'));
export const backupDefaults={enabled:false,days:14,maxBytes:2*1024**3};
export function createLocalBackupStore({adapter,root,readStream,now=Date.now,accept=backupPath}){
 const safe=path=>backupPath(path)&&accept(path)&&path!==root&&!path.startsWith(root+'/');
 let queue=Promise.resolve(),closed=false,running=false;const pending=[],controls=[],sizes=new Map(),readers=new Map();const index=createFolderPolicyStore(adapter,root+'/index');
 // Settings and UI reads may run after the current atomic operation, without
 // waiting for an entire startup backlog. Captures remain sequential and FIFO.
 async function drain(){if(running)return;running=true;try{while(controls.length||pending.length){const job=(controls.length?controls:pending).shift();try{job.resolve(await job.run());}catch(e){job.reject(e);}}}finally{running=false;}}
 const serial=(run,priority=false)=>{let resolve,reject;const job=new Promise((ok,no)=>{resolve=ok;reject=no;});(priority?controls:pending).push({run,resolve,reject});queue=Promise.all([queue,job.catch(()=>{})]).then(()=>{});void drain();return job;};
 async function mkdirs(path){let dir='';for(const part of path.split('/')){dir+=(dir?'/':'')+part;if(!await adapter.exists(dir))await adapter.mkdir(dir);}}
 const object=h=>root+'/objects/'+h;
 function check(state){
  if(!Object.keys(state).length)return {protocol:1,settings:{...backupDefaults},versions:[]};
  if(state.protocol!==1||!state.settings||typeof state.settings.enabled!=='boolean'||!Number.isInteger(state.settings.days)||state.settings.days<1||state.settings.days>365||!Number.isSafeInteger(state.settings.maxBytes)||state.settings.maxBytes<1024*1024||!Array.isArray(state.versions)||state.versions.length>100000)throw fail('backup-index-invalid');
  const ids=new Set();for(const v of state.versions){if(!v||!safe(v.path)||!Number.isSafeInteger(v.size)||v.size<0||!Number.isFinite(v.time)||!Number.isFinite(v.mtime)||v.lastSeen!==undefined&&!Number.isFinite(v.lastSeen)||!/^\w[\w-]{1,100}$/.test(v.id)||ids.has(v.id)||!Array.isArray(v.chunks)||!v.chunks.every(h=>/^[a-f0-9]{64}$/.test(h))||! /^[a-f0-9]{64}$/.test(v.sha256))throw fail('backup-index-invalid');ids.add(v.id);}return state;
 }
 const load=async()=>{if(closed)throw fail('backup-store-closed');return check(await index.read());};
 function bytes(versions){return new Set(versions.flatMap(v=>v.chunks));}
 async function used(versions){let total=0;for(const h of bytes(versions)){let size=sizes.get(h);if(size===undefined){const s=await adapter.stat(object(h));if(!s||s.type!=='file'||s.size>256*1024)throw fail('backup-object-missing');size=s.size;sizes.set(h,size);}total+=size;}return total;}
 async function physicalBytes(){
  if(!await adapter.exists(root+'/objects'))return 0;
  let total=0;for(const path of (await adapter.list(root+'/objects')).files){const stat=await adapter.stat(path);if(!stat||stat.type!=='file'||!Number.isSafeInteger(stat.size)||stat.size<0)throw fail('backup-object-missing');total+=stat.size;}return total;
 }
 async function save(state){if(closed)throw fail('backup-store-closed');await mkdirs(root+'/objects');check(state);await index.update(()=>state);}
 async function collect(state){
  // Both recoverable slots must describe this state before any referenced block is removed.
  await save(state);await save(state);const keep=bytes(state.versions),listing=await adapter.list(root+'/objects');
  for(const path of listing.files){const h=path.slice((root+'/objects/').length);if(/^[a-f0-9]{64}$/.test(h)&&!keep.has(h)){await adapter.remove(path);sizes.delete(h);}}
 }
 async function prune(state,protectedId){
  state.versions=state.versions.filter(v=>v.id===protectedId||readers.has(v.id)||(v.lastSeen??v.time)>=now()-state.settings.days*86400000);
  state.versions.sort((a,b)=>a.time-b.time);
  while(await used(state.versions)>state.settings.maxBytes){const i=state.versions.findIndex(v=>v.id!==protectedId&&!readers.has(v.id));if(i<0)throw fail('backup-quota-too-small');state.versions.splice(i,1);}
 }
 async function* blocks(stream){let pending=new Uint8Array(256*1024),size=0;for await(const part of stream){if(!(part instanceof Uint8Array))throw fail('backup-stream-invalid');for(let i=0;i<part.length;){const n=Math.min(pending.length-size,part.length-i);pending.set(part.subarray(i,i+n),size);size+=n;i+=n;if(size===pending.length){yield pending;pending=new Uint8Array(256*1024);size=0;}}}if(size)yield pending.slice(0,size);}
 async function capture(path,reason='change'){
  if(!safe(path))return null;const state=await load();if(!state.settings.enabled)return null;
  const before=await adapter.stat(path);if(!before||before.type!=='file')return null;if(before.size>state.settings.maxBytes)throw fail('backup-file-exceeds-quota');
  // Remove crash leftovers before staging at most one new file.
  await collect(state);const chunks=[];
  const proof=await hashShared2Stream((async function*(){for await(const b of blocks(await readStream(path))){if(closed)throw fail('backup-store-closed');const h=await hash(b),p=object(h);if(!await adapter.exists(p))await adapter.writeBinary(p,b.buffer);const stored=new Uint8Array(await adapter.readBinary(p));if(await hash(stored)!==h)throw fail('backup-object-corrupt');sizes.set(h,stored.length);chunks.push(h);yield b;}})());
  const after=await adapter.stat(path);if(!after||after.size!==before.size||after.mtime!==before.mtime||proof.size!==before.size)throw fail('backup-source-changed');
  const latest=state.versions.filter(v=>v.path===path).at(-1);if(latest?.sha256===proof.sha256){if(now()-(latest.lastSeen??latest.time)>=3600000){latest.lastSeen=now();await save(state);}return latest;}
  const v={id:crypto.randomUUID(),path,reason,time:now(),lastSeen:now(),mtime:before.mtime,size:proof.size,sha256:proof.sha256,chunks};state.versions.push(v);await prune(state,v.id);await collect(state);return v;
 }
 async function* content(version){
  for(const h of version.chunks){const b=new Uint8Array(await adapter.readBinary(object(h)));if(b.length>256*1024||await hash(b)!==h)throw fail('backup-object-corrupt');yield b;}
 }
 return {
  state:({priority=false}={})=>serial(async()=>{const s=await load();await used(s.versions);return {...s,usedBytes:await physicalBytes()};},priority),
  configure:patch=>serial(async()=>{const s=await load();s.settings={...s.settings,...patch};check(s);await prune(s);await collect(s);return s.settings;},true),
  capture:(path,reason='change',{priority=false}={})=>serial(async()=>{try{return await capture(path,reason);}catch(error){
   // Reload authority: a failed slot write may already have committed one valid slot.
   // GC can remove only blocks not referenced by that recoverable state.
   try{await collect(await load());}catch{}throw error;
  }},priority),
  async version(id){return serial(async()=>{const v=(await load()).versions.find(v=>v.id===id);if(!v)throw fail('backup-version-missing');return v;});},
  verify:(id,{priority=false}={})=>serial(async()=>{const v=(await load()).versions.find(v=>v.id===id);if(!v)throw fail('backup-version-missing');const p=await hashShared2Stream(content(v));if(p.size!==v.size||p.sha256!==v.sha256)throw fail('backup-version-corrupt');return v;},priority),
  retain:(id,{priority=false}={})=>serial(async()=>{
   const v=(await load()).versions.find(v=>v.id===id);if(!v)throw fail('backup-version-missing');
   const p=await hashShared2Stream(content(v));if(p.size!==v.size||p.sha256!==v.sha256)throw fail('backup-version-corrupt');
   readers.set(id,(readers.get(id)||0)+1);let released=false;
   return {version:v,release:()=>serial(async()=>{if(released)return;released=true;const count=readers.get(id)-1;if(count)readers.set(id,count);else readers.delete(id);})};
  },priority),
  stream:content,
  cleanup:()=>serial(async()=>{const s=await load();await prune(s);await collect(s);}),
  idle:()=>queue,
  dispose:()=>{closed=true;},
 };
}
