import test from 'node:test';
import assert from 'node:assert/strict';
import {createShared2LiveController} from '../plugin/shared2-live-controller.mjs';
import {createShared2RuntimeStore} from '../plugin/shared2-runtime-store.mjs';
const profile={account:'owner',workspace:'work',folder:'a'.repeat(32),database:'arcalink_s_'+'b'.repeat(32),generation:1,keyEpoch:0,cacheEpoch:'c'.repeat(32),documentRoot:'Owner/Shared',role:'editor'};
const stub=path=>({path,name:path.split('/').at(-1),stat:{type:'file',size:1,ctime:1,mtime:1}});
function fixture({saved={value:null},role='editor',metadata=[],inherit=false,canUpload=()=>true}={}){
 const calls={baseline:0,list:0,sync:0,live:0,events:[],adopt:[]};let release,allowed=true,fail=false;
 const p={...profile,role},store=createShared2RuntimeStore({profile:p,mount:'Local',store:{load:async()=>saved.value,save:async value=>{saved.value=structuredClone(value);}}});
 const engine={files:{localEvent:async item=>{if(fail)throw Error('file-write-failed');calls.events.push(item);return true;},adoptRevision:async(...args)=>calls.adopt.push(args),drain:async()=>{},pending:0},
  results:{restore:async()=>{},receive:async()=>{},resume(){},pause(){},state:{}},metadataFiles:async()=>metadata,metadata:async path=>metadata.find(file=>file.path===path),
  synchronize:async()=>calls.sync++,startLive:()=>{calls.live++;return new Promise(resolve=>release=resolve);},stopLive:async()=>release?.(false),getReplicationState:()=>({syncStatus:'PAUSED'})};
 const baseline={hasBaseline:async()=>inherit,synchronize:async()=>{calls.baseline++;return {conflicts:[]};},ledger:async()=>({files:{'note.md':{hash:'1'.repeat(64),revision:'1-base'}}}),close:async()=>{}};
 const controller=createShared2LiveController({profile:p,engine,baseline,store,scan:async()=>{calls.list++;if(fail)throw Error('file-write-failed');},checkLease:async()=>allowed,canUpload});
 return {controller,engine,store,saved,calls,setAllowed:value=>allowed=value,setFail:value=>fail=value};
}
test('one-time baseline transitions to continuous LiveSync; repeated metadata ticks do not rescan files',async()=>{
 const f=fixture();await f.controller.wake();assert.equal(f.controller.ready,true);
 for(let i=0;i<50;i++)await f.controller.wake();
 assert.equal(f.calls.baseline,1);assert.equal(f.calls.list,0);assert.equal(f.calls.sync,1);assert.equal(f.calls.live,1);
 assert.equal(f.controller.state.state,'idle');assert.equal(f.controller.activity,0);
 await f.controller.enqueue({type:'CHANGED',args:{file:stub('Owner/Shared/note.md')}});
 assert.equal(f.calls.list,0);assert.equal(f.calls.baseline,1);assert.equal(f.calls.events.length,1);
 await f.controller.close();
});
test('restart delegates to the supplied offline scanner without rerunning the cutover',async()=>{
 const first=fixture();await first.controller.wake();await first.controller.close();
 const next=fixture({saved:first.saved});
 await next.store.provenance.set('Owner/Shared/note.md',{revision:'2-displayed'});
 await next.controller.wake();assert.equal(next.calls.baseline,0);
 assert.equal(next.calls.list,1);assert.deepEqual(next.calls.events,[]);
 assert.equal(next.calls.live,1);await next.controller.close();
});
test('unapplied local events stay durable across failure and retry without rescanning the folder',async()=>{
 const f=fixture();await f.controller.wake();f.setFail(true);
 await assert.rejects(f.controller.enqueue({type:'CHANGED',args:{file:stub('Owner/Shared/note.md')}}),/file-write-failed/);
 assert.equal((await f.store.pending()).length,1);assert.equal(f.controller.state.state,'error');
 f.setFail(false);await f.controller.wake();assert.equal((await f.store.pending()).length,0);
 assert.equal(f.calls.list,0);assert.equal(f.controller.state.state,'idle');await f.controller.close();
});
test('explicit verification stops the live owner once and performs one standard startup pass',async()=>{
 const f=fixture();await f.controller.wake();const first=f.controller.synchronize(),second=f.controller.synchronize();assert.equal(first,second);await first;
 assert.equal(f.calls.baseline,1);assert.equal(f.calls.list,1);assert.equal(f.calls.live,2);assert.equal(f.controller.ready,true);
 await f.controller.close();await assert.rejects(f.controller.enqueue({type:'DELETE',args:{file:stub('Owner/Shared/note.md')}}));
});
test('viewer startup cannot publish local files and stale leases cannot admit an event',async()=>{
 const f=fixture({role:'viewer'});await f.controller.wake();assert.equal(f.calls.events.length,0);
 await assert.rejects(f.controller.enqueue({type:'CREATE',args:{file:stub('Owner/Shared/draft.md')}}),/read-only/);
 f.setAllowed(false);await assert.rejects(f.controller.enqueue({type:'DELETE',args:{file:stub('Owner/Shared/note.md')}}),/lease-rejected/);
 await f.controller.close();
});
test('runtime store serializes independent snapshot, provenance and event writers and rejects another cache scope',async()=>{
 const f=fixture();await Promise.all([f.store.kv.set('snapshot',{queued:[1]}),f.store.provenance.set('Owner/Shared/note.md',{revision:'1-base'}),f.store.append({type:'CHANGED'})]);
 assert.deepEqual(await f.store.kv.get('snapshot'),{queued:[1]});assert.equal((await f.store.pending()).length,1);assert.equal((await f.store.provenance.get('Owner/Shared/note.md')).revision,'1-base');
 const wrong=createShared2RuntimeStore({profile:{...profile,cacheEpoch:'d'.repeat(32)},mount:'Local',store:{load:async()=>f.saved.value,save:async()=>{throw Error('must not save');}}});
 await assert.rejects(wrong.pending(),/scope-mismatch/);await f.controller.close();
});

test('an existing scoped baseline imports only proven ancestry before standard offline reconciliation',async()=>{
 const f=fixture({inherit:true,metadata:[{path:'Owner/Shared/note.md',_rev:'1-base'}]});
 await f.controller.wake();assert.equal(f.calls.baseline,0);assert.equal(f.calls.adopt.length,0);assert.equal(f.calls.list,1);
 assert.deepEqual(await f.store.provenance.get('Owner/Shared/note.md'),{revision:'1-base'});
 assert.deepEqual(f.calls.events,[]);await f.controller.close();
 const missing=fixture({inherit:true});await missing.controller.wake();
 assert.equal(await missing.store.provenance.get('Owner/Shared/note.md'),undefined);await missing.controller.close();
});
test('reaccepted authority cannot inherit stale ancestry in place of its verified baseline',async()=>{
 const f=fixture({inherit:true,canUpload:()=>false});await f.controller.wake();
 assert.equal(f.calls.baseline,1);assert.equal(f.calls.events.length,0);await f.controller.close();
});

test('a failed manual check can reconnect on the next poll',async()=>{
 const f=fixture();await f.controller.wake();f.setFail(true);
 await assert.rejects(f.controller.synchronize(),/file-write-failed/);
 assert.equal(f.controller.ready,false);
 f.setFail(false);await f.controller.wake();
 assert.equal(f.controller.ready,true);assert.equal(f.calls.live,2);
 await f.controller.close();
});

test('startup restores incoming work without replaying the database and skips verified discovery events',async()=>{
 const path='Owner/Shared/note.md',proven={path,_rev:'1-proven'};
 const changed='Owner/Shared/changed.md';
 const f=fixture({metadata:[proven]});
 const order=[];
 f.engine.results.restore=async()=>{order.push('restore');};
 f.engine.results.receive=async()=>{assert.fail('unexpected cached database replay');};
 f.engine.synchronize=async()=>{order.push('sync');};
 const controller=createShared2LiveController({profile,engine:f.engine,baseline:{close:async()=>{}},store:f.store,
  checkLease:async()=>true,scan:async({full})=>{order.push(full?'manual':'startup');},isVerified:async doc=>doc===proven});
 await f.store.markPrepared();
 for(const [type,file] of [['DELETE',path],['CREATE',path],['CHANGED',path],['CREATE',changed]]){
  await controller.enqueue({type,args:{file:stub(file)}});
 }
 await controller.wake();
 assert.deepEqual(order,['startup','restore','sync']);
 assert.deepEqual(f.calls.events.map(x=>[x.type,x.args.file.path]),[['CHANGED',path],['CREATE',changed]]);
 assert.deepEqual(await f.store.pending(),[]);
 await controller.synchronize();
 assert.deepEqual(order.slice(3),['manual','restore','sync']);
 await controller.close();
});
