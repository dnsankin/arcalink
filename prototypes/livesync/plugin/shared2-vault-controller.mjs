import {safeRelative} from './folder-model.mjs';
const fail=code=>Object.assign(Error(code),{code});
/** One mount, one serialized reconciliation loop. Filesystem adapter must perform
 * conditional atomic replacement and preserve backups OUTSIDE the shared mount.
 * A cached/missing catalog never authorizes a personal-engine fallback.
 */
export function createShared2VaultController({profile,engine,disk,store,checkLease,hashStream,canUpload=()=>true,onState=(_state)=>{}}){
 if(!profile?.folder||!engine||!disk||!store||typeof checkLease!=='function'||typeof hashStream!=='function')throw fail('shared2-vault-adapters-required');
 for(const method of ['list','fingerprint','blob','replace','remove','backup'])if(typeof disk[method]!=='function')throw fail('shared2-conditional-filesystem-required');
 let state,flight,closed=false;
 const scope=JSON.stringify([profile.account,profile.workspace,profile.folder,profile.generation,profile.cacheEpoch||null,profile.role]);
 async function healthy(){if(closed||await checkLease(profile)!==true)throw fail('shared2-vault-lease-rejected');}
 async function save(){await store.save(structuredClone(state));}
 async function load(){if(state)return;const saved=await store.load();if(saved&&(saved.scope!==scope||saved.protocol!==2||!saved.files||typeof saved.files!=='object'))throw fail('shared2-vault-ledger-scope-mismatch');state=saved||{protocol:2,scope,files:{}};}
 async function preserve(path,hash){const backup=await disk.backup(path,hash);if(typeof backup!=='string'||!backup)throw fail('shared2-backup-location-required');state.recovery??=[];if(!state.recovery.some(item=>item.path===path&&item.hash===hash&&item.backup===backup)){state.recovery.push({path,hash,backup});}await save();}
 const oldFile=path=>Object.hasOwn(state.files,path)?state.files[path]:undefined;
 const remember=(path,value)=>Object.defineProperty(state.files,path,{value,writable:true,enumerable:true,configurable:true});
 const name=path=>{if(!safeRelative(path))throw fail('shared2-unsafe-vault-path');return profile.documentRoot+'/'+path;};
 async function run(){
  await healthy();await load();onState({state:'syncing'});
  // Capture local edits BEFORE pulling. Known ancestry produces a branch from
  // that revision; unknown ancestry produces an independent root, never a write
  // based on a newer remote revision the user has not seen.
  const local=await disk.list(),seen=new Set();
  for(const path of local){name(path);const folded=path.toLowerCase();if(seen.has(folded))throw fail('shared2-local-case-conflict');seen.add(folded);}
  if(profile.role!=='viewer'&&canUpload()&&local.some(path=>!oldFile(path))){
   await engine.synchronize();await healthy();const initial=await engine.inspect(),byPath=new Map(initial.files.map(file=>[file.path,file]));
   for(const path of local){
    if(oldFile(path))continue;const remote=byPath.get(name(path));
    if(!remote||remote.deleted||remote.conflicts.length)continue;
    const proof=await hashStream(engine.stream(remote.path));
    if(proof.size===remote.size&&await disk.fingerprint(path)===proof.sha256){remember(path,{hash:proof.sha256,revision:remote.revision});await save();}
   }
  }
  const paths=new Set([...local,...Object.keys(state.files)]);
  if(profile.role!=='viewer'&&canUpload())for(const path of paths){
   await healthy();const before=await disk.fingerprint(path),old=oldFile(path);
   if(before===old?.hash||!before&&!old)continue;
   if(before){
    const value=await disk.blob(path);if(await disk.fingerprint(path)!==before)throw fail('shared2-local-file-changed');
    const result=await engine.write(name(path),{blob:value,...(old?.revision?{baseRevision:old.revision}:{independent:true})});
    // A subsequent change remains dirty and is handled on the next pass.
    remember(path,{hash:before,revision:result.rev});await save();
   }else if(old?.revision){const result=await engine.remove(name(path),{baseRevision:old.revision});remember(path,{hash:null,revision:result.rev});await save();}
  }
  await healthy();await engine.synchronize();await healthy();
  const inventory=await engine.inspect(),conflicts=[];
  if(profile.role!=='viewer'&&!canUpload()){
   const canonical=new Set(inventory.files.map(file=>file.path));
   for(const path of local)if(!canonical.has(name(path))){const current=await disk.fingerprint(path);if(current){await preserve(path,current);await healthy();await disk.remove(path,{expectedHash:current});}}
  }
  for(const file of inventory.files){
   if(!file.path.startsWith(profile.documentRoot+'/'))throw fail('shared2-file-outside-document-root');
   const path=file.path.slice(profile.documentRoot.length+1);name(path);
   if(file.conflicts.length){conflicts.push(path);continue;}
   const current=await disk.fingerprint(path),old=oldFile(path);
   if(file.deleted){
    if(current){await preserve(path,current);await healthy();await disk.remove(path,{expectedHash:current});}
    remember(path,{hash:null,revision:file.revision});await save();continue;
   }
   const proof=await hashStream(engine.stream(file.path));
   if(proof.size!==file.size)throw fail('shared2-project-size-mismatch');
   if(current!==proof.sha256){
    if(current&&current!==old?.hash)await preserve(path,current);
    await healthy();await disk.replace(path,engine.stream(file.path),{expectedHash:current,sha256:proof.sha256,size:proof.size});
   }
   remember(path,{hash:proof.sha256,revision:file.revision});await save();
  }
  // An old ledger entry without metadata is not proof of remote deletion.
  // Tombstones are required; a damaged/missing cache cannot remove local files.
  onState({state:conflicts.length?'conflict':'idle',conflicts});return {conflicts};
 }
 function synchronize(){if(closed)return Promise.reject(fail('shared2-vault-closed'));if(flight)return flight;const task=run().catch(error=>{onState({state:'error',code:error.code||'shared2-vault-sync-failed'});throw error;});flight=task;task.then(()=>{if(flight===task)flight=undefined;},()=>{if(flight===task)flight=undefined;});return task;}
 return {synchronize,async close(){closed=true;if(flight)await flight.catch(()=>{});},async ledger(){await load();return structuredClone(state);}};
}
