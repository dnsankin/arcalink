import test from 'node:test';
import assert from 'node:assert/strict';
import {createPendingDeletionRecovery} from '../plugin/recovery.mjs';

test('replays only persisted deletions through the protected file handler',async()=>{
 const applied=[];
 const recover=createPendingDeletionRecovery({eligible:()=>true,current:()=>1,files:()=>['live','removed','missing'],metadata:async path=>path==='missing'?null:{deleted:path==='removed'},apply:async path=>applied.push(path),report:error=>{throw error;}});
 await recover();
 assert.deepEqual(applied,['removed']);
});
test('stops when the database changes while reading metadata',async()=>{
 let identity=1;
 const applied=[];
 const recover=createPendingDeletionRecovery({eligible:()=>true,current:()=>identity,files:()=>['removed'],metadata:async()=>{identity=2;return {deleted:true};},apply:async path=>applied.push(path),report:error=>{throw error;}});
 await recover();
 assert.deepEqual(applied,[]);
});
