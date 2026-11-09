import {ServiceFileHandlerBase} from '@vrtmrz/livesync-commonlib/compat/serviceModules/ServiceFileHandlerBase';
import {ServiceDatabaseFileAccessBase} from '@vrtmrz/livesync-commonlib/compat/serviceModules/ServiceDatabaseFileAccessBase';
import {InjectableFileProcessingService} from '@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectableFileProcessingService';
import {handlers} from '@vrtmrz/livesync-commonlib/compat/services/lib/HandlerUtils';
import {safeRelative} from './folder-model.mjs';

const fail=code=>Object.assign(Error(code),{code});

/** A virtual storage view: database paths stay stable when a recipient mounts
 * the folder elsewhere. The supplied backend retains backup/conditional-write
 * responsibilities; this adapter only routes paths and checks scope.
 */
export function createShared2ScopedStorage({storage,mount,documentRoot}){
 if(!storage||!safeRelative(mount)||!safeRelative(documentRoot))throw fail('invalid-shared2-storage-scope');
 const inside=(path,root)=>safeRelative(path)&&path.startsWith(root+'/');
 const physical=path=>{if(!inside(path,documentRoot))throw fail('shared2-file-outside-document-root');return mount+path.slice(documentRoot.length);};
 const logical=path=>{if(!inside(path,mount))throw fail('shared2-file-outside-mount');return documentRoot+path.slice(mount.length);};
 const toPhysical=file=>typeof file==='string'?physical(file):{...file,path:physical(file.path)};
 const toLogical=file=>file?{...file,path:logical(file.path)}:file;
 return {
  async getStub(path){return toLogical(await storage.getStub(physical(path)));},
  async getFileStub(path){return toLogical(await storage.getFileStub(physical(path)));},
  async readStubContent(file){return toLogical(await storage.readStubContent(toPhysical(file)));},
  async getFiles(){return (await storage.getFiles()).filter(file=>inside(file.path,mount)).map(toLogical);},
  stat:path=>storage.stat(physical(path)),
  statHidden(){throw fail('shared2-hidden-files-not-supported');},
  ensureDir:path=>storage.ensureDir(physical(path)),
  writeFileAuto:(path,body,times)=>storage.writeFileAuto(physical(path),body,times),
  deleteVaultItem:path=>storage.deleteVaultItem(physical(path)),
  async renameFile(file,path){return toLogical(await storage.renameFile(toPhysical(file),physical(path)));},
  touched:path=>storage.touched(physical(path)),
  triggerFileEvent:(type,path)=>storage.triggerFileEvent(type,physical(path)),
  normalisePath:path=>logical(storage.normalisePath(physical(path))),
 };
}

/** Compose the SAME file/revision handlers as the personal engine. No second
 * rename, deletion, conflict or provenance algorithm lives here. Admission and
 * result loading belong to the caller; incoming() accepts decoded metadata
 * whose chunks have been admitted by the ordinary result processor.
 * Not enabled in production until baseline/gateway integration passes.
 */
export function createShared2FileRuntime({services,storageAccess,fileReflectionProvenance,conflict,vault,documentRoot,role,assertCurrent,onReflected=async(_entry,_establish=false)=>{}}){
 if(!services?.database?.localDatabase||!safeRelative(documentRoot)||!['owner','editor','viewer'].includes(role)||typeof assertCurrent!=='function'
  ||!storageAccess||!fileReflectionProvenance||!conflict||!vault)throw fail('invalid-shared2-file-runtime');
 const pathAllowed=path=>safeRelative(path)&&path.startsWith(documentRoot+'/');
 const checkPath=path=>{if(!pathAllowed(path))throw fail('shared2-file-outside-document-root');};
 const fileProcessing=new InjectableFileProcessingService(services.context);
 const replication={processSynchroniseResult:handlers().anySuccess('processSynchroniseResult')};
 const scoped={...services,events:services.context.events,storageAccess,fileReflectionProvenance,conflict,
  vault:{isFileSizeTooLarge:size=>vault.isFileSizeTooLarge(size),isTargetFile:async(path,options)=>pathAllowed(path)&&await vault.isTargetFile(path,options)},fileProcessing,replication};
 scoped.databaseFileAccess=new ServiceDatabaseFileAccessBase(scoped);
 const handler=new ServiceFileHandlerBase(scoped);
 let closing=false,tail=Promise.resolve(),pending=0;
 function enqueue(task){
  if(closing)return Promise.reject(fail('shared2-file-runtime-closed'));
  pending++;
  const result=tail.then(async()=>{if(await assertCurrent()!==true)throw fail('shared2-file-runtime-access-denied');return task();}).finally(()=>{pending--;});
  tail=result.catch(()=>{});return result;
 }
 return {
  get pending(){return pending;},
  scan(run){
   return enqueue(()=>run({
    storageAccess,
    store:async file=>{
     if(role==='viewer')throw fail('shared2-read-only');
     checkPath(file.path);
     if(await fileProcessing.processFileEvent({type:'CHANGED',args:{file},restoredFromPreviousRuntime:true})!==true)throw fail('shared2-file-event-incomplete');
    },
    recordUntracked:async (file,revision)=>{checkPath(file.path);return handler.tryRecordUntrackedFileRevision(file,revision);},
    reflect:async path=>{checkPath(path);return handler.dbToStorage(path,path,false);},
    remove:async path=>{
     if(role==='viewer')throw fail('shared2-read-only');
     checkPath(path);
     return fileProcessing.processFileEvent({type:'DELETE',args:{file:{path,name:path.split('/').at(-1),stat:{type:'file',size:0,mtime:0,ctime:0}}},restoredFromPreviousRuntime:true});
    },
   }));
  },
  adoptRevision(path,revision){
   try{
    checkPath(path);
    return enqueue(async()=>{
     const adopted=await handler.storeFileToDBWithBaseRevision(path,revision,false);
     // The cutover ledger names an exact revision. If the handler could
     // not adopt it, the independent byte proof can still establish ancestry.
     await onReflected({path,_rev:revision},true);
     return adopted;
    });
   }catch(error){return Promise.reject(error);}
  },
  localEvent(item){
   if(role==='viewer')return Promise.reject(fail('shared2-read-only'));
   try{
    if(!['CREATE','CHANGED','DELETE','RENAME'].includes(item?.type)||!item.args?.file)throw fail('invalid-shared2-file-event');
    checkPath(item.args.file.path);
    if(item.type==='RENAME')checkPath(item.args.oldPath);
    if(item.args.renameTarget!==undefined)checkPath(item.args.renameTarget);
    const snapshot={...item,args:{...item.args,file:{...item.args.file,stat:{...item.args.file.stat}}}};
    return enqueue(()=>fileProcessing.processFileEvent(snapshot));
   }catch(error){return Promise.reject(error);}
  },
  incoming(entry){
   try{
    checkPath(entry?.path);
    if(!['plain','newnote'].includes(entry.type))throw fail('invalid-shared2-incoming-file');
    const snapshot=structuredClone(entry);
    return enqueue(async()=>{
     const reflected=await replication.processSynchroniseResult(snapshot);
     if(reflected===true)await onReflected(snapshot);
     return reflected;
    });
   }catch(error){return Promise.reject(error);}
  },
  drain:()=>tail,
  close(){closing=true;return tail;},
 };
}
