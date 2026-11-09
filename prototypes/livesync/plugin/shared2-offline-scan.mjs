import {createOfflineScanner} from '@arcalink/shared2-offline-scanner';
import {BASE_IS_NEW,EVEN} from '@vrtmrz/livesync-commonlib/compat/common/models/shared.const.symbols';
import {safeRelative} from './folder-model.mjs';

const fail=code=>Object.assign(Error(code),{code});

/** Use LiveSync's offline scanner with the database, storage and last-seen
 * state for this mount. All file mutations pass through the scoped handler. */
export function createShared2OfflineScan({documentRoot,store,services,role,canUpload,assertCurrent,rememberRevision}){
 const {performFullScan,FullScanModes,ExtraOnLocal,VaultScanResults}=createOfflineScanner(services.database.localDatabase.localDatabase.name);
 const valid=path=>safeRelative(path)&&path.startsWith(documentRoot+'/');
 const errors={showError(){},clearError(){}};
 return async ({engine,full=false,onConflict=async(_path)=>{}})=>{
  const metadata=await engine.metadataFiles();
  const byPath=new Map(metadata.map(doc=>[doc.path,doc]));
  const records=await store.provenance.snapshot();
  const sourceSettings=services.setting.currentSettings();
  const writable=role!=='viewer'&&canUpload();
  const fresh=(file,doc)=>{
   const record=Object.hasOwn(records,doc.path)?records[doc.path]:undefined;
   const stat=record?.verifiedStat;
   return !doc.deleted&&!doc._deleted&&!doc._conflicts?.length&&file.path===doc.path&&record?.revision===doc._rev&&stat&&file.stat.size===stat.size&&file.stat.mtime===stat.mtime&&file.stat.ctime===stat.ctime;
  };
  for(const doc of metadata)if(valid(doc.path)&&doc._conflicts?.length)await onConflict(doc.path);
  await engine.files.scan(async io=>{
   const files=await io.storageAccess.getFiles();
   const local=new Map(files.map(file=>[file.path,file]));
   // Only displayed ancestry can mark an offline deletion. The CouchDB
   // timestamp may differ from the native mtime after materialisation.
   const saved=await store.kv.get('scanner:fileStatusMap')||{};
   const lastSeen=Object.fromEntries(metadata.filter(doc=>valid(doc.path)&&!doc.deleted&&!doc._deleted&&Number.isFinite(doc.mtime)&&
    Object.hasOwn(records,doc.path)&&records[doc.path]?.revision===doc._rev).map(doc=>{
    const key=sourceSettings.handleFilenameCaseSensitive?doc.path:doc.path.toLowerCase();
    const remembered=Object.hasOwn(saved,key)?saved[key]:undefined;
    return [key,Number.isFinite(remembered)?Math.max(remembered,doc.mtime):doc.mtime];
   }));
   const assert=async()=>{if(await assertCurrent()!==true)throw fail('shared2-vault-lease-rejected');};
   const remember=async path=>{
    const doc=await engine.metadata(path);
    if(doc)await rememberRevision(doc);
   };
   const reflect=async value=>{
    const path=typeof value==='string'?value:services.path.getPath(value);
    const doc=byPath.get(path),file=local.get(path);
    if(!full&&doc&&file&&fresh(file,doc))return true;
    await assert();
    const reflected=await io.reflect(path);
    if(reflected)await remember(path);
    return reflected;
   };
   const host={
    services:{
     ...services,
     setting:{currentSettings:()=>({...sourceSettings,automaticallyDeleteMetadataOfDeletedFiles:0})},
     database:{localDatabase:{async *findAllNormalDocs(){yield* metadata;}}},
     vault:{isTargetFile:async path=>valid(path),isValidPath:valid,isFileSizeTooLarge:()=>false},
     keyValueDB:{kvDB:{
      get:key=>key==='fileStatusMap'?lastSeen:store.kv.get('scanner:'+key),
      set:(key,value)=>store.kv.set('scanner:'+key,value),
     }},
     path:{
      path2id:path=>services.path.path2id(path),
      getPath:doc=>services.path.getPath(doc),
      compareFileFreshness:(file,doc)=>{
       if(!full&&fresh(file,doc))return EVEN;
       // A changed local observation or older ancestry needs the maintained
       // file handler's revision check even when wall-clock dates coincide.
       if(Object.hasOwn(records,doc.path))return BASE_IS_NEW;
       return services.path.compareFileFreshness(file,doc);
      },
     },
    },
    serviceModules:{
     storageAccess:{getFiles:async()=>files,restoreState:async()=>{},delete:async path=>{
      if(!await reflect(path))throw fail('shared2-file-apply-incomplete');
     }},
     fileHandler:{
      storeFileToDB:async file=>{await assert();await io.store(file);await remember(file.path);},
      dbToStorage:reflect,
      deleteFileFromDB:async path=>{await assert();return io.remove(path);},
      tryRecordUntrackedFileRevision:async (file,revision)=>{
       if(Object.hasOwn(records,file.path))return false;
       await assert();
       const recorded=await io.recordUntracked(file,revision);
       if(recorded)await remember(file.path);
       return recorded;
      },
     },
    },
   };
   const result=await performFullScan(host,()=>{},errors,{
    mode:writable?FullScanModes.NEWER_WINS:FullScanModes.DB_APPLY,
    extraOnLocal:ExtraOnLocal.DELETE_DB_DELETED,
   });
   if(result!==VaultScanResults.COMPLETED)throw fail('shared2-file-event-incomplete');
  });
 };
}
