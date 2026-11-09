import {isPlainText} from '@vrtmrz/livesync-commonlib/compat/string_and_binary/path';
import {safeRelative} from './folder-model.mjs';
const fail=code=>Object.assign(Error(code),{code});

/** Native storage boundary for the ordinary LiveSync file handler. Reuses the
 * existing shared disk's conditional staged writes and recovery copies. Content
 * proofs are per affected file, never a scan of unrelated folder contents.
 */
export function createShared2LiveSyncStorage({storage,disk,mount,stat,hashStream,commit,preserve,dispatch=(type,path)=>storage.triggerFileEvent(type,path)}){
 if(!storage||!disk||!safeRelative(mount)||typeof stat!=='function'||typeof hashStream!=='function'||typeof commit!=='function'||typeof preserve!=='function')throw fail('invalid-shared2-native-storage');
 const observed=new Map();
 const relative=path=>{if(!safeRelative(path)||!path.startsWith(mount+'/'))throw fail('shared2-file-outside-mount');return path.slice(mount.length+1);};
 async function getStub(path){
  const name=relative(path),current=await stat(path);
  if(!current){observed.set(path,null);return null;}
  const native=await storage.getStub(path);
  if(current.type==='folder')return {...native,path:native?.path||path,isFolder:true};
  const resolved=native?.path||path;relative(resolved);
  observed.set(resolved,await disk.fingerprint(relative(resolved)));
  return {name:resolved.split('/').at(-1),path:resolved,stat:{...current,type:'file'}};
 }
 function expected(path){relative(path);if(!observed.has(path))throw fail('shared2-storage-observation-required');return observed.get(path);}
 async function backup(path,hash){if(hash!==null){const backup=await disk.backup(relative(path),hash);await preserve({path,hash,backup});}}
 return {
  getStub,
  async getFileStub(path){const file=await getStub(path);return file?.isFolder?null:file;},
  async readStubContent(stub){
   const name=relative(stub.path),current=await stat(stub.path);if(!current||current.type!=='file')return false;
   const blob=await disk.blob(name),body=blob.slice(0,blob.size,isPlainText(stub.name)?'text/plain':'application/octet-stream');
   const proof=await hashStream(body.stream());observed.set(stub.path,proof.sha256);
   return {...stub,stat:{...current,type:'file',size:body.size},body};
  },
  async getFiles(){return (await storage.getFiles()).filter(file=>file.path.startsWith(mount+'/'));},
  stat:path=>{relative(path);return stat(path);},
  normalisePath:path=>{relative(path);return storage.normalisePath(path);},
  ensureDir(path){relative(path);return Promise.resolve(true);}, // staged commit creates parents
  async writeFileAuto(path,data,_times){
   const name=relative(path),before=expected(path),body=new Blob([data]);
   const proof=await hashStream(body.stream());
   await commit(path,async()=>{
    if(before===proof.sha256){
     // Recheck the current file under the lease before acknowledging an
     // identical revision. No staged rename means no delete/create events.
     if(await disk.fingerprint(name)!==before)throw fail('shared2-local-file-changed');
     return;
    }
    await backup(path,before);
    await disk.replace(name,body.stream(),{expectedHash:before,...proof});
   });
   observed.set(path,proof.sha256);return true;
  },
  async deleteVaultItem(path){
   const name=relative(path),before=expected(path);
   await commit(path,async()=>{await backup(path,before);await disk.remove(name,{expectedHash:before});});observed.set(path,null);
  },
  async renameFile(file,path){
   const from=typeof file==='string'?file:file.path;relative(from);relative(path);
   // Ordinary moves are represented as database rename events. Storage-side
   // rename is used by the maintained handler only to correct filename case.
   if(from.toLowerCase()!==path.toLowerCase()||from.slice(0,from.lastIndexOf('/'))!==path.slice(0,path.lastIndexOf('/')))throw fail('shared2-storage-case-rename-required');
   const before=expected(from);
   return commit(from,async()=>{
    const target=await storage.getStub(path);
    if(target&&target.path!==from)throw fail('shared2-storage-case-collision');
    await backup(from,before);
    if(await disk.fingerprint(relative(from))!==before)throw fail('shared2-local-file-changed');
    const renamed=await storage.renameFile(file,path);
    if(!renamed)return null;
    if(await disk.fingerprint(relative(path))!==before)throw fail('shared2-local-file-changed');
    observed.delete(from);observed.set(path,before);return renamed;
   });
  },
  touched:path=>{relative(path);return storage.touched(path);},
  triggerFileEvent:(type,path)=>{relative(path);return dispatch(type,path);},
 };
}
