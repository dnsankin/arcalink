import test from 'node:test';
import assert from 'node:assert/strict';
import {createContentRetryQueue} from '../plugin/content-retry.mjs';
import {patchContentRetryProcessor,patchContentRetryLifecycle} from '../scripts/patch-content-retry.mjs';

const doc=(rev='1-a')=>({_id:'attachment',_rev:rev,children:['h:chunk']});
function setup(){
 let time=0,serial=0,db={},enabled=true,unavailable=false;
 const timers=new Map(),sent=[];let changes=0;
 const q=createContentRetryQueue({owner:()=>{if(unavailable)throw Error('Database closed');return db;},canRun:()=>enabled,enqueue:x=>sent.push(x),changed:()=>changes++,now:()=>time,
  setTimer:(fn,delay)=>{const id=++serial;timers.set(id,{fn,due:time+delay});return id;},clearTimer:id=>timers.delete(id)});
 const advance=ms=>{const end=time+ms;for(;;){const next=[...timers].sort((a,b)=>a[1].due-b[1].due)[0];if(!next||next[1].due>end)break;time=next[1].due;timers.delete(next[0]);next[1].fn();}time=end;};
 return {q,sent,timers,advance,owner:()=>db,swap:()=>{db={};},unavailable:()=>{unavailable=true;},enable:x=>{enabled=x;},changes:()=>changes};
}
test('content retry retains metadata and waits five seconds before retrying',()=>{
 const h=setup(),d=doc();assert.equal(h.q.defer(d,h.owner()),true);
 assert.deepEqual(h.q.snapshot(),[d]);h.advance(4999);assert.equal(h.sent.length,0);
 h.advance(1);assert.deepEqual(h.sent,[d]);assert.deepEqual(h.q.snapshot(),[]);
 h.q.finish(d);assert.equal(h.timers.size,0);
});
test('repeated content failures back off to one attempt per minute',()=>{
 const h=setup(),d=doc();
 for(const delay of [5000,15000,30000,60000,60000]){
  h.q.defer(d,h.owner());const before=h.sent.length;h.advance(delay-1);assert.equal(h.sent.length,before);
  h.advance(1);assert.equal(h.sent.length,before+1);
 }
});
test('offline or suspended state retains work without attempts, then resumes',()=>{
 const h=setup(),d=doc();h.enable(false);h.q.defer(d,h.owner());h.advance(180000);
 assert.equal(h.sent.length,0);assert.deepEqual(h.q.snapshot(),[d]);assert.equal(h.timers.size,1);
 h.enable(true);h.advance(5000);assert.deepEqual(h.sent,[d]);
});
test('duplicate failures have one timer and one pending document',()=>{
 const h=setup(),d=doc();h.q.defer(d,h.owner());h.q.defer(d,h.owner());
 assert.equal(h.timers.size,1);assert.equal(h.q.snapshot().length,1);h.advance(15000);assert.equal(h.sent.length,1);
});
test('a new revision cancels old retry and rejects its late failure',()=>{
 const h=setup(),old=doc(),next=doc('2-b');h.q.supersede(old);h.q.defer(old,h.owner());h.q.supersede(next);
 assert.equal(h.q.defer(old,h.owner()),false);assert.deepEqual(h.q.snapshot(),[]);
 assert.equal(h.q.defer(next,h.owner()),true);h.advance(5000);assert.deepEqual(h.sent,[next]);
});
test('a deletion arriving during a failed download cancels the previous retry',()=>{
 const h=setup(),d=doc(),deleted={...doc('2-delete'),deleted:true};h.q.defer(d,h.owner());h.q.supersede(deleted);
 h.advance(60000);assert.equal(h.sent.length,0);assert.deepEqual(h.q.snapshot(),[]);
});
test('changing database removes pending work and rejects late old-owner results',()=>{
 const h=setup(),d=doc(),old=h.owner();h.q.defer(d,old);h.swap();
 assert.deepEqual(h.q.snapshot(),[]);assert.equal(h.q.defer(d,old),false);
 h.advance(60000);assert.equal(h.sent.length,0);assert.equal(h.timers.size,0);
});
test('unload cancels timers but leaves a recoverable snapshot',()=>{
 const h=setup(),d=doc();h.q.defer(d,h.owner());h.q.dispose();h.advance(300000);
 assert.equal(h.sent.length,0);assert.equal(h.timers.size,0);assert.deepEqual(h.q.snapshot(),[d]);
 assert.equal(h.q.defer(d,h.owner()),false);
});
test('a temporarily unavailable database cannot throw from the retry timer',()=>{
 const h=setup(),d=doc(),old=h.owner();h.q.defer(d,old);h.unavailable();
 assert.doesNotThrow(()=>h.advance(5000));assert.deepEqual(h.q.snapshot(),[]);
 assert.equal(h.q.defer(d,old),false);assert.equal(h.sent.length,0);
});
test('snapshot is independent of the returned array and excludes completed work',()=>{
 const h=setup(),d=doc();h.q.defer(d,h.owner());h.q.snapshot().pop();assert.equal(h.q.snapshot().length,1);
 h.q.supersede(d);h.q.finish(d);assert.deepEqual(h.q.snapshot(),[]);assert.ok(h.changes()>0);
});
test('patches reject unknown upstream rather than silently skipping recovery',()=>{
 assert.throws(()=>patchContentRetryProcessor('unexpected upstream'),/Unexpected upstream/);
 assert.throws(()=>patchContentRetryLifecycle('unexpected upstream'),/Unexpected upstream/);
});
