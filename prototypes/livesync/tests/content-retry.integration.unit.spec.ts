import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {reactiveSource} from 'octagonal-wheels/dataobject/reactive';
import {ReplicateResultProcessor} from './serviceFeatures/replication/ReplicateResultProcessor';
import {ChunkFetcher} from '../node_modules/@vrtmrz/livesync-commonlib/dist/managers/ChunkFetcher.js';

const entry=(rev='1-a')=>({_id:'binary',_rev:rev,path:'Attachments/test.bin',ctime:1,mtime:2,size:7,
 children:['h:test'],datatype:'newnote',type:'newnote',eden:{}});
const bytes=new Uint8Array([0,255,128,10,13,0,42]);
function setup(saved?:any){
 let physical={},latest:any=entry(),snapshot=saved,online=true,paused=false,mode='';
 const disk=new Map<string,Uint8Array>();
 const read=vi.fn(async(meta:any):Promise<any>=>({...meta,data:new Blob([bytes])}));
 const apply=vi.fn(async(meta:any)=>{if(meta.deleted||meta._deleted)disk.delete(meta.path);
  else disk.set(meta.path,new Uint8Array(await meta.data.arrayBuffer()));return true;});
 const context:any={currentSettings:()=>({maxMTimeForReflectEvents:0,suspendParseReplicationResult:false,remoteType:mode}),
  getKeyValueDB:()=>({set:async(_key:string,value:any)=>{snapshot=structuredClone(value);},get:async()=>snapshot}),
  getLocalDatabase:()=>({localDatabase:physical,getRaw:async()=>latest,getDBEntryFromMeta:read}),
  requestActiveReplicatorRetirement:()=>{},runLocalApplicationActivity:async(task:()=>any)=>await task(),
  services:{API:{get isOnline(){return online;}},appLifecycle:{isReady:()=>true,isSuspended:()=>paused},database:{isDatabaseReady:()=>true},
   path:{getPath:(doc:any)=>doc.path},vault:{isTargetFile:async()=>true,isFileSizeTooLarge:()=>false,isValidPath:()=>true},
   replication:{replicationResultCount:reactiveSource(0),databaseQueueCount:reactiveSource(0),storageApplyingCount:reactiveSource(0),
    processVirtualDocument:async()=>false,processOptionalSynchroniseResult:async()=>false,processSynchroniseResult:apply}}};
 const processor=new ReplicateResultProcessor(context);
 return {processor,read,apply,disk,snapshot:()=>snapshot,setLatest:(v:any)=>{latest=v;},online:(v:boolean)=>{online=v;},paused:(v:boolean)=>{paused=v;},
  free:()=>{mode='ONLY_P2P';},swap:()=>{physical={};}};
}
const flush=()=>vi.advanceTimersByTimeAsync(100);
describe('cloud content recovery through the real result processor',()=>{
 beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
 it('recreates a dropped real ChunkFetcher request after a transport exception',async()=>{
  const h=setup(),stored=new Map<string,any>();let attempts=0;
  const coordinator={isFiniteReplicationActive:()=>false,onChanged:()=>()=>{},claim:(ids:string[])=>{
   const pending=new Set(ids);let resolve!:()=>void;const done=new Promise<void>(r=>{resolve=r;});
   return {done,pendingIds:ids,touch(){},release(){pending.clear();resolve();},settle(id:string){pending.delete(id);if(!pending.size)resolve();}};
  }};
  const fetcher=new ChunkFetcher({chunkManager:{deliveryCoordinator:coordinator,addListener(){},emitEvent(){},read:async()=>[],
   write:async(chunks:any[])=>{for(const chunk of chunks)stored.set(chunk._id,chunk);return {result:true};}},
   settingService:{currentSettings:()=>({minimumIntervalOfReadChunksOnline:1,concurrencyOfReadChunksOnline:1})},
   replicatorService:{runBoundedRemoteActivity:(task:()=>any)=>Promise.resolve(task()),getActiveReplicator:()=>({fetchRemoteChunks:async()=>{
    attempts++;if(attempts===1)throw new TypeError('transport interrupted');
    return [{_id:'h:test',type:'leaf',data:Buffer.from(bytes).toString('base64')}];
   }})}} as never);
  h.read.mockImplementation(async(meta:any)=>{
   fetcher.onEvent(['h:test' as never]);(fetcher as any).clearRequestTimer();await fetcher.requestMissingChunks();
   const chunk=stored.get('h:test');return chunk?{...meta,data:new Blob([Uint8Array.from(Buffer.from(chunk.data,'base64'))])}:false;
  });
  try {
   h.processor.enqueueAll([entry() as never]);await flush();expect(attempts).toBe(1);expect(h.snapshot().queued).toHaveLength(1);
   expect((fetcher as any).pendingClaims.size).toBe(0);
   await vi.advanceTimersByTimeAsync(5000);expect(attempts).toBe(2);expect(h.disk.get('Attachments/test.bin')).toEqual(bytes);
   expect(h.snapshot()).toEqual({queued:[],processing:[]});
  } finally {fetcher.destroy();await h.processor.disposeContentRetries();}
 });
 it('keeps failed metadata in the snapshot and later writes exact binary bytes',async()=>{
  const h=setup();h.read.mockResolvedValueOnce(false);h.processor.enqueueAll([entry() as never]);await flush();
  expect(h.disk.size).toBe(0);expect(h.snapshot().queued.map((d:any)=>d._id)).toEqual(['binary']);
  await vi.advanceTimersByTimeAsync(5000);expect(h.read).toHaveBeenCalledTimes(2);
  expect(h.disk.get('Attachments/test.bin')).toEqual(bytes);expect(h.snapshot()).toEqual({queued:[],processing:[]});
  await h.processor.disposeContentRetries();
 });
 it('retains failures thrown by content retrieval rather than only false results',async()=>{
  const h=setup();h.read.mockRejectedValueOnce(new TypeError('network interrupted'));h.processor.enqueueAll([entry() as never]);await flush();
  expect(h.snapshot().queued).toHaveLength(1);await vi.advanceTimersByTimeAsync(5000);expect(h.disk.get('Attachments/test.bin')).toEqual(bytes);
  await h.processor.disposeContentRetries();
 });
 it('does not make content requests offline or while explicitly paused',async()=>{
  const h=setup();h.read.mockResolvedValueOnce(false);h.processor.enqueueAll([entry() as never]);await flush();
  h.online(false);await vi.advanceTimersByTimeAsync(60000);expect(h.read).toHaveBeenCalledTimes(1);
  h.online(true);h.paused(true);await vi.advanceTimersByTimeAsync(60000);expect(h.read).toHaveBeenCalledTimes(1);
  h.paused(false);await vi.advanceTimersByTimeAsync(5000);expect(h.disk.get('Attachments/test.bin')).toEqual(bytes);
  await h.processor.disposeContentRetries();
 });
 it('rechecks the latest revision and skips a now-obsolete pending attachment',async()=>{
  const h=setup();h.read.mockResolvedValueOnce(false);h.processor.enqueueAll([entry() as never]);await flush();
  h.setLatest({...entry('2-new'),_revs_info:[{rev:'2-new',status:'available'},{rev:'1-a',status:'available'}]});
  await vi.advanceTimersByTimeAsync(5000);expect(h.read).toHaveBeenCalledTimes(1);expect(h.apply).not.toHaveBeenCalled();
  expect(h.snapshot().queued).toEqual([]);await h.processor.disposeContentRetries();
 });
 it('a remote deletion cancels retry without resurrecting the old content',async()=>{
  const h=setup();h.read.mockResolvedValueOnce(false);h.processor.enqueueAll([entry() as never]);await flush();
  const deleted={...entry('2-delete'),deleted:true};h.setLatest(deleted);h.processor.enqueueAll([deleted as never]);await flush();
  await vi.advanceTimersByTimeAsync(60000);expect(h.read).toHaveBeenCalledTimes(1);expect(h.disk.size).toBe(0);
  expect(h.apply).toHaveBeenCalledOnce();expect(h.apply.mock.calls[0][0].deleted).toBe(true);await h.processor.disposeContentRetries();
 });
 it('restores deferred metadata after restart and leaves no old timer running',async()=>{
  const h=setup();h.read.mockResolvedValue(false);h.processor.enqueueAll([entry() as never]);await flush();
  await h.processor.disposeContentRetries();const saved=h.snapshot();expect(saved.queued).toHaveLength(1);
  const next=setup(saved);await next.processor.restoreFromSnapshotOnce();await flush();
  expect(next.disk.get('Attachments/test.bin')).toEqual(bytes);await vi.advanceTimersByTimeAsync(300000);
  expect(h.read).toHaveBeenCalledTimes(1);await next.processor.disposeContentRetries();
 });
 it('discards delayed retries when the physical database is replaced',async()=>{
  const h=setup();h.read.mockResolvedValueOnce(false);h.processor.enqueueAll([entry() as never]);await flush();h.swap();
  await vi.advanceTimersByTimeAsync(5000);expect(h.read).toHaveBeenCalledTimes(1);expect(h.apply).not.toHaveBeenCalled();
  expect(h.snapshot().queued).toEqual([]);await h.processor.disposeContentRetries();
 });
 it('rejects a late content failure from a replaced physical database',async()=>{
  const h=setup();let release!:(v:false)=>void;h.read.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  h.processor.enqueueAll([entry() as never]);await flush();h.swap();release(false);await flush();
  await vi.advanceTimersByTimeAsync(60000);expect(h.read).toHaveBeenCalledTimes(1);expect(h.snapshot().queued).toEqual([]);
  await h.processor.disposeContentRetries();
 });
 it('does not change Free/P2P recovery behavior',async()=>{
  const h=setup();h.free();h.read.mockResolvedValue(false);h.processor.enqueueAll([entry() as never]);await flush();
  await vi.advanceTimersByTimeAsync(60000);expect(h.read).toHaveBeenCalledTimes(1);expect(h.snapshot().queued).toEqual([]);
  await h.processor.disposeContentRetries();
 });
 it('does not retry tombstones or files without external chunks',async()=>{
  const h=setup();const doc={...entry(),children:[]};h.setLatest(doc);h.read.mockResolvedValue(false);h.processor.enqueueAll([doc as never]);await flush();
  await vi.advanceTimersByTimeAsync(60000);expect(h.read).toHaveBeenCalledTimes(1);expect(h.snapshot().queued).toEqual([]);
  await h.processor.disposeContentRetries();
 });
});
