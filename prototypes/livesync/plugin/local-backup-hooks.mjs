import {backupPath} from './local-backup-store.mjs';
/** Reversible public DataAdapter interception. Never suppress a failed pre-write backup. */
export function installLocalBackupHooks({adapter,enabled,capture,failed,changed=()=>{},accept=backupPath}){
 const originals=new Map(),wrappers=new Map();let alive=true;
 async function protect(path,reason){
  if(!alive||!enabled()||!backupPath(path)||!accept(path)||path.startsWith('ArcaLink Shared/'))return;
  const stat=await adapter.stat(path);if(!stat)return;
  if(stat.type==='folder'){const list=await adapter.list(path);for(const file of list.files)await protect(file,reason);for(const dir of list.folders)await protect(dir,reason);}
  else await capture(path,reason);
 }
 for(const method of ['write','writeBinary','append','appendBinary','remove','rename','trashSystem','trashLocal','rmdir']){
  if(typeof adapter[method]!=='function')continue;
  const original=adapter[method],wrapper=async function(...args){
   try{await protect(args[0],method);if(method==='rename')await protect(args[1],'replace-by-rename');}
   catch(error){failed(error,args[0]);throw error;}
   const result=await original.apply(this,args);if(alive&&enabled())changed(args[0]);return result;
  };
  originals.set(method,original);wrappers.set(method,wrapper);adapter[method]=wrapper;
 }
 return ()=>{alive=false;for(const [method,original]of originals)if(adapter[method]===wrappers.get(method))adapter[method]=original;};
}
