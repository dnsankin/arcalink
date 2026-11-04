import {backupPath} from './local-backup-store.mjs';
/** Reversible public DataAdapter interception. Never suppress a failed pre-write backup. */
export function installLocalBackupHooks({adapter,enabled,capture,failed,changed=()=>{},accept=backupPath}){
 const originals=new Map(),wrappers=new Map(),operations=new Set();let alive=true;
 const protectedPath=path=>backupPath(path)&&accept(path)&&!path.startsWith('ArcaLink Shared/');
 // Include parent/child conflicts and both rename ends. Case folding is
 // conservative on case-sensitive disks and protects aliases on macOS/Windows.
 const overlap=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
 function atomic(paths,run){
  const before=[...operations].filter(job=>job.paths.some(a=>paths.some(b=>overlap(a,b))));
  if(!before.length&&(!alive||!enabled()))return run();
  let release;const done=new Promise(resolve=>release=resolve),job={paths,done};operations.add(job);
  return Promise.all(before.map(job=>job.done)).then(run).finally(()=>{operations.delete(job);release();});
 }
 async function protect(path,reason){
  if(!alive||!enabled()||!protectedPath(path))return;
  const stat=await adapter.stat(path);if(!stat)return;
  if(stat.type==='folder'){const list=await adapter.list(path);for(const file of list.files)await protect(file,reason);for(const dir of list.folders)await protect(dir,reason);}
  else await capture(path,reason);
 }
 for(const method of ['write','writeBinary','append','appendBinary','remove','rename','trashSystem','trashLocal','rmdir']){
  if(typeof adapter[method]!=='function')continue;
  const original=adapter[method],wrapper=async function(...args){
   const run=async()=>{
    try{await protect(args[0],method);if(method==='rename')await protect(args[1],'replace-by-rename');}
    catch(error){failed(error,args[0]);throw error;}
    const result=await original.apply(this,args);if(alive&&enabled())changed(args[0]);return result;
   };
   const paths=args.slice(0,method==='rename'?2:1);
   // Store/index writes and other excluded paths must never wait on their own backup.
   if(!paths.some(protectedPath))return run();
   return atomic(paths.filter(path=>typeof path==='string').map(path=>path.normalize('NFC').toLowerCase()),run);
  };
  originals.set(method,original);wrappers.set(method,wrapper);adapter[method]=wrapper;
 }
 return ()=>{alive=false;for(const [method,original]of originals)if(adapter[method]===wrappers.get(method))adapter[method]=original;};
}
