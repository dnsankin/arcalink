import test from 'node:test';
import assert from 'node:assert/strict';
import {createShared2StartupCheckpoint} from '../plugin/shared2-startup-checkpoint.mjs';

test('old ancestry, a changed file, a conflict or a failed comparison cannot suppress startup work',async()=>{
 const file={path:'Owner/Shared/attachment.pdf',_rev:'1-base',size:12};
 let record={revision:'1-base'},current={type:'file',size:12,mtime:10,ctime:10},digest='local',changeDuringRead=false;
 const proof=createShared2StartupCheckpoint({documentRoot:'Owner/Shared',
  provenance:{get:async()=>record,verify:async(_path,revision,verifiedStat)=>{record={revision,verifiedStat};}},
  metadata:async()=>file,stat:async()=>({...current}),fingerprint:async()=>{if(changeDuringRead)current.ctime++;return digest;},
  revisionProof:async()=>({size:12,sha256:'database'})});
 assert.equal(await proof.isVerified(file),false);
 await proof.remember(file);
 assert.equal(await proof.isVerified(file),false);
 digest='database';changeDuringRead=true;
 await proof.remember(file);
 assert.equal(await proof.isVerified(file),false);
 changeDuringRead=false;
 await proof.remember(file);
 assert.equal(await proof.isVerified(file),true);
 assert.equal(await proof.isVerified({...file,_conflicts:['2-other']}),false);
 assert.equal(await proof.isVerified({...file,_rev:'2-new'}),false);
 assert.equal(await proof.isVerified({...file,deleted:true}),false);
 assert.equal(await proof.isVerified({...file,path:'Owner/Other/attachment.pdf'}),false);
 current.ctime++;
 assert.equal(await proof.isVerified(file),false,'even a same-size file with its original mtime needs a check when ctime changed');
});

test('initial acknowledgement is fenced by the exact event sequence, file attributes and remote head',async()=>{
 const {createShared2RuntimeStore}=await import('../plugin/shared2-runtime-store.mjs');
 const {reconcileInitialEvents}=await import('../plugin/shared2-initial-events.mjs');
 const path='Root/Reports/a.bin';
 for(const race of ['new-event','changed-file','new-head','offline','missing-history']){
  let saved,reads=0;
  const store={load:async()=>saved,save:async value=>{saved=structuredClone(value);}};
  const runtime=createShared2RuntimeStore({store,profile:{folder:'a',cacheEpoch:1},mount:'Local'});
  const item={type:'CREATE',args:{file:{path,stat:{mtime:1}}}};
  const original=await runtime.append(item);
  const attrs={type:'file',mtime:2,ctime:1,size:3};
  await runtime.provenance.set(path,{revision:'1-a',verifiedStat:attrs});
  const engine={metadata:async()=>({path,_rev:'1-a',deleted:race==='missing-history'}),remoteEventHead:async()=>{
   reads++;
   if(race==='new-event'&&reads===1)await runtime.append({...item,type:'CHANGED'});
   if(race==='offline')throw Error('offline');
   if(race==='missing-history')return null;
   return {revision:race==='new-head'&&reads>1?'2-b':'1-a',deleted:false};
  }};
  const run=()=>reconcileInitialEvents({runtime,engine,checkpoint:{remember:async()=>{},isVerified:async()=>true},stat:async()=>({...attrs,mtime:race==='changed-file'?3:2}),exists:async()=>true,checked:async()=>true});
  if(race==='offline')await assert.rejects(run(),/offline/);
  else assert.equal((await run()).path,path);
  const reopened=createShared2RuntimeStore({store,profile:{folder:'a',cacheEpoch:1},mount:'Local'});
  assert.equal((await reopened.pending())[0].id,original);assert.equal((await reopened.pending()).length,race==='new-event'?2:1);
 }
});
